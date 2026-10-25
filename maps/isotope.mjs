// Isotope: a 120 m radioactive waste treatment plant on the night shift. Spent fuel glows green
// in the storage pools under each yard's gantry crane, in the cooling pond among the tanks, in the
// gutters along the west walls and in the reactor core under the pump house; sodium lamps light
// the rest, and cooling towers loom over the walls through a jaundiced smog.
// Writes isotope.json next to this file; rerun `node maps/isotope.mjs` after editing.
//
// Only the north half (z > 0), plus pieces straddling z = 0 on the east side, is authored here;
// `write` (maps/kit.mjs) adds the 180-degree copy of everything. The layout is the old Saltworks
// salt flat's, so its routes and nav hold: the pump house (deck 7) mid-map, a catwalk (7) down each
// west side, tank farms east, low walls before each spawn. The glow is all props: nothing on the
// floor trips anyone.
import { box, cylinder, decor, lamp, once, pipe, point, railing, sentries, sign, turned, write } from './kit.mjs';

const GLOW = '#5dff4a'; // spent fuel and sludge
const BEACON = '#ff3020';
const slab = (from, to, mat) => decor.push({ kind: 'slab', from, to, mat });

// --- Floor and edges -------------------------------------------------------------------------
once(() => box([-60, -1, -60], [60, 0, 60], 'ground'));
box([60, 0, -61], [61, 10, 61], 'concrete'); // east perimeter
box([-61, 0, 60], [61, 10, 61], 'concrete'); // north perimeter

// --- Pump house: deck 7 over the reactor core, a ramp up from the east -------------------------
once(() => {
  box([-9.5, 6.5, -9.5], [9.5, 7, 9.5], 'metal');
  box([-2.5, 0, -2.5], [2.5, 3, 2.5], 'metal');
  point([0, 7, 0]);
});
box([-9, 0, 8], [-3.5, 6.5, 9], 'panel');
box([3.5, 0, 8], [9, 6.5, 9], 'panel');
box([8, 0, 3.5], [9, 6.5, 9], 'panel');
box([-9, 0, 3.5], [-8, 6.5, 9], 'panel');
turned([17.147, 3.272, 6], [2, 0.25, 8.504], 90, 'metal', 24.305);
turned([13.272, 1.75, 6], [2, 1.75, 3.875], 90, 'concrete');
railing([-9.4, 7, 9.4], [9.4, 7, 9.4]);
railing([9.4, 7, -9.4], [9.4, 7, 3.8]);
lamp([7.5, 7, 7.5]);
// The core glows through its casing, lighting the hall under the deck.
sign([-1.8, 0.4, 2.5], [1.8, 2.6, 2.56], [0, 1.5, 4], GLOW);
sign([2.5, 0.4, -1.8], [2.56, 2.6, 1.8], [4, 1.5, 0], GLOW);
point([0, 0, 5], [0, 0, 13], [13, 0, 0], [8, 7, 6], [27, 0, 6]);

// --- Spawn yard: low walls with two gaps, base guns, sodium lamps -----------------------------
box([-42, 0, 43.5], [-22, 3, 44.5], 'concrete');
box([-10, 0, 43.5], [10, 3, 44.5], 'concrete');
box([22, 0, 43.5], [42, 3, 44.5], 'concrete');
lamp([-11, 0, 45.5]);
lamp([11, 0, 45.5]);
// Drums of waste stacked in the corners.
for (const [x, z] of [[52, 57.5], [53.2, 57.5], [54.4, 57.5], [52.6, 58.7], [53.8, 58.7], [-55.5, 57.5], [-54.3, 58.7], [-55.5, 58.7]]) {
  cylinder([x, 0, z], [x, 1.2, z], 0.5, 'hazard');
}
cylinder([53.2, 1.2, 58.1], [53.2, 2.4, 58.1], 0.5, 'hazard');
point([0, 0, 52], [-20, 0, 52], [20, 0, 52], [-16, 0, 39], [16, 0, 39]);

// --- West catwalk (7), with a ramp down to the spawn yard -------------------------------------
box([-50, 6.5, 8], [-44, 7, 36], 'metal');
turned([-47, 3.276, 42.888], [3, 0.25, 7.826], 0, 'metal', 26.565);
box([-50, 0, 35.888], [-44, 3.5, 42.888], 'concrete');
for (const z of [12, 22, 32]) {
  box([-49.9, 0, z - 0.3], [-49.3, 6.5, z + 0.3], 'metal');
  box([-44.7, 0, z - 0.3], [-44.1, 6.5, z + 0.3], 'metal');
}
railing([-49.9, 7, 8.1], [-49.9, 7, 35.6]);
railing([-44.1, 7, 8.1], [-44.1, 7, 35.6]);
railing([-49.9, 7, 8.1], [-44.1, 7, 8.1]);
lamp([-49.5, 7, 18]);
lamp([-44.5, 7, 28]);
// Sludge running in a gutter under the pipes along the west wall.
pipe([-58.5, 1.2, 46], [-58.5, 1.2, 4], 0.6);
pipe([-58.5, 2.8, 46], [-58.5, 2.8, 4], 0.45);
for (let z = 4; z < 46; z += 10.5) sign([-59.9, 0, z], [-58.9, 0.05, z + 10.5], [-57, 1, z + 5.25], GLOW);
point([-55, 0, 40], [-47, 0, 53], [-47, 7, 33], [-47, 7, 21], [-47, 7, 10], [-47, 0, 22], [-55, 0, 22], [-55, 0, 6]);

// --- West yard: waste containers, the hot cell, the storage pool ------------------------------
turned([-30, 1.2, 26], [3, 1.2, 2.5], 30, 'hazard');
turned([-22, 1, 14], [2.5, 1, 2.5], -20, 'hazard');
box([-37, 0, 8], [-33, 3, 16], 'hazard');
turned([-16, 1.5, 4], [2, 1.5, 2], 15, 'hazard');
// The hot cell: a shielded bunker, its window onto the pool glowing.
box([-30, 0, 31], [-22, 6, 37], 'concrete');
sign([-22, 2.6, 32.5], [-21.94, 4.2, 35.5], [-20.5, 3.4, 34], GLOW);
// The storage pool, spent fuel glowing in its racks under the crane.
slab([-22.6, 0, 32.4], [-9.4, 0.02, 42.6], 'soot');
sign([-22, 0.02, 33], [-10, 0.05, 42], [-16, 1.5, 37.5], GLOW);
for (let x = -20; x < -10; x += 2) slab([x - 0.15, 0.05, 33], [x + 0.15, 0.07, 42], 'trim');
for (let z = 35; z < 42; z += 2.25) slab([-22, 0.05, z - 0.15], [-10, 0.07, z + 0.15], 'trim');
point([-30, 0, 18], [-18, 0, 28], [-24, 0, 6], [-40, 0, 26]);

// --- Gantry crane over the yard, riding the perimeter walls ------------------------------------
// The girders run 16.5-18.5 m up, clear of a mech hovering at the catwalk's end; its cask hangs
// over the pool, 9.5 m up, clear of one hovering under it.
for (const x of [-60.5, 60.5]) {
  for (const z of [35, 41]) box([x - 0.5, 10, z - 0.5], [x + 0.5, 16.5, z + 0.5], 'hazard');
  box([x - 1, 16.5, 34], [x + 1, 18, 42], 'hazard');
}
for (const z of [37.1, 38.9]) box([-61, 16.5, z - 0.5], [61, 18.5, z + 0.5], 'hazard');
box([-19, 18.5, 35.5], [-13, 20, 40.5], 'hazard'); // trolley
cylinder([-16, 9.5, 38], [-16, 13.5, 38], 1.6, 'metal'); // cask
cylinder([-16, 13.5, 38], [-16, 14.1, 38], 0.8, 'trim');
for (const dx of [-0.5, 0.5]) pipe([-16 + dx, 14.1, 38], [-16 + dx, 18.5, 38], 0.06);
sign([-16.3, 20, 37.7], [-15.7, 20.3, 38.3], [-16, 21, 38], BEACON);

// --- Melter: the vitrification vessel mid-field, green through its ports -----------------------
cylinder([-4, 0, 28], [-4, 1, 28], 4.8, 'concrete');
cylinder([-4, 1, 28], [-4, 9, 28], 4.2, 'metal');
for (const y of [3, 7]) cylinder([-4, y - 0.15, 28], [-4, y + 0.15, 28], 4.35, 'trim');
cylinder([-4, 9, 28], [-4, 10, 28], 3.4, 'metal');
cylinder([-4, 10, 28], [-4, 10.8, 28], 2.2, 'metal');
cylinder([-4, 10.8, 28], [-4, 15, 28], 0.6, 'pipe');
sign([0.15, 4.2, 27.2], [0.35, 5.6, 28.8], [1.6, 4.9, 28], GLOW);
sign([-4.8, 4.2, 32.15], [-3.2, 5.6, 32.35], [-4, 4.9, 33.6], GLOW);
sign([-8.35, 4.2, 27.2], [-8.15, 5.6, 28.8], [-9.6, 4.9, 28], GLOW);
sign([-4.8, 4.2, 23.65], [-3.2, 5.6, 23.85], [-4, 4.9, 22.4], GLOW);
pipe([-4, 7.5, 23.8], [-4, 7.5, 9.5], 0.5); // to the pump house
point([14, 0, 30]);

// --- East: tank farm round the cooling pond, the platform, the stack --------------------------
box([20.5, 0, 16.5], [27.5, 9, 23.5], 'tank');
box([32.5, 0, 16.5], [39.5, 9, 23.5], 'tank');
box([20.5, 0, 28.5], [27.5, 9, 35.5], 'tank');
box([44.5, 0, 26.5], [51.5, 9, 33.5], 'tank');
pipe([27.5, 7, 20], [32.5, 7, 20], 0.5);
pipe([24, 7.5, 23.5], [24, 7.5, 28.5], 0.5);
slab([27.6, 0, 23.6], [39, 0.02, 35], 'soot');
sign([28.2, 0.02, 24.2], [38.4, 0.05, 34.4], [33.3, 1.5, 29.3], GLOW);
box([42, 0, 9], [56, 3, 19], 'concrete');
turned([37.22, 1.26, 12], [2.5, 0.25, 5.364], -90, 'concrete', 16.239);
railing([55.9, 3, 9.1], [55.9, 3, 18.9]);
railing([42.1, 3, 18.9], [55.9, 3, 18.9]);
lamp([54, 3, 17]);
turned([14, 1.2, 14], [2.5, 1.2, 2.5], 20, 'hazard');
point([52, 0, 40], [30, 0, 26], [41, 0, 30], [30, 0, 12], [48, 3, 14], [40, 0, 4]);
// The west stack (its twin stands east), crowned with machinery and a beacon.
box([-34, 0, -1], [-28, 20, 5], 'concrete');
turned([32.427, 16.72, 3.025], [2.514, 1.72, 2.525], -178.421, 'concrete');
turned([30.177, 19.724, 3.764], [2.613, 1.284, 3.264], -181.056, 'concrete');
turned([30.177, 22.295, 4.014], [1.073, 1.287, 1.073], -152.764, 'tank');
turned([-36.392, 16.068, 3.275], [1.549, 1.068, 2.892], 92.248, 'concrete');
turned([-36.906, 18.692, 1.047], [2.829, 1.555, 3.406], 93.668, 'concrete');
turned([-37.156, 21.423, 1.047], [0.98, 1.176, 0.98], 94.368, 'tank');
sign([-37.4, 22.6, 0.8], [-36.9, 22.9, 1.3], [-37.2, 23.6, 1], BEACON);
pipe([-30, 9, 0.5], [30, 9, 0.5], 0.4);

// --- Cooling towers past the north-west wall: purely a skyline, out of reach ------------------
// Stacked rings on a hyperboloid's curve: 16 m round at the foot, pinched to 10 at 40 m, 11 at the lip.
for (let y = 0; y < 56; y += 2.5) {
  const r = 10 * Math.sqrt(1 + ((y + 1.25 - 40) / 32) ** 2);
  cylinder([-92, y, 48], [-92, y + 2.5, 48], Math.round(r * 100) / 100, 'concrete');
}
decor.push({ kind: 'steam', at: [-92, 56, 48] });

sentries([[-6, 0, 47], [6, 0, 47]]);

write(
  new URL('./isotope.json', import.meta.url),
  {
    name: 'Isotope',
    size: [120, 120],
    night: true,
    palette: {
      sky: { horizon: '#4f5733', zenith: '#070a08', sun: '#d3e4a8', stars: 0.12 },
      fog: [60, 280],
      haze: ['#6f7d3e', 0.012, 5],
      light: { sky: '#8e9f78', ground: '#2c3022', ambient: 1.4, sun: '#c9d9a2', direct: 1.2 },
      tint: '#d8dfc4',
      lamp: '#ffb560',
      motes: { color: [[0.62, 1, 0.45], [0.25, 0.8, 0.3]], rate: 50, size: 0.15, drift: 0.3, rise: 0.5, life: 6, range: 40 },
      ambience: 'reactor',
    },
  },
  [[-5, 0.1, 53], [5, 0.1, 53], [-16, 0.1, 53], [16, 0.1, 53]],
);
