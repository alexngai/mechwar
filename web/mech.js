// Original procedural mechs: three walker classes built from boxes and posed every frame from
// sim state. They're rigid parts on joints, so there's no skinned mesh; legs use two-bone IK.
import * as THREE from 'three';
import { halo } from './fx.js';

// Team color lives in the accents (visor, light strip) and the weapon pods; the hull carries a
// personal scheme picked from the player id. -1 is offline.
const TEAMS = {
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
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;\nvHalf = abs(position);');
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
const ALONG_Z = Math.PI / 2; // pitch that lays a cylinder along Z
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), local = new THREE.Vector3(), moveDir = new THREE.Vector3();
const pole = new THREE.Vector3(), world = new THREE.Vector3(), flame = new THREE.Vector3();

const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
const cyl = (top, bottom, h, mat) => new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, h, 8), mat);
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
const clamp = THREE.MathUtils.clamp;

/** Add `obj` to `parent` at (x, y, z) with pitch rx and roll rz. */
function put(parent, obj, x, y, z, rx = 0, rz = 0) {
  obj.position.set(x, y, z);
  obj.rotation.set(rx, 0, rz);
  parent.add(obj);
  return obj;
}

// Class specs. Model space is meters at the class's nominal `height`, feet at y = 0, facing -Z.
// Legs: hip height and spacing, bone lengths, ankle height, `knee` +1 bends back and -1 forward.
// Gait: foot `stance` x, stride = clamp(speed * k, min, max), bob and foot-lift amplitudes, wreck
// `sink`, dust puffs per footfall. `hull` builds the body, `gun` fills one pod per `guns` side and
// returns its muzzle, `leg` builds one leg's parts, `nozzles` are [x, y, z, size?] on the body.
// `strip` [width, y, z, length] is the accent light line and `plate` [width, height, y, z] the
// unit-number plate; each is a box just wider than the body there, so it shows on both flanks.
// Materials: `m.hull` personal paint, `m.pods` team paint, `m.trim` metal, `m.hazard` stripes,
// `m.accent` team-colored lights.

// B (Lancer), medium: the original reverse-joint walker with twin side pods.
const LANCER = {
  height: 5, hipY: 2.9, hipX: 0.72, thigh: 1.75, shin: 1.7, ankleY: 0.3, knee: 1,
  stance: 0.85, stride: [0.12, 0.3, 1.4], bob: 0.08, lift: 0.5, sink: 1.5, dust: 1,
  nozzles: [[-0.4, 0.35, 1.55], [0.4, 0.35, 1.55]],
  strip: [2.24, 1.27, 0.1, 1.6], plate: [1.34, 0.3, 0.9, 1.3],
  guns: [-1, 1],
  hull(body, m) {
    put(body, box(1.5, 0.5, 1.2, m.hazard), 0, 0, 0.05); // hip block
    put(body, box(2.2, 1.1, 1.8, m.hull), 0, 0.8, 0.1); // main hull
    put(body, box(2.0, 0.7, 1.0, m.hull), 0, 0.75, -0.95, 0.45); // sloped nose
    put(body, box(1.3, 0.16, 0.06, m.accent), 0, 0.95, -1.38, 0.45); // visor slit
    put(body, box(1.7, 0.3, 1.4, m.hull), 0, 1.45, 0.25, -0.06); // roof plate
    put(body, box(1.3, 1.0, 0.7, m.trim), 0, 0.85, 1.3); // backpack
    put(body, box(0.06, 0.9, 0.06, m.trim), -0.75, 1.95, 0.7); // antenna
  },
  gun(pod, side, m) {
    pod.position.set(side * 1.45, 0.9, -0.1);
    pod.add(box(0.55, 0.6, 1.3, m.pods));
    put(pod, cyl(0.1, 0.13, 1.4, m.barrels), 0, -0.05, -1.3, ALONG_Z);
    return put(pod, new THREE.Object3D(), 0, -0.05, -2.0);
  },
  leg(m) {
    const foot = new THREE.Group();
    put(foot, box(0.75, 0.24, 1.3, m.trim), 0, 0.12, -0.2); // sole
    put(foot, box(0.3, 0.2, 0.45, jointMat), 0, 0.1, 0.55); // heel
    return { thigh: box(0.42, this.thigh, 0.55, m.hull), shin: box(0.3, this.shin, 0.36, m.trim), knee: box(0.48, 0.48, 0.48, jointMat), foot };
  },
};

// A (Wisp), light: stilt legs under a narrow pod, swept tail fins and one long rifle on the right arm.
const WISP = {
  height: 4.2, hipY: 2.75, hipX: 0.5, thigh: 1.65, shin: 1.6, ankleY: 0.25, knee: 1,
  stance: 0.62, stride: [0.14, 0.35, 1.7], bob: 0.04, lift: 0.6, sink: 1.5, dust: 1,
  nozzles: [[-0.22, 0.3, 1.05, 0.7], [0.22, 0.3, 1.05, 0.7]],
  strip: [1.24, 0.9, 0.15, 1.2], plate: [1.24, 0.25, 0.5, 0.55],
  guns: [1],
  hull(body, m) {
    put(body, box(0.95, 0.4, 0.8, m.hazard), 0, 0, 0.05); // hip block
    put(body, box(1.2, 0.8, 1.4, m.hull), 0, 0.6, 0.15); // main hull
    put(body, box(0.75, 0.45, 1.0, m.hull), 0, 0.6, -0.95, 0.35); // pointed nose
    put(body, box(0.5, 0.1, 0.06, m.accent), 0, 0.78, -1.43, 0.35); // visor slit
    put(body, box(0.25, 0.2, 1.5, m.trim), 0, 1.05, 0.2); // dorsal spine
    put(body, box(0.75, 0.6, 0.5, m.trim), 0, 0.55, 0.95); // backpack
    put(body, box(0.25, 0.25, 0.55, m.trim), -0.72, 0.7, -0.1); // sensor pod
    put(body, box(0.12, 0.08, 0.04, m.accent), -0.72, 0.72, -0.39); // sensor lens
    for (const side of [-1, 1]) put(body, box(0.05, 0.9, 0.5, m.pods), side * 0.4, 1.3, 0.7, 0.7, -side * 0.4); // swept fin
  },
  gun(pod, side, m) {
    pod.position.set(side * 0.78, 0.6, -0.05);
    pod.add(box(0.34, 0.34, 0.34, jointMat)); // shoulder
    put(pod, box(0.28, 0.36, 1.1, m.pods), 0.04, -0.12, -0.45); // forearm
    put(pod, box(0.08, 0.12, 0.55, m.trim), 0.04, 0.12, -0.7); // scope
    put(pod, cyl(0.055, 0.075, 2.1, m.barrels), 0.04, -0.12, -1.95, ALONG_Z); // long barrel
    put(pod, box(0.15, 0.15, 0.25, m.trim), 0.04, -0.12, -3.0); // muzzle brake
    return put(pod, new THREE.Object3D(), 0.04, -0.12, -3.2);
  },
  leg(m) {
    const foot = new THREE.Group();
    for (const x of [-0.13, 0.13]) put(foot, box(0.14, 0.16, 0.95, m.trim), x, 0.08, -0.3); // split toes
    put(foot, box(0.16, 0.14, 0.45, jointMat), 0, 0.07, 0.4); // heel spur
    return { thigh: box(0.26, this.thigh, 0.36, m.hull), shin: box(0.18, this.shin, 0.22, m.trim), knee: box(0.32, 0.32, 0.32, jointMat), foot };
  },
};

// C (Bulwark), heavy: a wide armored box behind a front slab on thick forward-kneed legs, with
// twin cannons on the shoulders.
const BULWARK = {
  height: 5.8, hipY: 2.7, hipX: 1.15, thigh: 1.75, shin: 1.65, ankleY: 0.35, knee: -1,
  stance: 1.35, stride: [0.12, 0.3, 1.0], bob: 0.14, lift: 0.35, sink: 1.3, dust: 2,
  nozzles: [[-0.65, 0.35, 2.1, 1.3], [0.65, 0.35, 2.1, 1.3]],
  strip: [3.58, 1.15, 0.1, 1.7], plate: [3.58, 0.45, 0.78, 0.2],
  guns: [-1, 1],
  hull(body, m) {
    put(body, box(2.0, 0.6, 1.4, jointMat), 0, 0, 0); // hip block
    put(body, box(3.0, 1.6, 2.4, m.hull), 0, 1.05, 0.15); // main hull
    put(body, box(3.3, 1.5, 0.4, m.hull), 0, 0.7, -1.3, 0.15); // front armor slab
    put(body, box(3.0, 0.25, 0.5, m.hazard), 0, -0.1, -1.25); // slab lip
    put(body, box(1.6, 0.14, 0.06, m.accent), 0, 1.62, -1.06); // visor slit over the slab
    put(body, box(2.6, 0.35, 2.0, m.hull), 0, 2.0, 0.3, -0.04); // roof plate
    put(body, box(2.2, 1.4, 0.9, m.trim), 0, 0.9, 1.75); // reactor pack
    for (const side of [-1, 1]) {
      put(body, box(0.3, 0.9, 1.9, m.hull), side * 1.62, 0.8, 0.1); // side armor
      put(body, cyl(0.12, 0.14, 0.7, m.barrels), side * 0.6, 1.9, 1.9); // exhaust stack
    }
  },
  gun(pod, side, m) {
    pod.position.set(side * 1.15, 2.55, 0.2);
    put(pod, box(0.5, 0.4, 0.6, jointMat), 0, -0.3, 0.1); // turret ring
    put(pod, box(0.85, 0.7, 1.9, m.pods), 0, 0.1, -0.1); // housing
    put(pod, cyl(0.17, 0.21, 1.7, m.barrels), 0, 0.1, -1.85, ALONG_Z); // barrel
    put(pod, box(0.5, 0.5, 0.4, m.trim), 0, 0.1, -2.75); // muzzle block
    return put(pod, new THREE.Object3D(), 0, 0.1, -3.0);
  },
  leg(m) {
    const foot = new THREE.Group();
    put(foot, box(1.2, 0.32, 1.6, m.trim), 0, 0.16, -0.15); // sole
    put(foot, box(0.7, 0.3, 0.5, jointMat), 0, 0.15, 0.75); // heel
    put(foot, box(0.65, 0.4, 0.65, jointMat), 0, 0.45, 0); // ankle block
    return { thigh: box(0.7, this.thigh, 0.8, m.hull), shin: box(0.55, this.shin, 0.6, m.trim), knee: box(0.75, 0.75, 0.75, jointMat), foot };
  },
};

const CLASSES = { A: WISP, B: LANCER, C: BULWARK };

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
  /** `cls` is 'A' (Wisp), 'B' (Lancer) or 'C' (Bulwark). Scale by tuning mech_height / `height`. */
  constructor(scene, fx, cls = 'B') {
    const spec = (this.spec = CLASSES[cls] ?? LANCER);
    this.cls = CLASSES[cls] ? cls : 'B';
    this.height = spec.height;
    this.scene = scene;
    this.fx = fx;
    this.team = -1;
    this.unit = -1;
    this.wear = { uDamage: { value: 0 }, uWreck: { value: 0 }, uFlash: { value: 0 } };
    const scheme = SCHEMES[0];
    this.hull = paintMaterial(this.wear, scheme.base, scheme.second, scheme.pattern);
    this.pods = paintMaterial(this.wear, TEAMS[-1].paint);
    this.trim = paintMaterial(this.wear, 0x2f3236);
    this.hazard = paintMaterial(this.wear, 0xc9a227, 0x1d1d1d, 'hazard');
    this.accent = new THREE.MeshBasicMaterial({ color: TEAMS[-1].accent });
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
    this.dodgeRoll = 0;
    this.nextGun = 0;
    this.brace = 0;

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

    // Weapon pods pitch with aim and fire in turn.
    this.guns = spec.guns.map((side) => {
      const pod = new THREE.Group();
      body.add(pod);
      return { pod, tip: spec.gun(pod, side, this) };
    });

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
    const glowing = [];
    root.traverse((o) => {
      if (!o.isMesh || o === this.shell) return;
      o.receiveShadow = true;
      o.geometry.computeBoundingSphere();
      o.castShadow = o.geometry.boundingSphere.radius > 0.35;
      if (o.material === this.accent) glowing.push(o);
    });
    // Glow halos stand in for bloom: visors and lenses always, nozzles while thrusting.
    this.halos = glowing.map((o) => o.add(halo(TEAMS[-1].accent, 1.1)).children.at(-1));
    this.nozzleHalos = this.nozzles.map((exit) => exit.add(halo(0xffa040, 1.8)).children.at(-1));

    // Added after the shadow and halo pass: the strip needs no halo and the plate casts no shadow.
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
    scene.add(root);
  }

  setTeam(team) {
    if (team === this.team) return;
    this.team = team;
    const t = TEAMS[team] ?? TEAMS[-1];
    this.pods.color.setHex(t.paint);
    for (const h of this.halos) h.material.color.setHex(t.accent);
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
   * heat (0-1), overheated, ability (active), damage (0 full health to 1) }. Also emits thruster,
   * footstep, smoke, spark and death effects.
   */
  update(dt, s) {
    this.t += dt;
    const { root, body, spec } = this;
    root.position.copy(s.pos);
    root.rotation.y = s.yaw;
    root.scale.setScalar(s.scale);

    const alive = s.health > 0;
    if (this.alive && !alive) this.fx.explosion(world.copy(s.pos).addScaledVector(UP, 0.6 * spec.height * s.scale));
    this.alive = alive;
    this.wreck = alive ? 0 : Math.min(1, this.wreck + dt * 2);

    // Gait: one full step cycle covers two strides; stride grows with speed so feet don't slide.
    local.copy(s.vel).applyAxisAngle(UP, -s.yaw).divideScalar(s.scale);
    const speed = Math.hypot(local.x, local.z);
    const grounded = alive && s.grounded;
    const moving = grounded && speed > 0.6;
    const stride = clamp(speed * spec.stride[0], spec.stride[1], spec.stride[2]);
    if (moving) this.phase += ((Math.PI * speed) / (2 * stride)) * dt;
    moveDir.set(local.x, 0, local.z).normalize();

    if (grounded && !this.grounded && this.airTime > 0.3) this.squash = Math.min(0.5, this.airTime * 0.3);
    this.airTime = grounded ? 0 : this.airTime + dt;
    this.grounded = grounded;
    this.squash = Math.max(0, this.squash - dt * 2);
    this.dodgeRoll = damp(this.dodgeRoll, 0, 4, dt);
    this.flash = Math.max(0, this.flash - dt * 6);

    // Body bobs with the gait, leans into motion, sinks on landing and slumps when destroyed.
    const bob = moving ? spec.bob * (1 - Math.cos(2 * this.phase)) * Math.min(speed / 6, 1) : 0;
    const sway = alive && s.hovering ? 0.06 * Math.sin(this.t * 5) : 0;
    // Brace sinks the Bulwark into a lower stance.
    this.brace = damp(this.brace, alive && s.ability && this.cls === 'C' ? 1 : 0, 8, dt);
    body.position.y = spec.hipY - bob - this.squash * 0.6 - this.wreck * spec.sink + sway - this.brace * 0.3;
    body.rotation.x = damp(body.rotation.x, alive ? clamp(local.z / 16, -1, 1) * 0.25 : -0.45 * this.wreck, 6, dt);
    body.rotation.z = damp(body.rotation.z, alive ? -clamp(local.x / 16, -1, 1) * 0.2 + this.dodgeRoll : 0.25 * this.wreck, 8, dt);
    for (const gun of this.guns) gun.pod.rotation.x = alive ? s.pitch - body.rotation.x : -0.5;

    // Feet swing forward in the air and slide back while planted; knees bend per class.
    for (const leg of this.legs) {
      const p = this.phase + leg.i * Math.PI;
      let x = leg.side * spec.stance, y = 0, z = -0.1;
      if (!alive) {
        x = leg.side * (spec.stance + 0.4);
        z = -0.4;
      } else if (!grounded) {
        x = leg.side * (spec.stance + 0.05);
        y = s.hovering ? 1.1 : 0.55;
        z = 0.3;
      } else if (moving) {
        const reach = -Math.cos(p) * stride, lift = Math.max(0, Math.sin(p));
        x += moveDir.x * reach;
        z += moveDir.z * reach;
        y = lift * spec.lift * Math.min(speed / 4, 1);
        if (leg.lifted && lift === 0) for (let n = 0; n < spec.dust; n++) this.fx.dust(leg.foot.getWorldPosition(world));
        leg.lifted = lift > 0;
      }
      const rate = moving ? 30 : 10;
      leg.target.set(damp(leg.target.x, x, rate, dt), damp(leg.target.y, y, rate, dt), damp(leg.target.z, z, rate, dt));
      leg.hip.set(leg.side * spec.hipX, body.position.y, 0);
      leg.ankle.copy(leg.target).y += spec.ankleY;
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
    const lit = !alive ? 0 : critical && this.flicker > 0 ? 0.15 : 1;
    if (lit !== this.lit) {
      this.lit = lit;
      this.accent.color.setHex((TEAMS[this.team] ?? TEAMS[-1]).accent).multiplyScalar(lit);
    }
    for (const h of this.halos) h.visible = Mech.halos && lit === 1;
    for (const h of this.nozzleHalos) {
      h.visible = Mech.halos && thrusting;
      h.material.color.setHex(slipstream ? 0x80c0ff : 0xffa040);
    }
    this.shell.visible = this.brace > 0.05;
    this.shellMat.opacity = this.brace * (0.12 + 0.05 * Math.sin(this.t * 8));
    if (!alive) this.fx.smoke(world.copy(s.pos).addScaledVector(UP, 0.44 * spec.height * s.scale), dt, 0.18);
    if (alive && s.overheated) for (const gun of this.guns) this.fx.smoke(gun.tip.getWorldPosition(world), dt, 0.75);

    const heat = Math.max(s.heat ?? 0, 0);
    this.barrels.emissive.setRGB(heat * 0.9, heat * 0.25, heat * 0.05);
    this.wear.uDamage.value = damage;
    this.wear.uWreck.value = this.wreck;
    this.wear.uFlash.value = this.flash;
    this.plateMat.color.setScalar(1 - 0.85 * this.wreck);
  }

  /** Muzzle flash, light and a glowing beam from the next barrel to `end`, with sparks there. */
  fire(end) {
    const gun = this.guns[(this.nextGun = (this.nextGun + 1) % this.guns.length)];
    const from = gun.tip.getWorldPosition(world);
    this.fx.beam(from, end);
    this.fx.muzzleLight(from);
    this.fx.muzzle(from, flame.subVectors(end, from).normalize());
    this.fx.impact(end);
  }

  hit() {
    this.flash = 1;
  }

  /** One-off cue when the class ability fires: Vent steam, a Slipstream kick, or a Brace pulse. */
  ability() {
    if (this.cls === 'B') {
      this.fx.steam(this.body.getWorldPosition(world));
      for (const gun of this.guns) this.fx.steam(gun.tip.getWorldPosition(world));
    } else if (this.cls === 'A') {
      this.fx.burst(this.body.getWorldPosition(world), flame.set(0, -0.2, 1).applyQuaternion(this.root.quaternion));
    } else {
      this.flash = 0.6;
    }
  }

  /** Side-jet burst and a roll toward `dir` (-1 left, +1 right). */
  dodge(dir) {
    this.dodgeRoll = -dir * 0.4;
    this.fx.burst(this.body.getWorldPosition(world), flame.set(-dir, 0, 0).applyQuaternion(this.root.quaternion));
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => o.geometry?.dispose());
    this.root.traverse((o) => o.isSprite && o.material.dispose());
    this.plateMat.map.dispose();
    for (const m of [this.hull, this.pods, this.trim, this.hazard, this.accent, this.plateMat, this.barrels, this.nozzleMat, this.shellMat]) m.dispose();
  }
}

/** Halos on (High quality) or off (Low). */
Mech.halos = true;
