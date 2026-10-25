// First-person cockpit: an original curved canopy frame, the dash's instruments and the class's own
// weapons, kept in camera space and drawn in a second pass after the world with depth cleared, so
// none of it clips into walls; the weapons go first, under the cockpit (see `render`). One console wraps around the pilot and carries the mech's state:
// hull and fuel in the middle, the radar scope lower left with the ability's dial beside it, the
// items' dials right; the glass HUD (hud.js)
// keeps what's aimed and reacted with. The pass is lit like the world (sun direction, the map's
// palette, nearby lamps and flashes), shades under cover, and flashes with the guns.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CLASSES, TEAMS, cloak, ghostMaterial, mountWeapon, showRound, windUp } from './mech.js';
import { radar } from './hud.js';

const frameMat = new THREE.MeshLambertMaterial({ color: 0x5a5f66, flatShading: true });
const trimMat = new THREE.MeshLambertMaterial({ color: 0x1b1d20, flatShading: true });
const boltMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a6, flatShading: true });
const cableMat = new THREE.MeshLambertMaterial({ color: 0x2a2c2f, flatShading: true });
const pipMat = new THREE.MeshBasicMaterial({ color: 0x4dff88 });
const UP = new THREE.Vector3(0, 1, 0);
const v = new THREE.Vector3(), q = new THREE.Quaternion();
const DEPTH = 1; // canopy pillars sit this far ahead of the eye
const RECOIL = 0.12; // m
const RECOIL_RECOVER = 10; // 1/s
// The cockpit's guns are drawn at SHRINK of their size about their arm mounts, which sit SETBACK
// further back per class (model m), so less of them crowds the view: the Heavy's furthest, as its
// shoulder turrets ride at eye height.
const SHRINK = 0.8, SETBACK = { A: 0.2, B: 0.3, C: 0.6 };
const TAU = Math.PI * 2;
// The console, in its own flat space (x along its face, y up it from its foot, z toward the pilot):
// it reaches SPAN either side, stands HUMP tall over the middle screen and WING over the sides, and
// is then bent around an upright axis BEND ahead of its face and leaned back by TILT.
const SPAN = 1.3, HUMP = 0.3, WING = 0.335, BEND = 2.5, TILT = 0.55;
const DASH = 0.93; // the dash's back edge sits this fraction of the view's half-height below center
// Instruments, w x h in meters, centered at SCREEN_AT on the console: vitals (hull and fuel) in the
// middle, the round radar scope lower left, the items' two round dials right (the offensive item's
// up at 11 o'clock, the support item's at 2), and out on the wings a round dial for the ability
// (left) and a round speed gauge with the altitude in digits (right).
const SCREENS = { vitals: [0.48, 0.2], radar: [0.28, 0.28], offensive: [0.125, 0.125], support: [0.125, 0.125], speed: [0.14, 0.14], ability: [0.14, 0.14] };
const SCREEN_AT = { vitals: [0, 0.15], radar: [-0.5, 0.157], offensive: [0.41, 0.19], support: [0.575, 0.145], speed: [0.79, 0.125], ability: [-0.79, 0.125] };
const ROUND = new Set(['radar', 'speed', 'ability', 'offensive', 'support']); // set in a scope's round housing
const SPEED_MAX = 120; // km/h at the speed gauge's full sweep
const SEAM = 0.295; // panel seams between the middle and the sides
const RIM = 0.035, RIM_DEPTH = 0.07; // bezel around each screen: bar width, how far it stands out
const RADAR_RIM = 0.012; // the radar scope's slimmer ring, so the scope can fill the wing
const DIAL_RIM = 0.018; // the item dials' slimmer rings, so the pair fits where one panel was
const RIMS = { radar: RADAR_RIM, offensive: DIAL_RIM, support: DIAL_RIM }; // round housings' rings (RIM if not here)
const LOCAL = 3; // world lights (lamps, flashes) the cockpit takes at once
// Each class's canopy: frame paint, top bar depth, rib and brow thickness, how far the brow dips
// at the middle, and whether it has hydraulic rams, a second glazing rib or armored rib sleeves.
// The Light's is slim, pale and pointed; the Heavy's squat, dark and armored.
const CANOPY = {
  A: { paint: 0x6c737d, bar: 0.1, rib: 0.03, brow: 0.018, dip: 0.13, rams: false, glazing: 2, armor: false },
  B: { paint: 0x5a5f66, bar: 0.12, rib: 0.042, brow: 0.026, dip: 0.09, rams: true, glazing: 1, armor: false },
  C: { paint: 0x55534b, bar: 0.16, rib: 0.056, brow: 0.034, dip: 0.05, rams: true, glazing: 1, armor: true },
};
// Where the screens' light falls on the metal around them (one glow between the item dials), and its color.
const GLOW_AT = { vitals: SCREEN_AT.vitals, radar: SCREEN_AT.radar, items: [0.49, 0.165], speed: SCREEN_AT.speed, ability: SCREEN_AT.ability };
const GLOW = 0xffc46a;
const FLASH = 1.2, FLASH_LIFE = 0.06; // a shot's light on the cockpit: intensity, seconds
const INSTRUMENT_HZ = 20; // redraws per second
const AMBER = '#ffc46a', DIM = 'rgba(255,196,106,0.4)', FAINT = 'rgba(255,196,106,0.14)', WARN = '#ff4a3a', FUEL = '#7fd8ff', REPAIR = '#6dff9a';
const LAMP_OFF = 0x3a0b08;

// Split along x, so the console's boxes bend with it.
const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d, Math.ceil(w / 0.05)), mat);

/** A box stretched from a to b (built along Y), `t` thick. */
function strut(a, b, t, mat) {
  return along(box(t, a.distanceTo(b), t, mat), a, b);
}

/** A cylinder of radius `r` from a to b. */
function rod(a, b, r, mat) {
  return along(new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 10), mat), a, b);
}

/** Places a mesh built along Y so it spans a to b. */
function along(mesh, a, b) {
  mesh.position.lerpVectors(a, b, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, v.subVectors(b, a).normalize());
  return mesh;
}

/** A bolt head at (x, y, z) facing the pilot. */
function bolt(x, y, z, r = 0.007) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.008, 6), boltMat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * Slides gun `pod` (in `group`, camera space) outward so none of it hangs over the dash or the
 * lower middle of the view: what's below `line` stays outside `span`. Only ever sideways, so every
 * weapon on an arm keeps the class's height.
 */
function clearDash(group, pod) {
  const line = -0.27, span = 0.95; // slopes per meter ahead
  const out = Math.sign(pod.position.x) || 1, scale = group.scale.x;
  let slide = 0;
  group.updateMatrixWorld(true);
  pod.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (v.z > -0.05 || v.y > line * -v.z) continue;
      slide = Math.max(slide, span * -v.z - out * v.x);
    }
  });
  pod.position.x += (out * slide) / scale;
}

/** Bends console point `p` around the pilot (see BEND), in place. */
function bendPoint(p) {
  const a = p.x / BEND, r = BEND - p.z;
  return p.set(r * Math.sin(a), p.y, BEND - r * Math.cos(a));
}

function bend(geometry) {
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    bendPoint(v.fromBufferAttribute(p, i));
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return geometry;
}

/** Screen `s` set into the console's face: on a dark backing, inside a bolted frame standing out RIM_DEPTH. */
function bezel(s) {
  const g = new THREE.Group(), { w, h } = s;
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(w, h, 16, 1), s.mat).translateZ(0.006));
  g.add(box(w + 2 * RIM, h + 2 * RIM, 0.004, trimMat));
  for (const y of [-1, 1]) g.add(box(w + 2 * RIM, RIM, RIM_DEPTH, frameMat).translateY((y * (h + RIM)) / 2).translateZ(RIM_DEPTH / 2));
  for (const x of [-1, 1]) g.add(box(RIM, h, RIM_DEPTH, frameMat).translateX((x * (w + RIM)) / 2).translateZ(RIM_DEPTH / 2));
  for (const x of [-1, 1]) for (const y of [-1, 1]) g.add(bolt((x * (w + RIM)) / 2, (y * (h + RIM)) / 2, RIM_DEPTH + 0.004));
  return g;
}

/** A round scope: a round screen set into the console's face, in a deep, bolted bezel `rim` wide. */
function scope(s, rim = RIM) {
  const g = new THREE.Group(), r = s.w / 2, front = RIM_DEPTH - 0.01;
  g.add(new THREE.Mesh(new THREE.CircleGeometry(r, 48), s.mat).translateZ(0.006));
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(r + rim, r + rim, front, 40, 1, true), frameMat);
  wall.rotation.x = Math.PI / 2;
  g.add(wall.translateY(front / 2));
  g.add(new THREE.Mesh(new THREE.RingGeometry(r, r + rim, 40), frameMat).translateZ(front));
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * TAU;
    g.add(bolt(Math.cos(a) * (r + rim / 2), Math.sin(a) * (r + rim / 2), front + 0.004, Math.min(0.007, rim * 0.35)));
  }
  return g;
}

export class Cockpit {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.05, 50);
    this.hemi = new THREE.HemisphereLight(0xdfe8f0, 0x4a4238, 1.1);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.6);
    this.scene.add(this.hemi);
    this.scene.add(this.sun, this.sun.target);
    this.accent = new THREE.MeshBasicMaterial({ color: TEAMS[-1].accent });
    this.frame = new THREE.Group();
    this.scene.add(this.frame);
    this.aspect = 0;
    this.cls = 'B';
    this.team = -1;
    this.weapons = null;
    this.next = 0;
    this.screens = Object.fromEntries(Object.entries(SCREENS).map(([name, size]) => [name, screen(size)]));
    this.lampMat = new THREE.MeshBasicMaterial({ color: LAMP_OFF });
    this.drawnAt = -Infinity;
    // Each screen's glow on the metal around it, so the dash reads as lit hardware.
    this.glows = Object.fromEntries(Object.keys(GLOW_AT).map((name) => [name, new THREE.PointLight(GLOW, 0.08, 0.7, 2)]));
    this.scene.add(...Object.values(this.glows));
    this.flash = new THREE.PointLight(0xffc27a, 0, 1.6, 2);
    this.flashLife = 0;
    this.scene.add(this.flash);
    // The strongest lamps and flashes nearby, placed where they are relative to the eye. All stay in
    // the scene (dark when unused): changing the light count would recompile the materials.
    this.locals = Array.from({ length: LOCAL }, () => new THREE.PointLight(0xffffff, 0, 0, 2));
    this.scene.add(...this.locals);
    this.sunBase = this.sun.intensity;
    this.shade = 0; // 0 in the open, 1 under cover from the sun
  }

  /** Rebuilds the canopy to span the view at `aspect`; pillars stay just inside the screen edges. */
  layout(aspect) {
    // A hidden page can report a zero-height view; keep the last layout until it's real.
    if (aspect === this.aspect || !(aspect > 0 && Number.isFinite(aspect))) return;
    this.aspect = aspect;
    for (const o of [...this.frame.children]) {
      o.traverse((m) => m.geometry?.dispose());
      this.frame.remove(o);
    }
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * DEPTH;
    const halfW = halfH * aspect;
    const z = -DEPTH;
    const top = -halfH * DASH, width = 2 * halfW + 0.6;
    // The canopy, styled per class (CANOPY): a top bar with a curved brow under it, lit along its
    // edge in the team's color; ribs that rise from the dash, bow out along the view's edges and
    // curve in to meet the brow; thin glazing ribs across the upper corners; braces into the dash;
    // then the class's rams or armor.
    const style = CANOPY[this.cls] ?? CANOPY.B;
    frameMat.color.setHex(style.paint);
    const curve = (points) => new THREE.CatmullRomCurve3(points.map(([x, y, dz]) => new THREE.Vector3(x, y, z + dz)));
    const tube = (points, r, mat) => new THREE.Mesh(new THREE.TubeGeometry(curve(points), 40, r, 6), mat);
    this.frame.add(box(2 * halfW + 1, style.bar, 0.3, frameMat).translateY(halfH + 0.075 - style.bar / 2).translateZ(z));
    const brow = [[-halfW * 0.74, halfH - 0.03, 0.03], [-halfW * 0.3, halfH - style.dip, 0.05], [halfW * 0.3, halfH - style.dip, 0.05], [halfW * 0.74, halfH - 0.03, 0.03]];
    this.frame.add(tube(brow, style.brow, frameMat), tube(brow.map(([x, y, dz]) => [x, y - style.brow - 0.002, dz + 0.014]), 0.005, this.accent));
    if (style.armor) for (let t = 0.08; t < 0.95; t += 0.12) this.frame.add(bolt(...curve(brow).getPoint(t).add(new THREE.Vector3(0, 0.012, style.brow)).toArray(), 0.009));
    for (const side of [-1, 1]) {
      const rib = [[side * halfW * 0.98, -halfH * 0.62, -0.1], [side * halfW * 1.0, -halfH * 0.05, -0.03], [side * halfW * 0.95, halfH * 0.6, 0], [side * halfW * 0.74, halfH - 0.03, 0.03]];
      this.frame.add(tube(rib, style.rib, frameMat));
      this.frame.add(tube([[side * halfW * 0.42, halfH - 0.08, 0.05], [side * halfW * 0.74, halfH * 0.62, 0.0], [side * halfW * 0.95, halfH * 0.22, -0.02]], 0.012, trimMat));
      if (style.glazing > 1) this.frame.add(tube([[side * halfW * 0.6, halfH - 0.05, 0.04], [side * halfW * 0.86, halfH * 0.72, 0.0], [side * halfW * 0.97, halfH * 0.48, -0.01]], 0.008, trimMat));
      this.frame.add(tube([[side * halfW * 0.98, -halfH * 0.5, -0.08], [side * halfW * 0.9, top + 0.03, 0.02], [side * halfW * 0.72, top + 0.01, 0.12]], 0.028, frameMat));
      const path = curve(rib), at = (t) => path.getPoint(t).add(new THREE.Vector3(-side * 0.08, 0, 0.045));
      if (style.armor) {
        // Armored sleeves bolted over the ribs.
        const on = (t) => path.getPoint(t).add(new THREE.Vector3(-side * 0.01, 0, 0.02));
        for (const [a, b] of [[0.2, 0.36], [0.44, 0.6]]) this.frame.add(strut(on(a), on(b), 2.2 * style.rib, trimMat));
      }
      if (style.rams) {
        this.frame.add(rod(at(0.15), at(0.45), 0.024, cableMat), rod(at(0.4), at(0.72), 0.011, boltMat));
        for (const t of [0.15, 0.72]) this.frame.add(strut(at(t).add(new THREE.Vector3(side * 0.05, 0, -0.03)), at(t), 0.03, trimMat));
      }
    }
    // The dash: a sloped shelf with a bolted rubber front edge, and on it one console that wraps
    // around the pilot: hull and fuel in the middle under a hood, the radar scope lower left, the
    // dials either side, the heat lamp along its rolled rim, seams between, toggle banks at the
    // seams' feet and conduits clamped along its foot.
    const dash = box(width, 0.5, 0.7, frameMat);
    dash.position.set(0, top - 0.25, z - 0.1);
    dash.rotation.x = 0.25;
    this.frame.add(dash);
    // The shelf's top falls from top + 0.08 at its back to top - 0.09 at its front edge (z + 0.3).
    const surface = (zz) => top + 0.079 - (0.173 * (zz - (z - 0.377))) / 0.677;
    this.frame.add(box(width, 0.04, 0.06, trimMat).translateY(top).translateZ(z + 0.24));
    for (let x = -halfW; x <= halfW; x += 0.2) this.frame.add(bolt(x, top, z + 0.272));
    const panel = new THREE.Group(), flat = new THREE.Group(), foot = z - 0.02;
    panel.position.set(0, surface(foot) - 0.01, foot);
    panel.rotation.x = -TILT;
    panel.updateMatrix();
    const onPanel = (x, y, dz) => bendPoint(new THREE.Vector3(x, y, dz)).applyMatrix4(panel.matrix);
    const S = THREE.MathUtils.smoothstep;
    const edge = (x) => WING + (HUMP - WING) * (1 - S(Math.abs(x), SEAM - 0.03, SEAM + 0.03)) - (WING - 0.08) * S(Math.abs(x), 0.95, 1.2);
    const face = new THREE.PlaneGeometry(2 * SPAN, 1, 156, 4), p = face.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, (p.getY(i) + 0.5) * edge(p.getX(i)));
    flat.add(new THREE.Mesh(face, frameMat));
    const rim = (from, to, dy, dz) => {
      const points = [];
      for (let x = from; x <= to + 1e-6; x += 0.02) points.push(new THREE.Vector3(x, edge(x) + dy, dz));
      return new THREE.CatmullRomCurve3(points);
    };
    flat.add(new THREE.Mesh(new THREE.TubeGeometry(rim(-SPAN, SPAN, 0, 0), 260, 0.02, 6), frameMat));
    flat.add(new THREE.Mesh(new THREE.TubeGeometry(rim(-0.75, 0.75, 0.012, 0.014), 150, 0.006, 5), this.lampMat));
    for (const side of [-1, 1]) flat.add(rod(new THREE.Vector3(side * SEAM, 0.01, 0.002), new THREE.Vector3(side * SEAM, edge(side * SEAM) - 0.02, 0.002), 0.005, trimMat));
    for (let x = -1.2; x <= 1.2 + 1e-6; x += 0.15) flat.add(bolt(x, 0.015, 0.004));
    for (const [name, s] of Object.entries(this.screens)) {
      const [x, y] = SCREEN_AT[name];
      flat.add((ROUND.has(name) ? scope(s, RIMS[name] ?? RIM) : bezel(s)).translateX(x).translateY(y));
    }
    for (const [name, [x, y]] of Object.entries(GLOW_AT)) this.glows[name].position.copy(onPanel(x, y, 0.14));
    const [vw, vh] = SCREENS.vitals, vy = SCREEN_AT.vitals[1] + vh / 2 + RIM;
    const hood = box(vw + 2 * RIM + 0.05, 0.012, 0.05, frameMat);
    hood.position.set(0, vy + 0.008, 0.025);
    hood.rotation.x = 0.25;
    flat.add(hood);
    for (const side of [-1, 1]) flat.add(box(0.012, 0.05, 0.05, frameMat).translateX(side * (vw / 2 + RIM + 0.02)).translateY(vy - 0.02).translateZ(0.025));
    flat.updateMatrixWorld(true);
    flat.traverse((o) => o.isMesh && panel.add(new THREE.Mesh(bend(o.geometry.applyMatrix4(o.matrixWorld)), o.material)));
    this.frame.add(panel);
    for (const [dz, r] of [[0.08, 0.013], [0.12, 0.009]]) {
      const at = (x) => {
        const pt = onPanel(x, 0, dz);
        pt.y = surface(pt.z) + r;
        return pt;
      };
      const points = [];
      for (let x = -SPAN; x <= SPAN + 1e-6; x += 0.1) points.push(at(x));
      this.frame.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 60, r, 8), cableMat));
      for (let x = -1.05; x <= 1.05 + 1e-6; x += 0.35) {
        const clamp = box(0.025, 2.6 * r, 0.03, boltMat);
        clamp.position.copy(at(x));
        clamp.rotation.y = -x / BEND;
        this.frame.add(clamp);
      }
    }
    for (const side of [-1, 1]) {
      const at = onPanel(side * SEAM, 0, 0.035), y = surface(at.z);
      const bank = new THREE.Group();
      bank.position.set(at.x, y, at.z);
      bank.rotation.y = (-side * SEAM) / BEND;
      bank.add(box(0.055, 0.012, 0.06, trimMat).translateY(0.006));
      for (const dx of [-0.017, 0, 0.017]) {
        bank.add(rod(new THREE.Vector3(dx, 0.012, -0.01), new THREE.Vector3(dx, 0.04, 0.005), 0.004, boltMat));
        bank.add(box(0.008, 0.006, 0.008, pipMat).translateX(dx).translateY(0.014).translateZ(0.023));
      }
      this.frame.add(bank);
    }
    // One mesh per material: the cockpit draws every frame, so keep its draw calls few.
    this.frame.updateMatrixWorld(true);
    const parts = new Map();
    this.frame.traverse((o) => {
      if (!o.isMesh) return;
      if (!parts.has(o.material)) parts.set(o.material, []);
      parts.get(o.material).push(o.geometry.clone().applyMatrix4(o.matrixWorld).toNonIndexed());
    });
    for (const o of [...this.frame.children]) {
      o.traverse((m) => m.geometry?.dispose());
      this.frame.remove(o);
    }
    for (const [material, geometries] of parts) this.frame.add(new THREE.Mesh(mergeGeometries(geometries), material));
  }

  /** Redraws the dash from `f`, the frame main.js also hands the glass HUD (see drawGlass). */
  instruments(f) {
    if (f.now - this.drawnAt < 1000 / INSTRUMENT_HZ) return;
    this.drawnAt = f.now;
    const blink = Math.floor(f.now / 150) % 2 === 0;
    this.lampMat.color.setHex(f.overheated ? (blink ? 0xff3a20 : LAMP_OFF) : f.heat > 0.8 ? 0xff7a30 : LAMP_OFF);
    vitalsScreen(this.screens.vitals, f);
    radarScreen(this.screens.radar, f);
    dialScreen(this.screens.ability, abilityDial(f), f.now);
    f.items.forEach((it, i) => dialScreen(this.screens[i ? 'support' : 'offensive'], itemDial(it), f.now));
    speedScreen(this.screens.speed, f);
    for (const s of Object.values(this.screens)) {
      if (f.jammed) jamStatic(s);
      s.map.needsUpdate = true;
    }
  }

  /**
   * `mech`'s weapons on class `cls`'s arms, painted with its materials (so damage scorch and
   * barrel heat glow match), at the mech's `scale`, placed where they sit relative to an eye
   * `eyeHeight` above the feet, shrunk and set back (see SHRINK).
   */
  setWeapons(cls, mech, eyeHeight, scale = 1) {
    this.cls = cls;
    this.aspect = 0; // rebuild the canopy in the class's style
    if (this.weapons) {
      this.scene.remove(this.weapons.group);
      this.weapons.group.traverse((o) => o.geometry?.dispose());
    }
    const spec = CLASSES[cls], group = new THREE.Group();
    group.scale.setScalar(scale);
    group.position.y = spec.hipY * scale - eyeHeight;
    const arm = (side, weapon) => {
      const pod = new THREE.Group();
      group.add(pod);
      const tip = mountWeapon(pod, cls, side, weapon.id, mech);
      pod.scale.multiplyScalar(SHRINK);
      pod.position.z += SETBACK[cls] ?? 0;
      clearDash(group, pod);
      return { pod, tip, rest: pod.position.clone(), kick: 0 };
    };
    const guns = [arm(-1, mech.weapons.primary)];
    const launcher = arm(1, mech.weapons.secondary);
    this.scene.add(group);
    this.weapons = { group, guns, launcher, arms: [...guns, launcher] };
    this.next = 0;
    this.cloaked = false;
  }

  /**
   * Camouflage on our own guns: drawn in the ghost material at `opacity` (0 for solid),
   * shimmering, so the pilot sees they're hidden. The canopy and console stay solid.
   */
  cloak(opacity, now) {
    if (!this.weapons) return;
    this.ghost ??= ghostMaterial();
    if (opacity > 0 !== this.cloaked) {
      this.cloaked = opacity > 0;
      cloak(this.weapons.group, this.ghost, this.cloaked);
    }
    this.ghost.opacity = opacity * (0.75 + 0.25 * Math.sin(now * 0.006));
  }

  /**
   * Draws the pass over whatever `renderer` holds (it must not auto-clear): the guns first, then
   * the canopy and console over them, depth cleared between, so the frame always covers the guns
   * and they only show through the glass, outside the cockpit.
   */
  render(renderer) {
    const guns = this.weapons?.group;
    this.frame.visible = false;
    renderer.render(this.scene, this.camera);
    renderer.clearDepth();
    this.frame.visible = true;
    if (guns) guns.visible = false;
    renderer.render(this.scene, this.camera);
    if (guns) guns.visible = true;
  }

  /**
   * Spins the primary's barrels by `spin` and lights its coils by `charge` (see mech.js `windUp`),
   * and shows the secondary's round while it's `ready`.
   */
  windUp(spin, charge, ready, dt) {
    if (!this.weapons) return;
    windUp(this.weapons.guns[0].pod, spin, charge, dt);
    showRound(this.weapons.launcher.pod, ready);
  }

  /** Matches the world's `hemi` and `sun` lights, a little dimmer: the canopy is under a roof. */
  light(hemi, sun) {
    this.hemi.color.copy(hemi.color);
    this.hemi.groundColor.copy(hemi.groundColor);
    this.hemi.intensity = hemi.intensity * 0.8;
    this.sun.color.copy(sun.color);
    this.sunBase = sun.intensity * 0.6;
  }

  setTeam(team) {
    if (team === this.team) return;
    this.team = team;
    this.accent.color.setHex((TEAMS[team] ?? TEAMS[-1]).accent);
  }

  /** Where the launcher's muzzle is in the world, without firing it (a held beam starts there). */
  launcherTip(worldCamera, out) {
    this.scene.updateMatrixWorld();
    return worldCamera.localToWorld(this.weapons.launcher.tip.getWorldPosition(out));
  }

  /**
   * Kicks the next primary gun back (in turn like the mech's own), or the launcher for `secondary`
   * fire, and returns its muzzle in world space, given the world camera this cockpit rides with.
   */
  fire(worldCamera, out, secondary = false) {
    const { guns, launcher } = this.weapons;
    const gun = secondary ? launcher : guns[(this.next = (this.next + 1) % guns.length)];
    gun.kick = RECOIL;
    this.scene.updateMatrixWorld();
    gun.tip.getWorldPosition(out);
    this.flash.position.copy(out);
    this.flashLife = FLASH_LIFE;
    return worldCamera.localToWorld(out);
  }

  /**
   * Lights the cockpit with the strongest of `lights` at the eye of `worldCamera`: each { at, rgb,
   * radius, power } in world space, falling off as arena.js bakes them, unless `clear(at)` says a
   * wall stands between.
   */
  local(worldCamera, lights, clear) {
    const eye = worldCamera.position;
    const near = lights
      .map((l) => ({ l, d: l.at.distanceTo(eye) }))
      .map((c) => ({ ...c, k: c.d < c.l.radius ? Math.min(c.l.power * (1 - c.d / c.l.radius) ** 2, 2.5) : 0 }))
      .filter((c) => c.k > 0.02)
      .sort((a, b) => b.k - a.k);
    let n = 0;
    for (const { l, d, k } of near) {
      if (n === LOCAL) break;
      if (!clear(l.at)) continue;
      // Irradiance pi * k here makes Lambert metal glow k times its color, as the arena's baked light does.
      const light = this.locals[n++];
      worldCamera.worldToLocal(light.position.copy(l.at));
      light.color.copy(l.rgb);
      light.intensity = Math.PI * k * d * d;
    }
    for (; n < LOCAL; n++) this.locals[n].intensity = 0;
  }

  /**
   * Follows the world camera's aspect and the sun, eases into shade when `shaded` (the sun blocked),
   * and eases recoil and the last shot's flash back. `fov` is the base field of view: the canopy
   * ignores the boost kick so it doesn't rebuild while it eases.
   */
  update(dt, worldCamera, sunDir, fov, shaded) {
    const c = this.camera;
    if (c.fov !== fov || c.aspect !== worldCamera.aspect) {
      c.fov = fov;
      c.aspect = worldCamera.aspect;
      c.updateProjectionMatrix();
      this.aspect = 0; // force a relayout for the new lens
    }
    this.layout(c.aspect);
    // The sun in camera space, so the canopy shades as the view turns.
    this.sun.position.copy(sunDir).applyQuaternion(q.copy(worldCamera.quaternion).invert());
    this.shade += ((shaded ? 1 : 0) - this.shade) * (1 - Math.exp(-6 * dt));
    this.sun.intensity = this.sunBase * (1 - 0.8 * this.shade);
    this.flashLife = Math.max(0, this.flashLife - dt);
    this.flash.intensity = (FLASH * this.flashLife) / FLASH_LIFE;
    for (const gun of this.weapons?.arms ?? []) {
      gun.kick *= Math.exp(-RECOIL_RECOVER * dt);
      gun.pod.position.copy(gun.rest).z += gun.kick;
    }
  }
}

// --- Instruments -----------------------------------------------------------------------------
// Each screen is a canvas texture, 512 px wide; text is sized to read at 1200 px windows.

/** A screen `w` x `h` meters: its canvas, texture and an unlit material that ignores tone mapping. */
function screen([w, h]) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * h) / w);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return { w, h, canvas, g: canvas.getContext('2d'), map, mat: new THREE.MeshBasicMaterial({ map, toneMapped: false }) };
}

const font = (px, weight = '') => `${weight} ${px}px ui-monospace, Menlo, monospace`;
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

/** Blanks screen `s` to its dark glass and frame; returns its context and size. */
function blank(s) {
  const { g, canvas } = s, W = canvas.width, H = canvas.height;
  g.fillStyle = '#090d0b';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = FAINT;
  g.lineWidth = 4;
  g.strokeRect(6, 6, W - 12, H - 12);
  g.textAlign = 'left';
  g.textBaseline = 'top';
  return [g, W, H];
}

function bar(g, x, y, w, h, fill, color) {
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fillRect(x, y, w, h);
  g.fillStyle = color;
  g.fillRect(x, y, w * clamp01(fill), h);
}

/**
 * Vitals: the hull's number and bar on top, the fuel bar under it (it drains with boost, hover and
 * dodges; the tick is what a boost needs), the repair cycle's state at the bottom, and a red wash
 * when hit.
 */
function vitalsScreen(s, f) {
  const [g, W, H] = blank(s);
  if (f.hurt > 0) {
    g.fillStyle = `rgba(255,60,40,${0.3 * f.hurt})`;
    g.fillRect(0, 0, W, H);
  }
  const x = 176, w = W - x - 24, hull = f.health / f.healthMax, color = hull < 0.3 ? WARN : AMBER;
  g.fillStyle = DIM;
  g.font = font(22);
  g.fillText(`HULL · ${f.className.toUpperCase()}`, x, 22);
  g.fillStyle = color;
  g.font = font(72, 'bold');
  g.fillText(String(Math.ceil(f.health)), 24, 36);
  bar(g, x, 52, w, 36, hull, color);
  const short = f.fuel < f.boostMin;
  g.fillStyle = short ? WARN : FUEL;
  g.font = font(30);
  g.fillText('FUEL', 24, 132);
  bar(g, x, 128, w, 30, f.fuel, short ? WARN : FUEL);
  const tick = x + w * f.boostMin;
  g.fillStyle = AMBER;
  g.fillRect(tick - 2, 120, 4, 46);
  const status = f.standing ? 'RESTARTING' : f.repair >= 1 ? 'REPAIRING' : f.repair > 0 ? 'SHUTTING DOWN' : '';
  if (status) {
    g.fillStyle = REPAIR;
    g.font = font(26, 'bold');
    g.fillText(status, x, 178);
  }
}

/** Radar: the glass's radar (hud.js), drawn large for the round scope, its marks bold enough to read. */
function radarScreen(s, f) {
  const { g, canvas } = s, W = canvas.width;
  g.fillStyle = '#090d0b';
  g.fillRect(0, 0, W, W);
  radar(g, W / 2, W / 2, W * 0.47, W / 130, f, f.radarMap);
}

/** Speed: a needle sweeping 0 to SPEED_MAX km/h, with the altitude in digits under the hub. */
function speedScreen(s, f) {
  const { g, canvas } = s, W = canvas.width, c = W / 2, r = W * 0.42;
  g.fillStyle = '#090d0b';
  g.fillRect(0, 0, W, W);
  // From lower left, clockwise round the top to lower right.
  const angle = (kmh) => Math.PI * 0.75 + (Math.min(Math.max(kmh, 0), SPEED_MAX) / SPEED_MAX) * Math.PI * 1.5;
  g.strokeStyle = g.fillStyle = AMBER;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = font(40);
  for (let v = 0; v <= SPEED_MAX; v += 10) {
    const a = angle(v), major = v % 20 === 0, inner = r - (major ? 34 : 18);
    g.lineWidth = major ? 6 : 4;
    g.globalAlpha = major ? 1 : 0.55;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
    g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    g.stroke();
    if (major) g.fillText(String(v), c + Math.cos(a) * (r - 66), c + Math.sin(a) * (r - 66));
  }
  g.globalAlpha = 1;
  const a = angle(f.speed * 3.6);
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(c - Math.cos(a) * 28, c - Math.sin(a) * 28);
  g.lineTo(c + Math.cos(a) * (r - 22), c + Math.sin(a) * (r - 22));
  g.stroke();
  g.beginPath();
  g.arc(c, c, 18, 0, TAU);
  g.fill();
  g.fillStyle = DIM;
  g.font = font(30);
  g.fillText('KM/H', c, c + 68);
  g.fillStyle = AMBER;
  g.font = font(46, 'bold');
  g.fillText(`${Math.round(f.altitude)} M`, c, c + 150);
}

// Dial icons by weapons.json id, stroked in a unit square about the origin (y down).
const poly = (g, points, close = false) => {
  g.beginPath();
  points.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (close) g.closePath();
  g.stroke();
};
const ring = (g, x, y, r, from = 0, to = TAU) => {
  g.beginPath();
  g.arc(x, y, r, from, to);
  g.stroke();
};
const tripod = (g) => {
  for (const x of [-0.6, 0, 0.6]) poly(g, [[0, 0.15], [x, 0.8]]);
};
const ICONS = {
  // Speed boost: chevrons pointing ahead.
  slipstream: (g) => {
    for (const y of [0, 0.55]) poly(g, [[-0.6, y + 0.1], [0, y - 0.5], [0.6, y + 0.1]]);
  },
  // Vent: heat rising off three vents.
  vent: (g) => {
    for (const x of [-0.45, 0, 0.45]) {
      g.beginPath();
      g.moveTo(x, 0.75);
      g.quadraticCurveTo(x + 0.3, 0.4, x, 0);
      g.quadraticCurveTo(x - 0.3, -0.4, x, -0.75);
      g.stroke();
    }
  },
  // Bulwark: a shield.
  brace: (g) => {
    g.beginPath();
    g.moveTo(0, -0.8);
    g.lineTo(0.65, -0.55);
    g.quadraticCurveTo(0.6, 0.45, 0, 0.85);
    g.quadraticCurveTo(-0.6, 0.45, -0.65, -0.55);
    g.closePath();
    g.stroke();
  },
  // Camouflage: an eye, struck through.
  cloak: (g) => {
    g.beginPath();
    g.moveTo(-0.8, 0);
    g.quadraticCurveTo(0, -0.75, 0.8, 0);
    g.quadraticCurveTo(0, 0.75, -0.8, 0);
    g.stroke();
    ring(g, 0, 0, 0.22);
    poly(g, [[-0.7, 0.7], [0.7, -0.7]]);
  },
  // Power shot: a bolt.
  power: (g) => poly(g, [[0.2, -0.85], [-0.45, 0.1], [0, 0.1], [-0.2, 0.85], [0.45, -0.15], [0, -0.15]], true),
  // Barrage: three rounds abreast.
  barrage: (g) => {
    for (const x of [-0.5, 0, 0.5]) poly(g, [[x - 0.14, 0.7], [x - 0.14, -0.25], [x, -0.65], [x + 0.14, -0.25], [x + 0.14, 0.7]], true);
  },
  // Artillery: a blast.
  artillery: (g) => poly(g, Array.from({ length: 16 }, (_, k) => [Math.sin((k * TAU) / 16) * (k % 2 ? 0.4 : 0.85), -Math.cos((k * TAU) / 16) * (k % 2 ? 0.4 : 0.85)]), true),
  // Tumbler: a grenade and its lever.
  grenade: (g) => {
    ring(g, 0, 0.2, 0.55);
    poly(g, [[0, -0.35], [0, -0.65]]);
    poly(g, [[-0.1, -0.62], [0.5, -0.4]]);
  },
  // Limpet: a spiked mine.
  limpet: (g) => {
    ring(g, 0, 0, 0.4);
    for (let k = 0; k < 6; k++) poly(g, [[Math.cos((k * TAU) / 6) * 0.4, Math.sin((k * TAU) / 6) * 0.4], [Math.cos((k * TAU) / 6) * 0.78, Math.sin((k * TAU) / 6) * 0.78]]);
  },
  // Pall: a cloud.
  smoke: (g) => {
    g.beginPath();
    g.arc(-0.4, 0.15, 0.35, Math.PI * 0.5, Math.PI * 1.5);
    g.arc(0.05, -0.15, 0.42, Math.PI, TAU);
    g.arc(0.45, 0.15, 0.35, Math.PI * 1.5, Math.PI * 0.5);
    g.closePath();
    g.stroke();
  },
  // MG turret: a gun on a tripod.
  mg_turret: (g) => {
    tripod(g);
    poly(g, [[-0.3, -0.3], [0.25, -0.3], [0.25, 0.15], [-0.3, 0.15]], true);
    poly(g, [[0.25, -0.08], [0.85, -0.08]]);
  },
  // Rocket turret: a launcher on a tripod.
  rocket_turret: (g) => {
    tripod(g);
    poly(g, [[-0.5, -0.45], [0.45, -0.45], [0.8, -0.25], [0.45, -0.05], [-0.5, -0.05]], true);
  },
  // Brownout: a pulse spreading.
  emp: (g) => {
    ring(g, 0, 0, 0.12);
    for (const r of [0.42, 0.75]) for (const a of [0, Math.PI]) ring(g, 0, 0, r, a - Math.PI / 4, a + Math.PI / 4);
  },
  // Salve: a repair cross in its orb.
  orb: (g) => {
    ring(g, 0, 0, 0.72);
    poly(g, [[-0.35, 0], [0.35, 0]]);
    poly(g, [[0, -0.35], [0, 0.35]]);
  },
  // Shield dome: a dome over the ground.
  dome: (g) => {
    ring(g, 0, 0.4, 0.7, Math.PI, TAU);
    poly(g, [[-0.85, 0.4], [0.85, 0.4]]);
  },
  // Barrier: a wall of blocks.
  barrier: (g) => {
    poly(g, [[-0.75, -0.45], [0.75, -0.45], [0.75, 0.55], [-0.75, 0.55]], true);
    poly(g, [[-0.75, 0.05], [0.75, 0.05]]);
    for (const [x, y] of [[0, -0.45], [-0.375, 0.05], [0.375, 0.05]]) poly(g, [[x, y], [x, y + 0.5]]);
  },
};

/** The ability's dial: on (draining) while its spell lasts, else recharging toward ready. */
const abilityDial = (f) => ({
  id: f.abilityId, ready: f.ability >= 1, on: f.abilityActive, fill: f.abilityActive ? f.abilityOn : f.ability,
  wait: f.abilityLeft, charges: 0, max: 0, key: f.abilityActive ? 'ON' : 'F',
});

/** An item's dial: ready with a charge left, its ring the next charge coming back; a Limpet down is on. */
const itemDial = (it) => ({
  id: it.id, ready: it.charges > 0, on: it.armed, fill: it.charges < it.max ? it.recharge : 1,
  wait: it.wait, charges: it.charges, max: it.max, key: it.armed ? 'DET' : it.key,
});

/**
 * A round dial for the ability or an item (`abilityDial`, `itemDial`): its icon, lit when ready
 * and pulsing while on; a ring that fills as it recharges (full when ready, draining in blue while
 * on); the seconds left over the dimmed icon while there's nothing to use; the item's charges as
 * pips; and its key.
 */
function dialScreen(s, { id, ready, on, fill, wait, charges, max, key }, now) {
  const { g, canvas } = s, W = canvas.width, c = W / 2, r = W * 0.43;
  g.fillStyle = '#090d0b';
  g.fillRect(0, 0, W, W);
  const color = on ? FUEL : ready ? AMBER : DIM;
  g.lineWidth = 28;
  g.strokeStyle = FAINT;
  ring(g, c, c, r);
  g.strokeStyle = color;
  ring(g, c, c, r, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(fill));
  g.save();
  g.translate(c, c - 30);
  g.scale(105, 105);
  g.lineWidth = 0.13;
  g.lineJoin = g.lineCap = 'round';
  g.strokeStyle = on || ready ? color : AMBER;
  g.globalAlpha = on ? 0.7 + 0.3 * Math.sin(now / 110) : ready ? 1 : 0.25;
  ICONS[id]?.(g);
  g.restore();
  g.globalAlpha = 1;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (!ready && !on && wait > 0) {
    g.fillStyle = AMBER;
    g.font = font(140, 'bold');
    g.fillText(String(Math.ceil(wait)), c, c - 30);
  }
  for (let k = 0; k < max; k++) {
    g.fillStyle = k < charges ? AMBER : FAINT;
    g.beginPath();
    g.arc(c + (k - (max - 1) / 2) * 40, c + 108, 12, 0, TAU);
    g.fill();
  }
  g.fillStyle = color;
  g.font = font(58, 'bold');
  g.fillText(key, c, c + 160);
}

/** Jammed: bands of static across a screen. */
function jamStatic(s) {
  const { g, canvas } = s;
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `rgba(170,205,255,${Math.random() * 0.3})`;
    g.fillRect(0, Math.random() * canvas.height, canvas.width, 2 + Math.random() * 6);
  }
}
