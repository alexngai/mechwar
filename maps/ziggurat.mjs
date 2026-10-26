// Ziggurat: a 200 m snowfield round a squat stepped pyramid. Two tiers, the
// ledge at 15 m and the top at 30, faced in 60-degree ice nobody can climb. A + of 10 m trenches
// cuts it into four lobes and meets under the top in the Vault, a 28 m hall round a core column.
// Each lobe has one way up from outside, pinwheeling round: a grand stair from the ring to the top
// on one face, and on the other a snow drift (NE, SW) or a toppled radar dish (NW, SE) up onto
// its ledge. Off the faces everything is a drop. Spawns hold the NE and SW corners, each a walled
// yard under a Quonset hangar; silos stand in the other two, a pillbox out from each trench mouth.
// Writes ziggurat.json next to this file; rerun `node maps/ziggurat.mjs` after editing.
//
// The north half (z > 0: the NE and NW lobes) and the east trench are authored here; `write`
// (maps/kit.mjs) adds the 180-degree twin. Heavy is 5.8 m: trenches 10 m wide, 6.5 m+ under roofs.
import { bases, box, cylinder, deathmatch, ground, heightAt, lamp, once, pipe, point, r3, sentries, sign, silos, slope, solids, turned, write } from './kit.mjs';

const SIZE = [200, 200], CELL = 4;
const B = 46, TW = 5, VAULT = 14; // the pyramid's half-width at its foot, a trench's, the Vault's
const H1 = 15, H2 = 30; // ledge, top
const RUN = H1 / Math.tan(Math.PI / 3); // a 60-degree face steps in this far per tier
const L1 = r3(B - RUN), B2 = 29, L2 = r3(B2 - RUN); // the ledge's edge, tier 2's foot, the top's edge
const SNOW = 0.5; // snow on every walkable top
const STAIR = Math.tan((29 * Math.PI) / 180); // grand stairs climb 29 degrees
const DISH = { r: 15.8, tilt: 28 }; // a dish's top rim on the ledge's edge, its bottom rim on the snow
const AMBER = '#ffb347', RED = '#ff2a1a';
/** A red warning light: a small glowing block centered on `at`. */
const beacon = ([x, y, z], r = 0.6) => sign([r3(x - r), r3(y - r), r3(z - r)], [r3(x + r), r3(y + r), r3(z + r)], [x, y, z], RED);

/** A box between any two opposite corners. */
const span = (a, b, mat) => box([0, 1, 2].map((i) => Math.min(a[i], b[i])), [0, 1, 2].map((i) => Math.max(a[i], b[i])), mat);
/** A mass over [x0, z0]-[x1, z1] from y0 to y1, `mat` under SNOW of snow. */
function capped([x0, z0], [x1, z1], y0, y1, mat = 'concrete') {
  span([x0, y0, z0], [x1, y1 - SNOW, z1], mat);
  span([x0, y1 - SNOW, z0], [x1, y1, z1], 'snow');
}

// --- The pyramid -----------------------------------------------------------------------------------
/**
 * The lobe in quadrant (sx, sz): each tier a core L-shaped round the Vault's corner, ice faces down
 * its two outer sides, and a pier where they'd meet. In lobe space x and z grow outward.
 */
function lobe(sx, sz) {
  const q = ([x, z]) => [sx * x, sz * z];
  const p3 = (x, y, z) => [sx * x, y, sz * z];
  for (const [y0, y1, edge] of [[0, H1, L1], [H1, H2, L2]]) {
    const foot = r3(edge + RUN), mid = r3((TW + edge) / 2), w = r3(edge - TW);
    capped(q([TW, VAULT]), q([edge, edge]), y0, y1);
    capped(q([VAULT, TW]), q([edge, VAULT]), y0, y1);
    slope(p3(mid, y0, foot), p3(mid, y1, edge), w, 3, 'ice');
    slope(p3(foot, y0, mid), p3(edge, y1, mid), w, 3, 'ice');
    capped(q([edge, edge]), q([foot, foot]), y0, y1);
    beacon([sx * (foot + 0.4), y1 - 1.4, sz * (foot + 0.4)]); // on the pier's outer corner
  }
  // Red strips up the trench walls at the mouths (each pair's other strip is on the next lobe).
  sign([sx * (TW - 0.15), 2, sz * (B - 3)], [sx * (TW - 0.05), 12, sz * (B - 2)], [sx * 2, 7, sz * (B - 2.5)], RED);
  sign([sx * (B - 3), 2, sz * (TW - 0.15)], [sx * (B - 2), 12, sz * (TW - 0.05)], [sx * (B - 2.5), 7, sz * 2], RED);
}
lobe(1, 1);
lobe(-1, 1);
once(() => {
  capped([-VAULT, -VAULT], [VAULT, VAULT], 27, H2); // the Vault's roof: the top's middle
  cylinder([0, 0, 0], [0, 27, 0], 4.5, 'concrete'); // its core column
});
// Amber panels on the column's four sides (props aren't `once`: the twin adds the other two).
for (const [x, z] of [[4.6, 0], [0, 4.6]]) {
  const [dx, dz] = [x ? 0 : 1.2, z ? 0 : 1.2];
  sign([x - dx, 8, z - dz], [x + dx, 11, z + dz], [x * 1.4, 9.5, z * 1.4], AMBER);
}

// Grand stairs: NE's up its north face, NW's up its west (the twin: SW's south, SE's east).
const STAIR_MID = r3((TW + L2) / 2), STAIR_FOOT = r3(L2 + H2 / STAIR);
slope([STAIR_MID, 0, STAIR_FOOT], [STAIR_MID, H2, L2], 8, 7.5, 'concrete');
slope([-STAIR_FOOT, 0, STAIR_MID], [-L2, H2, STAIR_MID], 8, 7.5, 'concrete');
for (const [x, z] of [[STAIR_MID - 4.5, STAIR_FOOT], [STAIR_MID + 4.5, STAIR_FOOT], [-STAIR_FOOT, STAIR_MID - 4.5], [-STAIR_FOOT, STAIR_MID + 4.5]]) lamp([x, 0, z]);
// Red lights either side of each stair's head.
for (const d of [-4.4, 4.4]) beacon([STAIR_MID + d, H2 + 0.35, L2 - 0.5]), beacon([-L2 + 0.5, H2 + 0.35, STAIR_MID + d]);

// NW's toppled radar dish, leaning on its north face's tier with its top rim on the ledge's edge: a
// round ramp onto the ledge. Its feed arm and struts are props, up out of reach.
const DISH_X = r3(-(TW + L1) / 2);
{
  const t = (DISH.tilt * Math.PI) / 180, n = [0, Math.cos(t), Math.sin(t)];
  const c = [DISH_X, H1 - DISH.r * Math.sin(t), L1 + DISH.r * Math.cos(t)];
  const along = (k) => c.map((v, i) => r3(v + n[i] * k));
  cylinder(along(-1.2), along(0), DISH.r, 'panel');
  // Half-buried in a drift at its own slope, side to side across the face: stepping off its rim
  // lands on snow, not in the V between the rim and the ice.
  const slip = Math.tan(t), foot = r3(L1 + (H1 - 0.05) / slip);
  slope([r3(-(TW + 0.5 + L1) / 2), 0, foot], [r3(-(TW + 0.5 + L1) / 2), r3(H1 - 0.05), L1], r3(L1 - TW - 0.5), 8, 'snow');
  const horn = along(11);
  pipe(along(0.1), horn, 0.35);
  for (const a of [0.5, 2.6, 4.7]) {
    const rim = [c[0] + DISH.r * 0.9 * Math.cos(a), c[1] + DISH.r * 0.9 * Math.sin(a) * Math.sin(t), c[2] - DISH.r * 0.9 * Math.sin(a) * Math.cos(t)];
    pipe(rim.map((v, i) => r3(v + n[i] * 0.3)), horn, 0.15);
  }
  turned(horn, [1.2, 1.2, 1.2], 0, 'metal');
  beacon(horn.map((v, i) => (i === 1 ? v + 1.6 : v)));
}

// --- The ring --------------------------------------------------------------------------------------
// The north pillbox, out from the north trench's mouth: a 3 m hover-up with a view down the trench.
capped([-5, 79], [5, 85], 0, 3);
// The east pillbox straddles z = 0; the twin gives the west's.
capped([79, -5], [85, 5], 0, 3);
// Bunkers out on the snow, roofs 3 m up (hover-ups, as the pillboxes'), each with a gun cabin at one
// end under a red light. `face` is the way its cabin's slit looks: [dx, dz], along x or z.
const BUNKERS = [[38, 74, [0, -1]], [-58, 32, [1, 0]], [66, 50, [-1, 0]], [-44, 78, [0, -1]]];
for (const [x, z, [fx, fz]] of BUNKERS) {
  const [hx, hz] = fx ? [3.5, 6] : [6, 3.5];
  capped([x - hx, z - hz], [x + hx, z + hz], 0, 3);
  const [cx, cz] = [x - fz * 3, z + fx * 3]; // the cabin, off-center along its length
  capped([cx - 2.2, cz - 2.2], [cx + 2.2, cz + 2.2], 3, 5.5);
  // The slit: a red strip just proud of the cabin's face.
  const [px, pz, ex, ez] = [cx + fx * 2.25, cz + fz * 2.25, fx ? 0.05 : 1.6, fz ? 0.05 : 1.6];
  sign([r3(px - ex), 4.2, r3(pz - ez)], [r3(px + ex), 4.6, r3(pz + ez)], [cx + fx * 3, 4.4, cz + fz * 3], RED);
}

// NW's silos, one fallen.
for (const [x, z, r, h] of [[-72, 72, 5.5, 20], [-85, 60, 4.5, 15], [-60, 86, 4.5, 24]]) {
  cylinder([x, 0, z], [x, h, z], r, 'tank');
  cylinder([x, h, z], [x, h + 0.4, z], r - 0.6, 'snow');
  beacon([x, h + 1, z], 0.7);
}
cylinder([-58, 3, 52], [-44, 3, 66], 3, 'tank');

// The NE yard: walls with a gate south and west, and a Quonset hangar along its back.
for (const [a, b] of [[[60, 60], [72, 61]], [[84, 60], [100, 61]], [[60, 61], [61, 72]], [[60, 84], [61, 100]]]) capped(a, b, 0, 3.5);
cylinder([65, 0, 92], [97, 0, 92], 9, 'panel');
sign([64.9, 3, 88], [64.95, 6, 96], [63, 4.5, 92], AMBER); // on the hangar's end, facing the gate
for (const at of [[72, 0, 58], [84, 0, 58], [58, 0, 72], [58, 0, 84]]) lamp(at);

// --- Terrain ---------------------------------------------------------------------------------------
const smooth = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
// Drifts for hull-down cover, out of the way of everything built (the twin's are added below).
const MOUNDS = [[-82, 28, 5, 2], [-24, 88, 6, 2.5], [44, 62, 5, 2], [84, 34, 6, 2.5], [-84, 44, 6, 3], [22, 90, 6, 2.5]];
const DRIFT_Z = r3((TW + L1) / 2); // NE's drift up its east face, onto the ledge
/** Half the terrain: the twin is the other half, so the whole is its own 180-degree twin. */
function half(x, z) {
  let h = 0;
  for (const [mx, mz, s, top] of MOUNDS) h += top * Math.exp(-((x - mx) ** 2 + (z - mz) ** 2) / (2 * s * s));
  if (x > 14 && Math.abs(z - DRIFT_Z) < 12) {
    // Flat a hair under the ledge out to x = 40 (where the ledge is, it's under it), then 30 degrees
    // down to the snow; under the lobe it tapers off before the Vault.
    const rise = x <= 40 ? 14.75 : Math.max(0, 14.75 - (x - 40) * Math.tan(Math.PI / 6));
    h = Math.max(h, rise * smooth(14, 18, x) * (1 - smooth(8, 12, Math.abs(z - DRIFT_Z))));
  }
  return h;
}
ground(SIZE, CELL, (x, z) => {
  const edge = 100 - Math.max(Math.abs(x), Math.abs(z));
  return half(x, z) + half(-x, -z) + 12 * smooth(10, 0, edge); // banks up to the walls
});
const at = (x, z) => [r3(x), r3(heightAt(x, z)), r3(z)];

// --- Waypoints -------------------------------------------------------------------------------------
const stairY = (d) => r3(H2 - (d - L2) * STAIR);
const dishY = (z) => r3(H1 - (z - L1) * Math.tan((DISH.tilt * Math.PI) / 180));
// The Vault and the trenches (the east's straddles z = 0; its twin is the west's).
point([8, 0, 8], [-8, 0, 8], [0, 0, 20], [0, 0, 34], [0, 0, 50], [20, 0, 0], [34, 0, 0], [50, 0, 0]);
// Ledges (NE's north side is cut by its stair, NW's west side too) and the pier tops.
point([33, H1, 9], [33, H1, DRIFT_Z], [33, H1, 33], [21, H1, 33], [41.5, H1, 41.5]);
point([-33, H1, 33], [-9, H1, 33], [DISH_X, H1, 33], [-33, H1, 21], [-33, H1, 29], [-41.5, H1, 41.5]);
// The top: each lobe's corner and the roof over the Vault.
point([17, H2, 17], [8, H2, 17], [17, H2, 8], [-17, H2, 17], [-8, H2, 17], [-17, H2, 8], [0, H2, 8], [8, H2, 0]);
// Up the stairs, the drift and the dish.
for (const d of [30, 45, 60]) point([STAIR_MID, stairY(d), d], [-d, stairY(d), STAIR_MID]);
point(at(STAIR_MID, STAIR_FOOT + 4), at(-STAIR_FOOT - 4, STAIR_MID));
for (const x of [46, 56]) point(at(x, DRIFT_Z));
point(at(70, DRIFT_Z));
for (const z of [44, 54]) point([DISH_X, dishY(z), z]);
point(at(DISH_X, 68));
// The pillbox and bunker roofs (up by hovering).
point([0, 3, 82], [82, 3, 0], ...BUNKERS.map(([x, z, [fx, fz]]) => [x + fz * 3, 3, z - fx * 3]));
// The NE yard.
point(at(70, 70), at(80, 70), at(70, 78), at(88, 72), at(78, 56), at(56, 78));
// The ring: a grid of open, gentle spots off everything built.
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
  for (let z = 0; z <= 90; z += 15) {
    for (let x = -90; x <= 90; x += 15) {
      if (z === 0 && x <= 0) continue; // the twin covers those
      if (Math.max(Math.abs(x), Math.abs(z)) < B + 4) continue; // the pyramid
      if (gentle(x, z) && !blocked(at(x, z))) point(at(x, z));
    }
  }
}

// --- Objectives ------------------------------------------------------------------------------------
bases([80, 0, 80]);
// Base guns in the open yard, either side of the spawns.
sentries([[66, 0, 66], [88, 0, 68]]);
// No Siege: its one station and AA gun would both have to stand in the middle (the Vault and the
// roof over it), and the whole match would be one brawl there.
// Missile Assault: A on NE's ledge at the drift's head, B in the Vault (its pad on the roof), C the
// twin of A on SW's ledge.
silos({ at: [33, H1, DRIFT_Z], radius: 7, band: 3 }, { at: [0, 0, 0], radius: 12, band: 4, pad: [0, H2, 0] });

// --- Spawns, write ---------------------------------------------------------------------------------
const north = [[70, 0.1, 72], [78, 0.1, 66], [86, 0.1, 74], [74, 0.1, 78]];
deathmatch([-90, 0.7, 90], [-78.461, 0.117, 12.67], [-15, 0.175, 75], [30, 1.75, 90]); // Deathmatch's own, round the ring
// A blizzard: an overcast white-out, the sun a pale smear, fog closing in past 25 m and gone by
// 170 (the pyramid a grey shape from the yards), blowing snow thick near the ground, and flakes
// driven hard from the west-north-west. The red beacons are what you steer by.
const palette = {
  sunDir: [0.4, 0.62, -0.68],
  sky: { horizon: '#d4dce3', zenith: '#a3b0bd', sun: '#eef2f5', stars: 0 },
  fog: [25, 170],
  haze: ['#e4eaef', 0.045, 9],
  light: { sky: '#d2dce6', ground: '#8c98a6', ambient: 1.7, sun: '#eef3f8', direct: 1.1 },
  lamp: '#ffb070',
  tint: '#eef3f9',
  terrain: ['#e8edf2', '#a7b6c4', '#dde4ea'],
  skyline: 'snow',
  // Flakes under the bloom threshold (0.7), so they read as snow, not sparks.
  motes: { color: [[0.86, 0.88, 0.9], [0.8, 0.83, 0.87]], rate: 900, size: 0.2, drift: 1.5, rise: -2.2, life: 2.5, wind: [9, -4], range: 20, solid: true },
  ambience: 'blizzard', // its sound bed and accents (web/audio.js)
};
write(new URL('./ziggurat.json', import.meta.url), { name: 'Ziggurat', size: SIZE, night: false, palette }, north);
