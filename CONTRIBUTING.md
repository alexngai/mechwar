# Contributing to MECHWAR

Thanks for helping. Bug fixes, new maps, weapons and items, bot behaviour, touch controls and performance on phones are all welcome. For a bigger change, such as a new mode or a rework of a system, open an [issue](https://github.com/alexngai/mechwar/issues) first so we can agree on the shape before you build it.

Just want to report a bug or suggest something? See [Feedback and suggestions](README.md#feedback-and-suggestions).

## Run it locally

Needs Rust (with the `wasm32-unknown-unknown` target), [wasm-pack](https://github.com/drager/wasm-pack) and Node 22.

```bash
npm install
npm run dev
```

Open the printed URL and click the page to capture the mouse. This is the offline sandbox. After editing Rust while `vite` is running, run `npm run wasm` and the page reloads.

WASD move · Shift boost · Space hover · Shift+A/D dash · LMB/RMB fire · Q/E items · F ability · R repair · V chase/cockpit camera · Esc menu, with the full list of keys.

### Online, with bots

```bash
npm run server
```

With `npm run dev` running, open tabs at `http://localhost:5173/?server=ws://localhost:9001/ws` to join quick play. Quick play cycles through the versus modes, each on the maps that fit it: team deathmatch (4v4), deathmatch (8 free-for-all, on the smaller maps), Missile Assault, Siege, Capture the Flag and Convoy. Bots fill the empty slots. The server runs any number of games (rooms) at once.

To try the lobby page, run `npx vite build` and open `http://localhost:9001/`, which serves the built client. From there you can:
- use quick play, or co-op (matched apart from quick play)
- see the listed games, or open a game, listed or by code only
- join by code or by invite link (`/?room=CODE`)

Server environment variables:
- `LAG_MS=40` adds 40 ms each way (about 80 ms round trip).
- `PORT` changes the port (default 9001).
- `MODE` pins one mode for quick play: `tdm`, `dm`, `ma`, `siege`, `ctf`, `convoy` or `defense`. Without it, every versus mode plays in turn.
- `MAP` pins one map; without it, the rotation plays.
- `SCORE_LIMIT` and `MATCH_SECONDS` shorten matches.
- `BOT_SKILL` sets how sharp bots are: `easy`, `normal`, `hard`, or 0 to 1.
- `PROGRESS_KEY` is the secret that signs progression records. A dev key stands in without it.

The HUD shows K/D, ping and `corr`: how far the last server correction moved your mech (0.000 when prediction is exact).

To play the production build the way it's hosted, run `npm run build`, then `npm run server`, and open `http://localhost:9001`. The server serves `dist/` and the WebSocket on one port; `?offline` opens the sandbox.

To try the touch controls on a computer, add `?touch` to the URL, or use your browser's device emulation. To reach the dev server from a phone, run `npx vite --host` and open the network URL. Gyro aim needs HTTPS, except on localhost.

## Tests

```bash
npm test
```

This runs the Rust tests, including the netcode checks. CI runs `cargo test --workspace` on every pull request. Tests run in debug builds, which catch integer overflows that release builds hide. Please add a test with a sim change when one can catch it breaking.

## How the code fits together

- `sim/` is the shared Rust simulation, with Rapier physics in `enhanced-determinism` mode. It's all pure Rust with no IO; the browser bindings are in `wasm.rs`, behind the `wasm` feature.
  - `lib.rs` steps a mech.
  - `net.rs` is the wire protocol.
  - `game.rs` is the authoritative match: lag-compensated hitscan, respawns, the modes' rules (with `objective.rs`, `siege.rs`, `ctf.rs`, `convoy.rs` and `defense.rs`).
  - `client.rs` does prediction, reconciliation and interpolation.
  - `bot.rs`, `brain.rs` and `tactics.rs` are the bots.
- `server/` is the axum server. It serves the built client, the lobby API (`/api/rooms`, `/api/quick`) and the `/ws` WebSocket. Each room runs its own `sim::game::Game` at 30 Hz and closes once it has sat empty a while.
- `web/` is the three.js client.
  - `entry.js` picks the page: `lobby.js` (the landing page) when there's no game to join, else the game.
  - `main.js` runs fixed 30 Hz sim steps, interpolated rendering, the HUD and the tuning panel.
  - `touch.js` has the touch controls, and `guide.js` builds the guide at `/guide/`.
- `tuning.json` holds every gameplay constant, with its slider range and `source`. The Rust sim reads it at compile time, and the page loads it for the sliders. "Copy tuning.json" in the panel copies the current slider values in the same format, ready to paste back over the file. Online, only the camera and touch sliders are live, because both ends use the compiled-in values.
- `classes.json` and `weapons.json` define the mechs, the weapons and the items.
- `maps/` holds one generator script per map (`maps/<name>.mjs`, built on `kit.mjs`) and the JSON it writes. After editing a script, rerun `node maps/<name>.mjs`. Each script's header describes its map.
- `guide/` holds the guide page, its map blurbs, and the screenshots in `guide/shots/`, taken with `tools/`.
- `balance/` holds Python scripts that play bot-only matches (`cargo run --release -p sim --bin arena`) to rate weapons and builds and tune the bots.

Most files open with a comment that explains what they're for. Start there.

## Sending a change

1. Fork the repo and branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Run `npm test`. For anything you can see, play it in the browser, on a phone too if it touches the HUD or controls.
4. Open a pull request that says what changed and why, with a screenshot or clip if it shows on screen.

The guide reads the game's data, so new weapons, items and maps show up there on their own. If a change moves one of the sim constants the guide quotes, update the `SIM` or `COOP` table at the top of `web/guide.js` too.

By contributing, you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of the project.

## Hosting your own

MECHWAR runs as one small server, with match state in memory. [Fly.io](https://fly.io) works well; `fly.toml` and the `Dockerfile` are ready.

One-time setup: log in with `fly auth login`, then create the app. The name becomes `https://<name>.fly.dev`.

```bash
fly launch --no-deploy --name <name> --region iad --ha=false --copy-config
```

Then, in `fly.toml`, delete `CANONICAL_HOST` or set it to your own domain. Otherwise every page redirects to mechwar.online.

Deploy and watch:

```bash
fly deploy --ha=false
```

```bash
fly logs
```

- Keep exactly one machine, because match state lives in memory. `--ha=false` ensures that; `fly scale count 1` fixes it if needed.
- The machine stops when idle and wakes on the next visit in a few seconds.
- A shared-cpu-1x machine with 256 MB costs about $2 a month if it runs all month, less with auto-stop.
- Set `PROGRESS_KEY` with `fly secrets set` so players' progression records can't be forged.

This repo deploys mechwar.online automatically on every push to `main`, once the tests pass (`.github/workflows/deploy.yml`). The Fly app keeps the game's old name, `webhawk`. The workflow needs a deploy token stored as the `FLY_API_TOKEN` repo secret:

```bash
fly tokens create deploy -a webhawk -x 8760h | gh secret set FLY_API_TOKEN --repo alexngai/mechwar
```

## Troubleshooting

`ld: tapi error: malformed file ... unknown architecture arm64e.x1-macos`: the Xcode Command Line Tools are older than the default macOS SDK. Update the Command Line Tools, or point builds at a matching SDK:

```bash
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk
```
