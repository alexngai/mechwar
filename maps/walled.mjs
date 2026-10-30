// Walled City (grey-box): a 320 x 224 m city stacked 100 m deep on both sides of a chasm 64 m wide,
// crossed in its middle by the Bridge, whose top is a plaza at the spawns' level. The west half is
// the wealthy one and the east the tenements (that's for the dressing; the grey-box gives both the
// same routes). Writes walled.json next to this file; rerun `node maps/walled.mjs` after editing.
//
// The city is planned as a grid of 16 m cells on nine storeys 12 m apart, each cell solid building,
// floor (walkable, 11 m of headroom under the storey above) or void (shafts, the courtyard, the
// well, the chasm), and built in lots, each its own building (see `LOTS`).
// Streets run on five floors, every other storey, 24 m apart, each its own shape (see `PLANS`): the
// canal along the chasm's floor (0), the low road, a gallery behind the chasm's face (24), the spawn
// hall, its square and the plaza (48), the monorail ring (72) and the roofs, open to the sky (96).
// The storeys between are building.
//
// The chasm (the four middle columns) is where the floors meet, and every floor crosses it: the
// canal along its floor; the Bridge in its middle, a mass of building with a hall through it on the
// low road and the plaza on top; near its ends two bridges, the monorail's enclosed deck with an
// open one on its roof. The ways between floors are at its faces, quick: in each half a switchback
// stair climbs the south face from the canal to the roofs, landing on every floor (and, between,
// over the plaza), and a ladder of pads throws you up the north face a floor at a time. Anything
// open drops you down (no fall damage): the face, the courtyard, the well.
//
// Only the west half (columns 0-9) is authored; its 180-degree twin is added at the end.
// Game modes: Missile Assault (A down the west well on the low road, B up on the plaza, C the twin
// of A: two in the city, one on its open street); Capture the Flag (each team's flag stand in the
// square in front of its spawn hall, by the gate onto the plaza); Convoy (along the monorail, from
// the middle of its south bridge to each base).
import { bases, beam, box, convoy, cylinder, decor, flags, flagStand, nav, objectives, pad, pads, point, r3, ramp, sentries, silos, slope, solids, turned, write } from './kit.mjs';

const CELL = 16, STORY = 12, LEVELS = 9; // storeys at 0, 12, ... 96
const NI = 20, NJ = 14, W = NI * CELL, D = NJ * CELL; // 320 x 224 m
const HALF = 10, GORGE = 8, FACE = 7; // columns authored; the chasm's west edge (it runs to the twin's); the face over it
const SOLID = 0, FLOOR = 1, VOID = 2;
const CANAL = 0, LOW = 2, SPAWN = 4, RAIL = 6, ROOF = 8; // the floors
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

// --- The floors: '.' floor, '#' building, ' ' open (the chasm, the courtyard, the well, a shaft) -----
// Each row from the north (j = 13) down to the south (j = 0), each column from the west wall (0) to
// the chasm's middle (9). The Bridge fills rows 5-8 of the chasm under the plaza; the monorail's two
// bridges near its ends (rows 2 and 11) are built on their own, sloping (see TRACK).
const PLAN = {
  [CANAL]: Array(NJ).fill('#######...'), // the docks along the face, the canal
  [LOW]: [
    '########  ',
    '########  ',
    '####....  ', // the well; the pads' landing on the face
    '####....  ',
    '#####.#   ',
    '#####..###',
    '######....', // the hall through the Bridge
    '######....',
    '######.###',
    '######.   ', // the gallery behind the face, the stair beside it
    '######.   ',
    '######..  ',
    '########  ',
    '########  ',
  ],
  [SPAWN]: [
    '########  ',
    '########  ',
    '####  ##  ', // the well
    '####   #  ',
    '####....  ', // round it to the pads
    '...... #..', // the spawn hall, its doors, the square, a drop to the low road, the gate's shoulders, the plaza
    '...#......',
    '...#......',
    '...... #..',
    '#####.#   ',
    '####..#   ', // the courtyard
    '####....  ', // and on to the stair
    '########  ',
    '########  ',
  ],
  [RAIL]: [
    '########  ',
    '########  ',
    '###   ##  ', // the monorail climbing beside the well (see TRACK)
    '###   ..  ',
    '....###   ', // the monorail, round the well
    '. ######  ', // past the base; the spawn hall's pad lands here
    '.#######  ',
    '.#######  ',
    '.#######  ',
    '....###   ',
    '###.  #   ', // round the courtyard
    '###.  ..  ', // to the foot of the south bridge
    '###....#  ',
    '########  ',
  ],
  [ROOF]: [
    '########  ',
    '####  .#  ', // the monorail's cutting up through the roofs
    '###.  ..  ', // the top of the north bridge
    '###.   .  ',
    '###.....  ', // round the well
    '#####.##  ',
    '#####.##  ',
    '#####.##  ',
    '#####.##  ',
    '###....   ', // round the courtyard
    '###.  .   ',
    '###.  ..  ', // the stair's top
    '########  ',
    '########  ',
  ],
};
const PLAZA = SPAWN, SPAN = [5, 8], HALL = LOW, FLANKS = [2, NJ - 1 - 2]; // the plaza's rows; the end bridges' rows
for (let L = 0; L < LEVELS; L++) {
  for (let i = 0; i < HALF; i++) {
    for (let j = 0; j < NJ; j++) {
      if (PLAN[L]) grid[L][i][j] = { '#': SOLID, '.': FLOOR, ' ': VOID }[PLAN[L][NJ - 1 - j][i]];
      // Between floors, building; open over the chasm but for the Bridge's mass.
      else grid[L][i][j] = i < GORGE || (L < PLAZA && j >= SPAN[0] && j <= SPAN[1]) ? SOLID : VOID;
    }
  }
}
// The square, the way on to the gate and the gate stand two storeys tall.
for (let i = 4; i <= FACE; i++) for (let j = SPAN[0]; j <= SPAN[1]; j++) if (grid[SPAWN][i][j] === FLOOR) grid[SPAWN + 1][i][j] = VOID;

// --- The courtyard, the well, the drops by the gate: open from their floors to the sky (or `top`) ----
const WELLS = [
  { i: 4, j: 2, w: 2, d: 2, floor: SPAWN }, // the courtyard, the ring round it
  { i: 4, j: 10, w: 2, d: 2, floor: LOW }, // the well, down from the spawns' floor to the low road (Missile Assault's A)
  { i: 6, j: SPAN[0], w: 1, d: 1, floor: LOW, top: SPAWN }, // either side of the gate, down to the hall's door
  { i: 6, j: SPAN[1], w: 1, d: 1, floor: LOW, top: SPAWN },
];
for (const { i, j, w, d, floor, top = LEVELS - 1 } of WELLS) {
  for (let L = floor; L <= top; L++) for (let a = i; a < i + w; a++) for (let b = j; b < j + d; b++) set(a, b, L, L === floor ? FLOOR : VOID);
}

// --- The stair: a switchback slot up the south face, 4 cells long, the middle two open its full height -
// Flights 32 m long climb a storey each (21 degrees), in two 8 m lanes taking turns, landing on the
// end cells: the south end on every floor (by the bridge's way on), the north end on the storeys
// between, over the plaza's corner. Open to the chasm on its east side.
const SLOTS = [{ i: FACE, j: FLANKS[0], from: CANAL }];
for (const { i, j, from } of SLOTS) {
  for (let L = from; L < LEVELS; L++) {
    for (const b of [j + 1, j + 2]) set(i, b, L, L === from ? FLOOR : VOID);
    set(i, (L - from) % 2 ? j + 3 : j, L, FLOOR);
  }
}

// --- Pads: a pad on a floor throws you up a floor (two storeys), to the floor beside its shaft ------
const SHAFTS = [
  // The ladder up the north face, from the canal to the roofs, a pad on each floor beside the last's landing.
  { i: 7, j: 9, L: CANAL, to: [0, 1] },
  { i: 6, j: 10, L: LOW, to: [0, -1] },
  { i: 7, j: 9, L: SPAWN, to: [0, 1] },
  { i: 6, j: 10, L: RAIL, to: [0, -1] },
  { i: 1, j: 8, L: SPAWN, to: [-1, 0] }, // in the spawn hall's corner, up onto the ring by the base
  { i: 4, j: 10, L: LOW, to: [0, -1] }, // the well's, up out of it
];
for (const { i, j, L, to } of SHAFTS) {
  set(i, j, L, FLOOR);
  set(i, j, L + 1, VOID);
  set(i, j, L + 2, VOID);
  set(i + to[0], j + to[1], L + 2, FLOOR);
}

// --- Spawn hall (roofed, deep in each half), the flag stand in the square in front of it ----------
// Its base (where missiles land, the convoy's end) is on the monorail ring over it; its flag stand
// is out in the square, by the gate onto the plaza, so defenders have to run to it.
const FLAG = [5, 6];
const STAND = [FLAG, [FLAG[0], FLAG[1] - 1], [FLAG[0] + 1, FLAG[1]]]; // the flag stand's cell and the ones its doorways (south, east) open on

// --- The monorail: snaking round each half and over the chasm, climbing as it goes ------------------
// Its south side runs through the buildings on the rail's floor (72), along the courtyard's open
// sides, to the base over the spawn hall; its north side wraps the well and climbs, a storey up
// beside it and another in a cutting through the roofs, out onto them (96). Each bridge over the
// chasm slopes from one side's roofs down to the other's rail floor (the twin's north side is the
// east's south), so the track loops through both bases, up and down; in Convoy the hauler rides it
// from the middle of the south bridge. TRACK is its centre line in the west half, [x, z, y], from
// the south bridge's foot round to the north bridge's top; CLIMBS, the cells at either end of each
// slope, for the links.
const TRACK = [
  [X(GORGE), cz(2), Y(RAIL)], [cx(7), cz(2), Y(RAIL)], [cx(6), cz(2), Y(RAIL)], [cx(6), cz(1), Y(RAIL)], [cx(3), cz(1), Y(RAIL)],
  [cx(3), cz(4), Y(RAIL)], [cx(0), cz(4), Y(RAIL)], [cx(0), cz(9), Y(RAIL)], [cx(3), cz(9), Y(RAIL)],
  [cx(3), Z(10), Y(RAIL)], [cx(3), Z(12), Y(RAIL + 1)], [cx(3), cz(12), Y(RAIL + 1)], // up beside the well
  [X(4), cz(12), Y(RAIL + 1)], [X(6), cz(12), Y(ROOF)], [cx(6), cz(12), Y(ROOF)], // up through the roofs
  [cx(6), cz(11), Y(ROOF)], [cx(7), cz(11), Y(ROOF)], [X(GORGE), cz(11), Y(ROOF)],
];
const BRIDGE = [[X(GORGE), cz(FLANKS[0]), Y(RAIL)], [X(NI - GORGE), cz(FLANKS[0]), Y(ROOF)]]; // the south one, west to east
const CLIMBS = [
  [[3, 9, RAIL], [3, 12, RAIL + 1]],
  [[3, 12, RAIL + 1], [6, 12, ROOF]],
  [[FACE, FLANKS[0], RAIL], [...twin(FACE, FLANKS[1]), ROOF]], // the south bridge
];
const SLOPED = new Set(); // the slopes' cells, open over the track
for (const [i, j, L] of [[3, 10, RAIL], [3, 10, RAIL + 1], [3, 11, RAIL], [3, 11, RAIL + 1], [4, 12, RAIL + 1], [5, 12, RAIL + 1], [4, 12, ROOF], [5, 12, ROOF]]) set(i, j, L, VOID), SLOPED.add((L * NI + i) * NJ + j);
set(3, 12, RAIL + 1, FLOOR); // the corner between them

// The canal's boats, [x0, z0, x1, z1, turn] (9 m tall, turned `turn` degrees), moored clear of the
// Bridge, the stair and the pads (the twin adds as many).
const BOATS = [
  [X(GORGE) + 12, Z(3) + 4, X(GORGE) + 24, Z(4) + 6, 10],
  [X(GORGE) + 10, Z(10) + 2, X(GORGE) + 22, Z(11) + 4, -8],
];

const key = (i, j, L) => (L * NI + i) * NJ + j;
// Cells something lands on, climbs from or runs through: nothing's put up on them.
const special = new Set();
const mark = (i, j, L) => special.add(key(i, j, L));
for (const { i, j, L, to } of SHAFTS) for (const [a, b, c] of [[i, j, L], [i + to[0], j + to[1], L + 2], [i, j, L + 1], [i, j, L + 2]]) mark(a, b, c);
for (const { i, j } of SLOTS) for (let L = 0; L < LEVELS; L++) for (const [a, b] of [[i, j], [i, j + 1], [i, j + 2], [i, j + 3], [i - 1, j], [i - 1, j + 3]]) mark(a, b, L);
for (let i = 0; i <= 3; i++) for (let j = 4; j <= 9; j++) mark(i, j, SPAWN);
for (const [i, j] of STAND) mark(i, j, SPAWN); // the flag stand's walls are its own
for (let k = 1; k < TRACK.length; k++) for (let t = 0; t <= 1; t += 1 / 16) { // the track: the convoy's way
  const [x, z, y] = TRACK[k - 1].map((v, m) => v + (TRACK[k][m] - v) * t);
  mark(Math.floor((x + W / 2) / CELL), Math.floor((z + D / 2) / CELL), Math.round(y / STORY));
}
for (const { i, j, w, d, floor } of WELLS) for (let a = i; a < i + w; a++) for (let b = j; b < j + d; b++) mark(a, b, floor); // (silo A's on one)

// --- Links between cells, and a check that every floor's reachable from the spawn and back ---------
function standable(i, j, L) {
  return get(i, j, L) === FLOOR;
}
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
  for (const [p, q] of CLIMBS) for (const [a, b] of [[p, q], [[...twin(p[0], p[1]), p[2]], [...twin(q[0], q[1]), q[2]]]]) add(a, b), add(b, a);
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
const HOME = [1, 6, SPAWN];
{
  const out = links(), there = reachable(HOME, out, false), back = reachable(HOME, out, true), stuck = [];
  for (let L = 0; L < LEVELS; L++) for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
    if (grid[L][i][j] === FLOOR && !(there.has(key(i, j, L)) && back.has(key(i, j, L)))) stuck.push(`${i},${j} on ${L}`);
  }
  if (stuck.length) throw new Error(`floor you can't get to and back from: ${stuck.join('; ')}`);
}

// --- The lots: the city as it was built, block by block ----------------------------------------------
// Each lot (a run of whole cells) is one owner's building: its storeys merge into blocks of its own
// colours, and its walls meet the next lot's flush. Columns of lots over cells [i0, i1), each split
// into rows [j0, j1); the chasm's columns are one more.
const LOTS = [
  { i: [0, 3], rows: [[0, 5], [5, 9], [9, 14]] },
  { i: [3, 6], rows: [[0, 4], [4, 9], [9, 14]] },
  { i: [6, 8], rows: [[0, 5], [5, 9], [9, 14]] },
  { i: [8, 10], rows: [[0, 14]] },
];
const lotOf = (i, j) => {
  const c = LOTS.findIndex(({ i: [i0, i1] }) => i >= i0 && i < i1);
  return `${c}.${LOTS[c].rows.findIndex(([j0, j1]) => j >= j0 && j < j1)}`;
};
/** The plan's point [x, y, z], as a placed point. */
const at = (x, y, z) => [r3(x), y, r3(z)];
const flip = ([x, y, z]) => [r3(-x) || 0, y, r3(-z) || 0];
/** A plan polyline [[x, z, y], ...] with a point every cell or so along it. */
const along = (line) => {
  const out = [at(line[0][0], line[0][2], line[0][1])];
  for (let k = 1; k < line.length; k++) {
    const [[x0, z0, y0], [x1, z1, y1]] = [line[k - 1], line[k]], n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / CELL);
    for (let s = 1; s <= n; s++) out.push(at(x0 + ((x1 - x0) * s) / n, r3(y0 + ((y1 - y0) * s) / n), z0 + ((z1 - z0) * s) / n));
  }
  return out;
};
/** A box over the plan's rectangle (x0, z0)-(x1, z1), y0 to y1, coloured `color`. */
const block = (x0, z0, x1, z1, y0, y1, mat, color) => {
  box([x0, y0, z0], [x1, y1, z1], mat);
  solids[solids.length - 1].color = color;
};

if (grid[SPAWN][FLAG[0]][FLAG[1]] !== FLOOR) throw new Error('the flag stand\'s cell was cut off');
// Each building's own walls, by band of levels (0-2, 3-5, 6 up), so you can tell how deep you are:
// grey and damp down by the canal, drier higher up, and bright where the sky reaches. The west's
// painted plaster, the east's faded tile and stained concrete; floors darken with them.
const band = (L) => Math.min(2, Math.floor(L / 3));
const WALLS = {
  west: [
    ['#6b6052', '#615a50', '#71675a', '#5a5249', '#675d55'],
    ['#9c8770', '#988a76', '#a58a72', '#8f8572', '#ab9478'],
    ['#d0ad82', '#ddc59e', '#c7967a', '#d6c192', '#bfae8a', '#d4a888', '#c6b493', '#e6d1ad'],
  ],
  east: [
    ['#454b48', '#40474b', '#4b4d47', '#3b4240', '#4a4644'],
    ['#606660', '#5b6468', '#687066', '#6b655a', '#646460'],
    ['#8b9086', '#86929a', '#97a294', '#a09584', '#a4a49d', '#7f8b84', '#958a84', '#8a9da5'],
  ],
};
const FLOORS = { west: ['#5c4a3f', '#7d5a46', '#a2704f'], east: ['#4a4c46', '#62645c', '#808279'] };
/** A stable random in [0, 1) for whatever stands at (a, b, c). */
const hue = (a, b, c = 0) => {
  const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return h - Math.floor(h);
};
const wallOf = (list, a, b, c) => list[Math.floor(hue(a, b, c) * list.length)];
const westWall = (i, j, L) => wallOf(WALLS.west[band(L)], i, j, L);
// The height of each tower's roof (where building reaches the top), for what's put up on them.
const tops = Array.from({ length: HALF }, () => Array(NJ).fill(undefined));

// --- Geometry: building masses, floor slabs where nothing's under them --------------------------
// Building, the chasm's columns too (where the Bridge stands): each lot's solid cells merge into
// blocks as big as they'll go within a band of levels (each band its own colours). A floor slab under
// every walkable cell that isn't on building, merged with its lot's neighbours'. A quarter of the
// roofs' towers rise a storey higher.
{
  const done = new Set();
  for (let L = 0; L < LEVELS; L++) for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
    if (grid[L][i][j] !== SOLID || done.has(key(i, j, L))) continue;
    const f = lotOf(i, j), free = (a, b, c) => a < HALF && b < NJ && c < LEVELS && band(c) === band(L) && lotOf(a, b) === f && grid[c][a][b] === SOLID && !done.has(key(a, b, c));
    let i1 = i, j1 = j, L1 = L;
    while (free(i1 + 1, j, L)) i1++;
    const rowOk = (b) => { for (let a = i; a <= i1; a++) if (!free(a, b, L)) return false; return true; };
    while (rowOk(j1 + 1)) j1++;
    const layerOk = (c) => { for (let a = i; a <= i1; a++) for (let b = j; b <= j1; b++) if (!free(a, b, c)) return false; return true; };
    while (layerOk(L1 + 1)) L1++;
    for (let c = L; c <= L1; c++) for (let a = i; a <= i1; a++) for (let b = j; b <= j1; b++) done.add(key(a, b, c));
    block(X(i), Z(j), X(i1 + 1), Z(j1 + 1), Y(L), Y(L1 + 1), 'plaster', westWall(i, j, L));
  }
  const storeys = rng(31), slabbed = new Set();
  const slab = (i, j, L) => grid[L][i][j] === FLOOR && !(L && grid[L - 1][i][j] === SOLID) && !slabbed.has(key(i, j, L));
  for (let i = 0; i < HALF; i++) for (let j = 0; j < NJ; j++) {
    if (i < GORGE && grid[LEVELS - 1][i][j] === SOLID) {
      const up = storeys() < 0.25 ? STORY : 0;
      tops[i][j] = Y(LEVELS) + up;
      if (up) block(X(i), Z(j), X(i + 1), Z(j + 1), Y(LEVELS), Y(LEVELS) + up, 'plaster', westWall(i, j, LEVELS));
    }
    for (let L = 0; L < LEVELS; L++) {
      if (!slab(i, j, L)) continue;
      const f = lotOf(i, j), more = (a, b) => a < HALF && b < NJ && lotOf(a, b) === f && slab(a, b, L);
      let i1 = i, j1 = j;
      while (more(i1 + 1, j)) i1++;
      const rowOk = (b) => { for (let a = i; a <= i1; a++) if (!more(a, b)) return false; return true; };
      while (rowOk(j1 + 1)) j1++;
      for (let a = i; a <= i1; a++) for (let b = j; b <= j1; b++) slabbed.add(key(a, b, L));
      block(X(i), Z(j), X(i1 + 1), Z(j1 + 1), Y(L) - 1, Y(L), 'terracotta', FLOORS.west[band(L)]);
    }
  }
}
// The edges: ground under the canal, walls round the map.
box([-W / 2, -2, -D / 2], [0, -1, D / 2], 'ground'); // (where the haze lies)
box([W / 2, -2, -D / 2], [W / 2 + 1, Y(LEVELS) + 12, D / 2], 'stone');
box([-W / 2, -2, D / 2], [W / 2, Y(LEVELS) + 12, D / 2 + 1], 'stone');

// The monorail's slopes: wedges of floor up through the buildings, solid under them; the south bridge
// (its twin the north), a deck with parapets along both edges, cover for the convoy's escort.
for (let k = 1; k < TRACK.length; k++) {
  const [[x0, z0, y0], [x1, z1, y1]] = [TRACK[k - 1], TRACK[k]];
  if (y0 === y1) continue;
  slope(at(x0, y0, z0), at(x1, y1, z1), CELL - 1, STORY / 2, 'terracotta');
  solids[solids.length - 1].color = FLOORS.west[band(RAIL)];
}
{
  const [[x0, z0, y0], [x1, , y1]] = BRIDGE;
  slope([x0, y0, z0], [x1, y1, z0], CELL, 1, 'concrete');
  for (const z of [Z(FLANKS[0]) + 0.3, Z(FLANKS[0] + 1) - 0.3]) beam([x0, y0 + 1.5, z], [x1, y1 + 1.5, z], 0.6, 3, 'lacquer');
}

// The canal: boats moored along it, staggered across it and askew, so no lane runs its length (the twin adds as many).
for (const [x0, z0, x1, z1, turn] of BOATS) turned([r3((x0 + x1) / 2), 4.5, r3((z0 + z1) / 2)], [r3((x1 - x0) / 2), 4.5, r3((z1 - z0) / 2)], turn, 'hull');

// --- The ramp slots' flights ----------------------------------------------------------------------
for (const { i, j, from } of SLOTS) {
  for (let L = from; L < LEVELS - 1; L++) {
    const north = (L - from) % 2 === 0, lane = north ? X(i) + 4 : X(i) + 12;
    const [z0, z1] = [Z(j + 1), Z(j + 3)], [lo, hi] = north ? [z0, z1] : [z1, z0];
    const [a, b] = [at(lane, Y(L), lo), at(lane, Y(L + 1), hi)];
    ramp(a, b, 7.5, 'metal', false);
    point([r3((a[0] + b[0]) / 2), Y(L) + STORY / 2, r3((a[2] + b[2]) / 2)]); // mid-flight (on it): the landings are too far apart to link
    point(at(lane, Y(L + 1), hi + (north ? 3 : -3))); // and off its top, straight on, clear of the next flight
  }
  for (const b of [j + 1, j + 2]) point(at(X(i) + 12, Y(from), cz(b))); // the slot's floor, in the lane the first flight leaves open
}

// --- The plaza: a shrine before each gate, stalls in its corners, clear of its waypoints and B's pad -
// The shrine, 10 m wide and taller than a Heavy, breaks the line from gate to gate (the twin adds the other).
turned([-14, Y(PLAZA) + 3.5, 0], [2, 3.5, 5], 0, 'lacquer');
for (const z of [-16, 16]) turned([-16, Y(PLAZA) + 2.5, z], [3, 2.5, 3], z > 0 ? 8 : -8, 'pale');

// --- Pads in their shafts: launched off-centre, away from the landing, so the arc clears the walls --
// and topping out low enough that a Heavy's head clears the floor over the landing.
for (const { i, j, L, to } of SHAFTS) pad(at(cx(i) - to[0] * 4, Y(L), cz(j) - to[1] * 4), at(cx(i + to[0]), Y(L + 2), cz(j + to[1])), Y(L + 2) + 4);

// --- Growth: what the city's added since, at any angle --------------------------------------------
// Shacks and water tanks on the open roofs, each in a corner of its cell, clear of the way through
// its middle, turned however it was set down.
{
  const grow = rng(77);
  for (let i = 0; i < FACE + 1; i++) for (let j = 0; j < NJ; j++) for (let L = 6; L < LEVELS; L++) {
    if (grid[L][i][j] !== FLOOR || special.has(key(i, j, L))) continue;
    let sky = true;
    for (let M = L + 1; M < LEVELS; M++) if (grid[M][i][j] !== VOID) sky = false;
    if (!sky || grow() > 0.3) continue;
    const [sx, sz] = [[1, 1], [1, -1], [-1, 1], [-1, -1]][Math.floor(grow() * 4)], [x, , z] = at(cx(i) + sx * 5, 0, cz(j) + sz * 5);
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
  if (L === 0 && BOATS.some(([x0, z0, x1, z1]) => cx(i) > x0 - 5 && cx(i) < x1 + 5 && cz(j) > z0 - 5 && cz(j) < z1 + 5)) continue; // a canal block stands there
  if (SLOTS.some((s) => s.i === i && s.from === L && (j === s.j + 1 || j === s.j + 2))) continue; // a flight starts there
  point(at(cx(i), Y(L), cz(j)));
}
// And along the monorail's slopes and the south bridge (the twin adds the north's).
for (let k = 1; k < TRACK.length; k++) if (TRACK[k - 1][2] !== TRACK[k][2]) point(...along([TRACK[k - 1], TRACK[k]]).slice(1, -1));
point(...along(BRIDGE).slice(1, -1));

// --- Objectives ----------------------------------------------------------------------------------
bases(at(cx(0), Y(RAIL), 0));
sentries([at(cx(2) + 4, Y(SPAWN), cz(5)), at(cx(2) + 4, Y(SPAWN), cz(8))]);
// The flag stand's doorways face south and east, toward the plaza, away from its guns in the hall.
flags(flagStand(at(cx(FLAG[0]), Y(SPAWN), cz(FLAG[1])), 0));
// The convoy: from the middle of the south bridge along the track to each base, 256 m either way in
// plan: down the bridge and round the south side to team 0's, up it and round the east's north side
// (the twin of the west's, climbing down) to team 1's.
const BASE = TRACK.findIndex(([x, z]) => x === cx(0) && z > 0); // the corner past the base, going round
convoy(
  along([[0, cz(FLANKS[0]), Y(RAIL + 1)], ...TRACK.slice(0, BASE), [cx(0), 0, Y(RAIL)]]),
  along([[0, cz(FLANKS[1]), Y(RAIL + 1)], ...TRACK.slice(BASE).reverse(), [cx(0), 0, Y(RAIL)]]).map(flip),
);
const A = WELLS[1]; // (open to the sky, for its launch pad)
// A in the well's far half, clear of its pad (in the near half, under the gallery it throws you onto).
silos({ at: at(X(A.i + 1), Y(A.floor), cz(A.j + 1)), radius: 10, band: 4 }, { at: [0, Y(PLAZA), 0], radius: 14, band: 4 });

// --- Dressing: the two sides of the chasm ----------------------------------------------------------
// The same building on both sides; only what it's made of and what hangs in it differ. The west, old
// money: warm plaster with lamplit windows, tiled floors, red lacquer screens and pillars, paper
// lanterns under the ceilings, gilt rails along the chasm, gardens and lamps on the roofs, its neon
// red and gold. The east, the tenements: grimy concrete with fluorescent windows, rust, tubes in
// nearly every room, pipes and boxes on the walls, cables and washing strung across, its neon pink
// and cyan. Each side's props are placed on the west's plan and set down on their own side.
const EAST = { plaster: 'tenement', terracotta: 'grime', lacquer: 'rust', pale: 'rust', tank: 'rust' };
const LANTERNS = ['#ff9a3a', '#ff6a32', '#ffc060'], TUBES = ['#dffff0', '#dffff0', '#c4f2ff', '#f0ffe0'];
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
    decor.push({ kind, from: [r3(u - hx), r3(y - hy), r3(w - hz)], to: [r3(u + hx), r3(y + hy), r3(w + hz)], yaw: east ? 180 : 0, ...extra });
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
    let M = L + 1; // what's over it: the storey of its ceiling, or the sky
    while (M < LEVELS && grid[M][i][j] === VOID) M++;
    const [x, z] = [cx(i), cz(j)], sky = M === LEVELS, roofed = !sky, top = Y(M) - 1;
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
      if (east && r() < 0.2) line('pipe', onSide(i, j, s, 0.04, 0.5, Y(L) + r(7, 9)), onSide(i, j, s, 0.96, 0.5, Y(L) + r(7, 9)), { r: r3(r(0.15, 0.3)) });
      if (east && r() < 0.12) {
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
    if (east && roofed && r() < 0.25) {
      // A cable strung across, from wall to wall.
      const s = Math.floor(r() * 4), y = top - r(1, 3);
      line('pipe', onSide(i, j, s, r(0.1, 0.9), 0.2, y), onSide(i, j, (s + 2) % 4, r(0.1, 0.9), 0.2, y - r(0, 1.5)), { r: 0.05 });
    }
    if (east && (sky || L === 0) && r() < 0.2) {
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
        if (get(i + di, j + dj, L) === VOID && !(i === FACE && di === 1) && !SLOPED.has(key(i + di, j + dj, L))) line('railing', onSide(i, j, s, 0.04, 0.4, Y(L)), onSide(i, j, s, 0.96, 0.4, Y(L)), { color: east ? '#5f6466' : '#9c7a3c' });
      }
      if (r() < 0.25) pole(x + Math.sign(ox || 1) * 6.5, Y(L), z + Math.sign(oz || 1) * 6.5, r(6, 9));
    }
    if (sky && L >= 5 && i < FACE && !special.has(key(i, j, L))) {
      if (!east && r() < 0.4) prop('slab', [x - ox * 0.6, Y(L) + 0.4, z + 6.5 * Math.sign(oz || 1)], [2.2, 0.4, 0.6], { mat: 'moss' }); // a planter
      if (!east && r() < 0.35) decor.push({ kind: 'lamp', at: here(x + ox, Y(L), z - oz) });
      if (east && r() < 0.2) line('pipe', [x + ox, Y(L), z + oz], [x + ox, Y(L) + r(4, 9), z + oz], { r: 0.08 }); // an aerial
    }
  }
  // The chasm's face: a balcony's edge gets a rail.
  for (let L = 1; L < LEVELS; L++) for (let j = 0; j < NJ; j++) {
    const foot = CLIMBS[2].some(([i, k, M]) => i === FACE && k === j && M === L) || (L === ROOF && j === FLANKS[1]); // where a bridge meets the face
    if (grid[L][GORGE][j] === VOID && grid[L][FACE][j] === FLOOR && !foot) line('railing', [X(GORGE) - 0.3, Y(L), Z(j) + 0.6], [X(GORGE) - 0.3, Y(L), Z(j + 1) - 0.6], east ? { color: '#6d7376' } : {});
  }
  // Neon, Hong Kong style (see web/neon.js): boards of glyphs in no particular script, under tube
  // outlines and bulbs or on lightboxes, long, tall, square, pill- and arch-shaped, emblems (discs,
  // diamonds, octagons) and pawnshop signs (a tall board under an emblem), warm in the west and cold
  // in the east. Down low they crowd out from the walls on brackets, the long ones spanning the
  // street: off the docks' back wall, out over the canal and the plaza from both faces and the
  // Bridge's sides, over the square and round the courtyard, the well and the low road. Higher up the
  // faces they hang flat on the walls, fewer. One in six lights the walls round it; none collides,
  // and none hangs lower than a Heavy's head.
  /** A neon board [w, h, emblem] on the wall at open cell (i, j)'s side `s`, `t` along it, its middle `y` up: out from the wall on a bracket, or `flat` on it. */
  const neon = (i, j, s, t, y, [w, h, emblem], flat = false) => {
    const [di] = SIDES[s];
    decor.push({ kind: 'neon', at: here(...onSide(i, j, s, t, flat ? 0.3 : 0.6 + w / 2, y)), size: [r3(w), r3(h)], yaw: (di !== 0) === flat ? 90 : 0, tone: east ? 'cool' : 'warm', ...(emblem && { emblem }), ...(r() < 0.16 && { light: [16, 2] }) });
    if (!flat) line('pipe', onSide(i, j, s, t, 0, y + h / 2 + 0.3), onSide(i, j, s, t, w + 0.6, y + h / 2 + 0.3), { r: 0.06, color: '#2a2a2a' });
  };
  /** A sign's size [w, h, emblem], no taller than `most` nor longer than `long`: a long board across the street, a tall one, an emblem or a lightbox. */
  const sign = (most = 16, long = 18) => {
    const k = r();
    if (k < 0.4) {
      const w = r(long / 2, long);
      return [w, Math.min(Math.max(w / r(3, 6), 2), 5, most)];
    }
    if (k < 0.68 && most >= 6) {
      const w = r(2.5, 5);
      return [w, Math.min(w * r(2.5, 4), most)];
    }
    if (k < 0.84) {
      const d = r(3, Math.min(9, most));
      return [d, d, true];
    }
    return [r(3, 7), r(2.5, Math.min(6, most))];
  };
  /** A sign, or now and then (when there's height for it) a pawnshop's: a tall board under an emblem, out on the same line, together centred `y` up. */
  const signs = (i, j, s, t, y, most, long) => {
    if (most < 12 || r() > 0.15) return neon(i, j, s, t, y, sign(most, long));
    const w = r(3, 4.5), d = w * 1.3, h = Math.min(w * r(2.5, 3.5), most - d - 0.5), low = y - (d + 0.5) / 2;
    neon(i, j, s, t, low, [w, h]);
    neon(i, j, s, t, low + h / 2 + 0.5 + d / 2, [d, d, true]);
  };
  /** Every wall round open cells at level L that `open` picks, the wall at level `M`: each gets `n()` signs across it, centred `y()` up, sized by `fit` ([most, long] for `sign`). */
  const walls = (L, open, M, n, y, fit) => {
    for (let i = 0; i <= FACE; i++) for (let j = 0; j < NJ; j++) {
      if (grid[L][i][j] !== FLOOR || !open(i, j)) continue;
      for (let s = 0; s < 4; s++) {
        const [di, dj] = SIDES[s];
        if (get(i + di, j + dj, M) !== SOLID) continue;
        for (let k = 0, m = n(); k < m; k++) signs(i, j, s, (k + 0.5) / m + r(-0.06, 0.06), y(), ...fit);
      }
    }
  };
  const stairs = (j) => j >= FLANKS[0] && j <= FLANKS[0] + 3, ladder = (j) => j === 9 || j === 10;
  walls(CANAL, (i, j) => i === FACE && !stairs(j) && !ladder(j), CANAL, () => 2, () => r(8, 9.5), [3, 12]); // the docks, under the face
  for (let L = 1; L < LEVELS; L++) for (let j = 0; j < NJ; j++) {
    // The faces: crowded low, up to just over the plaza (clear of the bridges), flat and fewer higher up.
    if (grid[L][GORGE][j] !== VOID || grid[L][FACE][j] !== SOLID) continue;
    if (L < RAIL && !(L === RAIL - 1 && FLANKS.includes(j))) for (let k = 0, m = 3 + Math.floor(r() * 2); k < m; k++) signs(GORGE, j, 3, (k + 0.5) / m + r(-0.05, 0.05), Y(L) + r(3, 9), 16, 18);
    else if (L >= RAIL && !FLANKS.includes(j) && r() < 0.5) {
      const size = sign(8, 12);
      neon(GORGE, j, 3, 0.5 + r(-1, 1) * Math.max(0, (CELL - size[0]) / (2 * CELL)), Y(L) + r(4, 8), size, true); // (inside its cell)
    }
  }
  // The Bridge's sides, out over the canal under it (clear of the face's, which reach 19 m out).
  for (let L = 1; L < PLAZA; L++) for (const [j, s] of [[SPAN[0] - 1, 2], [SPAN[1] + 1, 0]]) for (const [i, t] of [[GORGE + 1, 0.25], [GORGE + 1, 0.75]]) {
    if (grid[L][i][j] === VOID) signs(i, j, s, t + r(-0.04, 0.04), Y(L) + r(3, 9), 14, 14);
  }
  const square = (i, j) => i >= 4 && j >= SPAN[0] && j <= SPAN[1] && grid[SPAWN + 1][i][j] === VOID;
  walls(SPAWN, square, SPAWN, () => 2, () => Y(SPAWN) + r(8, 9.5), [3, 10]); // the square, under its first storey's top
  walls(SPAWN, square, SPAWN + 1, () => 1 + Math.floor(r() * 2), () => Y(SPAWN + 1) + r(3, 5.5), [8, 14]); // and high over it
  walls(SPAWN, (i, j) => grid[SPAWN + 1][i][j] === VOID && !square(i, j), SPAWN, () => 1 + Math.floor(r() * 2), () => Y(SPAWN) + r(9.5, 12), [5, 12]); // the courtyard
  walls(LOW, () => r() < 0.5, LOW, () => 1, () => Y(LOW) + r(8.4, 9), [2.8, 9]); // the low road and the well
  // The towers' roofs: one thing gone up on each, now and then: a shed under a pitched corrugated
  // sheet on posts, a stair hut or a tank on legs; a neon billboard on a few of the east's. None of
  // it collides: only the towers do.
  for (let i = 0; i <= FACE; i++) for (let j = 0; j < NJ; j++) {
    const top = tops[i][j];
    if (top === undefined) continue;
    const [x, z] = [cx(i), cz(j)], spot = (m) => [x + r(-m, m), z + r(-m, m)], roll = r();
    if (roll < 0.3) {
      // A shed: a corrugated roof pitched (its -Z edge up) on four posts.
      const [u, w] = spot(3.5), [hw, hd] = r() < 0.5 ? [r(2, 3.8), r(1.5, 2.6)] : [r(1.5, 2.6), r(2, 3.8)];
      const h = top + r(2.6, 3.6), tilt = r(6, 14), rise = hd * Math.sin((tilt * Math.PI) / 180);
      prop('roof', [u, h, w], [hw, 0.05, hd], { color: pick(east ? SHEETS_EAST : SHEETS_WEST), tilt: r3(tilt) });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const [pu, pw] = [u + sx * (hw - 0.3), w + sz * (hd - 0.3)];
        line('pipe', [pu, top, pw], [pu, h - sz * rise, pw], { r: 0.08, color: '#3a3c3f' });
      }
    } else if (roll < 0.5) {
      const [u, w] = spot(5);
      prop('slab', [u, top + 1.5, w], [r(1.4, 2.4), 1.5, r(1.4, 2.2)], { color: east ? '#74776f' : '#bba88a' }); // a stair hut
    } else if (roll < 0.65) {
      // A tank on legs.
      const [u, w] = spot(4.5), [rad, leg] = [r(1.2, 1.8), r(1.6, 2.6)];
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) line('pipe', [u + sx * rad * 0.6, top, w + sz * rad * 0.6], [u + sx * rad * 0.6, top + leg, w + sz * rad * 0.6], { r: 0.1, color: '#3a3c3f' });
      line('pipe', [u, top + leg, w], [u, top + leg + r(2.2, 3.6), w], { r: r3(rad), color: pick(east ? ['#6e5a48', '#7a7468', '#5f6a6a'] : ['#8a7a62', '#9a8a6a', '#7d6a55']) });
    }
    if (east && r() < 0.12) {
      // A neon billboard on two legs, facing out over an edge.
      const y = top + r(5, 8), s = Math.floor(r() * 4), [di, dj] = SIDES[s];
      for (const t of [0.25, 0.75]) {
        const a = onSide(i, j, s, t, 2, top);
        line('pipe', a, [a[0], y, a[2]], { r: 0.12, color: '#3a3430' });
      }
      decor.push({ kind: 'neon', at: here(...onSide(i, j, s, 0.5, 2, y + 1.6)), size: [7.2, 3.2], yaw: di ? 90 : 0, tone: 'cool', light: [18, 2.2] });
    }
  }
  // A cable slung from each pole to its nearest, sagging; lanterns strung along some of the west's.
  poles.forEach((p, n) => {
    const away = (q) => Math.hypot(q[0] - p[0], q[2] - p[2]);
    for (const q of poles.slice(n + 1).filter((q) => away(q) > 6 && away(q) < 36).sort((a, b) => away(a) - away(b)).slice(0, 1)) {
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
  // The Bridge's sign down the chasm, on its half of the Bridge.
  decor.push({ kind: 'neon', at: here(X(GORGE) + 16, Y(2) + 6, Z(SPAN[0]) - 0.4), size: [12, 6], yaw: 0, tone: east ? 'cool' : 'warm', light: [22, 2.4] });
  // The plaza: rails along its edges over the chasm, lamps by its stalls.
  for (const z of [Z(SPAN[0]) + 0.4, Z(SPAN[1] + 1) - 0.4]) line('railing', [X(GORGE) + 0.4, Y(PLAZA), z], [0, Y(PLAZA), z], east ? { color: '#6d7376' } : {});
  for (const z of [-21, 21]) decor.push({ kind: 'lamp', at: here(-21, Y(PLAZA), z) });
  // The hall under it: lanterns (west) or tubes (east) down its middle.
  for (const x of [X(GORGE) + 8, X(GORGE) + 24]) {
    light([x, Y(HALL + 1) - (east ? 0.4 : 2.6), 0], east ? [1.3, 0.06, 0.1] : [0.55, 0.75, 0.55], east ? TUBES[0] : LANTERNS[0], [x, Y(HALL) + 6, 0], [16, 3]);
  }
  // The docks: lamps along the west's, steam off the water by the east's.
  for (let j = 0; j < NJ; j += 2) {
    const z = cz(j) + r(-4, 4);
    if (!east) decor.push({ kind: 'lamp', at: here(X(FACE) + 13, 0, z) });
    if (east && r() < 0.5) decor.push({ kind: 'steam', at: here(X(GORGE) + r(2, 30), 0.8, cz(j) + r(-6, 6)) });
  }
}
// Across the chasm: cables slung from face to face, and the monorail's track round its whole loop.
{
  const r = rng(616);
  for (let k = 0; k < 6; k++) {
    const [y, za, zb] = [r(14, 100), r(-100, 100), r(-100, 100)], [a, b] = [[X(GORGE), za], [X(NI - GORGE), zb]];
    const mid = [(a[0] + b[0]) / 2, y - r(2, 5), (a[1] + b[1]) / 2];
    decor.push({ kind: 'pipe', from: [r3(a[0]), r3(y), r3(a[1])], to: mid.map(r3), r: 0.07 }, { kind: 'pipe', from: mid.map(r3), to: [r3(b[0]), r3(y + r(-2, 2)), r3(b[1])], r: 0.07 });
  }
  const track = [along(TRACK), along(BRIDGE)];
  for (const p of [...track, ...track.map((q) => q.map(flip))]) {
    for (let k = 1; k < p.length; k++) {
      const [a, b] = [p[k - 1], p[k]], d = Math.hypot(b[0] - a[0], b[2] - a[2]), [nx, nz] = [-(b[2] - a[2]) / d, (b[0] - a[0]) / d];
      for (const o of [-0.9, 0.9]) decor.push({ kind: 'pipe', from: [r3(a[0] + nx * o), a[1] + 0.12, r3(a[2] + nz * o)], to: [r3(b[0] + nx * o), b[1] + 0.12, r3(b[2] + nz * o)], r: 0.1 });
    }
  }
}

// --- Spawns, twin, write ---------------------------------------------------------------------------
const north = [];
for (const [i, j] of [[1, 5], [1, 6], [1, 7], [2, 5], [2, 6], [2, 7], [2, 8]]) north.push(at(cx(i), Y(SPAWN) + 0.1, cz(j))); // (the pad's in the hall's last corner)
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
  const box = flip(s.box), b = band(Math.round((s.box[1] - s.half[1]) / STORY)); // (a slab's underside is a metre under its level)
  const color = s.color && (s.mat === 'terracotta' ? FLOORS.east[b] : wallOf(WALLS.east[b], box[0], box[2], box[1]));
  solids.push({ ...s, box, mat: EAST[s.mat] ?? s.mat, ...(color && { color }), ...((s.yaw !== undefined || s.tilt) && { yaw: r3((s.yaw ?? 0) + 180) }) });
}
for (const p of [...nav]) nav.push(flip(p));
for (const p of [...pads]) pads.push({ at: flip(p.at), to: flip(p.to), apex: p.apex });
write(new URL('./walled.json', import.meta.url), { name: 'Walled City', size: [W, D], night: true, palette }, north, north.map(flip));
