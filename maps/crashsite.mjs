// Crash Site: a 300 m swamp, most of it taken up by the wreck of a ~300 m
// freighter that came down bow first across the mire and broke in four. The fight is on, in, under
// and between the pieces, at three heights: the water and the holds; the mid decks and the galleries
// along the hull, 9 m up; the top decks, 18-30 m up.
// - The bow (south-west): nose buried in the mound it pushed up, its top deck a 16 degree ramp up to
//   a 24 m overlook at its broken end. Inside, a hold and a mid deck, a ramp between; a window out.
// - The midship: a hold, a mid deck and a top deck, joined by ramps at either end and holed by
//   hatches that don't line up; galleries along both sides at 9 m on struts, the top deck lipping
//   over them; the bridge on top, its roof 30 m up a ramp. Girders join it to the bow at the top and
//   the middle, and to the stern at the top.
// - The stern (north-east): rolled onto its starboard side. Its keel is a ramp up from the water to
//   a ridge, the ridge a walk along the top; its deck, the far face, leans out over the water. Inside,
//   a cavern the length of it, a fallen deck up to a window in that face.
// - The engines, thrown clear: one hollow, a tunnel to walk through; one lying across, cover.
// - The flanks: a torn deck slab propped up, a ramp over a shelter; a hull plate leaning over a lane.
// The water is only for show: mechs wade the terrain under it, the shallows knee deep.
// Writes crashsite.json next to this file; rerun `node maps/crashsite.mjs` after editing.
//
// Asymmetric: all of it is authored here and `write` gets both teams' spawns. The bases face the
// wreck's two sides, each as far from the bow, the stern and the middle as the other.
// Metrics as the other maps': 6.5 m+ clear under decks, ramps near 24 degrees, steps under 0.5 m.
import { bases, beam, box, cylinder, decor, ground, heightAt, lamp, pad, point, r3, railing, ramp, sentries, siege, sign, silos, solids, turned, write } from './kit.mjs';

const SIZE = [300, 300], CELL = 4;
const HALF = 140, CORNER = 60; // the playable ground: a square this far out, its corners rounded
const AMBER = '#ffc46b', TEAL = '#7fe8ff', RED = '#ff3b30', EMERGENCY = '#3fd8ff';
/** A small light that glows `color` and lights its surroundings from `out`: a beacon, an emergency lamp. */
const beacon = ([x, y, z], color, out = [x, y, z]) => sign([r3(x - 0.35), r3(y), r3(z - 0.35)], [r3(x + 0.35), r3(y + 0.7), r3(z + 0.35)], out, color);
/** A broken cable or fitting spitting sparks now and then. */
const sparks = (p) => decor.push({ kind: 'sparks', at: p });

// --- Shapes ------------------------------------------------------------------------------------------
const clamp01 = (t) => Math.min(Math.max(t, 0), 1);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const dist = ([ax, az], [bx, bz]) => Math.hypot(ax - bx, az - bz);
const deg = (rad) => r3((rad * 180) / Math.PI);
function noise(x, z) {
  const hash = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const i = Math.floor(x), j = Math.floor(z), fx = smoothstep(0, 1, x - i), fz = smoothstep(0, 1, z - j);
  const [a, b, c, d] = [hash(i, j), hash(i + 1, j), hash(i, j + 1), hash(i + 1, j + 1)];
  return (a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz) * 2 - 1;
}
function random(seed) {
  let s = seed;
  return (lo = 0, hi = 1) => lo + (hi - lo) * (((s = (s * 16807) % 2147483647) - 1) / 2147483646);
}
function segment([px, pz], [ax, az], [bx, bz]) {
  const [ex, ez] = [bx - ax, bz - az], t = clamp01(((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1));
  return Math.hypot(px - ax - ex * t, pz - az - ez * t);
}
/** Signed distance to the edge of the playable ground. */
function edge([x, z]) {
  const qx = Math.abs(x) - (HALF - CORNER), qz = Math.abs(z) - (HALF - CORNER);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - CORNER;
}

// The wreck's own frame: `a` along it, bow (south-west) to stern (north-east), `c` across it, port
// (north-west, the salvage camp's side) negative. W turns (a, c) into world (x, z); S adds a height.
const R = Math.SQRT1_2;
const W = (a, c) => [r3((a + c) * R), r3((a - c) * R)];
const SHIP = (x, z) => [(x + z) * R, (x - z) * R];
const S = (a, c, y) => {
  const [x, z] = W(a, c);
  return [x, r3(y), z];
};
const BASES = [W(0, -115), W(0, 115)]; // the salvage camp (team 0), the pumping station (team 1)

// The pieces, along the wreck: the bow, a gap, the midship, a gap, the stern, the engines beyond.
const BOW = [-150, -66], MID = [-55, 55], STERN = [64, 128];
const HOLD = 0.2, DECK = 9, TOP = 18, BRIDGE = 30; // the midship's levels (tops); the water is at 0
const BEAM = 26; // half the midship's width
/** The bow's top deck, up from its buried nose to its broken end. */
const bowTop = (a) => (24 * (a - BOW[0])) / (BOW[1] - BOW[0]);

// --- Terrain -----------------------------------------------------------------------------------------
function height(x, z) {
  const [a, c] = SHIP(x, z), p = [x, z];
  let h = -0.8 + 0.7 * noise(x / 30, z / 30) + 0.4 * noise(x / 12 + 5.1, z / 12 - 3.3);
  h += Math.max(0, 3 * noise(x / 55 + 3.7, z / 55 - 1.9) - 0.7); // hummocks out of the water
  // The furrow: mud levelled just under the water along the wreck, berms either side of it, a mound
  // where the nose dug in.
  const along = smoothstep(-175, -150, a) * smoothstep(165, 140, a);
  h += (-0.2 - h) * (1 - smoothstep(36, 42, Math.abs(c))) * along;
  h += 3 * Math.exp(-((Math.abs(c) - 50) ** 2) / 60) * along * (0.6 + 0.4 * noise(a / 14, c / 14));
  h += 6 * Math.exp(-((a + 158) ** 2 + c * c) / 300);
  for (const b of BASES) h += (1.5 - h) * smoothstep(34, 22, dist(p, b)); // dry islands for the bases
  // The crater's rim: banks too steep to climb, up to dead woods no hover reaches.
  const w = edge(p) + 8;
  if (w > 0) h += Math.min(w < 8 ? (w * w) / 10 : 6.4 + (w - 8) * 1.6, 18) + 3 * smoothstep(8, 14, w) * noise(x / 11, z / 11);
  return h;
}
ground(SIZE, CELL, height);
const at = (x, z, up = 0) => [x, Math.round((heightAt(x, z) + up) * 100) / 100, z];
const groundAt = (a, c) => heightAt(...W(a, c));

// --- Pieces ------------------------------------------------------------------------------------------
const keep = []; // [a, b, gap] on the ground (world x, z): dead trees keep this far clear
const clear = (a, b = a, gap = 8) => keep.push([a, b, gap]);
const spots = []; // candidate waypoints, kept at the end where a Heavy fits
const spot = (a, c, y) => spots.push(S(a, c, y));

/** A box lined up with the wreck: a0..a1 along, c0..c1 across, y0..y1 up. */
function block(a0, a1, c0, c1, y0, y1, mat) {
  turned(S((a0 + a1) / 2, (c0 + c1) / 2, (y0 + y1) / 2), [r3((c1 - c0) / 2), r3((y1 - y0) / 2), r3((a1 - a0) / 2)], 45, mat);
}
/** A slab whose top surface runs from point `low` to point `high`, `width` across and `depth` deep under it. */
function slab(low, high, width, depth, mat) {
  const [dx, dy, dz] = [0, 1, 2].map((i) => high[i] - low[i]);
  const run = Math.hypot(dx, dz), tilt = Math.atan2(dy, run), yaw = Math.atan2(-dx, -dz);
  const n = [Math.sin(tilt) * Math.sin(yaw), Math.cos(tilt), Math.sin(tilt) * Math.cos(yaw)];
  const center = [0, 1, 2].map((i) => r3((low[i] + high[i]) / 2 - (depth / 2) * n[i]));
  turned(center, [width / 2, depth / 2, Math.hypot(run, dy) / 2].map(r3), deg(yaw), mat, deg(tilt));
}
/**
 * A plate run along the wreck from a0 to a1 whose cross-section goes from P to Q ([c, y]), `t`
 * thick on its `side` (+1 left of P to Q, -1 right): hulls rolled over, engine casings.
 */
function plate(a0, a1, [pc, py], [qc, qy], t, mat, side = -1) {
  const dc = qc - pc, dy = qy - py, len = Math.hypot(dc, dy), n = [-dy / len, dc / len];
  const mc = (pc + qc) / 2 + (side * n[0] * t) / 2, my = (py + qy) / 2 + (side * n[1] * t) / 2;
  turned(S((a0 + a1) / 2, mc, my), [r3((a1 - a0) / 2), r3(t / 2), r3(len / 2)], -45, mat, deg(Math.atan2(-dy, -dc)));
}

/** Splits a0..a1 × c0..c1 into the rectangles left once `holes` ([a0, a1, c0, c1]) are cut out. */
function tiles([a0, a1], [c0, c1], holes) {
  const cuts = (lo, hi, values) => [...new Set([lo, hi, ...values.filter((v) => v > lo && v < hi)])].sort((p, q) => p - q);
  const out = [], as = cuts(a0, a1, holes.flatMap((h) => [h[0], h[1]]));
  for (let i = 0; i + 1 < as.length; i++) {
    const am = (as[i] + as[i + 1]) / 2, here = holes.filter((h) => h[0] < am && am < h[1]), cs = cuts(c0, c1, here.flatMap((h) => [h[2], h[3]]));
    for (let j = 0; j + 1 < cs.length; j++) {
      const cm = (cs[j] + cs[j + 1]) / 2;
      if (!here.some((h) => h[2] < cm && cm < h[3])) out.push([as[i], as[i + 1], cs[j], cs[j + 1]]);
    }
  }
  return out;
}
/** A level deck, its top at `y`, over a0..a1 × c0..c1 but for its `holes`; waypoints over it every 18 m, off the holes. */
function deck(y, as, cs, holes = [], mat = 'metal', t = 0.5) {
  for (const [a0, a1, c0, c1] of tiles(as, cs, holes)) block(a0, a1, c0, c1, y - t, y, mat);
  for (let a = as[0] + 5; a < as[1] - 3; a += 18) {
    for (let c = cs[0] + 6; c < cs[1] - 3; c += 18) if (!holes.some((h) => a > h[0] - 3 && a < h[1] + 3 && c > h[2] - 3 && c < h[3] + 3)) spot(a, c, y);
  }
}
/** A wall at `c` along a0..a1 from y0 to y1 but for its `openings` ([a0, a1, y0, y1]), 1.2 m thick. */
function side(c, as, [y0, y1], openings = [], mat = 'hull') {
  for (const [a0, a1, b0, b1] of tiles(as, [y0, y1], openings)) block(a0, a1, c - 0.6, c + 0.6, b0, b1, mat);
}
/** A wall across the wreck at `a`, c0..c1 from y0 to y1 but for its `openings` ([c0, c1, y0, y1]). */
function bulkhead(a, cs, [y0, y1], openings = [], mat = 'hull') {
  for (const [c0, c1, b0, b1] of tiles(cs, [y0, y1], openings)) block(a - 0.6, a + 0.6, c0, c1, b0, b1, mat);
}
/**
 * A ramp along the wreck at `c`, `width` wide, from (a0, y0) up to (a1, y1), stepped full underneath
 * down to `base` so nothing gets under it; waypoints at its foot and top.
 */
function shipRamp(c, [a0, y0], [a1, y1], width, base, mat = 'metal') {
  ramp(S(a0, c, y0), S(a1, c, y1), width, mat, false);
  const n = Math.max(1, Math.ceil((y1 - y0) / 1.5)), dir = Math.sign(a1 - a0);
  for (let k = 0; k < n; k++) {
    const p = a0 + ((a1 - a0) * k) / n, q = a0 + ((a1 - a0) * (k + 1)) / n, top = y0 + ((y1 - y0) * k) / n - 0.3;
    if (top > base + 0.2) block(Math.min(p, q), Math.max(p, q), c - width / 2 + 0.1, c + width / 2 - 0.1, base, top, mat);
  }
  spot(a0 - dir * 3, c, y0);
  spot((a0 + a1) / 2, c, (y0 + y1) / 2 + 0.2);
  spot(a1 + dir * 3, c, y1);
}

/** A container `len` m long at world (x, z), turned `yaw`, its floor at `y` (default the ground). */
function container(x, z, yaw, mat, { y = heightAt(x, z) - 0.3, tilt = 0, len = 12 } = {}) {
  turned([r3(x), r3(y + 1.3), r3(z)], [1.3, 1.3, len / 2], yaw, mat, tilt);
}
/** A container lined up with the wreck at (a, c), its floor at `y`. */
const crate = (a, c, y, mat, len = 12, turn = 0) => container(...W(a, c), 45 + turn, mat, { y, len });

/** A dead tree: a snag with a few bare limbs, perhaps a scrap of crown; a mangrove stands on its roots. */
function snag(x, z, rand) {
  const r = rand(0.8, 1.6), h = rand(10, 20), mangrove = rand() < 0.3, y = heightAt(x, z) + (mangrove ? 4 : -1);
  if (mangrove) {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * 2 * Math.PI + rand(-0.3, 0.3);
      cylinder([x + Math.cos(a) * r, y + 1, z + Math.sin(a) * r], at(x + Math.cos(a) * 6, z + Math.sin(a) * 6, -0.5), r * 0.45, 'deadwood');
    }
  }
  const lean = [rand(-1.5, 1.5), rand(-1.5, 1.5)], top = [x + lean[0], y + h, z + lean[1]];
  cylinder([x, y, z], top, r, 'deadwood');
  for (let k = 0, n = Math.floor(rand(2, 4)); k < n; k++) {
    const a = rand(0, 2 * Math.PI), f = rand(0.55, 0.9), from = [x + lean[0] * f, y + h * f, z + lean[1] * f];
    cylinder(from, [from[0] + Math.cos(a) * rand(4, 7), from[1] + rand(2, 5), from[2] + Math.sin(a) * rand(4, 7)], r * 0.3, 'deadwood');
  }
  if (rand() < 0.5) decor.push({ kind: 'canopy', at: top.map(Math.round), r: Math.round(rand(3, 6)) });
  clear([x, z], [x, z], mangrove ? 14 : 10);
}

// --- The midship: hold, mid deck, top deck, galleries, the bridge --------------------------------------
{
  const [a0, a1] = MID;
  // Hatches that don't line up, and wells where the ramps climb through.
  const midHatches = [[-40, -24, -10, 10], [-8, 8, -10, 10], [24, 40, -10, 10]];
  const topHatches = [[-28, -14, -10, 10], [0, 14, -10, 4]];
  deck(HOLD, MID, [-BEAM, BEAM]);
  deck(DECK, MID, [-BEAM, BEAM], [...midHatches, [-48, -31, 15, 21], [31, 48, -21, -15]]);
  deck(TOP, MID, [-BEAM - 3, BEAM + 3], [...topHatches, [-48, -31, -21, -15], [31, 48, 15, 21]]); // lipping 3 m over the sides
  // Ramps: hold to mid deck at either end, then mid deck to top, on the other side.
  shipRamp(18, [-50, HOLD], [-31, DECK], 6, HOLD);
  shipRamp(-18, [50, HOLD], [31, DECK], 6, HOLD);
  shipRamp(-18, [-50, DECK], [-31, TOP], 6, DECK);
  shipRamp(18, [50, DECK], [31, TOP], 6, DECK);
  // Sides: breached to the water in the hold, doors out onto the galleries from the mid deck.
  side(-BEAM, MID, [-1, TOP - 0.5], [[-20, -6, -1, 7], [-34, -26, DECK, 16], [10, 18, DECK, 16]]);
  side(BEAM, MID, [-1, TOP - 0.5], [[6, 20, -1, 7], [-14, -6, DECK, 16], [26, 34, DECK, 16]]);
  // The fore end broke open: torn plates hang off it. The aft end: a bulkhead, a cargo door at the bottom.
  for (const [c, y] of [[-BEAM, 4], [BEAM, 12]]) slab(S(a0 - 6, c, y), S(a0 + 2, c, y + 5), 1.2, 6, 'rust');
  bulkhead(a1, [-BEAM, BEAM], [-1, TOP - 0.5], [[-8, 8, -1, 7]]);
  // Pillars between the hold and mid deck, and between the mid and top decks.
  for (const a of [-44, -16, 16, 44]) for (const c of [-12, 12]) block(a - 0.6, a + 0.6, c - 0.6, c + 0.6, HOLD, DECK - 0.5, 'hull');
  for (const a of [-20, 20]) for (const c of [-12, 12]) block(a - 0.6, a + 0.6, c - 0.6, c + 0.6, DECK, TOP - 0.5, 'hull');
  // Cargo in the hold and on the mid deck: cover between the pillars.
  crate(-30, -4, HOLD, 'rust');
  crate(-30, -4, HOLD + 2.6, 'panel', 8);
  crate(0, 16, HOLD, 'metal');
  crate(28, -2, HOLD, 'panel', 8, 90);
  crate(-6, -18, HOLD, 'rust', 8);
  crate(14, 20, DECK, 'rust', 8);
  crate(-18, -20, DECK, 'panel', 12);
  crate(46, 2, DECK, 'metal', 8, 90);
  // Cover up top: containers that stayed lashed, and a deck crane leaning over the forward hatch.
  crate(-40, 6, TOP, 'rust');
  crate(-20, 20, TOP, 'panel', 8, 90);
  crate(8, -20, TOP, 'metal');
  crate(44, -4, TOP, 'rust', 8, 90);
  for (const c of [-20, 20]) beam(S(-36, c, TOP), S(-34, 0, TOP + 14), 0.9, 0.9, 'metal');
  beam(S(-34, 0, TOP + 14), S(-14, 2, TOP + 19), 0.8, 1, 'metal');
  decor.push({ kind: 'pipe', from: S(-14, 2, TOP + 19), to: S(-14, 2, TOP + 9), r: 0.15 });
  // Galleries along the outside at the mid deck's height, on struts, with ramps up from the water.
  for (const s of [-1, 1]) {
    block(-45, 45, s < 0 ? -BEAM - 8 : BEAM, s < 0 ? -BEAM : BEAM + 8, DECK - 0.5, DECK, 'metal');
    railing(S(-45, s * (BEAM + 8), DECK), S(45, s * (BEAM + 8), DECK));
    for (const a of [-36, -12, 12, 36]) beam(S(a, s * (BEAM + 0.6), 5), S(a, s * (BEAM + 7), DECK - 0.5), 0.6, 0.6, 'hull'); // high enough to walk under
    for (let a = -40; a <= 40; a += 20) spot(a, s * (BEAM + 4), DECK);
    lamp(S(s * 20, s * (BEAM + 6), DECK));
  }
  shipRamp(-BEAM - 4, [-66, groundAt(-66, -BEAM - 4)], [-45, DECK], 6, -1.5);
  shipRamp(BEAM + 4, [64, groundAt(64, BEAM + 4)], [45, DECK], 6, -1.5);
  // The bridge, on the top deck aft: its roof the highest place on the map, up a ramp from mid-ship.
  block(20, 36, -12, 12, TOP - 0.5, BRIDGE, 'tower');
  shipRamp(9, [-4, TOP], [20, BRIDGE], 6, TOP);
  railing(S(20, -12, BRIDGE), S(36, -12, BRIDGE));
  beam(S(30, 0, BRIDGE), S(30, 0, BRIDGE + 12), 0.5, 0.5, 'metal');
  beacon(S(30, 0, BRIDGE + 12), RED); // the mast's warning light, still on
  // Emergency lights on the hold's pillars and the mid deck's, cold in the dark; sparks where it broke.
  for (const [a, c] of [[-44, -12], [16, 12], [44, -12]]) beacon(S(a, c - Math.sign(c) * 0.9, 5.5), EMERGENCY, S(a, c * 0.6, 5));
  for (const [a, c] of [[-20, 12], [20, -12]]) beacon(S(a, c - Math.sign(c) * 0.9, DECK + 5), EMERGENCY, S(a, c * 0.6, DECK + 4));
  for (const p of [S(a0 + 1, -18, 15), S(a0 + 1, 20, 7), S(a0 + 2, 4, DECK - 1)]) sparks(p);
  spot(28, -4, BRIDGE);
  for (const [a, c, y] of [[-40, 0, HOLD], [0, 0, HOLD], [40, 0, HOLD], [-22, 18, DECK], [22, -18, DECK], [-40, 20, TOP], [40, -20, TOP]]) lamp(S(a, c, y));
  clear(W(a0, 0), W(a1, 0), 46);
}

// --- The bow: buried nose, top deck up to the overlook, a hold and a mid deck inside --------------------
{
  const rand = random(1979);
  const buried = (a, c) => groundAt(a, c) - 2;
  const top = (a, c) => S(a, c, bowTop(a));
  // Sides follow the top deck down into the mud; a breach into the hold to port, a window out of the
  // mid deck to starboard.
  for (const s of [-1, 1]) {
    for (const [p, q] of [[BOW[0], -138], [-138, -125]]) slab(top(p, s * 12), top(q, s * 12), 1.2, r3(bowTop((p + q) / 2) - buried((p + q) / 2, s * 12) + 2), 'hull');
    slab(top(-125, s * 12), top(-125, s * 22), 1.2, r3(bowTop(-125) - buried(-125, s * 22)), 'hull');
    const cuts = s < 0 ? [-125, -104, -94, -66] : [-125, -84, -76, -66];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [p, q] = [cuts[i], cuts[i + 1]], hole = i === 1;
      const bottom = hole ? (s < 0 ? 8 : 16) : Math.min(buried(p, s * 22), buried(q, s * 22));
      slab(top(p, s * 22), top(q, s * 22), 1.2, r3(bowTop((p + q) / 2) - bottom), rand() < 0.25 ? 'rust' : 'hull');
      if (hole && s > 0) slab(S(p, s * 22, 9.5), S(q, s * 22, 9.5), 1.2, 12, 'hull'); // under the window
    }
  }
  // The top deck: the nose, then full width up to the broken end.
  for (const [p, q, w] of [[BOW[0], -125, 24], [-125, -96, 44], [-96, BOW[1], 44]]) slab(top(p, 0), top(q, 0), w, 0.6, 'metal');
  for (let a = -140; a <= BOW[1] - 4; a += 16) for (const c of a < -125 ? [0] : [-10, 10]) spot(a, c, bowTop(a));
  // A prow ahead of the nose, dug into the mound.
  for (const s of [-1, 1]) slab(S(BOW[0], s * 12, 3), S(BOW[0] - 14, 0, 1), 1.2, 9, 'hull');
  // Inside: a bulkhead where it's crushed, the hold floor, a mid deck from where it clears, a ramp between.
  bulkhead(-112, [-22, 22], [HOLD - 1, bowTop(-112)]);
  deck(HOLD, [-112, BOW[1]], [-22, 22]);
  deck(9.5, [-92, BOW[1]], [-22, 22], [[-89, -74, 10, 16]]);
  shipRamp(13, [-70, HOLD], [-89, 9.5], 6, HOLD);
  // Containers that slid down the top deck and fetched up against each other.
  for (const [a, c, mat] of [[-110, -8, 'rust'], [-108, 6, 'panel'], [-84, 14, 'metal']]) container(...W(a, c), 45, mat, { y: bowTop(a) - 0.1, tilt: -16 });
  crate(-100, 6, HOLD, 'rust', 8);
  crate(-80, -10, HOLD, 'panel');
  crate(-72, 6, 9.5, 'metal', 8, 90);
  lamp(S(-100, -14, HOLD));
  lamp(S(-78, 18, 9.5));
  // To the midship: a girder at the top, a fallen beam at the mid deck, the water between.
  slab(S(-68, 0, bowTop(-68)), S(-50, 0, TOP), 4, 1.5, 'metal');
  railing(S(-68, -2, bowTop(-68)), S(-50, -2, TOP));
  slab(S(-68, -8, 9.5), S(-52, -8, DECK), 4, 1, 'metal');
  spot(-59, 0, (bowTop(-68) + TOP) / 2 + 0.2);
  spot(-60, -8, 9.3);
  for (const a of [-60, -61]) spot(a, 10, groundAt(a, 10));
  lamp(S(-70, 0, bowTop(-70)));
  beacon(S(-90, 21, 12), RED, S(-90, 24, 12)); // by the window out of the mid deck
  for (const p of [S(BOW[1] + 1, 18, 20), S(BOW[1] + 1, -14, 5)]) sparks(p);
  clear(W(BOW[0] - 16, 0), W(BOW[1], 0), 40);
}

// --- The stern: rolled onto its starboard side ---------------------------------------------------------
{
  const [a0, a1] = STERN;
  // Its cross-section, starboard to the right: the keel a ramp up from the port water to a ridge, the
  // port side now a walk along the top, the deck leaning out over the starboard water.
  const keel = [[-32, -1], [-8, 14]], walk = [[-8, 14], [22, 21]], face = [[22, 21], [17, 2]];
  plate(a0, a1, ...keel, 1.2, 'hull', -1);
  plate(a0, a1, ...walk, 1.2, 'hull', -1);
  // The deck face, holed by a window looking out from the cavern's fallen deck.
  const faceAt = (y) => face[0][0] + ((face[1][0] - face[0][0]) * (y - face[0][1])) / (face[1][1] - face[0][1]);
  for (const [p, q, y0, y1] of [[a0, 88, 2, 21], [104, a1, 2, 21], [88, 104, 2, 10], [88, 104, 16, 21]]) plate(p, q, [faceAt(y1), y1], [faceAt(y0), y0], 1.2, 'rust', -1);
  // Inside: the old mid deck, fallen into a ramp up to the window.
  plate(a0 + 6, a1 - 6, [-12, HOLD], [15, 10.5], 0.8, 'metal', -1);
  for (let a = a0 + 12; a < a1 - 6; a += 18) {
    spot(a, -24, -1 + (15 * 8) / 24 + 0.3); // up the keel
    spot(a, -4, 14 + (7 * 4) / 30 + 0.3); // along the top
    spot(a, 12, 18.7);
    spot(a, -2, HOLD + (10.3 * 10) / 27 + 0.3); // up the fallen deck
    spot(a, 13, 9.9);
  }
  for (const a of [a0 + 3, (a0 + a1) / 2, a1 - 3]) spot(a, -18, groundAt(a, -18)); // the cavern's floor
  lamp(S(96, 12, 9.8));
  lamp(S(76, 6, 16.3));
  beacon(S(110, -14, 1), EMERGENCY, S(110, -10, 3)); // down in the cavern
  for (const p of [S(a0, 4, 12), S(a1, -6, 10)]) sparks(p);
  // From the midship's top deck down a girder onto the ridge.
  slab(S(53, -8, TOP), S(a0 + 2, -8, 14.6), 4, 1.5, 'metal');
  clear(W(a0, 0), W(a1, 0), 40);
}

// --- The engines, thrown clear ----------------------------------------------------------------------
{
  // One hollow: an octagonal casing to walk through, its floor flush with the water.
  const [a0, a1, c, apo] = [132, 154, -20, 7.5], rad = apo / Math.cos(Math.PI / 8), cy = HOLD + apo;
  for (let k = 0; k < 8; k++) {
    const t0 = -Math.PI / 2 - Math.PI / 8 + (k * Math.PI) / 4, t1 = t0 + Math.PI / 4;
    plate(a0, a1, [c + rad * Math.cos(t0), cy + rad * Math.sin(t0)], [c + rad * Math.cos(t1), cy + rad * Math.sin(t1)], 1, k % 3 ? 'metal' : 'rust', -1);
  }
  for (const a of [a0 + 4, (a0 + a1) / 2, a1 - 4]) spot(a, c, HOLD);
  for (const a of [a0 - 6, a1 + 6]) spot(a, c, groundAt(a, c));
  lamp(S((a0 + a1) / 2, c + 4, HOLD));
  // One solid, lying across.
  cylinder(S(150, -2, 4.5), S(140, 22, 5.5), 5, 'metal');
  cylinder(S(150.5, -3, 4.5), S(152, -7, 4.5), 6, 'rust');
  clear(W(a0, c), W(a1, c), 14);
  clear(W(150, -2), W(140, 22), 10);
}

// --- The flanks: a deck slab propped up to port, a hull plate leaning over a lane to starboard ------------
{
  // Port: a slab of deck 26 x 24 m, one edge in the water, the other up on containers 8 m high.
  const [a, lo, hi] = [-20, -84, -58];
  slab(S(a, lo, groundAt(a, lo) - 0.3), S(a, hi, 8), 24, 0.8, 'metal');
  for (const da of [-9, 9]) for (const y of [0, 2.6, 5.2]) container(...W(a + da, hi - 1.5), 45 + 90, y ? 'panel' : 'rust', { y: groundAt(a + da, hi - 1.5) - 0.3 + y, len: 8 });
  // Filled in steps under its low half, so the shelter under its high edge is all a mech can get into.
  const surface = (c) => groundAt(a, lo) - 0.3 + ((8.3 - groundAt(a, lo)) * (c - lo)) / (hi - lo);
  for (const [p, q] of [[lo + 3, lo + 9], [lo + 9, lo + 15]]) block(a - 11.5, a + 11.5, p, q, -1.5, surface(p) - 0.9, 'hull');
  for (const c of [lo + 6, lo + 18]) spot(a, c, surface(c) + 0.3);
  spot(a, hi - 4, groundAt(a, hi - 4)); // in the shelter
  clear(W(a - 14, lo), W(a + 14, hi), 14);
  // Starboard: a sheet of hull 36 m long torn off and leaning over a lane, on a stack of containers.
  const [b, foot, head] = [26, 58, 72];
  plate(b - 18, b + 18, [foot, -1], [head, 17], 1, 'hull', 1);
  for (const da of [-12, 12]) for (const y of [0, 2.6, 5.2, 7.8]) crate(b + da, head + 3, groundAt(b + da, head + 3) - 0.3 + y, y % 5 ? 'panel' : 'rust', 8, 90);
  block(b - 18, b + 18, foot + 0.5, foot + 4, -1.5, 3.5, 'hull'); // the low edge's foot, so nothing wedges in it
  for (const a of [b - 12, b, b + 12]) spot(a, 67, groundAt(a, 67)); // under it
  clear(W(b - 20, foot - 2), W(b + 20, head + 6), 12);
}

// --- Crash debris: spilled containers out on the water ----------------------------------------------
crate(-60, 40, groundAt(-60, 40) - 0.3, 'rust', 12, 30);
crate(-62, 44, groundAt(-62, 44) + 2.3, 'panel', 8, 25);
crate(70, -44, groundAt(70, -44) - 0.3, 'metal', 12, -20);
crate(10, -60, groundAt(10, -60) - 0.3, 'panel', 12, 70);
crate(-30, 58, groundAt(-30, 58) - 0.3, 'rust', 8, -40);
crate(100, -30, groundAt(100, -30) - 0.3, 'rust', 12, 10);
crate(-100, 30, groundAt(-100, 30) - 0.3, 'metal', 12, -15);

// --- Bases -------------------------------------------------------------------------------------------
{
  // The salvage camp (north-west): a crane over the water, containers stacked, a hab.
  const [x, z] = BASES[0], g = 1.5;
  box([x + 14, g - 2, z - 26], [x + 17, g + 22, z - 23], 'metal'); // crane tower
  beam([x + 15.5, g + 21, z - 24.5], [x + 30, g + 26, z - 40], 1, 1.2, 'metal'); // its boom, out toward the wreck
  decor.push({ kind: 'pipe', from: [x + 30, g + 26, z - 40], to: [x + 30, g + 12, z - 40], r: 0.15 });
  box([x - 22, g - 2, z - 6], [x - 8, g + 5, z + 4], 'panel'); // hab, roof a hover up
  container(x + 6, z + 14, 0, 'rust', { y: g });
  container(x + 6, z + 14, 0, 'panel', { y: g + 2.6, len: 8 });
  container(x - 4, z - 18, 90, 'metal', { y: g });
  container(x + 18, z + 2, 30, 'panel', { y: g, len: 8 });
  for (const p of [[x - 10, g, z - 10], [x + 12, g, z - 20], [x + 2, g, z + 10]]) lamp(p);
  sign([x - 22.2, g + 2, z - 4], [x - 22, g + 4, z + 2], [x - 24, g + 2, z - 1], AMBER);
  clear(BASES[0], BASES[0], 36);
}
{
  // The pumping station (south-east): a pump house on a deck on stilts, up a ramp; tanks, a pipe to the hull.
  const [x, z] = BASES[1], g = 1.5;
  box([x + 2, g + 6.5, z - 14], [x + 18, g + 7, z + 2], 'metal'); // deck, 6.5 m clear under it
  for (const [dx, dz] of [[3, -13], [17, -13], [3, 1], [17, 1]]) box([x + dx - 0.4, g - 1, z + dz - 0.4], [x + dx + 0.4, g + 6.5, z + dz + 0.4], 'metal');
  box([x + 8, g + 7, z - 12], [x + 16, g + 11, z - 2], 'panel'); // pump house on the deck
  slab([x - 12, g, z - 10], [x + 2, g + 7, z - 10], 6, 7.5, 'metal'); // ramp up to the deck
  railing([x + 2, g + 7, z + 2], [x + 18, g + 7, z + 2]);
  for (const [dx, dz] of [[14, 14], [22, 6]]) cylinder([x + dx, g - 1, z + dz], [x + dx, g + 7, z + dz], 3.5, 'tank');
  decor.push({ kind: 'pipe', from: [x + 2, g + 3, z - 2], to: [x - 30, g + 1, z + 30], r: 0.6 });
  container(x - 20, z - 16, 60, 'rust', { y: g });
  container(x + 28, z + 22, 10, 'metal', { y: g, len: 8 });
  for (const p of [[x + 6, g + 7, z - 4], [x - 12, g, z - 16], [x + 10, g, z + 10]]) lamp(p);
  sign([x + 7.8, g + 8, z - 10], [x + 8, g + 10, z - 5], [x + 6, g + 8, z - 7.5], TEAL);
  point([x + 6, g + 7, z - 8], [x - 15, g, z - 10]);
  clear(BASES[1], BASES[1], 36);
}

// --- Jump pads: from each base onto the midship's top deck, landing with its width ahead -----------------
function slabPad(x, z, to, apex) {
  const top = Math.round((heightAt(x, z) + 0.3) * 10) / 10;
  box([x - 4, top - 3, z - 4], [x + 4, top, z + 4], 'concrete');
  pad([x, top, z], to, apex);
  clear([x, z], [x, z], 8);
}
slabPad(...W(-14, -92), S(-6, -16, TOP), TOP + 8);
slabPad(...W(-14, 92), S(-6, 16, TOP), TOP + 8);

// --- Dead trees in the open water, and dead woods beyond the rim ------------------------------------------
{
  const rand = random(4404);
  for (let n = 0, tries = 0; n < 32 && tries < 8000; tries++) {
    const p = [rand(-150, 150), rand(-150, 150)];
    if (edge(p) < -12 && keep.every(([a, b, gap]) => segment(p, a, b) > gap)) snag(...p, rand), n++;
  }
  for (let n = 0, tries = 0; n < 140 && tries < 8000; tries++) {
    const p = [rand(-150, 150), rand(-150, 150)];
    if (edge(p) > 12 && edge(p) < 30) {
      decor.push({ kind: 'canopy', at: at(p[0], p[1], rand(3, 8)).map(Math.round), r: Math.round(rand(5, 9)) });
      n++;
    }
  }
}

// --- Waypoints -----------------------------------------------------------------------------------------
// The wreck's own (on its decks, ramps and walks), then a grid over the open water, each kept where a
// Heavy fits, nudged off anything in the way.
{
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
  for (const p of spots) if (!blocked(p, 1.5)) point(p);
  const gentle = ([x, z]) => Math.max(Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)), Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2))) / 4 < Math.tan(0.48);
  for (let j = 0, z = -140; z <= 140; j++, z += 20) {
    for (let x = -140 + (j % 2) * 10; x <= 140; x += 20) {
      const inside = ([px, pz]) => {
        const [a, c] = SHIP(px, pz);
        return (a > BOW[0] - 2 && a < BOW[1] && Math.abs(c) < 24) || (a > MID[0] && a < MID[1] && Math.abs(c) < BEAM + 1);
      };
      const spot = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]].map(([dx, dz]) => [x + dx, z + dz]).find((p) => edge(p) < -13 && !inside(p) && gentle(p) && !blocked(at(...p)));
      if (spot) point(at(...spot));
    }
  }
}

// --- Spawns, write ---------------------------------------------------------------------------------
// Night: a cold moon high in the south-east over blue mist, the water dark and glossy under it,
// the wreck's own lights still burning, spores drifting glowing over the water.
const palette = {
  sunDir: [0.55, 0.55, -0.63],
  sky: { horizon: '#3a5676', zenith: '#081226', sun: '#cfe2ff', stars: 0.6 },
  fog: [35, 230],
  haze: ['#5a7a9e', 0.035, 3.5],
  light: { sky: '#7f9cc8', ground: '#18222e', ambient: 1.7, sun: '#a8c4ff', direct: 1.4 },
  lamp: '#9fe6ff',
  tint: '#b9c8dc',
  terrain: ['#3e4a44', '#55585a', '#4a4a3c'],
  leaf: ['#3e5248', '#46584a', '#52604e', '#3a4a40'],
  undergrowth: 0.6,
  reeds: 1,
  water: { level: 0, color: '#1e3448', opacity: 0.8 },
  cover: 0.65,
  skyline: 'swamp',
  motes: [
    { color: [[0.6, 0.95, 1], [0.15, 0.45, 1]], rate: 70, size: 0.22, drift: 0.4, rise: 0.25, life: 6 },
    // A storm: rain driven on the wind, and lightning every few seconds lighting up the wreck.
    { color: [[0.62, 0.7, 0.82]], alpha: 0.35, streak: 0.04, rate: 1800, drift: 0.5, rise: -26, life: 1.1, wind: [7, 3], range: 26 },
  ],
  lightning: { every: [6, 15], strength: 1 },
  ambience: 'storm', // its sound bed and accents (web/audio.js)
};
// Four each, on the base islands, clear of their props.
const spawns = (points) => points.map(([x, z]) => [x, 1.6, z]);
const [cx, cz] = BASES[0], [sx, sz] = BASES[1];
// Missile Assault: a silo on each piece of the wreck, as far from either base: A up on the bow's
// overlook, B in the midship's hold (the decks over its hatches out of its band), C in the stern's
// cavern and on its fallen deck.
bases([cx, 1.6, cz], [sx, 1.6, sz]);
// Base guns: two on each base island, over its landings.
sentries([[-91.5, 6.5, 77], [-70.5, 1.5, 73]], [[76, 1.5, -65], [63, 1.5, -84]]);
// The pads: on the bow's sloping deck (tilted with it), on the hold's floor under the hatches, and up
// on the stern's ridge walk over the cavern.
silos({ at: S(-78, 0, bowTop(-78)), radius: 12, band: 4 }, { at: S(0, 0, HOLD), radius: 14, band: 5 }, { at: S(96, 0, 1), radius: 14, band: 6, pad: [67.882, 15.87, 67.882] });
// Siege: the station in the midship's hold, the AA gun on the bridge's roof (the highest place on
// the map), the ships over the midship, clear of the bridge's mast.
siege({ at: S(0, 0, HOLD), radius: 14, band: 5 }, { at: S(28, 0, BRIDGE), radius: 8, band: 3, pad: S(33, 5, BRIDGE) }, 60);
write(
  new URL('./crashsite.json', import.meta.url),
  { name: 'Crash Site', size: SIZE, night: true, palette },
  spawns([[cx + 2, cz - 6], [cx + 10, cz - 2], [cx - 4, cz - 12], [cx + 4, cz - 14]]),
  spawns([[sx - 6, sz + 8], [sx + 2, sz + 12], [sx - 12, sz + 2], [sx - 10, sz + 12]]),
);
