// Foundry: a 240 m industrial yard on four levels (channel -5, ground 0, decks 7, gantries 14).
// Writes foundry.json next to this file; rerun `node maps/foundry.mjs` after editing.
//
// Only the north half (z > 0), plus pieces straddling z = 0 on the east side, is authored here;
// `write` (maps/kit.mjs) adds the 180-degree copy of everything. Metrics: the Bulwark is 5.8 m
// tall and 3.6 m wide, so lanes and doors are 9+ m wide and clearances 6+ m; ramps stay near 23
// degrees (walkable is 40); hover tops out at 3.5 m, so 3 m ledges are hover shortcuts and the 7 m
// and 14 m tiers need ramps.
import { box, furnace, lamp, once, pipe, point, railing, ramp, stack, turned, write } from './kit.mjs';

// --- Floor and edges -------------------------------------------------------------------------
box([-120, -1, 7], [120, 0, 120], 'ground'); // north floor
box([92, -1, -7], [120, 0, 7], 'ground'); // east land bridge past the channel
box([120, 0, -121], [121, 18, 121], 'concrete'); // east perimeter
box([-121, 0, 120], [121, 18, 121], 'concrete'); // north perimeter

// --- Cooling channel (east half, -5 m) ------------------------------------------------------
// Entered by a 9 m ramp at each end; the platform between the halves carries the smelter.
box([24, -6, -7], [92, -5, 7], 'ground');
box([24, -5, 7], [92, -1, 8], 'concrete');
box([24, -5, -8], [92, -1, -7], 'concrete');
box([23, -5, -7], [24, -1, 7], 'concrete');
box([92, -5, -7], [93, -1, 7], 'concrete');
ramp([38, -5, 0], [24, 0, 0], 9);
box([24, -5, 4.5], [38, 0, 7], 'concrete');
box([24, -5, -7], [38, 0, -4.5], 'concrete');
ramp([78, -5, 0], [92, 0, 0], 9);
box([78, -5, 4.5], [92, 0, 7], 'concrete');
box([78, -5, -7], [92, 0, -4.5], 'concrete');
pipe([24, -3.6, 6.4], [78, -3.6, 6.4], 0.5);
lamp([44, -5, -6.2]);
point([42, -5, 0], [60, -5, 0], [74, -5, 0], [96, 0, 0], [108, 0, 0]);

// --- Smelter: core (roof 14), ring deck (7) over an arcade, hover steps up to the roof ---------
once(() => {
  box([-24, -1, -7], [24, 0, 7], 'ground');
  box([-9, 0, -9], [9, 14, 9], 'soot');
  point([0, 14, 0]);
});
box([-18, 6.5, 9], [18, 7, 18], 'metal'); // north ring
box([9, 6.5, -9], [18, 7, 9], 'metal'); // east ring
// Arcade walls under the ring's outer edge, with a 9 m doorway in each side.
box([-18, 0, 17], [-4.5, 6.5, 18], 'panel');
box([4.5, 0, 17], [18, 6.5, 18], 'panel');
box([17, 0, -17], [18, 6.5, -4.5], 'panel');
box([17, 0, 4.5], [18, 6.5, 17], 'panel');
box([3, 7, 9], [8, 10, 12.5], 'rust'); // ring 7 -> 10
box([-1, 7, 9], [3, 12, 12.5], 'rust'); // 10 -> 12, then 14 on the roof
furnace([-3, 0.4, 9], [3, 4, 9.25], [0, 2.5, 10.5]); // furnace mouths lighting the arcade
furnace([9, 0.4, -3], [9.25, 4, 3], [10.5, 2.5, 0]);
ramp([11, 0, 34], [11, 7, 18], 7);
railing([-18, 7, 18], [7.5, 7, 18]);
railing([14.5, 7, 18], [18, 7, 18]);
railing([18, 7, -18], [18, 7, 18]);
lamp([16.5, 7, 16.5]);
point([-13.5, 7, 13.5], [0, 7, 15.5], [12, 7, 15], [13.5, 7, 0]); // ring
point([-13, 0, 13], [0, 0, 13], [13, 0, 13], [13, 0, 0]); // arcade
point([0, 0, 24], [20, 0, 0], [11, 0, 38]); // north and east doorways, ring ramp foot

// --- Skybridge (14) from the base gantry to the smelter roof ----------------------------------
box([-8.5, 13.5, 9], [-1.5, 14, 80], 'metal');
for (const z of [30, 48, 66]) box([-6, 0, z - 1], [-4, 13.5, z + 1], 'concrete');
railing([-8.5, 14, 9], [-8.5, 14, 80]);
railing([-1.5, 14, 9], [-1.5, 14, 80]);
lamp([-2, 14, 44]);
point([-5, 14, 4], [-5, 14, 18], [-5, 14, 40], [-5, 14, 62]);

// --- North base: walled yard, hangar (roof 7), gantry (14) -----------------------------------
box([-30.5, 0, 77.5], [-24.5, 9, 78.5], 'concrete'); // front wall with two 9 m gates
box([-15.5, 0, 77.5], [15.5, 9, 78.5], 'concrete');
box([24.5, 0, 77.5], [30.5, 9, 78.5], 'concrete');
box([-30.5, 0, 78.5], [-29.5, 9, 120], 'concrete');
box([29.5, 0, 78.5], [30.5, 9, 120], 'concrete');
box([-26, 0, 64], [-14, 3, 66], 'concrete'); // blast barriers screening the gates
box([14, 0, 64], [26, 3, 66], 'concrete');
box([6, 0, 104], [28, 7, 120], 'panel'); // hangar
ramp([-10, 0, 112], [6, 7, 112], 8);
box([-11, 13.5, 80], [13, 14, 88], 'metal'); // gantry deck
for (const [x, z] of [[-10, 81], [-10, 87], [12, 81], [12, 87]]) box([x - 0.75, 0, z - 0.75], [x + 0.75, 13.5, z + 0.75], 'concrete');
ramp([9.5, 7, 104], [9.5, 14, 88], 7);
railing([-11, 14, 80], [-8.5, 14, 80]);
railing([-1.5, 14, 80], [13, 14, 80]);
railing([-11, 14, 88], [6, 14, 88]);
railing([-11, 14, 80], [-11, 14, 88]);
railing([13, 14, 80], [13, 14, 88]);
railing([13, 7, 104], [28, 7, 104]);
railing([28, 7, 104], [28, 7, 120]);
railing([6, 7, 104], [6, 7, 108]);
railing([6, 7, 116], [6, 7, 120]);
pipe([-29, 2, 80], [-29, 2, 118], 0.5);
pipe([29, 5, 80], [29, 5, 102], 0.7);
for (const at of [[-27.5, 0, 81], [27.5, 0, 81], [-27.5, 0, 117], [12, 14, 81], [26.5, 7, 117]]) lamp(at);
point([-14, 0, 112], [-14, 0, 96], [0, 0, 96], [24, 0, 98], [-20, 0, 86], [20, 0, 86], [-20, 0, 72], [20, 0, 72]); // yard and gates
point([9.5, 7, 110], [22, 7, 112], [9.5, 14, 84], [-5, 14, 84]); // hangar roof and gantry

// --- Courtyard (north half) ------------------------------------------------------------------
stack(45, 40);
stack(-45, 40);
box([18, 0, 24], [22, 3, 28], 'panel');
box([22, 0, 27], [25, 2, 30], 'panel');
turned([-22, 1.5, 28], [5, 1.5, 1], 30, 'concrete');
turned([-30, 0.6, 50], [5, 1.2, 4], 20, 'rust', 8); // slag heap
box([28, 0, 54], [33, 6, 60], 'concrete');
box([6, 0, 50], [18, 2.5, 51.5], 'concrete');
box([-17, 0, 60], [-14, 8, 63], 'concrete');
box([30, 0, 12], [42, 3, 17], 'rust');
box([-42, 0, 14], [-37, 3, 26], 'panel');
box([38, 0, 31], [41, 3, 35], 'rust');
lamp([-9, 0, 30]);
lamp([40, 0, 47]);
lamp([-20, 0, 62]);
point([-24, 0, 18], [28, 0, 22], [-32, 0, 38], [30, 0, 44], [0, 0, 44], [-22, 0, 56], [20, 0, 62], [-45, 0, 62], [45, 0, 62], [-40, 0, 76], [40, 0, 76]);

// --- East lane: pipe-rack catwalk (7) over container yards -----------------------------------
// The whole rack is authored (it straddles z = 0); the twin is the west lane's.
box([68.5, 6.5, -54], [75.5, 7, 54], 'metal');
ramp([72, 0, 70], [72, 7, 54], 7);
ramp([72, 0, -70], [72, 7, -54], 7);
for (const z of [-42, -28, -14, 14, 28, 42]) for (const x of [69, 75]) box([x - 0.5, 0, z - 0.5], [x + 0.5, 6.5, z + 0.5], 'metal');
pipe([70, 5.4, -54], [70, 5.4, 54], 0.6);
pipe([73.6, 5.6, -54], [73.6, 5.6, 54], 0.45);
railing([68.5, 7, -54], [68.5, 7, 54]);
railing([75.5, 7, -54], [75.5, 7, 54]);
lamp([75, 7, 20]);
point([72, 0, 74], [72, 7, 50], [72, 7, 26], [72, 7, 2], [72, 7, -22], [72, 7, -50], [72, 0, -74]);
// North-east yard: a row of double-stacked containers with one 9 m gap; the row's top (6) is a
// hop from the rack (7), and a single container (3) is a hop from the ground.
box([76, 0, 31], [90, 6, 37], 'rust');
box([99, 0, 31], [120, 6, 37], 'panel');
box([80, 0, 37], [86, 3, 43], 'panel');
box([100, 0, 12], [112, 3, 17], 'rust');
box([96, 0, 52], [101, 3, 64], 'panel');
box([108, 0, 60], [113, 6, 72], 'rust');
box([44, 0, 92], [56, 3, 97], 'panel');
box([78, 0, 86], [83, 6, 98], 'rust');
box([100, 0, 104], [112, 3, 109], 'panel');
lamp([91, 0, 38.5]);
point([80, 0, 18], [108, 0, 22], [94.5, 0, 34], [104, 0, 46], [88, 0, 58], [100, 0, 78], [58, 0, 22], [58, 0, 52], [60, 0, 96], [96, 0, 96]);

// --- North-west yard: process tanks --------------------------------------------------------
box([-102, 0, 22], [-90, 12, 34], 'tank');
box([-102, 0, 48], [-90, 12, 60], 'tank');
box([-88, 0, 66], [-76, 3, 71], 'rust');
box([-66, 0, 40], [-61, 3, 52], 'panel');
box([-56, 0, 90], [-44, 3, 95], 'panel');
box([-90, 0, 100], [-78, 6, 105], 'rust');
pipe([-96, 10, 34], [-96, 10, 48], 0.8);
pipe([-102, 4, 28], [-119.5, 4, 28], 0.6);
lamp([-88, 0, 41]);
point([-80, 0, 16], [-110, 0, 41], [-84, 0, 41], [-84, 0, 62], [-58, 0, 22], [-58, 0, 52], [-108, 0, 72], [-60, 0, 96], [-96, 0, 92]);

// --- Spawns, twin, write ---------------------------------------------------------------------
const north = [[-4, 0.1, 96], [-14, 0.1, 96], [-24, 0.1, 96], [-24, 0.1, 106]];
write(new URL('./foundry.json', import.meta.url), { name: 'Foundry', size: [240, 240], night: true }, north);
