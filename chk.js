
(function () {
  "use strict";

  // ---- asset locations -------------------------------------------------
  // Game data lives on the `game-assets` branch so the Pages site stays small
  // enough to actually build. Every host below serves CORS + byte ranges.
  var ASSET_BASES = [
    "https://cdn.jsdelivr.net/gh/every-sim/hollow-knight@game-assets/",
    "https://raw.githubusercontent.com/every-sim/hollow-knight/game-assets/",
    "https://cdn.jsdelivr.net/gh/mywebsitekeepsgettingblocked/hollow-knight@game-assets/",
    "https://raw.githubusercontent.com/mywebsitekeepsgettingblocked/hollow-knight/game-assets/"
  ];
  var DATA_PARTS = 45;
  var WASM_PARTS = 2;
  var DATA_PART_SIZE = 20866662;
  var DATA_LAST_SIZE = 8756670;
  var WASM_PART1_SIZE = 20866662;
  var WASM_PART2_SIZE = 9390603;
  var TOTAL_BYTES = DATA_PART_SIZE * (DATA_PARTS - 1) + DATA_LAST_SIZE + WASM_PART1_SIZE + WASM_PART2_SIZE;
  var CONCURRENCY = 6;

  var el = function (id) { return document.getElementById(id); };
  var canvas = el("unity-canvas");
  var startScreen = el("start");
  var loadingScreen = el("loading");
  var stageEl = el("stage");
  var fillEl = el("fill");
  var mbEl = el("mb");
  var pctEl = el("pct");
  var errBox = el("error-box");
  var retryBtn = el("btn-retry");
  var hud = el("hud");

  var loadedBytes = 0;
  var abortCurrent = false;

  function fmtMiB(bytes) { return (bytes / 1048576).toFixed(1); }

  function paint() {
    var ratio = Math.min(1, loadedBytes / TOTAL_BYTES);
    fillEl.style.right = (100 - ratio * 100).toFixed(2) + "%";
    mbEl.textContent = fmtMiB(loadedBytes) + " / " + fmtMiB(TOTAL_BYTES) + " MiB";
    pctEl.textContent = Math.round(ratio * 100) + "%";
  }

  function setStage(text) { stageEl.textContent = text; }

  function showError(message) {
    loadingScreen.classList.remove("hidden");
    startScreen.classList.add("hide");
    errBox.textContent = message;
    errBox.classList.add("show");
    retryBtn.classList.remove("hidden");
    setStage("Failed");
  }

  function clearError() {
    errBox.classList.remove("show");
    errBox.textContent = "";
    retryBtn.classList.add("hidden");
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- keyboard: Space jumps ------------------------------------------
  // The game's default jump key is Z. Rather than making people reach for it
  // in a browser, any key in this table is rewritten in place before the
  // engine's own listener sees the event (the engine reads key/keyCode/code).
  var KEY_ALIASES = {
    Space: { key: "z", code: "KeyZ", keyCode: 90 }
  };

  function aliasKey(e) {
    var alias = KEY_ALIASES[e.code];
    if (!alias) return;
    var props = {
      key: alias.key,
      code: alias.code,
      keyCode: alias.keyCode,
      which: alias.keyCode,
      charCode: alias.keyCode
    };
    Object.keys(props).forEach(function (name) {
      try {
        Object.defineProperty(e, name, {
          configurable: true,
          get: function () { return props[name]; }
        });
      } catch (err) { /* frozen event, leave as-is */ }
    });
    e.preventDefault();
  }

  window.addEventListener("keydown", aliasKey, true);
  window.addEventListener("keyup", aliasKey, true);

  // Download one chunk of the split build, with per-attempt host rotation.
  function fetchPart(path, expectedSize) {
    var attempt = 0;

    function tryOnce() {
      var base = ASSET_BASES[attempt % ASSET_BASES.length];
      return fetch(base + path, { cache: "force-cache" }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " from " + base);
        if (!res.body) throw new Error("streaming unsupported");
        var reader = res.body.getReader();
        var chunks = [];
        var partBytes = 0;
        return (function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              if (expectedSize && partBytes !== expectedSize) {
                throw new Error("short read (" + partBytes + "/" + expectedSize + " bytes)");
              }
              return new Blob(chunks, { type: "application/octet-stream" });
            }
            chunks.push(r.value);
            partBytes += r.value.length;
            loadedBytes += r.value.length;
            paint();
            return pump();
          });
        })();
      }).catch(function (e) {
        attempt += 1;
        if (attempt >= 6) throw new Error(path + ": " + (e && e.message ? e.message : e));
        return sleep(400 * attempt).then(tryOnce);
      });
    }
    return tryOnce();
  }

  // Small task pool so we keep the pipe full without opening 47 connections.
  function runPool(tasks, limit, onEach) {
    var index = 0;
    var results = new Array(tasks.length);
    var done = 0;

    function next() {
      if (index >= tasks.length) return Promise.resolve();
      var i = index++;
      return tasks[i]().then(function (value) {
        results[i] = value;
        done += 1;
        if (onEach) onEach(done, tasks.length);
        return next();
      });
    }

    var workers = [];
    for (var w = 0; w < Math.min(limit, tasks.length); w++) workers.push(next());
    return Promise.all(workers).then(function () { return results; });
  }

  // ---- cutscene plumbing ------------------------------------------------
  // The game asks File.Exists() whether a cutscene exists before handing the
  // URL to the VideoPlayer. There is no disk in a browser, so that call is
  // ---- cutscene transition ---------------------------------------------
  // The ported build cannot hand its cinematic videos to the WebGL player, so
  // every cutscene stalls at "video load" and resumes a moment later. Rather
  // than showing a frozen frame, the page watches the engine's own log and
  // fades through a black loading card while that happens.
  var LOADING_ON = [/Waiting for CinematicVideoPlayer/i, /Skipped cinematic/i];
  var LOADING_OFF = [/Cinematics are finished/i, /Skipping cinematic/i, /Loaded cinematic/i];
  var loadingWatch = { visible: false, shownAt: 0, hideTimer: 0, failsafe: 0 };

  function watchText(args) {
    var text = "";
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === "string") text += a + " ";
      else if (a && typeof a.message === "string") text += a.message + " ";
    }
    return text;
  }

  function loadingShow() {
    if (loadingWatch.visible) return;
    loadingWatch.visible = true;
    loadingWatch.shownAt = Date.now();
    var card = document.getElementById("cut-fade");
    if (!card) return;
    card.classList.add("on");
    clearTimeout(loadingWatch.failsafe);
    loadingWatch.failsafe = setTimeout(loadingHide, 20000);
  }

  function loadingHide() {
    if (!loadingWatch.visible) return;
    var waited = Date.now() - loadingWatch.shownAt;
    var card = document.getElementById("cut-fade");
    var go = function () {
      loadingWatch.visible = false;
      clearTimeout(loadingWatch.failsafe);
      if (card) card.classList.remove("on");
    };
    // never flash: keep the card up for at least a beat
    if (waited < 1400) setTimeout(go, 1400 - waited);
    else go();
  }

  function installCutsceneWatch() {
    ["log", "warn", "error", "info"].forEach(function (level) {
      var original = console[level];
      if (!original || original.__cutsceneWrapped) return;
      var wrapped = function () {
        try {
          var text = watchText(arguments);
          if (text) {
            if (LOADING_ON.some(function (re) { return re.test(text); })) loadingShow();
            else if (LOADING_OFF.some(function (re) { return re.test(text); })) loadingHide();
          }
        } catch (err) { /* never let logging break the engine */ }
        return original.apply(console, arguments);
      };
      wrapped.__cutsceneWrapped = true;
      console[level] = wrapped;
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("could not load " + src)); };
      document.body.appendChild(s);
    });
  }

  function boot() {
    abortCurrent = false;
    loadedBytes = 0;
    paint();
    clearError();
    startScreen.classList.add("hide");
    loadingScreen.classList.remove("hidden");
    setStage("Downloading game data");

    var dataTasks = [];
    var i;
    for (i = 1; i <= DATA_PARTS; i++) {
      (function (n) {
        var size = n === DATA_PARTS ? DATA_LAST_SIZE : DATA_PART_SIZE;
        dataTasks.push(function () { return fetchPart("Build/hktruffled.data.part" + n, size); });
      })(i);
    }
    var wasmTasks = [];
    for (i = 1; i <= WASM_PARTS; i++) {
      (function (n) {
        var size = n === 1 ? WASM_PART1_SIZE : WASM_PART2_SIZE;
        wasmTasks.push(function () { return fetchPart("Build/hktruffled.wasm.part" + n, size); });
      })(i);
    }

    var dataBlobs = null;
    var wasmBlobs = null;

    return runPool(dataTasks, CONCURRENCY, null).then(function (blobs) {
      dataBlobs = blobs;
      setStage("Downloading engine");
      return runPool(wasmTasks, 2, null);
    }).then(function (blobs) {
      wasmBlobs = blobs;
      if (abortCurrent) throw new Error("cancelled");
      setStage("Assembling build");
      var dataBlob = new Blob(dataBlobs, { type: "application/octet-stream" });
      var wasmBlob = new Blob(wasmBlobs, { type: "application/wasm" });
      dataBlobs = null;
      wasmBlobs = null;
      var dataUrl = URL.createObjectURL(dataBlob);
      var codeUrl = URL.createObjectURL(wasmBlob);
      setStage("Starting engine");
      return loadScript("Build/hktruffled.loader.js").then(function () {
        installCutsceneWatch();
        if (typeof createUnityInstance !== "function") throw new Error("Unity loader did not initialise");
        setStage("Compiling engine");
        return createUnityInstance(canvas, {
          dataUrl: dataUrl,
          frameworkUrl: "Build/hktruffled.framework.js",
          codeUrl: codeUrl,
          streamingAssetsUrl: "StreamingAssets",
          companyName: "Team Cherry",
          productName: "Hollow Knight",
          productVersion: "1.0",
          showBanner: function (msg, type) {
            if (type === "error") showError(String(msg));
            else console.warn(msg);
          },
          onProgress: function (progress) {
            if (progress > 0 && progress < 1) {
              setStage("Initialising " + Math.round(progress * 100) + "%");
            }
          }
        });
      });
    }).then(function () {
      loadingScreen.classList.add("hide");
      setTimeout(function () { loadingScreen.classList.add("hidden"); }, 700);
      hud.classList.add("on");
      canvas.focus();
      startFps();
    }).catch(function (err) {
      if (abortCurrent) return;
      console.error(err);
      showError((err && err.message ? err.message : String(err)) +
        "\n\nThis is usually a network hiccup on a ~913 MiB download. Retry to resume from the start.");
    });
  }

  // ---- fps readout -----------------------------------------------------
  var fpsTimer = null;
  function startFps() {
    var frames = 0;
    var last = performance.now();
    if (fpsTimer) return;
    (function tick() {
      frames++;
      var now = performance.now();
      if (now - last >= 500) {
        hud.textContent = Math.round((frames * 1000) / (now - last)) + " FPS";
        frames = 0;
        last = now;
      }
      fpsTimer = requestAnimationFrame(tick);
    })();
  }

  // ---- entry points ----------------------------------------------------
  el("btn-play").addEventListener("click", function () {
    boot();
  });
  retryBtn.addEventListener("click", function () {
    boot();
  });

  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    var note = document.createElement("p");
    note.className = "note";
    note.style.marginTop = "18px";
    note.style.color = "#e0b46a";
    note.textContent = "Heads up: mobile browsers usually run out of memory with a build this size.";
    document.querySelector("#start .note").after(note);
  }
})();
