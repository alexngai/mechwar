// The hangar's turntable: the shown bay's mech on a pad under its own lights, drawn by its own
// renderer (made the first time the hangar opens), turning slowly; drag it to turn it yourself.
import * as THREE from 'three';
import { Mech, mountWeapon } from './mech.js';

/** Stands in for the effects the preview mech would spawn: it never fires, dashes or burns. */
export const NO_FX = new Proxy({}, { get: () => () => {} });
const SPIN = 0.3; // rad/s
const ZERO = new THREE.Vector3();

export class Preview {
  /** The camera frames a mech `frame` m tall (the tallest class), so every class shows at its true size. */
  constructor(canvas, frame) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x2a2622, 1.8));
    const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
    key.position.set(5, 9, 7);
    const rim = new THREE.DirectionalLight(0x7fe0ff, 1.2);
    rim.position.set(-6, 4, -6);
    this.scene.add(key, rim);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.6, 0.14, 48), new THREE.MeshLambertMaterial({ color: 0x2b3038 }));
    pad.position.y = -0.07;
    this.scene.add(pad);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    // The whole tallest mech, a little from above.
    this.camera.position.set(0, frame * 0.8, frame * 3.1);
    this.camera.lookAt(0, frame * 0.48, 0);
    this.mech = null;
    this.shown = '';
    this.yaw = Math.PI - 0.6; // its front, three-quarters
    this.height = 5;
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      drag = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag === null) return;
      this.yaw += (e.clientX - drag) * 0.012;
      drag = e.clientX;
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    this.dragging = () => drag !== null;
  }

  /** Puts class `cls` ('A' to 'C') carrying `loadout` on the pad, standing `height` m tall. */
  show(cls, loadout, height) {
    const shown = `${cls}:${loadout.primary}:${loadout.secondary}`;
    if (shown === this.shown) return;
    this.shown = shown;
    this.mech?.dispose();
    this.mech = new Mech(this.scene, NO_FX, cls, loadout);
    this.height = height;
  }

  /** One frame, painted in `team`'s colors (-1 for none yet). */
  render(dt, team) {
    const { canvas } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!this.mech || !w || !h) return;
    this.renderer ??= new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    const ratio = Math.min(devicePixelRatio, 2);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (!this.dragging()) this.yaw += SPIN * dt;
    this.mech.setTeam(team);
    this.mech.update(dt, {
      pos: ZERO, yaw: this.yaw, pitch: 0, scale: this.height / this.mech.height, vel: ZERO,
      grounded: true, boosting: false, hovering: false, health: 1, ability: false, damage: 0, repair: 0,
    });
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Side profiles of the weapons with ids `ids` for the hangar's cards, as image URLs by id: each
 * model alone, muzzle to the right and a little toward us, under the turntable's lights, drawn
 * `w` by `h` px by a renderer made for it and thrown away.
 */
export function weaponThumbs(ids, w = 192, h = 96) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x2a2622, 2.2));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(4, 6, -2);
  scene.add(key);
  // Neutral paint: what a mech's own materials would be before its team colors.
  const lambert = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const m = { pods: lambert(0x7d8691), trim: lambert(0x3a3e44), barrels: lambert(0x2a2c30), hazard: lambert(0xc9a227), accent: new THREE.MeshBasicMaterial({ color: 0x7fe0ff }) };
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const view = new THREE.Vector3(1, 0.3, -0.35).normalize(), box = new THREE.Box3(), mid = new THREE.Vector3(), corner = new THREE.Vector3();
  const out = new Map();
  for (const id of ids) {
    const pod = new THREE.Group();
    scene.add(pod);
    mountWeapon(pod, 'B', 1, id, m);
    pod.updateMatrixWorld(true);
    box.setFromObject(pod).getCenter(mid);
    camera.position.copy(mid).addScaledVector(view, 20);
    camera.lookAt(mid);
    camera.updateMatrixWorld();
    // Frame the model's box as the camera sees it, padded, at the image's aspect.
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      corner.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z).applyMatrix4(camera.matrixWorldInverse);
      [x0, x1, y0, y1] = [Math.min(x0, corner.x), Math.max(x1, corner.x), Math.min(y0, corner.y), Math.max(y1, corner.y)];
    }
    const half = Math.max((x1 - x0) / 2, ((y1 - y0) / 2) * (w / h)) * 1.12, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    Object.assign(camera, { left: cx - half, right: cx + half, top: cy + half * (h / w), bottom: cy - half * (h / w) });
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    out.set(id, renderer.domElement.toDataURL());
    scene.remove(pod);
  }
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
