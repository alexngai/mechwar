import * as THREE from 'three';
import GUI from 'lil-gui';
import init, { WasmSim, arena, tick_dt } from '../sim/pkg/sim.js';
import tuning from '../tuning.json';

await init();
const sim = new WasmSim(JSON.stringify(tuning));
const DT = tick_dt();
const T = (name) => tuning[name].value;

// Index layout of WasmSim.state(); keep in sync with sim/src/wasm.rs.
const S = { POS: 0, VEL: 3, FUEL: 6, HEAT: 7, OVERHEATED: 8, GROUNDED: 9, BOOSTING: 10, HOVERING: 11, DODGE_CD: 12, SHOT: 13, AIM: 14 };

// --- Scene ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa3b0);
scene.fog = new THREE.Fog(0x8fa3b0, 60, 180);
scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x4a4238, 1.6));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
sun.position.set(30, 60, 20);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(T('fov'), 1, 0.1, 500);
camera.rotation.order = 'YXZ';

const box = (w, h, d, color, emissive = 0) =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, emissive, flatShading: true }));

// Arena geometry comes from the sim so collision and visuals share one source.
const blocks = arena();
for (let i = 0; i < blocks.length; i += 7) {
  const [cx, cy, cz, hx, hy, hz, tilt] = blocks.subarray(i, i + 7);
  const m = box(hx * 2, hy * 2, hz * 2, i === 0 ? 0x6b6f63 : 0xb8b2a0);
  m.position.set(cx, cy, cz);
  m.rotation.x = tilt;
  scene.add(m);
}
const grid = new THREE.GridHelper(100, 50, 0x3d4038, 0x55594e);
grid.position.y = 0.01;
scene.add(grid);

// Placeholder B-class mech, feet at origin, facing -Z, 5 m tall at scale 1.
const mech = new THREE.Group();
const hull = 0x8a8f5c, trim = 0x3b3f33;
for (const x of [-0.8, 0.8]) {
  const leg = box(0.7, 2.6, 0.9, trim);
  leg.position.set(x, 1.3, 0);
  const foot = box(1.0, 0.3, 1.5, trim);
  foot.position.set(x, 0.15, -0.2);
  mech.add(leg, foot);
}
const torso = box(2.8, 1.6, 2.4, hull);
torso.position.y = 3.6;
const canopy = box(1.4, 0.6, 0.6, 0x223040, 0x1a3a50);
canopy.position.set(0, 4.0, -1.3);
const thruster = box(1.2, 0.8, 0.3, 0xffa040, 0xff7a20);
thruster.position.set(0, 3.4, 1.35);
const arms = new THREE.Group();
arms.position.y = 3.6;
const gunTip = new THREE.Object3D();
for (const x of [-1.8, 1.8]) {
  const gun = box(0.5, 0.5, 2.4, trim);
  gun.position.set(x, 0, -0.7);
  arms.add(gun);
}
gunTip.position.set(1.8, 0, -1.9);
arms.add(gunTip);
mech.add(torso, canopy, thruster, arms);
scene.add(mech);

const tracer = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xfff0a0 }));
const impact = box(0.5, 0.5, 0.5, 0xfff0a0, 0xffd060);
tracer.frustumCulled = false; // setFromPoints doesn't refresh the bounding sphere
scene.add(tracer, impact);
let flashUntil = 0;

// --- Input ---------------------------------------------------------------
const keys = new Set();
let yaw = 0, pitch = 0, dodge = 0, firing = false, cockpit = false;
const locked = () => document.pointerLockElement === renderer.domElement;
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  document.body.classList.toggle('locked', locked());
  if (!locked()) firing = false;
});
addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const limit = THREE.MathUtils.degToRad(T('pitch_limit_deg'));
  yaw -= e.movementX * T('mouse_sensitivity');
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * T('mouse_sensitivity'), -limit, limit);
});
addEventListener('mousedown', (e) => { if (locked() && e.button === 0) firing = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyQ') dodge = -1;
  if (e.code === 'KeyE') dodge = 1;
  if (e.code === 'KeyR') { sim.reset(); prev = curr = sim.state(); }
  if (e.code === 'KeyV') cockpit = !cockpit;
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });
const axis = (pos, neg) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);

// --- Tuning panel ----------------------------------------------------------
const gui = new GUI({ title: 'Tuning (tuning.json)' });
const folders = {};
const push = () => sim.set_tuning(JSON.stringify(tuning));
for (const [name, p] of Object.entries(tuning)) {
  folders[p.group] ??= gui.addFolder(p.group).close();
  folders[p.group].add(p, 'value', p.min, p.max, p.step).name(`${name} (${p.unit})`).onChange(push);
}
folders.move.open();
gui.add({ copy: () => navigator.clipboard.writeText(JSON.stringify(tuning, null, 2) + '\n') }, 'copy').name('Copy tuning.json');

// --- HUD -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const hud = { status: $('status'), fuel: $('fuel'), heat: $('heat'), dodge: $('dodge'), crosshair: $('crosshair') };

// --- Fixed-step sim, interpolated render ----------------------------------
let prev = sim.state(), curr = prev, acc = 0, last = performance.now();
const eye = new THREE.Vector3(), offset = new THREE.Vector3(), aim = new THREE.Vector3();

function frame(now) {
  acc += Math.min((now - last) / 1000, 0.25);
  last = now;
  while (acc >= DT) {
    sim.step(axis('KeyD', 'KeyA'), axis('KeyW', 'KeyS'), yaw, pitch,
      keys.has('ShiftLeft') || keys.has('ShiftRight'), keys.has('Space'), dodge, firing);
    dodge = 0;
    prev = curr;
    curr = sim.state();
    acc -= DT;
    if (curr[S.SHOT]) {
      impact.position.set(curr[S.AIM], curr[S.AIM + 1], curr[S.AIM + 2]);
      flashUntil = now + 60;
    }
  }
  const a = acc / DT;
  const lerp = (i) => prev[i] + (curr[i] - prev[i]) * a;

  const scale = T('mech_height') / 5;
  mech.position.set(lerp(S.POS), lerp(S.POS + 1), lerp(S.POS + 2));
  mech.scale.setScalar(scale);
  mech.rotation.y = yaw;
  arms.rotation.x = pitch;
  mech.visible = !cockpit;
  thruster.visible = !!(curr[S.BOOSTING] || curr[S.HOVERING]);
  tracer.visible = impact.visible = now < flashUntil;

  // Look is applied at render rate for responsiveness; position is interpolated.
  eye.copy(mech.position).y += T('eye_height');
  camera.rotation.set(pitch, yaw, 0);
  camera.position.copy(eye);
  if (!cockpit) camera.position.add(offset.set(0, T('chase_height'), T('chase_distance')).applyQuaternion(camera.quaternion));
  if (camera.fov !== T('fov')) { camera.fov = T('fov'); camera.updateProjectionMatrix(); }
  scene.updateMatrixWorld();
  if (tracer.visible) tracer.geometry.setFromPoints([gunTip.getWorldPosition(new THREE.Vector3()), impact.position]);

  // Crosshair marks where the eye ray lands, so chase-cam parallax stays honest.
  aim.set(curr[S.AIM], curr[S.AIM + 1], curr[S.AIM + 2]).project(camera);
  hud.crosshair.style.left = `${(aim.x + 1) * 50}%`;
  hud.crosshair.style.top = `${(1 - aim.y) * 50}%`;

  const speed = Math.hypot(curr[S.VEL], curr[S.VEL + 2]);
  const flags = [curr[S.BOOSTING] && 'BOOST', curr[S.HOVERING] && 'HOVER', !curr[S.GROUNDED] && 'AIR', curr[S.OVERHEATED] && 'OVERHEAT'].filter(Boolean);
  hud.status.textContent = `${speed.toFixed(1)} m/s  y ${curr[S.POS + 1].toFixed(1)}  ${flags.join(' ')}`;
  hud.fuel.style.width = `${(100 * curr[S.FUEL]) / T('fuel_max')}%`;
  hud.heat.style.width = `${(100 * curr[S.HEAT]) / T('heat_max')}%`;
  hud.heat.classList.toggle('over', !!curr[S.OVERHEATED]);
  hud.dodge.style.width = `${100 * (1 - curr[S.DODGE_CD] / Math.max(T('dodge_cooldown'), 1e-6))}%`;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
