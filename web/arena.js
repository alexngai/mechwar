// The arena's look, built from map data (maps/*.json): solids with kitbashed trim, terrain, decor
// props, a generated ground texture and baked ambient occlusion (plus lamp, furnace and sign light on night
// maps), merged into three meshes. A map's `palette` tints it and colors its lamps. Only `solids`
// collide (the sim reads the same file); everything added here is visual.
import * as THREE from 'three';
import { halo, hot } from './fx.js';
import { heightAt } from '../maps/ground.js';

// Camera layers for quality-specific extras: halos stand in for bloom when it's off; High has light shafts.
export const LOW_ONLY = 1, HIGH_ONLY = 2;

const COLORS = {
  ground: 0x9a9384, concrete: 0xa8a08e, metal: 0x6f7880, panel: 0x8f969a, tank: 0xb9ac8e, hazard: 0xc9a032,
  trim: 0x55585b, rail: 0xd3a23a, pipe: 0x7d7262, pole: 0x3a3c3f, rust: 0x8a5634, soot: 0x4f4c49, stack: 0x6e5a4c,
  tower: 0x6c7470, rock: 0x7f7c8c, bark: 0x5b4a3a, moss: 0x6b7a4f, stone: 0x8f8b7b, hull: 0x7b7e74, deadwood: 0x6e675a,
  snow: 0xe8edf1, ice: 0xa9c6d8, sand: 0xdcbf86, sandstone: 0xc49a5c,
  // A mine's strata and the gravel on its benches.
  gravel: 0x8b8274, shale: 0x5e5955, ore: 0x9b5a37, clay: 0xb38a5b,
  pale: 0xd2cdc0, // bone-pale wood
  // A city's two sides: warm plaster, tiled floors and red lacquer; grimy tenement concrete.
  plaster: 0xb8a07c, terracotta: 0x94644a, lacquer: 0x7c3328, tenement: 0x6f736a, grime: 0x74766e,
};
// Ground, rock and wood: no trim, ribs or beams on these.
const NATURAL = new Set(['ground', 'rock', 'stone', 'moss', 'bark', 'deadwood', 'snow', 'ice', 'sand', 'sandstone', 'gravel', 'shale', 'ore', 'clay', 'pale']);
// Tree crowns and undergrowth, unless the palette's `leaf` names its own.
const LEAVES = ['#4d7834', '#5d8a3b', '#3e6a2f', '#6c9844'];
const REEDS = ['#7a7a48', '#6a6e40', '#8a7e50', '#5e6238'];
// Terrain: flat ground, the rock that shows where it steepens toward the 40-degree climb limit, and
// the drier ground of patches across the flat, unless the palette's `terrain` names its own.
const TERRAIN = [COLORS.ground, COLORS.rock, COLORS.ground];
// Lit windows on `tower` solids, unless the palette names its own; and how many slots are lit.
const WINDOWS = ['#ffd890', '#9dffc0', '#7fe8ff'];
const LIT = 0.3;
// Materials glazed like towers, with lit windows of their own colors, this share of them lit.
const GLAZED = {
  plaster: { colors: ['#ffcf8a', '#ffb466', '#ffe2ae'], lit: 0.3 },
  tenement: { colors: ['#d4ffec', '#a6ecff', '#eafff4', '#ffa2d4'], lit: 0.5 },
};
const TILE = 8; // ground texture repeat, meters
// Baked night lights: color, reach (m) and strength. Lamps light pools; furnaces glow orange.
const LAMP = { color: 0xffc98a, radius: 16, power: 1.4 };
const FURNACE = { color: 0xff8a3a, radius: 15, power: 4 };
const SIGN = { radius: 12, power: 2 };
const FUNGUS = { color: 0xff7a1a, radius: 9, power: 1.8 }; // glowing fungus: small orange pools
const FUNGUS_BLOBS = ['#ff7a1a', '#ffa040'];
// Crowns' veils: ribbons in this many segments, ending at least this far over the ground, all
// breathing once every BREATH s.
const VEIL_SEGMENTS = 4, VEIL_CLEAR = 7, BREATH = 6;
const PAD = '#a8ffc4'; // jump pads: a light green on every map
const PAD_RADIUS = 2.5; // the sim's
const AO_STEPS = [0.4, 0.9, 1.6, 2.5, 3.6]; // sample distances along the normal, meters
const UP = new THREE.Vector3(0, 1, 0), WHITE = new THREE.Color(1, 1, 1);
const tint = new THREE.Color(1, 1, 1); // the building map's palette tint, for `paint`
let leaves = LEAVES; // the building map's leaf colors
const color = new THREE.Color(), v = new THREE.Vector3(), n = new THREE.Vector3(), local = new THREE.Vector3(), sample = new THREE.Vector3(), to = new THREE.Vector3();
const off = new THREE.Vector3(), sky = new THREE.Vector3(); // a sky-cover ray's ends (`blocks` uses `local` and `sample`)
const COVER_REACH = 30; // meters: anything this close overhead counts as a roof

const solidMatrix = (s) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(...s.box),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(s.tilt ?? 0), THREE.MathUtils.degToRad(s.yaw ?? 0), 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );

/** A box geometry split into roughly `cell`-meter quads so per-vertex AO has room to vary. */
function boxGeometry([hx, hy, hz], cell = 2) {
  const seg = (h) => Math.min(96, Math.max(1, Math.round((2 * h) / cell)));
  return new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz, seg(hx), seg(hy), seg(hz));
}

/** A cylinder geometry (radius `hx`, axis Y, `hy` each way), faceted about every 1.5 m round. */
const cylinderGeometry = ([hx, hy]) =>
  new THREE.CylinderGeometry(hx, hx, 2 * hy, Math.min(24, Math.max(8, Math.round((2 * Math.PI * hx) / 1.5))), Math.min(48, Math.max(1, Math.round(hy))));

/**
 * The terrain as one mesh on the triangles the sim collides with (sim/src/map.rs `Terrain`),
 * colored from flat to steep, and darker down in hollows.
 */
function terrainGeometry({ cell, heights }, [w, d], [flat, steep, dry = flat]) {
  const rows = heights.length, cols = heights[0].length;
  const pos = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2), index = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c, x = c * cell - w / 2, z = r * cell - d / 2;
      pos.set([x, heights[r][c], z], 3 * k);
      uv.set([x / TILE, z / TILE], 2 * k);
      // Split along the (x0, z1)-(x1, z0) diagonal, both triangles facing up.
      if (r < rows - 1 && c < cols - 1) index.push(k, k + cols, k + 1, k + cols, k + cols + 1, k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  const nor = g.attributes.normal, colors = new Float32Array(rows * cols * 3), a = new THREE.Color(flat), b = new THREE.Color(steep), parched = new THREE.Color(dry);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      // Rock from about 25 degrees, all rock by 40; a hollow 4 m under the ground around it darkens.
      const rock = THREE.MathUtils.smoothstep(1 - nor.getY(k), 1 - Math.cos(0.44), 1 - Math.cos(0.7));
      let around = 0, n = 0;
      for (let i = Math.max(r - 2, 0); i <= Math.min(r + 2, rows - 1); i++) for (let j = Math.max(c - 2, 0); j <= Math.min(c + 2, cols - 1); j++, n++) around += heights[i][j];
      const shade = jitter(k) * (1 - THREE.MathUtils.clamp((around / n - heights[r][c]) / 4, 0, 1) * 0.35);
      const x = c * cell, z = r * cell, patch = Math.sin(x * 0.043 + Math.sin(z * 0.031) * 2) * Math.sin(z * 0.052 + Math.sin(x * 0.027) * 2);
      color.copy(a).lerp(parched, THREE.MathUtils.smoothstep(patch, 0.2, 0.7)).lerp(b, rock).multiply(tint).multiplyScalar(shade).toArray(colors, 3 * k);
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * Bushes over the terrain where it's gentle, dry (over `wet`, the water's level) and nothing
 * stands, `density` times about one per eight 4 m cells: only for show, so mechs wade through them.
 */
function undergrowth(map, boxes, parts, density, wet = -Infinity) {
  const [w, d] = map.size, ground = (x, z) => heightAt(map.terrain, map.size, x, z);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let z = -d / 2; z < d / 2; z += 4) {
    for (let x = -w / 2; x < w / 2; x += 4) {
      if (rand() > 0.12 * density) continue;
      const px = x + rand() * 4, pz = z + rand() * 4, y = ground(px, pz), s = 0.8 + rand() * 1.2, hex = leaves[Math.floor(rand() * leaves.length)];
      if (y < wet + 0.2 || Math.hypot(ground(px + 1, pz) - y, ground(px, pz + 1) - y) > 0.45) continue;
      sample.set(px, y + s * 0.5, pz);
      if (boxes.some((b) => b.center.distanceTo(sample) < b.radius + s && boxDistance(sample, b.inv, b.half) < s)) continue;
      parts.push(paint(new THREE.SphereGeometry(1, 6, 4).scale(s, s * 0.7, s).translate(px, y + s * 0.3, pz), hex, 0.75 + rand() * 0.3));
    }
  }
}

/** Clumps of reeds in the shallows, from 1.2 m under the water's `level` to just over it, `density` times about one per four 4 m cells. */
function reeds(map, boxes, parts, density, level) {
  const [w, d] = map.size, ground = (x, z) => heightAt(map.terrain, map.size, x, z);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let z = -d / 2; z < d / 2; z += 4) {
    for (let x = -w / 2; x < w / 2; x += 4) {
      if (rand() > 0.25 * density) continue;
      const px = x + rand() * 4, pz = z + rand() * 4, y = ground(px, pz);
      if (y < level - 1.2 || y > level + 0.4) continue;
      sample.set(px, level + 1, pz);
      if (boxes.some((b) => b.center.distanceTo(sample) < b.radius + 2 && boxDistance(sample, b.inv, b.half) < 1.5)) continue;
      for (let k = 0, n = 3 + Math.floor(rand() * 3); k < n; k++) {
        const h = level - y + 1.2 + rand() * 1.6, g = new THREE.BoxGeometry(0.14, h, 0.14).translate(0, h / 2, 0);
        g.rotateX((rand() - 0.5) * 0.4).rotateZ((rand() - 0.5) * 0.4).translate(px + (rand() - 0.5) * 1.6, y, pz + (rand() - 0.5) * 1.6);
        parts.push(paint(g, REEDS[Math.floor(rand() * REEDS.length)], 0.8 + rand() * 0.3));
      }
    }
  }
}

/** Small deterministic hash so each solid gets a stable color variation. */
const jitter = (i) => 1 + (((Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5) * 0.1;

/** Colors `geometry` `hex` times `shade`, tinted by the palette unless it's a light (`glows`). */
function paint(geometry, hex, shade = 1, glows = false) {
  color.set(hex).multiplyScalar(shade);
  if (!glows) color.multiply(tint);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Trim, ribs, beams and bands for one solid, in its local space. */
function kitbash(s, parts) {
  if (s.shape === 'cylinder' || NATURAL.has(s.mat)) return;
  const [hx, hy, hz] = s.half;
  const add = (w, h, d, x, y, z, hex = COLORS.trim) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(paint(g, hex));
  };
  const tall = hy > 1.2 && s.mat !== 'ground';
  if (tall) {
    // Cap trim along the top edges.
    add(2 * hx + 0.2, 0.25, 0.2, 0, hy - 0.12, hz);
    add(2 * hx + 0.2, 0.25, 0.2, 0, hy - 0.12, -hz);
    add(0.2, 0.25, 2 * hz + 0.2, hx, hy - 0.12, 0);
    add(0.2, 0.25, 2 * hz + 0.2, -hx, hy - 0.12, 0);
  }
  if (tall && Math.max(hx, hz) > 3 && s.mat !== 'tower' && !GLAZED[s.mat]) {
    // Vertical ribs every ~4 m on the long faces.
    const alongX = hx >= hz, long = alongX ? hx : hz, short = alongX ? hz : hx;
    for (let p = -long + 2; p <= long - 2 + 1e-3; p += 4) {
      for (const side of [-1, 1]) {
        if (alongX) add(0.3, 2 * hy - 0.4, 0.15, p, 0, side * (short + 0.07));
        else add(0.15, 2 * hy - 0.4, 0.3, side * (short + 0.07), 0, p);
      }
    }
  }
  if (s.mat === 'metal' && hy <= 0.3) {
    // Decks and ramps: cross beams underneath.
    for (let p = -hz + 1; p <= hz - 1 + 1e-3; p += 3) add(2 * hx, 0.35, 0.25, 0, -hy - 0.17, p, COLORS.pole);
  }
  if (s.mat === 'tank') {
    for (const f of [-0.35, 0.3]) add(2 * hx + 0.3, 0.35, 2 * hz + 0.3, 0, f * 2 * hy, 0, COLORS.pipe);
  }
  if (s.mat === 'stack') {
    // Steel bands up the shaft and a sooty lip, fluted like the stack's square and diamond halves.
    for (let y = -hy + 6; y < hy - 2; y += 7) add(2 * hx + 0.4, 0.6, 2 * hz + 0.4, 0, y, 0, COLORS.trim);
    add(2 * hx + 0.6, 1.2, 2 * hz + 0.6, 0, hy - 0.6, 0, COLORS.soot);
  }
}

/** A box from corner `d.from` to `d.to`, pitched `d.tilt` degrees (raising its -Z end) and turned `d.yaw` about its middle. */
function turnedBox(d, geometry = (size) => new THREE.BoxGeometry(...size)) {
  const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to);
  const g = geometry(new THREE.Vector3().subVectors(b, a).toArray().map(Math.abs));
  if (d.tilt) g.rotateX(THREE.MathUtils.degToRad(d.tilt));
  if (d.yaw) g.rotateY(THREE.MathUtils.degToRad(d.yaw));
  return g.translate(...a.add(b).multiplyScalar(0.5).toArray());
}

/** A corrugated sheet `w` x `d`, ribbed every 0.25 m across its width, 0.1 m thick (it fills `size`'s x and z). */
function corrugated([w, , d]) {
  const n = Math.max(2, Math.round(w / 0.25)), g = new THREE.BoxGeometry(w, 0.1, d, n, 1, 1), pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) if (Math.round((pos.getX(i) + w / 2) / (w / n)) % 2) pos.setY(i, pos.getY(i) + 0.12);
  g.computeVertexNormals();
  return g;
}

/** `lamp` is the lamps' { light, head } colors. */
function decorParts(d, parts, glow, lamp) {
  const segment = (from, to, thickness, hex) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    // Posts and poles stand straight up, where lookAt is undefined.
    const g = Math.abs(dir.y) > 0.99 * len ? new THREE.BoxGeometry(thickness, len, thickness) : new THREE.BoxGeometry(thickness, thickness, len);
    if (Math.abs(dir.y) <= 0.99 * len) g.lookAt(dir);
    g.translate(...a.clone().add(b).multiplyScalar(0.5).toArray());
    parts.push(paint(g, hex));
  };
  if (d.kind === 'railing') {
    const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to);
    const posts = Math.max(1, Math.round(a.distanceTo(b) / 1.6));
    for (let i = 0; i <= posts; i++) {
      const p = a.clone().lerp(b, i / posts);
      segment([p.x, p.y, p.z], [p.x, p.y + 1.1, p.z], 0.09, d.color ?? COLORS.rail);
    }
    for (const h of [0.55, 1.1]) segment([a.x, a.y + h, a.z], [b.x, b.y + h, b.z], 0.08, d.color ?? COLORS.rail);
  } else if (d.kind === 'pipe') {
    const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to);
    const len = a.distanceTo(b), dir = new THREE.Vector3().subVectors(b, a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const cyl = (r, l, at) => {
      const g = new THREE.CylinderGeometry(r, r, l, 10);
      g.applyQuaternion(q);
      g.translate(...at.toArray());
      parts.push(paint(g, d.color ?? COLORS.pipe));
    };
    cyl(d.r, len, a.clone().lerp(b, 0.5));
    for (let t = 0; t <= len; t += 6) cyl(d.r * 1.3, 0.25, a.clone().addScaledVector(dir, t));
  } else if (d.kind === 'lamp') {
    const [x, y, z] = d.at;
    segment([x, y, z], [x, y + 3.2, z], 0.16, COLORS.pole);
    const head = new THREE.BoxGeometry(0.7, 0.22, 0.7);
    head.translate(x, y + 3.25, z);
    glow.push(paint(head, lamp.head, 1, true));
    glow.lamps.push(new THREE.Vector3(x, y + 3.1, z));
    // Its light shaft, down to the deck it stands on.
    glow.shafts.push(paint(new THREE.CylinderGeometry(0.3, 2.6, 3.1, 16, 1, true).translate(x, y + 1.55, z), lamp.light, 0.25, true));
  } else if (d.kind === 'slab') {
    // A flat box of `mat` (or `color`) from corner `from` to `to`, turned `yaw` degrees about its
    // middle, that nothing collides with: paint on a floor (a pool's rim, the racks in it) that
    // mustn't trip anyone, or clutter on a wall.
    parts.push(paint(turnedBox(d), d.color ?? COLORS[d.mat] ?? COLORS.concrete));
  } else if (d.kind === 'roof') {
    // A corrugated sheet (a shack's or lean-to's roof) over `from`/`to`, pitched and turned as a
    // slab, of `color` (or `mat`): only for show.
    parts.push(paint(turnedBox(d, corrugated), d.color ?? COLORS[d.mat] ?? COLORS.rust));
  } else if (d.kind === 'sparks') {
    glow.sparkers.push(new THREE.Vector3(...d.at)); // a broken cable or fitting spitting sparks: only fx
  } else if (d.kind === 'steam') {
    glow.steam.push(new THREE.Vector3(...d.at)); // a cooling tower's lip, steaming: only fx
  } else if (d.kind === 'fringe') {
    // What hangs from under a table tree's crown `r` m round (its underside at `at`): moss dripping
    // off the rim, or with `long`, veils too, from the rim and further in (into `glow.veils`).
    const [x, y, z] = d.at, rnd = seeded(x, z), rings = d.long ? [[0.97, 1.3, 0.75], [0.6, 1.7, 0.45]] : [[0.98, 1.1, 2.6 / d.r]];
    glow.veils.push(veils(x, y, z, d.r, rnd, glow.floor, rings));
    // Mossy lumps round the rim, so it isn't a turned edge (props: nothing stands on them).
    for (let k = 0, n = Math.round((2 * Math.PI * d.r) / 2.2); k < n; k++) {
      const a = ((k + rnd(k + 400) * 0.5) / n) * 2 * Math.PI, s = 0.7 + 0.6 * rnd(k + 450), out = d.r - 0.2 + 0.3 * rnd(k + 500);
      const g = new THREE.SphereGeometry(1, 5, 2).scale(s, s * 0.6, s).translate(x + Math.cos(a) * out, y + 0.7, z + Math.sin(a) * out);
      parts.push(paint(g, leaves[k % leaves.length], 0.6 + 0.25 * rnd(k + 550)));
    }
  } else if (d.kind === 'pool') {
    // Water standing on a crown, about `r` m round at `at`: an uneven shore (`shore` runs 0 mid-pool
    // to 1 at it, for `poolMaterial`), mossy stones along it too low to trip on (props, as it is).
    const [x, y, z] = d.at, rnd = seeded(x, z), n = Math.max(16, Math.round(d.r * 2.6));
    const pos = [x, y, z], shore = [0], index = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI, rr = d.r * (1 + 0.035 * (rnd(k) * 2 - 1) + 0.02 * Math.sin(k * 0.9 + rnd(99) * 6)), c = Math.cos(a), s = Math.sin(a);
      pos.push(x + c * rr, y, z + s * rr);
      shore.push(1);
      index.push(0, 1 + ((k + 1) % n), 1 + k);
      for (let j = 0, m = rnd(k + 200) < 0.5 ? 1 : 2; j < m; j++) {
        const t = a + (j - 0.5) * 0.08, size = 0.25 + 0.3 * rnd(k * 2 + j + 250), o = rr + 0.05 + 0.2 * rnd(k * 2 + j + 300);
        const hex = rnd(k + 360) < 0.5 ? COLORS.stone : leaves[(k + j) % leaves.length];
        parts.push(paint(new THREE.SphereGeometry(1, 5, 2).scale(size, size * 0.45, size).translate(x + Math.cos(t) * o, y - 0.08, z + Math.sin(t) * o), hex, 0.8 + 0.3 * rnd(k + 350)));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('shore', new THREE.Float32BufferAttribute(shore, 1));
    g.setIndex(index);
    glow.pools.push(g);
  } else if (d.kind === 'falls') {
    // Water pouring off a crown's rim at `from` down to `to`, `w` m across, and mist where it lands.
    const [a, b] = [new THREE.Vector3(...d.from), new THREE.Vector3(...d.to)], h = a.y - b.y;
    const g = new THREE.CylinderGeometry(d.w / 2, d.w * 0.8, h, 7, Math.max(1, Math.round(h / 4)), true).translate(a.x, (a.y + b.y) / 2, a.z);
    const pos = g.attributes.position, fallen = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) fallen.set([a.y - pos.getY(i), Math.atan2(pos.getZ(i) - a.z, pos.getX(i) - a.x)], i * 2);
    g.setAttribute('fallen', new THREE.BufferAttribute(fallen, 2)); // meters fallen, and which way round
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    glow.falls.push(g);
    glow.steam.push(Object.assign(b.clone().setY(b.y + 1), { size: 0.22 }));
  } else if (d.kind === 'table') {
    // A table tree out past the map, for the skyline: a trunk up from `base` to its crown `r` m
    // round at `at`, drips under it. Nothing collides with it.
    const [x, y, z] = d.at, rnd = seeded(x, z), t = d.r * 0.16;
    parts.push(paint(new THREE.CylinderGeometry(t * 0.8, t, y - d.base, 7).translate(x, (y + d.base) / 2, z), COLORS.pale, 0.9));
    parts.push(paint(new THREE.CylinderGeometry(d.r, d.r * 0.96, 1.6, 16).translate(x, y + 0.8, z), leaves[Math.floor(rnd(1) * leaves.length)], 0.9 + 0.2 * rnd(2)));
    glow.veils.push(veils(x, y, z, d.r, rnd, glow.floor, [[0.98, 1.6, 2.6 / d.r]]));
  } else if (d.kind === 'fungus') {
    // A patch of glowing fungus `r` m round at `at`: blobs, the biggest mid-patch, on the level
    // ground round it (not up a steep bank), with a light of its own at night.
    const [x, y, z] = d.at, rnd = seeded(x, z);
    for (let k = 0, n = Math.round(5 + d.r * 3); k < n; k++) {
      const a = rnd(k) * 2 * Math.PI, out = d.r * Math.sqrt(rnd(k + 50)), px = x + Math.cos(a) * out, pz = z + Math.sin(a) * out;
      const under = glow.floor?.(px, pz) ?? y;
      if (Math.abs(under - y) > 1.2) continue;
      const s = (0.2 + 0.5 * rnd(k + 100)) * (1 - (0.5 * out) / d.r);
      glow.push(paint(new THREE.SphereGeometry(1, 6, 4).scale(s, s * 0.55, s).translate(px, under + s * 0.1, pz), FUNGUS_BLOBS[k % 2], 0.6 + 0.5 * rnd(k + 150), true));
    }
    glow.fungi.push(new THREE.Vector3(x, y + 1, z));
  } else if (d.kind === 'sign') {
    // A neon panel set on a wall (`from`/`to` corners, turned `yaw` degrees about its middle),
    // lighting the street from `at` (as far and as bright as `light`, [radius, power], says; 0 for
    // none at all).
    glow.push(paint(turnedBox(d), d.color, 1, true));
    if (d.light !== 0) glow.signs.push({ at: new THREE.Vector3(...d.at), color: d.color, ...(d.light && { radius: d.light[0], power: d.light[1] }) });
  } else if (d.kind === 'furnace') {
    // A furnace mouth: a glowing slab set into a wall (`from`/`to` corners), lit from `at`.
    const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to), at = new THREE.Vector3(...d.at);
    const size = new THREE.Vector3().subVectors(b, a).toArray().map(Math.abs);
    const g = new THREE.BoxGeometry(...size);
    const center = a.add(b).multiplyScalar(0.5);
    g.translate(...center.toArray());
    glow.push(paint(g, 0xffa050, 1, true));
    glow.furnaces.push(at);
    // Its glow: a square shaft flaring 5 m out of the mouth, off the wall toward `at`.
    const thin = size[0] < size[2] ? 0 : 2;
    const out = new THREE.Vector3().setComponent(thin, Math.sign(at.getComponent(thin) - center.getComponent(thin)));
    const across = new THREE.Vector3().crossVectors(UP, out).multiplyScalar(size[2 - thin] / 2);
    const shaft = new THREE.CylinderGeometry(Math.SQRT2, 1.6 * Math.SQRT2, 1, 4, 1, true, Math.PI / 4);
    shaft.applyMatrix4(new THREE.Matrix4().makeBasis(across, out.clone().multiplyScalar(-5), UP.clone().multiplyScalar(size[1] / 2)).setPosition(center.addScaledVector(out, 2.5)));
    glow.shafts.push(paint(shaft, FURNACE.color, 0.3, true));
  }
}

/** A stable random in [0, 1) for the `k`th thing about whatever stands at (x, z). */
const seeded = (x, z) => (k) => {
  const h = Math.sin((x * 7 + z * 13 + k) * 12.9898) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * Veils hanging from under a crown `r` m round, its underside at `y`: a ring of ribbons for each of
 * `rings` ([fraction of r out, spacing m, length as a fraction of r]), each half a meter wide
 * narrowing to a thread, ending VEIL_CLEAR m or more over the ground (`floor(x, z)`, if any).
 * `veil` (the crown's x and z, meters down from the top, a seed) and `tip` (0 at the top, 1 at the
 * end) drive their sway and breath (`veilMaterial`).
 */
function veils(x, y, z, r, rnd, floor, rings) {
  const pos = [], nor = [], col = [], veil = [], tip = [], index = [];
  let k = 0;
  for (const [ring, spacing, long] of rings) {
    const rho = r * ring, top = y, n = Math.round((2 * Math.PI * rho) / spacing);
    for (let i = 0; i < n; i++, k++) {
      const a = ((i + rnd(k + 10) * 0.6) / n) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a), px = x + c * rho, pz = z + s * rho;
      const len = Math.min(r * long * (0.7 + 0.6 * rnd(k + 100)), floor ? top - floor(px, pz) - VEIL_CLEAR : Infinity);
      if (len < 1.5) continue;
      color.set(leaves[k % leaves.length]).multiplyScalar(0.8 + 0.3 * rnd(k + 200)).multiply(tint);
      const base = pos.length / 3, seed = rnd(k + 300);
      for (let j = 0; j <= VEIL_SEGMENTS; j++) {
        const t = j / VEIL_SEGMENTS, w = 0.25 * (1 - t) + 0.03 * t;
        for (const side of [-w, w]) {
          pos.push(px - s * side, top - len * t, pz + c * side); // across the ring, facing out
          nor.push(c, 0, s);
          col.push(color.r, color.g, color.b);
          veil.push(x, z, len * t, seed);
          tip.push(t);
        }
        if (j) index.push(base + 2 * j - 2, base + 2 * j - 1, base + 2 * j, base + 2 * j - 1, base + 2 * j + 1, base + 2 * j);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  for (const [name, data, n] of [['position', pos, 3], ['normal', nor, 3], ['color', col, 3], ['veil', veil, 4], ['tip', tip, 1]]) {
    g.setAttribute(name, new THREE.Float32BufferAttribute(data, n));
  }
  g.setIndex(index);
  return g;
}

/**
 * Veils sway on a breeze, each its own way, and breathe all together: out and back in, their tips
 * brightening, once every BREATH s. The swing grows with the square of the drop. `uniforms` (time,
 * breath) are the caller's to advance.
 */
function veilMaterial(uniforms) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 veil;\nattribute float tip;\nuniform float veilTime, breath;\nvarying float vTip;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTip = tip;
        float swing = veil.z * veil.z * 0.01;
        vec2 out2 = normalize(transformed.xz - veil.xy + vec2(1e-3));
        float sway = sin(veilTime * 0.7 + veil.w * 6.28) + 0.4 * sin(veilTime * 1.9 + veil.w * 19.0);
        transformed.xz += (vec2(0.8, -0.35) * sway * 0.25 + out2 * breath * 0.35) * swing;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float breath;\nvarying float vTip;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(0.55, 0.75, 0.6) * smoothstep(0.6, 1.0, vTip) * (0.1 + 0.3 * (0.5 + 0.5 * breath));',
      );
  };
  return material;
}

/**
 * Falling water: pale, streaked, the streaks running down faster the further they've fallen, thin
 * at the lip and fading out into the mist at the foot. `uniforms.fallTime` is the caller's to advance.
 */
function fallsMaterial(uniforms) {
  const material = new THREE.MeshBasicMaterial({ color: 0xd8e2e0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 fallen;\nvarying vec2 vFallen;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFallen = fallen;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float fallTime;\nvarying vec2 vFallen;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float streak = fract(sin(floor(vFallen.y * 2.2) * 91.7) * 43758.5);
        float run = fract(vFallen.x * 0.08 - fallTime * (0.9 + 0.6 * streak));
        diffuseColor.a = (0.22 + 0.3 * smoothstep(0.6, 1.0, run)) * smoothstep(0.0, 1.5, vFallen.x) * (0.55 + 0.45 * streak);`,
      );
  };
  return material;
}

/**
 * Glowing pools (the palette's `pool` color): deeper toward the middle and bright in the shallows,
 * a web of caustic light swimming over them, the sky in them at a glance (the fog's color, nearer
 * the horizon) and the sun's glint off their ripples (`sun`, toward it). `uniforms.poolTime` is the
 * caller's to advance.
 */
function poolMaterial(color, sun, uniforms) {
  const material = hot(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.94, depthWrite: false, side: THREE.DoubleSide }));
  const glowing = material.onBeforeCompile;
  Object.assign(uniforms, { poolSun: { value: new THREE.Vector3(...sun).normalize() } });
  material.onBeforeCompile = (shader, renderer) => {
    glowing(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float shore;\nvarying float vShore;\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vShore = shore;\n  vWorld = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float poolTime;\nuniform vec3 poolSun;\nvarying float vShore;\nvarying vec3 vWorld;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= mix(0.6, 1.15, smoothstep(0.15, 1.0, vShore));
        // Two webs of light, one turned on the other, brightest where their threads cross.
        vec2 p = vWorld.xz * 1.1 + vec2(sin(vWorld.z * 0.5 + poolTime * 0.5), cos(vWorld.x * 0.45 - poolTime * 0.4)) * 0.7;
        vec2 p2 = mat2(0.8, -0.6, 0.6, 0.8) * p * 1.37 + 3.1;
        float web = min(abs(sin(p.x + poolTime * 0.9) + sin(p.y * 1.13 - poolTime * 0.7) + sin((p.x + p.y) * 0.77 + poolTime * 0.5)),
          abs(sin(p2.x - poolTime * 0.8) + sin(p2.y * 1.21 + poolTime * 0.6) + sin((p2.x - p2.y) * 0.83 - poolTime * 0.45)));
        diffuseColor.rgb += vec3(0.75, 1.0, 0.92) * pow(max(0.0, 1.0 - web * 0.55), 6.0) * 0.5;
        vec3 eye = normalize(cameraPosition - vWorld);
        vec3 ripple = normalize(vec3(sin(p.x * 2.0 + poolTime * 1.3) * 0.05, 1.0, cos(p.y * 2.2 - poolTime * 1.1) * 0.05));
        #ifdef USE_FOG
          diffuseColor.rgb = mix(diffuseColor.rgb, fogColor * 1.25, pow(1.0 - clamp(eye.y, 0.0, 1.0), 5.0) * 0.55);
        #endif
        diffuseColor.rgb += vec3(1.0, 0.94, 0.82) * pow(max(dot(reflect(-eye, ripple), poolSun), 0.0), 140.0) * 0.9;`,
      );
  };
  return material;
}

/** Concatenates indexed geometries that share the first one's attributes. */
function mergeGeometries(geometries) {
  const merged = new THREE.BufferGeometry();
  for (const name of Object.keys(geometries[0].attributes)) {
    const size = geometries[0].attributes[name].itemSize;
    const data = new Float32Array(geometries.reduce((sum, g) => sum + g.attributes[name].array.length, 0));
    let at = 0;
    for (const g of geometries) {
      data.set(g.attributes[name].array, at);
      at += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  const index = [];
  let base = 0;
  for (const g of geometries) {
    for (const i of g.index.array) index.push(i + base);
    base += g.attributes.position.count;
  }
  merged.setIndex(index);
  return merged;
}

/** Signed distance to an oriented box, given the inverse of its placement. */
function boxDistance(p, inv, [hx, hy, hz]) {
  local.copy(p).applyMatrix4(inv);
  const qx = Math.abs(local.x) - hx, qy = Math.abs(local.y) - hy, qz = Math.abs(local.z) - hz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}

/**
 * Darkens a solid's vertex colors where nearby solids crowd the space above each vertex, and by
 * `cover` (the palette's) where anything stands overhead, so a street under a deck lies in shade.
 */
function bakeAO(geometry, boxes, cover = 1) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal, col = geometry.attributes.color;
  geometry.computeBoundingSphere();
  const { center, radius } = geometry.boundingSphere;
  const near = new Set(boxes.filter((b) => b.center.distanceTo(center) < b.radius + radius + 4));
  const reach = AO_STEPS[AO_STEPS.length - 1];
  // Only boxes within twice the reach can shade a sample (one at most `reach` off the vertex).
  boxes.columns ??= columns(boxes, boxFootprint(2 * reach));
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    let light = 0.45; // undersides only ever face the ground: dark without sampling
    if (n.y > -0.9) {
      const column = boxes.columns(v);
      const close = column.filter((b) => near.has(b) && b.center.distanceTo(v) < b.radius + reach && boxDistance(v, b.inv, b.half) < 2 * reach);
      let occlusion = 0;
      for (const step of AO_STEPS) {
        sample.copy(v).addScaledVector(n, step);
        let d = step;
        for (const b of close) d = Math.min(d, boxDistance(sample, b.inv, b.half));
        occlusion += (step - Math.max(d, 0)) / step / AO_STEPS.length;
      }
      light = THREE.MathUtils.clamp(1 - 1.3 * occlusion, 0.35, 1);
      if (cover < 1) {
        off.copy(v).addScaledVector(n, 0.05);
        sky.copy(off).y += COVER_REACH;
        if (boxes.columns(off).some((b) => near.has(b) && blocks(off, sky, b.inv, b.half))) light *= cover;
      }
    }
    col.setXYZ(i, col.getX(i) * light, col.getY(i) * light, col.getZ(i) * light);
  }
}

/**
 * Finds the things (boxes, lights) whose footprint reaches a point's 8 m column of the map: each is
 * filed under every column its footprint covers, `footprint(thing)` giving its middle and half-size
 * across, [x, z, ex, ez].
 */
function columns(things, footprint) {
  const SIZE = 8, filed = new Map(), cell = (v) => Math.floor(v / SIZE);
  for (const t of things) {
    const [x0, z0, ex, ez] = footprint(t);
    for (let x = cell(x0 - ex); x <= cell(x0 + ex); x++) {
      for (let z = cell(z0 - ez); z <= cell(z0 + ez); z++) {
        const k = x * 65536 + z;
        if (!filed.has(k)) filed.set(k, []);
        filed.get(k).push(t);
      }
    }
  }
  const none = [];
  return (p) => filed.get(cell(p.x) * 65536 + cell(p.z)) ?? none;
}

/** A box's footprint for `columns`, grown `grow` m all round. */
const boxFootprint = (grow) => (b) => {
  const e = b.matrix.elements, [hx, hy, hz] = b.half;
  return [b.center.x, b.center.z, Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz + grow, Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz + grow];
};

/** True when the segment from `a` to `b` passes through the box placed by inverse matrix `inv`. */
function blocks(a, b, inv, [hx, hy, hz]) {
  const p = local.copy(a).applyMatrix4(inv), q = sample.copy(b).applyMatrix4(inv).sub(p);
  let t0 = 0, t1 = 1;
  for (const [o, d, h] of [[p.x, q.x, hx], [p.y, q.y, hy], [p.z, q.z, hz]]) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(o) > h) return false;
      continue;
    }
    const u = (-h - o) / d, w = (h - o) / d;
    t0 = Math.max(t0, Math.min(u, w));
    t1 = Math.min(t1, Math.max(u, w));
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Bakes `lights` into a `glow` attribute: per vertex, each light's color by its falloff and the
 * angle it strikes at, unless a solid stands between them (the lamps cast real shadows).
 */
function bakeLights(geometry, lights, boxes) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal;
  const glow = new Float32Array(pos.count * 3);
  // Each light is filed under every 8 m column of the map within its reach, and knows the boxes
  // within its reach, the only ones that can shade it.
  if (!lights.columns) {
    for (const l of lights) l.near = boxes.filter((b) => b.center.distanceTo(l.at) < b.radius + l.radius && boxDistance(l.at, b.inv, b.half) < l.radius);
    lights.columns = columns(lights, (l) => [l.at.x, l.at.z, l.radius, l.radius]);
  }
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nor, i);
    // From just off the surface, so the vertex's own solid doesn't shade it.
    v.fromBufferAttribute(pos, i).addScaledVector(n, 0.05);
    for (const l of lights.columns(v)) {
      to.subVectors(l.at, v);
      const d = to.length(), facing = n.dot(to) / d;
      if (d >= l.radius || facing <= 0) continue;
      if (l.near.some((b) => blocks(v, l.at, b.inv, b.half))) continue;
      const k = l.power * (1 - d / l.radius) ** 2 * facing;
      glow[i * 3] += l.rgb.r * k;
      glow[i * 3 + 1] += l.rgb.g * k;
      glow[i * 3 + 2] += l.rgb.b * k;
    }
  }
  geometry.setAttribute('glow', new THREE.BufferAttribute(glow, 3));
}

/**
 * A jump pad (`map.pads`): an octagonal plate whose face glows a soft green inside a bright rim
 * (into `lit`, which pulses), and a light of its own at night (into `signs`).
 */
function padParts(p, solid, lit, signs) {
  const [x, y, z] = p.at;
  const flat = (geometry, lift) => geometry.rotateX(-Math.PI / 2).translate(x, y + lift, z);
  solid.push(paint(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 0.2, 0.16, 8).translate(x, y + 0.08, z), COLORS.pole));
  lit.push(paint(flat(new THREE.CircleGeometry(PAD_RADIUS - 0.45, 8), 0.17), PAD, 0.35, true));
  lit.push(paint(flat(new THREE.RingGeometry(PAD_RADIUS - 0.45, PAD_RADIUS - 0.12, 8), 0.17), PAD, 1, true));
  signs.push({ at: new THREE.Vector3(x, y + 1.5, z), color: PAD });
}

/** Has a Lambert material add the baked `glow` attribute as light of its own. */
function glowing(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 glow;\nvarying vec3 vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vGlow * diffuseColor.rgb;');
  };
  return material;
}

/**
 * Additive light shafts that read as lit air: bright at the source (`uv.y` 1), fading along the
 * shaft and toward its edges, where the eye looks through the least of it, and into the fog.
 */
function shaftMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    vertexShader: /* glsl */ `
      uniform float fogNear, fogFar;
      varying vec3 vColor, vNormal, vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vColor = color * uv.y * uv.y * (1.0 - smoothstep(fogNear, fogFar, -mv.z));
        vNormal = normalMatrix * normal;
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor, vNormal, vView;
      void main() {
        gl_FragColor = vec4(vColor * abs(dot(normalize(vNormal), normalize(vView))), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    vertexColors: true,
    fog: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Lit window panes on the faces of a `tower` (or GLAZED) solid, in its local space: rows every 4 m
 * from 8 m up (street level stays dark, no glare at eye height), a slot every 3 m, `lit` of them lit
 * (seeded by `seed`, so a tower always looks the same).
 */
function towerWindows(s, seed, colors, out, lit = LIT) {
  const [hx, hy, hz] = s.half;
  let k = seed * 9301 + 49297;
  const rand = () => ((k = (k * 16807) % 2147483647) / 2147483647);
  for (const [w, d, face] of [[hx, hz, (a, y) => [a, y, hz + 0.05, 0]], [hx, hz, (a, y) => [a, y, -hz - 0.05, Math.PI]], [hz, hx, (a, y) => [hx + 0.05, y, -a, Math.PI / 2]], [hz, hx, (a, y) => [-hx - 0.05, y, a, -Math.PI / 2]]]) {
    for (let y = -hy + 8; y < hy - 2; y += 4) {
      for (let a = -w + 2; a < w - 1; a += 3) {
        if (rand() > lit) continue;
        const [x, wy, z, turn] = face(a, y);
        const pane = new THREE.PlaneGeometry(1.2, 1).rotateY(turn).translate(x, wy, z);
        out.push(paint(pane, colors[Math.floor(rand() * colors.length)], 0.2 + rand() * 0.25, true));
      }
    }
  }
}

/** Concrete slabs with seams, grit and salt stains; drawn once, no file download. */
function groundTexture() {
  const size = 256, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#c4bdae';
  g.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2400; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '70,64,56' : '235,230,220'},${0.04 + rand() * 0.08})`;
    g.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
  }
  for (let i = 0; i < 7; i++) {
    const x = rand() * size, y = rand() * size, r = 10 + rand() * 30;
    const stain = g.createRadialGradient(x, y, 0, x, y, r);
    stain.addColorStop(0, 'rgba(250,248,240,0.35)');
    stain.addColorStop(1, 'rgba(250,248,240,0)');
    g.fillStyle = stain;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  g.strokeStyle = 'rgba(60,55,48,0.45)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, size - 2, size - 2);
  g.beginPath();
  g.moveTo(size / 2, 0);
  g.lineTo(size / 2, size);
  g.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Adds the map's meshes to `scene`; returns them so a map change can remove them, with `vents`
 * (stack tops, which smoke) and `furnaces` (furnace mouths, which spark).
 */
export function buildArena(scene, map) {
  const started = performance.now();
  const palette = map.palette ?? {};
  tint.set(palette.tint ?? 0xffffff);
  leaves = palette.leaf ?? LEAVES;
  const lamp = palette.lamp ? { light: palette.lamp, head: new THREE.Color(palette.lamp).lerp(WHITE, 0.4).getHex() } : { light: LAMP.color, head: 0xffd9a0 };
  const boxes = map.solids.map((s) => {
    const matrix = solidMatrix(s);
    const [hx, hy, hz] = s.half;
    return { matrix, inv: matrix.clone().invert(), half: s.half, center: new THREE.Vector3(...s.box), radius: Math.hypot(hx, hy, hz) };
  });

  const ground = [], solid = [], glow = [];
  glow.lamps = [];
  glow.furnaces = [];
  glow.signs = [];
  glow.shafts = [];
  glow.sparkers = [];
  glow.steam = [];
  glow.veils = [];
  glow.pools = [];
  glow.falls = [];
  glow.fungi = [];
  glow.floor = map.terrain && ((x, z) => heightAt(map.terrain, map.size, x, z));
  map.solids.forEach((s, i) => {
    const g = paint((s.shape === 'cylinder' ? cylinderGeometry : boxGeometry)(s.half), s.color ?? COLORS[s.mat] ?? COLORS.concrete, jitter(i));
    g.applyMatrix4(boxes[i].matrix);
    bakeAO(g, boxes, palette.cover);
    if (s.mat === 'ground') {
      // World-space UVs so the slab texture tiles evenly across the whole floor.
      const pos = g.attributes.position, uv = g.attributes.uv;
      for (let k = 0; k < pos.count; k++) uv.setXY(k, pos.getX(k) / TILE, pos.getZ(k) / TILE);
      ground.push(g);
    } else {
      solid.push(g);
    }
    const parts = [];
    kitbash(s, parts);
    for (const p of parts) solid.push(p.applyMatrix4(boxes[i].matrix));
    if (s.mat === 'tower' || GLAZED[s.mat]) {
      const panes = [];
      towerWindows(s, i, GLAZED[s.mat]?.colors ?? palette.windows ?? WINDOWS, panes, GLAZED[s.mat]?.lit);
      for (const p of panes) glow.push(p.applyMatrix4(boxes[i].matrix));
    }
  });
  if (map.terrain) {
    const g = terrainGeometry(map.terrain, map.size, palette.terrain ?? TERRAIN);
    bakeAO(g, boxes, palette.cover);
    solid.push(g);
    if (palette.undergrowth) undergrowth(map, boxes, solid, palette.undergrowth, palette.water?.level);
    if (palette.reeds && palette.water) reeds(map, boxes, solid, palette.reeds, palette.water.level);
  }
  for (const d of map.decor ?? []) decorParts(d, solid, glow, lamp);
  const padGlow = [];
  for (const p of map.pads ?? []) padParts(p, solid, padGlow, glow.signs);
  const lit = (m) => (map.night ? glowing(m) : m);
  const light = (at, l) => ({ at, ...l, rgb: new THREE.Color(l.color) });
  const lights = map.night
    ? [
        ...glow.lamps.map((p) => light(p, { ...LAMP, color: lamp.light })),
        ...glow.furnaces.map((p) => light(p, FURNACE)),
        ...glow.signs.map(({ at, color, radius = SIGN.radius, power = SIGN.power }) => light(at, { radius, power, color })),
        ...glow.fungi.map((p) => light(p, FUNGUS)),
      ]
    : [];
  if (map.night) for (const g of [...ground, ...solid]) bakeLights(g, lights, boxes);

  const floor = ground.length && new THREE.Mesh(mergeGeometries(ground), lit(new THREE.MeshLambertMaterial({ map: groundTexture(), vertexColors: true })));
  const solids = new THREE.Mesh(mergeGeometries(solid), lit(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
  const meshes = [floor, solids, glow.length && new THREE.Mesh(mergeGeometries(glow), hot(new THREE.MeshBasicMaterial({ vertexColors: true })))].filter(Boolean);
  if (palette.water) {
    // Standing water: a sheet at its level out past the map's edge, only for show (mechs wade the terrain under it).
    // Glossy, so the sun glints off it and it reads as water, not more mud.
    const { level = 0, color: hex = '#3e4d44', opacity = 0.75 } = palette.water;
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(map.size[0] + 400, map.size[1] + 400).rotateX(-Math.PI / 2).translate(0, level, 0),
      new THREE.MeshPhongMaterial({ color: new THREE.Color(hex).multiply(tint), specular: 0x8a9a8c, shininess: 60, transparent: true, opacity, depthWrite: false }),
    );
    water.receiveShadow = true;
    meshes.push(water);
  }
  // Sun shadows: the floor only receives; solids, their trim and the terrain cast and receive.
  if (floor) floor.receiveShadow = true;
  solids.castShadow = solids.receiveShadow = true;
  if (padGlow.length) {
    // Jump pads breathe: their glow swells and fades on a sine, once every second and a half or so.
    const pads = new THREE.Mesh(mergeGeometries(padGlow), hot(new THREE.MeshBasicMaterial({ vertexColors: true })));
    pads.onBeforeRender = () => pads.material.color.setScalar(0.86 + 0.12 * Math.sin(performance.now() / 250));
    meshes.push(pads);
  }
  for (const p of glow.lamps) {
    const h = halo(palette.lamp ?? 0xffd29a, map.night ? 4 : 2.6);
    h.position.copy(p);
    h.layers.set(LOW_ONLY);
    meshes.push(h);
  }
  if (glow.veils.length) {
    const uniforms = { veilTime: { value: 0 }, breath: { value: 0 } };
    const veiled = new THREE.Mesh(mergeGeometries(glow.veils), veilMaterial(uniforms));
    veiled.receiveShadow = true; // they don't cast: a shadow that sways would need its own pass
    veiled.onBeforeRender = () => {
      const t = performance.now() / 1000;
      uniforms.veilTime.value = t % 1000;
      uniforms.breath.value = Math.sin((t * 2 * Math.PI) / BREATH);
    };
    meshes.push(veiled);
  }
  if (glow.pools.length) {
    // Water standing on the crowns, glowing from within.
    const uniforms = { poolTime: { value: 0 } };
    const pools = new THREE.Mesh(mergeGeometries(glow.pools), poolMaterial(palette.pool ?? '#58c4a8', palette.sunDir ?? [0.45, 0.8, 0.35], uniforms));
    pools.onBeforeRender = () => (uniforms.poolTime.value = (performance.now() / 1000) % 1000);
    meshes.push(pools);
  }
  if (glow.falls.length) {
    const uniforms = { fallTime: { value: 0 } };
    const falls = new THREE.Mesh(mergeGeometries(glow.falls), fallsMaterial(uniforms));
    falls.onBeforeRender = () => (uniforms.fallTime.value = (performance.now() / 1000) % 1000);
    meshes.push(falls);
  }
  for (const p of glow.fungi) {
    const h = halo(FUNGUS.color, 3);
    h.position.copy(p);
    h.layers.set(LOW_ONLY);
    meshes.push(h);
  }
  for (const p of glow.furnaces) {
    const h = halo(0xff8a3a, 7);
    h.position.copy(p);
    h.layers.set(LOW_ONLY);
    meshes.push(h);
  }
  for (const { at, color: c } of glow.signs) {
    const h = halo(c, 5);
    h.position.copy(at);
    h.layers.set(LOW_ONLY);
    meshes.push(h);
  }
  if (map.night && glow.shafts.length) {
    const shafts = new THREE.Mesh(mergeGeometries(glow.shafts), shaftMaterial());
    shafts.layers.set(HIGH_ONLY);
    meshes.push(shafts);
  }
  scene.add(...meshes);
  console.info(`arena ${map.name}: ${meshes.length} meshes, built in ${Math.round(performance.now() - started)} ms`);
  // Smoke rises from the top of each stack (its square half; the diamond is the same stack).
  meshes.vents = map.solids.filter((s) => s.mat === 'stack' && !s.yaw).map((s) => new THREE.Vector3(s.box[0], s.box[1] + s.half[1] + 0.5, s.box[2]));
  meshes.furnaces = glow.furnaces;
  meshes.sparkers = glow.sparkers;
  meshes.steam = glow.steam;
  meshes.motes = palette.motes;
  meshes.pads = map.pads ?? [];
  meshes.lights = lights; // night lights, for the cockpit
  return meshes;
}
