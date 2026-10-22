// Map-authoring kit shared by the generator scripts (foundry.mjs, verdigris.mjs): boxes, ramps and
// props, then `write`, which adds the 180-degree twin of everything and writes the JSON.
//
// Author one half (z > 0, plus pieces straddling z = 0 on one side); `write` adds the rest, so
// both teams get the same map. Wrap pieces that are their own twin in `once`.
import { writeFileSync } from 'node:fs';

export const solids = [], decor = [], nav = [], pads = [];
const single = new Set(); // pieces that are their own twin
export const r3 = (v) => Math.round(v * 1000) / 1000;

/** Axis-aligned box from its min and max corners. */
export const box = ([x0, y0, z0], [x1, y1, z1], mat) =>
  solids.push({ box: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2].map(r3), half: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2].map(r3), mat });

/** Box by center and half extents, turned `yaw` degrees and tilted `tilt` (positive raises -Z). */
export const turned = (center, half, yaw, mat, tilt = 0) => solids.push({ box: center, half, yaw, ...(tilt && { tilt }), mat });

/**
 * A ramp whose top surface runs from `low` to `high`, `width` wide, in the sim's convention:
 * yaw turns -Z to face uphill and positive tilt raises the -Z end.
 */
export function ramp(low, high, width, mat = 'metal', fill = low[1] === 0) {
  const T = 0.25; // half thickness
  const [dx, dy, dz] = [0, 1, 2].map((i) => high[i] - low[i]);
  const run = Math.hypot(dx, dz), tilt = Math.atan2(dy, run), yaw = Math.atan2(-dx, -dz);
  // The surface normal leans downhill; the center sits half a thickness under the surface.
  const n = [Math.sin(tilt) * Math.sin(yaw), Math.cos(tilt), Math.sin(tilt) * Math.cos(yaw)];
  const center = [0, 1, 2].map((i) => r3((low[i] + high[i]) / 2 - T * n[i]));
  const deg = (r) => r3((r * 180) / Math.PI);
  solids.push({ box: center, half: [width / 2, T, r3(Math.hypot(run, dy) / 2)], yaw: deg(yaw), tilt: deg(tilt), mat });
  // A ramp up from a floor (by default, ground level) is filled under its upper half, so a mech
  // can't walk in beneath the high end and wedge there; what's left under the low half is too low
  // to enter.
  if (fill) {
    const at = (f) => [0, 2].map((i) => low[i] + f * (high[i] - low[i]));
    const [x, z] = at(0.75);
    turned([r3(x), r3(low[1] + dy / 4), r3(z)], [width / 2, r3(dy / 4), r3(run / 4)], deg(yaw), 'concrete');
  }
}

/** A box from point `a` to point `b`, `w` wide and `t` thick, at any slope: a beam, strut or brace. */
export function beam(a, b, w, t, mat = 'metal') {
  const [dx, dy, dz] = [0, 1, 2].map((i) => b[i] - a[i]);
  const run = Math.hypot(dx, dz), deg = (r) => r3((r * 180) / Math.PI), tilt = deg(Math.atan2(dy, run));
  solids.push({ box: [0, 1, 2].map((i) => r3((a[i] + b[i]) / 2)), half: [w / 2, t / 2, r3(Math.hypot(run, dy) / 2)], yaw: deg(Math.atan2(-dx, -dz)), ...(tilt && { tilt }), mat });
}

/**
 * A growth on a structure, the way a city builds outward as it climbs: two or three blocks stacked
 * up its face from `root` (a point on the face, their underside), each reaching further out along
 * `dir` ([dx, dz], unit) than the one below, the top one about `reach` m, with a tank on its roof.
 * They turn only about the vertical, a little off the face's own line; `size` scales them. None
 * hangs below `root`, but clearance under it is the caller's: keep it 6.5 m+ over anywhere mechs
 * walk. With `shelf`, a slab walkway level with `root` instead, `shelf` m across at the tip, so
 * mechs can walk out on it; with `lit`, a lamp there. The shape is random but seeded by `root`, so
 * a rerun writes the same map.
 */
export function growth(root, dir, reach, { size = 1, shelf = 0, lit = false, mat = 'concrete' } = {}) {
  const [x, y, z] = root, [dx, dz] = dir, k = size, face = (Math.atan2(-dx, -dz) * 180) / Math.PI;
  let seed = (Math.abs(Math.round(x * 73 + y * 151 + z * 283)) % 2147483646) + 1;
  const rand = (lo, hi) => lo + (hi - lo) * (((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
  // A block from `d0` to `d1` m out from the face, `l` to its left, `w` across and `t` tall, its
  // underside at `h`, turned `turn` degrees off square.
  const block = (d0, d1, l, h, w, t, turn = 0, m = mat) => {
    const d = (d0 + d1) / 2;
    turned([r3(x + dx * d - dz * l), r3(h + t / 2), r3(z + dz * d + dx * l)], [w / 2, t / 2, (d1 - d0) / 2].map(r3), r3(face + turn), m);
  };
  if (shelf) {
    // Square slabs 1 m thick, so the underside stays near 7 m over a terrace 8 m down; the extra
    // slabs' tops sit a hair under the walkway's, so the two don't flicker.
    block(-0.8, reach, 0, y - 1, Math.max(5, shelf), 1);
    for (const f of [0.2, 0.55]) {
      const r = rand(1.6, 2.4);
      block(f * reach - r, f * reach + r, rand(-1.5, 1.5), y - 1.05, 2 * r, 1);
    }
    block(reach - shelf / 2, reach + shelf / 2, 0, y - 1.05, shelf, 1);
    if (lit) lamp([r3(x + dx * (reach + 1.2)), y, r3(z + dz * (reach + 1.2))]);
    return;
  }
  const n = rand(0, 1) < 0.5 ? 2 : 3;
  let h = y, out = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const t = k * rand(2, 3.5);
    out = reach * (0.45 + (0.55 * i) / n) * rand(0.9, 1.05);
    l = rand(-1.5, 1.5) * k;
    block(-0.5, out, l, h, k * rand(3, 6), t, rand(-6, 6));
    h += t;
  }
  const r = k * rand(0.9, 1.3);
  block(out / 2 - r, out / 2 + r, l, h, 2 * r, 2.4 * r, rand(0, 45), 'tank');
}

/** A smokestack: two boxes, square and diamond, whose union is a fluted, eight-pointed shaft. */
export function stack(x, z, r = 3, h = 34) {
  box([x - r, 0, z - r], [x + r, h, z + r], 'stack');
  turned([x, h / 2, z], [r, h / 2, r], 45, 'stack');
}

export const railing = (from, to) => decor.push({ kind: 'railing', from, to });
export const pipe = (from, to, r) => decor.push({ kind: 'pipe', from, to, r });
export const lamp = (at) => decor.push({ kind: 'lamp', at });
/** A glowing furnace mouth from corner `from` to `to`, its light (night maps) at `at`. */
export const furnace = (from, to, at) => decor.push({ kind: 'furnace', from, to, at });
/** A glowing sign panel from corner `from` to `to` in `color`, its light (night maps) at `at`. */
export const sign = (from, to, at, color) => decor.push({ kind: 'sign', from, to, at, color });
export const point = (...points) => nav.push(...points);
/** A jump pad at `at` that throws a mech over an arc topping out at height `apex`, down onto `to`. Waypoints at both ends let bots ride it. */
export const pad = (at, to, apex) => {
  pads.push({ at, to, apex });
  point(at, to);
};
export const once = (build) => {
  const before = [solids.length, nav.length];
  build();
  for (let i = before[0]; i < solids.length; i++) single.add(solids[i]);
  for (let i = before[1]; i < nav.length; i++) single.add(nav[i]);
};

const flip = ([x, y, z]) => [r3(-x) || 0, y, r3(-z) || 0];

/**
 * Adds the 180-degree twin of everything authored, then writes `file` (a URL) with `meta` (name,
 * size, night, palette...) and the north team's `spawns` (the south's are their twins).
 */
export function write(file, meta, north) {
  for (const s of [...solids]) {
    if (!single.has(s)) solids.push({ ...s, box: flip(s.box), ...(s.yaw !== undefined && { yaw: r3(s.yaw + 180) }) });
  }
  // Every point a prop has (at, from, to) turns with it.
  for (const d of [...decor]) decor.push(Object.fromEntries(Object.entries(d).map(([k, val]) => [k, Array.isArray(val) ? flip(val) : val])));
  for (const p of [...nav]) if (!single.has(p)) nav.push(flip(p));
  for (const p of [...pads]) pads.push({ at: flip(p.at), to: flip(p.to), apex: p.apex });
  // Ramps and turned boxes keep a yaw; the twin's is 180 more. Untilted boxes need no yaw at all.
  for (const s of solids) if (s.yaw === 0 || s.yaw === undefined) delete s.yaw;

  const map = { ...meta, solids, decor, pads, spawns: [north, north.map(flip)], nav };
  // One solid, prop or waypoint per line, so edits diff cleanly.
  const lines = (key) => `"${key}": [\n    ${map[key].map((v) => JSON.stringify(v)).join(',\n    ')}\n  ]`;
  const head = Object.entries(meta).map(([k, v]) => `"${k}": ${JSON.stringify(v).replaceAll(',', ', ')}`).join(',\n  ');
  writeFileSync(file, `{\n  ${head},\n  ${['solids', 'decor', ...(pads.length ? ['pads'] : [])].map(lines).join(',\n  ')},\n  "spawns": ${JSON.stringify(map.spawns)},\n  ${lines('nav')}\n}\n`);
  console.log(`${meta.name}: ${solids.length} solids, ${decor.length} decor, ${pads.length} pads, ${nav.length} waypoints`);
}
