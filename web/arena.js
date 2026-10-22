// The arena's look, built from map data (maps/*.json): solids with kitbashed trim, decor props, a
// generated ground texture and baked ambient occlusion (plus lamp, furnace and sign light on night
// maps), merged into three meshes. A map's `palette` tints it and colors its lamps. Only `solids`
// collide (the sim reads the same file); everything added here is visual.
import * as THREE from 'three';
import { halo, hot } from './fx.js';

// Camera layers for quality-specific extras: halos stand in for bloom when it's off; High has light shafts.
export const LOW_ONLY = 1, HIGH_ONLY = 2;

const COLORS = {
  ground: 0x9a9384, concrete: 0xa8a08e, metal: 0x6f7880, panel: 0x8f969a, salt: 0xe8e4d8, tank: 0xb9ac8e,
  trim: 0x55585b, rail: 0xd3a23a, pipe: 0x7d7262, pole: 0x3a3c3f, rust: 0x8a5634, soot: 0x4f4c49, stack: 0x6e5a4c,
  tower: 0x6c7470, rock: 0x7f7c8c,
};
// Lit windows on `tower` solids, unless the palette names its own; and how many slots are lit.
const WINDOWS = ['#ffd890', '#9dffc0', '#7fe8ff'];
const LIT = 0.3;
const TILE = 8; // ground texture repeat, meters
// Baked night lights: color, reach (m) and strength. Lamps light pools; furnaces glow orange.
const LAMP = { color: 0xffc98a, radius: 16, power: 1.4 };
const FURNACE = { color: 0xff8a3a, radius: 15, power: 4 };
const SIGN = { radius: 12, power: 2 };
const AO_STEPS = [0.4, 0.9, 1.6, 2.5, 3.6]; // sample distances along the normal, meters
const UP = new THREE.Vector3(0, 1, 0), WHITE = new THREE.Color(1, 1, 1);
const tint = new THREE.Color(1, 1, 1); // the building map's palette tint, for `paint`
const color = new THREE.Color(), v = new THREE.Vector3(), n = new THREE.Vector3(), local = new THREE.Vector3(), sample = new THREE.Vector3(), to = new THREE.Vector3();

const solidMatrix = (s) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(...s.box),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(s.tilt ?? 0), THREE.MathUtils.degToRad(s.yaw ?? 0), 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );

/** A box geometry split into roughly `cell`-meter quads so per-vertex AO has room to vary. */
function boxGeometry([hx, hy, hz], cell = 2) {
  const seg = (h) => Math.min(96, Math.max(1, Math.round((2 * h) / cell)));
  return new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz, seg(hx), seg(hy), seg(hz));
}

/** Small deterministic hash so each solid gets a stable color variation. */
const jitter = (i) => 1 + (((Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5) * 0.1;

/** Colors `geometry` `hex` times `shade`, tinted by the palette unless it's a light (`glows`). */
function paint(geometry, hex, shade = 1, glows = false) {
  color.set(hex).multiplyScalar(shade);
  if (!glows) color.multiply(tint);
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
  const tall = hy > 1.2 && s.mat !== 'salt' && s.mat !== 'ground' && s.mat !== 'rock';
  if (tall) {
    // Cap trim along the top edges.
    add(2 * hx + 0.2, 0.25, 0.2, 0, hy - 0.12, hz);
    add(2 * hx + 0.2, 0.25, 0.2, 0, hy - 0.12, -hz);
    add(0.2, 0.25, 2 * hz + 0.2, hx, hy - 0.12, 0);
    add(0.2, 0.25, 2 * hz + 0.2, -hx, hy - 0.12, 0);
  }
  if (tall && Math.max(hx, hz) > 3 && s.mat !== 'tower') {
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
  if (s.mat === 'stack') {
    // Steel bands up the shaft and a sooty lip, fluted like the stack's square and diamond halves.
    for (let y = -hy + 6; y < hy - 2; y += 7) add(2 * hx + 0.4, 0.6, 2 * hz + 0.4, 0, y, 0, COLORS.trim);
    add(2 * hx + 0.6, 1.2, 2 * hz + 0.6, 0, hy - 0.6, 0, COLORS.soot);
  }
}

/** `lamp` is the lamps' { light, head } colors. */
function decorParts(d, parts, glow, lamp) {
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
    glow.push(paint(head, lamp.head, 1, true));
    glow.lamps.push(new THREE.Vector3(x, y + 3.1, z));
    // Its light shaft, down to the deck it stands on.
    glow.shafts.push(paint(new THREE.CylinderGeometry(0.3, 2.6, 3.1, 16, 1, true).translate(x, y + 1.55, z), lamp.light, 0.25, true));
  } else if (d.kind === 'sign') {
    // A neon panel set on a wall (`from`/`to` corners), lighting the street from `at`.
    const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to);
    const g = new THREE.BoxGeometry(...new THREE.Vector3().subVectors(b, a).toArray().map(Math.abs));
    g.translate(...a.add(b).multiplyScalar(0.5).toArray());
    glow.push(paint(g, d.color, 1, true));
    glow.signs.push({ at: new THREE.Vector3(...d.at), color: d.color });
  } else if (d.kind === 'furnace') {
    // A furnace mouth: a glowing slab set into a wall (`from`/`to` corners), lit from `at`.
    const a = new THREE.Vector3(...d.from), b = new THREE.Vector3(...d.to), at = new THREE.Vector3(...d.at);
    const size = new THREE.Vector3().subVectors(b, a).toArray().map(Math.abs);
    const g = new THREE.BoxGeometry(...size);
    const center = a.add(b).multiplyScalar(0.5);
    g.translate(...center.toArray());
    glow.push(paint(g, 0xffa050, 1, true));
    glow.furnaces.push(at);
    // Its glow: a square shaft flaring 5 m out of the mouth, off the wall toward `at`.
    const thin = size[0] < size[2] ? 0 : 2;
    const out = new THREE.Vector3().setComponent(thin, Math.sign(at.getComponent(thin) - center.getComponent(thin)));
    const across = new THREE.Vector3().crossVectors(UP, out).multiplyScalar(size[2 - thin] / 2);
    const shaft = new THREE.CylinderGeometry(Math.SQRT2, 1.6 * Math.SQRT2, 1, 4, 1, true, Math.PI / 4);
    shaft.applyMatrix4(new THREE.Matrix4().makeBasis(across, out.clone().multiplyScalar(-5), UP.clone().multiplyScalar(size[1] / 2)).setPosition(center.addScaledVector(out, 2.5)));
    glow.shafts.push(paint(shaft, FURNACE.color, 0.3, true));
  }
}

/** Concatenates indexed geometries that share the first one's attributes. */
function mergeGeometries(geometries) {
  const merged = new THREE.BufferGeometry();
  for (const name of Object.keys(geometries[0].attributes)) {
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

/** True when the segment from `a` to `b` passes through the box placed by inverse matrix `inv`. */
function blocks(a, b, inv, [hx, hy, hz]) {
  const p = local.copy(a).applyMatrix4(inv), q = sample.copy(b).applyMatrix4(inv).sub(p);
  let t0 = 0, t1 = 1;
  for (const [o, d, h] of [[p.x, q.x, hx], [p.y, q.y, hy], [p.z, q.z, hz]]) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(o) > h) return false;
      continue;
    }
    const u = (-h - o) / d, w = (h - o) / d;
    t0 = Math.max(t0, Math.min(u, w));
    t1 = Math.min(t1, Math.max(u, w));
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Bakes `lights` into a `glow` attribute: per vertex, each light's color by its falloff and the
 * angle it strikes at, unless a solid stands between them (the lamps cast real shadows).
 */
function bakeLights(geometry, lights, boxes) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal;
  const glow = new Float32Array(pos.count * 3);
  geometry.computeBoundingSphere();
  const { center, radius } = geometry.boundingSphere;
  for (const l of lights.filter((l) => l.at.distanceTo(center) < l.radius + radius)) {
    const near = boxes.filter((b) => b.center.distanceTo(l.at) < b.radius + l.radius);
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(nor, i);
      // From just off the surface, so the vertex's own solid doesn't shade it.
      v.fromBufferAttribute(pos, i).addScaledVector(n, 0.05);
      to.subVectors(l.at, v);
      const d = to.length(), facing = n.dot(to) / d;
      if (d >= l.radius || facing <= 0) continue;
      if (near.some((b) => blocks(v, l.at, b.inv, b.half))) continue;
      const k = l.power * (1 - d / l.radius) ** 2 * facing;
      glow[i * 3] += l.rgb.r * k;
      glow[i * 3 + 1] += l.rgb.g * k;
      glow[i * 3 + 2] += l.rgb.b * k;
    }
  }
  geometry.setAttribute('glow', new THREE.BufferAttribute(glow, 3));
}

/** Has a Lambert material add the baked `glow` attribute as light of its own. */
function glowing(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 glow;\nvarying vec3 vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vGlow * diffuseColor.rgb;');
  };
  return material;
}

/**
 * Additive light shafts that read as lit air: bright at the source (`uv.y` 1), fading along the
 * shaft and toward its edges, where the eye looks through the least of it, and into the fog.
 */
function shaftMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    vertexShader: /* glsl */ `
      uniform float fogNear, fogFar;
      varying vec3 vColor, vNormal, vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vColor = color * uv.y * uv.y * (1.0 - smoothstep(fogNear, fogFar, -mv.z));
        vNormal = normalMatrix * normal;
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor, vNormal, vView;
      void main() {
        gl_FragColor = vec4(vColor * abs(dot(normalize(vNormal), normalize(vView))), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    vertexColors: true,
    fog: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Lit window panes on the faces of a `tower` solid, in its local space: rows every 4 m from 8 m up
 * (street level stays dark, no glare at eye height), a slot every 3 m, LIT of them lit (seeded by
 * `seed`, so a tower always looks the same).
 */
function towerWindows(s, seed, colors, out) {
  const [hx, hy, hz] = s.half;
  let k = seed * 9301 + 49297;
  const rand = () => ((k = (k * 16807) % 2147483647) / 2147483647);
  for (const [w, d, face] of [[hx, hz, (a, y) => [a, y, hz + 0.05, 0]], [hx, hz, (a, y) => [a, y, -hz - 0.05, Math.PI]], [hz, hx, (a, y) => [hx + 0.05, y, -a, Math.PI / 2]], [hz, hx, (a, y) => [-hx - 0.05, y, a, -Math.PI / 2]]]) {
    for (let y = -hy + 8; y < hy - 2; y += 4) {
      for (let a = -w + 2; a < w - 1; a += 3) {
        if (rand() > LIT) continue;
        const [x, wy, z, turn] = face(a, y);
        const pane = new THREE.PlaneGeometry(1.2, 1).rotateY(turn).translate(x, wy, z);
        out.push(paint(pane, colors[Math.floor(rand() * colors.length)], 0.2 + rand() * 0.25, true));
      }
    }
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

/**
 * Adds the map's meshes to `scene`; returns them so a map change can remove them, with `vents`
 * (stack tops, which smoke) and `furnaces` (furnace mouths, which spark).
 */
export function buildArena(scene, map) {
  const started = performance.now();
  const palette = map.palette ?? {};
  tint.set(palette.tint ?? 0xffffff);
  const lamp = palette.lamp ? { light: palette.lamp, head: new THREE.Color(palette.lamp).lerp(WHITE, 0.4).getHex() } : { light: LAMP.color, head: 0xffd9a0 };
  const boxes = map.solids.map((s) => {
    const matrix = solidMatrix(s);
    const [hx, hy, hz] = s.half;
    return { matrix, inv: matrix.clone().invert(), half: s.half, center: new THREE.Vector3(...s.box), radius: Math.hypot(hx, hy, hz) };
  });

  const ground = [], solid = [], glow = [];
  glow.lamps = [];
  glow.furnaces = [];
  glow.signs = [];
  glow.shafts = [];
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
    if (s.mat === 'tower') {
      const panes = [];
      towerWindows(s, i, palette.windows ?? WINDOWS, panes);
      for (const p of panes) glow.push(p.applyMatrix4(boxes[i].matrix));
    }
  });
  for (const d of map.decor ?? []) decorParts(d, solid, glow, lamp);
  const lit = (m) => (map.night ? glowing(m) : m);
  const light = (at, l) => ({ at, ...l, rgb: new THREE.Color(l.color) });
  const lights = map.night
    ? [
        ...glow.lamps.map((p) => light(p, { ...LAMP, color: lamp.light })),
        ...glow.furnaces.map((p) => light(p, FURNACE)),
        ...glow.signs.map(({ at, color }) => light(at, { ...SIGN, color })),
      ]
    : [];
  if (map.night) for (const g of [...ground, ...solid]) bakeLights(g, lights, boxes);

  const meshes = [
    ground.length && new THREE.Mesh(mergeGeometries(ground), lit(new THREE.MeshLambertMaterial({ map: groundTexture(), vertexColors: true }))),
    new THREE.Mesh(mergeGeometries(solid), lit(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }))),
    glow.length && new THREE.Mesh(mergeGeometries(glow), hot(new THREE.MeshBasicMaterial({ vertexColors: true }))),
  ].filter(Boolean);
  // Sun shadows: the floor only receives; solids and their trim cast and receive.
  meshes[0].receiveShadow = true;
  meshes[1].castShadow = meshes[1].receiveShadow = true;
  for (const p of glow.lamps) {
    const h = halo(palette.lamp ?? 0xffd29a, map.night ? 4 : 2.6);
    h.position.copy(p);
    h.layers.set(LOW_ONLY);
    meshes.push(h);
  }
  for (const p of glow.furnaces) {
    const h = halo(0xff8a3a, 7);
    h.position.copy(p);
    h.layers.set(LOW_ONLY);
    meshes.push(h);
  }
  for (const { at, color: c } of glow.signs) {
    const h = halo(c, 5);
    h.position.copy(at);
    h.layers.set(LOW_ONLY);
    meshes.push(h);
  }
  if (map.night && glow.shafts.length) {
    const shafts = new THREE.Mesh(mergeGeometries(glow.shafts), shaftMaterial());
    shafts.layers.set(HIGH_ONLY);
    meshes.push(shafts);
  }
  scene.add(...meshes);
  console.info(`arena ${map.name}: ${meshes.length} meshes, built in ${Math.round(performance.now() - started)} ms`);
  // Smoke rises from the top of each stack (its square half; the diamond is the same stack).
  meshes.vents = map.solids.filter((s) => s.mat === 'stack' && !s.yaw).map((s) => new THREE.Vector3(s.box[0], s.box[1] + s.half[1] + 0.5, s.box[2]));
  meshes.furnaces = glow.furnaces;
  meshes.lights = lights; // night lights, for the cockpit
  return meshes;
}
