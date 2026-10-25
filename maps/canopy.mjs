// Canopy: a 360 m forest, the last living one, and not quite right: pale trunks, crowns trailing veils
// that sway and breathe all together, and an orange-glowing fungus spreading through the dark
// places, something not of the forest taking it over. A rounded triangle of rolling ground walled by
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
import { bases, beam, box, convoy, cylinder, decor, flagStand, flags, ground, heightAt, lamp, pad, point, r3, railing, ramp, sentries, siege, sign, silos, solids, turned, write } from './kit.mjs';

const SIZE = [360, 360], CELL = 4;
const A = [-140, -118], B = [140, -118], C = [0, 140], ROUND = 30; // the playable triangle, grown ROUND m
const BASES = [[-122, -102], [122, -102]]; // west (team 0), east (team 1)
const STANDS = [[-131, -74], [131, -74]]; // each base's flag stand, north of it
const KNOLL = [6, -18], CROWN = [0, 112], HOLLOW = [0, -98], PULPIT = [-86, 30], GATE = [-52, -94];
const GORGE = [[-96, -70], [-80, -20], [-62, 30], [-40, 76]];
const SPINE = [[104, -72], [86, -14], [68, 40], [50, 80]];
const GORGE_FLOOR = -13, BREACH = 88; // the breach: this far along the Gorge, up its east wall
const TUNNEL = 92; // this far along the Spine
const GREEN = '#7dffb0', AMBER = '#ffc46b', LANTERN = '#ffa040';

/** A patch of glowing fungus `r` m round on the ground at (x, z) (props: it lights, nothing more). */
const fungus = (x, z, r, y = heightAt(x, z)) => decor.push({ kind: 'fungus', at: [r3(x), r3(y), r3(z)], r: r3(r) });

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
  const [ex, ez] = [bx - ax, bz - az], e2 = ex * ex + ez * ez, t = e2 ? clamp01(((px - ax) * ex + (pz - az) * ez) / e2) : 0;
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
  for (const s of STANDS) h += (1 - h) * smoothstep(24, 14, dist(p, s)); // and under the flag stands
  // The Gorge: a level floor between walls too steep to climb, 7-14 m out, sloping up at its ends;
  // at the breach its east wall lies back to a 30 degree slope.
  const g = along(p, GORGE), ends = smoothstep(0, 54, g.s) * smoothstep(LG, LG - 34, g.s);
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

/** A ramp from the ground toward `dir` ([dx, dz], unit) up to `top`, solid under, as long as it takes to climb at 24 degrees. Returns its foot. */
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
  return low;
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
 * A table tree at (x, z): a pale trunk `t` m round, narrowing, from `foot` (the ground) up to a flat
 * crown `r` m round, its top at `top`: a terrace to walk. Buttress roots fan from its foot (clear of
 * anything to keep clear), branch stubs spike up the trunk under the crown, water stands on it,
 * moss drips off its rim (veils too, with `long`); with `lit`, lanterns the eco-station hung on it.
 * Returns its crown (`at`, `r`, `top`, `t`, and `links`, the ways off its rim) for the canopy.
 */
function table(x, z, t, r, top, { roots = 4, turn = 0, long = false, lit = false, foot = heightAt(x, z) - 2 } = {}) {
  const rand = random(Math.round(Math.abs(x * 31 + z * 17)) + 7), y = foot, under = top - 2, waist = y + (under - y) * 0.45;
  cylinder([x, y, z], [x, waist, z], t);
  cylinder([x, waist - 0.5, z], [x, under, z], t * 0.78);
  cylinder([x, under, z], [x, top, z], r, 'moss');
  for (let k = 0; k < roots; k++) {
    // A fin from the trunk down into the ground 2 radii out: thin and steep, so it's cover, not a ramp.
    const a = turn + (k / roots) * 2 * Math.PI + rand(-0.25, 0.25), u = [Math.cos(a), Math.sin(a)];
    const fin = offset([x, z], u, t + t * rand(2, 2.6));
    if (keep.some(([p, q, gap]) => segment(fin, p, q) < gap - 2 || segment(offset([x, z], u, t * 1.5), p, q) < gap - 2)) continue;
    beam([x + u[0] * t * 0.7, y + 2 + t * 0.6, z + u[1] * t * 0.7], at(...fin, -0.8), 1.3, 3.2, 'bark');
  }
  // Stubs of branches up the trunk, pointing up and out, under the crown and over a mech's head.
  for (let k = 0, n = Math.floor((under - y - 16) / 4); k < n; k++) {
    const a = turn + k * 2.4 + rand(-0.3, 0.3), h = y + 12 + k * 4, u = [Math.cos(a), Math.sin(a)], len = Math.min(rand(2.5, 4.5), r - t - 1);
    beam([r3(x + u[0] * t * 0.5), r3(h), r3(z + u[1] * t * 0.5)], [r3(x + u[0] * (t * 0.78 + len)), r3(h + len * 0.6), r3(z + u[1] * (t * 0.78 + len))], 0.7, 0.7, 'bark');
  }
  decor.push({ kind: 'pool', at: [x, r3(top + 0.04), z], r: r3(r - 1.1) }); // to just inside the rim
  decor.push({ kind: 'fringe', at: [x, under, z], r, ...(long && { long }) });
  fungus(...offset([x, z], [Math.cos(turn + Math.PI / Math.max(roots, 1)), Math.sin(turn + Math.PI / Math.max(roots, 1))], t + 3), 2.5); // between its roots
  if (lit) {
    // Lanterns hung on it, over a mech's head: warm pools at dusk.
    for (const k of [0, 1]) {
      const a = turn + 1.3 + k * Math.PI, [lx, lz] = [x + Math.cos(a) * (t * 0.75 + 0.4), z + Math.sin(a) * (t * 0.75 + 0.4)], ly = heightAt(x, z) + 9 + k * 3;
      sign([r3(lx - 0.35), r3(ly), r3(lz - 0.35)], [r3(lx + 0.35), r3(ly + 0.7), r3(lz + 0.35)], [r3(x + Math.cos(a) * (t + 2)), r3(ly), r3(z + Math.sin(a) * (t + 2))], LANTERN);
    }
  }
  clear([x, z], [x, z], t * 3.6 + 6);
  point([x, top, z]);
  return { at: [x, z], r, top, t, links: [] };
}

/** A small table tree at (x, z) under the canopy, crown `r` m round topped at `top`: cover and shade, not a terrace. */
function copse(x, z, r, top) {
  cylinder(at(x, z, -1), [x, top - 1, z], r3(r * 0.2));
  cylinder([x, top - 1.2, z], [x, top, z], r3(r), 'moss');
  decor.push({ kind: 'fringe', at: [x, top - 1.2, z], r: r3(r) });
  clear([x, z], [x, z], r * 0.2 + 5);
}

/** A dead giant at (x, z) leaning `lean` degrees off upright toward `toward` ([dx, dz], unit): too steep to climb, a slant to hide under. */
function leaner(x, z, toward, lean, len, r) {
  const t = (lean * Math.PI) / 180, y = heightAt(x, z) - 2;
  const top = [x + toward[0] * Math.sin(t) * len, y + Math.cos(t) * len, z + toward[1] * Math.sin(t) * len];
  cylinder([x, y, z], top, r);
  clear([x, z], [top[0], top[2]], r + 6);
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
// The west ramp, turned 7.5 degrees south off its slab's middle so its foot lands clear of the cliffs'
// lip. (The east one comes down onto the Spine, below.)
const westRamp = (() => {
  const a = ((4.5 + 1 / 6) / 8) * 2 * Math.PI, top = [CROWN[0] + Math.cos(a) * 16.5, deckY, CROWN[1] + Math.sin(a) * 16.5];
  return { top, foot: rampDown(top, [Math.cos(a), Math.sin(a)], 7, 'metal') };
})();
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
    const { at: c, right, dir } = station(GORGE, s), p = offset(c, right, (rand() < 0.5 ? -1 : 1) * rand(7, 8)), half = [rand(2, 3.2), rand(1.4, 2.4), rand(2, 3.5)];
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
  // Its walk ends at the pillar's edge, flush with the top (the convoy's hauler walks up it).
  const end = offset(PULPIT, u, -7.5), r = 2.6;
  walkLog([foot[0], heightAt(...foot) - r * 0.5, foot[1]], [end[0], pTop - r - 0.05, end[1]], r, { run: 6, ends: [true, false] });
}
{
  // A stone arch from the Pulpit's top across the Gorge, down to its east rim, on two ribs from the walls.
  // It springs from the pillar's edge, flush with the top.
  const g = along(PULPIT, GORGE), { at: c, right, dir } = station(GORGE, g.s), edge = 7;
  const a = [...offset(c, right, -(g.d - edge))], b = at(...offset(c, right, 30)), top = [a[0], pTop, a[1]];
  stone(top, b, 8, 2.5);
  const over = (k) => top[1] + ((b[1] - top[1]) * (k + g.d - edge)) / (g.d - edge + 30); // the deck's height k m past the centerline
  for (const k of [-1, 1]) stone(lift(offset(c, right, k * 12), GORGE_FLOOR + 7), [c[0], over(0) - 2.5, c[1]], 6, 2);
  for (const k of [-1, 1]) {
    const side = (p) => [p[0] + dir[0] * k * 3.8, p[1], p[2] + dir[1] * k * 3.8];
    railing(side(top), side(b));
  }
  clear([top[0], top[2]], [b[0], b[2]], 10);
  point([c[0], over(0), c[1]], lift(offset(c, right, 15), r3(over(15))), b, at(...offset(c, right, 40)));
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
  // The crest's south end stands a step over the ground: a wedge up onto it, for the convoy's hauler.
  const { at: c, dir } = station(SPINE, 0);
  stone(at(...offset(c, dir, -4)), ridgePoint(0), 12, 2);
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
  fungus(...offset(offset(c, right, 3), station(SPINE, TUNNEL).dir, -4), 1.6); // and in the dark of it
  fungus(...offset(offset(c, right, -2), station(SPINE, TUNNEL).dir, 4), 1.2);
}
{
  // Shards along the crest's edges: cover up top, and a jagged line against the sky.
  const rand = random(909);
  for (const [s, side] of [[22, 1], [40, -1], [58, 1], [76, -1], [112, 1], [130, -1], [148, 1], [156, -1]]) {
    const { at: c, right } = station(SPINE, s), p = offset(c, right, side * 6.5), hh = (crestY(s) - heightAt(...p) + rand(3, 6)) / 2 + 1;
    turned([r3(p[0]), r3(heightAt(...p) + hh - 2), r3(p[1])], [3.5, r3(hh), 1.4], deg(Math.atan2(right[0], right[1])), 'stone', Math.round(side * rand(8, 18)));
  }
}
// The Crown deck's east ramp runs straight down onto the crest's north end (24 degrees from the deck's
// edge), so the deck leads onto the Spine.
const eastRamp = (() => {
  const foot = ridgePoint(LS), a = Math.atan2(foot[2] - CROWN[1], foot[0] - CROWN[0]), top = [CROWN[0] + Math.cos(a) * 16.5, deckY, CROWN[1] + Math.sin(a) * 16.5];
  stone(foot, top, 7, deckY - foot[1] + 2, 'metal');
  point(top, [0, 1, 2].map((i) => (foot[i] + top[i]) / 2 + (i === 1 ? 0.2 : 0)));
  clear([foot[0], foot[2]], [top[0], top[2]], 7.5);
  return { top, foot };
})();
// The east base's jump pad up onto the crest (laid with the others, below), landing on a joint.
const SPINE_PAD = [96, -96], spineLanding = joints.reduce((best, j) => (Math.abs(j - 36) < Math.abs(best - 36) ? j : best));
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

// --- The Gate: a table tree standing on four roots over the south road, 9 m clear under it ---------------
const gate = (() => {
  const [x, z] = GATE, y0 = heightAt(x, z) + 9.5;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2, u = [Math.cos(a), Math.sin(a)];
    cylinder([x + u[0] * 2.5, y0 + 1, z + u[1] * 2.5], at(...offset(GATE, u, 11), -1), 2.2, 'bark');
  }
  point(at(x, z), at(x - 16, z), at(x + 16, z), at(x, z - 16), at(x, z + 16));
  clear(GATE, GATE, 20);
  return table(x, z, 4.2, 12, 30, { roots: 0, foot: y0 });
})();

// --- The canopy: table trees whose crowns are terraces, linked across the map ----------------------
// Crowns stand 27-36 m up, linked to their neighbors so all of the map can be crossed up here: crowns
// level with each other through branch crowns overlapping both (one terrace), crowns 3 m apart by a
// bough climbing from one rim to the other, its top worn flat, no steeper than 24 degrees. Spurs (a
// pad 3 m under a crown, off its rim: a drop down, a hover back up) and shelf stairs (pads up a slim
// trunk, 3 m a step, a hover each) fill out the tiers; each base has a jump pad up. Discs stacked in
// plan stand 7.5 m+ apart, so nothing walks under a low ceiling.
const SLOPE = Math.tan((24 * Math.PI) / 180), LAP = 2.5; // branch crowns overlap the crowns they join by this much
// Launch pads and the AA gun need open sky (the silos and the Siege gun, below): no crown over them.
const OPEN = [[-68, 13], [2.5, -17.5], [70.5, 12.5], [12, -22]];
const open = (c, r) => OPEN.every((o) => dist(c, o) > r + 3);
const discs = []; // every walkable disc ({ at, r, top }), for spacing what comes after
const walks = []; // every bough ([p, q, y0, y1]), likewise
const unit = (a, b) => {
  const d = dist(a, b);
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
};

/** A branch crown `r` m round at (x, z), its top at `top`, on a branch from `owner`'s trunk. */
function shelf([x, z], r, top, owner) {
  r = r3(Math.min(r, 10));
  cylinder([r3(x), top - 1.2, r3(z)], [r3(x), top, r3(z)], r, 'moss');
  const u = unit(owner.at, [x, z]);
  beam([r3(owner.at[0] + u[0] * owner.t * 0.5), Math.max(top - 9, owner.above ?? -Infinity), r3(owner.at[1] + u[1] * owner.t * 0.5)], [r3(x), top - 1.2, r3(z)], 1.4, 1.4, 'bark');
  decor.push({ kind: 'fringe', at: [r3(x), top - 1.2, r3(z)], r });
  decor.push({ kind: 'pool', at: [r3(x), r3(top + 0.05), r3(z)], r: r3(r - 1) });
  point([r3(x), top, r3(z)]);
  const disc = { at: [x, z], r, top, t: 1, links: [] };
  discs.push(disc);
  return disc;
}

/** A bough from crown `a`'s rim up or down to `b`'s: 5 m thick, its top worn flat 3.8 m across, no steeper than 24 degrees. */
function bough(a, b) {
  const u = unit(a.at, b.at), p = offset(a.at, u, a.r - 0.6), q = offset(b.at, u, -(b.r - 0.6));
  const [lo, hi] = a.top <= b.top ? [lift(p, a.top), lift(q, b.top)] : [lift(q, b.top), lift(p, a.top)];
  ramp(lo.map(r3), hi.map(r3), 3.8, 'bark', false);
  // The bough itself, its top along the worn path, running on down into the lower crown.
  const k = 2 / dist([lo[0], lo[2]], [hi[0], hi[2]]), root = [0, 1, 2].map((i) => lo[i] - (hi[i] - lo[i]) * k);
  cylinder(root.map((v, i) => r3(v - (i === 1 ? 2.6 : 0))), hi.map((v, i) => r3(v - (i === 1 ? 2.6 : 0))), 2.6, 'bark');
  if (Math.abs(b.top - a.top) > dist(p, q) * SLOPE + 0.01) console.warn(`steep bough ${a.at} -> ${b.at}`);
  if (dist(a.at, b.at) > 33) point([r3((p[0] + q[0]) / 2), (a.top + b.top) / 2 + 0.2, r3((p[1] + q[1]) / 2)]);
  a.links.push(u);
  b.links.push([-u[0], -u[1]]);
  walks.push([p, q, a.top, b.top]);
}

/**
 * Links crowns `a` and `b`. Level: branch crowns between them, one or two, overlapping each other
 * and both ends (`side` m off the line, for a less even look). A step of 3 m: a bough from one to
 * the other, from a branch crown level with the lower one if it's a long way.
 */
function link(a, b, side = 2) {
  const gap = dist(a.at, b.at) - a.r - b.r, u = unit(a.at, b.at), n = [-u[1], u[0]];
  const around = (along, sway) => offset(offset(a.at, u, along), n, sway);
  const reach = (c, ...to) => Math.max(...to.map((d) => dist(c, d.at) - d.r)) + LAP;
  a.links.push(u);
  b.links.push([-u[0], -u[1]]);
  if (a.top === b.top) {
    if (gap <= 16) {
      const c = around(a.r + gap / 2, side), r = reach(c, a, b);
      return open(c, r) ? shelf(c, r, a.top, gap / 2 < 8 ? a : b) : bough(a, b);
    }
    const [c1, c2] = [around(a.r + gap * 0.28, side), around(a.r + gap * 0.72, -side)], mid = dist(c1, c2) / 2 + LAP;
    const [r1, r2] = [Math.max(reach(c1, a), mid), Math.max(reach(c2, b), mid)];
    if (!open(c1, r1) || !open(c2, r2)) return bough(a, b);
    shelf(c1, r1, a.top, a);
    return shelf(c2, r2, a.top, b);
  }
  const [lo, hi] = a.top < b.top ? [a, b] : [b, a], run = Math.abs(b.top - a.top) / SLOPE + 1.4;
  // A branch crown off the lower one, reaching toward the higher, if it's a long way, leaving the bough its run.
  const w = unit(lo.at, hi.at), r = Math.min((gap - run - 1 + LAP) / 2, 10), c = offset(offset(lo.at, w, lo.r - LAP + r), [-w[1], w[0]], side);
  if (gap < run + 9 || !open(c, r)) return bough(lo, hi);
  bough(shelf(c, r, lo.top, lo), hi);
}

/** Whether a disc `r` m round at (x, z), top at `top`, clears every walkable disc (but `own`) and walk within 7.5 m of its height. */
function clearOf([x, z], r, top, margin = 1, own = null) {
  return (
    discs.every((d) => d === own || Math.abs(d.top - top) >= 7.5 || dist(d.at, [x, z]) > d.r + r + margin) &&
    walks.every(([p, q, y0, y1]) => Math.abs((y0 + y1) / 2 - top) >= 7.5 || segment([x, z], p, q) > r + 2.5 + margin)
  );
}

/** The direction off crown `a`'s rim furthest from its links that `ok` takes: [dx, dz], after turning `skew` radians. */
function free(a, skew = 0, ok = () => true) {
  let best = null, score = -Infinity;
  for (let k = 0; k < 72; k++) {
    const t = (k / 72) * 2 * Math.PI + skew, u = [Math.cos(t), Math.sin(t)];
    if (!ok(u)) continue;
    const s = Math.min(...a.links.map((l) => 1 - (u[0] * l[0] + u[1] * l[1])), 2);
    if (s > score) [best, score] = [u, s];
  }
  return best;
}

/** A spur: a pad `r` m round off crown `a`'s rim toward `u`, 3 m under it, if it's clear. */
function spur(a, u, r = 5) {
  const c = offset(a.at, u, a.r + 0.6 + r);
  if (!clearOf(c, r, a.top - 3, 1, a) || edge(c) > -10) return;
  a.links.push(u);
  shelf(c, r, a.top - 3, a);
}

/**
 * Shelf stairs up to crown `a` from the ground toward `u`: pads 4 m round spiraling up a slim trunk
 * 3 m a step (a hover each), the top one level with the crown and just off its rim, the low ones
 * on stumps (nothing to wedge under).
 */
function stairs(a, u) {
  const c = offset(a.at, u, a.r + 9.6), floor = heightAt(...c);
  cylinder(lift(c, floor - 1), lift(c, a.top - 0.5), 1.6, 'bark');
  let turn = Math.atan2(-u[1], -u[0]), last;
  for (let y = a.top; y - floor > 0.5; y -= 3, turn += 1.53) {
    const p = [r3(c[0] + Math.cos(turn) * 5.2), r3(c[1] + Math.sin(turn) * 5.2)];
    cylinder(lift(p, y - floor < 8 ? heightAt(...p) - 1 : y - 1), lift(p, y), 4, 'moss');
    point([p[0], y, p[1]]);
    discs.push({ at: p, r: 4, top: y, t: 1, links: [] });
    last = p;
  }
  point(at(...offset(last, unit(c, last), 7.5)));
  a.links.push(u);
  clear(c, c, 14);
}

/** Water pouring off crown `a`'s rim toward `u` to the ground, if nothing's under it; mist where it lands. */
function falls(a, u, w = 1.6) {
  const [x, z] = offset(a.at, u, a.r + 0.4);
  if (!discs.every((d) => d === a || d.top > a.top || dist(d.at, [x, z]) > d.r + 1.5)) return;
  if (!walks.every(([p, q, y0, y1]) => Math.max(y0, y1) > a.top || segment([x, z], p, q) > 4)) return;
  decor.push({ kind: 'falls', from: [r3(x), a.top - 0.3, r3(z)], to: [r3(x), r3(heightAt(x, z)), r3(z)], w });
}

const CANOPY = {
  S1: table(-78, -76, 3, 11, 27, { roots: 0, turn: 0.3 }),
  S2: gate,
  S3: table(-14, -74, 3, 10, 27, { roots: 0, turn: 1.4 }),
  S4: table(22, -76, 3, 10, 30, { roots: 0, turn: 2.6 }),
  S6: table(78, -76, 3, 11, 27, { roots: 0, turn: 0.8 }),
  W1: table(-68, -38, 3, 11, 30, { roots: 0, turn: 2.0 }),
  M2: table(-38, -52, 4.5, 12, 33, { turn: 2.2, long: true, lit: true }),
  M3: table(48, -40, 4, 12, 33, { turn: 0.9, long: true, lit: true }),
  E1: table(80, -30, 3, 10, 30, { roots: 0, turn: 1.1 }),
  K1: table(-40, -14, 3, 11, 30, { roots: 0, turn: 0.5 }),
  K2: table(46, -8, 3, 11, 30, { roots: 0, turn: 2.9 }),
  N1: table(-30, 34, 5, 13, 33, { turn: 1.1, long: true, lit: true }),
  N2: table(8, 34, 3, 10, 30, { roots: 0, turn: 0.2 }),
  N3: table(44, 24, 5, 13, 33, { turn: 0.2, long: true, lit: true }),
  N4: table(-56, 52, 3, 10, 30, { roots: 0, turn: 1.7 }),
  E2: table(92, 16, 3, 10, 30, { roots: 0, turn: 2.4 }),
  U1: table(-12, 70, 4, 13, 33, { turn: 2.8, long: true, lit: true }),
  U2: table(30, 62, 3, 11, 33, { roots: 0, turn: 0.6 }),
  // Behind the Crown's ramps, clear of them and their walkers.
  U3: table(-46, 106, 3, 9, 33, { roots: 0, turn: 1.9 }),
  U4: table(38, 109, 3, 9, 33, { roots: 0, turn: 0.4 }),
  // The mother tree: the highest crown, over the station's old deck (no roots: the way round under the deck stays open).
  MO: table(...CROWN, 7, 18, 36, { roots: 0, turn: 0.4, long: true, lit: true }),
};
discs.push(...Object.values(CANOPY));
CANOPY.MO.above = deckY + 7.5; // its branches leave the trunk over a Heavy's head on the deck
for (const [a, b, side] of [
  ['S1', 'S2'], ['S2', 'S3', -3], ['S3', 'S4'], ['S4', 'S6', -3], // the south row
  ['S1', 'W1'], ['S2', 'M2'], ['S4', 'M3'], ['S6', 'E1'],
  ['W1', 'M2'], ['M3', 'E1'], ['W1', 'K1'], ['M2', 'K1'], ['M3', 'K2'], ['E1', 'K2'],
  ['K1', 'N1', -3], ['K2', 'N3'], ['E1', 'E2', -4], ['N3', 'E2'], // round the Knoll, and up
  ['N1', 'N4'], ['N1', 'N2'], ['N2', 'N3'], ['N1', 'U1'], ['N2', 'U1'], ['N3', 'U2'], ['N4', 'U3'],
  ['U3', 'U1'], ['U1', 'U2'], ['U2', 'U4'], ['U1', 'MO'], ['U3', 'MO'], ['U4', 'MO', -4], // and on up to the mother tree
]) link(CANOPY[a], CANOPY[b], side);
// The flank giants' old decks, a root up from the floor, now under their crowns.
{
  const deck = (x, z, r, dir, out) => {
    const c = offset([x, z], dir, r + 3.5), y = Math.round(heightAt(x, z) + 7.5);
    turned([c[0], y - 0.25, c[1]], [4.5, 0.25, 4.5], deg(Math.atan2(dir[0], dir[1])), 'bark');
    rampDown(lift(offset(c, out, 4), y), out, 5, 'bark');
    point([c[0], y, c[1]]);
  };
  deck(-30, 34, 5, [0.6, -0.8], [0.8, 0.6]);
  deck(44, 24, 5, [-0.7, -0.7], [-0.7, 0.7]);
}
// Stairs stand on open floor: inside the cliffs' lip, off their crowns' links, clear of what else keeps ground clear.
for (const k of ['S3', 'K1', 'K2', 'N2', 'U3', 'N4']) {
  const a = CANOPY[k], others = keep.filter(([p, q]) => dist(p, a.at) > 1 || dist(q, a.at) > 1);
  const u = free(a, 0, (u) => {
    const c = offset(a.at, u, a.r + 9.6);
    return (
      edge(offset(c, u, 8)) < -10 &&
      others.every(([p, q, gap]) => segment(c, p, q) > gap + 2) &&
      discs.every((d) => d === a || dist(d.at, c) > d.r + 10) &&
      walks.every(([p, q]) => segment(c, p, q) > 12)
    );
  });
  if (u) stairs(a, u);
  else console.warn(`no room for stairs at ${k}`);
}
// Jump pads from each base's clearing up onto its nearest crown, landing 4 m inside the rim: on the
// clearing's south side, off the ways in from the Gorge and the Spine (and the Spine's own pad).
for (const [b, a] of [[BASES[0], CANOPY.S1], [BASES[1], CANOPY.S6]]) {
  const [x, z] = [b[0] - Math.sign(b[0]) * 18, b[1] - 8], u = unit([x, z], a.at);
  slabPad(x, z, lift(offset(a.at, u, -(a.r - 4)).map(r3), a.top), a.top + 4);
  a.links.push([-u[0], -u[1]]);
}
// Spurs and falls turn away from the Spine and its pad's flight: a branch out over its crest would be
// at a mech's head height (or in the flight), and water would pour through it.
const offSpine = (a, r) => (u) =>
  [0.25, 0.5, 0.75, 1].every((t) => {
    const p = offset(a.at, u, (a.r + 0.6 + r) * t);
    return along(p, SPINE).d > 8 && segment(p, SPINE_PAD, station(SPINE, spineLanding).at) > 8;
  });
for (const k of Object.keys(CANOPY)) {
  const r = CANOPY[k].r > 11 ? 6 : 5;
  spur(CANOPY[k], free(CANOPY[k], 0.4, offSpine(CANOPY[k], r)), r);
}
for (const k of ['M2', 'M3', 'N1', 'N3', 'U1', 'MO']) spur(CANOPY[k], free(CANOPY[k], 2.2, offSpine(CANOPY[k], 5)), 5);
for (const k of Object.keys(CANOPY)) for (const s of [0.9, 3.4]) falls(CANOPY[k], free(CANOPY[k], s, offSpine(CANOPY[k], 0)), CANOPY[k].r > 12 ? 2.4 : 1.6);
leaner(...offset(station(GORGE, 30).at, station(GORGE, 30).right, 20), [-station(GORGE, 30).right[0], -station(GORGE, 30).right[1]], 52, 40, 2.4); // a dead giant leaning out over the Gorge
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
// Capture the Flag: each base's stand north of it, its back to the base guns, its doorways to the
// flank and toward the Knoll. A stone hut roofed with bark.
const stands = [270, 180].map((yaw, i) => flagStand([STANDS[i][0], 1, STANDS[i][1]], yaw, { wall: 'stone', roof: 'bark' }));
for (const s of STANDS) clear(s, s, 16);
point([136, 7, -92], at(110, -92), at(-112, -92), at(-136, -110), at(136, -110));

// --- Jump pads: the Gorge's floor up onto the Pulpit, and the east base onto the Spine ----------------
// The Gorge's sits north of the arch, clear of the convoy's walk down the floor south of the breach.
slabPad(...station(GORGE, 112).at, [PULPIT[0], pTop, PULPIT[1]], pTop + 8);
slabPad(...SPINE_PAD, ridgePoint(spineLanding), crestY(spineLanding) + 8);

// --- Convoy's route: [x, y, z] at feet height, each half from the start to its base -------------------
// The hauler starts a third of the way down the Crown deck's west ramp, as far to walk to either base.
// West, toward Grove Station: down the ramp and up the Pulpit's fallen trunk, over the stone arch from
// its top to the east rim, down the breach to the Gorge's floor (clear of A's pad), south along the
// floor under the fallen giant, and up its south end. East, toward Relay Station: up onto the deck and
// the long way round the mother tree, behind its trunk and under its crown, down the east ramp onto
// the Spine's north end, the whole crest south over the tunnel, and down its south end. None sits on
// a terrain cell's edge, where a ray down can miss.
const ROUTE_START = [0, 1, 2].map((i) => westRamp.top[i] + (westRamp.foot[i] - westRamp.top[i]) * 0.3);
const ROUTE = [
  [ROUTE_START, westRamp.foot, at(-56.3, 79.7), at(-56.5, 72.5), [-80.5, 16.57, 36.5], [-79.5, 17, 29.5], at(-36.5, 13.5), at(-31.5, 9.5), at(-30, 7.5), at(-30.5, 3.5), at(-60.5, 5.5), at(-71.5, 2), at(-77.88, -11.38), at(-94.5, -63), at(-98.88, -77.38), at(-106.5, -90), at(-122, -102)],
  [
    ROUTE_START,
    westRamp.top,
    // The long way round the mother tree, behind its trunk, clear of the stubs of branches on it.
    ...[180, 135, 90, 45, 0].map((a) => lift(offset(CROWN, [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)], 14), deckY)),
    eastRamp.top,
    // Along the crest from joint to joint, where its slabs meet.
    ...[LS - 1, ...joints.filter((j) => j < LS).reverse(), 0].map(ridgePoint),
    at(...offset(station(SPINE, 0).at, station(SPINE, 0).dir, -4)), at(112.5, -98), at(120.5, -102), at(122, -102),
  ],
].map((half) => half.map((p) => p.map(r3)));
// The understory keeps off it.
for (const half of ROUTE) for (let i = 1; i < half.length; i++) clear([half[i - 1][0], half[i - 1][2]], [half[i][0], half[i][2]], 6);
{
  const walked = (pts) => pts.slice(1).reduce((sum, b, i) => sum + Math.hypot(...b.map((v, k) => v - pts[i][k])), 0);
  console.log(`Convoy route: ${ROUTE.map((h) => walked(h).toFixed(1)).join(' m west, ')} m east`);
}

// --- The understory: small table trees under the canopy, clear of its terraces; more past the cliffs ------
scatter(
  20261023, 26, 8000,
  (p) => edge(p) < -12 && dist(p, HOLLOW) > 26 && dist(p, KNOLL) > 24 && BASES.every((b) => dist(p, b) > 40) && keep.every(([a, b, gap]) => segment(p, a, b) > gap) && clearOf(p, 7, 18, 4),
  ([x, z], rand) => copse(x, z, rand(4, 6.5), Math.min(r3(heightAt(x, z) + rand(10, 14)), 18)),
);
{
  const rim = [];
  scatter(77, 300, 20000, (p) => edge(p) > 13 && edge(p) < 36 && rim.every((q) => dist(p, q) > 14), (p, rand) => {
    rim.push(p);
    const base = heightAt(...p);
    decor.push({ kind: 'table', at: [Math.round(p[0]), Math.round(base + rand(14, 26)), Math.round(p[1])], r: Math.round(rand(6, 12)), base: Math.round(base - 1) });
  });
}
// Fallen logs and boulders for cover in the open.
for (const [x, z, angle, len, r] of [[-20, -104, 0.3, 18, 1.4], [26, -96, -0.5, 14, 1.2], [-6, 40, 0.1, 18, 1.5], [22, 84, 2.4, 14, 1.3], [-78, -100, 1.2, 14, 1.2]]) {
  const d = [Math.cos(angle) * len * 0.5, Math.sin(angle) * len * 0.5];
  cylinder(at(x - d[0], z - d[1], r * 0.6), at(x + d[0], z + d[1], r * 0.6), r, 'bark');
}
{
  const rand = random(4242);
  for (const [x, z, n] of [[-14, -36, 2], [30, -10, 2], [-30, 86, 2], [120, -60, 2], [-60, -66, 2], [-8, 16, 2]]) {
    for (let k = 0; k < n; k++) {
      const p = [x + rand(-8, 8), z + rand(-8, 8)], half = [rand(1.5, 3.5), rand(1, 2.4), rand(1.5, 3)];
      turned(at(p[0], p[1], half[1] * 0.4), half.map((v) => Math.round(v * 10) / 10), Math.round(rand(0, 180)), 'moss', Math.round(rand(-12, 12)));
    }
  }
}

// --- Fungus: patches in the dark places — the cliffs' feet, the Gorge's floor (the giants' roots and
// the tunnel have theirs) — and none in the bases' clearings.
{
  const spots = [];
  scatter(1031, 18, 20000, (p) => edge(p) > -15 && edge(p) < -7 && spots.every((q) => dist(p, q) > 28) && BASES.every((b) => dist(p, b) > 40), (p, rand) => {
    spots.push(p);
    fungus(...p, rand(1.5, 3.5));
  });
  for (let s = 22, k = 0; s < LG - 12; s += 24, k++) {
    const { at: c, right } = station(GORGE, s);
    fungus(...offset(c, right, k % 2 ? 4.5 : -4.5), 1.5 + (k % 3) * 0.6);
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
// Late dusk, muted: the sun low in the north-west behind the mother tree, a dusty rose horizon under
// slate, grey mist in the Gorge, leaves grey-green, lanterns lit, the fungus's spores adrift, leaves
// coming down.
const palette = {
  sunDir: [-0.5, 0.25, 0.83],
  sky: { horizon: '#a8938a', zenith: '#262a38', sun: '#e6c8a4', stars: 0.2 },
  fog: [45, 260],
  haze: ['#8e8c84', 0.022, 6],
  light: { sky: '#aeb0a6', ground: '#45463c', ambient: 2, sun: '#dcb894', direct: 1.9 },
  lamp: '#ffb35c',
  tint: '#e2ddd2',
  terrain: ['#5d6650', '#6e665c', '#6a6a52'],
  leaf: ['#6f7d6a', '#5e6c5a', '#7c8874', '#55614f'],
  undergrowth: 1,
  cover: 0.7,
  skyline: 'forest',
  motes: [
    { color: [[1, 0.62, 0.25], [1, 0.4, 0.08]], rate: 45, size: 0.2, drift: 0.5, rise: 0.15, life: 6 }, // spores
    // Leaves coming down on a light breeze out of the north-west.
    { color: [[0.44, 0.48, 0.4], [0.34, 0.37, 0.31]], rate: 25, size: 0.22, drift: 0.8, rise: -0.7, life: 9, wind: [1.2, -0.5], range: 30, solid: true },
  ],
  pool: '#58c4a8', // the water standing on the crowns, glowing
  ambience: 'grove', // its sound bed and accents (web/audio.js)
};
for (const s of solids) if (s.mat === 'bark') s.mat = 'pale'; // the forest's wood is bone-pale
// Diagnostics: how steep the walkable slabs run, and where the key pieces stand.
for (const s of solids.filter((s) => s.half[1] === 0.25 && s.tilt)) if (Math.abs(s.tilt) > 26) console.warn(`steep ramp ${s.mat} at ${s.box}: ${s.tilt} degrees`);
console.log(`Pulpit top ${pTop} (ground ${heightAt(...PULPIT).toFixed(1)}, edge ${edge(PULPIT).toFixed(1)}), crest ${crestY(36)}-${crestY(LS / 2)}, tunnel floor ${heightAt(...station(SPINE, TUNNEL).at).toFixed(1)}`);
// Siege: the station down in the Hollow on the south road, halfway between the bases, the AA gun on
// the Knoll's rock table, the ships along the south road.
const onGround = ([x, z]) => [x, r3(heightAt(x, z)), z];
bases(onGround(BASES[0]), onGround(BASES[1]));
// Base guns: two at each eco-station, either side of it.
sentries([[-115, 1, -110], [-140, 1, -104]], [[140, 1, -104], [115, 1, -110]]);
flags(...stands);
siege({ at: onGround(HOLLOW), radius: 12, band: 5 }, { at: [6, 13, -18], radius: 9, band: 3, pad: [12, 13, -22] }, 70);
// Missile Assault: A down in the Gorge by its breach (the west's flank, the Pulpit over it), B on the
// Knoll's rock table, C at the Spine's tunnel (the east's flank).
// C's launch pad is out of the tunnel, by its west mouth.
silos({ at: [-68, -13, 13], radius: 12, band: 5 }, { at: [6, 13, -18], radius: 9, band: 3, pad: [2.5, 13, -17.5] }, { at: [76, -1, 15], radius: 12, band: 5, pad: [70.5, -1.4, 12.5] });
convoy(...ROUTE); // Convoy: the route above
write(new URL('./canopy.json', import.meta.url), { name: 'Canopy', size: SIZE, night: true, palette }, spawns(BASES[0], 1), spawns(BASES[1], -1));
