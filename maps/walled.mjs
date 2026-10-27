// Walled City (grey-box): a 384 x 256 m city stacked 100 m deep on both sides of a gorge, the
// gorge crossed by the city itself again and again at every height. The west half is the wealthy
// one and the east the tenements (that's for the dressing; the grey-box gives both the same
// routes). Writes walled.json next to this file; rerun `node maps/walled.mjs` after editing.
//
// The city is planned as a grid of 16 m cells on nine levels 12 m apart (floors at 0-96), each cell
// solid building, floor (walkable, 11 m of headroom under the floor above) or void (shafts, wells,
// the gorge), and built in lots, each turned to its own street line (see `warp`). Levels are carved into alleys and halls; light wells and courtyards open them to the sky;
// switchback ramp slots climb the full height; pad shafts throw you up two floors; anything open
// drops you down (no fall damage). The gorge (the two middle columns) is crossed by: the Wall at
// the centre (the city spanning it at every level round a central well), straight bridge blocks
// at several heights, a pair of diagonal blocks crossing in an X at one level with another block
// passing over them, the monorail's two bridges, and the canal along its floor. A last pass turns
// any floor you couldn't get back out of into building.
//
// Only the west half (columns 0-11) is authored; `write` (maps/kit.mjs) adds its 180-degree twin.
// Game modes: Missile Assault (A in the west courtyard, B on the canal at the foot of the Wall's well, C the twin of A);
// Capture the Flag (each team's flag stand in its spawn hall's back corner); Convoy (along the
// monorail ring's south side at level 5, over the gorge on its bridge, base to base, jogging as it does).
import { bases, box, convoy, cylinder, decor, flags, flagStand, nav, objectives, pad, pads, point, r3, ramp, sentries, silos, solids, turned, write } from './kit.mjs';

const CELL = 16, STORY = 12, LEVELS = 9; // floors at 0, 12, ... 96
const NI = 24, NJ = 16, W = NI * CELL, D = NJ * CELL; // 384 x 256 m
const HALF = 12, GORGE = 11, FACE = 10; // columns authored; the gorge's west column; the face over it
const SOLID = 0, FLOOR = 1, VOID = 2;
const X = (i) => -W / 2 + i * CELL, Z = (j) => -D / 2 + j * CELL; // a cell's min corner
const cx = (i) => X(i) + CELL / 2, cz = (j) => Z(j) + CELL / 2;
const Y = (L) => L * STORY;

// The west half's cells, [L][i][j]; east cells read as their twins.
const grid = Array.from({ length: LEVELS }, () => Array.from({ length: HALF }, () => Array(NJ).fill(SOLID)));
const twin = (i, j) => [NI - 1 - i, NJ - 1 - j];
const inside = (i, j, L) => i >= 0 && i < NI && j >= 0 && j < NJ && L >= 0 && L < LEVELS;
function get(i, j, L) {
  if (!inside(i, j, L)) return SOLID;
  if (i >= HALF) [i, j] = twin(i, j);
  return grid[L][i][j];
}
function set(i, j, L, s) {
  if (!inside(i, j, L)) return;
  if (i >= HALF) [i, j] = twin(i, j);
  grid[L][i][j] = s;
}
/** Seeded random in [lo, hi), one stream per use. */
const rng = (seed) => (lo = 0, hi = 1) => lo + (hi - lo) * (((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
const rand = rng(20261025);
const pick = (lo, hi) => Math.floor(rand(lo, hi + 1));

// --- The hill: rock under the city, rising away from the gorge -----------------------------------
const ground = (i) => Math.max(0, Math.ceil((9 - i) / 3)); // lowest open level in column i (west half)
const open = (i, j, L, s = FLOOR) => {
  const ii = i >= HALF ? twin(i, j)[0] : i;
  if (ii !== GORGE && L < ground(ii)) return;
  set(i, j, L, s);
};

// --- The gorge, the canal on its floor, the docks along it ----------------------------------------
for (let j = 0; j < NJ; j++) {
  set(GORGE, j, 0, FLOOR);
  for (let L = 1; L < LEVELS; L++) set(GORGE, j, L, VOID);
  set(FACE, j, 0, FLOOR);
}

// --- Each level: short balconies over the gorge, alleys winding in from them, a hall ---------------
// Alleys are random walks that turn often, so no lane runs straight for long. The roofs are carved
// the same way, out of a roofscape of towers.
const STEP = [[1, 0], [0, 1], [-1, 0], [0, -1]];
function wander(i, j, L, steps, dir = pick(0, 3)) {
  for (let s = 0; s < steps; s++) {
    open(i, j, L);
    if (rand() < 0.45) dir = (dir + (rand() < 0.5 ? 1 : 3)) % 4;
    let [a, b] = [i + STEP[dir][0], j + STEP[dir][1]];
    if (a < 0 || a > FACE || b < 0 || b >= NJ) {
      dir = (dir + 2) % 4;
      [a, b] = [i + STEP[dir][0], j + STEP[dir][1]];
    }
    [i, j] = [a, b];
  }
}
for (let L = 1; L < LEVELS; L++) {
  for (let j = 0; j < NJ; j++) if ((j + 3 * L) % 6 < 2) open(FACE, j, L);
  for (let k = 0; k < 2; k++) wander(FACE, pick(0, NJ - 1), L, pick(5, 9), 2); // in from the gorge
  for (let k = 0; k < 2; k++) wander(pick(1, 8), pick(1, 14), L, pick(5, 9));
  const i0 = pick(1, 7), j0 = pick(0, 13);
  for (let i = i0; i < i0 + 2; i++) for (let j = j0; j < j0 + 2; j++) open(i, j, L);
}

// --- Spawn halls (level 4, roofed, deep in each half), their ways out ------------------------------
// Its base (where missiles land, the convoy's end) is on the monorail ring over it; its flag stand
// is out where its ways out meet, 60 m on toward the gorge, so defenders have to run to it.
const SPAWN = 4, FLAG = [6, 7], RAIL = 5;
for (let i = 0; i <= 3; i++) {
  for (let j = 5; j <= 9; j++) {
    open(i, j, SPAWN);
    set(i, j, SPAWN + 1, SOLID);
  }
}
for (const row of [6, 9]) wander(4, row, SPAWN, 10, 0); // ways out, winding toward the gorge
open(FLAG[0], FLAG[1], SPAWN);

// --- Light wells and courtyards: open to the sky from their floor, galleries round them ----------
const WELLS = [
  { i: 3, j: 3, w: 2, d: 2, floor: 3 }, // Missile Assault's A
  { i: 6, j: 11, w: 2, d: 2, floor: 5 },
  { i: 7, j: 5, w: 1, d: 1, floor: 2 },
];
for (const { i, j, w, d, floor } of WELLS) {
  for (let L = floor; L < LEVELS; L++) {
    for (let a = i - 1; a <= i + w; a++) for (let b = j - 1; b <= j + d; b++) open(a, b, L); // galleries
    for (let a = i; a < i + w; a++) for (let b = j; b < j + d; b++) set(a, b, L, L === floor ? FLOOR : VOID);
  }
}

// --- The Wall: the city spanning the gorge at every level round a central well ---------------------
// Rows 6-9 of the gorge's columns; the well (rows 7-8 of both columns, with the twin) is 32 m square
// and open from the canal to the sky, every level looking down it, with Missile Assault's B on the
// canal at its foot; galleries cross either side of it, solid every third level, walled on their
// gorge sides on most (so no view runs the gorge's length).
for (let L = 1; L < LEVELS; L++) {
  for (const j of [7, 8]) set(GORGE, j, L, VOID);
  for (const j of [6, 9]) set(GORGE, j, L, L % 3 === 0 ? SOLID : FLOOR);
  for (let j = 6; j <= 9; j++) open(FACE, j, L);
}

// --- Straight bridge blocks across the gorge: each at row j and its twin row (15 - j) --------------
// `shut` ones are walled along the gorge, enclosed; the rest open-sided.
const BRIDGES = [
  { j: 12, levels: [6, 7], shut: true }, // a two-storey hall over the X
  { j: 14, levels: [1, 2] }, // low and open, near the canal
  { j: 10, levels: [8] }, // a roof bridge
  { j: 14, levels: [5], shut: true }, // the monorail's (the ring's north and south legs)
  { j: 11, levels: [4], shut: true }, // a block between the X and the hall
];
for (const { j, levels } of BRIDGES) {
  for (const L of levels) {
    for (const row of [j, NJ - 1 - j]) {
      set(GORGE, row, L, FLOOR);
      open(FACE, row, L);
    }
  }
}

// --- The monorail: a ring at level 5 round the city, through its buildings ------------------------
// It jogs out to the city's edge and back on every side, so no stretch of it runs straight for more
// than six cells (with the twin's, across the gorge too).
const RING = [];
const run = (i0, j0, i1, j1) => {
  for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) for (let j = Math.min(j0, j1); j <= Math.max(j0, j1); j++) RING.push([i, j]);
};
run(10, 1, 8, 1), run(8, 0, 4, 0), run(4, 1, 1, 1); // south
run(1, 1, 1, 5), run(0, 5, 0, 10), run(1, 10, 1, 14); // west, past the base
run(1, 14, 6, 14), run(6, 15, 10, 15), run(10, 14, 10, 14); // north
for (const [i, j] of RING) open(i, j, RAIL);

// --- Switchback ramp slots: 4 cells long, the middle two open the full height ---------------------
// Flights 32 m long climb a level each (21 degrees), in two 8 m lanes taking turns, landing on the
// end cells: the south end at even steps, the north at odd.
const SLOTS = [
  { i: 9, j: 1, from: 0 },
  { i: 3, j: 10, from: 2 }, // right outside the spawn hall
  { i: 8, j: 11, from: 1 }, // (the hill's floor here)
];
for (const { i, j, from } of SLOTS) {
  for (let L = from; L < LEVELS; L++) {
    for (const b of [j + 1, j + 2]) set(i, b, L, L === from ? FLOOR : VOID);
    open(i, (L - from) % 2 ? j + 3 : j, L);
    open(i - 1, (L - from) % 2 ? j + 3 : j, L); // a way off each landing
  }
}

// --- Pad shafts: a pad on a floor throws you up two levels to the floor beside the shaft -----------
const SHAFTS = [
  { i: 6, j: 2, L: 3, to: [0, -1] }, // up onto the monorail
  { i: 9, j: 9, L: 1, to: [0, 1] },
  { i: 4, j: 13, L: 4, to: [0, 1] },
  { i: 7, j: 11, L: 2, to: [1, 0] },
  { i: 6, j: 4, L: 5, to: [-1, 0] },
  // A pad in each courtyard's floor, up onto its galleries: the way out of it.
  { i: 3, j: 3, L: 3, to: [-1, 0] },
  { i: 6, j: 11, L: 5, to: [-1, 0] },
  { i: 7, j: 5, L: 2, to: [0, 1] },
];
for (const { i, j, L, to } of SHAFTS) {
  open(i, j, L);
  open(i - to[0], j - to[1], L); // a way in at the bottom
  set(i, j, L + 1, VOID);
  set(i, j, L + 2, VOID);
  open(i + to[0], j + to[1], L + 2);
}

// The canal's blocks, [x0, z0, x1, z1, turn] (9 m tall, turned `turn` degrees off their lot), and the
// gorge's bays ({ j, L, out, turn }: out from the west face at row j, level L, askew); all clear of
// the crossings, the Wall, the X and the convoy's ring.
const CANAL = [
  [X(GORGE), Z(5), X(GORGE) + 11, Z(6), 12],
  [X(GORGE) + 9, Z(12), X(GORGE + 1), Z(13), -4], // (clear of the dock stairs beside it)
  [X(FACE), Z(1) + 4, X(FACE) + 12, Z(2) + 4, 15], // on the docks
  [X(FACE) + 2, Z(9) + 8, X(FACE) + 14, Z(10) + 8, -10],
  [X(GORGE) + 8, Z(7) - 4, X(GORGE + 1), Z(8) - 4, 6], // at the foot of the Wall's well (cover round B)
  [X(GORGE) + 2, Z(14) + 8, X(GORGE) + 14, Z(15) + 4, -14],
];
const BAYS = [
  { j: 0, L: 1, out: 12, turn: 10 }, { j: 11, L: 1, out: 8, turn: -12 },
  { j: 4, L: 2, out: 10, turn: -8 }, { j: 12, L: 2, out: 12, turn: 12 },
  { j: 2, L: 4, out: 12, turn: -10 }, { j: 13, L: 4, out: 10, turn: 8 },
  { j: 4, L: 5, out: 12, turn: 6 }, { j: 11, L: 5, out: 12, turn: -6 }, // over the level-4 bridges, across the courtyards' line
  { j: 2, L: 7, out: 10, turn: 12 }, { j: 13, L: 7, out: 12, turn: -10 },
];
// Footbridges slung across the gorge at odd angles, { L, a, b }: from the west face's floor at z = a
// to the east face's at z = b, level L, between the crossings at that level (the twin adds another).
const FOOTBRIDGES = [{ L: 6, a: 38, b: 58 }, { L: 8, a: 104, b: 72 }];
// Ways up out of the canal (the twin adds the east face's): dock stairs, ramps along the west face
// from the canal at row `foot` up onto the low bridge at row `bridge` (level 1), climbing rows
// `from` to `to`; and pads on the canal's floor at row `j` throwing you onto the face's floor at level `L`.
const DOCK_STAIRS = [{ foot: 11, from: Z(12), to: Z(14), bridge: 14 }, { foot: 4, from: Z(4), to: Z(2), bridge: 1 }];
const CANAL_PADS = [{ j: 10, L: 2 }];
for (const { j, L } of CANAL_PADS) open(FACE, j, L);
const rowAt = (z) => Math.floor((z + D / 2) / CELL);
for (const { L, a, b } of FOOTBRIDGES) open(FACE, rowAt(a), L), open(NI - 1 - FACE, rowAt(b), L);

// --- The diagonal X: two blocks crossing the gorge at level 3, meeting mid-gorge ------------------
// (Geometry below; here, the floors they land on.) Its twin crosses south of the Wall.
const X_LEVEL = 3, X_ROWS = [10, 14];
for (const j of X_ROWS) for (const row of [j, NJ - 1 - j]) open(FACE, row, X_LEVEL);

// --- Settle: a void resting on building is floor; then keep only floors you can get back from ------
function standable(i, j, L) {
  return get(i, j, L) === FLOOR;
}
function settle() {
  for (let L = 1; L < LEVELS; L++) for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) if (grid[L][i][j] === VOID && grid[L - 1][i][j] === SOLID) grid[L][i][j] = FLOOR;
}
const key = (i, j, L) => (L * NI + i) * NJ + j;
function links() {
  const out = new Map(), add = (a, b) => {
    const k = key(...a);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(b);
  };
  for (let L = 0; L < LEVELS; L++) {
    for (let i = 0; i < NI; i++) {
      for (let j = 0; j < NJ; j++) {
        if (!standable(i, j, L)) continue;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [a, b] = [i + di, j + dj];
          if (standable(a, b, L)) add([i, j, L], [a, b, L]);
          else if (get(a, b, L) === VOID) {
            // Off the edge: down to the first floor under it.
            let M = L - 1;
            while (M >= 0 && get(a, b, M) === VOID) M--;
            if (M >= 0 && standable(a, b, M)) add([i, j, L], [a, b, M]);
          }
        }
      }
    }
  }
  for (const { i, j, L, to } of SHAFTS) {
    for (const [p, q] of [[[i, j, L], [i + to[0], j + to[1], L + 2]], [twin(i, j).concat(L), [...twin(i + to[0], j + to[1]), L + 2]]]) add(p, q);
  }
  for (const { i, j, from } of SLOTS) {
    for (const [a, b] of [[i, j], twin(i, j)]) {
      const s = a === i ? 1 : -1; // the twin's slot runs the other way
      for (let L = from; L < LEVELS - 1; L++) {
        const lo = [a, (L - from) % 2 ? b + 3 * s : b, L], hi = [a, (L - from) % 2 ? b : b + 3 * s, L + 1];
        add(lo, hi);
        add(hi, lo);
      }
    }
  }
  for (const { foot, bridge } of DOCK_STAIRS) {
    for (const [u, v] of [[[GORGE, foot, 0], [GORGE, bridge, 1]], [[...twin(GORGE, foot), 0], [...twin(GORGE, bridge), 1]]]) add(u, v), add(v, u);
  }
  for (const { j, L } of CANAL_PADS) add([GORGE, j, 0], [FACE, j, L]), add([...twin(GORGE, j), 0], [...twin(FACE, j), L]);
  for (const { L, a, b } of FOOTBRIDGES) {
    const [p, q] = [[FACE, rowAt(a)], [NI - 1 - FACE, rowAt(b)]];
    for (const [u, v] of [[p, q], [twin(...p), twin(...q)]]) add([...u, L], [...v, L]), add([...v, L], [...u, L]);
  }
  // The X: its four ends all meet in the middle (and its twin's).
  for (const ends of [[[FACE, X_ROWS[0]], [NI - 1 - FACE, X_ROWS[1]], [FACE, X_ROWS[1]], [NI - 1 - FACE, X_ROWS[0]]]]) {
    for (const e of [ends, ends.map(([a, b]) => twin(a, b))]) for (const p of e) for (const q of e) if (p !== q) add([...p, X_LEVEL], [...q, X_LEVEL]);
  }
  return out;
}
function reachable(from, out, reverse) {
  const seen = new Set([key(...from)]), stack = [from];
  const back = new Map();
  if (reverse) for (const [k, list] of out) for (const q of list) {
    const kq = key(...q);
    if (!back.has(kq)) back.set(kq, []);
    back.get(kq).push(k);
  }
  const decode = (k) => [Math.floor(k / NJ) % NI, k % NJ, Math.floor(k / NJ / NI)];
  while (stack.length) {
    const p = stack.pop(), next = reverse ? (back.get(key(...p)) ?? []).map(decode) : out.get(key(...p)) ?? [];
    for (const q of next) {
      const k = key(...q);
      if (!seen.has(k)) seen.add(k), stack.push(q);
    }
  }
  return seen;
}
const HOME = [2, 7, SPAWN];
for (let pass = 0; pass < 4; pass++) {
  settle();
  const out = links(), there = reachable(HOME, out, false), back = reachable(HOME, out, true);
  let cut = 0;
  for (let L = 0; L < LEVELS; L++) for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
    const k = key(i, j, L);
    if (grid[L][i][j] === FLOOR && !(there.has(k) && back.has(k))) grid[L][i][j] = SOLID, cut++;
  }
  if (!cut) break;
}

// --- The lots: the city as it was built, block by block, each squared to its own street line ------
// The grid above is the plan; what's built on it turns. Each lot (a run of whole cells) is turned a
// few degrees about its middle and nudged, and blends into its neighbours across 24 m, so buildings
// fan out round the seams and the streets between lots run as wedges. The turn fades out toward the
// city's outer wall (its outermost cells stand square to it) and the gorge's middle (where the twin's
// city meets this one). Columns of lots over cells [i0, i1), each split into rows [j0, j1, degrees,
// dx, dz].
const LOTS = [
  { i: [0, 4], rows: [[0, 5, 5, 1, 0], [5, 10, -4, 0, 1], [10, 16, 6, -1, 0]] },
  { i: [4, 7], rows: [[0, 4, -6, 0, -1], [4, 9, 7, 1, 0], [9, 13, -5, 0, 1], [13, 16, 4, 0, 0]] },
  { i: [7, 12], rows: [[0, 6, 6, 0, 1], [6, 11, -5, -1, 0], [11, 16, 7, 0, -1]] },
];
const BLEND = 12; // half the width a lot blends into the next across
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** A lot's share at `v` along one axis, the lot spanning [a, b] of the whole [lo, hi]. */
const share = (v, a, b, lo, hi) => (a > lo ? ease((v - a + BLEND) / (2 * BLEND)) : 1) * (b < hi ? 1 - ease((v - b + BLEND) / (2 * BLEND)) : 1);
/** How much of the lots' turn the plan's point (x, z) in the west half takes: none by the outer wall or the gorge's middle. */
const fadeAt = (x, z) => ease((Math.min(x + W / 2, z + D / 2, D / 2 - z) - CELL) / (2 * CELL)) * ease(-x / 24);
/** Where the plan's point (x, z) in the west half stands, built. */
function warp(x, z) {
  const fade = fadeAt(x, z);
  if (!fade) return [x, z];
  let dx = 0, dz = 0;
  for (const { i: [i0, i1], rows } of LOTS) {
    const wx = share(x, X(i0), X(i1), -W / 2, 0);
    if (wx) for (const [j0, j1, turn, tx, tz] of rows) {
      const w = wx * share(z, Z(j0), Z(j1), -D / 2, D / 2), t = (turn * Math.PI) / 180;
      const [px, pz] = [(X(i0) + X(i1)) / 2, (Z(j0) + Z(j1)) / 2], [u, v] = [x - px, z - pz];
      dx += w * (px + u * Math.cos(t) - v * Math.sin(t) + tx - x);
      dz += w * (pz + u * Math.sin(t) + v * Math.cos(t) + tz - z);
    }
  }
  return [x + fade * dx, z + fade * dz];
}
/** The one rigid frame the plan's point (x, z) is built in: 'plan' (unturned), a lot's 'column.row', or null (between frames). */
function frameAt(x, z) {
  const fade = fadeAt(x, z);
  if (!fade) return 'plan';
  if (fade < 1) return null;
  const hits = [];
  LOTS.forEach(({ i: [i0, i1], rows }, c) => rows.forEach(([j0, j1], r) => {
    const w = share(x, X(i0), X(i1), -W / 2, 0) * share(z, Z(j0), Z(j1), -D / 2, D / 2);
    if (w) hits.push(w === 1 ? `${c}.${r}` : null);
  }));
  return hits.length === 1 ? hits[0] : null;
}
/** A cell's rigid frame, if all of it stands in one (its building can merge with its neighbours'), else null. */
function frameOf(i, j) {
  const f = [frameAt(X(i), Z(j)), frameAt(X(i + 1), Z(j)), frameAt(X(i), Z(j + 1)), frameAt(X(i + 1), Z(j + 1))];
  return f.every((g) => g !== null && g === f[0]) ? f[0] : null;
}
const frames = Array.from({ length: HALF }, (_, i) => Array.from({ length: NJ }, (_, j) => frameOf(i, j)));
/** Either half's plan point, built: the east half is the west's twin. */
const built = (x, z) => (x <= 0 ? warp(x, z) : warp(-x, -z).map((v) => -v));
const deg = (r) => (r * 180) / Math.PI;
/** The plan's point [x, y, z], built. */
const at = (x, y, z) => {
  const [u, v] = built(x, z);
  return [r3(u), y, r3(v)];
};
/** The yaw (degrees) of the plan's +Z at (x, z), built: how far a box squared to the plan there turns. */
const yawAt = (x, z) => {
  const [a, b] = [built(x, z - 1), built(x, z + 1)];
  return deg(Math.atan2(b[0] - a[0], b[1] - a[1]));
};
/**
 * A box over the plan's rectangle (x0, z0)-(x1, z1), y0 to y1, built, squared to its lot. A cell
 * built across a seam isn't quite square, so each side either stays inside it (`out[side]` false:
 * nothing pokes past it, into a ramp's top or a shaft) or reaches past it, `grow` m beyond its
 * furthest corner (true: over the crack to the neighbour); sides in order west, east, south, north.
 * With `out` null, the box takes the cell's mean size, grown `grow`, turned `turn` degrees more.
 */
function quad(x0, z0, x1, z1, y0, y1, mat, { out = [false, false, false, false], grow = 0, turn = 0, color } = {}) {
  const [a, b, c, d] = [built(x0, z0), built(x1, z0), built(x1, z1), built(x0, z1)];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const [s, n, w, e] = [mid(a, b), mid(d, c), mid(a, d), mid(b, c)], o = mid(s, n);
  const yaw = Math.atan2(n[0] - s[0], n[1] - s[1]) + (turn * Math.PI) / 180;
  const [ux, uz] = [[Math.cos(yaw), -Math.sin(yaw)], [Math.sin(yaw), Math.cos(yaw)]];
  let lx = [-len(w, e) / 2 - grow, len(w, e) / 2 + grow], lz = [-len(s, n) / 2 - grow, len(s, n) / 2 + grow];
  if (out) {
    const on = (p, u) => (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1];
    const side = (p, q, u, low, far) => (far ? (low ? Math.min : Math.max)(on(p, u), on(q, u)) + (low ? -grow : grow) : (low ? Math.max : Math.min)(on(p, u), on(q, u)));
    lx = [side(a, d, ux, true, out[0]), side(b, c, ux, false, out[1])];
    lz = [side(a, b, uz, true, out[2]), side(d, c, uz, false, out[3])];
  }
  const [mx, mz] = [(lx[0] + lx[1]) / 2, (lz[0] + lz[1]) / 2];
  const at = [o[0] + ux[0] * mx + uz[0] * mz, o[1] + ux[1] * mx + uz[1] * mz];
  turned([r3(at[0]), r3((y0 + y1) / 2), r3(at[1])], [r3((lx[1] - lx[0]) / 2), r3((y1 - y0) / 2), r3((lz[1] - lz[0]) / 2)], r3(deg(yaw)), mat);
  if (color) solids[solids.length - 1].color = color;
}
/** A wall `t` thick along the plan's line (x0, z0)-(x1, z1), y0 to y1, built. */
function wall(x0, z0, x1, z1, y0, y1, mat, t = 1) {
  const [a, b] = [built(x0, z0), built(x1, z1)], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  turned([r3((a[0] + b[0]) / 2), r3((y0 + y1) / 2), r3((a[1] + b[1]) / 2)], [t / 2, r3((y1 - y0) / 2), r3(len / 2 + 0.3)], r3(deg(Math.atan2(b[0] - a[0], b[1] - a[1]))), mat);
}
{
  // How far the lots stretch the plan: each cell's sides, built, and its turn.
  let lo = Infinity, hi = 0, most = 0;
  for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
    const [a, b, d] = [built(X(i), Z(j)), built(X(i + 1), Z(j)), built(X(i), Z(j + 1))];
    for (const l of [Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(d[0] - a[0], d[1] - a[1])]) lo = Math.min(lo, l), hi = Math.max(hi, l);
    most = Math.max(most, Math.abs(yawAt(cx(i), cz(j))));
  }
  console.log(`lots: cells ${lo.toFixed(1)}-${hi.toFixed(1)} m a side, turned up to ${most.toFixed(1)} degrees`);
}

if (grid[SPAWN][FLAG[0]][FLAG[1]] !== FLOOR) throw new Error('the flag stand\'s cell was cut off');
// Each building's own walls: the west's painted plaster, the east's faded tile and stained concrete.
const WEST_WALLS = ['#c4a27a', '#d2bc96', '#b98a6c', '#c9b48a', '#a99a7a', '#c79a7e', '#b7a789', '#d8c4a4'];
const EAST_WALLS = ['#6f736a', '#6a7378', '#7f8a7e', '#857d6e', '#8a8a84', '#5f6862', '#7a6f6a', '#6e8088'];
/** A stable random in [0, 1) for whatever stands at (a, b, c). */
const hue = (a, b, c = 0) => {
  const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return h - Math.floor(h);
};
const wallOf = (list, a, b, c) => list[Math.floor(hue(a, b, c) * list.length)];
// The height of each tower's roof (where building reaches the top), for what's put up on them.
const tops = Array.from({ length: HALF }, () => Array(NJ).fill(undefined));
for (const { j, L } of CANAL_PADS) if (grid[L][FACE][j] !== FLOOR) throw new Error(`the canal pad at row ${j} has nowhere to land`);

// --- Geometry: building masses, floor slabs where nothing's under them --------------------------
// Building, the gorge's columns too (where the Wall and the bridges stand). Inside a lot's rigid
// middle (or the unturned ring by the outer wall), solid cells merge into blocks as big as they'll go;
// across a seam each cell's stack is its own mass, inside its cell (so a crack between buildings), a
// metre short of any floor on it. A floor slab under every walkable cell that isn't on a block, out
// over the cracks to the floor or building beside it but not past its edge over a drop (a shaft, a
// well, a ramp slot). The roofs' towers rise a level higher, or more: each built as far as its owner could.
{
  const done = new Set();
  for (let L = 0; L < LEVELS; L++) for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
    const f = frames[i][j];
    if (grid[L][i][j] !== SOLID || done.has(key(i, j, L))) continue;
    if (f === null) {
      let L1 = L;
      while (L1 + 1 < LEVELS && grid[L1 + 1][i][j] === SOLID) L1++;
      for (let c = L; c <= L1; c++) done.add(key(i, j, c));
      quad(X(i), Z(j), X(i + 1), Z(j + 1), Y(L), Y(L1 + 1) - (grid[L1 + 1]?.[i][j] === FLOOR ? 1 : 0), 'plaster', { grow: 0.05, color: wallOf(WEST_WALLS, i, j, L) });
      continue;
    }
    const free = (a, b, c) => a < HALF && b < NJ && c < LEVELS && frames[a][b] === f && grid[c][a][b] === SOLID && !done.has(key(a, b, c));
    let i1 = i, j1 = j, L1 = L;
    while (free(i1 + 1, j, L)) i1++;
    const rowOk = (b) => { for (let a = i; a <= i1; a++) if (!free(a, b, L)) return false; return true; };
    while (rowOk(j1 + 1)) j1++;
    const layerOk = (c) => { for (let a = i; a <= i1; a++) for (let b = j; b <= j1; b++) if (!free(a, b, c)) return false; return true; };
    while (layerOk(L1 + 1)) L1++;
    for (let c = L; c <= L1; c++) for (let a = i; a <= i1; a++) for (let b = j; b <= j1; b++) done.add(key(a, b, c));
    quad(X(i), Z(j), X(i1 + 1), Z(j1 + 1), Y(L), Y(L1 + 1), 'plaster', { grow: 0.05, color: wallOf(WEST_WALLS, i, j, L) });
  }
  const storeys = rng(31);
  for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
    // A storey or three more, now and then a tower well over the rest.
    const up = 4 * Math.floor(storeys(0, 4)) + (storeys() < 0.1 ? 8 + 4 * Math.floor(storeys(0, 3)) : 0);
    if (i !== GORGE && grid[LEVELS - 1][i][j] === SOLID) {
      tops[i][j] = Y(LEVELS) + up;
      if (up) quad(X(i), Z(j), X(i + 1), Z(j + 1), Y(LEVELS), Y(LEVELS) + up, 'plaster', { grow: 0.05, color: wallOf(WEST_WALLS, i, j, 99) });
    }
    for (let L = 0; L < LEVELS; L++) {
      if (grid[L][i][j] !== FLOOR || (L && grid[L - 1][i][j] === SOLID && frames[i][j] !== null)) continue;
      const out = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([di, dj]) => get(i + di, j + dj, L) !== VOID);
      quad(X(i), Z(j), X(i + 1), Z(j + 1), Y(L) - 1, Y(L), 'terracotta', { out, grow: frames[i][j] === null ? 0.3 : 0 });
    }
  }
  let rigid = 0;
  for (const col of frames) for (const f of col) rigid += f !== null;
  console.log(`lots: ${rigid} of ${HALF * NJ} cells rigid`);
}
// The edges: the hill's foot under the canal, walls round the map.
box([-W / 2, -2, -D / 2], [0, -1, D / 2], 'ground'); // (where the haze lies)
box([W / 2, -2, -D / 2], [W / 2 + 1, Y(LEVELS) + 12, D / 2], 'stone');
box([-W / 2, -2, D / 2], [W / 2, Y(LEVELS) + 12, D / 2 + 1], 'stone');

// Walls along the gorge on the enclosed crossings (on their gorge-facing sides) and the Wall's galleries.
const shut = (j, L, south = true, north = true) => {
  for (const [go, z] of [[south, Z(j)], [north, Z(j + 1)]]) if (go) wall(X(GORGE), z, X(GORGE + 1), z, Y(L), Y(L + 1) - 1, 'lacquer');
};
for (const { j, levels, shut: s } of BRIDGES) if (s) for (const L of levels) for (const row of [j, NJ - 1 - j]) if (grid[L][GORGE][row] === FLOOR) shut(row, L);
for (let L = 1; L < LEVELS - 1; L++) {
  if (L === 6) continue; // an open deck at level 6
  if (grid[L][GORGE][6] === FLOOR) shut(6, L, true, false);
  if (grid[L][GORGE][9] === FLOOR) shut(9, L, false, true);
}

// Partitions: between neighbouring floor cells, mostly a wall with an 8 m doorway at one end of it,
// either end (a waypoint in each), so open floor reads as rooms off rooms, the way through them
// zigzags, and views stop at the next wall. None round anything a pad, a ramp, the X or a footbridge
// lands on, nor in the spawn halls or the gorge.
const special = new Set();
const mark = (i, j, L) => special.add(key(i, j, L));
for (const { i, j, L, to } of SHAFTS) for (const [a, b, c] of [[i, j, L], [i - to[0], j - to[1], L], [i + to[0], j + to[1], L + 2], [i, j, L + 1], [i, j, L + 2]]) mark(a, b, c);
for (const { i, j } of SLOTS) for (let L = 0; L < LEVELS; L++) for (const [a, b] of [[i, j], [i, j + 1], [i, j + 2], [i, j + 3], [i - 1, j], [i - 1, j + 3]]) mark(a, b, L);
for (let i = 0; i <= 4; i++) for (let j = 4; j <= 10; j++) mark(i, j, SPAWN);
mark(FLAG[0], FLAG[1], SPAWN); // the flag stand's walls are its own
for (const [i, j] of RING) mark(i, j, RAIL); // the ring: the convoy's way
for (const j of X_ROWS) for (const row of [j, NJ - 1 - j]) mark(FACE, row, X_LEVEL);
for (const { i, j, w, d, floor } of WELLS) for (let a = i; a < i + w; a++) for (let b = j; b < j + d; b++) mark(a, b, floor); // (silo A's on one)
for (const { L, a, b } of FOOTBRIDGES) for (const z of [a, b, -a, -b]) mark(FACE, rowAt(z), L);
for (const { j, L } of CANAL_PADS) mark(FACE, j, L);
// Which corners of a cell have a doorway, by key: "sx,sz" (signs toward the corner from its middle).
const doors = new Map();
const door = (i, j, L, sx, sz) => {
  if (!doors.has(key(i, j, L))) doors.set(key(i, j, L), new Set());
  doors.get(key(i, j, L)).add(`${sx},${sz}`);
};
for (let L = 1; L < LEVELS; L++) {
  for (let i = 0; i < FACE; i++) {
    for (let j = 0; j < NJ; j++) {
      if (grid[L][i][j] !== FLOOR || special.has(key(i, j, L))) continue;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const [a, b] = [i + di, j + dj];
        if (a > FACE || b >= NJ || grid[L][a][b] !== FLOOR || special.has(key(a, b, L)) || rand() > 0.8) continue;
        const c = rand() < 0.5 ? 4 : 12, s = c > 8 ? 1 : -1; // the doorway's middle along the edge
        // Out on a roof (nothing over either side), a parapet in the building's colour, not a screen.
        const roof = [[i, j], [a, b]].every(([u, v]) => L + 1 >= LEVELS || grid[L + 1][u][v] === VOID);
        const [top, mat, color] = roof ? [Y(L) + 5, 'plaster', wallOf(WEST_WALLS, i, j, L)] : [Y(L + 1) - 1, 'lacquer'];
        const screen = (...line) => {
          wall(...line, mat);
          if (color) solids[solids.length - 1].color = color;
        };
        if (di) {
          screen(X(a), c > 8 ? Z(j) : Z(j) + 8, X(a), c > 8 ? Z(j) + 8 : Z(j + 1), Y(L), top);
          point(at(X(a), Y(L), Z(j) + c));
          door(i, j, L, 1, s), door(a, j, L, -1, s);
        } else {
          screen(c > 8 ? X(i) : X(i) + 8, Z(b), c > 8 ? X(i) + 8 : X(i + 1), Z(b), Y(L), top);
          point(at(X(i) + c, Y(L), Z(b)));
          door(i, j, L, s, 1), door(i, b, L, s, -1);
        }
      }
    }
  }
}
// The canal: blocks set along it, staggered across it and askew, so no lane runs its length (the twin adds as many).
for (const [x0, z0, x1, z1, turn] of CANAL) quad(x0, z0, x1, z1, 0, 9, 'hull', { out: null, turn });
// Bays: rooms jutting off the gorge's face a storey tall, askew, their roofs out over it (the next
// floor's balconies, where it has them), staggered up the face so no view runs the gorge's length.
for (const { j, L, out, turn } of BAYS) quad(X(GORGE) - 4, Z(j) + 2, X(GORGE) + out, Z(j + 1) - 2, Y(L), Y(L + 1), 'plaster', { out: null, turn, color: wallOf(WEST_WALLS, GORGE, j, L) });
// The spawn halls' piers, at their inner corners (but round the flag stand): cover, and no view across.
for (const i of [1, 2, 3, 4]) for (const j of [6, 7, 8, 9]) {
  if (i <= 2 && j <= 7) continue; // (the hall's back corner stays open)
  const [x, , z] = at(X(i), 0, Z(j));
  turned([x, Y(SPAWN) + STORY / 2, z], [2, STORY / 2, 2], r3(yawAt(X(i), Z(j))), 'lacquer');
}
// Footbridges: 6 m walks across the gorge, from face to face, where both ends stand.
for (const { L, a, b } of FOOTBRIDGES) {
  if (get(FACE, rowAt(a), L) !== FLOOR || get(NI - 1 - FACE, rowAt(b), L) !== FLOOR) {
    console.warn(`footbridge at level ${L} has lost an end`);
    continue;
  }
  const [p, q] = [built(X(GORGE) - 4, a), built(X(NI - GORGE) + 4, b)], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  turned([r3((p[0] + q[0]) / 2), Y(L) - 0.5, r3((p[1] + q[1]) / 2)], [3, 0.5, r3(len / 2)], r3(deg(Math.atan2(q[0] - p[0], q[1] - p[1]))), 'metal');
  for (const f of [0.3, 0.5, 0.7]) point([r3(p[0] + (q[0] - p[0]) * f), Y(L), r3(p[1] + (q[1] - p[1]) * f)]);
}

// --- The ramp slots' flights ----------------------------------------------------------------------
for (const { i, j, from } of SLOTS) {
  for (let L = from; L < LEVELS - 1; L++) {
    const north = (L - from) % 2 === 0, lane = north ? X(i) + 4 : X(i) + 12;
    const [z0, z1] = [Z(j + 1), Z(j + 3)], [lo, hi] = north ? [z0, z1] : [z1, z0];
    const [a, b] = [at(lane, Y(L), lo), at(lane, Y(L + 1), hi)];
    if (deg(Math.atan2(STORY, Math.hypot(b[0] - a[0], b[2] - a[2]))) > 24) console.warn(`steep flight in the slot at ${i},${j}`);
    ramp(a, b, 7.5, 'metal', false);
    point([r3((a[0] + b[0]) / 2), Y(L) + STORY / 2, r3((a[2] + b[2]) / 2)]); // mid-flight (on it): the landings are too far apart to link
    point(at(lane, Y(L + 1), hi + (north ? 3 : -3))); // and off its top, straight on, clear of the next flight
  }
  for (const b of [j + 1, j + 2]) point(at(X(i) + 12, Y(from), cz(b))); // the slot's floor, in the lane the first flight leaves open
}

// --- Ways up out of the canal ----------------------------------------------------------------------
// The dock stairs: a flight up the face from the canal to the low bridge, filled under its top half
// (nothing to wedge under), with waypoints at its foot, on it and off its top; the canal pads.
for (const { from, to } of DOCK_STAIRS) {
  const lane = X(GORGE) + 4, dir = Math.sign(to - from), [a, b] = [at(lane, 0, from), at(lane, Y(1), to)];
  ramp(a, b, 7.5, 'metal', true);
  point(at(lane, 0, from - dir * 4), [r3((a[0] + b[0]) / 2), STORY / 2, r3((a[2] + b[2]) / 2)], at(lane, Y(1), to + dir * 3));
}
for (const { j, L } of CANAL_PADS) pad(at(X(GORGE) + 14, 0, cz(j)), at(cx(FACE), Y(L), cz(j)), Y(L) + 4); // (from mid-canal, so it's high by the face's edge)

// --- The diagonal X: two blocks from face to face, floor and a roof over each, crossing mid-gorge --
{
  const [za, zb] = [cz(X_ROWS[0]), cz(X_ROWS[1])], xw = X(GORGE), xe = X(NI - GORGE);
  for (const [z0, z1] of [[za, zb], [zb, za]]) {
    const [a, b] = [built(xw, z0), built(xe, z1)], o = [r3((a[0] + b[0]) / 2), r3((a[1] + b[1]) / 2)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 4, yaw = r3(deg(Math.atan2(b[0] - a[0], b[1] - a[1])));
    turned([o[0], Y(X_LEVEL) - 0.5, o[1]], [7, 0.5, r3(len / 2)], yaw, 'concrete');
    turned([o[0], Y(X_LEVEL + 1) - 1.5, o[1]], [7, 0.5, r3(len / 2 - 6)], yaw, 'metal'); // its roof, shade only
    for (const f of [0.25, 0.5, 0.75]) point([r3(a[0] + (b[0] - a[0]) * f), Y(X_LEVEL), r3(a[1] + (b[1] - a[1]) * f)]);
  }
}

// --- Pads in their shafts: launched off-centre, away from the landing, so the arc clears the walls --
// and topping out low enough that a Heavy's head clears the floor over the landing.
for (const { i, j, L, to } of SHAFTS) pad(at(cx(i) - to[0] * 4, Y(L), cz(j) - to[1] * 4), at(cx(i + to[0]), Y(L + 2), cz(j + to[1])), Y(L + 2) + 4);

// --- Growth: what the city's added since, at any angle --------------------------------------------
// Shacks and water tanks on the open roofs, each in a corner of its cell clear of the doorways and
// of the ways through the middle, turned however it was set down.
{
  const grow = rng(77);
  for (let i = 0; i < FACE + 1; i++) for (let j = 0; j < NJ; j++) for (let L = 6; L < LEVELS; L++) {
    if (grid[L][i][j] !== FLOOR || special.has(key(i, j, L))) continue;
    let sky = true;
    for (let M = L + 1; M < LEVELS; M++) if (grid[M][i][j] !== VOID) sky = false;
    if (!sky || grow() > 0.45) continue;
    const free = [[1, 1], [1, -1], [-1, 1], [-1, -1]].filter(([sx, sz]) => !doors.get(key(i, j, L))?.has(`${sx},${sz}`));
    if (!free.length) continue;
    const [sx, sz] = free[Math.floor(grow() * free.length)], [x, , z] = at(cx(i) + sx * 5, 0, cz(j) + sz * 5);
    if (grow() < 0.3) cylinder([x, Y(L), z], [x, r3(Y(L) + grow(4, 6)), z], r3(grow(1.6, 2)), 'tank');
    else {
      const h = r3(grow(3.5, 6));
      turned([x, r3(Y(L) + h / 2), z], [r3(grow(1.6, 2)), r3(h / 2), r3(grow(1.6, 2))], r3(grow(0, 90)), 'pale');
    }
  }
}

// --- Waypoints: every walkable cell's middle --------------------------------------------------------
for (let L = 0; L < LEVELS; L++) for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
  if (grid[L][i][j] !== FLOOR) continue;
  if (SHAFTS.some((s) => (s.i === i && s.j === j && s.L === L) || (s.i + s.to[0] === i && s.j + s.to[1] === j && s.L + 2 === L))) continue; // the pad's own waypoints stand there
  if (i === FLAG[0] && j === FLAG[1] && L === SPAWN) continue; // and the flag stand's
  if (CANAL_PADS.some((p) => p.j === j && ((i === GORGE && L === 0) || (i === FACE && L === p.L)))) continue; // and a canal pad's
  if (L === 0 && CANAL.some(([x0, z0, x1, z1]) => cx(i) > x0 - 5 && cx(i) < x1 + 5 && cz(j) > z0 - 5 && cz(j) < z1 + 5)) continue; // a canal block stands there
  if (SLOTS.some((s) => s.i === i && s.from === L && (j === s.j + 1 || j === s.j + 2))) continue; // a flight starts there
  point(at(cx(i), Y(L), cz(j)));
}

// --- Objectives ----------------------------------------------------------------------------------
bases(at(cx(0), Y(RAIL), 0));
sentries([at(cx(3) + 4, Y(SPAWN), cz(6)), at(cx(3) + 4, Y(SPAWN), cz(9))]);
// The flag stand's doorways face south and east, toward the gorge, away from its guns in the hall.
flags(flagStand(at(cx(FLAG[0]), Y(SPAWN), cz(FLAG[1])), r3(yawAt(cx(FLAG[0]), cz(FLAG[1])))));
// The convoy: from the middle of the ring's south bridge to each base, round the ring's jogs (the
// east's are the twins of the west's north side), 320 m either way in plan; a point every cell or
// so, so the route bends with the lots.
const route = (...plan) => {
  const out = [at(plan[0][0], Y(RAIL), plan[0][1])];
  for (let k = 1; k < plan.length; k++) {
    const [[x0, z0], [x1, z1]] = [plan[k - 1], plan[k]], n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / CELL);
    for (let s = 1; s <= n; s++) out.push(at(x0 + ((x1 - x0) * s) / n, Y(RAIL), z0 + ((z1 - z0) * s) / n));
  }
  return out;
};
const via = (...cells) => cells.map(([i, j]) => [cx(i), cz(j)]);
convoy(
  route([0, cz(1)], ...via([8, 1], [8, 0], [4, 0], [4, 1], [1, 1], [1, 5], [0, 5]), [cx(0), 0]),
  route([0, cz(1)], ...via([13, 1], [13, 0], [17, 0], [17, 1], [22, 1], [22, 5], [23, 5]), [cx(23), 0]),
);
const [A] = WELLS;
silos({ at: at(X(A.i + 1), Y(A.floor), Z(A.j + 1)), radius: 12, band: 4 }, { at: [0, 0, 0], radius: 14, band: 4 });

// --- Dressing: the two sides of the gorge ----------------------------------------------------------
// The same building on both sides; only what it's made of and what hangs in it differ. The west, old
// money: warm plaster with lamplit windows, tiled floors, red lacquer screens and pillars, paper
// lanterns under the ceilings, gilt rails along the gorge, banners down its face, gardens and lamps
// on the roofs. The east, the tenements: grimy concrete with fluorescent windows, rust, tubes in
// nearly every room, pipes and boxes on the walls, cables and washing strung across, neon down the
// gorge's face. Each side's props are placed on the west's plan and set down on their own side.
const flip = ([x, y, z]) => [r3(-x) || 0, y, r3(-z) || 0];
const EAST = { plaster: 'tenement', terracotta: 'grime', lacquer: 'rust', pale: 'rust', tank: 'rust' };
const LANTERNS = ['#ff9a3a', '#ff6a32', '#ffc060'], TUBES = ['#dffff0', '#dffff0', '#c4f2ff', '#f0ffe0'];
const BANNERS = ['#ffcc66', '#ff5a3a', '#ffb347'], NEON = ['#ff3fa0', '#3fe0ff', '#b0ff3a', '#ff7a2a', '#c86bff'];
const WASHING = ['#c94f4f', '#e0d6c0', '#4f6fc9', '#d9b44a', '#6aa36a', '#b07ac9'];
const SHEETS_WEST = ['#8c5a46', '#7d5040', '#9a6a4e', '#6f6a5e'], SHEETS_EAST = ['#7a4a32', '#6b6e6a', '#5d6a6e', '#8a8a7e', '#6e5a48'];
const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // a cell's sides: south, east, north, west
for (const east of [false, true]) {
  const r = rng(east ? 909 : 404), pick = (list) => list[Math.floor(r() * list.length)];
  const put = (p) => (east ? flip(p) : p);
  /** The plan's point [x, y, z], built, on this side. */
  const here = (x, y, z) => put(at(x, y, z));
  /** A box prop (`sign` or `slab`) centred on the plan's point, `half` its half-size along the plan's x, y and z, squared to its lot. */
  const prop = (kind, [x, y, z], [hx, hy, hz], extra) => {
    const [u, , w] = here(x, 0, z);
    decor.push({ kind, from: [r3(u - hx), r3(y - hy), r3(w - hz)], to: [r3(u + hx), r3(y + hy), r3(w + hz)], yaw: r3(yawAt(x, z) + (east ? 180 : 0)), ...extra });
  };
  /** A glowing prop that lights the street from `from` (the plan's point): [radius, power]. */
  const light = (center, half, color, from, reach) => prop('sign', center, half, { color, at: here(...from), light: reach });
  const line = (kind, a, b, extra) => decor.push({ kind, from: here(...a), to: here(...b), ...extra });
  // A point on a cell's side `s` (SIDES), `t` along it (0 to 1), `inset` m in from it, `y` up.
  const onSide = (i, j, s, t, inset, y) => {
    const [di, dj] = SIDES[s], [x0, z0] = [cx(i) + (di * CELL) / 2, cz(j) + (dj * CELL) / 2];
    return [x0 - di * inset + (dj ? (t - 0.5) * CELL : 0), y, z0 - dj * inset + (di ? (t - 0.5) * CELL : 0)];
  };
  const poles = []; // the tops of the poles on this side's roofs, for the cables between them
  /** A pole `h` m tall at the plan's point, a crossbar near its top (cables run from there). */
  const pole = (u, y, w, h) => {
    line('pipe', [u, y, w], [u, y + h, w], { r: 0.14, color: '#3a3430' });
    line('pipe', [u - 1.4, y + h - 0.6, w], [u + 1.4, y + h - 0.6, w], { r: 0.06, color: '#3a3430' });
    poles.push([u, y + h - 0.6, w]);
  };
  for (let L = 0; L < LEVELS; L++) for (let i = 0; i <= FACE; i++) for (let j = 0; j < NJ; j++) {
    if (grid[L][i][j] !== FLOOR || (i === FLAG[0] && j === FLAG[1] && L === SPAWN)) continue;
    const [x, z] = [cx(i), cz(j)], roofed = L + 1 < LEVELS && grid[L + 1][i][j] !== VOID, top = Y(L + 1) - 1;
    let sky = true;
    for (let M = L + 1; M < LEVELS; M++) if (grid[M][i][j] !== VOID) sky = false;
    const [ox, oz] = [r(-4, 4), r(-4, 4)];
    if (roofed && !east && r() < 0.5) {
      // A paper lantern on a cord.
      const y = top - 2.6;
      light([x + ox, y, z + oz], [0.55, 0.75, 0.55], pick(LANTERNS), [x + ox, Y(L) + 6, z + oz], [16, 2.8]); // (lighting the room from its middle)
      prop('slab', [x + ox, (y + 0.6 + top) / 2, z + oz], [0.03, (top - y - 0.6) / 2, 0.03], { color: '#2a2220' });
    }
    if (roofed && east && r() < 0.8) {
      // A fluorescent tube under the ceiling.
      const along = r() < 0.5, y = top - 0.4;
      light([x + ox, y, z + oz], along ? [0.1, 0.06, 1.3] : [1.3, 0.06, 0.1], pick(TUBES), [x + ox, Y(L) + 6, z + oz], [16, 3.8]);
    }
    for (let s = 0; s < 4; s++) {
      const [di, dj] = SIDES[s];
      if (get(i + di, j + dj, L) !== SOLID) continue;
      if (east && r() < 0.5) line('pipe', onSide(i, j, s, 0.04, 0.5, Y(L) + r(7, 9)), onSide(i, j, s, 0.96, 0.5, Y(L) + r(7, 9)), { r: r3(r(0.15, 0.3)) });
      if (east && r() < 0.35) {
        // A box on the wall: an air conditioner, a meter, a junction.
        const [u, y, w] = onSide(i, j, s, r(0.2, 0.8), 0.5, Y(L) + r(3, 9));
        prop('slab', [u, y, w], di ? [0.4, 0.45, 0.7] : [0.7, 0.45, 0.4], { mat: 'metal' });
      }
      if (!east && roofed && r() < 0.15) {
        // A sconce on the wall.
        const [u, y, w] = onSide(i, j, s, r(0.25, 0.75), 0.3, Y(L) + 5);
        light([u, y, w], di ? [0.15, 0.5, 0.35] : [0.35, 0.5, 0.15], '#ffb060', onSide(i, j, s, 0.5, 2, Y(L) + 4), [8, 1]);
      }
    }
    if (east && roofed && r() < 0.6) {
      // Cables strung across, from wall to wall.
      for (let k = 0, n = 1 + Math.floor(r() * 3); k < n; k++) {
        const s = Math.floor(r() * 4), y = top - r(1, 3);
        line('pipe', onSide(i, j, s, r(0.1, 0.9), 0.2, y), onSide(i, j, (s + 2) % 4, r(0.1, 0.9), 0.2, y - r(0, 1.5)), { r: 0.05 });
      }
    }
    if (east && (sky || L === 0) && r() < 0.45) {
      // Washing on a line.
      const s = Math.floor(r() * 2), y = Y(L) + r(5.5, 7.5), a = onSide(i, j, s, r(0.2, 0.8), 0.3, y), b = onSide(i, j, s + 2, r(0.2, 0.8), 0.3, y);
      line('pipe', a, b, { r: 0.03 });
      for (let k = 1, n = 3 + Math.floor(r() * 4); k <= n; k++) {
        const f = k / (n + 1), p = [a[0] + (b[0] - a[0]) * f, y - 0.65, a[2] + (b[2] - a[2]) * f];
        prop('slab', p, s ? [0.45, 0.6, 0.03] : [0.03, 0.6, 0.45], { color: pick(WASHING) });
      }
    }
    if (sky && L >= 5) {
      // An open roof: a rail along each edge with a drop past it, a pole in a corner now and then.
      for (let s = 0; s < 4; s++) {
        const [di, dj] = SIDES[s];
        if (get(i + di, j + dj, L) === VOID && !(i === FACE && di === 1)) line('railing', onSide(i, j, s, 0.04, 0.4, Y(L)), onSide(i, j, s, 0.96, 0.4, Y(L)), { color: east ? '#5f6466' : '#9c7a3c' });
      }
      if (r() < 0.3) pole(x + Math.sign(ox || 1) * 6.5, Y(L), z + Math.sign(oz || 1) * 6.5, r(6, 9));
    }
    if (sky && L >= 5 && i < FACE && !special.has(key(i, j, L))) {
      if (!east && r() < 0.5) prop('slab', [x - ox * 0.6, Y(L) + 0.4, z + 6.5 * Math.sign(oz || 1)], [2.2, 0.4, 0.6], { mat: 'moss' }); // a planter
      if (!east && r() < 0.35) decor.push({ kind: 'lamp', at: here(x + ox, Y(L), z - oz) });
      if (east && r() < 0.4) line('pipe', [x + ox, Y(L), z + oz], [x + ox, Y(L) + r(4, 9), z + oz], { r: 0.08 }); // an aerial
    }
  }
  // The gorge's face: a balcony's edge gets a rail; a wall gets a banner (west) or neon and boxes (east).
  for (let L = 1; L < LEVELS; L++) for (let j = 0; j < NJ; j++) {
    if (grid[L][GORGE][j] !== VOID) continue;
    const face = grid[L][FACE][j];
    if (face === FLOOR) line('railing', [X(GORGE) - 0.3, Y(L), Z(j) + 0.6], [X(GORGE) - 0.3, Y(L), Z(j + 1) - 0.6], east ? { color: '#6d7376' } : {});
    if (face !== SOLID) continue;
    const z = cz(j) + r(-3, 3), y = Y(L) + r(3, 7);
    if (!east && r() < 0.35) light([X(GORGE) + 0.2, y, z], [0.15, 3.5, 1.1], pick(BANNERS), [X(GORGE) + 2.5, y, z], [16, 2.4]);
    if (east && r() < 0.6) light([X(GORGE) + 0.2, y, z], [0.15, r(1, 2.5), r(1.2, 3)], pick(NEON), [X(GORGE) + 2.5, y, z], [18, 2.8]);
    if (east) for (let k = 0, n = Math.floor(r() * 3); k < n; k++) prop('slab', [X(GORGE) + 0.5, Y(L) + r(1, 10), Z(j) + r(2, 14)], [0.5, 0.45, 0.7], { mat: 'metal' });
  }
  // The towers' roofs: what's gone up on them since, at any angle. Sheds and lean-tos under pitched
  // corrugated sheets on posts, stair huts, tanks on legs, poles with cables slung from one to the
  // next, aerials and dishes, rails round the edges, boxes; strings of lanterns over the west's,
  // neon billboards on the east's. None of it collides: only the towers do.
  for (let i = 0; i <= FACE; i++) for (let j = 0; j < NJ; j++) {
    const top = tops[i][j];
    if (top === undefined) continue;
    const [x, z] = [cx(i), cz(j)], spot = (m) => [x + r(-m, m), z + r(-m, m)];
    for (let k = 0, n = r() < 0.55 ? 1 : 2; k < n; k++) {
      // A shed: a corrugated roof pitched (its -Z edge up) on four posts.
      const [u, w] = spot(3.5), [hw, hd] = r() < 0.5 ? [r(2, 3.8), r(1.5, 2.6)] : [r(1.5, 2.6), r(2, 3.8)];
      const h = top + r(2.6, 3.6), tilt = r(6, 14), rise = hd * Math.sin((tilt * Math.PI) / 180);
      prop('roof', [u, h, w], [hw, 0.05, hd], { color: pick(east ? SHEETS_EAST : SHEETS_WEST), tilt: r3(tilt) });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const [pu, pw] = [u + sx * (hw - 0.3), w + sz * (hd - 0.3)];
        line('pipe', [pu, top, pw], [pu, h - sz * rise, pw], { r: 0.08, color: '#3a3c3f' });
      }
    }
    if (r() < 0.6) {
      const [u, w] = spot(5);
      prop('slab', [u, top + 1.5, w], [r(1.4, 2.4), 1.5, r(1.4, 2.2)], { color: east ? '#74776f' : '#bba88a' }); // a stair hut
    }
    if (r() < (east ? 0.6 : 0.35)) {
      // A tank on legs.
      const [u, w] = spot(4.5), [rad, leg] = [r(1.2, 1.8), r(1.6, 2.6)];
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) line('pipe', [u + sx * rad * 0.6, top, w + sz * rad * 0.6], [u + sx * rad * 0.6, top + leg, w + sz * rad * 0.6], { r: 0.1, color: '#3a3c3f' });
      line('pipe', [u, top + leg, w], [u, top + leg + r(2.2, 3.6), w], { r: r3(rad), color: pick(east ? ['#6e5a48', '#7a7468', '#5f6a6a'] : ['#8a7a62', '#9a8a6a', '#7d6a55']) });
    }
    if (r() < (east ? 0.7 : 0.45)) pole(x + pick([-1, 1]) * r(5, 7), top, z + pick([-1, 1]) * r(5, 7), r(6, 10));
    for (let k = 0, n = east ? Math.floor(r(1, 4)) : r() < 0.4 ? 1 : 0; k < n; k++) {
      // An aerial, crossed near its top.
      const [u, w] = spot(6), ah = r(3, 8);
      line('pipe', [u, top, w], [u, top + ah, w], { r: 0.05, color: '#4a4c4e' });
      line('pipe', [u - 0.8, top + ah * 0.8, w], [u + 0.8, top + ah * 0.8, w], { r: 0.03, color: '#4a4c4e' });
    }
    if (east && r() < 0.35) {
      // A dish on a post.
      const [u, w] = spot(5), a = r(0, 2 * Math.PI);
      line('pipe', [u, top, w], [u, top + 1.4, w], { r: 0.06, color: '#4a4c4e' });
      line('pipe', [u, top + 1.7, w], [u + Math.cos(a) * 0.12, top + 1.82, w + Math.sin(a) * 0.12], { r: r3(r(0.7, 1.1)), color: '#c8c8c0' });
    }
    for (let k = 0, n = east ? Math.floor(r(1, 4)) : Math.floor(r(0, 2)); k < n; k++) {
      const [u, w] = spot(6);
      prop('slab', [u, top + 0.45, w], [0.5, 0.45, 0.7], { mat: 'metal' }); // a box: an air conditioner, a meter
    }
    for (let s = 0; s < 4; s++) {
      // A rail along an edge with a drop past it (the next roof lower, or none).
      const [di, dj] = SIDES[s];
      if ((tops[i + di]?.[j + dj] ?? -1) < top - 1 && r() < 0.7) line('railing', onSide(i, j, s, 0.04, 0.4, top), onSide(i, j, s, 0.96, 0.4, top), { color: east ? '#5f6466' : '#9c7a3c' });
    }
    if (east && r() < 0.15) {
      // A neon billboard on two legs, facing out over an edge.
      const y = top + r(5, 8), s = Math.floor(r() * 4), [di, dj] = SIDES[s];
      for (const t of [0.25, 0.75]) {
        const a = onSide(i, j, s, t, 2, top);
        line('pipe', a, [a[0], y, a[2]], { r: 0.12, color: '#3a3430' });
      }
      const [u, , w] = onSide(i, j, s, 0.5, 2, top);
      light([u, y + 1.6, w], di ? [0.15, 1.6, 3.6] : [3.6, 1.6, 0.15], pick(NEON), [u + di * 3, y + 1, w + dj * 3], [18, 2.2]);
    }
  }
  // Cables slung from each pole to its nearest one or two, sagging; lanterns strung along some of the west's.
  poles.forEach((p, n) => {
    const away = (q) => Math.hypot(q[0] - p[0], q[2] - p[2]);
    for (const q of poles.slice(n + 1).filter((q) => away(q) > 6 && away(q) < 36).sort((a, b) => away(a) - away(b)).slice(0, 2)) {
      const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 - r(1.5, 4), (p[2] + q[2]) / 2];
      line('pipe', p, mid, { r: 0.04, color: '#2a2a2a' });
      line('pipe', mid, q, { r: 0.04, color: '#2a2a2a' });
      if (!east && r() < 0.5) {
        for (let k = 1; k < 6; k++) {
          const f = k / 6, [a, b, t] = f < 0.5 ? [p, mid, f * 2] : [mid, q, f * 2 - 1], c = [0, 1, 2].map((m) => a[m] + (b[m] - a[m]) * t);
          light([c[0], c[1] - 0.45, c[2]], [0.25, 0.3, 0.25], pick(LANTERNS), c, 0);
        }
      }
    }
  });
  // The Wall's sign down the gorge, on its half of the Wall: a gilt board (west), a neon one (east).
  light([X(GORGE) + 8, Y(7) + 5, Z(6) - 0.4], [6, 3, 0.15], east ? '#ff3fa0' : '#ffb347', [X(GORGE) + 8, Y(7) + 4, Z(6) - 4], [22, 2.4]);
  // The docks: lamps along the west's, neon over the east's, steam off the water.
  for (let j = 0; j < NJ; j += 2) {
    const z = cz(j) + r(-4, 4);
    if (!east) decor.push({ kind: 'lamp', at: here(X(FACE) + 13, 0, z) });
    else light([X(FACE) + 1, 7, z], [0.15, 1.2, 2.5], pick(NEON), [X(FACE) + 4, 5, z], [14, 1.8]);
    if (east && r() < 0.5) decor.push({ kind: 'steam', at: here(X(GORGE) + r(2, 14), 0.8, cz(j) + r(-6, 6)) });
  }
}
// Across the gorge: cables slung from face to face, and the monorail's track round the ring.
{
  const r = rng(616);
  for (let k = 0; k < 14; k++) {
    const [y, za, zb] = [r(14, 100), r(-120, 120), r(-120, 120)], [a, b] = [built(X(GORGE), za), built(X(NI - GORGE), zb)];
    const mid = [(a[0] + b[0]) / 2, y - r(2, 5), (a[1] + b[1]) / 2];
    decor.push({ kind: 'pipe', from: [r3(a[0]), r3(y), r3(a[1])], to: mid.map(r3), r: 0.07 }, { kind: 'pipe', from: mid.map(r3), to: [r3(b[0]), r3(y + r(-2, 2)), r3(b[1])], r: 0.07 });
  }
  for (const p of [objectives.convoy.points]) {
    for (let k = 1; k < p.length; k++) {
      const [a, b] = [p[k - 1], p[k]], d = Math.hypot(b[0] - a[0], b[2] - a[2]), [nx, nz] = [-(b[2] - a[2]) / d, (b[0] - a[0]) / d];
      for (const o of [-0.9, 0.9]) decor.push({ kind: 'pipe', from: [r3(a[0] + nx * o), a[1] + 0.12, r3(a[2] + nz * o)], to: [r3(b[0] + nx * o), b[1] + 0.12, r3(b[2] + nz * o)], r: 0.1 });
    }
  }
}

// --- Spawns, twin, write ---------------------------------------------------------------------------
const north = [];
for (const i of [2, 3]) for (const j of [6, 7, 8, 9]) north.push(at(cx(i), Y(SPAWN) + 0.1, cz(j)));
// Blue hour: the last of the dusk, a twilight sky warm at the horizon and the city's lights coming
// on: warm lamps in the west, cold tubes and neon in the east. Black water stands on the canal.
const palette = {
  sky: { horizon: '#9a7a80', zenith: '#2c3458', sun: '#f0d8ff', stars: 0.04 },
  fog: [50, 320], haze: ['#7c6a78', 0.025, 7],
  light: { sky: '#aeb0d0', ground: '#4c4448', ambient: 3, sun: '#c8c0ec', direct: 0.9 }, exposure: 1.15,
  lamp: '#ffae5a', skyline: 'city', cover: 0.7,
  water: { level: 0.5, color: '#1c2a2a', opacity: 0.9 },
};
let floors = 0, voids = 0;
for (const plane of grid) for (const col of plane) for (const c of col) floors += c === FLOOR, voids += c === VOID;
console.log(`cells: ${floors} floor, ${voids} void (west half)`);
// The east half: the west's twin, built of the tenements' materials (the props are each side's own).
for (const s of [...solids]) {
  const box = flip(s.box);
  solids.push({ ...s, box, mat: EAST[s.mat] ?? s.mat, ...(s.color && { color: wallOf(EAST_WALLS, box[0], box[2], box[1]) }), ...((s.yaw !== undefined || s.tilt) && { yaw: r3((s.yaw ?? 0) + 180) }) });
}
for (const p of [...nav]) nav.push(flip(p));
for (const p of [...pads]) pads.push({ at: flip(p.at), to: flip(p.to), apex: p.apex });
write(new URL('./walled.json', import.meta.url), { name: 'Walled City', size: [W, D], night: true, palette }, north, north.map(flip));
