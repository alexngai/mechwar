// Riftline: a 240 m lavender canyon. A chasm splits the map east-west between the two bases:
// rims at 0, cliff terraces at -8 and -16, the floor at -24, and a three-deck bridge across it
// (service gantry -8, road 0, rail +10) whose rail deck runs on to both bases as the high road.
// Writes riftline.json next to this file; rerun `node maps/riftline.mjs` after editing.
//
// The north wall and rim (z > 0) and pieces straddling z = 0 are authored here; `write`
// (maps/kit.mjs) adds the 180-degree twin. Metrics as the other maps': 9-10 m lanes and gates,
// 6.5 m+ under decks, ramps near 24 degrees, 3 m hover ledges. Hover lasts about 5 s and a dash is
// 8.5 m, so a 12 m gap takes a hover; there's no fall damage, so the chasm is a slow road, not a pit.
import { box, lamp, once, point, railing, ramp, sign, turned, write } from './kit.mjs';

const BASE = -25; // bottom of every rock mass
const MAGENTA = '#ff6be0', LILAC = '#c9a2ff';
// Switchback stairs up the north wall start at these x: floor -> -16 -> -8 -> rim.
const STAIRS = [-62, 34];

/** A level's rock: solid from BASE to `top`, with a ground slab on top for the floor texture. */
function rock([x0, z0], [x1, z1], top) {
  box([x0, BASE, z0], [x1, top - 1, z1], 'rock');
  box([x0, top - 1, z0], [x1, top, z1], 'ground');
}

/** A craggy boulder on a cliff face: a turned rock block embedded in the wall at (x, z). */
const boulder = (x, z, bottom, top, w, yaw) => turned([x, (bottom + top) / 2, z], [w / 2, (top - bottom) / 2, 1.6], yaw, 'rock');

// --- Canyon: rim, two terraces and the floor, with the switchback stairs -----------------------
rock([-120, 36], [120, 120], 0); // north rim plateau
rock([-120, 28], [120, 36], -8); // terrace -8
rock([-120, 20], [120, 28], -16); // terrace -16
once(() => box([-120, BASE, -20], [120, -24, 20], 'ground')); // chasm floor
for (const a of STAIRS) {
  ramp([a, -24, 16.5], [a + 18, -16, 16.5], 7, 'metal', true); // floor -> -16, then a landing
  rock([a + 18, 12], [a + 28, 20], -16);
  ramp([a + 18, -16, 24], [a, -8, 24], 7, 'metal', true); // -16 -> -8, then a landing
  box([a - 10, -16, 20], [a, -9, 28], 'rock');
  box([a - 10, -9, 20], [a, -8, 28], 'ground');
  ramp([a, -8, 32], [a + 18, 0, 32], 7, 'metal', true); // -8 -> rim, onto a landing
  box([a + 18, -8, 28], [a + 28, -1, 36], 'rock');
  box([a + 18, -1, 28], [a + 28, 0, 36], 'ground');
  lamp([a + 26, 0, 30]);
  lamp([a + 26, -16, 14]);
}
// Boulders break up the cliff faces, clear of the stairs, the bridge and the pipelines.
const clear = (x) => Math.abs(x) > 10 && Math.abs(Math.abs(x) - 75) > 6 && STAIRS.every((a) => x < a - 14 || x > a + 30);
for (let x = -112; x <= 112; x += 14) {
  const j = Math.sin(x * 12.9898) * 0.5; // a stable jitter per spot
  if (!clear(x)) continue;
  // Narrow and barely turned, so none juts more than about 2.5 m into an 8 m terrace.
  boulder(x + j * 4, 35.6, -8, -0.6, 5 + j * 2, j * 15); // rim face
  boulder(x + 7 - j * 3, 27.6, -16, -8.6, 5 - j * 2, -j * 15); // -8 face
  boulder(x - j * 5, 19.6, -24, -16.6, 5 + j * 2, j * 15); // -16 face
}

// --- The bridge: service gantry (-8), road deck (0), rail deck (+10) on a truss ----------------
once(() => {
  box([-6, -0.5, -36], [6, 0, 36], 'metal');
  box([-4, -8.5, -28], [4, -8, 28], 'metal');
  box([-4, 9.5, -90], [4, 10, 90], 'metal'); // runs on over both rims to the bases
  for (const x of [-4, 4]) railing([x, 10, -90], [x, 10, 90]);
  for (const x of [-4, 4]) railing([x, -8, -28], [x, -8, 28]);
  for (const x of [-6.4, 6.4]) box([x - 0.2, -8.5, -0.2], [x + 0.2, 10, 0.2], 'metal'); // truss posts at mid-span
  point([0, 0, 0], [0, 10, 0]);
});
for (const z of [12, 24, 36]) for (const x of [-6.4, 6.4]) box([x - 0.2, -8.5, z - 0.2], [x + 0.2, 10, z + 0.2], 'metal');
sign([-0.9, 4, 11.8], [0.9, 8, 12.2], [0, 2, 12], MAGENTA); // beacons hanging under the rail deck
railing([-6, 0, 0], [-6, 0, 36]);
railing([6, 0, 0], [6, 0, 36]);
lamp([5, 0, 34]);
// Road <-> rail: a ramp beside the bridgehead up to a landing on the rail deck.
ramp([9.5, 0, 66], [9.5, 10, 44], 7);
box([4, 9.5, 38], [13, 10, 44], 'metal');
railing([13, 10, 38], [13, 10, 44]);
railing([4, 10, 38], [13, 10, 38]);
for (const z of [52, 72]) box([-1, 0, z - 1], [1, 9.5, z + 1], 'concrete'); // rail deck pillars
point([0, 0, 20], [0, 0, 42], [0, -8, 14], [0, 10, 30], [0, 10, 60], [0, 10, 84], [8.5, 10, 41], [9.5, 0, 70]);

// --- Broken pipelines (east; the twin is west): a 12 m gap mid-span takes a hover --------------
// A 3.8 m duct, thin enough for a Bulwark to pass under on the -8 terrace (6.2 m).
for (const s of [1, -1]) {
  box([73.1, -1.8, s === 1 ? 6 : -36], [76.9, 0, s === 1 ? 36 : -6], 'metal');
  turned([75, -0.9, s * 6.6], [1.9, 0.9, 0.6], 25 * s, 'metal', 20); // its torn end
  point([75, 0, s * 26]);
}

// --- North rim: cover, a pump house, a pylon, and the base -------------------------------------
turned([-30, 1.5, 56], [5, 1.5, 3], 20, 'rock'); // outcrops: 3 m hover-ups and taller walls
turned([-35, 3.5, 60], [3, 3.5, 2.5], -15, 'rock');
turned([30, 1.5, 76], [4, 1.5, 3], -30, 'rock');
turned([88, 4, 58], [5, 4, 4], 10, 'rock');
turned([-80, 1.5, 48], [6, 1.5, 3], 5, 'rock');
box([44, 0, 50], [60, 7, 64], 'panel'); // pump house, roof by ramp
ramp([52, 0, 80], [52, 7, 64], 7);
railing([44, 7, 50], [60, 7, 50]);
sign([48, 3, 49.8], [56, 5, 50], [52, 3, 47], LILAC);
box([-96, 0, 58], [-94, 26, 60], 'metal'); // cable pylon
lamp([-95, 26, 59]);
box([-30.5, 0, 85.5], [-20, 9, 86.5], 'concrete'); // base front wall, gates at x +-15
box([-10, 0, 85.5], [10, 9, 86.5], 'concrete');
box([20, 0, 85.5], [30.5, 9, 86.5], 'concrete');
box([-30.5, 0, 86.5], [-29.5, 9, 120], 'concrete');
box([29.5, 0, 86.5], [30.5, 9, 120], 'concrete');
ramp([0, 0, 112], [0, 10, 90], 8); // down from the rail deck
box([10, 0, 106], [28, 7, 120], 'panel'); // relay station
sign([-10, 4, 85.3], [-5, 6.5, 85.5], [-7.5, 3, 83], MAGENTA);
for (const at of [[-25, 0, 84], [25, 0, 84], [-24, 0, 116], [20, 7, 108]]) lamp(at);
box([120, BASE, -121], [121, 18, 121], 'concrete'); // perimeter, down to the chasm floor
box([-121, 0, 120], [121, 18, 121], 'concrete');

// --- Waypoints ---------------------------------------------------------------------------------
point([10, -24, 0], [40, -24, 0], [70, -24, 0], [100, -24, 0]); // floor (twins cover x < 0)
for (const a of STAIRS) {
  point([a - 4, -24, 16], [a + 23, -16, 18], [a - 5, -8, 24], [a + 23, 0, 32]); // up the switchbacks
  point([a + 22, -16, 24], [a - 4, -8, 32]); // each ramp's foot
}
point([-110, -16, 24], [-90, -16, 24], [-28, -16, 24], [-5, -16, 24], [15, -16, 24], [70, -16, 24], [95, -16, 24], [112, -16, 24]);
point([-110, -8, 32], [-85, -8, 32], [-20, -8, 32], [0, -8, 32], [18, -8, 32], [72, -8, 32], [95, -8, 32], [112, -8, 32]);
point([-105, 0, 45], [-75, 0, 42], [-50, 0, 45], [-15, 0, 44], [20, 0, 44], [35, 0, 45], [75, 0, 44], [105, 0, 45]);
point([-105, 0, 72], [-70, 0, 70], [-45, 0, 74], [-15, 0, 64], [20, 0, 62], [70, 0, 72], [105, 0, 74]);
point([52, 0, 84], [52, 7, 57], [-15, 0, 80], [15, 0, 80], [-15, 0, 96], [15, 0, 96], [0, 0, 116], [-20, 0, 112]);

// --- Spawns, twin, write -------------------------------------------------------------------------
const north = [[-20, 0.1, 102], [-12, 0.1, 108], [12, 0.1, 100], [20, 0.1, 96]];
const palette = {
  sky: { horizon: '#a58fc4', zenith: '#1e1640', sun: '#ffd0ec', stars: 0.15 },
  fog: [60, 240],
  haze: ['#8064c0', 0.05, 6],
  light: { sky: '#b6a6e6', ground: '#3a2c4a', ambient: 1.7, sun: '#ffc6e6', direct: 1.5 },
  lamp: '#f0b8ff',
  tint: '#c3bad8',
};
write(new URL('./riftline.json', import.meta.url), { name: 'Riftline', size: [240, 240], night: true, palette }, north);
