// First-person cockpit: an original curved canopy frame, the dash's instruments and the class's own
// weapons, kept in camera space and drawn in a second pass after the world with depth cleared, so
// none of it clips into walls. The dash carries the mech's state (hull and fuel, the radar scope,
// systems); the glass HUD (hud.js) keeps what's aimed and reacted with. The pass is lit like the
// world (sun direction, the map's palette), shades under cover, and flashes with the guns.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CLASSES, TEAMS } from './mech.js';
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
const TAU = Math.PI * 2;
// Instruments, w x h in meters at the canopy's depth: vitals (hull and fuel) left, the round radar
// scope in the middle, systems right.
const SCREENS = { vitals: [0.44, 0.24], radar: [0.34, 0.34], systems: [0.44, 0.24] };
const SCREEN_X = { vitals: -0.6, radar: 0, systems: 0.6 };
const RIM = 0.035, RIM_DEPTH = 0.07; // housing frame around each screen: bar width, how far it stands out
const POD_YAW = 0.3; // side pods turn this far toward the pilot
const SCOPE_TILT = 0.5; // the scope lies back further than the pods, to stay under the aim frame
const GLOW = { vitals: 0xffc46a, radar: 0xffc46a, systems: 0xffc46a }; // light each screen throws on its housing
const FLASH = 1.2, FLASH_LIFE = 0.06; // a shot's light on the cockpit: intensity, seconds
const INSTRUMENT_HZ = 20; // redraws per second
const AMBER = '#ffc46a', DIM = 'rgba(255,196,106,0.4)', FAINT = 'rgba(255,196,106,0.14)', WARN = '#ff4a3a', FUEL = '#7fd8ff', REPAIR = '#6dff9a';
const LAMP_OFF = 0x3a0b08;

const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

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
 * Slides gun `pod` (in `group`, camera space) outward, then up if that isn't enough, so none of it
 * hangs in front of the dash screens: what's below the line from the eye over the housings' tops
 * stays outside the screens' span.
 */
function clearDash(group, pod, fov) {
  const halfH = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * DEPTH;
  const tallest = SCREENS.vitals[1]; // the side pods: the scope sits between the guns
  const line = (-halfH * 0.75 + tallest + 2 * RIM + 0.03) / DEPTH, span = 0.95; // slopes per meter ahead
  const out = Math.sign(pod.position.x) || 1, scale = group.scale.x;
  let slide = 0, lift = 0;
  group.updateMatrixWorld(true);
  pod.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (v.z > -0.05 || v.y > line * -v.z) continue;
      slide = Math.max(slide, span * -v.z - out * v.x);
      lift = Math.max(lift, line * -v.z - v.y);
    }
  });
  if (slide <= 0.6) pod.position.x += (out * slide) / scale;
  else pod.position.y += lift / scale;
}

/**
 * Screen `s` set in its housing: recessed behind a frame that stands out RIM_DEPTH, on a back plate,
 * under a hood, with bolted corners and posts down to the dash. `lamp`, if given, is a warning
 * strip along the frame's top bar.
 */
function housing(s, lamp) {
  const g = new THREE.Group(), { w, h } = s, front = RIM_DEPTH - 0.01;
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), s.mat));
  g.add(box(w + 2 * RIM, h + 2 * RIM, 0.03, trimMat).translateZ(-0.025));
  for (const y of [-1, 1]) g.add(box(w + 2 * RIM, RIM, RIM_DEPTH, frameMat).translateY((y * (h + RIM)) / 2).translateZ(front / 2));
  for (const x of [-1, 1]) g.add(box(RIM, h, RIM_DEPTH, frameMat).translateX((x * (w + RIM)) / 2).translateZ(front / 2));
  const hood = box(w + 2 * RIM + 0.02, 0.012, 0.08, frameMat);
  hood.position.set(0, h / 2 + RIM, front + 0.02);
  hood.rotation.x = 0.3;
  g.add(hood);
  if (lamp) g.add(box(w * 0.9, 0.012, 0.01, lamp).translateY((h + RIM) / 2).translateZ(front + 0.005));
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) g.add(bolt((x * (w + RIM)) / 2, (y * (h + RIM)) / 2, front + 0.004));
    g.add(rod(new THREE.Vector3((x * w) / 3, -h / 2 - RIM, 0), new THREE.Vector3((x * w) / 3, -h / 2 - RIM - 0.05, -0.01), 0.011, boltMat));
  }
  return g;
}

/** The radar scope: a round screen in a deep, bolted bezel on a back plate, on posts to the dash. */
function scope(s) {
  const g = new THREE.Group(), r = s.w / 2, front = RIM_DEPTH - 0.01, facing = (mesh) => ((mesh.rotation.x = Math.PI / 2), mesh);
  g.add(new THREE.Mesh(new THREE.CircleGeometry(r, 48), s.mat));
  g.add(facing(new THREE.Mesh(new THREE.CylinderGeometry(r + RIM, r + RIM, 0.03, 40), trimMat)).translateY(-0.025));
  g.add(facing(new THREE.Mesh(new THREE.CylinderGeometry(r + RIM, r + RIM, front, 40, 1, true), frameMat)).translateY(front / 2));
  g.add(new THREE.Mesh(new THREE.RingGeometry(r, r + RIM, 40), frameMat).translateZ(front));
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * TAU;
    g.add(bolt(Math.cos(a) * (r + RIM / 2), Math.sin(a) * (r + RIM / 2), front + 0.004));
  }
  for (const x of [-1, 1]) g.add(rod(new THREE.Vector3((x * r) / 2, -r * 0.8, -0.02), new THREE.Vector3((x * r) / 2, -r - RIM - 0.06, -0.03), 0.011, boltMat));
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
    this.team = -1;
    this.weapons = null;
    this.next = 0;
    this.screens = Object.fromEntries(Object.entries(SCREENS).map(([name, size]) => [name, screen(size)]));
    this.lampMat = new THREE.MeshBasicMaterial({ color: LAMP_OFF });
    this.drawnAt = -Infinity;
    // Each screen's glow on the metal around it, so the dash reads as lit hardware.
    this.glows = Object.fromEntries(Object.entries(GLOW).map(([name, color]) => [name, new THREE.PointLight(color, 0.08, 0.7, 2)]));
    this.scene.add(...Object.values(this.glows));
    this.flash = new THREE.PointLight(0xffc27a, 0, 1.6, 2);
    this.flashLife = 0;
    this.scene.add(this.flash);
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
    const top = -halfH * 0.75, width = 2 * halfW + 0.6;
    // The canopy: a top bar with a curved brow under it, lit along its edge in the team's color;
    // ribs that rise from the dash, bow out along the view's edges and curve in to meet the brow;
    // thin glazing ribs across the upper corners; braces into the dash; a hydraulic ram per side.
    const curve = (points) => new THREE.CatmullRomCurve3(points.map(([x, y, dz]) => new THREE.Vector3(x, y, z + dz)));
    const tube = (points, r, mat) => new THREE.Mesh(new THREE.TubeGeometry(curve(points), 40, r, 6), mat);
    this.frame.add(box(2 * halfW + 1, 0.12, 0.3, frameMat).translateY(halfH + 0.015).translateZ(z));
    const brow = [[-halfW * 0.74, halfH - 0.03, 0.03], [-halfW * 0.3, halfH - 0.09, 0.05], [halfW * 0.3, halfH - 0.09, 0.05], [halfW * 0.74, halfH - 0.03, 0.03]];
    this.frame.add(tube(brow, 0.026, frameMat), tube(brow.map(([x, y, dz]) => [x, y - 0.028, dz + 0.014]), 0.005, this.accent));
    for (const side of [-1, 1]) {
      const rib = [[side * halfW * 0.98, -halfH * 0.62, -0.1], [side * halfW * 1.0, -halfH * 0.05, -0.03], [side * halfW * 0.95, halfH * 0.6, 0], [side * halfW * 0.74, halfH - 0.03, 0.03]];
      this.frame.add(tube(rib, 0.042, frameMat));
      this.frame.add(tube([[side * halfW * 0.42, halfH - 0.08, 0.05], [side * halfW * 0.74, halfH * 0.62, 0.0], [side * halfW * 0.95, halfH * 0.22, -0.02]], 0.012, trimMat));
      this.frame.add(tube([[side * halfW * 0.98, -halfH * 0.5, -0.08], [side * halfW * 0.9, top + 0.03, 0.02], [side * halfW * 0.72, top + 0.01, 0.12]], 0.028, frameMat));
      const path = curve(rib), at = (t) => path.getPoint(t).add(new THREE.Vector3(-side * 0.08, 0, 0.045));
      this.frame.add(rod(at(0.15), at(0.45), 0.024, cableMat), rod(at(0.4), at(0.72), 0.011, boltMat));
      for (const t of [0.15, 0.72]) this.frame.add(strut(at(t).add(new THREE.Vector3(side * 0.05, 0, -0.03)), at(t), 0.03, trimMat));
    }
    // The dash: a sloped console with a bolted rubber edge along the front, conduits clamped along
    // it, toggle banks between the screens, and the three screens in their housings, the side pods
    // turned toward the pilot.
    const dash = box(width, 0.5, 0.7, frameMat);
    dash.position.set(0, top - 0.25, z - 0.1);
    dash.rotation.x = 0.25;
    this.frame.add(dash);
    // The dash's top falls from top + 0.08 at its back to top - 0.09 at its front edge (z + 0.3).
    const surface = (zz) => top + 0.079 - (0.173 * (zz - (z - 0.377))) / 0.677;
    this.frame.add(box(width, 0.04, 0.06, trimMat).translateY(top).translateZ(z + 0.24));
    for (let x = -halfW; x <= halfW; x += 0.2) this.frame.add(bolt(x, top, z + 0.272));
    for (const [zz, r] of [[z + 0.07, 0.013], [z + 0.11, 0.009]]) {
      const y = surface(zz) + r;
      this.frame.add(rod(new THREE.Vector3(-width / 2, y, zz), new THREE.Vector3(width / 2, y, zz), r, cableMat));
      for (let x = -halfW + 0.1; x <= halfW; x += 0.35) this.frame.add(box(0.025, 2.6 * r, 0.03, boltMat).translateX(x).translateY(y).translateZ(zz));
    }
    for (const side of [-1, 1]) {
      const x = side * 0.32, y = surface(z - 0.02);
      this.frame.add(box(0.055, 0.012, 0.06, trimMat).translateX(x).translateY(y + 0.006).translateZ(z - 0.02));
      for (const dx of [-0.017, 0, 0.017]) {
        const lever = rod(new THREE.Vector3(x + dx, y + 0.012, z - 0.03), new THREE.Vector3(x + dx, y + 0.04, z - 0.015), 0.004, boltMat);
        this.frame.add(lever, box(0.008, 0.006, 0.008, pipMat).translateX(x + dx).translateY(y + 0.014).translateZ(z + 0.003));
      }
    }
    for (const [name, s] of Object.entries(this.screens)) {
      const x = SCREEN_X[name], round = name === 'radar';
      const pod = round ? scope(s) : housing(s, name === 'vitals' ? this.lampMat : null);
      pod.rotation.set(round ? -SCOPE_TILT : -0.2, -Math.sign(x) * POD_YAW, 0, 'YXZ'); // leaning back
      pod.position.set(x, top + (round ? (s.h / 2 + RIM) * Math.cos(SCOPE_TILT) : s.h / 2 + RIM) + 0.01, z - 0.04);
      this.frame.add(pod);
      pod.updateMatrixWorld();
      this.glows[name].position.set(0, 0, 0.14).applyMatrix4(pod.matrixWorld);
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
    systemsScreen(this.screens.systems, f);
    for (const s of Object.values(this.screens)) {
      if (f.jammed) jamStatic(s);
      s.map.needsUpdate = true;
    }
  }

  /**
   * The class's guns from its spec, painted with `mech`'s materials (so damage scorch and barrel
   * heat glow match), at the mech's `scale`, placed where they sit relative to an eye
   * `eyeHeight` above the feet.
   */
  setWeapons(cls, mech, eyeHeight, scale = 1) {
    if (this.weapons) {
      this.scene.remove(this.weapons.group);
      this.weapons.group.traverse((o) => o.geometry?.dispose());
    }
    const spec = CLASSES[cls], group = new THREE.Group();
    group.scale.setScalar(scale);
    group.position.y = spec.hipY * scale - eyeHeight;
    const guns = spec.guns.map((side) => {
      const pod = new THREE.Group();
      group.add(pod);
      const tip = spec.gun(pod, side, mech);
      clearDash(group, pod, this.camera.fov);
      return { pod, tip, rest: pod.position.clone(), kick: 0 };
    });
    this.scene.add(group);
    this.weapons = { group, guns };
    this.next = 0;
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

  /**
   * Kicks the next gun back (alternating like the mech's own) and returns its muzzle in world
   * space, given the world camera this cockpit rides with.
   */
  fire(worldCamera, out) {
    const guns = this.weapons.guns;
    const gun = guns[(this.next = (this.next + 1) % guns.length)];
    gun.kick = RECOIL;
    this.scene.updateMatrixWorld();
    gun.tip.getWorldPosition(out);
    this.flash.position.copy(out);
    this.flashLife = FLASH_LIFE;
    return worldCamera.localToWorld(out);
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
    for (const gun of this.weapons?.guns ?? []) {
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
 * Vitals: the fuel tube on the left (it drains with boost, hover and dodges; the tick is what a boost
 * needs), the hull number and bar, a red wash when hit, and lamps, or the repair cycle's state.
 */
function vitalsScreen(s, f) {
  const [g, W, H] = blank(s);
  if (f.hurt > 0) {
    g.fillStyle = `rgba(255,60,40,${0.3 * f.hurt})`;
    g.fillRect(0, 0, W, H);
  }
  const tx = 24, ty = 24, tw = 46, th = H - 48, fill = clamp01(f.fuel), short = f.fuel < f.boostMin;
  g.fillStyle = 'rgba(127,216,255,0.08)';
  g.fillRect(tx, ty, tw, th);
  g.fillStyle = short ? WARN : FUEL;
  g.fillRect(tx, ty + th * (1 - fill), tw, th * fill);
  g.strokeStyle = DIM;
  g.lineWidth = 3;
  g.strokeRect(tx, ty, tw, th);
  const tick = ty + th * (1 - f.boostMin);
  g.strokeStyle = AMBER;
  g.beginPath();
  g.moveTo(tx - 8, tick);
  g.lineTo(tx + tw + 8, tick);
  g.stroke();
  const low = f.health / f.healthMax < 0.3, color = low ? WARN : AMBER, mid = (96 + W) / 2;
  g.textAlign = 'center';
  g.fillStyle = DIM;
  g.font = font(28);
  g.fillText(`HULL · ${f.className.toUpperCase()}`, mid, 18);
  g.fillStyle = color;
  g.font = font(104, 'bold');
  g.fillText(String(Math.ceil(f.health)), mid, 48);
  bar(g, 96, 158, W - 120, 18, f.health / f.healthMax, color);
  const status = f.standing ? 'RESTARTING' : f.repair >= 1 ? 'REPAIRING' : f.repair > 0 ? 'SHUTTING DOWN' : '';
  if (status) {
    g.fillStyle = REPAIR;
    g.font = font(34, 'bold');
    g.fillText(status, mid, H - 66);
    return;
  }
  g.textAlign = 'left';
  [['DODGE', f.dodge >= 1, AMBER], ['BOOST', f.boosting, FUEL], ['JAM', f.jammed, WARN]].forEach(([name, on, lit], i) => {
    const x = 100 + i * 136, y = H - 66;
    g.fillStyle = on ? lit : FAINT;
    g.beginPath();
    g.arc(x + 11, y + 15, 10, 0, TAU);
    g.fill();
    g.fillStyle = on ? lit : DIM;
    g.font = font(28);
    g.fillText(name, x + 28, y);
  });
}

/** Radar: the glass's radar (hud.js), drawn large for the round scope. */
function radarScreen(s, f) {
  const { g, canvas } = s, W = canvas.width;
  g.fillStyle = '#090d0b';
  g.fillRect(0, 0, W, W);
  radar(g, W / 2, W / 2, W * 0.42, W / 210, f, f.radarMap);
}

/** Systems: the ability's charge, each item's charges and recharge, and repair. */
function systemsScreen(s, f) {
  const [g, W] = blank(s);
  const label = (y, name, key, lit, color = AMBER) => {
    g.fillStyle = lit ? color : DIM;
    g.font = font(32);
    g.textAlign = 'left';
    g.fillText(name.toUpperCase(), 26, y);
    g.textAlign = 'right';
    g.fillText(key, W - 26, y);
  };
  const ready = f.ability >= 1 || f.abilityActive;
  label(18, f.abilityName, f.abilityActive ? 'ON' : f.ability >= 1 ? 'F' : '', ready);
  bar(g, 26, 56, W - 52, 10, f.abilityActive ? 1 : f.ability, ready ? AMBER : DIM);
  f.items.forEach((it, i) => {
    const y = 82 + i * 64;
    label(y, it.name, it.key, it.charges > 0);
    for (let k = 0; k < it.max; k++) {
      g.fillStyle = k < it.charges ? AMBER : FAINT;
      g.fillRect(26 + k * 52, y + 38, 44, 12);
    }
    if (it.charges < it.max) bar(g, 26 + it.max * 52 + 12, y + 41, W - 64 - it.max * 52, 6, it.recharge, DIM);
  });
  const repairing = f.repair > 0 || f.standing;
  label(214, 'Repair', f.repair >= 1 ? 'ON' : repairing ? '…' : 'R', true, repairing ? REPAIR : AMBER);
}

/** Jammed: bands of static across a screen. */
function jamStatic(s) {
  const { g, canvas } = s;
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `rgba(170,205,255,${Math.random() * 0.3})`;
    g.fillRect(0, Math.random() * canvas.height, canvas.width, 2 + Math.random() * 6);
  }
}
