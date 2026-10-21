// First-person cockpit: an original canopy frame and the class's own weapons, kept in camera space
// and drawn in a second pass after the world with depth cleared, so neither clips into walls.
import * as THREE from 'three';
import { CLASSES, TEAMS } from './mech.js';

const frameMat = new THREE.MeshLambertMaterial({ color: 0x5a5f66, flatShading: true });
const trimMat = new THREE.MeshLambertMaterial({ color: 0x1b1d20, flatShading: true });
const screenMat = new THREE.MeshBasicMaterial({ color: 0x15201c });
const UP = new THREE.Vector3(0, 1, 0);
const v = new THREE.Vector3(), q = new THREE.Quaternion();
const DEPTH = 1; // canopy pillars sit this far ahead of the eye
const RECOIL = 0.12; // m
const RECOIL_RECOVER = 10; // 1/s

const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

/** A box stretched from a to b (built along Y), `t` thick. */
function strut(a, b, t, mat) {
  const mesh = box(t, a.distanceTo(b), t, mat);
  mesh.position.lerpVectors(a, b, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, v.subVectors(b, a).normalize());
  return mesh;
}

export class Cockpit {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.05, 50);
    this.scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x4a4238, 1.1));
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.6);
    this.scene.add(this.sun, this.sun.target);
    this.accent = new THREE.MeshBasicMaterial({ color: TEAMS[-1].accent });
    this.frame = new THREE.Group();
    this.scene.add(this.frame);
    this.aspect = 0;
    this.team = -1;
    this.weapons = null;
    this.next = 0;
  }

  /** Rebuilds the canopy to span the view at `aspect`; pillars stay just inside the screen edges. */
  layout(aspect) {
    // A hidden page can report a zero-height view; keep the last layout until it's real.
    if (aspect === this.aspect || !(aspect > 0 && Number.isFinite(aspect))) return;
    this.aspect = aspect;
    for (const o of [...this.frame.children]) {
      o.geometry.dispose();
      this.frame.remove(o);
    }
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * DEPTH;
    const halfW = halfH * aspect;
    const z = -DEPTH;
    // Top bar with an accent strip under it, raked pillars, a dash console with three screens.
    this.frame.add(box(2 * halfW + 1, 0.12, 0.3, frameMat).translateY(halfH + 0.015).translateZ(z));
    this.frame.add(box(2 * halfW + 1, 0.012, 0.02, this.accent).translateY(halfH - 0.05).translateZ(z + 0.16));
    for (const side of [-1, 1]) {
      const top = new THREE.Vector3(side * halfW * 0.86, halfH + 0.05, z);
      const bottom = new THREE.Vector3(side * halfW * 1.02, -halfH * 0.6, z - 0.1);
      this.frame.add(strut(top, bottom, 0.07, frameMat));
    }
    const dash = box(2 * halfW + 0.6, 0.5, 0.7, frameMat);
    dash.position.set(0, -halfH * 0.75 - 0.25, z - 0.1);
    dash.rotation.x = 0.25;
    this.frame.add(dash);
    this.frame.add(box(2 * halfW + 0.6, 0.04, 0.06, trimMat).translateY(-halfH * 0.75).translateZ(z + 0.24));
    for (const x of [-0.42, 0, 0.42]) {
      const screen = box(0.32, 0.005, 0.2, screenMat);
      screen.position.set(x * halfW * 1.4, -halfH * 0.75 + 0.01, z - 0.02);
      screen.rotation.x = 0.25;
      this.frame.add(screen);
    }
  }

  /**
   * The class's guns from its spec, painted with `mech`'s materials (so damage scorch and barrel
   * heat glow match), placed where they sit relative to an eye `eyeHeight` above the feet.
   */
  setWeapons(cls, mech, eyeHeight) {
    if (this.weapons) {
      this.scene.remove(this.weapons.group);
      this.weapons.group.traverse((o) => o.geometry?.dispose());
    }
    const spec = CLASSES[cls], group = new THREE.Group();
    group.position.y = spec.hipY - eyeHeight;
    const guns = spec.guns.map((side) => {
      const pod = new THREE.Group();
      group.add(pod);
      const tip = spec.gun(pod, side, mech);
      return { pod, tip, rest: pod.position.clone(), kick: 0 };
    });
    this.scene.add(group);
    this.weapons = { group, guns };
    this.next = 0;
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
    return worldCamera.localToWorld(gun.tip.getWorldPosition(out));
  }

  /**
   * Follows the world camera's aspect and the sun, and eases recoil back. `fov` is the base field
   * of view: the canopy ignores the boost kick so it doesn't rebuild while it eases.
   */
  update(dt, worldCamera, sunDir, fov) {
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
    for (const gun of this.weapons?.guns ?? []) {
      gun.kick *= Math.exp(-RECOIL_RECOVER * dt);
      gun.pod.position.copy(gun.rest).z += gun.kick;
    }
  }
}
