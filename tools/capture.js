// Helpers for taking the guide's screen grabs from live matches (guide/shots/mode-*, mech-*,
// start-*). The game's ?capture hook (`__capture`, web/main.js) moves the camera, holds a frame
// still and steers our mech; these wait for a moment worth a picture, frame it, and hold it.
//
// 1. Build the client with the hook in: `VITE_CAPTURE=1 npx vite build --outDir <dir>`.
// 2. Serve it with bots playing the mode: `STATIC_DIR=<dir> PORT=9041 MODE=ctf MAP=verdigris
//    MATCH_SECONDS=3000 BOT_SKILL=hard ./target/release/server` (it can't be the dev server: any
//    file another session saves reloads the page).
// 3. Open http://localhost:9041/?server=ws://localhost:9041/ws&capture in a 1600x900 browser you
//    can screenshot to a file (e.g. chrome-devtools MCP: emulate, take_screenshot with filePath),
//    and run this file in the page.
// 4. Each helper resolves once the frame is held; take the screenshot, then `c.hold = false`.
//    Convert to 1280x720 WebP (q 0.8) into guide/shots/ (the dev server's /__shots/ takes POSTs).
//
// How the guide's were taken:
// - mode-tdm / mode-dm: `duel()` / `duel({ teams: 'any' })` on Foundry / Sump (Sump at the
//   default score limit, as the panel shows it).
// - mode-ma: a fixed view of silo A's pad, held 2.2 s into a launch (`objectives().missiles`).
// - mode-siege: once a ship is up, `around()` its position from 30 m below.
// - mode-ctf: `around()` the flag mesh over its carrier (`objectives().flags`).
// - mode-convoy: `around()` the hauler (`objectives().hauler`) while escorts walk it.
// - mech-movement / mech-repair: `watch((m) => m.hovering)`, `watch((m) => m.repairing)`.
// - mech-orbs / mech-deployables: `thing()` on `field().orbs` / a dome in `deployed()`.
// - mech-base-guns: `shoulder()` from a base gun in `deployed()` (kind 5) to an enemy in its reach.
// - mech-lock-on / mech-heat: launched (#launch), `css(COCKPIT)`, `c.look()` at the nearest enemy
//   and `c.lock(true)` till `c.me().lock` holds / `c.fire(true)` till heat passes 180.
// - start-hangar: `css()` with #picker shown, before launching.
(() => {
  const c = window.__capture;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  /** Whether nothing in the arena stands between `a` and `b`. */
  const clear = (a, b) => { const d = sub(b, a), l = Math.hypot(...d); return c.ray(a, unit(d), l) >= l - 0.8; };
  const chest = (m, up = 2.6) => [m.pos[0], m.pos[1] + up, m.pos[2]];
  const byId = (id) => c.mechs().find((m) => m.id === id);
  // What's hidden: everything but the scene and the top panel, or (COCKPIT) all but our own HUD.
  const SCENE = '#picker,#help,#hud,#stats,#menu,#glass,.lil-gui,#debug-log,#killcam';
  const COCKPIT = '#picker,#help,#hud,#stats,#menu,.lil-gui,#debug-log';
  const style = document.getElementById('cap-css') ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: 'cap-css' }));
  const css = (hide) => { style.textContent = hide ? `${hide}{display:none!important}` : ''; };
  css(SCENE);

  /** Over `a`'s shoulder toward `b`, from the first of a few spots that sees both; or null. */
  function shoulder(a, b, { back = 8, up = 3.2, side = 3.5 } = {}) {
    const ac = chest(a), bc = chest(b), f = unit([bc[0] - ac[0], 0, bc[2] - ac[2]]), r = [-f[2], 0, f[0]];
    for (const [k, s, u] of [[back, side, up], [back, -side, up], [back * 0.7, side, up + 2], [back * 0.7, -side, up + 2], [back * 1.3, 0, up + 4]]) {
      const eye = [ac[0] - f[0] * k + r[0] * s, ac[1] + u, ac[2] - f[2] * k + r[2] * s];
      if (clear(ac, eye) && clear(eye, bc)) return { eye, look: [ac[0] + (bc[0] - ac[0]) * 0.6, (ac[1] + bc[1]) / 2, ac[2] + (bc[2] - ac[2]) * 0.6] };
    }
    return null;
  }
  /** `m` ({ pos, yaw }) from round it: `turns` radians off its front, tried in order, `r` m out and `h` up; or null. */
  function around(m, { r = 10, h = 3, turns = [0.7, -0.7, 1.2, -1.2, 0.3, -0.3, 2, -2, Math.PI], look = 2 } = {}) {
    const at = chest(m, look);
    for (const t of turns) {
      const a = (m.yaw ?? 0) + t, eye = [at[0] - Math.sin(a) * r, at[1] + h, at[2] - Math.cos(a) * r];
      if (clear(at, eye) && c.ray(eye, [0, -1, 0], 1.5) >= 1.5) return { eye, look: at };
    }
    return null;
  }
  /** Rides `view()` (null to give up) for `ride` ms, then holds the frame; whether it held. */
  async function ride(view, ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const v = view();
      if (!v) return false;
      c.view = v;
      await sleep(25);
    }
    c.hold = true;
    return true;
  }
  /** Waits up to `ms` for what `find()` returns ({ pos, yaw? }) and a view of it from round it; rides it and holds. */
  async function thing(find, { ms = 40000, hold = 400, view = {} } = {}) {
    c.hold = false;
    for (const t0 = performance.now(); performance.now() - t0 < ms; await sleep(80)) {
      const t = find();
      if (t && around(t, view) && (await ride(() => { const now = find(); return now && around(now, view); }, hold))) return t;
    }
    return null;
  }
  /** `thing` for the first living mech `pick(m)` takes. */
  const watch = (pick, opts) => thing(() => c.mechs().find((m) => m.health > 0 && pick(m)), opts);
  /** Facing angle of `a` toward `b`, radians off its heading. */
  const facing = (a, b) => { const g = Math.atan2(-(b.pos[0] - a.pos[0]), -(b.pos[2] - a.pos[2])) - a.yaw; return Math.abs(Math.atan2(Math.sin(g), Math.cos(g))); };
  /**
   * Waits for a mech squaring up to an enemy `min`-`max` m off (`teams`: 'ours', a mech of ours
   * facing theirs; 'any', anyone facing anyone), over its shoulder; rides it and holds.
   */
  async function duel({ ms = 40000, hold = 600, min = 14, max = 36, teams = 'ours', view = {} } = {}) {
    c.hold = false;
    for (const t0 = performance.now(); performance.now() - t0 < ms; await sleep(80)) {
      const live = c.mechs().filter((m) => m.health > 0), pairs = [];
      for (const a of live) for (const b of live) {
        if (a.team === b.team || (teams === 'ours' && a.team !== c.team)) continue;
        const d = Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]);
        if (d > min && d < max && facing(a, b) < 0.35 && Math.abs(a.pos[1] - b.pos[1]) < 3) pairs.push({ a: a.id, b: b.id, d });
      }
      for (const p of pairs.sort((x, y) => x.d - y.d)) {
        const view2 = () => { const a = byId(p.a), b = byId(p.b); return a && b && shoulder(a, b, view); };
        if (view2() && (await ride(view2, hold))) return p;
      }
    }
    return null;
  }
  /** Each deployable as { kind (0 dome, 1 barrier, 2 MG turret, 3 rocket turret, 4 ship, 5 base gun, 6 hauler), team, owner, pos, yaw, left, hull }. */
  const deployed = () => {
    const f = c.field().deployables, out = [];
    for (let i = 0; i < f.length; i += 10) out.push({ kind: f[i], team: f[i + 1], owner: f[i + 2], pos: [f[i + 3], f[i + 4], f[i + 5]], yaw: f[i + 6], left: f[i + 8], hull: f[i + 9] });
    return out;
  };
  window.__lib = { c, sleep, clear, chest, byId, css, SCENE, COCKPIT, shoulder, around, thing, watch, duel, deployed };
})();
