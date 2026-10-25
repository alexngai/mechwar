// The lobby's backdrop: a working hangar where the three classes stand raised on scissor lifts,
// each under its own spotlight and hooked up to service lines, among tool chests, carts, racks and
// a bridge crane, while the camera circles them slowly, front to back and round again. Only for
// show: nothing in it reacts to the pointer, it holds still for reduced motion, and it stops
// drawing while the page is hidden (the browser pauses its frames).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import classes from '../classes.json';
import tuning from '../tuning.json';
import { NO_FX } from './hangar.js';
import { Mech } from './mech.js';

// Class, x, turn toward the middle: the outer two stand clear of the lobby's column on a wide window.
const BAYS = [['A', -14, 0.35], ['B', 0, 0], ['C', 14, -0.35]];
const LIFT = 2.6; // how high the lifts hold the mechs, m
// High enough to clear the heavy on its lift, low enough that the orbit's frame takes in the lamps.
const SPOT = { height: 13, angle: 0.5, intensity: 950, color: 0xfff0d8 };
const ORBIT = { radius: 29, period: 90, height: 7.4, look: 4.4 }; // m, s a turn, m, m
const SHADE = 0x07090b; // the dark the hangar falls off into
const CAN = new THREE.MeshStandardMaterial({ color: 0x2b2e32, roughness: 0.5, metalness: 0.6 });
const LENS = new THREE.MeshBasicMaterial({ color: new THREE.Color(SPOT.color).multiplyScalar(3) }); // past white, so it reads lit
const STEEL = 0x2b2f35, DARK = 0x17191c, PAINT = 0xa8861f, SAFETY = 0xc9a227;
// Below the decks everything keeps to dull tones, so the mechs stand out.
const ARM = 0x45484c, RAIL = 0x6a6e73, HOSE = 0x3a3d40, LINE = 0x5a5236, RED = 0x553230, RUST = 0x5a4634, OLIVE = 0x3a4036, NAVY = 0x2e3946, WOOD = 0x4e4232;
const CHROME = new THREE.MeshStandardMaterial({ color: 0xb8bec4, roughness: 0.3, metalness: 0.9 });
const SCREEN = new THREE.MeshBasicMaterial({ color: 0x23708a });
const GO = new THREE.MeshBasicMaterial({ color: 0x2a8a50 });
const STOP = new THREE.MeshBasicMaterial({ color: 0x8a3420 });
const BEACON = new THREE.MeshBasicMaterial({ color: 0xffa21a }); // blinks, see `frame`
const AMBER = new THREE.Color(0xffa21a);

const mats = new Map();
/** One material a color, shared, so the merge in `backdrop` makes one mesh of each. */
const paint = (color) => {
  if (color.isMaterial) return color;
  if (!mats.has(color)) mats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  return mats.get(color);
};
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = v(0, 1, 0);

const box = (w, h, d, color, x, y, z) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), paint(color));
  mesh.position.set(x, y, z);
  return mesh;
};
/** A round bar of radius `r` from `a` to `b`: a pin, a ram, a leg, a wheel, a drum. */
const rod = (a, b, r, color) => {
  const axis = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, axis.length(), 14), paint(color));
  mesh.position.copy(a).addScaledVector(axis, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, axis.normalize());
  return mesh;
};
/** A flat bar `w` wide and `h` deep from `a` to `b`: an arm, a rail. */
const bar = (a, b, w, h, color) => {
  const mesh = box(w, h, a.distanceTo(b), color, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  mesh.lookAt(b);
  return mesh;
};
/** A hose of radius `r` through `points`. */
const hose = (points, r, color) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), points.length * 6, r, 8), paint(color));
/** Points from `a` to `b`, hanging `drop` m low in the middle. */
const hang = (a, b, drop, n = 10) => Array.from({ length: n + 1 }, (_, i) => a.clone().lerp(b, i / n).addScaledVector(UP, -4 * drop * (i / n) * (1 - i / n)));
/** A hose coiled `turns` times, `r` across, lying at (x, y, z). */
const coil = (r, turns, color, x, y, z) => Array.from({ length: turns }, (_, i) => {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r - i * 0.03, 0.05, 6, 28), paint(color));
  ring.position.set(x, y + 0.05 + i * 0.09, z);
  ring.rotation.x = Math.PI / 2;
  return ring;
});
const group = (...parts) => new THREE.Group().add(...parts);

/** A scissor lift: a base on the floor, two stages of arms a side pushed up by a pair of rams, and
 * a deck LIFT m up, railed round its back and sides, with beacons on the base's front corners. */
function lift() {
  const lo = 0.4, hi = LIFT - 0.36, span = 4.4, stage = (hi - lo) / 2, ram = lo + stage * 1.5;
  const g = group(
    box(5.6, lo, 5.8, STEEL, 0, lo / 2, 0),
    box(6.8, 0.36, 6.8, 0x24282e, 0, LIFT - 0.18, 0),
    rod(v(-2.4, ram, 0), v(2.4, ram, 0), 0.08, STEEL),
  );
  for (const s of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const y0 = lo + k * stage, y1 = y0 + stage;
      g.add(
        bar(v(s * 2.25, y0, -span / 2), v(s * 2.25, y1, span / 2), 0.14, 0.26, ARM),
        bar(v(s * 2.55, y0, span / 2), v(s * 2.55, y1, -span / 2), 0.14, 0.26, ARM),
        rod(v(s * 2.1, y0 + stage / 2, 0), v(s * 2.7, y0 + stage / 2, 0), 0.09, DARK),
      );
    }
    for (let k = 0; k <= 2; k++) for (const z of [-span / 2, span / 2]) g.add(rod(v(s * 2.1, lo + k * stage, z), v(s * 2.7, lo + k * stage, z), 0.08, DARK));
    g.add(rod(v(s * 2.6, lo, 2.7), v(s * 2.6, lo + 0.08, 2.7), 0.12, DARK), rod(v(s * 2.6, lo + 0.08, 2.7), v(s * 2.6, lo + 0.26, 2.7), 0.09, BEACON));
  }
  for (const x of [-0.8, 0.8]) {
    const a = v(x, lo + 0.1, -1.9), b = v(x, ram, 0), m = a.clone().lerp(b, 0.6);
    g.add(rod(a, m, 0.13, DARK), rod(m, b, 0.06, CHROME));
  }
  for (const [x0, z0, x1, z1] of [[-3.3, -3.3, 3.3, -3.3], [-3.3, -3.3, -3.3, 1.6], [3.3, -3.3, 3.3, 1.6]]) {
    for (const y of [0.55, 1.05]) g.add(bar(v(x0, LIFT + y, z0), v(x1, LIFT + y, z1), 0.05, 0.05, RAIL));
    const n = Math.round(Math.hypot(x1 - x0, z1 - z0) / 1.6);
    for (let i = 0; i <= n; i++) g.add(box(0.06, 1.05, 0.06, RAIL, x0 + ((x1 - x0) * i) / n, LIFT + 0.525, z0 + ((z1 - z0) * i) / n));
  }
  return g;
}

/** A rolling tool chest: five drawers on casters, a top box shut over them. */
function chest(color) {
  const g = group(
    box(1.3, 0.95, 0.62, color, 0, 0.6, 0), box(1.32, 0.04, 0.64, DARK, 0, 1.095, 0),
    box(1.26, 0.42, 0.58, color, 0, 1.325, 0), box(1.27, 0.02, 0.59, DARK, 0, 1.42, 0),
    box(0.5, 0.025, 0.04, CHROME, 0, 1.36, 0.3), rod(v(0.7, 0.95, -0.2), v(0.7, 0.95, 0.2), 0.02, CHROME),
  );
  for (let i = 0; i < 5; i++) g.add(box(1.22, 0.012, 0.01, DARK, 0, 0.15 + i * 0.18, 0.315), box(0.8, 0.025, 0.04, CHROME, 0, 0.28 + i * 0.18, 0.33));
  for (const x of [-0.55, 0.55]) for (const z of [-0.24, 0.24]) g.add(rod(v(x, 0.06, z - 0.03), v(x, 0.06, z + 0.03), 0.06, DARK));
  return g;
}

/** A portable toolbox, handle up. */
const toolbox = (color) => group(
  box(0.56, 0.24, 0.26, color, 0, 0.12, 0), box(0.57, 0.02, 0.27, DARK, 0, 0.18, 0),
  box(0.03, 0.08, 0.03, DARK, -0.15, 0.28, 0), box(0.03, 0.08, 0.03, DARK, 0.15, 0.28, 0), rod(v(-0.16, 0.32, 0), v(0.16, 0.32, 0), 0.02, DARK),
);

/** A service cart: a power and coolant unit on wheels, its panel lit, a hose reel on its +x end. */
function cart(color, line) {
  const g = group(
    box(1.9, 0.14, 1.1, DARK, 0, 0.3, 0), box(1.8, 1.15, 1.0, color, 0, 0.94, 0),
    box(0.75, 0.5, 0.05, DARK, 0.42, 1.0, 0.52), box(0.5, 0.24, 0.02, SCREEN, 0.42, 1.06, 0.55),
    box(0.08, 0.06, 0.02, GO, 0.25, 0.84, 0.55), box(0.08, 0.06, 0.02, STOP, 0.4, 0.84, 0.55),
    rod(v(-1.08, 1.3, -0.4), v(-1.08, 1.3, 0.4), 0.03, CHROME),
    rod(v(0.92, 0.95, 0), v(0.94, 0.95, 0), 0.42, DARK), rod(v(0.94, 0.95, 0), v(1.12, 0.95, 0), 0.34, line), rod(v(1.12, 0.95, 0), v(1.14, 0.95, 0), 0.42, DARK),
  );
  for (const z of [-0.38, 0.38]) g.add(rod(v(-0.9, 1.3, z), v(-1.08, 1.3, z), 0.025, CHROME));
  for (const x of [-0.65, 0.65]) for (const z of [-0.62, 0.5]) g.add(rod(v(x, 0.2, z), v(x, 0.2, z + 0.12), 0.2, DARK));
  for (let i = 0; i < 7; i++) g.add(box(0.04, 0.6, 0.02, DARK, -0.75 + i * 0.1, 0.95, 0.51));
  return g;
}

/** Gas bottles chained in a stand. */
function bottles() {
  const g = group(box(1.7, 0.1, 0.5, STEEL, 0, 0.05, 0), box(1.7, 0.04, 0.04, DARK, 0, 1.1, 0.17));
  for (const x of [-0.85, 0.85]) g.add(box(0.05, 1.3, 0.05, STEEL, x, 0.65, -0.2));
  [OLIVE, 0x50555a, OLIVE, RED].forEach((color, i) => {
    const x = -0.57 + i * 0.38;
    g.add(rod(v(x, 0.1, 0), v(x, 1.4, 0), 0.15, color), rod(v(x, 1.4, 0), v(x, 1.5, 0), 0.09, color), rod(v(x, 1.5, 0), v(x, 1.62, 0), 0.04, CHROME));
  });
  return g;
}

/** A steel drum, ribbed, standing at (x, z). */
const drum = (color, x, z) => group(rod(v(x, 0, z), v(x, 0.88, z), 0.3, color), rod(v(x, 0.28, z), v(x, 0.31, z), 0.315, color), rod(v(x, 0.58, z), v(x, 0.61, z), 0.315, color));

/** A workbench: a pegboard of tools behind it, a vise and a toolbox on top, a shelf beneath. */
function bench() {
  const g = group(
    box(2.4, 0.08, 0.9, 0x4a4036, 0, 0.92, 0), box(2.3, 0.04, 0.8, STEEL, 0, 0.25, 0),
    box(2.4, 1.1, 0.04, 0x3a3f45, 0, 1.55, -0.43), box(0.26, 0.16, 0.22, NAVY, -0.8, 1.04, 0.25),
    toolbox(RED).translateX(0.6).translateY(0.96),
  );
  for (const x of [-1.15, 1.15]) for (const z of [-0.4, 0.4]) g.add(box(0.07, 0.9, 0.07, STEEL, x, 0.45, z));
  for (let i = 0; i < 8; i++) g.add(box(0.04, 0.22 + (i % 3) * 0.1, 0.02, CHROME, -1 + i * 0.28, 1.6, -0.4));
  return g;
}

/** A pallet rack along a wall: uprights, three levels of beams, crates and drums on them. */
function rack() {
  const g = group();
  for (const x of [-1.6, 1.6]) for (const z of [-0.5, 0.5]) g.add(box(0.1, 4.2, 0.1, NAVY, x, 2.1, z));
  for (const y of [0.15, 1.55, 2.95]) g.add(box(3.3, 0.12, 1.1, RUST, 0, y, 0));
  g.add(
    box(1.2, 0.9, 0.9, OLIVE, -0.9, 0.66, 0), box(1.0, 0.7, 0.9, WOOD, 0.6, 0.56, 0),
    box(1.4, 1.0, 0.9, WOOD, -0.6, 2.11, 0), drum(NAVY, 0.9, 0).translateY(1.61),
    box(1.0, 0.8, 0.9, OLIVE, 0.8, 3.41, 0), box(0.9, 0.6, 0.9, WOOD, -0.6, 3.31, 0),
  );
  return g;
}

/** A compressor against a wall: a long housing with fans on top, grilles, a panel, pipes up the wall. */
function compressor() {
  const g = group(
    box(4.6, 2.4, 2, 0x3d4a3a, 0, 1.3, 0), box(4.7, 0.1, 2.1, DARK, 0, 0.05, 0),
    box(0.9, 0.6, 0.05, DARK, 1.5, 1.6, 1.01), box(0.6, 0.3, 0.02, SCREEN, 1.5, 1.68, 1.04), box(0.1, 0.07, 0.02, GO, 1.3, 1.42, 1.04),
  );
  for (const x of [-1.2, 0.2]) g.add(rod(v(x, 2.5, 0), v(x, 2.8, 0), 0.6, DARK), rod(v(x, 2.8, 0), v(x, 2.82, 0), 0.5, STEEL));
  for (let i = 0; i < 12; i++) g.add(box(0.05, 1.4, 0.02, DARK, -2 + i * 0.2, 1.3, 1.01));
  for (const x of [1.6, 2.0]) g.add(rod(v(x, 2.5, -0.7), v(x, 8, -0.7), 0.1, STEEL));
  return g;
}

/** A work lamp on a tripod at (x, z) aimed at `aim`: its head glows and its light is real. */
function lamp(scene, x, z, aim) {
  const head = v(x, 2.4, z);
  const g = group(rod(v(x, 1.1, z), head, 0.03, DARK));
  for (let i = 0; i < 3; i++) g.add(rod(v(x + 0.7 * Math.cos(i * 2.1), 0, z + 0.7 * Math.sin(i * 2.1)), v(x, 1.15, z), 0.025, DARK));
  const can = box(0.5, 0.38, 0.22, ARM, head.x, head.y + 0.1, head.z), lens = box(0.42, 0.3, 0.02, LENS, 0, 0, 0.12);
  can.lookAt(aim);
  can.add(lens);
  g.add(can);
  const light = new THREE.SpotLight(0xffe2b8, 220, 0, 0.8, 0.6, 2);
  light.position.copy(can.position);
  light.target.position.copy(aim);
  scene.add(light, light.target);
  return g;
}

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
  scene.add(new THREE.HemisphereLight(0x8a98a8, 0x14120f, 0.8));
  const fill = new THREE.DirectionalLight(0x9fc4e8, 1); // a faint cool fill from the camera's side
  scene.add(fill);
  // Everything that holds still goes in here, merged at the end into a mesh a material.
  const hall = new THREE.Group();
  const put = (obj, x, z, yaw = 0) => {
    obj.position.set(x, obj.position.y, z);
    obj.rotation.y = yaw;
    hall.add(obj);
    obj.updateMatrixWorld();
    return obj;
  };

  // The hangar, all round the bays: a floor with walkway lines, ribbed end walls under catwalks,
  // side walls and roof trusses, all fading into the dark.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  for (const s of [-1, 1]) {
    hall.add(box(90, 20, 1, 0x1b1e22, 0, 10, s * 40));
    for (let x = -40; x <= 40; x += 5) hall.add(box(0.6, 20, 0.8, 0x15181b, x, 10, s * 39.2));
    hall.add(box(90, 0.4, 2.4, 0x23262a, 0, 8, s * 38.4));
    for (let x = -40; x <= 40; x += 2.5) hall.add(box(0.08, 1.1, 0.08, 0x3a3d40, x, 8.75, s * 37.3));
    hall.add(box(90, 0.08, 0.08, SAFETY, 0, 9.3, s * 37.3));
    hall.add(box(1, 20, 80, 0x181b1e, s * 44, 10, 0));
    for (let z = -35; z <= 35; z += 5) hall.add(box(0.8, 20, 0.6, 0x15181b, s * 43.2, 10, z));
    hall.add(box(52, 0.01, 0.2, LINE, 0, 0.005, s * 7));
  }
  for (let z = -32; z <= 32; z += 8) hall.add(box(88, 0.7, 0.5, 0x121416, 0, 17, z));

  // A bridge crane over the back of the bays on rails along the side walls, its hook part way down.
  hall.add(box(85, 0.9, 0.8, PAINT, 0, 14.2, -12));
  for (const s of [-1, 1]) hall.add(box(0.6, 0.6, 80, STEEL, s * 42.6, 15, 0), box(1.2, 0.8, 2.6, PAINT, s * 42, 14.6, -12));
  hall.add(box(2.2, 0.8, 1.8, STEEL, -5, 13.4, -12), box(0.7, 0.9, 0.35, PAINT, -5, 9.2, -12), rod(v(-5, 8.75, -12), v(-5, 8.4, -12), 0.06, CHROME));
  for (const x of [-5.25, -4.75]) hall.add(rod(v(x, 13, -12), v(x, 9.65, -12), 0.025, DARK));
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.06, 6, 14, Math.PI * 1.4), CHROME);
  hook.position.set(-5, 8.2, -12);
  hook.rotation.z = Math.PI * 0.8;
  hall.add(hook);

  // Round the bays: carts, chests and bottles between them, a bench and lamps outside them,
  // crates behind; racks, a compressor and drums along the walls.
  const carts = [put(cart(OLIVE, 0x1a1a1a), -7, -3.4), put(cart(0x4a4f55, RUST), 21, -1.5, -Math.PI / 2)];
  put(chest(RED), -6.4, 1.8, 0.15);
  put(toolbox(RED), -8.4, 3.1, 0.4);
  put(chest(0x41464d), 6.9, -2.4, -0.2);
  put(bottles(), 7.4, 1.6, -0.3);
  hall.add(drum(NAVY, 8.7, -4.6), drum(RED, 9.4, -4.0), drum(NAVY, -20.6, -5.2));
  put(bench(), -21.2, -1.5, Math.PI / 2);
  put(chest(RUST), -21, 2.6, Math.PI / 2);
  put(bottles(), 21.6, 2.8, -Math.PI / 2);
  hall.add(lamp(scene, -19.5, 5.2, v(-15.5, 1, -0.5)), lamp(scene, 19.5, 5.2, v(15.5, 1, -0.5)));
  hall.add(lamp(scene, -9, 10.5, v(-3, 1, 3)), lamp(scene, 9, 10.5, v(3, 1, 3)));
  hall.add(box(1.3, 0.14, 1.1, WOOD, -4.6, 0.07, 9.6), box(1.1, 0.8, 0.9, OLIVE, -4.7, 0.54, 9.6), box(0.7, 0.5, 0.6, WOOD, -4.5, 1.19, 9.5));
  hall.add(...coil(0.5, 4, 0x1a1a1a, 4.2, 0, 8.8));
  put(toolbox(0x41464d), 5.6, 9.9, -0.5);
  hall.add(box(1.2, 1.0, 1.0, WOOD, -3.6, 0.5, -7.6), box(0.9, 0.7, 0.9, OLIVE, -3.5, 1.35, -7.5), box(1.1, 0.9, 1.1, OLIVE, 4.2, 0.45, -8.1));
  put(rack(), -10, -35.6);
  put(rack(), 10, -35.6);
  put(compressor(), 0, -35.4);
  put(rack(), -12, 35.6, Math.PI);
  put(cart(OLIVE, 0x1a1a1a), 14, 34.6, Math.PI);
  put(rack(), 38.6, -10, -Math.PI / 2);
  put(bench(), -38.8, -6, Math.PI / 2);
  put(bottles(), 38.6, 10, -Math.PI / 2);
  hall.add(drum(OLIVE, -18, -35.2), drum(OLIVE, -18.7, -34.8), drum(RED, -3, 35.2), box(1.4, 1.2, 1.2, WOOD, 6, 0.6, 35), box(1.2, 1.2, 1.2, OLIVE, -38, 0.6, 8));
  // The carts' lines across the floor to the nearest lifts.
  const [left, right] = carts.map((c) => c.localToWorld(v(1.03, 0.6, 0)));
  hall.add(hose([left, v(left.x + 0.4, 0.06, left.z + 0.5), v(-5.6, 0.06, -1.6), v(-8.6, 0.06, -0.6), v(-11.2, 0.25, -0.8)], 0.06, 0x1a1a1a));
  hall.add(hose([right, v(right.x - 0.6, 0.06, right.z - 0.3), v(18.5, 0.06, -2.2), v(16.8, 0.25, -1.4)], 0.06, RUST));

  // The bays: a lift, a hazard line, a mech and the spotlight over it, with a faint cone of light,
  // and lines down to the mech and its deck from a reel on the truss behind.
  const mechs = BAYS.map(([cls, x, turn], i) => {
    const height = classes[cls].overrides?.mech_height ?? tuning.mech_height.value;
    put(lift(), x, 0);
    hall.add(box(6.8, 0.01, 0.35, LINE, x, 0.005, 3.8));
    put(toolbox([RED, 0x41464d, RUST][i]), x - 2.5, -2.6, 0.3).position.y = LIFT;
    hall.add(...coil(0.45, 3, HOSE, x + 2.4, LIFT, -2.2));
    hall.add(rod(v(x - 0.35, 16.1, -8), v(x + 0.35, 16.1, -8), 0.3, DARK), box(0.08, 0.6, 0.08, STEEL, x, 16.5, -8));
    hall.add(hose(hang(v(x - 0.15, 15.85, -8), v(x, LIFT + 0.62 * height, -0.15 * height), 1.0), 0.09, DARK));
    hall.add(hose([...hang(v(x + 0.15, 15.85, -8), v(x + 2.2, LIFT + 1.12, -3.3), 1.4), v(x + 2.3, LIFT + 0.6, -2.9), v(x + 2.4, LIFT + 0.12, -2.4)], 0.05, HOSE));

    const spot = new THREE.SpotLight(SPOT.color, SPOT.intensity, 0, SPOT.angle, 0.55, 2);
    spot.position.set(x, SPOT.height, 0.5);
    spot.target.position.set(x, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0004;
    scene.add(spot, spot.target);
    // The cone's apex at the lamp, its axis down to where the lamp points.
    const axis = new THREE.Vector3().subVectors(spot.position, spot.target.position), reach = axis.length();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(reach * Math.tan(SPOT.angle), reach, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: SPOT.color, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    cone.position.copy(spot.target.position).addScaledVector(axis, 0.5);
    cone.quaternion.setFromUnitVectors(UP, axis.normalize());
    scene.add(cone);
    // The can the lamp hangs in, on a rod down from the truss: its lens glowing at the lamp, the
    // body back up the axis.
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 1.2, 24), [CAN, CAN, LENS]);
    can.quaternion.copy(cone.quaternion);
    can.position.copy(spot.position).addScaledVector(axis, 0.6);
    const drop = 16.7 - SPOT.height - 1;
    scene.add(can);
    hall.add(box(0.1, drop, 0.1, 0x2b2e32, x, SPOT.height + 1 + drop / 2, 0.25));
    const mech = new Mech(scene, NO_FX, cls);
    mech.root.traverse((o) => { o.castShadow = o.receiveShadow = true; });
    return { mech, pos: new THREE.Vector3(x, LIFT, 0), yaw: Math.PI + turn, scale: height / mech.height };
  });

  // Hundreds of parts, a few draws.
  hall.updateMatrixWorld(true);
  const parts = new Map();
  hall.traverse((o) => {
    if (!o.isMesh) return;
    if (!parts.has(o.material)) parts.set(o.material, []);
    parts.get(o.material).push(o.geometry.applyMatrix4(o.matrixWorld));
  });
  for (const [material, geometries] of parts) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  }

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
    camera.lookAt(0, ORBIT.look, 0);
    fill.position.copy(camera.position);
    BEACON.color.copy(AMBER).multiplyScalar(Math.max(0.12, Math.sin(t * 4)) ** 2);
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
