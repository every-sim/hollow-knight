# Hollow Knight (WebGL port)

A browser port of Hollow Knight. Originally by **bog** (truffed.lol) — credit him if you reuse this.

## How it is hosted

GitHub Pages only publishes a small site (the player page, the Unity loader and engine
glue). The ~913 MiB of game build data is split into 20 MB chunks and lives on the
`game-assets` branch, because a ~1 GB Pages site never finishes deploying. The page
streams those chunks from jsDelivr (with raw.githubusercontent.com as a fallback) and
glues them back together in the browser.

- Live: https://mywebsitekeepsgettingblocked.github.io/hollow-knight/
- Data branch: `game-assets` (`Build/hktruffled.data.part1..45`, `Build/hktruffled.wasm.part1..2`)

## Requirements

Desktop Chrome/Edge/Firefox with roughly 4 GB+ of free RAM. The build downloads about
913 MiB, so the first load takes a while. Mobile browsers generally run out of memory.
