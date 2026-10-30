// Hivewall: a mining colony carved into a cliff, overrun by the Bloom, a glowing orange fungus that
// has taken the colony's machines. Made for Co-op Defense alone: the Bloom's walkers come out of two
// mine mouths and a burrow on the floor and climb 60 m to the reactor on the cliff's top. Writes
// hivewall.json next to this file; rerun `node maps/hivewall.mjs` after editing.
//
// A 144 x 116 m map on 12 m storeys, authored round the middle of the Shaft and moved into place at
// the end (`AT`). Two climbs, outer and inner, that cross:
// - the Stair, outside on the open cliff face (west): from gate A's yard a flight north up to a
//   landing at 12, a flight east up to 24 and on, level, over the Bridge across the Shaft; out its far
//   side, a flight south up the hive's flank to a landing at 36 and one back north up to the Crown at
//   48. Beside its first flights, the Bastion, a terrace at 20 to build on;
// - the Shaft, inside the wall: the hive's hollow heart, 52 m across and open to the sky, a 12 m ramp
//   spiralling up round its inside walls a storey a side from the floor (gate B comes in from the
//   east, the burrow opens in its floor) to the Crown. The Bridge crosses at 24 over its first side
//   and under its last corner, and the Pod, a platform at 24 off the Bridge, hangs in the middle on
//   its stalk, every turn of the spiral round it; the rim at 48 looks down on it all.
// Both lanes meet on the Crown (48) and go on as one, up the last ramp to the reactor on the Crest
// (60). Cross-links the Bloom can seal: the Tunnel at 12, from the Stair's landing into the Shaft, and
// the Door at 36, out of the Shaft onto the Stair's landing on the far side (and the ways on past
// each, so a seal switches which killzone is hot). Overlooks, where towers stand 8 m+ over a lane
// (out of crawlers' and brutes' reach): the Bastion, the Pod, the rim, a gallery beside the last
// flight and a ledge over its landing, the Crest's edge. Jump pads up to the Crest from gate A's yard,
// the Bastion, the Shaft's floor and the far landing at 36, for pilots (see `PADS`). Every lane is
// wide, for brutes and bosses too. Metrics as the other maps': 9 m+ over wide lanes, 6.5 m+ over
// anything mechs walk, ramps near 23 degrees.
import { box, coopOnly, cylinder, decor, defense, furnace, lamp, nav, pads, pipe, point, r3, railing, sign, slope, solids, turned, write } from './kit.mjs';

const SIZE = [144, 116];
const AT = [4, -18]; // where the Shaft's middle stands on the map
const [XW, XE, ZS, ZN] = [-76, 68, -40, 76]; // the map's edges, about the Shaft's middle
const K = 12 / 28; // a ramp's rise a metre: a storey over 28 m, 23 degrees
const CROWN = 48, CREST = 60;
const BLOOM = '#ff7a1a', SICK = '#ffb347', COLD = '#7fe0ff', RED = '#ff3a2a';

/** Openings carved out of every `block` they cut ([x0, y0, z0, x1, y1, z1]). */
const HOLES = [
  [-30, 24, 10, -25, 34, 22], // the Bridge through the Shaft's west wall
  [25, 24, 6, 30, 34, 22], // and its east wall
  [-58, 12, 22, -25, 21.5, 33], // the Tunnel at 12
  [25, 0, 17.5, 41, 10, 29.5], // gate B's drift
  [25, 36, -26, 30, 46, -12], // the Door at 36
  [29, 24, 10, 41, 47, 22], // the hall at the Bridge's east end, under the Crown
];
/** Splits box `b` round hole `h` (both [x0, y0, z0, x1, y1, z1]) into the boxes left. */
function carve(b, h) {
  if (h[0] >= b[3] || h[3] <= b[0] || h[1] >= b[4] || h[4] <= b[1] || h[2] >= b[5] || h[5] <= b[2]) return [b];
  const out = [];
  let [x0, y0, z0, x1, y1, z1] = b;
  if (h[0] > x0) out.push([x0, y0, z0, h[0], y1, z1]), (x0 = h[0]);
  if (h[3] < x1) out.push([h[3], y0, z0, x1, y1, z1]), (x1 = h[3]);
  if (h[2] > z0) out.push([x0, y0, z0, x1, y1, h[2]]), (z0 = h[2]);
  if (h[5] < z1) out.push([x0, y0, h[5], x1, y1, z1]), (z1 = h[5]);
  if (h[1] > y0) out.push([x0, y0, z0, x1, h[1], z1]);
  if (h[4] < y1) out.push([x0, h[4], z0, x1, y1, z1]);
  return out;
}
/** A box between two corners in plan, from y0 to y1, less the HOLES. */
function block(x0, z0, x1, z1, y0, y1, mat = 'concrete') {
  let parts = [[x0, y0, z0, x1, y1, z1]];
  for (const h of HOLES) parts = parts.flatMap((b) => carve(b, h));
  for (const [a, b, c, d, e, f] of parts) box([a, b, c], [d, e, f], mat);
}
/**
 * A solid ramp, its top from `low` up to `high`, `width` across, solid down to `floor` under its
 * high end (and as deep again under its low end). Its top end stands 2 cm proud of the landing it
 * meets, so a Heavy steps down onto it rather than stopping at the joint.
 */
function wedge(low, high, width, floor, mat = 'concrete') {
  const top = [high[0], high[1] + 0.02, high[2]];
  const run = Math.hypot(top[0] - low[0], top[2] - low[2]), t = Math.atan2(top[1] - low[1], run);
  slope(low, top, width, r3(((top[1] - floor) * Math.cos(t)) / 2), mat);
}
/** A ramp slab half a metre thick, over open space, 2 cm proud at its top (see `wedge`). */
const deck = (low, high, width, mat = 'metal') => slope(low, [high[0], high[1] + 0.02, high[2]], width, 0.25, mat);
const fungus = (x, y, z, r) => decor.push({ kind: 'fungus', at: [r3(x), r3(y), r3(z)], r: r3(r) });
/** Seeded random in [lo, hi). */
const rng = (seed) => (lo = 0, hi = 1) => lo + (hi - lo) * (((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);

// --- Ground, and the cliff's mass round the edges --------------------------------------------------
box([XW, -2, ZS], [XE, 0, ZN], 'ground');
block(XW, ZS, -69, -30, 0, 24, 'rock'); // the rock gate A's mouth is in
block(-69, ZS, -57, -30, 9, 24, 'rock'); // over the mouth
block(XW, -30, -69, 33, 0, 4, 'rock'); // the cliff's lip west of the yard, the first flight and its landing
block(XW, 33, -29, ZN, 0, CREST, 'rock'); // the Crest, west
block(-57, 22, -29, 33, 0, CREST, 'rock'); // over the Tunnel at 12 (and under it)
block(-29, 33, 29, ZN, 0, CREST, 'rock'); // the Crest over the Shaft's north wall
block(29, 33, 41, ZN, 0, CREST, 'rock');
block(41, 45, 53, ZN, 0, CREST, 'rock'); // past the last ramp's head
block(53, 19, XE, ZN, 0, CREST, 'rock'); // the Crest's east strip, beside the last ramp
block(59, ZS, XE, 19, 0, CREST, 'rock'); // behind the east gallery

// --- The Shaft: walls, the spiral, the Bridge and the Pod --------------------------------------------
// Inside 52 m east-west (x -26 to 26) and 59 north-south (z -26 to 33), walls 3 m thick; ramp strips
// 12 m wide round it (19 along the north, for the Tunnel at 12 to come in beside the Bridge), corner landings where they turn, the hollow between.
block(-29, -29, -26, 33, 0, CROWN, 'rock'); // west wall
block(26, -29, 29, 33, 0, CROWN, 'rock'); // east wall
block(-29, ZS, 29, -26, 0, CROWN, 'rock'); // the south wall, its top the rim
// The spiral: corners NE (the floor, then 48 over it), NW 12, SW 24, SE 36; the sides between climb a
// storey each: north (a solid wedge off the floor), then west, south and east (decks, open under).
wedge([14, 0, 23.5], [-14, 12, 23.5], 19, 0, 'concrete'); // side 1, 0 -> 12, westward
block(-26, 14, -14, 33, 0, 12, 'concrete'); // NW corner, 12
deck([-20, 12, 14], [-20, 24, -14], 12); // side 2, 12 -> 24, southward
block(-26, -26, -14, -14, 0, 24, 'concrete'); // SW corner, 24
deck([-14, 24, -20], [14, 36, -20], 12); // side 3, 24 -> 36, eastward
block(14, -26, 26, -14, 0, 36, 'concrete'); // SE corner, 36
deck([20, 36, -14], [20, 48, 14], 12); // side 4, 36 -> 48, northward
block(14, 14, 26, 33, CROWN - 1, CROWN, 'metal'); // NE corner, 48: the spiral's head, out onto the Crown
// The Bridge at 24, west wall to east, over side 1 and under the head; the Pod off it, on its stalk.
block(-29, 10, 29, 22, 23, 24, 'metal');
block(-5, -5, 5, 5, 23, 24, 'metal');
block(-3, 5, 3, 10, 23, 24, 'metal');
cylinder([0, 0, 0], [0, 23, 0], 1.6, 'rust');

// --- The Stair, outside: gate A's yard, two flights up the face to the Bridge, and the Bastion ----------
wedge([-63, 0, -18], [-63, 12, 10], 12, 0); // flight 1, 0 -> 12, northward
block(-69, 10, -57, 33, 0, 12); // the landing at 12 (the Tunnel off its north end)
// Flight 2, 12 -> 24, eastward onto the Bridge: solid down to 10, and a deck over its last 3 m (a
// wedge's end leans out past its top: it would poke through the wall into the Shaft).
const F2 = [-32, r3(12 + 25 * K)];
wedge([-57, 12, 16], [F2[0], F2[1], 16], 12, 10);
deck([F2[0], F2[1], 16], [-29, 24, 16], 12, 'concrete');
block(-57, ZS, -29, 10, 0, 20, 'tower'); // the Bastion, a terrace at 20 beside both flights

// --- The far side: the hall at 24, a flight down to the landing at 36, a flight back up to the Crown -
block(29, 10, 41, 33, 0, CROWN - 1, 'concrete'); // under the Crown (the hall and gate B's drift cut out)
block(29, 10, 41, 33, CROWN - 1, CROWN, 'metal'); // the Crown, over the hall
wedge([35, 24, 10], [35, 36, -18], 12, 24); // flight 3, 24 -> 36, southward (its foot's end clear of gate B's drift)
block(29, -30, 53, -18, 0, 36); // the landing at 36
wedge([47, 36, -18], [47, CROWN, 10], 12, 0); // flight 4, 36 -> 48, northward
block(41, 10, 53, 17, 0, CROWN); // the Crown, east
wedge([47, CROWN, 17], [47, CREST, 45], 12, 0); // the last ramp, 48 -> 60
// The ledge at 44 over the landing at 36 (a ramp up from it onto the rim at its west end), and the
// gallery beside flight 4, 8 m over it, up to the Crest.
block(38, ZS, 59, -30, 0, 44, 'tower');
wedge([38, 44, -35], [29, CROWN, -35], 10, 0, 'tower');
block(53, -30, 59, -18, 0, 44, 'tower');
wedge([56, 44, -18], [56, 56, 10], 6, 0, 'tower');
wedge([56, 56, 10], [56, CREST, 19], 6, 0, 'tower');

// --- Lanes -----------------------------------------------------------------------------------------------
// Named points; edges from, to, weight (the climbs' 3, the cross-links 1).
const lanePoints = [], at = {}, edges = [];
const P = (name, p) => {
  at[name] = lanePoints.length;
  lanePoints.push(p.map(r3));
};
const link = (a, b, w) => edges.push([at[a], at[b], w]);
const chain = (names, w) => names.slice(1).forEach((n, i) => link(names[i], n, w));
const REACTOR = [47, CREST, 46];
const GATES = { A: [-63, 0, -23], B: [36, 0, 23.5], C: [12, 0, -6] }; // C: the burrow, opening last
P('R', REACTOR);
// The Stair.
P('A0', GATES.A);
P('A1', [-63, 0, -18]);
P('A2', [-63, 12, 10]);
P('A12', [-63, 12, 16]);
P('A3', [-57, 12, 16]);
P('A4', [-29, 24, 16]);
P('A5', [29, 24, 16]);
P('A5a', [35, 24, 16]);
P('A6', [35, 24, 10]);
P('A7', [35, 36, -18]);
P('A8', [41, 36, -24]);
P('A8a', [47, 36, -24]);
P('A9', [47, 36, -18]);
P('A10', [47, CROWN, 10]);
P('M', [47, CROWN, 13.5]);
P('M1', [47, CROWN, 17]);
P('M2', [47, CREST, 45]);
// The Shaft.
P('B0', GATES.B);
P('C0', [20, 0, 23.5]);
P('S1', [14, 0, 23.5]);
P('S2', [-14, 12, 23.5]);
P('C1', [-20, 12, 23.5]);
P('S3', [-20, 12, 14]);
P('S4', [-20, 24, -14]);
P('C2', [-20, 24, -20]);
P('S5', [-14, 24, -20]);
P('S6', [14, 36, -20]);
P('C3', [20, 36, -20]);
P('S7', [20, 36, -14]);
P('S8', [20, CROWN, 14]);
P('C4', [20, CROWN, 23.5]);
P('X', [35, CROWN, 13.5]);
P('BC', GATES.C);
// The Tunnel at 12.
P('T0', [-63, 12, 27.5]);
P('T1', [-20, 12, 27.5]);

chain(['A0', 'A1', 'A2', 'A12'], 3);
chain(['A12', 'A3', 'A4', 'A5', 'A5a', 'A6', 'A7', 'A8', 'A8a', 'A9', 'A10', 'M'], 3);
chain(['M', 'M1', 'M2', 'R'], 3);
chain(['B0', 'C0', 'S1'], 3);
link('BC', 'C0', 3);
chain(['S1', 'S2', 'C1', 'S3', 'S4', 'C2', 'S5', 'S6', 'C3'], 3);
chain(['C3', 'S7', 'S8', 'C4', 'X', 'M'], 3);
chain(['A12', 'T0', 'T1', 'C1'], 1); // the Tunnel at 12, into the Shaft
link('C3', 'A7', 1); // the Door at 36, out onto the Stair
// Routes the Bloom can seal (a run starts with one sealed, and between waves it seals another or
// bursts one open, never cutting a gate off from the reactor): each leaves a fork, so walkers there
// take the other way, into or out of the Shaft.
const edgeOf = (a, b) => edges.findIndex(([x, y]) => x === at[a] && y === at[b]);
const seals = [
  [edgeOf('A12', 'T0'), 'the Tunnel at 12'],
  [edgeOf('A12', 'A3'), 'the Stair at 12'],
  [edgeOf('C3', 'A7'), 'the Door at 36'],
  [edgeOf('C3', 'S7'), "the spiral's last turn"],
];
if (seals.some(([e]) => e < 0)) throw new Error('a seal on no edge');

// --- Pads, spawns -------------------------------------------------------------------------------------------
// Pilots' ways back up to the Crest: from gate A's yard, the Bastion, the Shaft's floor and the far
// landing at 36. Pilots only: they stay out of the bots' waypoints (see where they're put down).
const PADS = [
  [[-63, 0, -27], [-62, CREST, 42], 76],
  [[-40, 20, -14], [-46, CREST, 44], 72],
  [[-9, 0, -9], [-9, CREST, 46], 76],
  [[33, 36, -27], [60, CREST, 30], 70],
];
const SPAWNS = [[26, 58], [38, 61], [58, 60], [30, 65], [44, 65], [56, 65]].map(([x, z]) => [x, CREST + 0.1, z]);

// --- Waypoints ------------------------------------------------------------------------------------------
/** Whether a mech standing at `p` (feet) would be inside a solid or under one too low, give or take `margin` m. */
const blocked = (p, margin = 2) =>
  solids.some((s) => {
    const [yaw, tilt] = [((s.yaw ?? 0) * Math.PI) / 180, ((s.tilt ?? 0) * Math.PI) / 180];
    return [1, 2, 3, 4, 5, 6, 7].some((up) => {
      const d = [p[0] - s.box[0], p[1] + up - s.box[1], p[2] - s.box[2]];
      const x1 = d[0] * Math.cos(yaw) - d[2] * Math.sin(yaw), z1 = d[0] * Math.sin(yaw) + d[2] * Math.cos(yaw);
      const y2 = d[1] * Math.cos(tilt) + z1 * Math.sin(tilt), z2 = -d[1] * Math.sin(tilt) + z1 * Math.cos(tilt);
      if (s.shape === 'cylinder') return Math.hypot(x1, z2) < s.half[0] + margin && Math.abs(y2) < s.half[1] + margin;
      return Math.abs(x1) < s.half[0] + margin && Math.abs(y2) < s.half[1] + 0.5 && Math.abs(z2) < s.half[2] + margin;
    });
  });
/** Whether a waypoint at `p` is on a pad (it would throw a mech walking off it). */
const onPad = (p) => PADS.some(([at]) => Math.abs(at[1] - p[1]) < 1 && Math.hypot(at[0] - p[0], at[2] - p[2]) < 5);
/** Waypoints over the rectangle at height y, about `step` apart, each nudged off anything in the way. */
function grid(x0, z0, x1, z1, y, step = 14) {
  const nx = Math.max(1, Math.round((x1 - x0) / step)), nz = Math.max(1, Math.round((z1 - z0) / step));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const [x, z] = [x0 + ((i + 0.5) * (x1 - x0)) / nx, z0 + ((j + 0.5) * (z1 - z0)) / nz];
      const spot = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dz]) => [r3(x + dx), y, r3(z + dz)]).find((p) => !blocked(p) && !onPad(p));
      if (spot) point(spot);
    }
  }
}
/** Waypoints along a lane's points (on ramps, rooms and landings), and between them where far apart. */
function along(names, gap = 20) {
  for (let k = 0; k < names.length; k++) {
    const a = lanePoints[at[names[k]]];
    point(a);
    const b = k + 1 < names.length && lanePoints[at[names[k + 1]]];
    if (!b) continue;
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / gap);
    for (let i = 1; i < n; i++) point([0, 1, 2].map((m) => r3(a[m] + ((b[m] - a[m]) * i) / n)));
  }
}

// --- Dressing -------------------------------------------------------------------------------------------
/** Whether a prop `r` m round at `p` stands at least `clear` m off every lane near its height. */
function offLanes([x, y, z], r, clear = 5.5) {
  return edges.every(([a, b]) => {
    const [p, q] = [lanePoints[a], lanePoints[b]], [dx, dz] = [q[0] - p[0], q[2] - p[2]];
    const s = Math.min(1, Math.max(0, ((x - p[0]) * dx + (z - p[2]) * dz) / (dx * dx + dz * dz || 1)));
    const ly = p[1] + (q[1] - p[1]) * s;
    return Math.hypot(x - p[0] - dx * s, z - p[2] - dz * s) >= clear + r || y > ly + 9 || y < ly - 12;
  });
}
/** Whether a prop `r` m round at (x, z) on height y keeps off the pads' ends, the spawns and the reactor's ring. */
const roomy = (x, y, z, r) =>
  [...PADS.flatMap(([a, b]) => [a, b]), ...SPAWNS].every((p) => Math.abs(p[1] - y) > 2 || Math.hypot(p[0] - x, p[2] - z) > r + 4.5) &&
  Math.hypot(x - REACTOR[0], z - REACTOR[2]) > r + 13;
const tank = (x, y, z, r, h) => offLanes([x, y, z], r) && roomy(x, y, z, r) && cylinder([x, y, z], [x, y + h, z], r, 'tank');
/** A smokestack standing on `y`: two boxes, square and diamond, as kit's `stack`. */
function chimney(x, y, z, r, h) {
  box([x - r, y, z - r], [x + r, y + h, z + r], 'stack');
  turned([x, y + h / 2, z], [r, h / 2, r], 45, 'stack');
}
/** Railings along a drop's edge, posts every 1.6 m (props: a rail stops nobody). */
const rail = (a, b) => railing(a.map(r3), b.map(r3));
/** Glowing tubes on a ceiling at `y`, from (x0, z0) to (x1, z1), lighting the floor `drop` m under. */
const tube = (x0, z0, x1, z1, y, drop = 5, color = COLD) => sign([x0, y - 0.25, z0], [x1, y - 0.05, z1], [r3((x0 + x1) / 2), y - drop, r3((z0 + z1) / 2)], color);
{
  // Gate A: timbered, the Bloom's light deep in it; its yard thick with the Bloom, neon on the walls.
  const r = rng(11);
  for (const x of [-68.5, -57.5]) block(x - 0.5, -30.8, x + 0.5, -30, 0, 9, 'pale');
  block(-69, -30.8, -57, -30, 8.2, 9, 'pale');
  furnace([-68, 0, -39.9], [-58, 7, -39.6], [-63, 4, -34]);
  for (let k = 0; k < 12; k++) fungus(r(-68, -58), 0, r(-39, -19), r(1.2, 3));
  sign([-68.9, 6, -28], [-68.8, 8.5, -21], [-65, 5, -24], SICK);
  sign([-60, 12, -30.15], [-66, 14, -30.05], [-63, 9, -27], RED);
  lamp([-58.5, 0, -20]);
  // The Stair's face: the colony's name over the first flight, lamps up it and round the landing.
  sign([-57.15, 13, -15], [-57.05, 17.5, -3], [-61, 14, -9], SICK);
  for (const p of [[-67.5, 12, 31], [-58.5, 12, 11], [-67.5, 12, 11]]) lamp(p);
  for (const z of [-12, 0]) lamp([-68.4, r3((z + 18) * K), z]);
  for (let k = 0; k < 6; k++) fungus(r(-68, -58), 12, r(12, 29), r(0.8, 2));
  tube(-54, 26.5, -32, 28.5, 21.5); // the Tunnel at 12
  tube(-48, 24.5, -40, 25.1, 21.5, 5, BLOOM);
  // The Bastion: rails on its drops (not where flight 2 comes level with it), tanks, lamps, the Bloom.
  rail([-57, 20, 9.7], [-48, 20, 9.7]);
  rail([-34, 20, 9.7], [-29, 20, 9.7]);
  rail([-56.7, 20, ZS], [-56.7, 20, 9.7]);
  for (const [x, z, rad, h] of [[-52, -36, 2.4, 6], [-44, -37, 2, 5], [-35, -36, 2.6, 6.5], [-32, -24, 2, 5]]) tank(x, 20, z, rad, h);
  for (const p of [[-54, 20, -10], [-38, 20, 4], [-36, 20, -30]]) lamp(p);
  for (let k = 0; k < 8; k++) fungus(r(-55, -31), 20, r(-38, 8), r(0.8, 2.2));
  for (const x of [-55, -43, -31]) sign([x - 4, 8, -29.95], [x + 4, 10, -29.85], [x, 6, -27], [COLD, '#ff4fa0', '#b0ff3a'][Math.round((x + 55) / 12)]);
}
{
  // The Shaft: the stalk thick with the Bloom, its heart on the Pod; the burrow glowing in the floor;
  // cables hanging off the decks; lamps at the corners; tubes and warnings on the walls.
  const r = rng(23);
  fungus(0, 24, 0, 4);
  for (let y = 0; y < 23; y += 4.5) fungus(r(-1, 1), y, r(-1, 1), 2.2);
  sign([8.5, 0.4, -9.5], [15.5, 0.5, -2.5], [12, 3, -6], BLOOM); // the burrow, just over the water
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI;
    fungus(12 + 5 * Math.cos(a), 0, -6 + 5 * Math.sin(a), r(1.2, 2.4));
  }
  for (let k = 0; k < 18; k++) fungus(r(-24, 24), 0, r(-24, 12), r(1.5, 3.5));
  rail([-5, 24, -4.7], [5, 24, -4.7]);
  rail([-4.7, 24, -5], [-4.7, 24, 5]);
  rail([4.7, 24, -5], [4.7, 24, 5]);
  for (const x of [-2.7, 2.7]) rail([x, 24, 5], [x, 24, 10]);
  rail([-29, 24, 21.7], [29, 24, 21.7]);
  rail([-29, 24, 10.3], [-3, 24, 10.3]);
  rail([3, 24, 10.3], [29, 24, 10.3]);
  for (const x of [-20, 20]) lamp([x, 24, 21]);
  lamp([4, 24, 4]);
  // The decks' inner edges: rails, and cables up to the rim.
  rail([-14.3, 12, 14], [-14.3, 24, -14]);
  rail([-14, 24, -14.3], [14, 36, -14.3]);
  rail([14.3, 36, -14], [14.3, CROWN, 14]);
  rail([-14, 12, 14.3], [14, 0, 14.3]);
  for (const t of [0.25, 0.75]) {
    pipe([-14.3, r3(12 + 12 * t), r3(14 - 28 * t)], [-27, CROWN, r3(14 - 28 * t)], 0.12);
    pipe([r3(-14 + 28 * t), r3(24 + 12 * t), -14.3], [r3(-14 + 28 * t), CROWN, -27.5], 0.12);
    pipe([14.3, r3(36 + 12 * t), r3(-14 + 28 * t)], [27, 56, r3(-14 + 28 * t)], 0.12);
  }
  for (const [x, y, z] of [[-24, 12, 31], [-24, 24, -24], [24, 36, -24], [24, CROWN, 31], [24, 0, 31]]) lamp([x, y, z]);
  for (const [x, y, z] of [[-17, 12, 30], [-24, 24, -17], [17, 36, -24], [24, 0, 16]]) fungus(x, y, z, r(1, 2));
  tube(-27, -8, -27, 8, 30, 6);
  sign([-25.95, 30, -10], [-25.85, 44, -7], [-22, 34, -8], SICK);
  sign([25.85, 4, 2], [25.95, 9, 10], [22, 4, 6], RED);
  sign([-8, 40, -25.95], [8, 43, -25.85], [0, 38, -22], RED);
  for (const x of [-20, 0, 20]) pipe([x, 0, 32.6], [x, CROWN + 6, 32.6], 0.35);
  // Gate B's drift: timbered, the Bloom's light at its end, tubes along it.
  for (const z of [17.9, 29.1]) box([26, 0, z - 0.4], [27, 10, z + 0.4], 'pale'); // (in its hole, so not `block`)
  box([26, 9.2, 17.5], [27, 10, 29.5], 'pale');
  furnace([40.9, 0, 18.5], [40.6, 7, 28.5], [36, 4, 23.5]);
  tube(30, 23, 40, 24, 10);
  for (let k = 0; k < 5; k++) fungus(r(30, 40), 0, r(18.5, 28.5), r(1, 2));
  // The rim: rails along its drop, lamps, the Bloom creeping over the lip.
  rail([-26, CROWN, -26.3], [26, CROWN, -26.3]);
  for (const x of [-20, 0, 20]) lamp([x, CROWN, -36]);
  for (let k = 0; k < 6; k++) fungus(r(-26, 26), CROWN, r(-30, -27), r(0.8, 1.6));
}
{
  // The far side: the hall at 24 under the Crown, the landing at 36 and the overlooks over it.
  const r = rng(37);
  tube(30, 16, 40, 16.6, 47);
  for (const p of [[39, 24, 20], [31, 36, -28], [40, 44, -38], [56, 44, -28], [36, CROWN, 30]]) lamp(p);
  rail([29, CROWN, 10.3], [53, CROWN, 10.3]);
  rail([38, 44, -30.3], [59, 44, -30.3]);
  rail([53.3, 44, -30], [53.3, 44, -18]);
  rail([53.3, 44, -18], [53.3, 56, 10]);
  rail([29, 36, -29.7], [38, 36, -29.7]);
  for (let k = 0; k < 6; k++) fungus(r(30, 52), 36, r(-29, -19), r(0.8, 1.8));
  for (let k = 0; k < 4; k++) fungus(r(30, 40), 24, r(11, 21), r(0.8, 1.6));
  pipe([58.6, 30, -30], [58.6, CREST + 3, -30], 0.4);
  pipe([58.6, 50, -30], [58.6, 50, 18], 0.3);
  sign([41.05, 30, -4], [41.15, 33, 4], [44, 30, 0], '#ff4fa0');
  sign([53, 40, -17.9], [59, 42, -17.8], [56, 40, -15], COLD);
}
{
  // The Crest: the atmosphere plant behind the reactor, tanks and stacks, sheds along the back, cover
  // round the reactor's ring, lamps; the Bloom thinning out up here.
  const r = rng(71);
  block(30, 70, 62, ZN, CREST, CREST + 12, 'panel'); // the plant's hall
  block(40, 68, 52, 70, CREST, CREST + 7, 'metal');
  sign([42, CREST + 8.5, 69.85], [50, CREST + 10.3, 70], [46, CREST + 6, 64], COLD); // over its door
  for (const [x, z, rad, h] of [[-62, 66, 6, 14], [-38, 68, 5, 11], [-14, 70, 4, 9], [10, 66, 6, 14], [-66, 40, 4, 10], [64, 52, 3.5, 9]]) {
    tank(x, CREST, z, rad, h);
    pipe([x, CREST + h - 1, z], [x < 30 ? x + 12 : 30, CREST + 9, Math.min(z + 4, 74)], 0.5);
  }
  chimney(-50, CREST, 54, 3, 26);
  chimney(0, CREST, 52, 3, 30);
  chimney(56, CREST + 12, 73, 2, 14);
  for (const [x0, x1] of [[-74, -50], [-30, -8], [12, 24]]) {
    if (offLanes([(x0 + x1) / 2, CREST, 73], (x1 - x0) / 2, 4)) block(x0, r(70, 72), x1, ZN, CREST, CREST + r3(r(6, 9)), r() < 0.5 ? 'panel' : 'rust');
    decor.push({ kind: 'steam', at: [r3((x0 + x1) / 2), CREST + 10, 74] });
  }
  for (let k = 0, placed = 0; k < 400 && placed < 18; k++) {
    const [x, z] = [r(-72, 64), r(36, 66)];
    const crest = (x < 41 && z > 35) || (x >= 53 && z > 20) || z > 47;
    if (!crest || !offLanes([x, CREST, z], 3, 7) || !roomy(x, CREST, z, 3)) continue;
    const [w, d] = r() < 0.5 ? [r(4, 7), 1] : [r(2, 3), r(2, 3)];
    turned([r3(x), CREST + 0.8, r3(z)], [r3(w / 2), 0.8, r3(d / 2)], r3(r(0, 90)), r() < 0.5 ? 'concrete' : 'metal');
    placed++;
  }
  for (const [x, z] of [[30, 40], [64, 40], [-20, 40], [-56, 38], [20, 56], [64, 62]]) if (offLanes([x, CREST, z], 0.5, 4)) lamp([x, CREST, z]);
  rail([-29, CREST, 33.3], [41, CREST, 33.3]);
  rail([-76, CREST, 33.3], [-57, CREST, 33.3]);
  rail([40.7, CREST, 33], [40.7, CREST, 45]);
  rail([53.3, CREST, 19], [53.3, CREST, 45]);
  for (let k = 0; k < 6; k++) fungus(r(-70, 40), CREST, r(34, 37), r(0.8, 1.6));
}

point([44, CREST, 61]); // the first, by the spawns
// The pads are left out of the bots' waypoints (kit's `pad` would add their ends): the infested are
// bots too, and took them up past both killzones to the reactor. Pilots ride them; bots walk.
for (const [at, to, apex] of PADS) pads.push({ at, to, apex });
along(['A0', 'A1', 'A2', 'A12', 'A3', 'A4', 'A5', 'A5a', 'A6', 'A7', 'A8', 'A8a', 'A9', 'A10', 'M', 'M1', 'M2', 'R']);
along(['B0', 'C0', 'S1', 'S2', 'C1', 'S3', 'S4', 'C2', 'S5', 'S6', 'C3', 'S7', 'S8', 'C4', 'X']);
along(['BC', 'C0']);
along(['A12', 'T0', 'T1', 'C1']);
grid(-24, -24, 24, 12, 0, 10); // the Shaft's floor, round the stalk and under the decks
point([-6, 24, 0], [6, 24, 0], [0, 24, -3], [0, 24, 7]); // the Pod
grid(-55, -38, -31, 8, 20, 10); // the Bastion
grid(-68, -29, -58, -19, 0, 6); // gate A's yard
grid(-27, -38, 27, -28, CROWN, 10); // the rim
grid(40, -38, 58, -32, 44, 8); // the ledge at 44
for (const z of [-26, -20]) point([56, 44, z]); // the gallery beside flight 4
for (let z = -14; z < 10; z += 8) point([56, r3(44 + (z + 18) * K), z]);
grid(29, 18, 40, 32, CROWN, 7); // the Crown, north
grid(-74, 35, -29, 74, CREST, 16); // the Crest
grid(-29, 35, 41, 74, CREST, 16);
grid(41, 47, 66, 74, CREST, 12);
grid(54, 20, 66, 47, CREST, 9);

// --- Moved into place, written ------------------------------------------------------------------------------
const move = (p) => [r3(p[0] + AT[0]), p[1], r3(p[2] + AT[1])];
for (const s of solids) s.box = move(s.box);
for (const d of decor) for (const k of ['at', 'from', 'to']) if (d[k]) d[k] = move(d[k]);
nav.splice(0, nav.length, ...nav.map(move));
for (const p of pads) [p.at, p.to] = [move(p.at), move(p.to)];
defense({ at: move(REACTOR), radius: 8 }, [GATES.A, GATES.B, GATES.C].map(move), { points: lanePoints.map(move), edges, narrow: [], seals }, [2]);
coopOnly();
// The hive's side (its infested mechs come out of the gates anyway): two at each.
const infested = [[-67, 0.1, -22], [-59, 0.1, -22], [36, 0.1, 19], [36, 0.1, 25], [8, 0.1, -9], [15, 0.1, -3]].map(move);
// Night over the cliff: the sky a dull rust over black, the Bloom's glow on the haze low down,
// spores drifting up out of it, windows lit up the colony.
const palette = {
  sunDir: [0.35, 0.4, -0.85],
  sky: { horizon: '#5c2a16', zenith: '#0b0605', sun: '#ffb27a', stars: 0.05 },
  fog: [40, 250],
  haze: ['#9a4214', 0.045, 7],
  light: { sky: '#8c6a58', ground: '#3a1c0e', ambient: 1.8, sun: '#ffa070', direct: 1 },
  lamp: '#ffb060',
  tint: '#e6d2c2',
  windows: ['#ffb060', '#ff8a3a', '#ffd890', '#7fe0ff'],
  skyline: 'desert',
  cover: 0.7,
  water: { level: 0.35, color: '#2a1a10', opacity: 0.85 },
  motes: [{ color: [[1, 0.55, 0.15], [1, 0.35, 0.05]], rate: 60, size: 0.18, drift: 0.4, rise: 0.6, life: 7 }],
  ambience: 'hive',
};
console.log(`lanes: ${lanePoints.length} points, ${edges.length} edges`);
write(new URL('./hivewall.json', import.meta.url), { name: 'Hivewall', size: SIZE, night: true, palette }, SPAWNS.map(move), infested);
