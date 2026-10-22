// Map-authoring kit shared by the generator scripts (foundry.mjs, verdigris.mjs): boxes, ramps and
// props, then `write`, which adds the 180-degree twin of everything and writes the JSON.
//
// Author one half (z > 0, plus pieces straddling z = 0 on one side); `write` adds the rest, so
// both teams get the same map. Wrap pieces that are their own twin in `once`.
import { writeFileSync } from 'node:fs';

export const solids = [], decor = [], nav = [];
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
  // Ramps and turned boxes keep a yaw; the twin's is 180 more. Untilted boxes need no yaw at all.
  for (const s of solids) if (s.yaw === 0 || s.yaw === undefined) delete s.yaw;

  const map = { ...meta, solids, decor, spawns: [north, north.map(flip)], nav };
  // One solid, prop or waypoint per line, so edits diff cleanly.
  const lines = (key) => `"${key}": [\n    ${map[key].map((v) => JSON.stringify(v)).join(',\n    ')}\n  ]`;
  const head = Object.entries(meta).map(([k, v]) => `"${k}": ${JSON.stringify(v).replaceAll(',', ', ')}`).join(',\n  ');
  writeFileSync(file, `{\n  ${head},\n  ${['solids', 'decor'].map(lines).join(',\n  ')},\n  "spawns": ${JSON.stringify(map.spawns)},\n  ${lines('nav')}\n}\n`);
  console.log(`${meta.name}: ${solids.length} solids, ${decor.length} decor, ${nav.length} waypoints`);
}
