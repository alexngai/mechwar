// The lobby's backdrop: a dim hangar where the three classes stand on pads, each under its own
// spotlight, while the camera circles them slowly, front to back and round again. Only for show:
// nothing in it reacts to the pointer, it holds still for reduced motion, and it stops drawing
// while the page is hidden (the browser pauses its frames).
import * as THREE from 'three';
import classes from '../classes.json';
import tuning from '../tuning.json';
import { NO_FX } from './hangar.js';
import { Mech } from './mech.js';

// Class, x, turn toward the middle: the outer two stand clear of the lobby's column on a wide window.
const BAYS = [['A', -14, 0.35], ['B', 0, 0], ['C', 14, -0.35]];
// Low enough that the orbit's frame takes in the lamps; the angle keeps the pool a pad wide.
const SPOT = { height: 11, angle: 0.5, intensity: 1150, color: 0xfff0d8 };
const ORBIT = { radius: 29, period: 90, height: 6.8 }; // m, s a turn, m
const SHADE = 0x07090b; // the dark the hangar falls off into
const CAN = new THREE.MeshStandardMaterial({ color: 0x2b2e32, roughness: 0.5, metalness: 0.6 });
const LENS = new THREE.MeshBasicMaterial({ color: new THREE.Color(SPOT.color).multiplyScalar(3) }); // past white, so it reads lit

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
  scene.fog = new THREE.Fog(SHADE, 40, 120);
  scene.add(new THREE.HemisphereLight(0x8a98a8, 0x14120f, 0.5));
  const fill = new THREE.DirectionalLight(0x9fc4e8, 1); // a faint cool fill from the camera's side
  scene.add(fill);

  // The hangar, all round the bays: a floor with hazard lines before each pad, ribbed end walls
  // under catwalks, side walls and roof trusses, all fading into the dark.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  for (const s of [-1, 1]) {
    scene.add(box(90, 20, 1, 0x1b1e22, 0, 10, s * 40));
    for (let x = -40; x <= 40; x += 5) scene.add(box(0.6, 20, 0.8, 0x15181b, x, 10, s * 39.2));
    scene.add(box(90, 0.4, 2.4, 0x23262a, 0, 8, s * 38.4));
    for (let x = -40; x <= 40; x += 2.5) scene.add(box(0.08, 1.1, 0.08, 0x3a3d40, x, 8.75, s * 37.3));
    scene.add(box(90, 0.08, 0.08, 0xc9a227, 0, 9.3, s * 37.3));
    scene.add(box(1, 20, 80, 0x181b1e, s * 44, 10, 0));
    for (let z = -35; z <= 35; z += 5) scene.add(box(0.8, 20, 0.6, 0x15181b, s * 43.2, 10, z));
  }
  for (let z = -32; z <= 32; z += 8) scene.add(box(88, 0.7, 0.5, 0x121416, 0, 17, z));

  // The bays: a pad, a hazard line, a mech and the spotlight over it, with a faint cone of light.
  const mechs = BAYS.map(([cls, x, turn]) => {
    scene.add(box(6.8, 0.2, 6.8, 0x24282e, x, 0.1, 0));
    scene.add(box(6.8, 0.02, 0.35, 0xc9a227, x, 0.21, 3.8));
    const spot = new THREE.SpotLight(SPOT.color, SPOT.intensity, 0, SPOT.angle, 0.55, 2);
    spot.position.set(x, SPOT.height, 0.5);
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
    // The can the lamp hangs in, on a rod down from the truss: its lens glowing at the lamp, the
    // body back up the axis.
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 1.2, 24), [CAN, CAN, LENS]);
    can.quaternion.copy(cone.quaternion);
    can.position.copy(spot.position).addScaledVector(axis, 0.6);
    const rod = 16.7 - SPOT.height - 1;
    scene.add(can, box(0.1, rod, 0.1, 0x2b2e32, x, SPOT.height + 1 + rod / 2, 0.25));
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
    // Round the bays from the front, a gentle rise and fall as it goes.
    const a = (t / ORBIT.period) * Math.PI * 2;
    camera.position.set(Math.sin(a) * ORBIT.radius, ORBIT.height + Math.sin(t * 0.21) * 0.4, Math.cos(a) * ORBIT.radius);
    camera.lookAt(0, 3, 0);
    fill.position.copy(camera.position);
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
