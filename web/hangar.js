// The hangar's turntable: the shown bay's mech on a pad under its own lights, drawn by its own
// renderer (made the first time the hangar opens), turning slowly; drag it to turn it yourself.
import * as THREE from 'three';
import { Mech } from './mech.js';

/** Stands in for the effects the preview mech would spawn: it never fires, dashes or burns. */
const NO_FX = new Proxy({}, { get: () => () => {} });
const SPIN = 0.3; // rad/s
const ZERO = new THREE.Vector3();

export class Preview {
  constructor(canvas) {
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
    this.mech = null;
    this.shown = '';
    this.yaw = 0.7;
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
    // Frame the whole mech, a little from above.
    this.camera.position.set(0, height * 0.8, height * 3.1);
    this.camera.lookAt(0, height * 0.48, 0);
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
