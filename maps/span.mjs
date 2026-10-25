// Span: a 300 m desert under a hard yellow noon, crossed by a broken arch. The arch springs from
// two towns in the NW and SE corners and climbs (36 degrees at its feet, walkable all the way) to
// 36 m over the middle, where its two arms stop 24 m short of each other: climb an arm for the view,
// but there's no way across at the top. Under the gap lies the Keystone, a fallen block with a
// ramp up each long side. Spawns hold the NE and SW corners in walled yards; between each and the
// middle stands a mesa with a drift up its back, flanked by outcrops that leave slot canyons at its
// ends. Sandstone hoodoos frame the arms, and dunes roll across the open ground between.
// Writes span.json next to this file; rerun `node maps/span.mjs` after editing.
//
// The north half (z > 0: the NW arm and town, the NE yard and mesa) is authored here; `write`
// (maps/kit.mjs) adds the 180-degree twin. Much of it is laid out along the arch: `s` m from the
// middle toward the NW town, `v` m across it toward the NE yard. Heavy is 5.8 m: streets and slots
// 10 m+, 6.5 m+ under the arms.
import { bases, box, convoy, cylinder, ground, heightAt, lamp, once, point, r3, sentries, siege, sign, silos, slope, solids, turned, write } from './kit.mjs';

const SIZE = [300, 300], CELL = 4;
const RISE = 36, REACH = 112, GAP = 12; // the arch's crest, its feet's distance out, its tips'
const R = (REACH ** 2 + RISE ** 2) / (2 * RISE); // the circle the arch's back follows
const MESA = { v: 82, half: [10, 17], top: 14 }; // across (v) and along (s) the arch
const TEAL = '#4fe0d0', AMBER = '#ffbf5a';
const S2 = Math.SQRT1_2;

/** World [x, z] at `s` along the arch toward the NW town and `v` across it toward the NE yard. */
const uv = (s, v) => [r3((v - s) * S2), r3((s + v) * S2)];
/** The arch's back `s` m out from the middle. */
const back = (s) => r3(Math.sqrt(R * R - s * s) - (R - RISE));
/** A box laid along the arch (`hs` half along it, `hv` across), standing on the ground at `y0`. */
const laid = (s, v, hs, hv, h, mat, y0 = 0) => {
  const [x, z] = uv(s, v);
  turned([x, r3(y0 + h / 2), z], [hv, r3(h / 2), hs], -45, mat);
};

// --- The arch --------------------------------------------------------------------------------------
// The NW arm in 13 pieces from its foot to its tip, 5 m thick; the lowest three (under 6.5 m clear)
// are solid to the ground. Each piece sits 2 cm under the one below it: a Heavy climbing over a
// joint that meets exactly snags on the upper piece's edge, but steps down 2 cm without noticing.
for (let i = 0, step = (REACH - GAP) / 13; i < 13; i++) {
  const s0 = REACH - i * step, s1 = s0 - step, [x0, z0] = uv(s0, 0), [x1, z1] = uv(s1, 0), drop = 0.02 * i;
  slope([x0, r3(back(s0) - drop), z0], [x1, r3(back(s1) - drop), z1], 12, i < 3 ? 6.5 : 2.5, 'concrete');
}
// The Keystone under the gap, and a ramp up its NE side (the twin's up its SW).
once(() => laid(0, 0, 10, 7, 6, 'sandstone'));
{
  const [lx, lz] = uv(0, 20.5), [hx, hz] = uv(0, 7);
  slope([lx, 0, lz], [hx, 6, hz], 8, 3.5, 'sandstone');
}
// A slab of the crest, fallen beside it.
{
  const [x, z] = uv(15, -17);
  turned([x, 1.8, z], [4, 2.2, 6], -20, 'concrete', 12);
}

// --- The NW town round the arm's foot --------------------------------------------------------------
// A street up the middle to the foot between pueblos, with towers among them and an outer row.
// [s, v, half along, half across, height]
for (const [s, v, hs, hv, h] of [
  [126, -18, 5, 5, 28], [128, 19, 6, 5, 32], [160, 0, 6, 10, 22],
  [116, -38, 5, 4, 8], [118, 38, 5, 4, 9], [136, -40, 6, 5, 11], [136, 40, 5, 6, 12],
]) laid(s, v, hs, hv, h, 'concrete');
const TERRACES = []; // on each pueblo, the middle of each roof a hover climbs to, and the street before it
/**
 * A pueblo at `s` along the street, its front on the street's edge at `front` (v) and the street
 * toward `side` (±1): three 2.8 m storeys, each stepping back 5 m from the one below, so each roof
 * is a terrace a hover climbs to from the one below (or from the street).
 */
function pueblo(s, front, side, hs) {
  const STOREY = 2.8, STEP = 5, back = front - side * 16;
  for (let k = 0; k < 3; k++) {
    const f = front - side * STEP * k;
    laid(s, (f + back) / 2, hs, Math.abs(f - back) / 2, STOREY * (k + 1), 'concrete');
    TERRACES.push([s, k < 2 ? f - side * STEP / 2 : (f + back) / 2, STOREY * (k + 1)]);
  }
  TERRACES.push([s, front + side * 5, null]);
}
pueblo(108, -12, 1, 6);
pueblo(108, 12, -1, 6);
pueblo(142, -12, 1, 7);
pueblo(144, 12, -1, 6);
for (const [s, v] of [[118, -13], [118, 13], [136, -13], [136, 13]]) {
  const [x, z] = uv(s, v);
  lamp([x, 0, z]);
}
{
  // Signs on the two towers' street faces.
  for (const [s, v, color] of [[126, -13, TEAL], [128, 14, AMBER]]) {
    const [x, z] = uv(s, v);
    sign([r3(x - 1.5), 9, r3(z - 1.5)], [r3(x + 1.5), 12, r3(z + 1.5)], [x, 10, z], color);
  }
}

// --- The NE yard ------------------------------------------------------------------------------------
// Sandstone walls with a gate west and south, a gate tower on the corner between them.
for (const [a, b] of [[[91, 92], [92.5, 112]], [[91, 126], [92.5, 150]], [[92, 91], [112, 92.5]], [[126, 91], [150, 92.5]]]) box([a[0], 0, a[1]], [b[0], 6, b[1]], 'sandstone');
box([86, 0, 86], [97, 18, 97], 'sandstone');
for (const at of [[89, 0, 110], [89, 0, 128], [110, 0, 89], [128, 0, 89]]) lamp(at);

// --- Rock: the mesa, its outcrops, hoodoos ------------------------------------------------------------
{
  const [x, z] = uv(0, MESA.v);
  turned([x, MESA.top / 2, z], [MESA.half[0], MESA.top / 2, MESA.half[1]], -45, 'sandstone');
  // Lower blocks at its ends, for a craggy skyline.
  for (const [s, v, hs, hv, h] of [[-18, 78, 3, 6, 9], [18, 86, 3, 6, 8], [-14, 90, 3, 4, 11], [14, 74, 3, 4, 10]]) laid(s, v, hs, hv, h, 'sandstone');
}
// Outcrops off the mesa's ends: the slot canyons between them and its end blocks are 10 m.
for (const [s, v, hs, hv, h, yaw] of [[-37, 86, 6, 5, 9, 8], [-40, 98, 4, 4, 13, -10], [37, 80, 6, 5, 9, -6], [40, 68, 4, 4, 12, 12]]) {
  const [x, z] = uv(s, v);
  turned([x, h / 2, z], [hv, h / 2, hs], -45 + yaw, 'sandstone');
}
for (const [s, v, hs, hv, h, yaw] of [[64, -42, 6, 5, 8, 20], [70, -50, 4, 3, 12, -15], [-78, 30, 6, 4, 7, 30]]) {
  const [x, z] = uv(s, v);
  turned([x, h / 2, z], [hv, h / 2, hs], -45 + yaw, 'sandstone');
}
/**
 * A hoodoo: a column of sandstone blocks, each turned its own way and swelling or pinching, in
 * bands of harder and softer rock, on a skirt of fallen blocks and under a wider cap of harder
 * rock. Seeded by where it stands, so a rerun writes the same map.
 */
function hoodoo(x, z, r, h) {
  let seed = (Math.abs(Math.round(x * 73 + z * 283)) % 2147483646) + 1;
  const rand = (lo, hi) => lo + (hi - lo) * (((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + rand(0, 1), d = r * rand(0.9, 1.3), t = rand(2.5, 4.5);
    turned([r3(x + d * Math.cos(a)), r3(t / 2 - 0.5), r3(z + d * Math.sin(a))], [r3(r * rand(0.5, 0.8)), r3(t / 2), r3(r * rand(0.5, 0.8))], r3(rand(0, 90)), 'sandstone', r3(rand(-8, 8)));
  }
  let y = 0, [cx, cz] = [x, z];
  for (let k = 0; y < h - 1; k++) {
    const t = Math.min(rand(5, 9), h - y), w = r * rand(0.75, 1.1);
    turned([r3(cx), r3(y + t / 2), r3(cz)], [r3(w), r3(t / 2), r3(w * rand(0.8, 1.1))], r3(rand(0, 90)), k % 2 ? 'sand' : 'sandstone');
    y += t;
    [cx, cz] = [cx + rand(-0.6, 0.6), cz + rand(-0.6, 0.6)];
  }
  turned([r3(cx), r3(y + 1.5), r3(cz)], [r3(r + 2.5), 1.5, r3(r + 1.5)], r3(rand(0, 90)), 'stone');
}
const HOODOOS = [[30, 112, 6, 46], [112, 30, 6, 42], [-20, 52, 5, 40], [-52, 20, 5, 36], [-40, 125, 5, 34]];
for (const [x, z, r, h] of HOODOOS) hoodoo(x, z, r, h);

// --- Terrain ---------------------------------------------------------------------------------------
const smooth = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
const toUV = (x, z) => [(z - x) * S2, (x + z) * S2];
/** 1 where dunes may roll, 0 on and around what's built (each test its own 180-degree twin). */
function open(x, z) {
  const [s, v] = toUV(x, z), [as, av] = [Math.abs(s), Math.abs(v)];
  let m = smooth(24, 34, Math.hypot(x, z)); // the Keystone
  m *= 1 - (1 - smooth(14, 20, av)) * smooth(76, 84, as); // the arms' feet and the towns' street
  m *= 1 - smooth(92, 100, as) * (1 - smooth(46, 54, av)); // the towns
  m *= 1 - (1 - smooth(48, 56, as)) * smooth(118, 126, av); // the yards
  m *= 1 - (1 - smooth(26, 34, as)) * smooth(58, 64, av) * (1 - smooth(122, 128, av)); // the mesas
  for (const [hx, hz, r] of HOODOOS) for (const k of [1, -1]) m *= smooth(r + 3, r + 9, Math.hypot(x - k * hx, z - k * hz));
  return m;
}
/** NE's mesa's drift, rising 30 degrees from the NE to just under its top (the twin's is SW's). */
function drift(x, z) {
  const [s, v] = toUV(x, z), b = v - MESA.v;
  if (b < 2 || b > 40 || Math.abs(s) > 14) return 0;
  const rise = b <= 12 ? MESA.top - 0.25 : Math.max(0, MESA.top - 0.25 - (b - 12) * Math.tan(Math.PI / 6));
  return rise * smooth(2, 6, b) * (1 - smooth(9, 13, Math.abs(s)));
}
const dune = (x, z) => 2.6 * Math.max(0, Math.cos(0.06 * (0.8 * x + 0.6 * z))) ** 2 + 1.4 * Math.max(0, Math.cos(0.095 * (-0.5 * x + 0.87 * z))) ** 2;
ground(SIZE, CELL, (x, z) => {
  const edge = 150 - Math.max(Math.abs(x), Math.abs(z));
  return dune(x, z) * open(x, z) + drift(x, z) + drift(-x, -z) + 16 * smooth(14, 0, edge); // rimrock walls
});
const at = (x, z) => [r3(x), r3(heightAt(x, z)), r3(z)];
const atUV = (s, v) => at(...uv(s, v));
/** On top of NE's mesa, `s` along it. */
const onMesa = (s) => {
  const [x, z] = uv(s, MESA.v);
  return [x, MESA.top, z];
};

// --- Waypoints -------------------------------------------------------------------------------------
// Along the NW arm to its tip, and its foot.
for (const s of [16, 30, 45, 60, 75, 90, 102]) {
  const [x, z] = uv(s, 0);
  point([x, back(s), z]);
}
point(atUV(REACH + 6, 0));
// The Keystone's top, and up its NE ramp.
once(() => point([0, 6, 0]));
{
  const [x, z] = uv(0, 13);
  point([x, r3(6 - 6 * Math.tan((24 * Math.PI) / 180)), z], atUV(0, 25));
}
// NE's mesa: its top, and up its drift.
point(onMesa(0), onMesa(-10), onMesa(10));
for (const v of [98, 108, 120]) point(atUV(0, v));
// The slot canyons at the mesa's ends.
point(atUV(-26, 82), atUV(26, 78));
// The pueblos' terraces, and the street before each.
for (const [s, v, y] of TERRACES) {
  const [x, z] = uv(s, v);
  point(y === null ? at(x, z) : [x, y, z]);
}
// The town's street, and the NE yard.
point(atUV(134, 0), atUV(150, 0), atUV(122, -28), atUV(122, 28), atUV(150, -30), atUV(150, 30));
point(at(112, 120), at(120, 112), at(128, 128), at(104, 136), at(136, 104), at(84, 119), at(119, 84));
// The rest: a grid of open, gentle spots off everything built.
{
  // A spot is blocked if a solid or its twin (which `write` adds later) stands over it.
  const blocked = (p, margin = 2.5) => [p, [-p[0], p[1], -p[2]]].some((p) => solids.some((s) => {
      const [yaw, tilt] = [((s.yaw ?? 0) * Math.PI) / 180, ((s.tilt ?? 0) * Math.PI) / 180];
      return [1, 3, 5, 7].some((up) => {
        const d = [p[0] - s.box[0], p[1] + up - s.box[1], p[2] - s.box[2]];
        const x1 = d[0] * Math.cos(yaw) - d[2] * Math.sin(yaw), z1 = d[0] * Math.sin(yaw) + d[2] * Math.cos(yaw);
        const y2 = d[1] * Math.cos(tilt) + z1 * Math.sin(tilt), z2 = -d[1] * Math.sin(tilt) + z1 * Math.cos(tilt);
        if (s.shape === 'cylinder') return Math.hypot(x1, z2) < s.half[0] + margin && Math.abs(y2) < s.half[1] + margin;
        return Math.abs(x1) < s.half[0] + margin && Math.abs(y2) < s.half[1] + 0.5 && Math.abs(z2) < s.half[2] + margin;
      });
    }));
  const gentle = (x, z) => Math.max(Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)), Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2))) / 4 < Math.tan(0.45);
  for (let z = 0; z <= 140; z += 18) {
    for (let x = -140; x <= 140; x += 18) {
      if (z === 0 && x <= 0) continue; // the twin covers those
      if (Math.hypot(x, z) < 22) continue; // the Keystone's
      if (gentle(x, z) && !blocked(at(x, z))) point(at(x, z));
    }
  }
}

// --- Objectives ------------------------------------------------------------------------------------
bases([125, 0, 125]);
// Base guns inside the yard's two gates.
sentries([[100, 0, 119], [119, 0, 100]]);
// Siege: the station round the Keystone's foot, the AA gun on its top, the ships over the arch.
siege({ at: [0, 0, 0], radius: 18, band: 4 }, { at: [0, 6, 0], radius: 8, band: 2.5, pad: [0, 6, 0] }, 75);
// Missile Assault: A on NE's mesa, B round the Keystone (its pad in the open beside it), C on SW's
// mesa.
const [px, pz] = uv(10, 13);
silos({ at: onMesa(0), radius: 10, band: 3 }, { at: [0, 0, 0], radius: 18, band: 4, pad: [px, 0, pz] });
// Convoy: the hauler starts in the shade under the NW arm, on the arch's line, so as far from either
// yard. North: out from under the arm across the dunes toward the NW town, back east along its edge
// and down through the slot canyon off the NE mesa's north-west end, round the hoodoo behind it and in
// by the NE yard's west gate. South: down the arm's length under it to its tip, round the fallen slab
// and the Keystone's west end (clear of B's pad and the AA gun's), through the slot canyon off the SW
// mesa's south-east end, round the hoodoo behind that and in by the SW yard's east gate. Points are
// world (x, z) on the sand, kept off the terrain cells' edges where a ray down can miss.
{
  const on = (pts) => pts.map((p) => (p.length === 2 ? at(...p) : p));
  convoy(
    on([[-52.4, 2.6, 52.4], [-53, 53], [-47.5, 58], [-43.5, 83.5], [-23.5, 111], [-1, 82], [9, 72.5], [22.5, 59.5], [34.5, 71.5], [48.5, 85.5], [48.5, 98], [47.5, 111], [51.5, 111], [72.5, 114.5], [82.5, 118.5], [93, 121.5], [93.5, 122], [94.5, 123.5], [97.5, 125], [125, 125]]),
    on([[-52.4, 2.6, 52.4], [-43, 43], [-21.5, 22], [-21.5, 21], [-34, 2], [-34, -3.5], [-22.5, -17.5], [-19, -19], [-17, -53.5], [-25.5, -62.5], [-35.5, -71.5], [-49, -85.5], [-47.5, -102.5], [-47.5, -111], [-58.5, -111], [-71.5, -114.5], [-82.5, -118.5], [-92.88, -121.88], [-99.5, -125.5], [-125, -125]]),
  );
}

// --- Spawns, write ---------------------------------------------------------------------------------
const north = [[112, 0.1, 120], [120, 0.1, 112], [128, 0.1, 128], [108, 0.1, 132]];
// A white-hot noon on another world: the sun high in the south-west (the arch throws its shadow
// north-east across the middle) in a sky gone gold to burnt orange overhead, with no blue left in
// it; the air thick and warm low down, dust blowing, mirages on the far sand and the horizon
// shimmering. Overexposed a touch, as the eye is in a glare.
const palette = {
  sunDir: [-0.5, 0.68, -0.53],
  sky: { horizon: '#f6cf86', zenith: '#c9732e', sun: '#fff3c8', stars: 0 },
  fog: [120, 380],
  haze: ['#f0b862', 0.016, 7],
  light: { sky: '#ffd49a', ground: '#8a5428', ambient: 1.5, sun: '#ffe4a8', direct: 2.7 },
  lamp: '#ffc070',
  tint: '#ffe6bc',
  terrain: ['#eab65c', '#c2763c', '#dfaa5e'],
  skyline: 'desert',
  motes: { color: [[1, 0.84, 0.52], [0.86, 0.6, 0.32]], rate: 45, size: 0.14, drift: 3, rise: 0.05, life: 5 },
  mirage: 0.85,
  heat: 1,
  exposure: 1.12,
  ambience: 'desert', // its sound bed and accents (web/audio.js)
};
write(new URL('./span.json', import.meta.url), { name: 'Span', size: SIZE, night: false, palette }, north);
