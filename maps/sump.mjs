// Sump: a 150 m flooded undercity in deep blue. An old street grid at -8 lies under the city deck
// (0), which its buildings hold up; light wells and ramp wells open the deck, a trench splits its
// center, and two roofs stand 7 m above it. Writes sump.json next to this file; rerun
// `node maps/sump.mjs` after editing.
//
// The north half (z > 0), the east half of the z = 0 street and the center are authored here;
// `write` (maps/kit.mjs) adds the 180-degree twin. Metrics as the other maps': 10 m streets, 7.5 m
// under the deck, ramps near 24 degrees, 3 m hover-up crates. Bots walk, so every way up is a ramp.
import { box, growth, lamp, once, pad, point, railing, ramp, sentries, sign, write } from './kit.mjs';

const CYAN = '#3de0ff', BLUE = '#5a8cff', AMBER = '#ffb347';

/** An old building, holding up the deck: walls from the undercity floor, a deck slab on top. */
function block([x0, z0], [x1, z1], mat = 'concrete') {
  box([x0, -8, z0], [x1, -1, z1], mat);
  box([x0, -1, z0], [x1, 0, z1], 'ground');
}
/** Deck grating over a street. */
const grate = ([x0, z0], [x1, z1]) => box([x0, -0.5, z0], [x1, 0, z1], 'metal');
/** Railings round a deck opening, given as the corners of each edge. */
const edge = (...corners) => corners.forEach(([a, b]) => railing(a, b));

// --- Undercity: blocks between the avenues (x 0, +-40, +-70) and streets (z 0, +-28) -------------
once(() => box([-75, -9, -48], [75, -8, 48], 'ground'));
block([-65, 5], [-45, 23], 'rust');
block([-35, 5], [-5, 23], 'panel');
block([45, 5], [65, 23]);
// North of the z = 28 street the blocks run on to the base, with one ramp slot at x = -40.
block([-75, 33], [-45, 48], 'panel');
block([-35, 33], [5, 48]);
block([5, 33], [45, 48], 'rust');
block([45, 33], [75, 48]);

// The east hall: the block between the trench and the x = 40 avenue is open under its deck.
box([5, -1, 5], [35, 0, 23], 'ground');
box([13, -8, 12], [15, -1, 14], 'concrete');
box([25, -8, 15], [27, -1, 17], 'concrete');

// Grating over the streets that stay roofed.
grate([5, -5], [75, 5]); // z = 0 street, east of the trench (the twin roofs the west)
grate([-75, 23], [-45, 33]);
grate([-45, 23], [-35, 31]); // short of the x = -40 ramp slot
grate([-35, 23], [35, 33]);
grate([45, 23], [75, 33]);
grate([-45, 5], [-35, 23]);
grate([65, 5], [75, 23]);
grate([-75, 5], [-65, 23]);

// --- Wells -----------------------------------------------------------------------------------------
// The trench: the x = 0 avenue lies open from z -23 to 23, a ramp up at each end and a footbridge
// across the middle.
ramp([0, -8, 5], [0, 0, 23], 9, 'metal', true);
once(() => {
  box([-5, -0.5, -2.5], [5, 0, 2.5], 'metal');
  railing([-5, 0, -2.5], [5, 0, -2.5]);
  railing([-5, 0, 2.5], [5, 0, 2.5]);
});
edge([[-5, 0, 2.5], [-5, 0, 23]], [[5, 0, 2.5], [5, 0, 23]]);
// The x = 40 well: a drop at the z = 28 crossing, and a ramp back up to the deck at z = 5.
ramp([40, -8, 23], [40, 0, 5], 9, 'metal', true);
edge([[35, 0, 5], [35, 0, 33]], [[45, 0, 5], [45, 0, 33]], [[35, 0, 33], [45, 0, 33]]);
// The x = -40 slot: up from the z = 28 street to the north base yard.
ramp([-40, -8, 30], [-40, 0, 48], 9, 'metal', true);
edge([[-45, 0, 31], [-45, 0, 48]], [[-35, 0, 31], [-35, 0, 48]], [[-45, 0, 31], [-35, 0, 31]]);

// Undercity lights: cyan lamps along the streets, signs on the walls.
for (const at of [[22, -8, 4], [58, -8, -4], [-58, -8, 24], [-22, -8, 32], [70, -8, 24], [20, -8, 22], [-40, -8, 8]]) lamp(at);
sign([-35.2, -6, 8], [-35, -3.5, 16], [-38, -5, 12], CYAN); // on the walls of the x = -40 avenue
sign([58, -6, 32.8], [66, -4, 33], [62, -5, 30], BLUE);
sign([10, -6, 32.8], [20, -4.5, 33], [15, -5, 30], AMBER);

// --- Deck top --------------------------------------------------------------------------------------
box([46, 0, 36], [64, 7, 46], 'panel'); // the east roof, by ramp from the deck
ramp([55, 0, 20], [55, 7, 36], 7);
railing([46, 7, 46], [64, 7, 46]);
railing([46, 7, 36], [51.5, 7, 36]);
railing([58.5, 7, 36], [64, 7, 36]);
box([-65, 0, 36], [-48, 22, 46], 'tower'); // a tower over the west blocks, blocks built out from it
growth([-56, 15, 36], [0, -1], 7); // over the deck
growth([-48, 17, 41], [1, 0], 7); // over the ramp slot
sign([-56, 8, 35.8], [-50, 14, 36], [-53, 3, 33], CYAN);
box([20, 0, 38], [26, 3, 44], 'rust'); // 3 m crates and vents: cover and hover-ups
box([-24, 0, 10], [-18, 3, 16], 'panel');
box([-58, 0, 12], [-54, 2, 16], 'metal');
box([56, 0, 8], [60, 2, 12], 'metal');
box([14, 0, 12], [20, 2.5, 16], 'rust');
for (const at of [[-20, 0, 26], [30, 0, 30], [-70, 0, 44], [66, 0, 14], [8, 0, 46]]) lamp(at);

// --- North base: a gate wall and a yard under open sky ------------------------------------------
box([-75, -1, 48], [75, 0, 75], 'ground');
box([-30.5, 0, 51.5], [-20, 9, 52.5], 'concrete');
box([-10, 0, 51.5], [10, 9, 52.5], 'concrete');
box([20, 0, 51.5], [30.5, 9, 52.5], 'concrete');
box([-30.5, 0, 52.5], [-29.5, 9, 75], 'concrete');
box([29.5, 0, 52.5], [30.5, 9, 75], 'concrete');
box([44, 0, 60], [60, 6, 70], 'panel'); // pump house in the east yard
sign([-8, 4, 51.3], [-2, 6.5, 51.5], [-5, 3, 49], CYAN);
for (const at of [[-25, 0, 50], [25, 0, 50], [-24, 0, 72], [-50, 0, 64]]) lamp(at);

// --- Perimeter -----------------------------------------------------------------------------------
box([75, -9, -76], [76, 0, 76], 'concrete');
box([75, 0, -76], [76, 24, 76], 'tower');
box([-76, 0, 75], [76, 24, 76], 'tower');

// --- Jump pad: from the x = 40 well's corner, out over the ramp well onto the hall's deck --------
pad([42.5, -8, 30.5], [27, 0, 14], 4);

// --- Waypoints -----------------------------------------------------------------------------------
once(() => point([0, -8, 0], [0, 0, 0]));
point([10, -8, 0], [25, -8, 0], [40, -8, 0], [55, -8, 0], [70, -8, 0]); // z = 0 street (east)
point([-70, -8, 28], [-55, -8, 28], [-40, -8, 28], [-20, -8, 28], [0, -8, 28], [20, -8, 28], [40, -8, 28], [55, -8, 28], [70, -8, 28]);
point([70, -8, 14], [-70, -8, 14], [-40, -8, 14], [10, -8, 19], [30, -8, 9], [20, -8, 14]); // avenues, hall
point([0, -8, 3]); // the trench ramp's foot (the wells' feet are on the z = 28 street)
point([0, 0, 27], [40, 0, 0], [-40, 0, 51]); // ramp tops
point([20, 0, 0], [58, 0, 0], [-62, 0, 10], [-12, 0, 14], [22, 0, 8], [48, 0, 16], [70, 0, 14]); // deck
point([-70, 0, 28], [-30, 0, 28], [20, 0, 28], [67, 0, 28], [-70, 0, 40], [-20, 0, 40], [5, 0, 40], [34, 0, 40], [70, 0, 40]);
point([55, 0, 16], [50, 7, 41], [60, 7, 41]); // the east roof
point([-15, 0, 48], [15, 0, 48], [-15, 0, 58], [15, 0, 58], [0, 0, 66], [-45, 0, 62], [65, 0, 58], [-60, 0, 70]); // base

// --- Base guns: inside the gate wall, behind its middle span, out of the gates ---------------------
sentries([[-6, 0, 55], [6, 0, 55]]);

// --- Spawns, twin, write -------------------------------------------------------------------------
const north = [[-20, 0.1, 64], [-12, 0.1, 70], [12, 0.1, 66], [20, 0.1, 62]];
const palette = {
  sky: { horizon: '#1f3550', zenith: '#070d18', sun: '#cfe4ff', stars: 0.1 },
  fog: [30, 140],
  haze: ['#2f5f8a', 0.035, 4],
  light: { sky: '#7fa0cc', ground: '#1a2434', ambient: 2.1, sun: '#bcd8ff', direct: 1.4 },
  lamp: '#7fe8ff',
  tint: '#a4b0c0',
  cover: 0.5,
  skyline: 'city',
  windows: ['#bfe8ff', '#7fd4ff', '#ffe2a0'],
};
write(new URL('./sump.json', import.meta.url), { name: 'Sump', size: [150, 150], night: true, palette }, north);
