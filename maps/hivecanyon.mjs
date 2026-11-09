// Hive Canyon: Hivewall as it first stood, a mining colony carved into a cliff over a canyon,
// overrun by the Bloom, a glowing orange fungus that has taken the colony's machines. Made for
// Co-op Defense alone: the Bloom's walkers come out of three mine mouths at the canyon's floor and
// climb 96 m to the reactor on the cliff's top. Writes hivecanyon.json next to this file; rerun
// `node maps/hivecanyon.mjs` after editing.
//
// A 300 x 220 m map, the canyon along its south edge and the cliff rising north, on 12 m storeys:
// - the Workings (-12): flooded mine galleries on the canyon floor, the three mine mouths (the
//   gates) in its far wall, each under the foot of a climb, a ramp up out of each to
// - Low Town (0): the market street along the canyon, under the cliff's face;
// - the Stack (12-72): tenement blocks piled up the cliff, their roofs the terraces, the towers'
//   ground: over the flights, beside the landings, round the Shaft's foot;
// - the Crest (84): the atmosphere plant's plaza on top, the reactor in it by the Stair's head.
// Three climbs, a lane each, joined by cross-links:
// - the Stair, mid-face: a switchback street, flights 14 m wide (23 degrees), terraces between them
//   at 24, 48 and 72; the main lane;
// - the Shaft, west: an old ore lift, its core 28 m square, a 14 m ramp spiralling round it seven
//   sides, a storey a side; the heavies' way;
// - the Warren, east: a stairwell through a tenement's insides, seven 10 m halls switching back
//   between landing rooms, in off Low Town by a tunnel; narrow, so brutes and bosses keep off it.
// The side gates' walkers may take the street to the Stair's foot instead; the Shaft's lane crosses
// to the Stair at 48, the Stair's to the Warren at 24, and the Warren's back to the Stair at 72 (one
// way each, so no lane loops). Overlooks, where towers stand 8 m over a lane, out of crawlers' and
// brutes' reach and seeing over what walks it: a gallery cut in the terrace's edge along each of the
// first three flights (and one in the Crest's corner over the turn at 72), two round the Shaft's
// walls, and docks on the quay by two of the mine ramps. Metrics as the other maps': 9 m+ over wide
// lanes, 6.5 m+ over anything mechs walk, ramps near 23 degrees.
import { beam, box, coopOnly, cylinder, decor, defense, furnace, lamp, objectives, pad, pipe, point, r3, railing, sign, slope, solids, turned, write } from './kit.mjs';

const SIZE = [300, 220];
const WORK = -12, CREST = 84;
const BACK = -100, QUAY = -68, FACE = -45, STREET = -57; // the far wall, Low Town's two edges, its street
const GATES = [-100, -35, 67], MOUTH = 8; // the mine mouths (under the Shaft, the Stair, the Warren), and half of one's width
const BLOOM = '#ff7a1a', SICK = '#ffb347', COLD = '#7fe0ff', RED = '#ff3a2a';
// The overlooks (the docks, galleries and ledges below) stand this high over the lanes beside them:
// out of reach of crawlers' blasts and brutes' fists, and over the heads of what walks the lane.
const LIFT = 8;

/** A box between two corners in plan, from y0 to y1. */
const block = (x0, z0, x1, z1, y0, y1, mat = 'concrete') => box([x0, y0, z0], [x1, y1, z1], mat);
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

// --- The Workings: the canyon's floor, the far wall and its mine mouths ------------------------------
box([-150, WORK - 2, -110], [150, WORK, QUAY], 'ground');
{
  let x0 = -150;
  for (const g of GATES) {
    block(x0, -110, g - MOUTH, BACK, WORK - 2, 48, 'rock');
    block(g - MOUTH, -110, g + MOUTH, BACK, 0, 48, 'rock'); // over the mouth
    x0 = g + MOUTH;
  }
  block(x0, -110, 150, BACK, WORK - 2, 48, 'rock');
}
// Each mouth: timbered, the Bloom's light deep in it, and a ramp up from it to Low Town.
for (const g of GATES) {
  for (const s of [-1, 1]) beam([g + s * 7.4, WORK, BACK + 0.5], [g + s * 7.4, -1, BACK + 0.5], 0.8, 0.8, 'pale');
  beam([g - 8, -1, BACK + 0.5], [g + 8, -1, BACK + 0.5], 0.8, 1, 'pale');
  furnace([g - 6, WORK, -109.9], [g + 6, WORK + 7, -109.6], [g, WORK + 4, -104]);
  wedge([g, WORK, -96], [g, 0, QUAY], 14, WORK, 'concrete');
  for (const s of [-1, 1]) railing([g + s * 6.8, WORK, -96], [g + s * 6.8, 0, QUAY]);
}
// Galleries: timber-roofed bays along the far wall between the mouths, posts and roof slabs, low
// enough to read as the mine's and high enough to walk under; rock pillars and spoil out on the floor.
{
  const r = rng(11);
  for (const [x0, x1] of [[-148, -114], [-86, -49], [-21, 53], [81, 148]]) {
    block(x0, BACK, x1, -86, -2.5, -1.5, 'pale');
    for (let x = x0 + 2; x <= x1 - 2; x += Math.max(8, (x1 - x0 - 4) / Math.round((x1 - x0 - 4) / 10))) {
      for (const z of [-87, -99]) block(x - 0.5, z - 0.5, x + 0.5, z + 0.5, WORK, -2.5, 'pale');
    }
    for (let k = 0; k < (x1 - x0) / 12; k++) fungus(r(x0 + 3, x1 - 3), WORK, r(-98, -88), r(1.5, 3.5));
  }
  // Pillars of rock the miners left, out on the floor between the ramps.
  for (const [x, z, w, d, yaw] of [[-128, -78, 7, 5, 12], [-62, -80, 6, 6, 30], [-6, -76, 5, 4, -15], [36, -79, 6, 5, 20], [100, -77, 5, 6, -25], [132, -80, 7, 6, 8]]) {
    turned([x, -6, z], [w / 2, 6, d / 2], yaw, 'rock');
    fungus(x + w, WORK, z - 2, 2.5);
  }
  for (let k = 0; k < 26; k++) {
    const x = r(-146, 146), z = r(-84, -71);
    if (GATES.every((g) => Math.abs(x - g) > 13)) fungus(x, WORK, z, r(1.2, 3));
  }
}

// --- Low Town and the Stack's footing ------------------------------------------------------------------
block(-150, QUAY, 150, 110, WORK, 0, 'ground');
// Loading docks on the quay, LIFT high, beside the ramps up from the Stair's mine mouth (west of it)
// and the Warren's (east): towers on one look down the ramp and the mouth, and along the street.
// Each a slab from 15 to 25 m off the ramp's lane, a ramp up onto it from further along the quay.
const DOCKS = [[GATES[1], -1], [GATES[2], 1]], DOCK = [15, 25, r3(25 + (56 * LIFT) / 24)], DZ = [QUAY, -62.5];
/** Whether x is along the quay where a dock (and its ramp) stands, `pad` m round it. */
const docked = (x, pad = 0) => DOCKS.some(([g, side]) => (x - g) * side > DOCK[0] - pad && (x - g) * side < DOCK[2] + pad);
for (const [g, side] of DOCKS) {
  block(Math.min(g + side * DOCK[0], g + side * DOCK[1]), DZ[0], Math.max(g + side * DOCK[0], g + side * DOCK[1]), DZ[1], 0, LIFT, 'concrete');
  wedge([g + side * DOCK[2], 0, (DZ[0] + DZ[1]) / 2], [g + side * DOCK[1], LIFT, (DZ[0] + DZ[1]) / 2], DZ[1] - DZ[0], 0, 'metal');
}

// --- The Stair: four flights up the face's middle, terraces between ---------------------------------
// Flight k runs along z = FLIGHTS[k], 14 m wide, from landing to landing: x = +-28 at its ends, the
// landings (14 m) out to +-42, the lane down their middles (x = +-35).
const FLIGHTS = [-38, -10, 18, 46];
// Galleries: a strip of the terrace on each flight's uphill side, GW deep, cut down to LIFT over the
// flight: flat over the landing at the flight's foot, then up along the flight, LIFT over it all the
// way, to meet the terrace's top. Pilots walk down into one off the terrace and build looking down
// onto the flight.
const GW = 6;
/**
 * Flight `k`'s gallery: the flight's foot at (x0, y0), climbing toward `dir` (+-1 in x), the terrace
 * it's cut from `top` high and reaching to x = `to`. Where it meets the terrace's top, from its foot.
 */
function gallery(k, [x0, y0], dir, top, to, mat) {
  const [z0, z1] = [FLIGHTS[k] + 7, FLIGHTS[k] + 7 + GW], zc = (z0 + z1) / 2, y = y0 + LIFT;
  const xj = r3(x0 + (dir * (top - y) * 56) / 24);
  const span = (a, b, y1, m = mat) => block(Math.min(a, b), z0, Math.max(a, b), z1, 0, y1, m);
  span(x0 - dir * 14, x0, y); // over the landing
  wedge([x0, y, zc], [xj, top, zc], GW, 0, 'concrete');
  span(x0, xj, y); // under it (a tilted slab's end leaves a gap under its foot)
  span(xj, to, top); // the rest of the strip, at the terrace's height
  return xj;
}
const GJ = [];
{
  block(-86, FACE, -42, -31, 0, 24, 'tower'); // the terrace at 24's west wing, over Low Town
  block(-86, -31, -42, -17, 0, 24, 'tower'); // the terrace at 24, its gallery cut out of its edge
  block(-42, -25, 28, -17, 0, 24, 'tower');
  GJ.push(gallery(0, [-28, 0], 1, 24, 28, 'tower'));
  wedge([-28, 0, FLIGHTS[0]], [28, 24, FLIGHTS[0]], 14, 0); // flight 1: 0 -> 24, west to east
  block(28, FACE, 42, -3, 0, 24); // the east landing at 24
  block(-28, -17, 28, -3, 0, 24);
  wedge([28, 24, FLIGHTS[1]], [-28, 48, FLIGHTS[1]], 14, 24); // flight 2: 24 -> 48
  block(-42, -17, -28, 25, 0, 48); // the west landing at 48
  // The terrace at 48's west wing, to the Shaft, a gallery cut in its edge over the Shaft (see there).
  block(-87, -17, -42, 39, 0, 48, 'tower');
  block(-28, 3, 42, 11, 0, 48, 'tower'); // the terrace at 48, and its gallery
  GJ.push(gallery(1, [28, 24], -1, 48, -28, 'tower'));
  block(-28, 11, 28, 25, 0, 48);
  wedge([-28, 48, FLIGHTS[2]], [28, 72, FLIGHTS[2]], 14, 48); // flight 3: 48 -> 72
  block(28, 11, 42, 53, 0, 72); // the east landing at 72
  block(-42, 31, 28, 39, 0, 72, 'tower'); // the terrace at 72, and its gallery
  GJ.push(gallery(2, [-28, 48], 1, 72, 28, 'tower'));
  block(0, 39, 28, 53, 0, 72);
  wedge([28, 72, FLIGHTS[3]], [0, CREST, FLIGHTS[3]], 14, 72); // flight 4: 72 -> the Crest, a storey
}

// --- The Crest ---------------------------------------------------------------------------------------
// West, over the Shaft and the Stair's top, the Shaft's galleries cut in its face (see there).
block(-150, 45, 0, 110, 0, CREST, 'rock');
block(-87, 39, 0, 45, 0, CREST, 'rock');
block(0, 53, 150, 110, 0, CREST, 'rock');
// East, over the Stair's turn at 72, a gallery cut in its corner: LIFT over the landing and the strip,
// up beside the landing to the Crest's top (the Warren's lane out passes north of it).
const TURN = [42, 48, 34, 41, r3(41 + (56 * (CREST - 72 - LIFT)) / 24)]; // x0, x1, z0, its ramp's foot, top
block(TURN[1], 34, 150, 53, 0, CREST, 'rock');
block(TURN[0], TURN[2], TURN[1], TURN[3], 0, 72 + LIFT, 'rock');
wedge([45, 72 + LIFT, TURN[3]], [45, CREST, TURN[4]], TURN[1] - TURN[0], 0, 'concrete');
block(TURN[0], TURN[3], TURN[1], TURN[4], 0, 72 + LIFT, 'rock');
block(TURN[0], TURN[4], TURN[1], 53, 0, CREST, 'rock');

// --- The Shaft: the ore lift's core, a ramp round it from Low Town to the Crest ----------------------
// Corners SE at 0 (the foot, off Low Town), SW 12, NW 24, NE 36, SE 48, SW 60, NW 72, NE 84 (the
// top, onto the Crest), each a 14 m landing; the sides between, ramps 28 m long.
const HC = [-121, 11], CORE = 14, LR = 21;
const EAST_LEDGE = 6.333; // where the ramp up the east side, from 36, passes 44
const SHAFT_UP = -135 + (28 * (CREST - 72 - LIFT)) / 12; // where the upper gallery meets the Crest's top
const CORNERS = [[1, -1], [-1, -1], [-1, 1], [1, 1]]; // SE, SW, NW, NE
const corner = (k) => [HC[0] + CORNERS[k % 4][0] * LR, 12 * k, HC[1] + CORNERS[k % 4][1] * LR];
{
  block(HC[0] - CORE, HC[1] - CORE, HC[0] + CORE, HC[1] + CORE, 0, 96, 'rust'); // the core
  block(-150, -17, -149, 39, 0, 96, 'rock'); // the shaft's west wall, on the map's edge
  for (let k = 1; k <= 7; k++) {
    const [x, y, z] = corner(k);
    block(x - 7, z - 7, x + 7, z + 7, y - 1, y, 'metal');
  }
  for (let k = 0; k < 7; k++) {
    const [a, b] = [corner(k), corner(k + 1)], len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const d = [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
    const low = [a[0] + d[0] * 7, a[1], a[2] + d[1] * 7], high = [b[0] - d[0] * 7, b[1], b[2] - d[1] * 7];
    if (k === 0) wedge(low, high, 14, 0, 'metal');
    else deck(low, high, 14);
  }
  // The headframe's legs at the shaft's outer corners, and girders round it every other storey.
  for (const [sx, sz] of CORNERS) {
    const [x, z] = [HC[0] + sx * 28.6, HC[1] + sz * 28.6];
    if (sx > 0 && sz < 0) continue; // (the foot's corner stays open)
    block(x - 0.6, z - 0.6, x + 0.6, z + 0.6, 0, 96, 'rust');
  }
  block(HC[0] - 18, HC[1] - 18, HC[0] + 18, HC[1] + 18, 96, 97.5, 'rust'); // the headframe's cap
  cylinder([HC[0] - 9, 104, HC[1]], [HC[0] + 9, 104, HC[1]], 6.5, 'rust'); // its wheel
  // Galleries cut in the walls round it, GW deep, LIFT over the ramps and corners beside them. The
  // lower, in the north wall (the Crest's face) from over the corner at 24, up beside the ramp to
  // over the corner at 36, round it and along the east wall (the terrace at 48's west wing) at 44, to
  // meet the ramp on from 36 where that passes 44: walked onto off it there. The upper, over the
  // corner at 72, up beside the ramp on from it to meet the Crest's top: walked down into off the Crest.
  const [z0, z1] = [HC[1] + 28, HC[1] + 28 + GW], zc = (z0 + z1) / 2;
  block(-150, z0, -135, z1, 0, 24 + LIFT, 'rock');
  wedge([-135, 24 + LIFT, zc], [-107, 36 + LIFT, zc], GW, 0, 'metal');
  block(-135, z0, -107, z1, 0, 24 + LIFT, 'rock');
  block(-107, z0, -87, z1, 0, 36 + LIFT, 'rock');
  block(-93, EAST_LEDGE, -87, z0, 0, 36 + LIFT, 'tower');
  block(-93, -17, -87, EAST_LEDGE, 0, 48, 'tower');
  block(-150, z0, SHAFT_UP, z1, 54, 72 + LIFT, 'rock'); // over the lower, under the upper
  wedge([-135, 72 + LIFT, zc], [SHAFT_UP, CREST, zc], GW, 54, 'metal');
  block(SHAFT_UP, z0, -87, z1, 54, CREST, 'rock');
}

// --- The west: the Shaft's foot, a block to 12 beside it ----------------------------------------------
block(-150, FACE, -114, -17, 0, 12, 'tower'); // its roof level with the Shaft's corner at 12
// (the Shaft's foot between, x -114 to -86, stays at Low Town's level)

// --- The east: a ledge at 24, the Warren, a strip at 72, the tenements up to the Crest -------------
// The Warren's stairwell: lane A (x 62-72) climbs north, lane B (74-84) south, a 2 m wall between;
// landing rooms at the south end (z -15 to -5: 0, 24, 48, 72) and the north (24 to 34: 12, 36, 60,
// 84); its halls between (z -5 to 24) climb a storey each, tall enough over their tops. In by a tunnel
// at 0 from Low Town, out onto the Crest at 84; a gallery at 24 joins the Stair's landing there, a
// doorway at 72 the strip back to the Stair.
const WA = [62, 72], WB = [74, 84], WS = [-15, -5], WN = [24, 34];
{
  block(42, FACE, 62, -17, 0, 24, 'tower');
  block(WA[0], FACE, WA[1], -17, 11, 24, 'tower'); // over the tunnel
  block(WA[1], FACE, 150, -17, 0, 24, 'tower');
  block(42, -17, 62, -5, 0, 24); // under the gallery at 24
  block(42, -17, 62, -5, 34, 72); // over it
  block(42, -5, 62, 34, 0, 72, 'tower'); // the strip at 72
  block(WB[1], -17, 150, 34, 0, CREST, 'tower'); // the east tenements
  // The stairwell's south wall (the tunnel through it), its rooms' floors and ceilings.
  block(WA[0], -17, WA[1], WS[0], 11, CREST);
  block(WA[1], -17, WB[1], WS[0], 0, CREST);
  for (const [y0, y1] of [[11, 24], [35, 48], [59, 72], [83, 84]]) block(WA[0], WS[0], WB[1], WS[1], y0, y1);
  for (const [y0, y1] of [[0, 12], [23, 36], [47, 60], [71, 84]]) block(WA[0], WN[0], WB[1], WN[1], y0, y1);
  block(WA[1], WS[1], WB[0], WN[0], 0, CREST); // the wall between the halls
  for (const s of [0, 24, 48, 72]) {
    const x = (WA[0] + WA[1]) / 2;
    if (s === 0) wedge([x, 0, WS[1]], [x, 12, WN[0]], 10, 0);
    else deck([x, s, WS[1]], [x, s + 12, WN[0]], 10, 'concrete');
    if (s < 72) block(WA[0], WS[1], WA[1], WN[0], s + 23, s + 24); // its hall's ceiling (the last is open)
  }
  for (const n of [12, 36, 60]) {
    const x = (WB[0] + WB[1]) / 2;
    if (n === 12) wedge([x, n, WN[0]], [x, n + 12, WS[1]], 10, 0);
    else deck([x, n, WN[0]], [x, n + 12, WS[1]], 10, 'concrete');
    block(WB[0], WS[1], WB[1], WN[0], n + 23, n + 24);
  }
}

// --- Lanes ---------------------------------------------------------------------------------------------
// Named points; edges from, to, weight (the Stair's 3, the Shaft's and the Warren's 2, cross-links 1).
const lanePoints = [], at = {}, edges = [], narrow = [];
const P = (name, p) => {
  at[name] = lanePoints.length;
  lanePoints.push(p.map(r3));
};
const link = (a, b, w, tight = false) => {
  if (tight) narrow.push(edges.length);
  edges.push([at[a], at[b], w]);
};
const chain = (names, w, tight = false) => names.slice(1).forEach((n, i) => link(names[i], n, w, tight));
const REACTOR = [-12, CREST, 70];
P('R', REACTOR);
GATES.forEach((g, k) => {
  const t = 'WME'[k];
  P(`${t}0`, [g, WORK, -104]);
  P(`${t}1`, [g, WORK, -96]);
  P(`${t}2`, [g, 0, QUAY]);
  P(`${t}3`, [g, 0, STREET]);
});
// The Stair: up each flight, then along its landing to the next.
P('S0', [-35, 0, FLIGHTS[0]]);
P('S1', [35, 24, FLIGHTS[0]]);
P('S2', [35, 24, FLIGHTS[1]]);
P('S3', [-35, 48, FLIGHTS[1]]);
P('S4', [-35, 48, FLIGHTS[2]]);
P('S5', [35, 72, FLIGHTS[2]]);
P('S6', [35, 72, FLIGHTS[3]]);
P('S7', [-7, CREST, FLIGHTS[3]]);
const STAIR = ['M3', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
// The Shaft.
for (let k = 0; k <= 7; k++) P(`H${k}`, corner(k));
P('HX', [corner(7)[0], CREST, 46]);
// The Warren.
const WX = [(WA[0] + WA[1]) / 2, (WB[0] + WB[1]) / 2], WZ = [(WS[0] + WS[1]) / 2, (WN[0] + WN[1]) / 2];
const WARREN = ['E3'];
for (let s = 0; s <= 72; s += 24) {
  if (s) P(`B${s}`, [WX[1], s, WZ[0]]), WARREN.push(`B${s}`);
  P(`A${s}`, [WX[0], s, WZ[0]]);
  P(`a${s + 12}`, [WX[0], s + 12, WZ[1]]);
  WARREN.push(`A${s}`, `a${s + 12}`);
  if (s < 72) P(`b${s + 12}`, [WX[1], s + 12, WZ[1]]), WARREN.push(`b${s + 12}`);
}
P('WT', [WX[0], CREST, 46]);
P('K1', [49, 72, WZ[0]]);
P('K2', [49, 72, FLIGHTS[2]]);

chain(['W0', 'W1', 'W2', 'W3', 'H0'], 2);
chain(['M0', 'M1', 'M2', 'M3'], 3);
chain(['E0', 'E1', 'E2', 'E3'], 2);
chain([...STAIR, 'R'], 3);
chain(['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'HX', 'R'], 2);
chain(WARREN, 2, true);
chain(['a84', 'WT', 'R'], 2);
// Low Town's forks: the side gates' walkers to their own climbs mostly, else along the street to
// the Stair's foot (the Warren's big ones always).
link('W3', 'M3', 1);
link('E3', 'M3', 1);
// Cross-links up the face.
link('H4', 'S3', 1); // the Shaft at 48 to the Stair's west landing
link('S2', 'A24', 1, true); // the Stair's east landing at 24 into the Warren
chain(['A72', 'K1', 'K2', 'S5'], 1, true); // the Warren at 72 out along the strip to the Stair
// Routes the Bloom can seal (a run starts with one sealed, and between waves it seals another or
// bursts one open, never cutting a gate off from the reactor).
const edgeOf = (a, b) => edges.findIndex(([x, y]) => x === at[a] && y === at[b]);
const seals = [
  [edgeOf('W3', 'H0'), "the Shaft's foot"],
  [edgeOf('E3', 'A0'), 'the Warren tunnel'],
  [edgeOf('W3', 'M3'), 'the west street'],
  [edgeOf('E3', 'M3'), 'the east street'],
  [edgeOf('H4', 'S3'), 'the Shaft link at 48'],
  [edgeOf('S2', 'A24'), 'the Warren door at 24'],
  [edgeOf('A72', 'K1'), 'the strip at 72'],
];
if (seals.some(([e]) => e < 0)) throw new Error('a seal on no edge');
defense({ at: REACTOR, radius: 8 }, GATES.map((g) => [g, WORK, -104]), { points: lanePoints, edges, narrow, seals });
// Its own pace, as Hivewall first played (bosses 2600 and 4500, the compact Hivewall's 1800 and
// 3200): its climbs are twice as long, so bosses stand twice as long under fire and need the hull,
// and stragglers 30 s behind their wave's last walk 1.25 times their pace.
Object.assign(objectives.defense, { bosses: 1.42, hurry: [30, 1.25] });
coopOnly();

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
/** Waypoints over the rectangle at height y, about `step` apart, each nudged off anything in the way. */
function grid(x0, z0, x1, z1, y, step = 16) {
  const nx = Math.max(1, Math.round((x1 - x0) / step)), nz = Math.max(1, Math.round((z1 - z0) / step));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const [x, z] = [x0 + ((i + 0.5) * (x1 - x0)) / nx, z0 + ((j + 0.5) * (z1 - z0)) / nz];
      const spot = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dz]) => [r3(x + dx), y, r3(z + dz)]).find((p) => !blocked(p));
      if (spot) point(spot);
    }
  }
}
/** Waypoints along a lane's points (on ramps, rooms and landings), and between them where far apart. */
function along(names, gap = 24) {
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
// The pads (where they throw from and land) and the pilots' spawns, kept clear of props.
const PADS = [
  [[-64, 0, -51], [-64, 24, -35], 44], // Low Town onto the terrace at 24
  [[118, 0, -51], [118, 24, -34], 44], // onto the east ledge at 24
  [[-132, 0, -51], [-132, 12, -34], 30], // onto the block at 12 by the Shaft
  [[-64, 24, -27], [-64, 48, -4], 60], // the terrace at 24 up to 48
  [[-10, 48, 4], [-10, 72, 33], 84], // 48 to 72, over flight 3
  [[10, 72, 30], [10, CREST, 62], 94], // 72 to the Crest, over flight 4
  [[52, 24, -30], [52, 72, 0], 90], // the east ledge onto the strip at 72
];
const SPAWNS = [[-16, 92], [16, 92], [-32, 90], [32, 90], [-50, 86], [50, 86]].map(([x, z]) => [x, CREST + 0.1, z]);
/** Whether a prop `r` m round at (x, z) on height y keeps off the pads' ends and the spawns. */
const roomy = (x, y, z, r) => [...PADS.flatMap(([a, b]) => [a, b]), ...SPAWNS].every((p) => Math.abs(p[1] - y) > 2 || Math.hypot(p[0] - x, p[2] - z) > r + 4.5);
const tank = (x, y, z, r, h) => offLanes([x, y, z], r) && roomy(x, y, z, r) && cylinder([x, y, z], [x, y + h, z], r, 'tank');
/** A smokestack standing on `y`: two boxes, square and diamond, as kit's `stack`. */
function chimney(x, y, z, r, h) {
  box([x - r, y, z - r], [x + r, y + h, z + r], 'stack');
  turned([x, y + h / 2, z], [r, h / 2, r], 45, 'stack');
}
/** Railings along a drop's edge, posts every 1.6 m (props: a rail stops nobody). */
const rail = (a, b) => railing(a.map(r3), b.map(r3));
{
  // Low Town: stalls along the cliff's foot and the quay, clear of the lanes and the pads; neon
  // over them, lamps, the Bloom creeping up from the quay's edge.
  const r = rng(23), AWNINGS = ['hazard', 'rust', 'ore'], NEON = [SICK, COLD, '#ff4fa0', '#b0ff3a', BLOOM];
    for (const [z0, z1] of [[-50.5, -46], [-67, -62.5]]) {
    for (let x = -146; x < 146; x += r(9, 14)) {
      const p = [x, 0, (z0 + z1) / 2];
      if (!offLanes(p, 2.5, 5.4) || !roomy(x, 0, p[2], 3) || (z0 < -60 && docked(x, 3))) continue;
      const [w, d] = [r(3, 5), z1 - z0];
      block(x - w / 2, z0, x + w / 2, z1, 0, r(2.6, 3.4), r() < 0.5 ? 'rust' : 'panel');
      decor.push({ kind: 'slab', from: [r3(x - w / 2 - 0.6), 3.5, r3(Math.min(z0, z1) - 1)], to: [r3(x + w / 2 + 0.6), 3.7, r3(Math.max(z0, z1) + 0.4)], mat: AWNINGS[Math.floor(r() * 3)] });
      if (r() < 0.6) sign([r3(x - 1.5), 4, r3(z0 < -60 ? z0 - 0.1 : z1 - 0.15)], [r3(x + 1.5), 5.2, r3(z0 < -60 ? z0 : z1 - 0.05)], [r3(x), 3, r3((z0 + z1) / 2 + (z0 < -60 ? 2 : -3))], NEON[Math.floor(r() * NEON.length)]);
    }
  }
  for (let x = -140; x <= 140; x += 28) if (!docked(x, 1)) lamp([x, 0, -63.5]);
  for (let x = -146; x <= 146; x += r(6, 12)) if (GATES.every((g) => Math.abs(x - g) > 9) && !docked(x, 2)) fungus(x, 0, QUAY + r(1, 3), r(1, 2.5));
  const ends = DOCKS.flatMap(([g, side]) => [g + side * DOCK[0], g + side * DOCK[2]]);
  [-150, ...[...GATES.flatMap((g) => [g - 7, g + 7]), ...ends].sort((a, b) => a - b), 150].forEach((x, k, xs) => k % 2 === 0 && rail([x, 0, QUAY + 0.3], [xs[k + 1], 0, QUAY + 0.3]));
  // The docks: rails round their tops and up their ramps' sides, a lamp, a sign, the Bloom at the foot.
  for (const [g, side] of DOCKS) {
    const [a, b, c] = DOCK.map((d) => r3(g + side * d));
    for (const z of [DZ[0] + 0.3, DZ[1] - 0.3]) rail([a, LIFT, z], [b, LIFT, z]), rail([b, LIFT, z], [c, 0, z]);
    rail([a - side * 0.3, LIFT, DZ[0]], [a - side * 0.3, LIFT, DZ[1]]);
    lamp([r3(g + side * 23.5), LIFT, -63.5]);
    sign([Math.min(a, b) + 2, 2.5, DZ[1] + 0.05], [Math.max(a, b) - 2, 4, DZ[1] + 0.15], [r3((a + b) / 2), 3, -59], side < 0 ? SICK : COLD);
    fungus(r3(g + side * 14), 0, -64, 1.5);
  }
  // Signs up the Stack's foot: the colony's name over the Stair, the Warren's tunnel marked, the
  // Shaft's foot, warnings where the Bloom came up.
  sign([-24, 9, FACE - 0.15], [-6, 12, FACE - 0.05], [-15, 8, FACE - 6], SICK);
  sign([WA[0] + 1, 12.5, FACE - 0.15], [WA[1] - 1, 15, FACE - 0.05], [67, 10, FACE - 5], COLD);
  sign([-130, 13, FACE - 0.15], [-118, 15.5, FACE - 0.05], [-124, 10, FACE - 5], RED);
  sign([-84, 14, FACE - 0.15], [-70, 17, FACE - 0.05], [-77, 12, FACE - 6], '#ff4fa0');
  sign([88, 15, FACE - 0.15], [104, 18, FACE - 0.05], [96, 12, FACE - 6], '#b0ff3a');
  sign([124, 9, FACE - 0.15], [138, 11.5, FACE - 0.05], [131, 8, FACE - 5], BLOOM);
}
{
  // The terraces: water tanks along their back walls, rails along their drops, lamps; the Bloom in
  // the corners, thinning as it climbs.
  const r = rng(37);
  for (const [x0, x1, z, y] of [[-80, 20, -20, 24], [-80, -50, -42, 24], [48, 146, -20, 24], [-82, -50, 34, 48], [-20, 34, 8, 48], [-36, 20, 36, 72], [-144, -120, -20, 12]]) {
    for (let x = x0; x <= x1; x += r(14, 22)) tank(r3(x), y, z, r3(r(1.8, 2.6)), r3(r(4, 6.5)));
  }
  for (const [x0, x1, z, y] of [[-86, -42, -31, 24], [GJ[0], 28, -31, 24], [-42, GJ[0], -25, 24], [-86, -42, FACE, 24], [42, 150, FACE, 24], [-28, GJ[1], -3, 48], [GJ[1], 42, 3, 48], [-150, -114, FACE, 12], [GJ[2], 28, 25, 72], [-42, GJ[2], 31, 72]]) {
    rail([x0, y, z + 0.3], [x1, y, z + 0.3]);
  }
  for (const [x, y, z] of [[-60, 24, -24], [-20, 24, -22], [10, 24, -24], [-70, 24, -40], [60, 24, -26], [100, 24, -26], [140, 24, -30], [-80, 48, 10], [-60, 48, 30], [0, 48, 6], [-20, 72, 34], [56, 72, 20], [-130, 12, -30], [-108, 0, -30], [-92, 0, -30]]) {
    if (offLanes([x, y, z], 0.5, 4)) lamp([x, y, z]);
  }
  for (const [x0, x1, z0, z1, y, n] of [[-86, 28, -24, -18, 24, 6], [-86, -42, -44, -32, 24, 4], [44, 148, -44, -18, 24, 7], [-86, -44, -16, 38, 48, 4], [-26, 40, 4, 10, 48, 2], [-40, 26, 32, 38, 72, 1], [-148, -116, -44, -18, 12, 4], [-112, -88, -44, -18, 0, 6]]) {
    for (let k = 0; k < n; k++) fungus(r(x0, x1), y, r(z0, z1), r(1, 2.6));
  }
  // The Shaft's foot round its core, and the Warren's rooms: dark, and thick with it.
  for (const [x, z] of [[-100, 6], [-100, 24], [-121, 33], [-142, 20], [-142, 0], [-106, -40], [-94, -24]]) fungus(x, 0, z, r(2, 3.5));
  for (const s of [0, 24, 48, 72]) fungus(80, s, -13, r(1.5, 2.5)), fungus(64, s, -13, 1.2);
  for (const n of [12, 36, 60]) fungus(82, n, 32, r(1.5, 2.5));
  for (let k = 0; k < 6; k++) fungus(67, 0, r(-44, -18), r(1, 2));
}
{
  // Balconies and pipes on the terraces' faces, high over what's under them (not over the flights,
  // where the galleries look out).
  const r = rng(53);
  for (const [x0, x1, z, y0, y1, side] of [[-80, -45, FACE, 6, 20, -1], [46, 146, FACE, 8, 20, -1], [-90, -46, -17, 32, 44, -1], [-146, -118, FACE, 7, 9, -1]]) {
    for (let x = x0 + r(0, 6); x < x1 - 4; x += r(10, 18)) {
      const y = r3(r(y0, y1)), w = r(3, 6);
      const arcs = PADS.every(([a, b]) => {
        const [dx, dz] = [b[0] - a[0], b[2] - a[2]], s = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - 1 - a[2]) * dz) / (dx * dx + dz * dz)));
        return Math.hypot(x - a[0] - dx * s, z - 1 - a[2] - dz * s) > w / 2 + 5;
      });
      if (side < 0 && arcs && offLanes([x, y, z - 1.5], 2, 5)) block(r3(x - w / 2), r3(z - 2), r3(x + w / 2), z, y, r3(y + 0.4), 'metal');
    }
    for (let x = x0 + r(2, 8); x < x1; x += r(12, 24)) pipe([r3(x), y0 - 4, r3(z - 0.4)], [r3(x), y1 + 3, r3(z - 0.4)], r3(r(0.2, 0.4)));
    pipe([x0, r3((y0 + y1) / 2), r3(z - 0.5)], [x1, r3((y0 + y1) / 2), r3(z - 0.5)], 0.3);
  }
}
{
  // The Crest: the atmosphere plant round the reactor, a ring of open ground about it to fight on.
  const r = rng(71);
  block(-22, 100, 22, 110, CREST, CREST + 12, 'panel'); // the plant's hall, behind the reactor
  block(-14, 98, 14, 100, CREST, CREST + 7, 'metal');
  for (const [x, z, rad, h] of [[-62, 96, 7, 15], [62, 96, 7, 15], [-92, 100, 5, 11], [96, 98, 5, 11], [-120, 64, 6, 13], [128, 66, 6, 13], [-40, 104, 3.5, 8], [40, 104, 3.5, 8]]) {
    tank(x, CREST, z, rad, h);
    pipe([x, CREST + h - 1, z], [x < 0 ? -22 : 22, CREST + 9, z < 100 ? 104 : 105], 0.5);
  }
  chimney(-132, CREST, 100, 3, 30);
  chimney(134, CREST, 96, 3, 26);
  chimney(-6, CREST + 12, 106, 2, 14);
  // Cover across the plaza: low walls and crates, all clear of the lanes and the reactor's ring.
  for (let k = 0, placed = 0; k < 400 && placed < 26; k++) {
    const [x, z] = [r(-140, 140), r(40, 96)];
    const crest = z >= 55 || (x < -2 && z >= 41) || (x > 44 && z >= 36);
    if (!crest || Math.hypot(x, z - REACTOR[2]) < 16 || !offLanes([x, CREST, z], 3, 7) || !roomy(x, CREST, z, 3)) continue;
    const [w, d] = r() < 0.5 ? [r(4, 7), 1] : [r(2, 3), r(2, 3)];
    turned([r3(x), CREST + 0.8, r3(z)], [r3(w / 2), 0.8, r3(d / 2)], r3(r(0, 90)), r() < 0.5 ? 'concrete' : 'metal');
    placed++;
  }
  for (const [x, z] of [[-30, 70], [30, 70], [-14, 92], [14, 92], [-70, 70], [70, 70], [-110, 90], [110, 90]]) if (offLanes([x, CREST, z], 0.5, 4)) lamp([x, CREST, z]);
  rail([0, CREST, 53.3], [42, CREST, 53.3]);
  rail([-150, CREST, 45.3], [SHAFT_UP, CREST, 45.3]);
  rail([SHAFT_UP, CREST, 39.3], [-107, CREST, 39.3]);
  rail([-93, CREST, 39.3], [0, CREST, 39.3]);
  rail([TURN[1], CREST, 34.3], [62, CREST, 34.3]);
  for (let k = 0; k < 5; k++) fungus(r(-140, -110), CREST, r(47, 60), r(0.8, 1.6)); // creeping over the lip
  // The plant's sheds along the Crest's back, their vents steaming.
  for (const [x0, x1] of [[-140, -100], [-84, -50], [36, 70], [92, 140]]) {
    const z0 = r(100, 103);
    if (offLanes([(x0 + x1) / 2, CREST, z0 + 3], (x1 - x0) / 2, 4)) block(x0, z0, x1, 110, CREST, CREST + r3(r(6, 10)), r() < 0.5 ? 'panel' : 'rust');
    decor.push({ kind: 'steam', at: [r3((x0 + x1) / 2), CREST + 11, 106] });
  }
  sign([-7, CREST + 8.5, 97.85], [7, CREST + 10.3, 98], [0, CREST + 6, 92], COLD); // over the hall's door
}
{
  // The Shaft: a lamp on every landing, the lift's number down its core, the Bloom thick at its foot.
  for (let k = 1; k <= 7; k++) {
    const [x, y, z] = corner(k), [sx, sz] = CORNERS[k % 4];
    lamp([r3(x + sx * 5.5), y, r3(z + sz * 5.5)]);
    if (k < 4) fungus(x + sx * 4, y, z + sz * 4, 1.2);
  }
  sign([HC[0] - 1.5, 38, HC[1] - CORE - 0.15], [HC[0] + 1.5, 54, HC[1] - CORE - 0.02], [HC[0], 30, HC[1] - CORE - 6], SICK);
  sign([HC[0] + CORE + 0.02, 74, HC[1] - 1.2], [HC[0] + CORE + 0.15, 86, HC[1] + 1.2], [HC[0] + CORE + 6, 66, HC[1]], RED);
  for (const [x, z] of [[-96, -4], [-104, 12], [-96, 30], [-112, 35], [-130, 35], [-146, 26], [-146, 8], [-146, -12], [-104, -40], [-110, -25], [-90, -35]]) fungus(x, 0, z, 2.5);
  // The Warren: tubes on its rooms' ceilings, flickering cold.
  for (const s of [0, 24, 48, 72]) sign([65, s + 10.6, -11], [81, s + 10.85, -9], [73, s + 6, -10], COLD);
  for (const n of [12, 36, 60]) sign([65, n + 10.6, 28], [81, n + 10.85, 30], [73, n + 6, 29], COLD);
  sign([64, 10.6, -38], [70, 10.85, -36], [67, 6, -37], COLD); // the tunnel
  sign([64, 10.6, -24], [70, 10.85, -22], [67, 6, -23], BLOOM);
}
{
  // The overlooks: rails along their drops (props: a rail stops no shot), a lamp at each, pipes up
  // the galleries' back walls, the Bloom at their low ends.
  const r = rng(61);
  [[-28, 0, 1, 24], [28, 24, -1, 48], [-28, 48, 1, 72]].forEach(([x0, y0, dir, top], k) => {
    const [z, back, y] = [FLIGHTS[k] + 7.3, FLIGHTS[k] + 6.6 + GW, y0 + LIFT];
    rail([x0 - dir * 14, y, z], [x0, y, z]);
    rail([x0, y, z], [GJ[k], top, z]);
    lamp([x0 - dir * 12, y, FLIGHTS[k] + 11]);
    lamp([r3(x0 + dir * 20), r3(y + (20 * 24) / 56), FLIGHTS[k] + 11]);
    pipe([x0 - dir * 6, y, back], [x0 - dir * 6, top + 2, back], 0.35);
    pipe([x0 - dir * 14, y + 5, back], [x0 + dir * 4, y + 5, back], 0.25);
    for (let n = 0; n < 3 - k; n++) fungus(x0 - dir * r(2, 12), y, FLIGHTS[k] + r(10, 12), r(0.8, 1.8));
  });
  rail([-42.3, 24, -31], [-42.3, 24, -25]); // the terrace at 24 over its gallery's end
  rail([-41.7, 48 + LIFT, 25], [-41.7, 48 + LIFT, 31]); // the gallery at 56 over the terrace at 48's wing
  // The gallery over the turn at 72, and the Crest round it.
  rail([TURN[0] + 0.3, 72 + LIFT, TURN[2]], [TURN[0] + 0.3, 72 + LIFT, TURN[3]]);
  rail([TURN[0] + 0.3, 72 + LIFT, TURN[3]], [TURN[0] + 0.3, CREST, TURN[4]]);
  rail([TURN[0], 72 + LIFT, TURN[2] + 0.3], [TURN[1], 72 + LIFT, TURN[2] + 0.3]);
  rail([TURN[1] + 0.3, CREST, TURN[2]], [TURN[1] + 0.3, CREST, TURN[4]]);
  lamp([46.5, 72 + LIFT, 39.5]);
  pipe([47.6, 72 + LIFT, 36], [47.6, CREST + 2, 36], 0.35);
  // The Shaft's: the lower along the north wall and round onto the east, the upper.
  const z = HC[1] + 28.3;
  rail([-150, 24 + LIFT, z], [-135, 24 + LIFT, z]);
  rail([-135, 24 + LIFT, z], [-107, 36 + LIFT, z]);
  rail([-107, 36 + LIFT, z], [-93, 36 + LIFT, z]);
  rail([-92.7, 36 + LIFT, 39], [-92.7, 36 + LIFT, EAST_LEDGE]);
  rail([-86.7, 48, 39], [-86.7, 48, EAST_LEDGE]); // the wing over it
  rail([-150, 72 + LIFT, z], [-135, 72 + LIFT, z]);
  rail([-135, 72 + LIFT, z], [SHAFT_UP, CREST, z]);
  for (const [x, y, zz] of [[-148, 24 + LIFT, 44], [-90, 36 + LIFT, 43], [-89, 36 + LIFT, 14], [-148, 72 + LIFT, 44]]) lamp([x, y, zz]);
  for (const [x, y, zz, rad] of [[-146, 24, 42.5, 2], [-140, 24, 43.5, 1.4], [-100, 36, 43, 1], [-90, 36, 22, 1.2], [-144, 72, 43, 1]]) fungus(x, y + LIFT, zz, rad);
  // The block at 12's edge over the Shaft's foot.
  rail([-114.3, 12, FACE], [-114.3, 12, -17]);
  lamp([-117, 12, -43]);
}
{
  // The Workings: ore carts on the floor, and the Bloom over everything down here.
  const r = rng(91);
  for (let k = 0, n = 0; k < 60 && n < 10; k++) {
    const [x, z] = [r(-140, 140), r(-94, -72)];
    if (GATES.some((g) => Math.abs(x - g) < 14)) continue;
    turned([r3(x), WORK + 1, r3(z)], [1.2, 1, 2], r3(r(0, 180)), r() < 0.5 ? 'rust' : 'metal');
    n++;
  }
  for (let k = 0; k < 40; k++) {
    const [x, z] = [r(-146, 146), r(-98, -70)];
    if (GATES.every((g) => Math.abs(x - g) > 9)) fungus(x, WORK, z, r(2, 4.5));
  }
  for (const g of GATES) for (const s of [-1, 1]) fungus(g + s * 5, WORK, -103, 2.5), fungus(g + s * 10, WORK, -94, 3.5);
}

// --- Pads ------------------------------------------------------------------------------------------------
// Pilots' ways back up: Low Town onto the terraces at 24 and 12, and a chain up the Stair's middle,
// 24 -> 48 -> 72 -> the Crest, and the east ledge onto the strip at 72.
for (const [from, to, apex] of PADS) pad(from, to, apex);

// --- Waypoints, spawns, write ---------------------------------------------------------------------------
point([0, CREST, 95]); // the first, by the spawns
along(['W0', 'W1', 'W2']);
along(['M0', 'M1', 'M2']);
along(['E0', 'E1', 'E2']);
along([...STAIR, 'R']);
along(['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'HX']);
along(WARREN.slice(1), 30);
along(['a84', 'WT']);
along(['A72', 'K1', 'K2']);
grid(-148, -98, 148, -70, WORK, 18); // the Workings
grid(-148, -66, 148, -47, 0, 16); // Low Town
grid(-148, -43, -116, -19, 12); // the block at 12 by the Shaft
grid(-112, -43, -88, -19, 0); // the Shaft's foot
grid(-84, -43, -44, -33, 24); // the terrace at 24
grid(-84, -25, 26, -19, 24);
grid(44, -43, 148, -19, 24); // the east ledge at 24
grid(-85, -15, -44, 37, 48); // the terrace at 48
grid(-26, 4, 40, 10, 48);
grid(-40, 31, 26, 37, 72); // the terrace at 72
grid(44, -15, 60, 32, 72); // the strip
grid(-148, 41, -2, 108, CREST, 18); // the Crest
grid(-2, 55, 148, 108, CREST, 18);
grid(44, 36, 148, 53, CREST, 18);
grid(86, -15, 148, 34, CREST, 18);
// The overlooks: along each gallery 2 m in from its edge, over its landing and up along its flight;
// along the Shaft's ledges, and on its ramps by where each meets them.
[[-28, 0, 1], [28, 24, -1], [-28, 48, 1]].forEach(([x0, y0, dir], k) => {
  const z = FLIGHTS[k] + 9;
  for (const t of [-10, -4]) point([x0 + dir * t, y0 + LIFT, z]);
  for (let t = 6; t < Math.abs(GJ[k] - x0) - 2; t += 9) point([x0 + dir * t, r3(y0 + LIFT + (t * 24) / 56), z]);
});
point([44, 72 + LIFT, 36], [44, 72 + LIFT, 39.5], [44, r3(72 + LIFT + (5 * 24) / 56), 46]); // over the turn at 72
for (const y of [24, 72]) {
  for (const x of [-145, -139]) point([x, y + LIFT, 41]);
  for (let x = -131; x < (y < 72 ? -107 : -127); x += 9) point([x, r3(y + LIFT + ((x + 135) * 12) / 28), 41]);
}
for (const z of [41, 33, 24, 15]) point([z > 39 ? -99 : -91, 36 + LIFT, z]);
point([-97, r3(36 + ((25 - 5) * 12) / 28), 5]); // on the ramp, by where the lower gallery meets it
for (const z of [-41, -31, -21]) point([-116.5, 12, z]); // the block at 12's edge, over the Shaft's foot
for (const [g, side] of DOCKS) point([g + side * 17, LIFT, -66], [g + side * 22, LIFT, -64.5], [g + side * 34, r3(((DOCK[2] - 34) * LIFT) / (DOCK[2] - DOCK[1])), -65.25]);
// Round the Shaft's core at its foot.
for (const p of [[-100, 0, 4], [-100, 0, 20], [-100, 0, 32], [-121, 0, 32], [-142, 0, 32], [-142, 0, 15], [-142, 0, -6]]) point(p);

// The hive's side (its infested mechs come out of the gates anyway): two in each mine mouth.
const infested = GATES.flatMap((g) => [[g - 3, WORK + 0.1, -106], [g + 3, WORK + 0.1, -106]]);
// Night in the canyon: the sky a dull rust over black, the Bloom's glow on the haze low in the
// Workings, spores drifting up out of it, windows lit up the Stack.
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
  water: { level: -11.4, color: '#2a1a10', opacity: 0.85 },
  motes: [{ color: [[1, 0.55, 0.15], [1, 0.35, 0.05]], rate: 60, size: 0.18, drift: 0.4, rise: 0.6, life: 7 }],
  ambience: 'hive',
};
console.log(`lanes: ${lanePoints.length} points, ${edges.length} edges (${narrow.length} narrow)`);
write(new URL('./hivecanyon.json', import.meta.url), { name: 'Hive Canyon', size: SIZE, night: true, palette }, SPAWNS, infested);
