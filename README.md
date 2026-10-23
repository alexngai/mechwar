# MECHWAR

A browser mech shooter, at [mechwar.online](https://mechwar.online). Plan: [concept.md](concept.md).

## Run

Needs Rust (with the `wasm32-unknown-unknown` target), [wasm-pack](https://github.com/drager/wasm-pack) and Node 22.

```bash
npm install
npm run dev
```

Open the printed URL, click the page to capture the mouse.

WASD move · Shift boost · Space hover · Q/E dodge · LMB fire · V chase/cockpit camera · R respawn · Esc release mouse

`npm test` runs the Rust tests, including the netcode checks. After editing Rust while `vite` is running, run `npm run wasm` and the page reloads.

## Run online

```bash
npm run server
```

With `npm run dev` running, open tabs at `http://localhost:5173/?server=ws://localhost:9001/ws` to join quick play: 4v4 team deathmatch, with bots filling empty slots. The server runs any number of games (rooms) at once. To try the lobby page, run `npx vite build` and open `http://localhost:9001/`, which serves the built client: quick play, the listed games, opening a game (listed or by code only) and joining by code or invite link (`/?room=CODE`). Server env vars:
- `LAG_MS=40` adds 40 ms each way (about 80 ms round trip).
- `PORT` changes the port (default 9001).
- Quick play's games: `MAP` pins one map (else the rotation), `SCORE_LIMIT` and `MATCH_SECONDS` shorten matches, and `BOT_SKILL` (`easy`, `normal`, `hard`, or 0 to 1) sets how sharp bots are.

The HUD shows K/D, ping and `corr`, which is how far the last server correction moved your mech (0.000 when prediction is exact). Online, only camera sliders are live, because both ends use the compiled-in `tuning.json`.

To play the production build the way it's hosted, run `npm run build`, then `npm run server`, and open `http://localhost:9001`. The server serves `dist/` and the WebSocket on one port; `?offline` opens the sandbox.

## Deploy (Fly.io)

One-time setup: log in with `fly auth login`, then create the app. The name becomes `https://<name>.fly.dev`.

```bash
fly launch --no-deploy --name <name> --region iad --ha=false --copy-config
```

Deploy and watch:

```bash
fly deploy --ha=false
```

```bash
fly logs
```

- The Fly app and this repo keep the game's old name, `webhawk` (Fly can't rename an app); the site answers at mechwar.online once its domain points at the app.
- Pushes to `main` also deploy automatically (`.github/workflows/deploy.yml`, after the tests pass). That needs a deploy token stored as the `FLY_API_TOKEN` repo secret:

  ```bash
  fly tokens create deploy -a webhawk -x 8760h | gh secret set FLY_API_TOKEN --repo alexngai/webhawk
  ```

- Keep exactly one machine: match state lives in memory. `--ha=false` ensures that; `fly scale count 1` fixes it if needed.
- The machine stops when idle and wakes on the next visit in a few seconds.
- Cost: a shared-cpu-1x, 256 MB machine is about $2/month if it runs all month, less with auto-stop.

## Layout

- `tuning.json` — every constant, with slider range and `source` (`capture`, `default property` or `own tuning`). The Rust sim reads it at compile time; the page loads it for the sliders. "Copy tuning.json" in the panel copies the current slider values in the same format, ready to paste back over the file.
- `sim/` — shared Rust sim (Rapier, `enhanced-determinism`). `lib.rs` steps a mech; `net.rs` is the wire protocol, `game.rs` the authoritative match (lag-compensated hitscan, respawn), `client.rs` prediction, reconciliation and interpolation. All pure Rust with no IO; browser bindings in `wasm.rs` behind the `wasm` feature.
- `server/` — axum: serves the built client, the lobby API (`/api/rooms`, `/api/quick`) and the `/ws` WebSocket. Each room runs its own `sim::game::Game` at 30 Hz and closes once it has sat empty a while.
- `web/entry.js` picks the page: `web/lobby.js` (the landing page) when there's no game to join, else the game.
- `web/main.js` — Three.js client: fixed 30 Hz sim steps, interpolated render, HUD, lil-gui panel.

## Troubleshooting

`ld: tapi error: malformed file ... unknown architecture arm64e.x1-macos`: the Xcode Command Line Tools are older than the default macOS SDK. Update the Command Line Tools, or point builds at the matching SDK:

```bash
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk
```
