// Original procedural mechs: three walker classes built from boxes and posed every frame from
// sim state. They're rigid parts on joints, so there's no skinned mesh; legs use two-bone IK.
import * as THREE from 'three';
import { halo, hot } from './fx.js';
import classes from '../classes.json';
import weapons from '../weapons.json';

// Team color lives in the accents (visor, light strip) and the weapon pods; the hull carries a
// personal scheme picked from the player id. -1 is offline.
export const TEAMS = {
  '-1': { accent: 0x7fe0ff, paint: 0x6f7552 },
  0: { accent: 0x4fb4ff, paint: 0x3d6894 },
  1: { accent: 0xff5a36, paint: 0x9c4538 },
};
// Muted two-tone schemes with no blues or reds, so the accents carry the side.
const SCHEMES = [
  { base: 0x8f9468, second: 0x5c5f43, pattern: 'camo' }, // olive
  { base: 0xb0a07c, second: 0x786a50, pattern: 'splinter' }, // sand
  { base: 0x8f9396, second: 0x55595e, pattern: 'stripes' }, // ash
  { base: 0x8a6c55, second: 0x4f3d31, pattern: 'camo' }, // rust
  { base: 0xb9b3a2, second: 0x6e6a60, pattern: 'splinter' }, // bone
  { base: 0x646b70, second: 0x3c4146, pattern: 'stripes' }, // slate
];
const PATTERNS = { plain: 0, camo: 1, splinter: 2, stripes: 3, hazard: 4 };
const jointMat = new THREE.MeshPhongMaterial({ color: 0x1b1d20, specular: 0x5a5a5a, shininess: 50, flatShading: true });
// Live rounds showing in a secondary's mouth: warheads and shells, and the darts' brass tips.
const warheadMat = new THREE.MeshLambertMaterial({ color: 0xb8442c, flatShading: true });
const dartMat = new THREE.MeshLambertMaterial({ color: 0xd8a640, flatShading: true });
const mineLampMat = hot(new THREE.MeshBasicMaterial({ color: 0xff3020 }));
const mendLensMat = hot(new THREE.MeshBasicMaterial({ color: 0x60ffb0 }));
// Canopy glass: dark and smooth, with a sky-tinted shine. Both sides, so no edge shows a hole.
const glassMat = new THREE.MeshPhongMaterial({ color: 0x1e2e3a, specular: 0xa8c8dc, shininess: 80, side: THREE.DoubleSide });
const frameMat = new THREE.MeshPhongMaterial({ color: 0x74787a, specular: 0x8a8a8a, shininess: 40 }); // canopy braces

// Paint for box parts, patched into Lambert. Patterns live in each part's own space so they ride
// with it as legs re-pose. Every vertex of a one-segment box is a corner, so abs(position) is the
// box's half size, which gives the distance to the nearest edge for wear. Scorch spreads with
// uDamage, uWreck chars everything. All paint materials share this one program.
const PAINT_PARS = /* glsl */ `
uniform vec3 uSecond;
uniform int uPattern;
uniform float uSeed, uDamage, uWreck, uFlash;
varying vec3 vLocal, vHalf;
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(1.0, 0.0);
  return mix(
    mix(mix(hash3(i), hash3(i + o.xyy), f.x), mix(hash3(i + o.yxy), hash3(i + o.xxy), f.x), f.y),
    mix(mix(hash3(i + o.yyx), hash3(i + o.xyx), f.x), mix(hash3(i + o.yxx), hash3(i + o.xxx), f.x), f.y), f.z);
}
vec3 paint(vec3 base) {
  vec3 p = vLocal + uSeed;
  float second = 0.0;
  if (uPattern == 1) second = step(0.52, 0.7 * noise3(p * 1.4) + 0.3 * noise3(p * 4.0));
  else if (uPattern == 2) second = step(0.62, hash3(floor(vec3(p.x + 0.6 * p.y, p.y - 0.5 * p.z, p.z + 0.4 * p.x) * 1.3)));
  else if (uPattern == 3) second = step(0.62, fract((p.x + p.y * 0.4 + p.z) * 0.8));
  else if (uPattern == 4) second = step(0.5, fract((vLocal.x + vLocal.y + vLocal.z) * 3.0));
  vec3 color = mix(base, uSecond, second);
  // Bare metal shows along edges, more as damage grows.
  vec3 d = vHalf - abs(vLocal);
  float edge = min(min(max(d.x, d.y), max(d.y, d.z)), max(d.x, d.z));
  float wear = (1.0 - smoothstep(0.012, 0.04 + 0.05 * uDamage, edge)) * (0.4 + 0.6 * uDamage) * (0.5 + 0.5 * noise3(vLocal * 11.0));
  color = mix(color, vec3(0.32), wear);
  // Char where the burn field is under a threshold that rises with damage, soot around it.
  vec3 char = vec3(0.025, 0.022, 0.02);
  if (uDamage > 0.02) {
    float burn = 0.7 * noise3(p * 1.7 + 3.1) + 0.3 * noise3(p * 5.0), t = 0.08 + 0.4 * uDamage;
    color *= 0.6 + 0.4 * smoothstep(t, t + 0.25, burn);
    color = mix(color, char, 0.85 - 0.85 * smoothstep(t - 0.03, t + 0.03, burn));
  }
  return mix(color, char, uWreck * 0.9);
}`;
function patchPaint(shader) {
  Object.assign(shader.uniforms, this.userData.uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vLocal, vHalf;')
    // Curved parts have no box edges to wear: push their "edges" far off.
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLocal = position;\nvHalf = abs(position)${this.userData.curved ? ' + 10.0' : ''};`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${PAINT_PARS}`)
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = paint(diffuseColor.rgb);')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uFlash * 0.7;');
}
/** A paint material on `wear` (one mech's shared damage, wreck and flash uniforms). */
function paintMaterial(wear, color, second = color, pattern = 'plain') {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
  m.userData.uniforms = { ...wear, uSecond: { value: new THREE.Color(second) }, uPattern: { value: PATTERNS[pattern] }, uSeed: { value: 0 } };
  m.onBeforeCompile = patchPaint;
  return m;
}
/** `paint` (a box part's material) for curved parts: the same color, pattern and wear, no edges. */
function curvedPaint(paint) {
  const m = paintMaterial({}, 0);
  m.color = paint.color;
  m.userData = { uniforms: paint.userData.uniforms, curved: true };
  m.customProgramCacheKey = () => 'curved-paint';
  return m;
}

/** Stencils a two-digit unit number onto `canvas`, worn in spots; blank for ids below 0. */
function stencil(canvas, id) {
  const g = canvas.getContext('2d'), { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  if (id < 0) return;
  g.fillStyle = '#e8e4d6';
  g.font = `bold ${h * 0.8}px "Courier New", monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(id % 100).padStart(2, '0'), w / 2, h * 0.54);
  g.globalCompositeOperation = 'destination-out';
  let seed = id + 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 60; i++) g.fillRect(rand() * w, rand() * h, 1 + rand() * 3, 1 + rand() * 2);
  g.globalCompositeOperation = 'source-over';
}

const UP = new THREE.Vector3(0, 1, 0);
export const CROUCH = 0.8; // repairing mechs crouch to this much of their height; matches sim/src/lib.rs
const ALONG_Z = Math.PI / 2; // pitch that lays a cylinder along Z
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), local = new THREE.Vector3(), moveDir = new THREE.Vector3();
const pole = new THREE.Vector3(), world = new THREE.Vector3(), flame = new THREE.Vector3(), stretch = new THREE.Vector3();

const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
const cyl = (top, bottom, h, mat) => new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, h, 8), mat);
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
const clamp = THREE.MathUtils.clamp;
const DASH_TRAIL = 0.2; // s of smoke laid behind a dash
const DASH_SPOT = 22; // m/s sideways, and mostly sideways: only a dash does that (a diagonal boost doesn't)
const REPAIR_GLOW = 0x6dff9a;

/**
 * A cockpit pod: glass over the top half of an ellipsoid with radii (rx, ry, rz) at (x, y, z),
 * pitched by `tilt` (negative lowers the front, so it sweeps back like a fighter's), on a blocky
 * hull base `depth` deep: a tapered block of `sides` flat faces, a little wider than the glass so
 * its top makes a deck round it (six point a prow at the nose; five and four give a flat front), with a
 * team-lit seam where glass meets deck. Two roll bars brace the glass from outside, one over each
 * side, leaning in: straight pipe runs with bent corners, rising from the deck ahead of the glass,
 * across above it and down behind.
 */
function canopy(parent, m, rx, ry, rz, x, y, z, tilt, depth, sides) {
  const glass = put(parent, new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), glassMat), x, y, z, tilt);
  glass.scale.set(rx, ry, rz);
  // The polygon's flat faces sit at cos(PI / sides) of its corners: spread them just past the glass.
  const spread = 1.12 / Math.cos(Math.PI / sides);
  const turn = sides === 4 ? Math.PI / 4 : 0;
  const tub = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.6, 1, sides, 1, false, turn).translate(0, -0.5, 0), m.hullCurved);
  tub.scale.set(spread, depth / ry, spread);
  const seam = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 4, 48).rotateX(Math.PI / 2), m.accent);
  seam.scale.y = 0.6 / ry;
  glass.add(tub, seam);
  // Each bar leans in: its feet stand out near the deck's edge (x = ±0.84 rx), its top run sits
  // over the glass's shoulder (x = ±0.5 rx, where the glass is 0.87 ry tall at most), and the
  // corners are placed so the straight runs clear the glass. Built unscaled so the pipe stays round.
  const brace = put(parent, new THREE.Group(), x, y, z, tilt);
  const r = Math.max(0.05 * rx, 0.035), bend = 3 * r, top = 1.02 * ry + r;
  for (const side of [-1, 1]) {
    const corners = [[0.84, 0, -0.84], [0.5, top, -0.48], [0.5, top, 0.4], [0.84, 0, 0.95]].map(([bx, h, f]) => new THREE.Vector3(side * bx * rx, h, f * rz));
    const path = new THREE.CurvePath();
    let from = corners[0];
    for (let i = 1; i < corners.length - 1; i++) {
      const c = corners[i], before = c.clone().lerp(from, bend / c.distanceTo(from)), after = c.clone().lerp(corners[i + 1], bend / c.distanceTo(corners[i + 1]));
      path.add(new THREE.LineCurve3(from, before));
      path.add(new THREE.QuadraticBezierCurve3(before, c, after)); // the bend
      from = after;
    }
    path.add(new THREE.LineCurve3(from, corners.at(-1)));
    brace.add(new THREE.Mesh(new THREE.TubeGeometry(path, 64, r, 6), frameMat));
    put(brace, box(3 * r, 2 * r, 4 * r, jointMat), corners[0].x, r, corners[0].z); // mount on the deck
  }
  return glass;
}

/** Add `obj` to `parent` at (x, y, z) with pitch rx and roll rz. */
function put(parent, obj, x, y, z, rx = 0, rz = 0) {
  obj.position.set(x, y, z);
  obj.rotation.set(rx, 0, rz);
  parent.add(obj);
  return obj;
}

// Class specs. Model space is meters at the class's nominal `height`, feet at y = 0, facing -Z.
// Legs: hip height and spacing, bone lengths, ankle height, `knee` +1 bends back and -1 forward.
// Gait: foot `stance` x, stride = clamp(speed * k, min, max) (steps per second come to
// speed / (2 * stride), so longer strides lumber), bob and foot-lift amplitudes, wreck
// `sink`, dust puffs per footfall. `hull` builds the body, `leg` builds one leg's parts, `nozzles`
// are [x, y, z, size?] on the body, and `arm` [x, y, z] is the right arm's weapon mount (the left
// mirrors it): the primary goes on the left, the secondary on the right (see KITS).
// `strip` [width, y, z, length] is the accent light line and `plate` [width, height, y, z] the
// unit-number plate; each is a box just wider than the body there, so it shows on both flanks.
// Materials: `m.hull` personal paint, `m.pods` team paint, `m.trim` metal, `m.hazard` stripes,
// `m.accent` team-colored lights.

// B (Lancer), medium: the original reverse-joint walker with a gun pod and a rocket pod at its sides.
const LANCER = {
  height: 5, hipY: 2.9, hipX: 0.72, thigh: 1.75, shin: 1.7, ankleY: 0.3, knee: 1,
  stance: 0.85, stride: [0.2, 0.3, 2.4], bob: 0.12, lift: 0.6, sink: 1.5, dust: 1,
  nozzles: [[-0.4, 0.35, 1.55], [0.4, 0.35, 1.55]],
  strip: [2.24, 1.2, 0.35, 1.25], plate: [1.34, 0.3, 0.9, 1.3],
  arm: [1.45, 0.9, -0.1],
  hull(body, m) {
    put(body, box(1.5, 0.5, 1.2, m.hazard), 0, 0, 0.05); // hip block
    put(body, box(2.2, 1.1, 1.4, m.hull), 0, 0.8, 0.3); // main hull
    canopy(body, m, 0.92, 0.8, 1.12, 0, 0.82, -0.5, -0.08, 0.6, 5); // rounder canopy on a five-faced, flat-fronted base
    put(body, box(1.7, 0.3, 1.0, m.hull), 0, 1.45, 0.55, -0.06); // roof plate
    put(body, box(1.3, 1.0, 0.7, m.trim), 0, 0.85, 1.3); // backpack
    put(body, box(0.06, 0.9, 0.06, m.trim), -0.75, 1.95, 0.7); // antenna
  },
  leg(m) {
    const foot = new THREE.Group();
    put(foot, box(0.75, 0.24, 1.3, m.trim), 0, 0.12, -0.2); // sole
    put(foot, box(0.3, 0.2, 0.45, jointMat), 0, 0.1, 0.55); // heel
    return { thigh: box(0.42, this.thigh, 0.55, m.hull), shin: box(0.3, this.shin, 0.36, m.trim), knee: box(0.48, 0.48, 0.48, jointMat), foot };
  },
};

// A (Wisp), light: short legs under a narrow pod, swept tail fins and slim arms.
const WISP = {
  height: 3.5, hipY: 2.05, hipX: 0.5, thigh: 1.35, shin: 1.3, ankleY: 0.22, knee: 1,
  stance: 0.62, stride: [0.167, 0.3, 2.42], bob: 0.12, lift: 0.5, sink: 1.1, dust: 1,
  nozzles: [[-0.22, 0.3, 1.05, 0.7], [0.22, 0.3, 1.05, 0.7]],
  strip: [1.24, 0.9, 0.3, 1.0], plate: [1.24, 0.25, 0.5, 0.55],
  arm: [0.78, 0.6, -0.05],
  hull(body, m) {
    put(body, box(0.95, 0.4, 0.8, m.hazard), 0, 0, 0.05); // hip block
    put(body, box(1.2, 0.8, 1.1, m.hull), 0, 0.6, 0.3); // main hull
    canopy(body, m, 0.52, 0.52, 1.2, 0, 0.72, -0.5, -0.14, 0.45, 6); // long teardrop bubble on a six-faced prow
    put(body, box(0.25, 0.2, 1.1, m.trim), 0, 1.05, 0.45); // dorsal spine, behind the bubble
    put(body, box(0.75, 0.6, 0.5, m.trim), 0, 0.55, 0.95); // backpack
    put(body, box(0.2, 0.22, 0.5, m.trim), -0.66, 0.85, 0.05); // sensor pod on the flank
    put(body, box(0.1, 0.08, 0.04, m.accent), -0.66, 0.87, -0.22); // sensor lens
    for (const side of [-1, 1]) put(body, box(0.05, 0.9, 0.5, m.pods), side * 0.4, 1.3, 0.7, 0.7, -side * 0.4); // swept fin
  },
  leg(m) {
    const foot = new THREE.Group();
    for (const x of [-0.13, 0.13]) put(foot, box(0.14, 0.16, 0.95, m.trim), x, 0.08, -0.3); // split toes
    put(foot, box(0.16, 0.14, 0.45, jointMat), 0, 0.07, 0.4); // heel spur
    return { thigh: box(0.26, this.thigh, 0.36, m.hull), shin: box(0.18, this.shin, 0.22, m.trim), knee: box(0.32, 0.32, 0.32, jointMat), foot };
  },
};

// C (Bulwark), heavy: a wide armored box behind a front slab on thick forward-kneed legs, with its
// weapons on shoulder turrets.
const BULWARK = {
  height: 5.8, hipY: 2.7, hipX: 1.15, thigh: 1.75, shin: 1.65, ankleY: 0.35, knee: -1,
  stance: 1.35, stride: [0.24, 0.3, 2.2], bob: 0.2, lift: 0.5, sink: 1.3, dust: 2,
  nozzles: [[-0.65, 0.35, 2.1, 1.3], [0.65, 0.35, 2.1, 1.3]],
  strip: [3.58, 1.15, 0.1, 1.7], plate: [3.58, 0.45, 0.78, 0.2],
  arm: [1.15, 2.55, 0.2],
  hull(body, m) {
    put(body, box(2.0, 0.6, 1.4, jointMat), 0, 0, 0); // hip block
    put(body, box(3.0, 1.6, 2.4, m.hull), 0, 1.05, 0.15); // main hull
    put(body, box(3.3, 1.1, 0.4, m.hull), 0, 0.45, -1.3, 0.15); // front armor slab, the canopy's sill
    put(body, box(3.0, 0.25, 0.5, m.hazard), 0, -0.1, -1.25); // slab lip
    canopy(body, m, 1.25, 0.78, 1.05, 0, 1.02, -0.62, -0.06, 0.55, 4); // broad armored canopy on a flat-fronted block
    put(body, box(2.6, 0.35, 1.2, m.hull), 0, 2.0, 0.75, -0.04); // roof plate
    put(body, box(2.2, 1.4, 0.9, m.trim), 0, 0.9, 1.75); // reactor pack
    for (const side of [-1, 1]) {
      put(body, box(0.3, 0.9, 1.9, m.hull), side * 1.62, 0.8, 0.1); // side armor
      put(body, cyl(0.12, 0.14, 0.7, m.barrels), side * 0.6, 1.9, 1.9); // exhaust stack
    }
  },
  leg(m) {
    const foot = new THREE.Group();
    put(foot, box(1.2, 0.32, 1.6, m.trim), 0, 0.16, -0.15); // sole
    put(foot, box(0.7, 0.3, 0.5, jointMat), 0, 0.15, 0.75); // heel
    put(foot, box(0.65, 0.4, 0.65, jointMat), 0, 0.45, 0); // ankle block
    return { thigh: box(0.7, this.thigh, 0.8, m.hull), shin: box(0.55, this.shin, 0.6, m.trim), knee: box(0.75, 0.75, 0.75, jointMat), foot };
  },
};

export const CLASSES = { A: WISP, B: LANCER, C: BULWARK };

// Weapon models by weapons.json id, each built in a pod facing -Z and returning its muzzle. Each is
// sized for a `home` class and scaled to fit any other, and set so its bore (the barrel's line:
// its muzzle, or a raised tube's pivot, `bore`) runs through its class's arm mount, so every
// weapon on an arm sits at the same height.
const KITS = {
  // A long rifle on a slim forearm.
  stitcher: { home: 'A', build(pod, m) {
    pod.add(box(0.34, 0.34, 0.34, jointMat)); // shoulder
    put(pod, box(0.28, 0.36, 1.1, m.pods), 0.04, -0.12, -0.45); // forearm
    put(pod, box(0.08, 0.12, 0.55, m.trim), 0.04, 0.12, -0.7); // scope
    put(pod, cyl(0.055, 0.075, 1.0, m.barrels), 0.04, -0.12, -1.45, ALONG_Z); // barrel
    put(pod, box(0.15, 0.15, 0.25, m.trim), 0.04, -0.12, -2.0); // muzzle brake
    return put(pod, new THREE.Object3D(), 0.04, -0.12, -2.15);
  } },
  // Three short barrels stacked over a receiver on a slim forearm.
  triplet: { home: 'A', build(pod, m) {
    pod.add(box(0.34, 0.34, 0.34, jointMat)); // shoulder
    put(pod, box(0.28, 0.36, 0.8, m.pods), 0.04, -0.12, -0.35); // forearm
    put(pod, box(0.22, 0.34, 0.5, m.trim), 0.04, -0.06, -0.9); // receiver
    for (const y of [-0.16, -0.06, 0.04]) put(pod, cyl(0.035, 0.04, 0.75, m.barrels), 0.04, y, -1.45, ALONG_Z); // barrels
    put(pod, box(0.18, 0.34, 0.1, m.trim), 0.04, -0.06, -1.8); // muzzle shroud
    return put(pod, new THREE.Object3D(), 0.04, -0.06, -1.9);
  } },
  // A gun pod with one tapered barrel.
  pike: { home: 'B', build(pod, m) {
    pod.add(box(0.55, 0.6, 1.3, m.pods));
    put(pod, cyl(0.1, 0.13, 1.4, m.barrels), 0, -0.05, -1.3, ALONG_Z);
    return put(pod, new THREE.Object3D(), 0, -0.05, -2.0);
  } },
  // Six barrels round a spinner (`userData.spinner`, turned by `windUp`), out of a gun pod.
  gyre: { home: 'B', build(pod, m) {
    pod.add(box(0.55, 0.6, 1.0, m.pods));
    const spinner = put(pod, new THREE.Group(), 0, -0.05, -0.5);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      put(spinner, cyl(0.045, 0.045, 1.3, m.barrels), Math.cos(a) * 0.12, Math.sin(a) * 0.12, -0.65, ALONG_Z);
    }
    for (const z of [-0.1, -1.2]) put(spinner, cyl(0.19, 0.19, 0.08, m.trim), 0, 0, z, ALONG_Z); // collars
    pod.userData.spinner = spinner;
    return put(pod, new THREE.Object3D(), 0, -0.05, -1.85);
  } },
  // A cannon on a shoulder turret.
  squall: { home: 'C', build(pod, m) {
    put(pod, box(0.5, 0.4, 0.6, jointMat), 0, -0.3, 0.1); // turret ring
    put(pod, box(0.85, 0.7, 1.9, m.pods), 0, 0.1, -0.1); // housing
    put(pod, cyl(0.17, 0.21, 1.7, m.barrels), 0, 0.1, -1.85, ALONG_Z); // barrel
    put(pod, box(0.5, 0.5, 0.4, m.trim), 0, 0.1, -2.75); // muzzle block
    return put(pod, new THREE.Object3D(), 0, 0.1, -3.0);
  } },
  // A long barrel through coils that glow as it charges (`userData.charge`, lit by `windUp`), on a
  // shoulder turret.
  kiln: { home: 'C', build(pod, m) {
    put(pod, box(0.5, 0.4, 0.6, jointMat), 0, -0.3, 0.1); // turret ring
    put(pod, box(0.8, 0.65, 1.5, m.pods), 0, 0.1, 0); // housing
    put(pod, cyl(0.13, 0.15, 2.0, m.barrels), 0, 0.1, -1.7, ALONG_Z); // barrel
    const glow = hot(new THREE.MeshBasicMaterial({ color: COILS_COLD }));
    for (const z of [-1.0, -1.35, -1.7, -2.05]) {
      put(pod, cyl(0.26, 0.26, 0.09, m.trim), 0, 0.1, z, ALONG_Z); // coil
      put(pod, cyl(0.22, 0.22, 0.14, glow), 0, 0.1, z - 0.15, ALONG_Z); // its glow
    }
    put(pod, box(0.36, 0.36, 0.25, m.trim), 0, 0.1, -2.8); // muzzle
    pod.userData.charge = glow;
    return put(pod, new THREE.Object3D(), 0, 0.1, -2.95);
  } },
  // Three tubes splayed in a fan on a slim forearm, as the darts fly, each with a dart's tip in
  // its mouth while the rack's loaded (`userData.loaded`).
  darts: { home: 'A', build(pod, m) {
    pod.add(box(0.34, 0.34, 0.34, jointMat)); // shoulder
    put(pod, box(0.28, 0.36, 0.9, m.pods), -0.04, -0.12, -0.4); // forearm
    put(pod, box(0.42, 0.1, 0.8, m.trim), -0.04, 0.06, -0.65); // rack bed
    const loaded = [];
    for (const [x, fan] of [[-0.15, 0.06], [-0.04, 0], [0.07, -0.06]]) {
      const tube = put(pod, new THREE.Group(), x, 0.16, -0.3);
      tube.rotation.y = fan;
      put(tube, cyl(0.045, 0.045, 1.05, m.barrels), 0, 0, -0.525, ALONG_Z); // tube
      put(tube, cyl(0.058, 0.058, 0.05, m.trim), 0, 0, -1.05, ALONG_Z); // muzzle ring
      loaded.push(put(tube, cyl(0, 0.035, 0.16, dartMat), 0, 0, -1.1, -ALONG_Z)); // dart tip
    }
    put(pod, box(0.06, 0.1, 0.25, m.accent), -0.04, 0.26, -0.15); // sight
    pod.userData.loaded = loaded;
    return put(pod, new THREE.Object3D(), -0.04, 0.16, -1.4);
  } },
  // A two-by-two missile pod on a slim forearm under a lock-on sensor; the missiles' noses show in
  // its cells while it's loaded.
  hornet: { home: 'A', build(pod, m) {
    pod.add(box(0.34, 0.34, 0.34, jointMat)); // shoulder
    put(pod, box(0.28, 0.36, 0.9, m.pods), -0.04, -0.12, -0.4); // forearm
    put(pod, box(0.44, 0.44, 1.0, m.trim), -0.04, 0.2, -0.85); // missile pod
    const loaded = [];
    for (const x of [-0.14, 0.06]) {
      for (const y of [0.1, 0.3]) {
        put(pod, cyl(0.075, 0.075, 0.06, m.barrels), x, y, -1.36, ALONG_Z); // cell mouth
        loaded.push(put(pod, cyl(0, 0.06, 0.16, warheadMat), x, y, -1.42, -ALONG_Z)); // missile nose
      }
    }
    put(pod, box(0.14, 0.1, 0.14, m.accent), -0.04, 0.47, -0.6); // lock-on sensor
    pod.userData.loaded = loaded;
    return put(pod, new THREE.Object3D(), -0.04, 0.2, -1.45);
  } },
  // A beam projector on the forearm: a tapered housing ending in a dish between two prongs, its
  // lens glowing the mending green.
  mender: { home: 'A', build(pod, m) {
    pod.add(box(0.34, 0.34, 0.34, jointMat)); // shoulder
    put(pod, box(0.28, 0.36, 0.9, m.pods), -0.04, -0.12, -0.4); // forearm
    put(pod, cyl(0.2, 0.15, 0.8, m.trim), -0.04, 0.16, -0.8, ALONG_Z); // housing, wide at the back
    put(pod, cyl(0.14, 0.28, 0.14, m.barrels), -0.04, 0.16, -1.25, ALONG_Z); // dish, wide at the front
    put(pod, new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), mendLensMat), -0.04, 0.16, -1.28); // lens
    for (const x of [-0.24, 0.16]) put(pod, box(0.04, 0.04, 0.32, m.accent), x, 0.16, -1.42); // prongs
    return put(pod, new THREE.Object3D(), -0.04, 0.16, -1.45);
  } },
  // A long launch tube through a pod, flared at the back to vent the blast and banded with hazard
  // stripes, under a sight; the rocket's warhead shows in its mouth while it's loaded.
  rocket: { home: 'B', build(pod, m) {
    pod.add(box(0.55, 0.6, 1.0, m.pods));
    put(pod, cyl(0.17, 0.17, 1.5, m.barrels), 0, 0.05, -0.75, ALONG_Z); // tube
    put(pod, cyl(0.27, 0.18, 0.3, m.trim), 0, 0.05, 0.6, ALONG_Z); // back-blast vent, wide at the back
    put(pod, cyl(0.19, 0.19, 0.14, m.hazard), 0, 0.05, -1.1, ALONG_Z); // hazard band
    put(pod, cyl(0.22, 0.22, 0.1, m.trim), 0, 0.05, -1.5, ALONG_Z); // muzzle collar
    put(pod, box(0.08, 0.14, 0.35, m.trim), 0.18, 0.42, -0.35); // sight
    pod.userData.loaded = [put(pod, cyl(0, 0.15, 0.32, warheadMat), 0, 0.05, -1.6, -ALONG_Z)]; // warhead
    return put(pod, new THREE.Object3D(), 0, 0.05, -1.65);
  } },
  // A long, slim barrel between two rails out of a pod, under a scope: a long-range shot.
  spindle: { home: 'B', build(pod, m) {
    pod.add(box(0.5, 0.55, 1.1, m.pods));
    put(pod, cyl(0.06, 0.08, 1.9, m.barrels), 0, 0, -1.4, ALONG_Z); // barrel
    for (const y of [-0.13, 0.13]) put(pod, box(0.06, 0.05, 1.8, m.trim), 0, y, -1.35); // rails
    put(pod, box(0.18, 0.32, 0.1, m.trim), 0, 0, -2.3); // muzzle block
    put(pod, box(0.12, 0.14, 0.5, m.trim), 0, 0.36, -0.25); // scope
    put(pod, box(0.08, 0.06, 0.04, m.accent), 0, 0.36, -0.51); // its lens
    return put(pod, new THREE.Object3D(), 0, 0, -2.4);
  } },
  // A squat launcher with a wide barrel, finned to shed heat, over a core behind a grille that
  // glows with the mech's heat (`userData.core`, lit by `stoke`): what it'll throw.
  furnace: { home: 'B', build(pod, m) {
    pod.add(box(0.6, 0.65, 1.2, m.pods));
    put(pod, cyl(0.24, 0.26, 1.3, m.barrels), 0, 0.05, -1.1, ALONG_Z); // barrel
    put(pod, cyl(0.3, 0.3, 0.12, m.trim), 0, 0.05, -1.75, ALONG_Z); // muzzle ring
    const core = hot(new THREE.MeshBasicMaterial({ color: CORE_COLD }));
    put(pod, box(0.5, 0.1, 0.7, core), 0, 0.35, 0.05); // core window
    for (const z of [-0.2, 0.05, 0.3]) put(pod, box(0.54, 0.04, 0.04, m.trim), 0, 0.42, z); // grille
    for (const side of [-1, 1]) for (const z of [-0.3, 0, 0.3]) put(pod, box(0.05, 0.45, 0.12, m.trim), side * 0.33, 0, z); // fins
    pod.userData.core = core;
    return put(pod, new THREE.Object3D(), 0, 0.05, -1.85);
  } },
  // A short, fat tube raised 0.3 rad on a turret to lob, its mouth flared, banded and braced by
  // recoil springs, with spare shells racked down the housing's side; a shell's nose shows in the
  // mouth while it's loaded.
  mortar: { home: 'C', bore: [0, 0.15], build(pod, m) {
    put(pod, box(0.5, 0.4, 0.6, jointMat), 0, -0.3, 0.1); // turret ring
    put(pod, box(0.85, 0.7, 1.6, m.pods), 0, 0.05, -0.2); // breech housing
    for (const z of [-0.65, -0.25, 0.15]) {
      put(pod, cyl(0.1, 0.1, 0.42, m.hazard), 0.52, 0, z); // spare shell
      put(pod, cyl(0.04, 0.1, 0.1, warheadMat), 0.52, 0.26, z); // its nose
    }
    const tube = put(pod, new THREE.Group(), 0, 0.15, -0.9);
    tube.rotation.x = 0.3;
    put(tube, cyl(0.3, 0.27, 1.1, m.barrels), 0, 0, -0.55, ALONG_Z); // tube
    put(tube, cyl(0.33, 0.33, 0.12, m.hazard), 0, 0, -0.7, ALONG_Z); // band
    put(tube, cyl(0.29, 0.37, 0.2, m.trim), 0, 0, -1.12, ALONG_Z); // flared mouth
    for (const x of [-0.28, 0.28]) put(tube, cyl(0.05, 0.05, 0.75, m.trim), x, -0.2, -0.3, ALONG_Z); // recoil springs
    const shell = put(tube, new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 6), warheadMat), 0, 0, -1.12);
    shell.scale.z = 1.4;
    pod.userData.loaded = [shell];
    return put(tube, new THREE.Object3D(), 0, 0, -1.25);
  } },
  // A fat canister tube on a turret, ringed at the mouth with the bomblets it scatters; the
  // canister's nose shows while it's loaded.
  splitter: { home: 'C', build(pod, m) {
    put(pod, box(0.5, 0.4, 0.6, jointMat), 0, -0.3, 0.1); // turret ring
    put(pod, box(0.85, 0.7, 1.6, m.pods), 0, 0.05, -0.1); // housing
    put(pod, cyl(0.32, 0.32, 1.5, m.barrels), 0, 0.05, -1.5, ALONG_Z); // canister tube
    put(pod, cyl(0.36, 0.36, 0.14, m.hazard), 0, 0.05, -1.2, ALONG_Z); // band
    put(pod, cyl(0.46, 0.46, 0.12, m.trim), 0, 0.05, -2.1, ALONG_Z); // collar at the mouth, holding the bomblets
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      put(pod, new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), warheadMat), Math.cos(a) * 0.39, 0.05 + Math.sin(a) * 0.39, -2.17); // bomblet, half sunk in the collar
    }
    const nose = put(pod, new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 6), warheadMat), 0, 0.05, -2.25);
    nose.scale.z = 0.8;
    pod.userData.loaded = [nose];
    return put(pod, new THREE.Object3D(), 0, 0.05, -2.4);
  } },
  // A flat launch chute with a hazard-banded mouth on a turret, under a cassette of mine discs,
  // their lamps lit while the layer's loaded.
  warren: { home: 'C', build(pod, m) {
    put(pod, box(0.5, 0.4, 0.6, jointMat), 0, -0.3, 0.1); // turret ring
    put(pod, box(0.85, 0.6, 1.8, m.pods), 0, 0.05, -0.1); // housing
    put(pod, box(0.7, 0.3, 1.4, m.barrels), 0, 0.05, -1.5); // chute
    put(pod, box(0.78, 0.38, 0.12, m.hazard), 0, 0.05, -2.2); // its mouth
    const loaded = [];
    for (const z of [-0.5, -0.1, 0.3]) {
      put(pod, cyl(0.28, 0.28, 0.1, m.trim), 0, 0.4, z); // mine disc
      loaded.push(put(pod, cyl(0.05, 0.05, 0.03, mineLampMat), 0, 0.46, z)); // its lamp
    }
    pod.userData.loaded = loaded;
    return put(pod, new THREE.Object3D(), 0, 0.05, -2.3);
  } },
};

const COILS_COLD = new THREE.Color(0x2a1206), COILS_HOT = new THREE.Color(0xff9a40);
const CORE_COLD = new THREE.Color(0x1a0a04), CORE_HOT = new THREE.Color(0xff7a20);

/** Lights weapon `pod`'s heat core (`userData.core`) by the mech's heat, 0-1. */
export function stoke(pod, heat) {
  pod.userData.core?.color.lerpColors(CORE_COLD, CORE_HOT, Math.min(Math.max(heat, 0), 1));
}

/** Turns weapon `pod`'s spinner by `spin` (0-1) over `dt`, and lights its coils by `charge` (0-1). */
export function windUp(pod, spin, charge, dt) {
  const { spinner, charge: coils } = pod.userData;
  if (spinner) spinner.rotation.z += spin * 30 * dt;
  coils?.color.lerpColors(COILS_COLD, COILS_HOT, charge);
}

/** Shows weapon `pod`'s loaded round (`userData.loaded`) while its secondary is `ready`. */
export function showRound(pod, ready) {
  for (const round of pod.userData.loaded ?? []) round.visible = ready;
}

/** Class `cls`'s own weapons as a loadout: indices into weapons.json's primaries and secondaries. */
export function ownLoadout(cls) {
  const own = (classes[cls] ?? classes.B).weapons;
  return { primary: weapons.primaries.findIndex((w) => w.id === own.primary), secondary: weapons.secondaries.findIndex((w) => w.id === own.secondary) };
}

/** The weapons.json entries a loadout names (the first of a slot for an index out of range). */
export function armament(loadout) {
  return { primary: weapons.primaries[loadout.primary] ?? weapons.primaries[0], secondary: weapons.secondaries[loadout.secondary] ?? weapons.secondaries[0] };
}

/** Builds weapon `id` in `pod` at class `cls`'s left (`side` -1) or right (+1) arm; returns its muzzle. */
export function mountWeapon(pod, cls, side, id, m) {
  const spec = CLASSES[cls] ?? LANCER, kit = KITS[id] ?? KITS.pike;
  pod.position.set(side * spec.arm[0], spec.arm[1], spec.arm[2]);
  pod.scale.setScalar(spec.height / CLASSES[kit.home].height);
  const tip = kit.build(pod, m);
  const [x, y] = kit.bore ?? [tip.position.x, tip.position.y];
  for (const part of pod.children) part.position.x -= x, part.position.y -= y;
  return tip;
}

/** Stretch a segment mesh (built along Y) from a to b. */
function place(mesh, a, b) {
  mesh.position.lerpVectors(a, b, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, v1.subVectors(b, a).normalize());
}

/** Two-bone IK: the joint for a chain of lengths a and b from `root` to `end`, bending toward `bendDir`. */
function solveJoint(root, end, a, b, bendDir, out) {
  const d = v1.subVectors(end, root);
  const len = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  d.normalize();
  const along = (a * a - b * b + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(a * a - along * along, 0));
  const bend = v2.copy(bendDir).addScaledVector(d, -bendDir.dot(d)).normalize();
  return out.copy(root).addScaledVector(d, along).addScaledVector(bend, h);
}

export class Mech {
  /**
   * `cls` is 'A' (Wisp), 'B' (Lancer) or 'C' (Bulwark), carrying `loadout` (see `ownLoadout`).
   * Scale by tuning mech_height / `height`.
   */
  constructor(scene, fx, cls = 'B', loadout = ownLoadout(cls)) {
    const spec = (this.spec = CLASSES[cls] ?? LANCER);
    this.cls = CLASSES[cls] ? cls : 'B';
    this.loadout = loadout;
    this.weapons = armament(loadout);
    this.height = spec.height;
    this.scene = scene;
    this.fx = fx;
    this.team = -1;
    this.unit = -1;
    /** The player's own mech: its sounds play flat, as heard from the cockpit. */
    this.own = false;
    this.wear = { uDamage: { value: 0 }, uWreck: { value: 0 }, uFlash: { value: 0 } };
    const scheme = SCHEMES[0];
    this.hull = paintMaterial(this.wear, scheme.base, scheme.second, scheme.pattern);
    this.hullCurved = curvedPaint(this.hull);
    this.pods = paintMaterial(this.wear, TEAMS[-1].paint);
    this.trim = paintMaterial(this.wear, 0x2f3236);
    this.hazard = paintMaterial(this.wear, 0xc9a227, 0x1d1d1d, 'hazard');
    this.accent = hot(new THREE.MeshBasicMaterial({ color: TEAMS[-1].accent }));
    this.lit = 1;
    this.flicker = 0;
    this.barrels = new THREE.MeshLambertMaterial({ color: 0x2a2c30, flatShading: true });
    this.nozzleMat = new THREE.MeshLambertMaterial({ color: 0x3a2f28, flatShading: true });
    this.t = 0;
    this.phase = 0;
    this.squash = 0;
    this.airTime = 0;
    this.grounded = true;
    this.alive = true;
    this.wreck = 0;
    this.flash = 0;
    this.nextGun = 0;
    this.brace = 0;
    this.guard = 0; // a fresh launch's shield, 0-1
    this.glide = 0;
    this.boosting = false;
    this.dashTrail = 0; // seconds of dash smoke left to lay
    this.dashDir = new THREE.Vector3();
    this.shutdown = 0;
    this.facing = null; // the heading drawn: the view's, except held while shut down
    this.held = false;

    const root = (this.root = new THREE.Group());
    const body = (this.body = new THREE.Group());
    body.position.y = spec.hipY;
    root.add(body);
    spec.hull(body, this);

    // Thruster nozzles under the backpack; `exit` marks where flame leaves.
    this.nozzles = spec.nozzles.map(([x, y, z, size = 1]) => {
      const nozzle = put(body, cyl(0.2, 0.28, 0.45, this.nozzleMat), x, y, z, -0.6);
      nozzle.scale.setScalar(size);
      return put(nozzle, new THREE.Object3D(), 0, -0.3, 0);
    });

    // Weapon pods pitch with aim: the primary on the left arm, the secondary's launcher on the right.
    const pod = (side, weapon) => {
      const p = new THREE.Group();
      body.add(p);
      return { pod: p, tip: mountWeapon(p, this.cls, side, weapon.id, this) };
    };
    this.guns = [pod(-1, this.weapons.primary)];
    const launcher = pod(1, this.weapons.secondary);
    this.launcher = launcher.tip;
    this.arms = [this.guns[0].pod, launcher.pod];

    // Legs live in root space and are re-solved every frame.
    this.legs = [-1, 1].map((side, i) => {
      const { thigh, shin, knee, foot } = spec.leg(this);
      root.add(thigh, shin, knee, foot);
      return {
        side, i, thigh, shin, knee, foot, lifted: false,
        target: new THREE.Vector3(side * spec.stance, 0, -0.1),
        hip: new THREE.Vector3(), ankle: new THREE.Vector3(), joint: new THREE.Vector3(),
      };
    });


    // Brace shell: a faint pulsing shield around the Bulwark.
    this.shellMat = new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.shell = put(root, new THREE.Mesh(new THREE.IcosahedronGeometry(spec.height * 0.55, 1), this.shellMat), 0, spec.height * 0.5, 0);
    this.shell.visible = false;

    // Big parts cast sun shadows; everything receives them. Tiny parts skip the shadow pass.
    root.traverse((o) => {
      if (!o.isMesh || o === this.shell) return;
      o.receiveShadow = true;
      o.geometry.computeBoundingSphere();
      o.castShadow = o.geometry.boundingSphere.radius > 0.35;
    });

    // Added after the shadow pass: the strip stays out of it and the plate casts no shadow.
    const [sw, sy, sz, sl] = spec.strip;
    put(body, box(sw, 0.1, sl, this.accent), 0, sy, sz);
    const [pw, ph, py, pz] = spec.plate;
    this.stencil = document.createElement('canvas');
    this.stencil.width = 128;
    this.stencil.height = 64;
    const map = new THREE.CanvasTexture(this.stencil);
    map.colorSpace = THREE.SRGBColorSpace;
    this.plateMat = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // Face UVs read upright from outside, so the number shows on both flanks; depth = 2 x height
    // keeps the canvas's 2:1 aspect.
    this.plate = put(body, box(pw, ph, 2 * ph, this.plateMat), 0, py, pz);
    this.plate.receiveShadow = true;
    this.plate.visible = false;

    // Repair drone: lifts off the back during the wind-up, then hovers over the hull and beams it.
    this.drone = put(root, new THREE.Group(), 0, 0, 0);
    put(this.drone, box(0.6, 0.16, 0.6, this.trim), 0, 0, 0);
    for (const x of [-0.38, 0.38]) put(this.drone, box(0.16, 0.06, 0.7, this.trim), x, 0.02, 0);
    this.drone.add(halo(REPAIR_GLOW, 1.3));
    this.beamMat = new THREE.MeshBasicMaterial({ color: REPAIR_GLOW, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    // Unit length hanging down from the drone; scaled to reach the hull.
    this.beam = put(this.drone, new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.35, 1, 8, 1, true).translate(0, -0.5, 0), this.beamMat), 0, 0, 0);
    this.drone.visible = false;
    scene.add(root);
  }

  setTeam(team) {
    if (team === this.team) return;
    this.team = team;
    const t = TEAMS[team] ?? TEAMS[-1];
    this.pods.color.setHex(t.paint);
    this.lit = -1; // repaint the accents on the next update
  }

  /** Paint scheme, pattern offset and stencilled number from the player id (-1 offline). */
  setUnit(id) {
    if (id === this.unit) return;
    this.unit = id;
    const s = SCHEMES[Math.max(id, 0) % SCHEMES.length], u = this.hull.userData.uniforms;
    this.hull.color.setHex(s.base);
    u.uSecond.value.setHex(s.second);
    u.uPattern.value = PATTERNS[s.pattern];
    u.uSeed.value = Math.max(id, 0) * 7.31;
    stencil(this.stencil, id);
    this.plateMat.map.needsUpdate = true;
    this.plate.visible = id >= 0;
  }

  /**
   * Pose from sim state: { pos, yaw, pitch, scale, vel, grounded, boosting, hovering, health,
   * heat (0-1), overheated, ability (active), damage (0 full health to 1), repair (0 none, wind-up
   * fraction, 1 healing) }. Also emits thruster, footstep, smoke, spark and death effects.
   */
  update(dt, s) {
    this.t += dt;
    const { root, body, spec } = this;
    root.position.copy(s.pos);
    root.scale.setScalar(s.scale);

    const alive = s.health > 0;
    // Shut down for repair, the mech holds its heading while the pilot looks around, then turns
    // back to the view once the repair ends.
    if (this.facing === null || !alive) this.facing = s.yaw;
    else if (s.repair > 0) this.held = true;
    else if (this.held) {
      const off = Math.atan2(Math.sin(s.yaw - this.facing), Math.cos(s.yaw - this.facing));
      this.facing += off * (1 - Math.exp(-8 * dt));
      this.held = Math.abs(off) > 0.02;
    } else this.facing = s.yaw;
    root.rotation.y = this.facing;
    if (this.alive && !alive) {
      this.fx.explosion(world.copy(s.pos).addScaledVector(UP, 0.6 * spec.height * s.scale));
      Mech.audio?.death(this.own ? null : world);
    }
    this.alive = alive;
    this.wreck = alive ? 0 : Math.min(1, this.wreck + dt * 2);

    // Gait: one full step cycle covers two strides; stride grows with speed so feet don't slide.
    local.copy(s.vel).applyAxisAngle(UP, -this.facing).divideScalar(s.scale);
    // Our dashes start from dodge(); others' show as a sideways speed only a dash reaches.
    const dashing = Math.abs(local.x) > DASH_SPOT && Math.abs(local.x) > 1.5 * Math.abs(local.z);
    if (!this.own && alive && dashing && this.dashTrail <= 0) this.dodge(Math.sign(local.x));
    const speed = Math.hypot(local.x, local.z);
    const grounded = alive && s.grounded;
    // Boosting on the ground, the thrusters carry the mech: legs hold a crouched glide.
    const gliding = grounded && s.boosting;
    const moving = grounded && !gliding && speed > 0.6;
    this.glide = damp(this.glide, gliding ? 1 : 0, 6, dt);
    const stride = clamp(speed * spec.stride[0], spec.stride[1], spec.stride[2]);
    if (moving) this.phase += ((Math.PI * speed) / (2 * stride)) * dt;
    moveDir.set(local.x, 0, local.z).normalize();

    if (grounded && !this.grounded && this.airTime > 0.3) {
      this.squash = Math.min(0.5, this.airTime * 0.3);
      Mech.audio?.land(this.cls, this.own ? null : s.pos, this.airTime);
    }
    // Thrusters lighting up for a boost.
    if (alive && s.boosting && !this.boosting) Mech.audio?.ignite(this.cls, this.own ? null : s.pos);
    this.boosting = alive && s.boosting;
    this.airTime = grounded || !alive ? 0 : this.airTime + dt; // a respawn is no landing
    this.grounded = grounded;
    this.squash = Math.max(0, this.squash - dt * 2);
    this.flash = Math.max(0, this.flash - dt * 6);

    // Body bobs with the gait, leans into motion, sinks on landing and slumps when destroyed.
    // Lowest when the feet are spread, highest as they pass: as a walker does, and it lends reach.
    const bob = moving ? spec.bob * (1 + Math.cos(2 * this.phase)) * Math.min(speed / 6, 1) : 0;
    const sway = alive && s.hovering ? 0.06 * Math.sin(this.t * 5) : 0;
    // Brace sinks the Bulwark into a lower stance.
    this.brace = damp(this.brace, alive && s.ability && this.cls === 'C' ? 1 : 0, 8, dt);
    // Shut down for repair: it crouches as low as its hit shape does (CROUCH in sim/src/lib.rs)
    // and the guns droop.
    const repair = alive ? s.repair ?? 0 : 0;
    this.shutdown = damp(this.shutdown, repair > 0 ? 1 : 0, 4, dt);
    const crouch = this.shutdown * (1 - CROUCH) * spec.height;
    body.position.y = spec.hipY - bob - this.squash * 0.6 - this.wreck * spec.sink + sway - this.brace * 0.3 - crouch - this.glide * 0.35;
    body.rotation.x = damp(body.rotation.x, alive ? clamp(local.z / 16, -1, 1) * 0.25 : -0.45 * this.wreck, 6, dt);
    // No roll into strafes or dashes (it was disorienting); only a wreck keels over.
    body.rotation.z = damp(body.rotation.z, alive ? 0 : 0.25 * this.wreck, 8, dt);
    for (const arm of this.arms) arm.rotation.x = alive ? THREE.MathUtils.lerp(s.pitch - body.rotation.x, -0.4, this.shutdown) : -0.5;

    // Feet swing forward in the air and slide back while planted; knees bend per class.
    for (const leg of this.legs) {
      const p = this.phase + leg.i * Math.PI;
      let x = leg.side * spec.stance, y = 0, z = -0.1;
      if (!alive) {
        x = leg.side * (spec.stance + 0.4);
        z = -0.4;
      } else if (gliding) {
        x = leg.side * (spec.stance + 0.1);
        y = 0.12;
        z = -0.1 + (leg.i ? 0.35 : -0.35);
        leg.lifted = false;
      } else if (!grounded) {
        x = leg.side * (spec.stance + 0.05);
        y = s.hovering ? 1.1 : 0.55;
        z = 0.3;
      } else if (moving) {
        const reach = -Math.cos(p) * stride, lift = Math.max(0, Math.sin(p));
        x += moveDir.x * reach;
        z += moveDir.z * reach;
        y = lift * spec.lift * Math.min(speed / 4, 1);
        if (leg.lifted && lift === 0) {
          for (let n = 0; n < spec.dust; n++) this.fx.dust(leg.foot.getWorldPosition(world));
          Mech.audio?.step(this.cls, this.own ? null : world);
        }
        leg.lifted = lift > 0;
      }
      const rate = moving ? 30 : 10;
      leg.target.set(damp(leg.target.x, x, rate, dt), damp(leg.target.y, y, rate, dt), damp(leg.target.z, z, rate, dt));
      leg.hip.set(leg.side * spec.hipX, body.position.y, 0);
      leg.ankle.copy(leg.target).y += spec.ankleY;
      // Past full reach, pull the foot in toward the hip (it slides a touch) rather than letting
      // the leg come apart.
      const reach = (spec.thigh + spec.shin) * 0.99;
      if (stretch.subVectors(leg.ankle, leg.hip).length() > reach) {
        leg.ankle.copy(leg.hip).addScaledVector(stretch.normalize(), reach);
        leg.target.copy(leg.ankle).y -= spec.ankleY;
      }
      solveJoint(leg.hip, leg.ankle, spec.thigh, spec.shin, pole.set(leg.side * 0.2, 0, spec.knee), leg.joint);
      place(leg.thigh, leg.hip, leg.joint);
      place(leg.shin, leg.joint, leg.ankle);
      leg.knee.position.copy(leg.joint);
      leg.foot.position.copy(leg.target);
      leg.foot.rotation.x = alive && leg.target.y > 0.05 ? -0.3 : 0;
    }

    root.updateMatrixWorld(true);
    const thrusting = alive && (s.boosting || s.hovering);
    const slipstream = alive && s.ability && this.cls === 'A';
    if (slipstream) this.nozzleMat.emissive.setRGB(0.4, 0.7, 1);
    else this.nozzleMat.emissive.setRGB(thrusting ? 1 : 0.15, thrusting ? 0.45 : 0.05, 0);
    if (thrusting) {
      // Boost pushes flame back, hover straight down; Slipstream burns longer and blue-white.
      if (s.hovering) flame.set(0, -1, 0.15).normalize();
      else flame.set(0, -0.35, 1).normalize().applyQuaternion(root.quaternion);
      const power = s.hovering ? 1.4 : slipstream ? 1.6 : 1;
      for (const exit of this.nozzles) this.fx.thrust(exit.getWorldPosition(world), flame, power, dt, slipstream);
    }
    // Badly damaged: smoke, spitting sparks and lights that drop out.
    const damage = alive ? clamp(s.damage ?? 0, 0, 1) : 1;
    const critical = alive && damage > 0.7;
    if (critical) {
      this.fx.smoke(body.getWorldPosition(world), dt, 0.3);
      if (Math.random() < dt * 1.5) {
        const r = spec.height * 0.3;
        this.fx.impact(body.localToWorld(world.set((Math.random() - 0.5) * r, Math.random() * r, (Math.random() - 0.5) * r)));
      }
      if (this.flicker <= 0 && Math.random() < dt * 4) this.flicker = 0.05 + Math.random() * 0.15;
    }
    this.flicker -= dt;
    const lit = !alive ? 0 : repair > 0 ? 0.3 : critical && this.flicker > 0 ? 0.15 : 1;
    if (lit !== this.lit) {
      this.lit = lit;
      this.accent.color.setHex((TEAMS[this.team] ?? TEAMS[-1]).accent).multiplyScalar(lit);
    }
    if (this.dashTrail > 0) {
      this.fx.dashTrail(body.getWorldPosition(world), this.dashDir, dt, this.dashTrail > DASH_TRAIL - 0.15);
      this.dashTrail -= dt;
    }
    // The shell shows a Brace, or a fresh launch's shield (brighter, pulsing slower).
    this.guard = damp(this.guard, alive && s.shielded ? 1 : 0, 6, dt);
    this.shell.visible = this.brace > 0.05 || this.guard > 0.05;
    this.shellMat.opacity = Math.max(this.brace * (0.12 + 0.05 * Math.sin(this.t * 8)), this.guard * (0.2 + 0.08 * Math.sin(this.t * 4)));
    this.updateDrone(dt, repair);
    if (!alive) this.fx.smoke(world.copy(s.pos).addScaledVector(UP, 0.44 * spec.height * s.scale), dt, 0.18);
    if (alive && s.overheated) for (const gun of this.guns) this.fx.smoke(gun.tip.getWorldPosition(world), dt, 0.75);

    const heat = Math.max(s.heat ?? 0, 0);
    this.barrels.emissive.setRGB(heat * 0.9, heat * 0.25, heat * 0.05);
    this.wear.uDamage.value = damage;
    this.wear.uWreck.value = this.wreck;
    this.wear.uFlash.value = this.flash;
    this.plateMat.color.setScalar(1 - 0.85 * this.wreck);
  }

  /** Drone over the backpack: rises with the wind-up, then circles and beams while healing. */
  updateDrone(dt, repair) {
    const { drone, spec } = this;
    drone.visible = repair > 0;
    if (!drone.visible) return;
    const top = spec.height + 1.1, x = repair * repair * (3 - 2 * repair);
    const orbit = 0.6 * x;
    drone.position.set(orbit * Math.sin(this.t * 1.7), THREE.MathUtils.lerp(spec.hipY + 0.6, top, x) + 0.08 * Math.sin(this.t * 4), THREE.MathUtils.lerp(1.4, 0, x) + orbit * Math.cos(this.t * 1.7));
    drone.rotation.y = this.t * 2;
    this.beam.visible = repair >= 1;
    if (!this.beam.visible) return;
    const reach = drone.position.y - spec.height * 0.62;
    this.beam.scale.set(1, reach, 1);
    this.beamMat.opacity = 0.35 + 0.15 * Math.sin(this.t * 14);
    drone.updateMatrixWorld(true);
    this.fx.repair(this.beam.localToWorld(world.set(0, -1, 0)), dt);
  }

  /**
   * Muzzle flash, light and a glowing beam from the next barrel to `end`, with sparks there.
   * `from` overrides the muzzle (the cockpit's own guns in first person).
   */
  fire(end, from = null) {
    const gun = this.guns[(this.nextGun = (this.nextGun + 1) % this.guns.length)];
    from ??= gun.tip.getWorldPosition(world);
    Mech.audio?.shot(this.weapons.primary.sound, this.own ? null : from);
    this.fx.beam(from, end);
    this.fx.muzzleLight(from, this.own);
    this.fx.muzzle(from, flame.subVectors(end, from).normalize());
    this.fx.impact(end);
  }

  hit() {
    this.flash = 1;
  }

  /** Secondary fire leaving the launcher (or `from`, as in `fire`): a flash and a puff of flame and smoke. */
  launch(from = null) {
    const tip = from ?? this.launcher.getWorldPosition(world);
    this.fx.burst(tip, flame.set(0, 0.3, -1).normalize().applyQuaternion(this.root.quaternion));
    this.fx.muzzleLight(tip, this.own);
    Mech.audio?.launch(this.weapons.secondary.sound, this.own ? null : tip);
  }

  /** A projectile primary leaving the next barrel along `dir`: flash and light. Returns the muzzle; `from` as in `fire`. */
  muzzle(dir, from = null) {
    const gun = this.guns[(this.nextGun = (this.nextGun + 1) % this.guns.length)];
    from ??= gun.tip.getWorldPosition(new THREE.Vector3());
    this.fx.muzzleLight(from, this.own);
    this.fx.muzzle(from, dir);
    Mech.audio?.shot(this.weapons.primary.sound, this.own ? null : from);
    return from;
  }

  /** One-off cue when the class ability fires: Vent steam, a Slipstream kick, or a Brace pulse. */
  ability() {
    Mech.audio?.ability(this.cls, this.own ? null : this.body.getWorldPosition(world));
    if (this.cls === 'B') {
      this.fx.steam(this.body.getWorldPosition(world));
      for (const gun of this.guns) this.fx.steam(gun.tip.getWorldPosition(world));
    } else if (this.cls === 'A') {
      this.fx.burst(this.body.getWorldPosition(world), flame.set(0, -0.2, 1).applyQuaternion(this.root.quaternion));
    } else {
      this.flash = 0.6;
    }
  }

  /** Side-jet burst for a dash toward `dir` (-1 left, +1 right). */
  dodge(dir) {
    Mech.audio?.dash(this.own ? null : this.body.getWorldPosition(world));
    this.dashDir.set(-dir, 0, 0).applyQuaternion(this.root.quaternion);
    this.fx.burst(this.body.getWorldPosition(world), this.dashDir);
    this.dashTrail = DASH_TRAIL;
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => o.geometry?.dispose());
    this.root.traverse((o) => o.isSprite && o.material.dispose());
    this.plateMat.map.dispose();
    for (const m of [this.hull, this.hullCurved, this.pods, this.trim, this.hazard, this.accent, this.plateMat, this.barrels, this.nozzleMat, this.shellMat, this.beamMat]) m.dispose();
  }
}

/** Sound cues (`audio.js`), once the page sets them up. */
Mech.audio = null;
