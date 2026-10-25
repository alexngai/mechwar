// Canopy: a 360 m forest. A rounded triangle of rolling ground walled by
// cliffs. The two bases, eco-stations, hold its south corners; the north corner, the Crown, is a
// rise under the mother tree, ringed by the station's old deck 9 m up. Between them:
// - the Knoll, a hill mid-map under a rock table, an overlook two sides can hold against each other;
// - the Gorge up the west flank, a 15 m canyon with sheer walls, out only at its ends, up a breach
//   in its east wall, or by the pad on its floor; a fallen giant and a stone arch bridge it;
// - the Pulpit, a rock pillar on the Gorge's west rim, up a fallen trunk: the west's overlook;
// - the Spine up the east flank, a stone ridge 14 m high, walkable along its crest from either
//   end, with a tunnel through it: the east's overlook and its choke;
// - the Gate, a giant standing on its roots over the south road, and the Teeth, rocks across it;
// - giants leaning and fallen at all angles, standing in for buildings.
// Writes canopy.json next to this file; rerun `node maps/canopy.mjs` after editing.
//
// Asymmetric: all of it is authored here and `write` gets both teams' spawns. Each base has a flank
// with an overlook and a pad up to it, about as far from the Knoll and the Crown as the other's.
// Metrics as the other maps': 6.5 m+ under decks, ramps near 24 degrees, hover ledges 3-4 m. Ground
// over 40 degrees can't be walked up (tuning's max_slope_deg), which makes the cliffs walls.
import { bases, beam, box, cylinder, decor, ground, heightAt, lamp, pad, point, r3, railing, ramp, sentries, siege, sign, silos, solids, turned, write } from './kit.mjs';

const SIZE = [360, 360], CELL = 4;
const A = [-140, -118], B = [140, -118], C = [0, 140], ROUND = 30; // the playable triangle, grown ROUND m
const BASES = [[-122, -102], [122, -102]]; // west (team 0), east (team 1)
const KNOLL = [6, -18], CROWN = [0, 112], HOLLOW = [0, -98], PULPIT = [-86, 30], GATE = [-52, -94];
const GORGE = [[-96, -70], [-80, -20], [-62, 30], [-40, 76]];
const SPINE = [[104, -72], [86, -14], [68, 40], [50, 80]];
const GORGE_FLOOR = -13, BREACH = 88; // the breach: this far along the Gorge, up its east wall
const TUNNEL = 92; // this far along the Spine
const GREEN = '#7dffb0', AMBER = '#ffc46b', LANTERN = '#ffa040';

// --- Shapes ------------------------------------------------------------------------------------------
const clamp01 = (t) => Math.min(Math.max(t, 0), 1);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const dist = ([ax, az], [bx, bz]) => Math.hypot(ax - bx, az - bz);
const deg = (rad) => r3((rad * 180) / Math.PI);
/** Distance from `p` to the segment `a`-`b`. */
function segment([px, pz], [ax, az], [bx, bz]) {
  const [ex, ez] = [bx - ax, bz - az], t = clamp01(((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez));
  return Math.hypot(px - ax - ex * t, pz - az - ez * t);
}
const length = (pts) => pts.slice(1).reduce((sum, b, i) => sum + dist(pts[i], b), 0);
/** `p` against the polyline `pts`: distance `d`, distance `s` along it, and `side`, -1 to the right of travel. */
function along(p, pts) {
  let best = { d: Infinity }, s0 = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], [ex, ez] = [b[0] - a[0], b[1] - a[1]], len = Math.hypot(ex, ez);
    const t = clamp01(((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / (len * len)), d = dist(p, [a[0] + ex * t, a[1] + ez * t]);
    if (d < best.d) best = { d, s: s0 + t * len, side: Math.sign(ex * (p[1] - a[1]) - ez * (p[0] - a[0])) };
    s0 += len;
  }
  return best;
}
/** The point `s` m along the polyline `pts`, its direction there, and the perpendicular to its right. */
function station(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], len = dist(a, b);
    if (s <= len || i === pts.length - 1) {
      const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      return { at: [a[0] + dir[0] * s, a[1] + dir[1] * s], dir, right: [dir[1], -dir[0]] };
    }
    s -= len;
  }
}
const offset = ([x, z], [dx, dz], k) => [x + dx * k, z + dz * k];
const lift = ([x, z], y) => [x, y, z];
/** Signed distance to the edge of the playable ground: the triangle A B C grown ROUND m. */
function edge(p) {
  const corners = [A, B, C], inside = corners.every((a, i) => {
    const b = corners[(i + 1) % 3];
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
  });
  const d = Math.min(...corners.map((a, i) => segment(p, a, corners[(i + 1) % 3])));
  return (inside ? -d : d) - ROUND;
}

/** Smooth value noise in [-1, 1] on a unit lattice, the same on every run. */
function noise(x, z) {
  const hash = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const i = Math.floor(x), j = Math.floor(z), fx = smoothstep(0, 1, x - i), fz = smoothstep(0, 1, z - j);
  const [a, b, c, d] = [hash(i, j), hash(i + 1, j), hash(i, j + 1), hash(i + 1, j + 1)];
  return (a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz) * 2 - 1;
}
const bump = (p, at, h, sigma) => h * Math.exp(-(dist(p, at) ** 2) / (2 * sigma * sigma));
/** Seeded random in [lo, hi). */
function random(seed) {
  let s = seed;
  return (lo = 0, hi = 1) => lo + (hi - lo) * (((s = (s * 16807) % 2147483647) - 1) / 2147483646);
}

// --- Terrain -----------------------------------------------------------------------------------------
const LG = length(GORGE), LS = length(SPINE);
function height(x, z) {
  const p = [x, z];
  let h = 5 * noise(x / 90, z / 90) + 2.5 * noise(x / 40 + 7.3, z / 40 - 2.1) + noise(x / 18 - 4.4, z / 18 + 9.2);
  h += bump(p, KNOLL, 14, 22) + bump(p, CROWN, 8, 26) - bump(p, HOLLOW, 3, 22);
  h += 3 * Math.exp(-(along(p, SPINE).d ** 2) / (2 * 14 * 14)); // a swell for the Spine to stand on
  for (const b of BASES) h += (1 - h) * smoothstep(34, 18, dist(p, b)); // level clearings at 1 m
  // The Gorge: a level floor between walls too steep to climb, 7-14 m out, sloping up at its ends;
  // at the breach its east wall lies back to a 30 degree slope.
  const g = along(p, GORGE), ends = smoothstep(0, 40, g.s) * smoothstep(LG, LG - 34, g.s);
  const breach = g.side < 0 ? 1 - smoothstep(6, 16, Math.abs(g.s - BREACH)) : 0;
  h += (GORGE_FLOOR - h) * (1 - smoothstep(7, 14 + 32 * breach, g.d)) * ends;
  // The cliffs: a lip from 8 m inside the edge, then 58 degrees up, craggy, to a plateau no hover reaches.
  const w = edge(p) + 8;
  if (w > 0) h += Math.min(w < 8 ? (w * w) / 10 : 6.4 + (w - 8) * 1.6, 26) + 3 * smoothstep(8, 14, w) * noise(x / 11, z / 11);
  return h;
}
ground(SIZE, CELL, height);
const at = (x, z, up = 0) => [x, Math.round((heightAt(x, z) + up) * 100) / 100, z];

// --- Pieces ------------------------------------------------------------------------------------------
const keep = []; // [a, b, gap]: ground the forest keeps `gap` m clear of, along a to b
const clear = (a, b = a, gap = 8) => keep.push([a, b, gap]);

/**
 * A stone slab whose top surface runs from `low` to `high`, `width` m across and `depth` m deep
 * under it: ridge blocks, decks, ribs.
 */
function stone(low, high, width, depth, mat = 'stone') {
  const [dx, dy, dz] = [0, 1, 2].map((i) => high[i] - low[i]);
  const run = Math.hypot(dx, dz), tilt = Math.atan2(dy, run), yaw = Math.atan2(-dx, -dz);
  const n = [Math.sin(tilt) * Math.sin(yaw), Math.cos(tilt), Math.sin(tilt) * Math.cos(yaw)];
  const center = [0, 1, 2].map((i) => r3((low[i] + high[i]) / 2 - (depth / 2) * n[i]));
  turned(center, [width / 2, depth / 2, Math.hypot(run, dy) / 2].map(r3), deg(yaw), mat, deg(tilt));
}

/** A ramp from the ground toward `dir` ([dx, dz], unit) up to `top`, solid under, as long as it takes to climb at 24 degrees. */
function rampDown(top, dir, width, mat) {
  let len = 8;
  while (len < 60 && (top[1] - heightAt(top[0] + dir[0] * len, top[2] + dir[1] * len)) / len > Math.tan((24 * Math.PI) / 180)) len += 0.5;
  // A solid wedge, not a deck on stilts: nothing gets under it to wedge there.
  const foot = [top[0] + dir[0] * len, top[2] + dir[1] * len], low = at(...foot);
  stone(low, top, width, top[1] - low[1] + 2, mat);
  clear(foot, [top[0], top[2]], width / 2 + 4);
  clear(foot, offset(foot, dir, 12), width / 2 + 4);
  point(at(...foot), top);
  if (len > 28) point([(foot[0] + top[0]) / 2, (heightAt(...foot) + top[1]) / 2 + 0.2, (foot[1] + top[2]) / 2]);
}

/**
 * A log `r` m round lying from point `a` to `b` (on its axis), with a walkway worn flat along its
 * top and, at each end in `ends`, a ramp onto it from the ground `run` m beyond, so mechs can walk it.
 */
function walkLog(a, b, r, { run = 8, ends = [true, true] } = {}) {
  cylinder(a, b, r, 'bark');
  const top = (p) => [p[0], r3(p[1] + r + 0.05), p[2]];
  ramp(top(a), top(b), r * 1.1, 'bark', false);
  const dir = [b[0] - a[0], b[2] - a[2]], len = Math.hypot(...dir), u = [dir[0] / len, dir[1] / len];
  const feet = [offset([a[0], a[2]], u, -run), offset([b[0], b[2]], u, run)];
  point(top(a), top([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]), top(b));
  [[feet[0], a], [feet[1], b]].forEach(([foot, end], i) => {
    if (!ends[i]) return;
    if (top(end)[1] - heightAt(...foot) > 0.6) ramp(at(...foot), top(end), r * 1.1, 'bark', false);
    point(at(...foot));
  });
  clear(ends[0] ? feet[0] : [a[0], a[2]], ends[1] ? feet[1] : [b[0], b[2]], r + 4);
}

/**
 * A giant at (x, z): a trunk `r` m round narrowing in three sections to `h` m, buttress roots
 * fanning out from its foot (clear of anything to keep clear), boughs up into a crown `crown` round.
 */
function giant(x, z, r, h, crown, { roots = 5, turn = 0 } = {}) {
  const rand = random(Math.round(Math.abs(x * 31 + z * 17)) + 7), y = heightAt(x, z) - 2;
  let y0 = y;
  for (const [f, top] of [[1, 0.32], [0.78, 0.66], [0.58, 1]]) {
    cylinder([x, y0, z], [x, y + top * h, z], r * f);
    y0 = y + top * h - 0.5;
  }
  for (let k = 0; k < roots; k++) {
    // A fin from the trunk down into the ground 2 radii out: thin and steep, so it's cover, not a ramp.
    const a = turn + (k / roots) * 2 * Math.PI + rand(-0.25, 0.25), u = [Math.cos(a), Math.sin(a)];
    const foot = offset([x, z], u, r + r * rand(2, 2.6));
    if (keep.some(([p, q, gap]) => segment(foot, p, q) < gap - 2 || segment(offset([x, z], u, r * 1.5), p, q) < gap - 2)) continue;
    beam([x + u[0] * r * 0.7, y + 2 + r * 0.6, z + u[1] * r * 0.7], at(...foot, -0.8), 1.3, 3.2, 'bark');
  }
  for (let k = 0; k < 4; k++) {
    const a = turn + 0.6 + (k / 4) * 2 * Math.PI + rand(-0.3, 0.3);
    cylinder([x, y + 0.72 * h, z], [x + Math.cos(a) * crown * 0.6, y + h + rand(0, 4), z + Math.sin(a) * crown * 0.6], r * 0.22);
  }
  decor.push({ kind: 'canopy', at: [x, Math.round(y + h + 2), z], r: crown });
  // Lanterns the eco-station hung on it, over a mech's head: warm pools at dusk.
  for (const k of [0, 1]) {
    const a = turn + 1.3 + k * Math.PI, [lx, lz] = [x + Math.cos(a) * (r * 0.75 + 0.4), z + Math.sin(a) * (r * 0.75 + 0.4)], ly = y + 2 + 9 + k * 3;
    sign([r3(lx - 0.35), r3(ly), r3(lz - 0.35)], [r3(lx + 0.35), r3(ly + 0.7), r3(lz + 0.35)], [r3(x + Math.cos(a) * (r + 2)), r3(ly), r3(z + Math.sin(a) * (r + 2))], LANTERN);
  }
  clear([x, z], [x, z], r * 3.6 + 6);
}

/** A giant leaning `lean` degrees off upright toward `toward` ([dx, dz], unit): too steep to climb, a slant to hide under. */
function leaner(x, z, toward, lean, len, r) {
  const t = (lean * Math.PI) / 180, y = heightAt(x, z) - 2;
  const top = [x + toward[0] * Math.sin(t) * len, y + Math.cos(t) * len, z + toward[1] * Math.sin(t) * len];
  cylinder([x, y, z], top, r);
  decor.push({ kind: 'canopy', at: top.map(Math.round), r: Math.round(r * 5) });
  clear([x, z], [top[0], top[2]], r + 6);
}

/** A forest tree: a leaning trunk and a crown, some with a second, lower tier. */
function tree(x, z, r, h, rand) {
  const y = heightAt(x, z) - 1, lean = [rand(-1.5, 1.5), rand(-1.5, 1.5)];
  cylinder([x, y, z], [x + lean[0], y + h, z + lean[1]], r);
  const crown = (f, size) => decor.push({ kind: 'canopy', at: [Math.round(x + lean[0] * f), Math.round(y + h * f + 1), Math.round(z + lean[1] * f)], r: Math.round(size) });
  crown(1, r * 4 + rand(1, 4));
  if (rand() < 0.4) crown(0.72, r * 3 + rand(0, 2));
  clear([x, z], [x, z], r + 12);
}

/** Up to `count` spots from `tries` random ones that `fits` takes, each handed to `place`. */
function scatter(seed, count, tries, fits, place) {
  const rand = random(seed);
  for (let n = 0; tries-- > 0 && n < count; ) {
    const p = [rand(-178, 178), rand(-178, 178)];
    if (fits(p)) place(p, rand), n++;
  }
}

/** A jump pad on a slab a step over the ground, flat so it fires wherever a mech stands on it. */
function slabPad(x, z, to, apex) {
  const top = Math.round((heightAt(x, z) + 0.3) * 10) / 10;
  box([x - 4, top - 3, z - 4], [x + 4, top, z + 4], 'concrete');
  pad([x, top, z], to, apex);
  clear([x, z], [x, z], 8);
}

// --- The Crown: the mother tree and its deck, an octagon ring 9 m up with two ramps ------------------
const deckY = Math.round(heightAt(...CROWN) + 9);
for (let k = 0; k < 8; k++) {
  const a = ((k + 0.5) / 8) * 2 * Math.PI, p = (b, r) => [CROWN[0] + Math.cos(b) * r, deckY, CROWN[1] + Math.sin(b) * r];
  turned(lift(offset(CROWN, [Math.cos(a), Math.sin(a)], 12.5), deckY - 0.25), [5.6, 0.25, 4.5], Math.round(90 - (a * 180) / Math.PI), 'metal');
  // Railings on the outer edge, but not where the ramps arrive (south-west and south-east).
  if (k !== 4 && k !== 7) railing(p(a - Math.PI / 8, 17.4), p(a + Math.PI / 8, 17.4));
  point(p(a, 12.5), at(...offset(CROWN, [Math.cos(a), Math.sin(a)], 12.5))); // on the deck, and the way round under it
}
for (const k of [4, 7]) {
  const a = ((k + 0.5) / 8) * 2 * Math.PI;
  rampDown([CROWN[0] + Math.cos(a) * 16.5, deckY, CROWN[1] + Math.sin(a) * 16.5], [Math.cos(a), Math.sin(a)], 7, 'metal');
}
for (const k of [1, 3, 5]) lamp([CROWN[0] + Math.cos((k / 8) * 2 * Math.PI) * 15.5, deckY, CROWN[1] + Math.sin((k / 8) * 2 * Math.PI) * 15.5]);
sign([CROWN[0] - 3, deckY + 1.5, CROWN[1] - 8.3], [CROWN[0] + 3, deckY + 3, CROWN[1] - 8.1], [CROWN[0], deckY + 2, CROWN[1] - 10], GREEN);

// --- The Gorge: crossings, the breach, rocks on its floor ---------------------------------------------
{
  // A fallen giant across it, rim to rim, walkable along its top.
  const { at: c, right } = station(GORGE, 58), r = 2.8;
  const [a, b] = [offset(c, right, -21), offset(c, right, 21)];
  walkLog([a[0], heightAt(...a) + 0.2, a[1]], [b[0], heightAt(...b) + 0.2, b[1]], r);
}
for (let s = 24; s < LG - 16; s += 16) {
  const { at: c, right } = station(GORGE, s);
  point(at(...c));
  if (s % 32 === 24) lamp(at(...offset(c, right, (s % 64 === 24 ? 1 : -1) * 5.5))); // path lights down the misty floor
}
{
  // The breach's foot and top.
  const { at: c, right } = station(GORGE, BREACH);
  point(at(...offset(c, right, 4)), at(...offset(c, right, 24)), at(...offset(c, right, 42)));
}
{
  const rand = random(515);
  // Midway between the floor's waypoints, and to one side.
  for (const s of [32, 64, 96, 128]) {
    const { at: c, right, dir } = station(GORGE, s), p = offset(c, right, (rand() < 0.5 ? -1 : 1) * rand(3, 4.5)), half = [rand(2, 3.2), rand(1.4, 2.4), rand(2, 3.5)];
    turned(at(...p, half[1] * 0.4), half.map((v) => Math.round(v * 10) / 10), deg(Math.atan2(dir[0], dir[1])) + Math.round(rand(-30, 30)), 'moss', Math.round(rand(-10, 10)));
  }
}
clear(GORGE[0], GORGE[1], 22);
clear(GORGE[1], GORGE[2], 22);
clear(GORGE[2], GORGE[3], 22);

// --- The Pulpit: a rock pillar on the west rim, up a fallen trunk from the north ---------------------
const pTop = Math.round(heightAt(...PULPIT) + 16);
turned([PULPIT[0], pTop - 12, PULPIT[1]], [7, 12, 7], 14, 'stone');
turned([PULPIT[0] - 6, pTop - 14, PULPIT[1] - 4], [3, 14, 4], 40, 'stone', 8);
turned([PULPIT[0] + 2, pTop - 13, PULPIT[1] - 7], [4, 12, 2.5], -20, 'stone', -12);
{
  const foot = [-62, 66], u = [(PULPIT[0] - foot[0]) / dist(foot, PULPIT), (PULPIT[1] - foot[1]) / dist(foot, PULPIT)];
  const end = offset(PULPIT, u, -3), r = 2.6;
  walkLog([foot[0], heightAt(...foot) - r * 0.5, foot[1]], [end[0], pTop - r - 0.05, end[1]], r, { run: 6, ends: [true, false] });
}
{
  // A stone arch from the Pulpit's top across the Gorge, down to its east rim, on two ribs from the walls.
  const g = along(PULPIT, GORGE), { at: c, right, dir } = station(GORGE, g.s);
  const a = [...offset(c, right, -(g.d - 5))], b = at(...offset(c, right, 30)), top = [a[0], pTop, a[1]];
  stone(top, b, 8, 2.5);
  const over = (k) => top[1] + ((b[1] - top[1]) * (k + g.d - 5)) / (g.d - 5 + 30); // the deck's height k m past the centerline
  for (const k of [-1, 1]) stone(lift(offset(c, right, k * 12), GORGE_FLOOR + 7), [c[0], over(0) - 2.5, c[1]], 6, 2);
  for (const k of [-1, 1]) {
    const side = (p) => [p[0] + dir[0] * k * 3.8, p[1], p[2] + dir[1] * k * 3.8];
    railing(side(top), side(b));
  }
  clear([top[0], top[2]], [b[0], b[2]], 10);
  point([c[0], over(0), c[1]], b, at(...offset(c, right, 40)));
}
lamp([PULPIT[0] - 3, pTop, PULPIT[1] + 3]);
point([PULPIT[0], pTop, PULPIT[1]]);
clear(PULPIT, PULPIT, 16);

// --- The Spine: a stone ridge, its crest a walkway, a tunnel through it --------------------------------
const crestY = (s) => {
  let sum = 0;
  for (let k = -12; k <= 12; k += 4) sum += heightAt(...station(SPINE, Math.min(Math.max(s + k, 0), LS)).at);
  return Math.round((sum / 7 + 0.5 + 14 * smoothstep(0, 44, s) * smoothstep(LS, LS - 38, s)) * 10) / 10;
};
const ridgePoint = (s) => {
  const { at: p } = station(SPINE, s);
  return [p[0], crestY(s), p[1]];
};
const joints = []; // where one crest slab meets the next, level with crestY: a sure landing
for (const [from, to] of [[0, TUNNEL - 5], [TUNNEL + 5, LS]]) {
  const n = Math.ceil((to - from) / 12);
  for (let i = 0; i < n; i++) {
    const a = from + ((to - from) * i) / n - (i ? 0.6 : 0), b = from + ((to - from) * (i + 1)) / n + (i < n - 1 ? 0.6 : 0);
    stone(ridgePoint(a), ridgePoint(b), 12, Math.max(crestY((a + b) / 2) - heightAt(...station(SPINE, (a + b) / 2).at) + 5, 4));
    joints.push(from + ((to - from) * (i + 1)) / n);
  }
}
{
  // Ledges stepping up the ridge's flanks, 5 and 10 m up: a hover at a time to the crest.
  for (const [s, side] of [[24, 1], [52, -1], [118, 1], [142, -1]]) {
    const { at: c, dir } = station(SPINE, s), right = [dir[1], -dir[0]], g = heightAt(...c), yaw = deg(Math.atan2(dir[0], dir[1]));
    for (const [out, up] of [[8, 10], [12, 5]]) {
      const p = offset(c, right, side * out);
      turned([r3(p[0]), r3((g + up + heightAt(...p) - 3) / 2), r3(p[1])], [2, r3((g + up - heightAt(...p) + 3) / 2), 4.5], yaw, 'stone');
    }
  }
  // Talus at its foot.
  const rand = random(3131);
  for (let s = 14; s < LS - 10; s += 17) {
    const { at: c, right } = station(SPINE, s), p = offset(c, right, (rand() < 0.5 ? -1 : 1) * rand(8, 10)), half = [rand(1.5, 2.8), rand(1, 2), rand(1.5, 2.5)];
    turned(at(...p, half[1] * 0.4), half.map((v) => Math.round(v * 10) / 10), Math.round(rand(0, 180)), 'moss', Math.round(rand(-12, 12)));
  }
}
{
  // The tunnel: 10 m wide, 8 m clear under the crest's roof slab.
  const { at: c, right } = station(SPINE, TUNNEL), floor = heightAt(...c);
  stone(ridgePoint(TUNNEL - 6), ridgePoint(TUNNEL + 6), 12, crestY(TUNNEL) - floor - 8);
  point(at(...offset(c, right, -11)), at(...c), at(...offset(c, right, 11)));
  for (const k of [-1, 1]) lamp(at(...offset(offset(c, right, k * 8), station(SPINE, TUNNEL).dir, 6)));
}
{
  // Shards along the crest's edges: cover up top, and a jagged line against the sky.
  const rand = random(909);
  for (const [s, side] of [[22, 1], [40, -1], [58, 1], [76, -1], [112, 1], [130, -1], [148, 1], [162, -1]]) {
    const { at: c, right } = station(SPINE, s), p = offset(c, right, side * 6.5), hh = (crestY(s) - heightAt(...p) + rand(3, 6)) / 2 + 1;
    turned([r3(p[0]), r3(heightAt(...p) + hh - 2), r3(p[1])], [3.5, r3(hh), 1.4], deg(Math.atan2(right[0], right[1])), 'stone', Math.round(side * rand(8, 18)));
  }
}
for (let s = 8; s < LS - 4; s += 14) point(ridgePoint(s));
for (const s of [0, LS]) point(at(...station(SPINE, s).at));
clear(SPINE[0], SPINE[1], 14);
clear(SPINE[1], SPINE[2], 14);
clear(SPINE[2], SPINE[3], 14);

// --- The Knoll: a rock table on top, a ramp up its south side, a pinnacle a hover above ---------------
{
  const top = Math.round(heightAt(...KNOLL) + 5);
  turned([KNOLL[0], top - 7, KNOLL[1]], [9, 7, 7], 0, 'stone');
  turned([KNOLL[0] + 3, top + 3.5 - 7, KNOLL[1] + 2.5], [3.5, 7, 3], 30, 'stone');
  turned([KNOLL[0] - 8, top - 8, KNOLL[1] + 6], [3, 8, 2], -25, 'stone', 14);
  rampDown([KNOLL[0] - 3, top, KNOLL[1] - 6.5], [0, -1], 6, 'stone');
  point([KNOLL[0] - 3, top, KNOLL[1] - 2]);
  clear(KNOLL, KNOLL, 26);
}

// --- The Gate: a giant standing on four roots over the south road, 9 m clear under it -----------------
{
  const [x, z] = GATE, y0 = heightAt(x, z) + 9.5;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2, u = [Math.cos(a), Math.sin(a)];
    cylinder([x + u[0] * 2.5, y0 + 1, z + u[1] * 2.5], at(...offset(GATE, u, 11), -1), 2.2, 'bark');
  }
  cylinder([x, y0, z], [x, y0 + 18, z], 4.2);
  cylinder([x, y0 + 17.5, z], [x + 1, y0 + 38, z - 1], 3.2);
  decor.push({ kind: 'canopy', at: [x + 1, Math.round(y0 + 40), z - 1], r: 18 });
  point(at(x, z), at(x - 16, z), at(x + 16, z), at(x, z - 16), at(x, z + 16));
  clear(GATE, GATE, 20);
}

// --- Giants, standing, leaning and fallen --------------------------------------------------------------
giant(...CROWN, 8, 58, 26, { roots: 0, turn: 0.4 }); // no roots: the way round under the deck stays open
{
  // The flank giants, each with a deck up a root.
  const deck = (x, z, r, dir, out) => {
    const c = offset([x, z], dir, r + 3.5), y = Math.round(heightAt(x, z) + 7.5);
    turned([c[0], y - 0.25, c[1]], [4.5, 0.25, 4.5], deg(Math.atan2(dir[0], dir[1])), 'bark');
    rampDown(lift(offset(c, out, 4), y), out, 5, 'bark');
    point([c[0], y, c[1]]);
  };
  deck(-30, 34, 5, [0.6, -0.8], [0.8, 0.6]);
  giant(-30, 34, 5, 46, 18, { turn: 1.1 });
  deck(44, 24, 5, [-0.7, -0.7], [-0.7, 0.7]);
  giant(44, 24, 5, 48, 18, { turn: 0.2 });
}
giant(-38, -52, 4.5, 40, 16, { turn: 2.2 });
giant(48, -40, 4, 38, 15, { turn: 0.9 });
giant(-12, 70, 4, 40, 16, { turn: 2.8 });
leaner(30, 58, [-0.9, 0.44], 35, 50, 3);
leaner(-20, 4, [-0.34, -0.94], 30, 44, 2.6);
{
  // One leaning out over the Gorge from its east rim, a slant across the sky above the floor.
  const { at: c, right } = station(GORGE, 30), base = offset(c, right, 20);
  leaner(...base, [-right[0], -right[1]], 52, 40, 2.4);
}
{
  // One fallen across the field south-east of the Knoll: a wall of cover 6 m high.
  const [a, b] = [[16, -60], [52, -68]];
  cylinder(at(...a, 1.2), at(...b, 1.2), 3.4, 'bark');
  clear(a, b, 10);
}

// --- The Teeth: rocks across the south road on the east side ------------------------------------------
turned(at(50, -92, 3), [6, 7, 9], 25, 'stone', 6);
turned(at(68, -114, 2), [7, 6, 6], -10, 'stone', -5);
turned(at(58, -100, 1), [2, 5, 3], 60, 'stone', 15);
clear([50, -92], [68, -114], 12);

// --- Bases -----------------------------------------------------------------------------------------
// West: Grove Station, a habitat and greenhouse in the clearing.
box([-146, 0, -96], [-126, 6, -86], 'panel'); // habitat, roof a hover up
box([-146, 0, -86], [-141, 4, -76], 'panel'); // its airlock wing
for (const x of [-120, -112, -104]) beam([x, 1, -84], [x, 7, -84], 0.4, 0.4); // greenhouse frame posts
beam([-120, 7, -84], [-104, 7, -84], 0.4, 0.4);
box([-122, 1, -86.5], [-102, 2.2, -85.5], 'metal'); // its planter wall
box([-110, 0, -122], [-104, 3, -118], 'metal'); // crates
box([-104, 0, -121], [-100, 2, -117], 'metal');
box([-140, 0, -120], [-136, 2.5, -112], 'concrete');
sign([-140, 3, -85.8], [-132, 5, -85.6], [-136, 3, -84], GREEN);
for (const p of [[-126, 1, -84], [-110, 1, -116], [-140, 1, -108]]) lamp(p);
// East: Relay Station, a deck on stilts under a mast.
box([128, 6.5, -100], [144, 7, -84], 'metal'); // deck, 6.5 m clear under it
for (const [x, z] of [[129, -99], [143, -99], [129, -85], [143, -85]]) box([x - 0.4, 0, z - 0.4], [x + 0.4, 6.5, z + 0.4], 'metal');
ramp([114, 1, -92], [128, 7, -92], 7, 'metal', true);
for (const [a, b] of [[[128, 7, -100], [144, 7, -100]], [[144, 7, -100], [144, 7, -84]], [[128, 7, -84], [144, 7, -84]]]) railing(a, b);
box([140, 0, -110], [142, 26, -108], 'metal'); // relay mast
lamp([141, 26, -109]);
box([104, 0, -122], [110, 3, -118], 'metal'); // crates
box([100, 0, -121], [104, 2, -117], 'metal');
box([136, 0, -120], [140, 2.5, -112], 'concrete');
sign([136.5, 0.6, -111.8], [139.5, 2, -111.6], [138, 1, -110], AMBER);
for (const p of [[136, 7, -92], [112, 1, -114], [140, 1, -116]]) lamp(p);
for (const b of BASES) clear(b, b, 36);
point([136, 7, -92], at(110, -92), at(-112, -92), at(-136, -110), at(136, -110));

// --- Jump pads: the Gorge's floor up onto the Pulpit, and the east base onto the Spine ----------------
slabPad(...station(GORGE, 40).at, [PULPIT[0], pTop, PULPIT[1]], pTop + 8);
{
  const s = joints.reduce((best, j) => (Math.abs(j - 36) < Math.abs(best - 36) ? j : best));
  slabPad(96, -96, ridgePoint(s), crestY(s) + 8);
}

// --- The forest, and more forest beyond the cliffs -----------------------------------------------------
scatter(
  20261023, 46, 6000,
  (p) => edge(p) < -12 && dist(p, HOLLOW) > 26 && keep.every(([a, b, gap]) => segment(p, a, b) > gap),
  ([x, z], rand) => tree(x, z, rand(1.4, 2.4), rand(20, 32), rand),
);
{
  const rim = [];
  scatter(77, 400, 20000, (p) => edge(p) > 13 && edge(p) < 36 && rim.every((q) => dist(p, q) > 12), (p, rand) => {
    rim.push(p);
    decor.push({ kind: 'canopy', at: at(p[0], p[1], rand(2, 9)).map(Math.round), r: Math.round(rand(8, 13)) });
  });
}
// Fallen logs and boulders for cover in the open.
for (const [x, z, angle, len, r] of [[-20, -104, 0.3, 18, 1.4], [26, -96, -0.5, 14, 1.2], [-6, 40, 0.1, 18, 1.5], [22, 84, 2.4, 14, 1.3], [-78, -100, 1.2, 14, 1.2]]) {
  const d = [Math.cos(angle) * len * 0.5, Math.sin(angle) * len * 0.5];
  cylinder(at(x - d[0], z - d[1], r * 0.6), at(x + d[0], z + d[1], r * 0.6), r, 'bark');
}
{
  const rand = random(4242);
  for (const [x, z, n] of [[-14, -36, 2], [30, -10, 2], [-30, 86, 2], [40, 96, 2], [120, -60, 2], [-60, -66, 2], [92, -30, 2], [-8, 16, 2]]) {
    for (let k = 0; k < n; k++) {
      const p = [x + rand(-8, 8), z + rand(-8, 8)], half = [rand(1.5, 3.5), rand(1, 2.4), rand(1.5, 3)];
      turned(at(p[0], p[1], half[1] * 0.4), half.map((v) => Math.round(v * 10) / 10), Math.round(rand(0, 180)), 'moss', Math.round(rand(-12, 12)));
    }
  }
}

// --- Waypoints over the open ground --------------------------------------------------------------------
// A grid wherever it's gentle and a Heavy fits, nudged off anything in the way; the pieces above
// added their own.
{
  /** Whether a mech standing at `p` (feet) would be inside a solid or under a low deck, give or take `margin` m. */
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
  const gentle = ([x, z]) => Math.max(Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)), Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2))) / 4 < Math.tan(0.48);
  for (let j = 0, z = -150; z <= 170; j++, z += 20) {
    for (let x = -170 + (j % 2) * 10; x <= 170; x += 20) {
      const spot = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]].map(([dx, dz]) => [x + dx, z + dz]).find((p) => edge(p) < -13 && gentle(p) && !blocked(at(...p)));
      if (spot) point(at(...spot));
    }
  }
}

// --- Spawns, write ---------------------------------------------------------------------------------
const spawns = (b, s) => [[-6, -10], [4, -16], [10, -2], [-12, -4]].map(([dx, dz]) => at(b[0] + s * dx, b[1] + dz, 0.1));
// Twilight: the sun low in the north-west behind the mother tree, an orange sky going violet
// overhead, warm mist in the Gorge, lanterns lit, fireflies out, leaves coming down.
const palette = {
  sunDir: [-0.5, 0.25, 0.83],
  sky: { horizon: '#f08a50', zenith: '#2a2150', sun: '#ffb070', stars: 0.25 },
  fog: [45, 260],
  haze: ['#d98a5a', 0.02, 6],
  light: { sky: '#e0a884', ground: '#5c3c30', ambient: 2.1, sun: '#ff9a50', direct: 2.3 },
  lamp: '#ffb35c',
  tint: '#f2d8c2',
  terrain: ['#6a7840', '#7a685c', '#8a7444'],
  leaf: ['#4a6a2e', '#6a7a32', '#3e5a2a', '#80783a'],
  undergrowth: 1,
  cover: 0.7,
  skyline: 'forest',
  motes: [
    { color: [[1, 0.86, 0.45], [1, 0.42, 0.1]], rate: 50, size: 0.22, drift: 0.5, rise: 0.15, life: 6 }, // fireflies
    // Leaves coming down on a light breeze out of the north-west.
    { color: [[0.55, 0.32, 0.14], [0.4, 0.24, 0.1]], rate: 25, size: 0.22, drift: 0.8, rise: -0.7, life: 9, wind: [1.2, -0.5], range: 30, solid: true },
  ],
  ambience: 'twilight', // its sound bed and accents (web/audio.js)
};
// Diagnostics: how steep the walkable slabs run, and where the key pieces stand.
for (const s of solids.filter((s) => s.half[1] === 0.25 && s.tilt)) if (Math.abs(s.tilt) > 26) console.warn(`steep ramp ${s.mat} at ${s.box}: ${s.tilt} degrees`);
console.log(`Pulpit top ${pTop} (ground ${heightAt(...PULPIT).toFixed(1)}, edge ${edge(PULPIT).toFixed(1)}), crest ${crestY(36)}-${crestY(LS / 2)}, tunnel floor ${heightAt(...station(SPINE, TUNNEL).at).toFixed(1)}`);
// Siege: the station down in the Hollow on the south road, halfway between the bases, the AA gun on
// the Knoll's rock table, the ships along the south road.
const onGround = ([x, z]) => [x, r3(heightAt(x, z)), z];
bases(onGround(BASES[0]), onGround(BASES[1]));
// Base guns: two at each eco-station, either side of it.
sentries([[-115, 1, -110], [-140, 1, -104]], [[140, 1, -104], [115, 1, -110]]);
siege({ at: onGround(HOLLOW), radius: 12, band: 5 }, { at: [6, 13, -18], radius: 9, band: 3, pad: [12, 13, -22] }, 70);
// Missile Assault: A down in the Gorge by its breach (the west's flank, the Pulpit over it), B on the
// Knoll's rock table, C at the Spine's tunnel (the east's flank).
// C's launch pad is out of the tunnel, by its west mouth.
silos({ at: [-68, -13, 13], radius: 12, band: 5 }, { at: [6, 13, -18], radius: 9, band: 3, pad: [2.5, 13, -17.5] }, { at: [76, -1, 15], radius: 12, band: 5, pad: [70.5, -1.4, 12.5] });
write(new URL('./canopy.json', import.meta.url), { name: 'Canopy', size: SIZE, night: true, palette }, spawns(BASES[0], 1), spawns(BASES[1], -1));
