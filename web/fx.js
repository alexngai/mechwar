// Procedural effects: an additive glow pool (fire, sparks, flashes), a soft smoke pool and an
// ember pool (stack sparks, cinders), each one THREE.Points updated on the CPU. ponytail: a full
// pool overwrites its oldest particle; raise the sizes if effects visibly cut out in big fights.
import * as THREE from 'three';

// Tints are display colors. Drawn into High quality's HDR target they go in as the scene-linear
// color that OutputPass's sRGB and ACES (three's ACESFilmicToneMapping, inverted) turn back into
// that tint, so they look the same and their hottest parts cross the bloom threshold.
const vertexShader = `
attribute float size;
attribute float alpha;
attribute vec3 tint;
uniform float scale;
uniform float cap; // largest angular size (rad): keeps embers drifting past the eye from blooming
uniform float toneMappingExposure;
varying vec3 vTint, vLinear;
varying float vAlpha;
vec3 untonemap(vec3 c) {
  c = min(c, 0.97); // display white would take infinite light
  vec3 y = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  y = clamp(inverse(mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602)) * y, 0.0, 1.0);
  vec3 a = 0.983729 * y - 1.0, b = 0.432951 * y - 0.0245786, k = 0.238081 * y + 0.000090537;
  vec3 v = (-b - sqrt(b * b - 4.0 * a * k)) / (2.0 * a);
  // Saturated tints fall outside what ACES can output; clamp, or additive sparks would subtract.
  return max(inverse(mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777)) * v * 0.6 / toneMappingExposure, 0.0);
}
void main() {
  vTint = tint;
  vLinear = untonemap(tint);
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = scale * min(size / -mv.z, cap);
  gl_Position = projectionMatrix * mv;
}`;

const fragmentShader = `
varying vec3 vTint, vLinear;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0) discard;
  #ifdef TONE_MAPPING
    gl_FragColor = vec4(vTint, vAlpha * (1.0 - d)); // straight to the screen
  #else
    gl_FragColor = vec4(vLinear, vAlpha * (1.0 - d));
  #endif
}`;

class Pool {
  constructor(scene, max, blending, cap = 1e3) {
    this.max = max;
    this.next = 0;
    this.shade = 1; // scales spawned colors: smoke is lit by the scene, so it darkens at night
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
    this.uniforms = { scale: { value: 1 }, cap: { value: cap } };
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
    for (let k = 0; k < 3; k++) {
      this.c0[i3 + k] = color[0][k] * this.shade;
      this.c1[i3 + k] = color[1][k] * this.shade;
    }
  }

  clear() {
    this.life.fill(0);
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
const WIND = new THREE.Vector3(0.45, 0.85, 0.25).normalize(); // plumes rise and lean downwind
const v = new THREE.Vector3(), jitter = new THREE.Vector3();
const spot = new THREE.Vector3(), dir = new THREE.Vector3(), mid = new THREE.Vector3(), view = new THREE.Vector3(), side = new THREE.Vector3(), normal = new THREE.Vector3();
const BEAM_LIFE = 0.09, BEAM_WIDTH = 0.25, LIGHT_LIFE = 0.08;

/** Gradient drawn once on a canvas: `stops` maps 0..1 across the canvas to alpha. */
function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  return new THREE.CanvasTexture(canvas);
}

/** Gain on `hot` materials: above 1 in High quality, so they cross the bloom threshold. */
export const HOT = { value: 1 };
/** Has a basic material's color scaled by HOT. */
export function hot(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hot = HOT;
    shader.fragmentShader = `uniform float hot;\n${shader.fragmentShader}`.replace('#include <opaque_fragment>', 'outgoingLight *= hot;\n#include <opaque_fragment>');
  };
  return material;
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
        hot(new THREE.MeshBasicMaterial({ map: texture, color: 0xffe2a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })),
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
/** Projectiles, pooled: a dark body along the flight with a glowing core. */
class Shells {
  constructor(scene, count = 64) {
    const geometry = new THREE.CylinderGeometry(0.1, 0.13, 0.8, 6).rotateX(Math.PI / 2); // along Z
    const material = new THREE.MeshLambertMaterial({ color: 0x2a2c30, flatShading: true });
    this.items = Array.from({ length: count }, () => {
      const mesh = new THREE.Mesh(geometry, material);
      const core = mesh.add(halo(0xffb060, 1.4)).children.at(-1);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, core };
    });
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
const REPAIR = [[0.75, 1, 0.8], [0.25, 1, 0.5]];
const EMBER = [[1, 0.78, 0.38], [0.9, 0.2, 0.02]];
const STATIC = [[0.45, 0.75, 1], [0.1, 0.25, 1]];

export class Effects {
  constructor(scene) {
    this.glow = new Pool(scene, 1500, THREE.AdditiveBlending);
    this.soft = new Pool(scene, 800, THREE.NormalBlending);
    // Sparks and cinders: tiny, many, and never bigger than a few pixels however close.
    this.embers = new Pool(scene, 800, THREE.AdditiveBlending, 0.012);
    this.beams = new Beams(scene);
    this.shells = new Shells(scene);
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

  /** Drops every particle in flight (a map change: last map's smoke shouldn't hang in the new sky). */
  clear() {
    for (const pool of [this.glow, this.soft, this.embers]) pool.clear();
  }

  /** Smoke and dust are lit by the scene, so they darken at night; fire and sparks glow regardless. */
  setNight(night) {
    this.soft.shade = night ? 0.3 : 1;
  }

  /** `height` is the drawing buffer height in pixels; point sizes are in meters. */
  update(dt, camera, height) {
    const scale = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.glow.update(dt, scale);
    this.soft.update(dt, scale);
    this.embers.update(dt, scale);
    this.beams.update(dt, camera);
    for (const l of this.lights) {
      l.life = Math.max(0, l.life - dt);
      l.light.intensity = (l.life / LIGHT_LIFE) * 60;
    }
  }

  beam(from, to) {
    this.beams.spawn(from, to);
  }

  /** A flash's light at `p`; `own` marks the player's own guns (the cockpit lights those itself). */
  muzzleLight(p, own = false) {
    const l = this.lights[this.nextLight];
    this.nextLight = (this.nextLight + 1) % this.lights.length;
    l.light.position.copy(p);
    l.life = LIGHT_LIFE;
    l.own = own;
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

  /** A mech's death at scale 1; secondary-fire blasts pass their radius over 5. */
  explosion(p, scale = 1) {
    for (let i = 0; i < 40 * scale; i++) {
      this.glow.spawn(p, scatter(UP, rand(0, 3), 9 * scale), { life: rand(0.3, 0.7), size: [rand(1.5, 2.5) * scale, rand(3, 4.5) * scale], color: FIRE, drag: 3 });
    }
    for (let i = 0; i < 30 * scale; i++) {
      this.glow.spawn(p, scatter(UP, rand(4, 8), 14 * scale), { life: rand(0.4, 0.9), size: [0.3, 0.05], color: SPARK, gravity: 15, drag: 0.5 });
    }
    for (let i = 0; i < 20 * scale; i++) {
      this.soft.spawn(p, scatter(UP, rand(1, 3), 3 * scale), { life: rand(1.5, 2.8), size: [2 * scale, 6 * scale], color: [[0.25, 0.24, 0.22], [0.15, 0.15, 0.15]], alpha: 0.7, drag: 1.5 });
    }
  }

  /** EMP: a ring of blue sparks racing out to `radius`, and a flash at its core. */
  pulse(p, radius) {
    const life = 0.4;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      this.glow.spawn(p, v.set(Math.cos(a), rand(-0.08, 0.08), Math.sin(a)).multiplyScalar(radius / life), { life, size: [1.1, 0.5], color: STATIC });
    }
    for (let i = 0; i < 14; i++) this.glow.spawn(p, scatter(UP, 0, 5), { life: rand(0.15, 0.3), size: [1.5, 0.3], color: STATIC, drag: 4 });
  }

  /** A jammed mech's crackle: stray blue sparks around its chest `p`. */
  jam(p, dt) {
    for (let i = count(25, dt); i > 0; i--) {
      spot.set(rand(-1.5, 1.5), rand(-1.5, 1.5), rand(-1.5, 1.5)).add(p);
      this.glow.spawn(spot, scatter(UP, 0, 6), { life: rand(0.05, 0.12), size: [0.5, 0.1], color: STATIC });
    }
  }

  /**
   * This frame's projectiles, each { pos, vel, cls, age, primary, grenade }: primary fire is a
   * small hot slug with a short glow streak, rockets and darts burn with a smoke trail, mortar
   * shells (C) tumble dark with a blinking light, and grenades tumble small with a light that
   * blinks faster as the fuse runs down.
   */
  projectiles(list, dt) {
    this.shells.items.forEach((item, i) => {
      const p = list[i];
      item.mesh.visible = !!p;
      if (!p) return;
      item.mesh.position.copy(p.pos);
      item.mesh.lookAt(v.copy(p.pos).add(p.vel));
      if (p.grenade) {
        item.mesh.scale.setScalar(0.5);
        item.mesh.rotateX(p.age * 25);
        item.core.visible = (p.age * (4 + 6 * p.age)) % 1 < 0.5;
        item.core.material.color.setHex(0x70ffa0);
        return;
      }
      const shell = !p.primary && p.cls === 'C', dart = !p.primary && p.cls === 'A';
      item.mesh.scale.setScalar(p.primary ? 0.6 : dart ? 0.6 : shell ? 1.6 : 1);
      item.core.visible = !shell || (p.age * 6) % 1 < 0.5;
      item.core.material.color.setHex(p.primary ? 0xffe2a0 : shell ? 0xff4020 : 0xffb060);
      if (p.primary) {
        dir.copy(p.vel).normalize();
        for (let k = count(60, dt); k > 0; k--) this.glow.spawn(p.pos, scatter(dir, -2, 0.3), { life: 0.05, size: [0.5, 0.1], color: SPARK, drag: 4 });
        return;
      }
      if (shell) {
        if (Math.random() < dt * 8) this.soft.spawn(p.pos, scatter(UP, 0.3, 0.3), { life: 0.6, size: [0.4, 1.2], color: DUST, alpha: 0.3, drag: 2 });
        return;
      }
      dir.copy(p.vel).normalize();
      for (let k = count(dart ? 30 : 45, dt); k > 0; k--) {
        this.soft.spawn(p.pos, scatter(dir, -1, 0.3), { life: rand(0.3, dart ? 0.4 : 0.8), size: [0.35, dart ? 0.9 : 1.6], color: [[0.8, 0.8, 0.78], [0.6, 0.6, 0.6]], alpha: 0.45, drag: 2 });
      }
      for (let k = count(40, dt); k > 0; k--) this.glow.spawn(p.pos, scatter(dir, -6, 1), { life: 0.06, size: [dart ? 0.4 : 0.7, 0.1], color: FLAME, drag: 4 });
    });
  }

  /** Continuous rising smoke; `shade` 0 (black) to 1 (white): dark for wrecks, light for overheat steam. */
  smoke(p, dt, shade) {
    for (let i = count(14, dt); i > 0; i--) {
      this.soft.spawn(p, scatter(UP, rand(1.5, 3), 0.6), {
        life: rand(1.2, 2.2), size: [0.8, 3.5], color: [[shade, shade, shade], [shade * 0.8, shade * 0.8, shade * 0.8]], alpha: 0.5, drag: 0.8,
      });
    }
  }

  /** A smokestack's plume at `p`: big, slow, dark puffs that drift downwind as they spread. */
  plume(p, dt) {
    for (let i = count(6, dt); i > 0; i--) {
      this.soft.spawn(p, scatter(WIND, rand(2.5, 4), 0.4), {
        life: rand(5, 7), size: [rand(3, 4), rand(12, 16)], color: [[0.42, 0.4, 0.38], [0.62, 0.6, 0.58]], alpha: 0.35, drag: 0.15,
      });
    }
  }

  /** Sparks rising from a stack or furnace at `p`, `rate` a second, drifting downwind as they cool. */
  sparks(p, dt, rate) {
    for (let i = count(rate, dt); i > 0; i--) {
      spot.set(p.x + rand(-1.5, 1.5), p.y, p.z + rand(-1.5, 1.5));
      this.embers.spawn(spot, scatter(WIND, rand(2, 5), 1.2), { life: rand(2, 3.5), size: [rand(0.25, 0.4), 0.05], color: EMBER, drag: 0.2 });
    }
  }

  /** Cinders adrift in the air around `p` (the camera): slow, wind-borne, fading as they cool. */
  cinders(p, dt) {
    for (let i = count(80, dt); i > 0; i--) {
      spot.set(p.x + rand(-35, 35), p.y + rand(-6, 14), p.z + rand(-35, 35));
      this.embers.spawn(spot, scatter(WIND, rand(0.5, 1.5), 0.6), { life: rand(3, 5), size: [rand(0.2, 0.35), 0.05], color: EMBER, drag: 0.1 });
    }
  }

  /**
   * Dash exhaust at `p` this frame, blowing along `dir`: lingering grey smoke that spreads as it
   * fades, so a dash leaves a trail along its path; `hot` adds jet flame (the first moments).
   */
  dashTrail(p, dir, dt, hot) {
    for (let i = count(130, dt); i > 0; i--) {
      this.soft.spawn(p, scatter(dir, rand(0.4, 1.2), 0.5), {
        life: rand(0.42, 0.58), size: [rand(1.4, 2), rand(4.5, 6.5)], color: [[0.78, 0.78, 0.76], [0.55, 0.55, 0.55]], alpha: 0.6, drag: 1.5,
      });
    }
    if (hot) for (let i = count(60, dt); i > 0; i--) this.glow.spawn(p, scatter(dir, rand(6, 12), 1.5), { life: rand(0.06, 0.12), size: [0.8, 0.2], color: FLAME, drag: 5 });
  }

  dust(p) {
    for (let i = 0; i < 4; i++) this.soft.spawn(p, scatter(UP, 0.8, 1.6), { life: rand(0.4, 0.8), size: [0.4, 1.4], color: DUST, alpha: 0.35, drag: 3 });
  }

  /** Repair beam landing on a hull: green motes drifting up off it. */
  repair(p, dt) {
    for (let i = count(40, dt); i > 0; i--) this.glow.spawn(p, scatter(UP, rand(0.5, 2), 1.5), { life: rand(0.3, 0.6), size: [0.3, 0.05], color: REPAIR, drag: 2 });
  }
}
