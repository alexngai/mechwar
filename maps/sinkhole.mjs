// Sinkhole: a 200 m red-rock pit under a dusty day sky. An eight-sided hole steps down in rings
// (rim 0, terraces -7, -14 and -21, floor -28) joined by a double spiral of ramps, and three bridges
// cross it through the center at -7, 0 and +8, each turned 60 degrees from the last.
// Writes sinkhole.json next to this file; rerun `node maps/sinkhole.mjs` after editing.
//
// The north half (z > 0) and the sides facing 0-135 degrees are authored here; `write`
// (maps/kit.mjs) adds the 180-degree twin. Metrics as Riftline's: 8 m terraces, 6.5 m+ under
// every deck, ramps near 24 degrees. A side "facing" d degrees has its outward normal d degrees
// clockwise from north; on it, p runs outward from the center and s runs clockwise along it.
import { box, coral, lamp, once, pad, point, r3, railing, ramp, sign, turned, write } from './kit.mjs';

const BASE = -29; // bottom of every rock mass
const CYAN = '#3de0ff';
const T = Math.tan(Math.PI / 8); // half a side over the apothem
// The floor and the three terraces: inner and outer apothem, and height. The rim starts at 50.
const BANDS = [[0, 26, -28], [26, 34, -21], [34, 42, -14], [42, 50, -7]];
const RIM = 50, H = [-28, -21, -14, -7, 0];
const SIDES = [0, 45, 90, 135]; // the twin adds 180-315

/** World [x, z] of (p, s) on the side facing `deg`. */
const at = (deg, p, s) => {
  const r = (deg * Math.PI) / 180;
  return [r3(p * Math.sin(r) + s * Math.cos(r)), r3(p * Math.cos(r) - s * Math.sin(r))];
};
/** World [x, z] `d` meters out from the center toward `deg`. */
const along = (deg, d) => at(deg, d, 0);

/**
 * Rock from BASE to `top` on the side facing `deg`, from apothem p0 to p1 and `half` along it,
 * with a ground slab on top. Diagonal sides sit 2 cm low, so where they overlap a square side
 * the tops never z-fight.
 */
function slab(deg, p0, p1, half, top, mat = 'rock') {
  const h = top - (deg % 90 ? 0.02 : 0), [x, z] = at(deg, (p0 + p1) / 2, 0), depth = r3((p1 - p0) / 2);
  turned([x, r3((BASE + h - 1) / 2), z], [r3(half), r3((h - 1 - BASE) / 2), depth], deg, mat);
  turned([x, r3(h - 0.5), z], [r3(half), 0.5, depth], deg, 'ground');
}

/** A craggy boulder on the face of the ring whose inner apothem is `p`, from `bottom` to `top`. */
function boulder(deg, p, s, bottom, top, w, yaw) {
  const [x, z] = at(deg, p - 0.4, s);
  turned([x, r3((bottom + top) / 2), z], [r3(w / 2), r3((top - bottom) / 2), 1.6], r3(deg + yaw), 'rock');
}

// --- The pit: floor, terrace rings and the rim -----------------------------------------------------
once(() => box([-30, BASE, -30], [30, -28, 30], 'ground'));
for (const [p0, p1, top] of BANDS.slice(1)) for (const deg of SIDES) slab(deg, p0, p1, p1 * T, top);
// The rim: square blocks out to the walls, and diagonal blocks filling the square's corners.
box([-RIM, BASE, RIM], [RIM, -1, 100], 'rock');
box([-RIM, -1, RIM], [RIM, 0, 100], 'ground');
box([RIM, BASE, -RIM], [100, -1, RIM], 'rock');
box([RIM, -1, -RIM], [100, 0, RIM], 'ground');
for (const x0 of [RIM, -100]) {
  box([x0, BASE, RIM], [x0 + 100 - RIM, -1, 100], 'rock');
  box([x0, -1, RIM], [x0 + 100 - RIM, 0, 100], 'ground');
}
for (const deg of [45, 135]) slab(deg, RIM, RIM * Math.SQRT2, RIM * T, 0);

// The double spiral: on each side in turn, a ramp up the next ring's wall to a landing at its
// top, so climbing walks you round the pit. Its twin climbs the other way round.
for (let k = 0; k < 4; k++) {
  const deg = SIDES[k], wall = BANDS[k][1], p = wall - 3.5;
  const [lx, lz] = at(deg, p, -8), [hx, hz] = at(deg, p, 8);
  ramp([lx, H[k], lz], [hx, H[k + 1], hz], 7, 'metal', true);
  // The landing runs half a meter into the ring, 1 cm under its top (no z-fighting).
  const top = H[k + 1] - 0.01, [x, z] = at(deg, wall - 3.25, 10);
  turned([x, r3((H[k] + top - 1) / 2), z], [2, r3((top - 1 - H[k]) / 2), 3.75], deg, 'rock');
  turned([x, r3(top - 0.5), z], [2, 0.5, 3.75], deg, 'ground');
}
// Boulders break up each ring's face, except where a ramp climbs it.
for (let k = 0; k < 4; k++) {
  const p = BANDS[k][1], bottom = H[k], top = H[k + 1] - 0.6;
  for (const deg of SIDES) {
    if (deg === SIDES[k]) continue;
    const j = Math.sin((deg + 7) * (k + 3)) * 0.5; // a stable jitter per spot
    boulder(deg, p, -6 + j * 3, bottom, top, 5 + j * 2, j * 15);
  }
}

// --- Bridges: the gantry (-7, N-S), the road (0, 60 degrees) and the high bridge (+8, 120) ------------
const ROAD = 60, HIGH = 120;
once(() => {
  box([-4, -7.48, -44], [4, -6.98, 44], 'metal'); // into the -7 terrace, 2 cm proud of it
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
// Down from the high bridge to the rim at each end.
const [hx0, hz0] = along(HIGH + 180, 64), [hx1, hz1] = along(HIGH + 180, 83);
ramp([hx1, 0, hz1], [hx0, 8, hz0], 8);
// Truss posts down to the floor, at the deck edges (never in a walkway), with cyan beacons.
for (const [deg, half, under] of [[0, 4.4, -7.5], [ROAD, 5.4, -0.5], [HIGH + 180, 4.4, 7.5]]) {
  for (const s of [-half, half]) {
    const [x, z] = at(deg, 16, s);
    box([r3(x - 0.2), -28, r3(z - 0.2)], [r3(x + 0.2), under, r3(z + 0.2)], 'metal');
  }
  const [x, z] = at(deg, 16, half);
  sign([r3(x - 0.25), -14, r3(z - 0.25)], [r3(x + 0.25), -9, r3(z + 0.25)], [x, -11, z], CYAN);
}

// --- Rim: outcrops, a pump house, a pylon, and the north base -----------------------------------
turned([-40, 1.5, 64], [5, 1.5, 3], 20, 'rock'); // 3 m hover-ups and taller walls
turned([-48, 3.5, 70], [3, 3.5, 2.5], -15, 'rock');
turned([80, 1.5, 40], [4, 1.5, 3], -30, 'rock');
turned([-88, 4, 20], [5, 4, 4], 10, 'rock');
box([58, 0, 56], [72, 7, 68], 'panel'); // pump house, roof by ramp
ramp([65, 0, 84], [65, 7, 68], 7);
railing([58, 7, 56], [72, 7, 56]);
box([-80, 0, 70], [-78, 24, 72], 'metal'); // cable pylon, coral grown out both ways
lamp([-79, 24, 71]);
coral([-78, 18, 71], [1, 0], 5, { size: 0.8 });
coral([-80, 18, 71], [-1, 0], 5, { size: 0.8 });
// Table coral grown off the north rim over the pit, level with it: a lookout over the
// bridges (7 m clear over the -7 terrace below). Its twin hangs off the south rim.
coral([-18, 0, RIM], [0, -1], 8, { shelf: 5, lit: true });
point([-18, 0, 43]);
box([-30.5, 0, 72], [-20, 9, 73], 'concrete'); // base front wall, gates at x +-15
box([-10, 0, 72], [10, 9, 73], 'concrete');
box([20, 0, 72], [30.5, 9, 73], 'concrete');
box([-30.5, 0, 73], [-29.5, 9, 100], 'concrete');
box([29.5, 0, 73], [30.5, 9, 100], 'concrete');
box([10, 0, 88], [26, 6, 100], 'panel'); // relay station
sign([-10, 4, 71.8], [-5, 6.5, 72], [-7.5, 3, 70], CYAN);
for (const [deg, p, s, y] of [[0, 52, -14, 0], [90, 52, 10, 0], [45, 47, -14, -7], [0, 39, 12, -14], [90, 31, 0, -21]]) {
  const [x, z] = at(deg, p, s);
  lamp([x, y, z]);
}
for (const at_ of [[-25, 0, 70], [25, 0, 70], [-24, 0, 96]]) lamp(at_);
box([100, -1, -101], [101, 20, 101], 'rock'); // perimeter cliffs
box([-101, -1, 100], [101, 20, 101], 'rock');

// --- Jump pads: the pit floor out to the east rim, and the -21 terrace up onto the gantry -------
pad([21, -28, 0], [58, 0, 0], 3);
pad([-11, -21, 28], [0, -7, 28], -2);

// --- Waypoints -----------------------------------------------------------------------------------
// The floor, then each terrace: a point at every side's middle and corner, except where a ramp
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
point([65, 0, 88], [62, 7, 62], [68, 7, 62]); // pump house
point([-15, 0, 68], [15, 0, 68], [-15, 0, 80], [15, 0, 78], [0, 0, 94], [-60, 0, 60], [-70, 0, 80], [-85, 0, 85], [45, 0, 80], [85, 0, 85], [86, 0, 60], [90, 0, 30], [85, 0, 15]);

// --- Spawns, twin, write -------------------------------------------------------------------------
const north = [[-20, 0.1, 84], [-12, 0.1, 92], [12, 0.1, 80], [20, 0.1, 82]];
const palette = {
  sky: { horizon: '#e8a888', zenith: '#6f7fae', sun: '#fff0e0', stars: 0 },
  fog: [80, 260],
  haze: ['#e0b090', 0.018, 6],
  light: { sky: '#f0d0c0', ground: '#5a3020', ambient: 1.5, sun: '#fff0e0', direct: 2.2 },
  lamp: '#ffd8b0',
  tint: '#e0a890',
};
write(new URL('./sinkhole.json', import.meta.url), { name: 'Sinkhole', size: [200, 200], night: false, palette }, north);
