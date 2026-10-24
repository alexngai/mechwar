// Verdigris: a 180 m green-lit city on four levels (drains -7, streets 0, roofs 7, viaduct 14).
// Writes verdigris.json next to this file; rerun `node maps/verdigris.mjs` after editing.
//
// The north half (z > 0), the east district (straddling z = 0) and the center are authored here;
// `write` (maps/kit.mjs) adds the 180-degree twin. Metrics as Foundry's: alleys and gates 9-10 m,
// 6.5 m under every deck and street bridge, ramps near 23 degrees, 3 m hover ledges.
import { bases, box, flagStand, flags, growth, lamp, once, pad, point, railing, ramp, sentries, sign, silos, write } from './kit.mjs';

const GREEN = '#3dff8a', TEAL = '#3de0ff', MAGENTA = '#ff4fd8';

// --- Ground and perimeter ------------------------------------------------------------------------
box([-90, -1, 52], [90, 0, 90], 'ground'); // north of the drain
box([70, -1, 42], [90, 0, 52], 'ground'); // past the drain's east end
box([-90, -1, 42], [-70, 0, 52], 'ground'); // and its west end
once(() => box([-90, -1, -42], [90, 0, 42], 'ground')); // between the drains
box([90, 0, -91], [91, 36, 91], 'tower'); // east perimeter block
box([-91, 0, 90], [91, 36, 91], 'tower'); // north

// --- North storm drain (-7 m) ----------------------------------------------------------------------
// 10 m wide, under four street bridges; ramp mouths at its ends, in slots with walls on three sides.
box([-70, -8, 42], [70, -7, 52], 'ground');
box([-70, -7, 41], [70, -1, 42], 'concrete');
box([-70, -7, 52], [70, -1, 53], 'concrete');
box([70, -7, 42], [71, -1, 52], 'concrete');
box([-71, -7, 42], [-70, -1, 52], 'concrete');
ramp([54, -7, 47], [70, 0, 47], 10);
ramp([-54, -7, 47], [-70, 0, 47], 10);
for (const x of [-45, -17, 17, 45]) {
  box([x - 5, -0.5, 42], [x + 5, 0, 52], 'metal'); // grated street bridge
  // Railings each side, but not where the flag stand's deck joins them (below).
  for (const rx of [x - 5, x + 5]) if (rx !== -40 && rx !== -22) railing([rx, 0, 42], [rx, 0, 52]);
}
// The flag stand's deck over the drain, between the west gate's bridge and the next one west.
box([-40, -0.5, 42], [-22, 0, 52], 'metal');
lamp([0, -7, 51]);
lamp([35, -7, 43]);
point([-50, -7, 47], [-30, -7, 47], [0, -7, 47], [30, -7, 47], [50, -7, 47], [76, 0, 47], [-76, 0, 47]);
point([-45, 0, 47], [-17, 0, 47], [17, 0, 47], [45, 0, 47]); // bridges
point([-45, 0, 38], [-17, 0, 38], [17, 0, 38], [45, 0, 38], [-45, 0, 57], [-17, 0, 57], [17, 0, 57], [45, 0, 57]); // streets each side

// --- North base: a plaza behind a row of shops, with the transit ramp up to the viaduct ------------
box([-32, 0, 62], [-22, 7, 68], 'panel'); // shopfronts with two 10 m gates
box([-12, 0, 62], [12, 7, 68], 'panel');
box([22, 0, 62], [32, 7, 68], 'panel');
box([32, 0, 62], [40, 30, 90], 'tower'); // plaza sides
box([-40, 0, 62], [-32, 30, 90], 'tower');
ramp([0, 0, 84], [0, 7, 68], 9); // plaza -> shop roof
ramp([0, 7, 62], [0, 14, 46], 9); // shop roof -> spur, over the street and the drain
box([-4.5, 13.5, 36.5], [4.5, 14, 46], 'metal'); // spur onto the viaduct
box([-1, 0, 39], [1, 13.5, 41], 'concrete');
for (const x of [-4.5, 4.5]) railing([x, 14, 36.5], [x, 14, 46]);
railing([-12, 7, 62], [-4.5, 7, 62]);
railing([4.5, 7, 62], [12, 7, 62]);
sign([-12, 1.5, 61.8], [-4.5, 3.5, 62], [-8, 2.5, 60], GREEN);
sign([22, 1.5, 61.8], [32, 3, 62], [27, 2, 60], TEAL);
for (const at of [[-27, 0, 71], [27, 0, 71], [-17, 0, 58.5], [17, 0, 58.5]]) lamp(at);
point([-17, 0, 65], [17, 0, 65], [-17, 0, 78], [17, 0, 78], [0, 0, 87], [0, 7, 65], [0, 14, 41]);

// North-east and north-west yards between the base and the outer lanes.
box([40, 0, 72], [90, 32, 90], 'tower');
box([-90, 0, 72], [-40, 30, 90], 'tower');
box([56, 0, 64], [68, 3, 69], 'rust'); // cover crates against the towers, 3 m: hover-ups
box([-68, 0, 64], [-56, 3, 69], 'panel');
sign([60, 18, 71.8], [76, 21, 72], [68, 6, 66], GREEN);
lamp([80, 0, 56]);
point([55, 0, 61], [80, 0, 62], [-55, 0, 61], [-80, 0, 62]);

// --- Viaduct (14 m): a square ring round the market, on pillars -------------------------------------
box([-36.5, 13.5, 27.5], [36.5, 14, 36.5], 'metal'); // north side
box([27.5, 13.5, -27.5], [36.5, 14, 27.5], 'metal'); // east side
for (const x of [-32, 32]) box([x - 1, 0, 31], [x + 1, 13.5, 33], 'concrete');
box([31, 0, -1], [33, 13.5, 1], 'concrete');
railing([-36.5, 14, 36.5], [-4.5, 14, 36.5]);
railing([4.5, 14, 36.5], [36.5, 14, 36.5]);
railing([-27.5, 14, 27.5], [27.5, 14, 27.5]);
railing([36.5, 14, -36.5], [36.5, 14, -4.5]);
railing([36.5, 14, 4.5], [36.5, 14, 36.5]);
railing([27.5, 14, -27.5], [27.5, 14, 27.5]);
lamp([-20, 14, 35]);
point([0, 14, 32], [32, 14, 32], [-32, 14, 32], [32, 14, 0]);

// --- Market square (inside the ring) -------------------------------------------------------------
once(() => {
  box([-3, 0, -3], [3, 26, 3], 'tower'); // clock tower
  sign([-3.2, 18, -2], [-3, 22, 2], [-6, 16, 0], GREEN);
  sign([3, 18, -2], [3.2, 22, 2], [6, 16, 0], GREEN);
});
box([-22, 0, 6], [-16, 3, 10], 'panel'); // stalls: 3 m, cover and hover-ups
box([10, 0, 10], [16, 3, 14], 'rust');
box([-8, 0, 18], [-3, 3, 23], 'panel');
box([18, 0, 18], [23, 2, 21], 'concrete');
lamp([10, 0, 22]);
lamp([-20, 0, 14]);
point([14, 0, 0], [0, 0, 14], [20, 0, 14], [-16, 0, 16], [0, 0, 24]);

// --- East district (both sides of z = 0): towers, a roof landing and the stairs to the viaduct ------
box([74, 0, 14], [90, 30, 36], 'tower');
box([74, 0, -36], [90, 34, -14], 'tower');
box([46, 0, 24], [54, 24, 36], 'tower');
box([46, 0, -36], [54, 22, -24], 'tower');
box([52.5, 0, -8], [64, 7, 8], 'panel'); // landing roof, 7 m
ramp([60, 0, 26], [60, 7, 10], 8); // street -> landing
ramp([52.5, 7, 0], [36.5, 14, 0], 9); // landing -> viaduct
railing([64, 7, -8], [64, 7, 8]);
railing([52.5, 7, -8], [64, 7, -8]);
sign([73.8, 8, 20], [74, 12, 30], [71, 6, 25], GREEN);
sign([73.8, 10, -30], [74, 13, -20], [71, 6, -25], TEAL);
sign([45.8, 14, 26], [46, 17, 34], [43, 8, 30], MAGENTA);
lamp([66, 0, 12]);
lamp([66, 0, -20]);
box([78, 0, -6], [84, 3, 0], 'rust'); // crates in the pocket
point([44, 0, 14], [44, 0, -14], [68, 0, 0], [82, 0, 4], [68, 0, 30], [68, 0, -30], [60, 0, 30], [58, 7, 0], [62, 0, -16]);

// --- Growths: blocks built out from the towers -----------------------------------------------------
// Overhangs (high over every street, deck and the viaduct), and one perch on the east district's
// tower, 14 m up over its street, reached by a jump pad (its twin is on the west).
const D = Math.SQRT1_2;
growth([3, 21, 3], [D, D], 8); // the clock tower's crown, four ways with the twin
growth([-3, 21, 3], [-D, D], 8);
growth([32, 16, 84], [-1, 0], 7); // over the plaza, off both its towers
growth([-32, 16, 84], [1, 0], 7);
growth([75, 12, 72], [0, -1], 7); // over the north-east yard
growth([74, 14, 25], [-1, 0], 9, { shelf: 5, lit: true }); // the east perch
pad([69, 0, 7], [65, 14, 25], 17);

// --- Objectives ------------------------------------------------------------------------------------
// Missile Assault: B in the market inside the viaduct ring (the ring the high ground over it), A in
// the west district by its roof landing (C its twin in the east). The ring links all three at 14 m.
bases([-17, 0, 80]);
// Base guns: up on the shop roofs either side of the transit ramp, over the plaza.
sentries([[-5, 7, 64], [5, 7, 64]]);
// Capture the Flag: the stand on its deck over the drain, by the west gate, its back to the base
// guns and its doorways onto the next bridge west and the street beyond the drain.
flags(flagStand([-31, 0, 47], 90, { wall: 'panel' }));
silos({ at: [-65, 0, 8], radius: 10, band: 4, pad: [-67.5, 0, 8] }, { at: [0, 0, 0], radius: 16, band: 4, pad: [-6.5, 0, 0] });

// --- Spawns, twin, write ---------------------------------------------------------------------------
const north = [[-22, 0.1, 78], [-12, 0.1, 82], [12, 0.1, 82], [22, 0.1, 78]];
const palette = {
  sky: { horizon: '#1d3327', zenith: '#030907', sun: '#9fd0b4', stars: 0.25 },
  fog: [35, 165],
  haze: ['#3c7556', 0.07, 4],
  light: { sky: '#5a8574', ground: '#18221c', ambient: 1.7, sun: '#a8d8c0', direct: 0.9 },
  lamp: '#bfffd8',
  tint: '#9fb3a8',
  skyline: 'city',
  windows: ['#c8ffd8', '#7fffb0', '#ffe2a0', '#7fe8ff'],
};
write(new URL('./verdigris.json', import.meta.url), { name: 'Verdigris', size: [180, 180], night: true, palette }, north);
