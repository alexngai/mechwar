// Procedural effects: an additive glow pool (fire, sparks, flashes) and a soft smoke pool, each one
// THREE.Points updated on the CPU. ponytail: a full pool overwrites its oldest particle; raise the
// sizes if effects visibly cut out in big fights.
import * as THREE from 'three';

const vertexShader = `
attribute float size;
attribute float alpha;
attribute vec3 tint;
uniform float scale;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vTint = tint;
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const fragmentShader = `
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vTint, vAlpha * (1.0 - d));
}`;

class Pool {
  constructor(scene, max, blending) {
    this.max = max;
    this.next = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.tint = new Float32Array(max * 3);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.span = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    for (const [name, array, n] of [['position', this.pos, 3], ['tint', this.tint, 3], ['size', this.size, 1], ['alpha', this.alpha, 1]]) {
      this.geo.setAttribute(name, new THREE.BufferAttribute(array, n));
    }
    this.uniforms = { scale: { value: 1 } };
    const points = new THREE.Points(
      this.geo,
      new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: this.uniforms, blending, transparent: true, depthWrite: false }),
    );
    points.frustumCulled = false;
    scene.add(points);
  }

  spawn(p, v, { life, size, color, alpha = 1, gravity = 0, drag = 0 }) {
    const i = this.next;
    this.next = (i + 1) % this.max;
    this.life[i] = this.span[i] = life;
    [this.s0[i], this.s1[i]] = size;
    this.a0[i] = alpha;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    const i3 = i * 3;
    this.pos.set([p.x, p.y, p.z], i3);
    this.vel.set([v.x, v.y, v.z], i3);
    this.c0.set(color[0], i3);
    this.c1.set(color[1], i3);
  }

  update(dt, scale) {
    this.uniforms.scale.value = scale;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(this.life[i], 0) / this.span[i];
      const keep = Math.max(0, 1 - this.drag[i] * dt);
      const i3 = i * 3;
      this.vel[i3 + 1] -= this.gravity[i] * dt;
      for (let j = i3; j < i3 + 3; j++) {
        this.vel[j] *= keep;
        this.pos[j] += this.vel[j] * dt;
        this.tint[j] = this.c0[j] + (this.c1[j] - this.c0[j]) * t;
      }
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.alpha[i] = this.a0[i] * (1 - t);
    }
    for (const name of ['position', 'tint', 'size', 'alpha']) this.geo.attributes[name].needsUpdate = true;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const v = new THREE.Vector3(), jitter = new THREE.Vector3();
const dir = new THREE.Vector3(), mid = new THREE.Vector3(), view = new THREE.Vector3(), side = new THREE.Vector3(), normal = new THREE.Vector3();
const BEAM_LIFE = 0.09, BEAM_WIDTH = 0.25, LIGHT_LIFE = 0.08;

/** Gradient drawn once on a canvas: `stops` maps 0..1 across the canvas to alpha. */
function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  return new THREE.CanvasTexture(canvas);
}

let glowTexture;
/** An additive glow sprite: a cheap stand-in for bloom around bright things. */
export function halo(color, size) {
  glowTexture ??= canvasTexture(64, 64, (g, w) => {
    const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, w, w);
  });
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

/** Tracers: pooled camera-facing quads stretched muzzle to impact, soft across their width. */
class Beams {
  constructor(scene, count = 24) {
    const texture = canvasTexture(1, 32, (g, w, h) => {
      const l = g.createLinearGradient(0, 0, 0, h);
      l.addColorStop(0, 'rgba(255,255,255,0)');
      l.addColorStop(0.5, 'rgba(255,255,255,1)');
      l.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = l;
      g.fillRect(0, 0, w, h);
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.next = 0;
    this.items = Array.from({ length: count }, () => {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ map: texture, color: 0xffe2a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, from: new THREE.Vector3(), to: new THREE.Vector3(), life: 0 };
    });
  }

  spawn(from, to) {
    const beam = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    beam.from.copy(from);
    beam.to.copy(to);
    beam.life = BEAM_LIFE;
  }

  update(dt, camera) {
    for (const b of this.items) {
      b.life -= dt;
      b.mesh.visible = b.life > 0;
      if (!b.mesh.visible) continue;
      const length = dir.subVectors(b.to, b.from).length();
      dir.divideScalar(length);
      mid.addVectors(b.from, b.to).multiplyScalar(0.5);
      // Turn the quad about the beam's axis to face the camera.
      side.crossVectors(dir, view.subVectors(camera.position, mid)).normalize();
      normal.crossVectors(side, dir);
      b.mesh.matrix.makeBasis(dir.multiplyScalar(length), side.multiplyScalar(BEAM_WIDTH), normal).setPosition(mid);
      b.mesh.material.opacity = b.life / BEAM_LIFE;
    }
  }
}
const rand = (a, b) => a + Math.random() * (b - a);
/** `dir * speed` plus a random kick up to `spread` on each axis. */
const scatter = (dir, speed, spread) =>
  v.copy(dir).multiplyScalar(speed).add(jitter.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(spread));
/** Fractional per-frame rates become a whole count on average. */
const count = (rate, dt) => Math.floor(rate * dt + Math.random());

const FIRE = [[1, 0.95, 0.7], [1, 0.35, 0.05]];
const SPARK = [[1, 0.9, 0.5], [1, 0.3, 0.05]];
const FLAME = [[0.85, 0.9, 1], [1, 0.45, 0.1]];
const COOL_FLAME = [[0.85, 0.97, 1], [0.25, 0.55, 1]];
const DUST = [[0.62, 0.58, 0.5], [0.5, 0.47, 0.42]];

export class Effects {
  constructor(scene) {
    this.glow = new Pool(scene, 1500, THREE.AdditiveBlending);
    this.soft = new Pool(scene, 600, THREE.NormalBlending);
    this.beams = new Beams(scene);
    // Two short-lived lights at the latest muzzle flashes (High quality only).
    this.lights = [0, 1].map(() => {
      const light = new THREE.PointLight(0xffc27a, 0, 16, 2);
      scene.add(light);
      return { light, life: 0 };
    });
    this.nextLight = 0;
  }

  setQuality(high) {
    for (const l of this.lights) l.light.visible = high;
  }

  /** `height` is the drawing buffer height in pixels; point sizes are in meters. */
  update(dt, camera, height) {
    const scale = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.glow.update(dt, scale);
    this.soft.update(dt, scale);
    this.beams.update(dt, camera);
    for (const l of this.lights) {
      l.life = Math.max(0, l.life - dt);
      l.light.intensity = (l.life / LIGHT_LIFE) * 60;
    }
  }

  beam(from, to) {
    this.beams.spawn(from, to);
  }

  muzzleLight(p) {
    const l = this.lights[this.nextLight];
    this.nextLight = (this.nextLight + 1) % this.lights.length;
    l.light.position.copy(p);
    l.life = LIGHT_LIFE;
  }

  muzzle(p, dir) {
    for (let i = 0; i < 6; i++) this.glow.spawn(p, scatter(dir, rand(4, 12), 2), { life: rand(0.05, 0.09), size: [rand(0.6, 1.1), 0.2], color: FIRE });
  }

  impact(p) {
    for (let i = 0; i < 10; i++) {
      this.glow.spawn(p, scatter(UP, rand(2, 5), 7), { life: rand(0.15, 0.35), size: [0.25, 0.05], color: SPARK, gravity: 18, drag: 1 });
    }
    for (let i = 0; i < 3; i++) this.soft.spawn(p, scatter(UP, 1, 1), { life: rand(0.5, 0.9), size: [0.5, 1.8], color: DUST, alpha: 0.45, drag: 2 });
  }

  /** `cool` flames are Slipstream's blue-white. */
  thrust(p, dir, power, dt, cool = false) {
    for (let i = count(70 * power, dt); i > 0; i--) {
      this.glow.spawn(p, scatter(dir, rand(8, 14), 1.2), { life: rand(0.06, 0.13) * power, size: [0.75 * power, 0.15], color: cool ? COOL_FLAME : FLAME, drag: 4 });
    }
  }

  /** Vent: a big burst of white steam. */
  steam(p) {
    for (let i = 0; i < 16; i++) {
      this.soft.spawn(p, scatter(UP, rand(2, 5), 3), { life: rand(0.8, 1.4), size: [1, 4], color: [[0.95, 0.95, 0.95], [0.8, 0.8, 0.8]], alpha: 0.6, drag: 2 });
    }
    for (let i = 0; i < 8; i++) this.glow.spawn(p, scatter(UP, rand(2, 6), 4), { life: rand(0.1, 0.25), size: [0.8, 0.2], color: COOL_FLAME, drag: 3 });
  }

  burst(p, dir) {
    for (let i = 0; i < 18; i++) this.glow.spawn(p, scatter(dir, rand(8, 16), 3), { life: rand(0.08, 0.18), size: [0.9, 0.2], color: FLAME, drag: 5 });
    for (let i = 0; i < 4; i++) {
      this.soft.spawn(p, scatter(dir, 3, 1.5), { life: rand(0.5, 0.8), size: [1, 2.5], color: [[0.7, 0.7, 0.7], [0.5, 0.5, 0.5]], alpha: 0.35, drag: 3 });
    }
  }

  explosion(p) {
    for (let i = 0; i < 40; i++) {
      this.glow.spawn(p, scatter(UP, rand(0, 3), 9), { life: rand(0.3, 0.7), size: [rand(1.5, 2.5), rand(3, 4.5)], color: FIRE, drag: 3 });
    }
    for (let i = 0; i < 30; i++) {
      this.glow.spawn(p, scatter(UP, rand(4, 8), 14), { life: rand(0.4, 0.9), size: [0.3, 0.05], color: SPARK, gravity: 15, drag: 0.5 });
    }
    for (let i = 0; i < 20; i++) {
      this.soft.spawn(p, scatter(UP, rand(1, 3), 3), { life: rand(1.5, 2.8), size: [2, 6], color: [[0.25, 0.24, 0.22], [0.15, 0.15, 0.15]], alpha: 0.7, drag: 1.5 });
    }
  }

  /** Continuous rising smoke; `shade` 0 (black) to 1 (white): dark for wrecks, light for overheat steam. */
  smoke(p, dt, shade) {
    for (let i = count(14, dt); i > 0; i--) {
      this.soft.spawn(p, scatter(UP, rand(1.5, 3), 0.6), {
        life: rand(1.2, 2.2), size: [0.8, 3.5], color: [[shade, shade, shade], [shade * 0.8, shade * 0.8, shade * 0.8]], alpha: 0.5, drag: 0.8,
      });
    }
  }

  dust(p) {
    for (let i = 0; i < 4; i++) this.soft.spawn(p, scatter(UP, 0.8, 1.6), { life: rand(0.4, 0.8), size: [0.4, 1.4], color: DUST, alpha: 0.35, drag: 3 });
  }
}
