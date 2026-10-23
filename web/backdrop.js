// The lobby's backdrop: a dim hangar where the three classes stand on pads, each under its own
// spotlight, while the camera drifts slowly back and forth along them. Only for show: nothing in
// it reacts to the pointer, it holds still for reduced motion, and it stops drawing while the page
// is hidden (the browser pauses its frames).
import * as THREE from 'three';
import classes from '../classes.json';
import tuning from '../tuning.json';
import { NO_FX } from './hangar.js';
import { Mech } from './mech.js';

// Class, x, turn toward the middle: the outer two stand clear of the lobby's column on a wide window.
const BAYS = [['A', -14, 0.35], ['B', 0, 0], ['C', 14, -0.35]];
const SPOT = { height: 16, angle: 0.36, intensity: 2400, color: 0xfff0d8 };
const PAN = { radius: 29, swing: 0.25, period: 50, height: 6.8 }; // m, rad, s, m
const SHADE = 0x07090b; // the dark the hangar falls off into

const box = (w, h, d, color, x, y, z) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  return mesh;
};

/** Fills a fixed full-window canvas behind the lobby with the hangar and starts it turning. */
export function backdrop() {
  const canvas = document.createElement('canvas');
  canvas.id = 'backdrop';
  document.body.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SHADE);
  scene.fog = new THREE.Fog(SHADE, 28, 70);
  scene.add(new THREE.HemisphereLight(0x8a98a8, 0x14120f, 0.5));
  const fill = new THREE.DirectionalLight(0x9fc4e8, 1); // a faint cool fill from the camera's side
  fill.position.set(0, 6, 20);
  scene.add(fill);

  // The hangar: a floor with hazard lines before each pad, a ribbed back wall under a catwalk,
  // side walls and roof trusses fading into the dark.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 70), new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  scene.add(box(90, 20, 1, 0x1b1e22, 0, 10, -12));
  for (let x = -40; x <= 40; x += 5) scene.add(box(0.6, 20, 0.8, 0x15181b, x, 10, -11.2));
  scene.add(box(90, 0.4, 2.4, 0x23262a, 0, 8, -10.4));
  for (let x = -40; x <= 40; x += 2.5) scene.add(box(0.08, 1.1, 0.08, 0x3a3d40, x, 8.75, -9.3));
  scene.add(box(90, 0.08, 0.08, 0xc9a227, 0, 9.3, -9.3));
  for (const x of [-34, 34]) scene.add(box(1, 20, 70, 0x181b1e, x, 10, 10));
  for (let z = -8; z <= 24; z += 8) scene.add(box(70, 0.7, 0.5, 0x121416, 0, 17, z));

  // The bays: a pad, a hazard line, a mech and the spotlight over it, with a faint cone of light.
  const mechs = BAYS.map(([cls, x, turn]) => {
    scene.add(box(6.8, 0.2, 6.8, 0x24282e, x, 0.1, 0));
    scene.add(box(6.8, 0.02, 0.35, 0xc9a227, x, 0.21, 3.8));
    const spot = new THREE.SpotLight(SPOT.color, SPOT.intensity, 0, SPOT.angle, 0.55, 2);
    spot.position.set(x, SPOT.height, 2);
    spot.target.position.set(x, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    scene.add(spot, spot.target);
    // The cone's apex at the lamp, its axis down to where the lamp points.
    const axis = new THREE.Vector3().subVectors(spot.position, spot.target.position), reach = axis.length();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(reach * Math.tan(SPOT.angle), reach, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: SPOT.color, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    cone.position.copy(spot.target.position).addScaledVector(axis, 0.5);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    scene.add(cone);
    const mech = new Mech(scene, NO_FX, cls);
    mech.root.traverse((o) => { o.castShadow = o.receiveShadow = true; });
    const height = classes[cls].overrides?.mech_height ?? tuning.mech_height.value;
    return { mech, pos: new THREE.Vector3(x, 0.2, 0), yaw: Math.PI + turn, scale: height / mech.height };
  });

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const zero = new THREE.Vector3();
  let last = performance.now(), t = 0;
  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!still) t += dt;
    const w = innerWidth, h = innerHeight, ratio = Math.min(devicePixelRatio, 1.5);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const a = Math.sin((t / PAN.period) * Math.PI * 2) * PAN.swing;
    camera.position.set(Math.sin(a) * PAN.radius, PAN.height + Math.sin(t * 0.21) * 0.4, Math.cos(a) * PAN.radius);
    camera.lookAt(Math.sin(a) * 5, 3, 0);
    for (const { mech, pos, yaw, scale } of mechs) {
      mech.update(dt, {
        pos, yaw, pitch: 0, scale, vel: zero, grounded: true, boosting: false, hovering: false, health: 1, ability: false, damage: 0, repair: 0,
      });
    }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
