// Sinkhole: a 200 m open-pit mine on the day shift, under dust. An eight-sided pit steps down in
// benches (rim 0, benches -7, -14 and -21, floor -28, flooded with rust-red runoff), cut through
// banded strata and joined by a double spiral of haul ramps; three bridges cross it through the
// center at -7, 0 and +8, each turned 60 degrees from the last. Under each team's front rim are the
// old workings: a station at -14 opening onto the pit's -14 bench, reached from the surface down a
// broad haul decline, a narrower drift, or the shaft under the headframe (drop in; its cage pad
// throws you back out). A narrow adit runs in under the east rim from the -7 bench. A bucket-wheel
// excavator stands on each side rim with its wheel out over the pit.
// Writes sinkhole.json next to this file; rerun `node maps/sinkhole.mjs` after editing.
//
// The north half (z > 0) and the sides facing 0-135 degrees are authored here; `write`
// (maps/kit.mjs) adds the 180-degree twin. Metrics as Riftline's: 8 m terraces, 6.5 m+ under
// every deck, ramps near 24 degrees. A side "facing" d degrees has its outward normal d degrees
// clockwise from north; on it, p runs outward from the center and s runs clockwise along it.
// Every class goes everywhere: the workings are 10, 6 and 5 m wide and give a Heavy (5.8 m tall)
// 6.5 m of headroom (6 under the -7 bench).
import { bases, beam, box, cylinder, decor, flagStand, flags, growth, lamp, once, pad, pipe, point, r3, railing, ramp, sentries, sign, silos, slope, turned, write } from './kit.mjs';

const BASE = -29; // bottom of every rock mass
const AMBER = '#ffae2a';
const T = Math.tan(Math.PI / 8); // half a side over the apothem
// The floor and the three benches: inner and outer apothem, and height. The rim starts at 50.
const BANDS = [[0, 26, -28], [26, 34, -21], [34, 42, -14], [42, 50, -7]];
const RIM = 50, H = [-28, -21, -14, -7, 0];
// The rock of the ring rising from H[k] to H[k + 1] (the rim's last): strata, darkest deepest.
const STRATA = ['shale', 'stone', 'ore', 'clay'];
const SIDES = [0, 45, 90, 135]; // the twin adds 180-315

/** World [x, z] of (p, s) on the side facing `deg`. */
const at = (deg, p, s) => {
  const r = (deg * Math.PI) / 180;
  return [r3(p * Math.sin(r) + s * Math.cos(r)), r3(p * Math.cos(r) - s * Math.sin(r))];
};
/** World [x, z] `d` meters out from the center toward `deg`. */
const along = (deg, d) => at(deg, d, 0);
/** A prop slab from corner `from` to `to` that nothing collides with. */
const plate = (from, to, mat) => decor.push({ kind: 'slab', from: from.map(r3), to: to.map(r3), mat });

// --- The workings: voids cut out of the north and east rims (world [min, max] corners) ------------
const MINE = [
  [[-5, -14, 42], [5, -8, 56]], // adit: the -14 bench in to the station, under the -7 bench
  [[-8, -14, 56], [8, -7.5, 64]], // station
  [[-8, -14, 64], [8, 0, 72]], // shaft, open to the sky, against the base's front wall
  [[-48, -14, 57.5], [-8, 0, 67.5]], // haul decline, west to the surface
  [[8, -14, 58], [14, -7.5, 64]], // drift, east (level, then climbing)
  [[14, -14, 58], [48.6, 0, 64]],
  [[50, -7, -14.5], [62, -0.5, -9.5]], // narrow adit, from the east -7 bench (level, then climbing)
  [[62, -7, -14.5], [81.2, 0, -9.5]],
];

/** Axis-aligned boxes of `mat` filling [lo, hi] except the workings. */
function carved(lo, hi, mat) {
  let pieces = [[lo, hi]];
  for (const [vlo, vhi] of MINE) {
    pieces = pieces.flatMap(([a, b]) => {
      if ([0, 1, 2].some((i) => vhi[i] <= a[i] || vlo[i] >= b[i])) return [[a, b]];
      // Slice off what's below and above the void, then either side of it, then before and after.
      const out = [], cur = [[...a], [...b]];
      for (const i of [1, 0, 2]) {
        if (cur[0][i] < vlo[i]) out.push([[...cur[0]], cur[1].map((v, j) => (j === i ? vlo[i] : v))]), (cur[0][i] = vlo[i]);
        if (cur[1][i] > vhi[i]) out.push([cur[0].map((v, j) => (j === i ? vhi[i] : v)), [...cur[1]]]), (cur[1][i] = vhi[i]);
      }
      return out;
    });
  }
  for (const [a, b] of pieces) box(a, b, mat);
}

/** Rock from BASE up to `top` over [x0, z0]-[x1, z1], gravel on top, the workings cut out. */
function rock([x0, z0], [x1, z1], top, mat) {
  carved([x0, BASE, z0], [x1, top - 1, z1], mat);
  carved([x0, top - 1, z0], [x1, top, z1], 'gravel');
}

/**
 * Rock from BASE to `top` on the side facing `deg`, from apothem p0 to p1 and `half` along it,
 * with gravel on top. Diagonal sides sit 2 cm low, so where they overlap a square side the tops
 * never z-fight.
 */
function slab(deg, p0, p1, half, top, mat) {
  if (deg === 0) return rock([-half, p0], [half, p1], top, mat);
  const h = top - (deg % 90 ? 0.02 : 0), [x, z] = at(deg, (p0 + p1) / 2, 0), depth = r3((p1 - p0) / 2);
  turned([x, r3((BASE + h - 1) / 2), z], [r3(half), r3((h - 1 - BASE) / 2), depth], deg, mat);
  turned([x, r3(h - 0.5), z], [r3(half), 0.5, depth], deg, 'gravel');
}

/** A craggy boulder of `mat` on the face of the ring whose inner apothem is `p`, from `bottom` to `top`. */
function boulder(deg, p, s, bottom, top, w, yaw, mat) {
  const [x, z] = at(deg, p - 0.4, s);
  turned([x, r3((bottom + top) / 2), z], [r3(w / 2), r3((top - bottom) / 2), 1.6], r3(deg + yaw), mat);
}

/**
 * A decline in the workings, running along X: its floor climbing from `low` to `high` (centered on
 * `low`'s z), `width` across, roofed `clear` m over the floor until it breaks out into an open cut.
 * Returns its floor height at x.
 */
function decline(low, high, width, clear) {
  const rise = (high[1] - low[1]) / (high[0] - low[0]), floor = (x) => low[1] + (x - low[0]) * rise;
  const z = low[2], out = low[0] + (-0.5 - clear - low[1]) / rise; // where the roof meets the surface
  slope(low, high, width, 8, 'gravel'); // thick: down into the rock under the void
  if (Math.abs(out - low[0]) > 0.5) slope([low[0], low[1] + clear + 0.5, z], [out, 0, z], width, 0.25, 'clay');
  // Rock over the roof up to the surface, in steps (hidden pockets between them and the roof).
  const [x0, x1] = [low[0], out].sort((a, b) => a - b);
  for (let x = x0; x < x1 - 1e-6; x += 3) {
    const xe = Math.min(x + 3, x1), bottom = r3(Math.max(floor(x), floor(xe)) + clear + 0.5);
    if (bottom < -1) box([r3(x), bottom, z - width / 2], [r3(xe), -1, z + width / 2], 'clay');
    if (bottom < -0.05) box([r3(x), Math.max(bottom, -1), z - width / 2], [r3(xe), 0, z + width / 2], 'gravel');
  }
  // Railings along the open cut's lips.
  const [c0, c1] = [out, high[0]].sort((a, b) => a - b);
  for (const side of [-1, 1]) railing([r3(c0), 0, z + (side * width) / 2], [r3(c1), 0, z + (side * width) / 2]);
  return floor;
}

/** Steel sets every `step` m along X from x0 to x1 in a working `width` across, and amber strips. */
function sets(x0, x1, step, z, width, floor, clear) {
  for (let x = x0, i = 0; x <= x1 + 1e-6; x += step, i++) {
    const y = floor(x), [n, s] = [z - width / 2, z + width / 2];
    plate([x - 0.15, y, n], [x + 0.15, y + clear, n + 0.3], 'trim');
    plate([x - 0.15, y, s - 0.3], [x + 0.15, y + clear, s], 'trim');
    plate([x - 0.15, y + clear - 0.25, n], [x + 0.15, y + clear, s], 'trim');
    const m = x + step / 2, ym = floor(m);
    if (i % 2 && m < x1) sign([r3(m - 0.9), r3(ym + 2.4), s - 0.06], [r3(m + 0.9), r3(ym + 2.7), s], [r3(m), r3(ym + 2), z], AMBER);
  }
}

// --- The pit: floor, bench rings and the rim ---------------------------------------------------------
once(() => box([-30, BASE, -30], [30, -28, 30], 'ground'));
for (let k = 1; k < 4; k++) for (const deg of SIDES) slab(deg, BANDS[k][0], BANDS[k][1], BANDS[k][1] * T, BANDS[k][2], STRATA[k - 1]);
// The rim: square blocks out to the walls, a block in each of the square's corners, and diagonal
// blocks over the octagon's corners (no deeper than the corner blocks, so they stay clear of the
// workings).
rock([-RIM, RIM], [RIM, 100], 0, 'clay');
rock([RIM, -RIM], [100, RIM], 0, 'clay');
for (const x0 of [RIM, -100]) rock([x0, RIM], [x0 + 100 - RIM, 100], 0, 'clay');
const CORNER = RIM * Math.SQRT1_2;
rock([CORNER, CORNER], [RIM, RIM], 0, 'clay');
rock([CORNER, -RIM], [RIM, -CORNER], 0, 'clay');
for (const deg of [45, 135]) slab(deg, RIM, (RIM + CORNER) * Math.SQRT1_2, RIM * T, 0, 'clay');

// The double spiral: on each side in turn, a ramp up the next ring's wall to a landing at its
// top, so climbing walks you round the pit. Its twin climbs the other way round.
for (let k = 0; k < 4; k++) {
  const deg = SIDES[k], wall = BANDS[k][1], p = wall - 3.5;
  const [lx, lz] = at(deg, p, -8), [hx, hz] = at(deg, p, 8);
  ramp([lx, H[k], lz], [hx, H[k + 1], hz], 7, 'metal', true);
  // The landing runs half a meter into the ring, 1 cm under its top (no z-fighting).
  const top = H[k + 1] - 0.01, [x, z] = at(deg, wall - 3.25, 10);
  turned([x, r3((H[k] + top - 1) / 2), z], [2, r3((top - 1 - H[k]) / 2), 3.75], deg, STRATA[k]);
  turned([x, r3(top - 0.5), z], [2, 0.5, 3.75], deg, 'gravel');
}
// Boulders break up each ring's face, except where a ramp climbs it or the adit comes out.
for (let k = 0; k < 4; k++) {
  const p = BANDS[k][1], bottom = H[k], top = H[k + 1] - 0.6;
  for (const deg of SIDES) {
    if (deg === SIDES[k] || (deg === 0 && k === 2)) continue;
    const j = Math.sin((deg + 7) * (k + 3)) * 0.5; // a stable jitter per spot
    boulder(deg, p, -6 + j * 3, bottom, top, 5 + j * 2, j * 15, STRATA[k]);
  }
}

// --- Bridges: the conveyor gantry (-7, N-S), the haul road (0, 60 degrees) and the high bridge (+8, 120)
const ROAD = 60, HIGH = 120;
once(() => {
  box([-4, -7.48, -44], [4, -6.98, 44], 'metal'); // into the -7 bench, 2 cm proud of it
  for (const x of [-4, 4]) railing([x, -6.98, -44], [x, -6.98, 44]);
  turned([0, -0.23, 0], [5, 0.25, 54], ROAD, 'metal'); // onto the rim, 2 cm proud of it
  turned([0, 7.75, 0], [4, 0.25, 64], HIGH, 'metal');
  for (const [deg, half, y, d] of [[ROAD, 5, 0.02, 54], [HIGH, 4, 8, 64]]) {
    for (const s of [-half, half]) {
      const [x0, z0] = at(deg, -d, s), [x1, z1] = at(deg, d, s);
      railing([x0, y, z0], [x1, y, z1]);
    }
  }
  point([0, -28, 0], [0, -7, 0], [0, 0.02, 0], [0, 8, 0]);
});
plate([1.4, -6.98, 0], [3.6, -6.9, 44], 'soot'); // the gantry's conveyor belt (and its twin)
// Down from the high bridge to the rim at each end.
const [hx0, hz0] = along(HIGH + 180, 64), [hx1, hz1] = along(HIGH + 180, 83);
ramp([hx1, 0, hz1], [hx0, 8, hz0], 8);
// Truss posts down to the floor, at the deck edges (never in a walkway), with amber beacons.
for (const [deg, half, under] of [[0, 4.4, -7.5], [ROAD, 5.4, -0.5], [HIGH + 180, 4.4, 7.5]]) {
  for (const s of [-half, half]) {
    const [x, z] = at(deg, 16, s);
    box([r3(x - 0.2), -28, r3(z - 0.2)], [r3(x + 0.2), under, r3(z + 0.2)], 'metal');
  }
  const [x, z] = at(deg, 16, half);
  sign([r3(x - 0.25), -14, r3(z - 0.25)], [r3(x + 0.25), -9, r3(z + 0.25)], [x, -11, z], AMBER);
}

// --- The workings under the north rim ----------------------------------------------------------------
// The station at -14 joins the adit (south, onto the -14 bench), the shaft (north), the haul
// decline (west) and the drift (east).
const haul = decline([-8, -14, 62.5], [-48, 0, 62.5], 10, 6.5);
const drift = decline([14, -14, 61], [48.6, 0, 61], 6, 6.5);
for (let z = 44; z <= 54; z += 5) { // the adit's sets, across it
  for (const x of [-5, 4.7]) plate([x, -14, z - 0.15], [x + 0.3, -8, z + 0.15], 'trim');
  plate([-5, -8.25, z - 0.15], [5, -8, z + 0.15], 'trim');
}
sets(-26, -10, 4, 62.5, 10, haul, 6.5);
sets(10, 30, 4, 61, 6, (x) => (x < 14 ? -14 : drift(x)), 6.5);
// The shaft: railings round its collar, the cage's pad (it throws a mech up and out west, in front
// of the base's west gate), and the headframe: south legs on the station's roof, north legs on the
// base's front wall, a crown with two sheaves, the hoist ropes down the shaft.
railing([-8, 0, 64], [8, 0, 64]);
for (const x of [-8, 8]) railing([x, 0, 64], [x, 0, 71.8]);
pad([1.5, -14, 68], [-16, 0, 68], 6);
for (const x of [-8.5, 8.5]) {
  box([x - 0.5, 0, 63], [x + 0.5, 20, 64], 'hazard');
  box([x - 0.5, 9, 72], [x + 0.5, 20, 73], 'hazard');
  box([x - 0.5, 20, 63], [x + 0.5, 21, 73], 'hazard');
}
for (const z of [63.5, 72.5]) box([-9, 20, z - 0.5], [9, 21, z + 0.5], 'hazard');
beam([-8.5, 0.5, 63.5], [8.5, 19.5, 63.5], 0.6, 0.6, 'hazard'); // braces: south face, east face
beam([8.5, 0.5, 64], [8.5, 19.5, 72], 0.6, 0.6, 'hazard');
for (const z of [66, 70]) {
  cylinder([-0.4, 22.6, z], [0.4, 22.6, z], 2, 'metal');
  pipe([0, 20.6, z], [0, -9, z], 0.07);
}
sign([-0.3, 21, 67.7], [0.3, 21.3, 68.3], [0, 22, 68], AMBER);

// --- The narrow adit under the east rim: from the -7 bench, level, then up to the surface ----------
decline([62, -7, -12], [81.2, 0, -12], 5, 6.5);
sets(51, 60, 3, -12, 5, () => -7, 6.5);

// --- Machinery on the rim: the excavator, haul trucks, floodlight masts -------------------------------
// A bucket-wheel excavator on the east rim, its boom out over the pit (12 m over the rim at its
// lowest, its wheel 9 m clear over the benches).
for (const z of [3, 13.5]) box([64, 0, z], [82, 2.6, z + 3.5], 'soot'); // crawler tracks
box([66, 2.6, 4], [80, 9, 16], 'hazard'); // the house
box([62, 6, 11], [66, 10, 15.5], 'panel'); // operator's cab
cylinder([73, 9, 10], [73, 10.5, 10], 5, 'metal'); // slewing ring
beam([70, 11, 10], [36, 15, 10], 3, 2.4, 'hazard'); // boom
cylinder([36, 15, 8.5], [36, 15, 11.5], 6, 'hazard'); // bucket wheel
cylinder([36, 15, 8], [36, 15, 12], 1.6, 'trim');
beam([76, 11, 10], [93, 13, 10], 2.5, 2, 'hazard'); // counter-jib
box([91, 9.5, 7], [97, 14.5, 13], 'concrete'); // counterweight
beam([74, 10.5, 10], [76, 24, 10], 1.2, 1.2, 'metal'); // mast, and its stays
pipe([76, 24, 10], [40, 16.2, 10], 0.12);
pipe([76, 24, 10], [93, 14.5, 10], 0.12);

/** A haul truck at (x, y, z), its cab toward -Z turned `yaw` degrees: the bed (3.2 m: a hover-up) behind. */
function truck([x, y, z], yaw) {
  const r = (yaw * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const w = (dx, dy, dz) => [r3(x + dx * c + dz * s), r3(y + dy), r3(z - dx * s + dz * c)];
  turned(w(0, 1.4, 0), [2, 0.4, 4.6], yaw, 'soot');
  turned(w(0, 2.5, 1.2), [2.5, 0.7, 3.4], yaw, 'hazard');
  turned(w(0, 3, -3.4), [2.2, 1.2, 1.1], yaw, 'hazard');
  for (const dz of [-3.3, 1.6, 3.6]) for (const dx of [-2.2, 2.2]) cylinder(w(dx - 0.5, 1.2, dz), w(dx + 0.5, 1.2, dz), 1.2, 'soot');
}
truck([-42, 0, 80], 20);
truck([80, 0, 38], -30);

/** A floodlight mast at (x, z), its lamps facing south (`dir` -1) or north (1). */
function mast(x, z, dir) {
  box([x - 0.3, 0, z - 0.3], [x + 0.3, 16, z + 0.3], 'metal');
  box([x - 1.4, 16, z - 1.4], [x + 1.4, 17.4, z + 1.4], 'soot');
  const f = z + dir * 1.4;
  sign([x - 1.2, 16.2, Math.min(f, f + dir * 0.05)], [x + 1.2, 17.2, Math.max(f, f + dir * 0.05)], [x, 15, z + dir * 4], '#fff2d0');
}
mast(-30, 54, -1);
mast(40, 54, -1);
mast(75, -28, 1);

// --- Rim: rock, a pump house, a pylon, and the north base -------------------------------------------
turned([-52, 3.5, 82], [3, 3.5, 2.5], -15, 'ore'); // a tall rock to hide behind
turned([-88, 4, 20], [5, 4, 4], 10, 'ore');
box([58, 0, 56], [72, 7, 68], 'panel'); // pump house (it keeps the pit from flooding), roof by ramp
ramp([65, 0, 84], [65, 7, 68], 7);
railing([58, 7, 56], [72, 7, 56]);
pipe([58, 1.2, 57], [37, 1.2, 37], 0.5); // its main, along the rim and over the edge
pipe([37, 1.2, 37], [35.6, -6.5, 35.6], 0.5);
/** A spoil heap at (x, z): rings of gravel stepping up (1.2 m each: a hover climbs them). */
function stockpile(x, z) {
  for (let i = 0, r = 6.5; r > 1; i++, r -= 1.3) cylinder([x, i * 1.2, z], [x, (i + 1) * 1.2, z], r3(r), 'gravel');
}
stockpile(-62, 92);
stockpile(45, 92);
box([-80, 0, 70], [-78, 24, 72], 'metal'); // cable pylon, blocks built out both ways
lamp([-79, 24, 71]);
growth([-78, 18, 71], [1, 0], 5, { size: 0.8 });
growth([-80, 18, 71], [-1, 0], 5, { size: 0.8 });
// A slab platform built off the north rim over the pit, level with it: a lookout over the
// bridges (7 m clear over the -7 bench below). Its twin hangs off the south rim.
growth([-18, 0, RIM], [0, -1], 8, { shelf: 5, lit: true });
point([-18, 0, 43]);
box([-30.5, 0, 72], [-20, 9, 73], 'concrete'); // base front wall, gates at x +-15
box([-10, 0, 72], [10, 9, 73], 'concrete');
box([20, 0, 72], [30.5, 9, 73], 'concrete');
box([-30.5, 0, 73], [-29.5, 9, 100], 'concrete');
box([29.5, 0, 73], [30.5, 9, 100], 'concrete');
box([10, 0, 88], [26, 6, 100], 'panel'); // relay station
sign([-10, 4, 71.8], [-5, 6.5, 72], [-7.5, 3, 70], AMBER);
for (const [deg, p, s, y] of [[0, 52, -14, 0], [90, 52, 10, 0], [45, 47, -14, -7], [0, 39, 12, -14], [90, 31, 0, -21]]) {
  const [x, z] = at(deg, p, s);
  lamp([x, y, z]);
}
for (const at_ of [[-25, 0, 70], [25, 0, 70], [-24, 0, 96]]) lamp(at_);
box([100, -1, -101], [101, 20, 101], 'clay'); // perimeter cliffs
box([-101, -1, 100], [101, 20, 101], 'clay');

// --- Jump pads: the pit floor out to the east rim, and the -21 bench up onto the gantry ---------
pad([21, -28, 0], [58, 0, 0], 3);
pad([-11, -21, 28], [0, -7, 28], -2);

// --- Waypoints -----------------------------------------------------------------------------------
// The floor, then each bench: a point at every side's middle and corner, except where a ramp
// or landing stands; there, the ramp's foot and its landing.
point(...[[45, 12], [90, 12], [135, 12]].map(([deg, p]) => { const [x, z] = at(deg, p, 0); return [x, -28, z]; }));
for (let k = 0; k < 4; k++) {
  const deg = SIDES[k], wall = BANDS[k][1], [fx, fz] = at(deg, wall - 3.5, -11.5), [lx, lz] = at(deg, wall - 3.25, 10);
  point([fx, H[k], fz], [lx, H[k + 1], lz]);
}
for (let j = 1; j < 4; j++) {
  const [p0, p1, h] = BANDS[j], mid = (p0 + p1) / 2;
  for (const deg of SIDES) {
    if (deg === SIDES[j]) continue; // the ramp, and its landing round the next corner
    const [x, z] = at(deg, mid, 0), [cx, cz] = at(deg + 22.5, mid / Math.cos(Math.PI / 8), 0);
    point([x, h, z], [cx, h, cz]);
  }
}
for (const deg of SIDES) {
  const [x, z] = at(deg, 58, 0), [cx, cz] = at(deg + 22.5, 58 / Math.cos(Math.PI / 8), 0);
  point([x, 0, z], [cx, 0, cz]);
}
point([0, -7, 22], [0, -7, 40]); // the gantry
for (const d of [22, 44]) { const [x, z] = along(ROAD, d); point([x, 0.02, z]); }
for (const d of [24, 44, 62]) { const [x, z] = along(HIGH + 180, d); point([x, 8, z]); }
{ const [x, z] = along(ROAD, 62); point([x, 0, z]); }
{ const [x, z] = along(HIGH + 180, 88); point([x, 0, z]); }
point([0, -14, 48], [0, -14, 60]); // adit, station
for (const x of [-20, -34]) point([x, r3(haul(x)), 62.5]); // down the haul decline
point([-54, 0, 62.5]);
point([11, -14, 61], [24, r3(drift(24)), 61], [54, 0, 61]); // through the drift
point([56, -7, -12], [70, r3((70 - 62) * 7 / 19.2 - 7), -12], [85, 0, -12]); // and the narrow adit
point([65, 0, 88], [62, 7, 62], [68, 7, 62]); // pump house
point([-15, 0, 68], [15, 0, 68], [-15, 0, 80], [15, 0, 78], [0, 0, 94], [-60, 0, 60], [-70, 0, 80], [-85, 0, 85], [45, 0, 80], [85, 0, 85], [86, 0, 60], [90, 0, 30], [85, 0, 15]);

// --- Objectives ----------------------------------------------------------------------------------
// Missile Assault: B on the pit floor under all three bridges, A at the high bridge's north-west
// head (C its twin at the other end): the bridge runs straight between them over B.
bases([-16, 0, 88]);
// Base guns: either side of the yard's front.
sentries([[-17, 0, 73.5], [18, 0, 73.5]]);
// Capture the Flag: the stand outside the yard's west wall, its back to the base guns, its doorways
// to the rim and the west gate.
flags(flagStand([-47, 0, 90], 0));
// B's launch pad is between two of the bridges, open to the sky.
silos({ at: [-70, 0, 40], radius: 10, band: 4, pad: [-75, 0, 39.5] }, { at: [0, -28, 0], radius: 14, band: 4, pad: [-4.5, -28, 7.5] });

// --- Spawns, twin, write -------------------------------------------------------------------------
const north = [[-20, 0.1, 84], [-12, 0.1, 92], [12, 0.1, 80], [20, 0.1, 82]];
// An overcast day shift: dust lying in the pit and blowing over the rim, the sun a pale disc,
// the runoff on the floor rust-red, mesas out past the spoil.
const palette = {
  sky: { horizon: '#cdb89a', zenith: '#8a94a0', sun: '#fff0d6', stars: 0 },
  fog: [80, 320],
  haze: ['#bfa684', 0.03, 8],
  light: { sky: '#e6dccb', ground: '#6e5c48', ambient: 1.5, sun: '#fff0d8', direct: 2.3 },
  lamp: '#ffd8a0',
  tint: '#f4eadc',
  skyline: 'desert',
  water: { level: -27.4, color: '#9c4a1a', opacity: 0.85 },
  motes: { color: [[0.86, 0.76, 0.6], [0.72, 0.62, 0.48]], rate: 30, size: 0.14, drift: 2.5, rise: 0.1, life: 5 },
  cover: 0.55, // shade in the workings and under the bridges
  ambience: 'quarry', // its sound bed and accents (web/audio.js)
};
write(new URL('./sinkhole.json', import.meta.url), { name: 'Sinkhole', size: [200, 200], night: false, palette }, north);
