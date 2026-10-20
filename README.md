# webhawk

Movement sandbox and networked 1v1 for a browser mech shooter. Plan: [concept.md](concept.md).

## Run

Needs Rust (with the `wasm32-unknown-unknown` target), [wasm-pack](https://github.com/drager/wasm-pack) and Node 22.

```bash
npm install
npm run dev
```

Open the printed URL, click the page to capture the mouse.

WASD move · Shift boost · Space hover · Q/E dodge · LMB fire · V chase/cockpit camera · R respawn · Esc release mouse

`npm test` runs the Rust tests, including the netcode checks. After editing Rust while `vite` is running, run `npm run wasm` and the page reloads.

## Run online (1v1)

```bash
npm run server
```

Then open two tabs at `http://localhost:5173/?server=ws://localhost:9001`. Set `LAG_MS=40` on the server to add 40 ms each way (about 80 ms round trip); `PORT` changes the port. The HUD shows K/D, ping and `corr`, how far the last server correction moved your mech (0.000 when prediction is exact). Online, only camera sliders are live: both ends use the compiled-in `tuning.json`.

## Layout

- `tuning.json` — every constant, with slider range and `source` (`capture`, `default property` or `own tuning`). The Rust sim reads it at compile time; the page loads it for the sliders. "Copy tuning.json" in the panel copies the current slider values in the same format, ready to paste back over the file.
- `sim/` — shared Rust sim (Rapier, `enhanced-determinism`). `lib.rs` steps a mech; `net.rs` is the wire protocol, `game.rs` the authoritative match (lag-compensated hitscan, respawn), `client.rs` prediction, reconciliation and interpolation. All pure Rust with no IO; browser bindings in `wasm.rs` behind the `wasm` feature.
- `server/` — WebSocket glue (tokio) running `sim::game::Game` at 30 Hz.
- `web/main.js` — Three.js client: fixed 30 Hz sim steps, interpolated render, HUD, lil-gui panel.

## Troubleshooting

`ld: tapi error: malformed file ... unknown architecture arm64e.x1-macos`: the Xcode Command Line Tools are older than the default macOS SDK. Update the Command Line Tools, or point builds at the matching SDK:

```bash
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk
```
