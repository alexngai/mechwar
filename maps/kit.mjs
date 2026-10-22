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
 * Coral grown onto a structure: from `root`, a point on its face, a chunky limb of lumps reaches
 * `reach` m out along `dir` ([dx, dz], unit), wandering and curling upward, with a finger forking
 * off each joint; `size` scales its girth. It hangs up to 2.5 * `size` m under `root` at the face
 * and rises from there, but clearance under it is the caller's: keep it 6.5 m+ over anywhere mechs
 * walk. With `shelf`, a table coral instead: slabs overlapping at odd angles, their tops level
 * with `root` so mechs can walk out on them, `shelf` m across at the tip, lumps hanging under; with
 * `lit`, a lamp on it. The shape is random but seeded by `root`, so a rerun writes the same map.
 */
export function coral(root, dir, reach, { size = 1, shelf = 0, lit = false, mat = 'rock' } = {}) {
  const [x, y, z] = root, [dx, dz] = dir, k = size;
  let seed = (Math.abs(Math.round(x * 73 + y * 151 + z * 283)) % 2147483646) + 1;
  const rand = (lo, hi) => lo + (hi - lo) * (((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
  // Distance `d` along dir, `l` to its left, at height `h`.
  const at = (d, l, h) => [r3(x + dx * d - dz * l), r3(h), r3(z + dz * d + dx * l)];
  const lump = (c, r, tilt = 20) => turned(c, [r3(r * rand(0.8, 1.1)), r3(r * rand(0.7, 0.9)), r3(r * rand(0.8, 1.1))], r3(rand(0, 90)), mat, r3(rand(-tilt, tilt)));
  if (shelf) {
    const T = 1.4, top = y - T / 2;
    beam(at(-0.8, 0, top), at(reach, rand(-0.5, 0.5), top), Math.max(5, shelf), T, mat);
    turned(at(reach, 0, top), [shelf / 2, T / 2, shelf / 2], r3(rand(15, 35)), mat);
    turned(at(rand(0.45, 0.6) * reach, rand(1, 2) * (rand(0, 1) < 0.5 ? -1 : 1), top), [r3(0.35 * shelf), T / 2, r3(0.4 * shelf)], r3(rand(0, 90)), mat);
    // Lumps under it, low enough that none breaks the walking surface.
    for (const [d, r] of [[0, 1.6], [0.35, 1.4], [0.8, 1.1]]) lump(at(d * reach, rand(-0.8, 0.8), y - 0.4 - 1.4 * r), r);
    if (lit) lamp(at(reach + 1.2, 0, y));
    return;
  }
  // A segment from `from` ([d, l, h]) `len` m along `heading` (degrees off dir), `pitch` up, `t`
  // thick, capped with a lump; returns its end.
  const grow = (from, heading, pitch, len, t) => {
    const [a, b] = [heading, pitch].map((g) => (g * Math.PI) / 180);
    const end = [from[0] + len * Math.cos(b) * Math.cos(a), from[1] + len * Math.cos(b) * Math.sin(a), from[2] + len * Math.sin(b)];
    beam(at(...from), at(...end), r3(1.15 * t), r3(t), mat);
    lump(at(...end), 0.8 * t);
    return end;
  };
  // The limb: three segments, each thinner and steeper, a finger forking off each of the first two.
  let p = [-0.8 * k, 0, y + 1.3 * k], heading = 0;
  for (const [len, pitch, t, finger] of [[0.42, rand(4, 14), 2.6, 0.4], [0.34, rand(24, 38), 2, 0.3], [0.28, rand(48, 66), 1.4, 0]]) {
    p = grow(p, (heading += rand(-14, 14)), pitch, len * reach, t * k);
    if (finger) grow(p, heading + rand(40, 65) * (rand(0, 1) < 0.5 ? -1 : 1), rand(35, 60), finger * reach, 0.6 * t * k);
  }
  // A crust of lumps where it grips the face.
  for (let i = 0; i < 4; i++) lump(at(rand(-0.3, 0.8) * k, rand(-2, 2) * k, y + rand(-0.5, 2.5) * k), rand(1, 1.5) * k, 25);
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
