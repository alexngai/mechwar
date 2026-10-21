// The arena's look, built from map data (maps/*.json): solids with kitbashed trim, decor props, a
// generated ground texture and baked ambient occlusion, merged into three meshes. Only `solids`
// collide (the sim reads the same file); everything added here is visual.
import * as THREE from 'three';
import { halo } from './fx.js';

const COLORS = {
  ground: 0x9a9384, concrete: 0xa8a08e, metal: 0x6f7880, panel: 0x8f969a, salt: 0xe8e4d8, tank: 0xb9ac8e,
  trim: 0x55585b, rail: 0xd3a23a, pipe: 0x7d7262, pole: 0x3a3c3f,
};
const TILE = 8; // ground texture repeat, meters
const AO_STEPS = [0.4, 0.9, 1.6, 2.5, 3.6]; // sample distances along the normal, meters
const color = new THREE.Color(), v = new THREE.Vector3(), n = new THREE.Vector3(), local = new THREE.Vector3(), sample = new THREE.Vector3();

const solidMatrix = (s) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(...s.box),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(s.tilt ?? 0), THREE.MathUtils.degToRad(s.yaw ?? 0), 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );

/** A box geometry split into roughly `cell`-meter quads so per-vertex AO has room to vary. */
function boxGeometry([hx, hy, hz], cell = 2) {
  const seg = (h) => Math.min(48, Math.max(1, Math.round((2 * h) / cell)));
  return new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz, seg(hx), seg(hy), seg(hz));
}

/** Small deterministic hash so each solid gets a stable color variation. */
const jitter = (i) => 1 + (((Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5) * 0.1;

function paint(geometry, hex, shade = 1) {
  color.setHex(hex).multiplyScalar(shade);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Trim, ribs, beams and bands for one solid, in its local space. */
function kitbash(s, parts) {
  const [hx, hy, hz] = s.half;
  const add = (w, h, d, x, y, z, hex = COLORS.trim) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(paint(g, hex));
  };
  const tall = hy > 1.2 && s.mat !== 'salt' && s.mat !== 'ground';
  if (tall) {
    // Cap trim along the top edges.
    add(2 * hx + 0.2, 0.25, 0.2, 0, hy - 0.12, hz);
    add(2 * hx + 0.2, 0.25, 0.2, 0, hy - 0.12, -hz);
    add(0.2, 0.25, 2 * hz + 0.2, hx, hy - 0.12, 0);
    add(0.2, 0.25, 2 * hz + 0.2, -hx, hy - 0.12, 0);
  }
  if (tall && Math.max(hx, hz) > 3) {
    // Vertical ribs every ~4 m on the long faces.
    const alongX = hx >= hz, long = alongX ? hx : hz, short = alongX ? hz : hx;
    for (let p = -long + 2; p <= long - 2 + 1e-3; p += 4) {
      for (const side of [-1, 1]) {
        if (alongX) add(0.3, 2 * hy - 0.4, 0.15, p, 0, side * (short + 0.07));
        else add(0.15, 2 * hy - 0.4, 0.3, side * (short + 0.07), 0, p);
      }
    }
  }
  if (s.mat === 'metal' && hy <= 0.3) {
    // Decks and ramps: cross beams underneath.
    for (let p = -hz + 1; p <= hz - 1 + 1e-3; p += 3) add(2 * hx, 0.35, 0.25, 0, -hy - 0.17, p, COLORS.pole);
  }
  if (s.mat === 'tank') {
    for (const f of [-0.35, 0.3]) add(2 * hx + 0.3, 0.35, 2 * hz + 0.3, 0, f * 2 * hy, 0, COLORS.pipe);
  }
}

function decorParts(d, parts, glow) {
  const segment = (from, to, thickness, hex) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    // Posts and poles stand straight up, where lookAt is undefined.
    const g = Math.abs(dir.y) > 0.99 * len ? new THREE.BoxGeometry(thickness, len, thickness) : new THREE.BoxGeometry(thickness, thickness, len);
    if (Math.abs(dir.y) <= 0.99 * len) g.lookAt(dir);
    g.translate(...a.clone().add(b).multiplyScalar(0.5).toArray());
    parts.push(paint(g, hex));
  };
  if (d.kind === 'railing') {
    const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to);
    const posts = Math.max(1, Math.round(a.distanceTo(b) / 1.6));
    for (let i = 0; i <= posts; i++) {
      const p = a.clone().lerp(b, i / posts);
      segment([p.x, p.y, p.z], [p.x, p.y + 1.1, p.z], 0.09, COLORS.rail);
    }
    for (const h of [0.55, 1.1]) segment([a.x, a.y + h, a.z], [b.x, b.y + h, b.z], 0.08, COLORS.rail);
  } else if (d.kind === 'pipe') {
    const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to);
    const len = a.distanceTo(b), dir = new THREE.Vector3().subVectors(b, a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const cyl = (r, l, at) => {
      const g = new THREE.CylinderGeometry(r, r, l, 10);
      g.applyQuaternion(q);
      g.translate(...at.toArray());
      parts.push(paint(g, COLORS.pipe));
    };
    cyl(d.r, len, a.clone().lerp(b, 0.5));
    for (let t = 0; t <= len; t += 6) cyl(d.r * 1.3, 0.25, a.clone().addScaledVector(dir, t));
  } else if (d.kind === 'lamp') {
    const [x, y, z] = d.at;
    segment([x, y, z], [x, y + 3.2, z], 0.16, COLORS.pole);
    const head = new THREE.BoxGeometry(0.7, 0.22, 0.7);
    head.translate(x, y + 3.25, z);
    glow.push(paint(head, 0xffd9a0));
    glow.lamps.push(new THREE.Vector3(x, y + 3.1, z));
  }
}

/** Concatenates indexed geometries that share position, normal, uv and color attributes. */
function mergeGeometries(geometries) {
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const size = geometries[0].attributes[name].itemSize;
    const data = new Float32Array(geometries.reduce((sum, g) => sum + g.attributes[name].array.length, 0));
    let at = 0;
    for (const g of geometries) {
      data.set(g.attributes[name].array, at);
      at += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  const index = [];
  let base = 0;
  for (const g of geometries) {
    for (const i of g.index.array) index.push(i + base);
    base += g.attributes.position.count;
  }
  merged.setIndex(index);
  return merged;
}

/** Signed distance to an oriented box, given the inverse of its placement. */
function boxDistance(p, inv, [hx, hy, hz]) {
  local.copy(p).applyMatrix4(inv);
  const qx = Math.abs(local.x) - hx, qy = Math.abs(local.y) - hy, qz = Math.abs(local.z) - hz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}

/** Darkens a solid's vertex colors where nearby solids crowd the space above each vertex. */
function bakeAO(geometry, boxes) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal, col = geometry.attributes.color;
  geometry.computeBoundingSphere();
  const { center, radius } = geometry.boundingSphere;
  const near = boxes.filter((b) => b.center.distanceTo(center) < b.radius + radius + 4);
  const reach = AO_STEPS[AO_STEPS.length - 1];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    let light = 0.45; // undersides only ever face the ground: dark without sampling
    if (n.y > -0.9) {
      const close = near.filter((b) => b.center.distanceTo(v) < b.radius + reach);
      let occlusion = 0;
      for (const step of AO_STEPS) {
        sample.copy(v).addScaledVector(n, step);
        let d = step;
        for (const b of close) d = Math.min(d, boxDistance(sample, b.inv, b.half));
        occlusion += (step - Math.max(d, 0)) / step / AO_STEPS.length;
      }
      light = THREE.MathUtils.clamp(1 - 1.3 * occlusion, 0.35, 1);
    }
    col.setXYZ(i, col.getX(i) * light, col.getY(i) * light, col.getZ(i) * light);
  }
}

/** Concrete slabs with seams, grit and salt stains; drawn once, no file download. */
function groundTexture() {
  const size = 256, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#c4bdae';
  g.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2400; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '70,64,56' : '235,230,220'},${0.04 + rand() * 0.08})`;
    g.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
  }
  for (let i = 0; i < 7; i++) {
    const x = rand() * size, y = rand() * size, r = 10 + rand() * 30;
    const stain = g.createRadialGradient(x, y, 0, x, y, r);
    stain.addColorStop(0, 'rgba(250,248,240,0.35)');
    stain.addColorStop(1, 'rgba(250,248,240,0)');
    g.fillStyle = stain;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  g.strokeStyle = 'rgba(60,55,48,0.45)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, size - 2, size - 2);
  g.beginPath();
  g.moveTo(size / 2, 0);
  g.lineTo(size / 2, size);
  g.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Adds the map's meshes to `scene`; returns them so a map change can remove them. */
export function buildArena(scene, map) {
  const started = performance.now();
  const boxes = map.solids.map((s) => {
    const matrix = solidMatrix(s);
    const [hx, hy, hz] = s.half;
    return { matrix, inv: matrix.clone().invert(), half: s.half, center: new THREE.Vector3(...s.box), radius: Math.hypot(hx, hy, hz) };
  });

  const ground = [], solid = [], glow = [];
  glow.lamps = [];
  map.solids.forEach((s, i) => {
    const g = paint(boxGeometry(s.half), COLORS[s.mat] ?? COLORS.concrete, jitter(i));
    g.applyMatrix4(boxes[i].matrix);
    bakeAO(g, boxes);
    if (s.mat === 'ground') {
      // World-space UVs so the slab texture tiles evenly across the whole floor.
      const pos = g.attributes.position, uv = g.attributes.uv;
      for (let k = 0; k < pos.count; k++) uv.setXY(k, pos.getX(k) / TILE, pos.getZ(k) / TILE);
      ground.push(g);
    } else {
      solid.push(g);
    }
    const parts = [];
    kitbash(s, parts);
    for (const p of parts) solid.push(p.applyMatrix4(boxes[i].matrix));
  });
  for (const d of map.decor ?? []) decorParts(d, solid, glow);

  const meshes = [
    ground.length && new THREE.Mesh(mergeGeometries(ground), new THREE.MeshLambertMaterial({ map: groundTexture(), vertexColors: true })),
    new THREE.Mesh(mergeGeometries(solid), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })),
    glow.length && new THREE.Mesh(mergeGeometries(glow), new THREE.MeshBasicMaterial({ vertexColors: true })),
  ].filter(Boolean);
  // Sun shadows: the floor only receives; solids and their trim cast and receive.
  meshes[0].receiveShadow = true;
  meshes[1].castShadow = meshes[1].receiveShadow = true;
  for (const p of glow.lamps) {
    const h = halo(0xffd29a, 2.6);
    h.position.copy(p);
    meshes.push(h);
  }
  scene.add(...meshes);
  console.info(`arena ${map.name}: ${meshes.length} meshes, built in ${Math.round(performance.now() - started)} ms`);
  return meshes;
}
