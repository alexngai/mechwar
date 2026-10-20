# webhawk

Single-player movement sandbox for a browser mech shooter. Plan: [concept.md](concept.md).

## Run

Needs Rust (with the `wasm32-unknown-unknown` target), [wasm-pack](https://github.com/drager/wasm-pack) and Node 22.

```bash
npm install
npm run dev
```

Open the printed URL, click the page to capture the mouse.

WASD move · Shift boost · Space hover · Q/E dodge · LMB fire · V chase/cockpit camera · R respawn · Esc release mouse

`npm test` runs the Rust sim test. After editing Rust while `vite` is running, run `npm run wasm` and the page reloads.

## Layout

- `tuning.json` — every constant, with slider range and `source` (`capture`, `default property` or `own tuning`). The Rust sim reads it at compile time; the page loads it for the sliders. "Copy tuning.json" in the panel copies the current slider values in the same format, ready to paste back over the file.
- `sim/` — shared Rust sim (Rapier, `enhanced-determinism`). Pure Rust in `lib.rs`; browser bindings in `wasm.rs` behind the `wasm` feature, so a native server can depend on the crate later.
- `web/main.js` — Three.js client: fixed 30 Hz sim steps, interpolated render, HUD, lil-gui panel.

## Troubleshooting

`ld: tapi error: malformed file ... unknown architecture arm64e.x1-macos`: the Xcode Command Line Tools are older than the default macOS SDK. Update the Command Line Tools, or point builds at the matching SDK:

```bash
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk
```
