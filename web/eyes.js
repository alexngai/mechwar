// The pilot's eyes adjust to the light they look into, as a camera's auto exposure does: step out
// of a dark hall into the sun and the view glares, then settles; step in out of it and the hall
// stays murky till the eyes open up; a blast's flash leaves the view dimmed a moment after; the
// sun in the view darkens the ground under it. Only the exposure moves, and only part of the way
// (`strength`, tuning.json's eye_adapt): a dark hall still looks darker than the yard.
//
// What's in view is metered with rays, lit as the arena is lit: a grid over the view, each ray
// that lands on a surface reading the sky's ambient there, the sun's (or moon's) light unless
// something stands between (with shadows on: Low draws none), the palette's `cover` shade under a
// roof and night lamps' baked pools. The readings are averaged in stops, the middle counting most,
// a few rays a frame; rays into the sky don't count, so looking up changes nothing. Open ground in
// the sun (by night, in a lamp's pool) reads as the map's own exposure, so there each map looks as
// it was tuned.
import * as THREE from 'three';

// The grid, as fractions of the view's half-width and half-height, and each ray's weight.
const GRID = [[0, 0, 4], [-0.5, 0, 2], [0.5, 0, 2], [0, 0.45, 2], [0, -0.45, 2], [-0.6, 0.5, 1], [0.6, 0.5, 1], [-0.6, -0.5, 1], [0.6, -0.5, 1]];
const PER_FRAME = 3; // grid rays cast each frame, in turn
const REACH = 200; // m a view ray looks
const SUN_REACH = 150; // m a ray toward the sun looks for something in the way
const COVER_REACH = 30; // m overhead that counts as a roof (as arena.js bakes `cover`)
const SUN_SHARE = 0.6; // of the sun's light a lit surface takes, on average over its slants
const LAMP_SHARE = 0.5; // of a lamp's pool at a ray's landing (it ignores facing and shadow)
// Night maps are lit for play by their lamps: their own exposure was set for ground in a lamp's
// pool, about this bright (a street lamp's 6 m out), on top of the moonlight.
const NIGHT_POOL = 0.3;
const SEEN = [-2, 2]; // stops each reading is kept within, as a meter's are
// By day the sun, unshaded, at the middle of the view adds GLARE (against a lit surface), fading
// out GLARE_ANGLE degrees off it.
const GLARE = 3, GLARE_ANGLE = 25;
const LIGHT_TAU = 0.3, DARK_TAU = 1.8; // s: eyes stop down fast and open up slowly
const OVER = 0.7, UNDER = 0.5; // stops the exposure goes at most over, and under, the map's own
// A blast's flash at its own radius away (against a lit surface), falling off with the square of
// the distance past it, over FLASH_TAU s; less if it's behind us or round a corner.
const FLASH = 10, FLASH_TAU = 0.12;
const JUMP = 15; // m: a camera move this big in a frame (a respawn, the killcam) skips adjusting

const dir = new THREE.Vector3(), at = new THREE.Vector3(), ahead = new THREE.Vector3();

export class Eyes {
  /** `cast(x, y, z, dx, dy, dz, max)` is how far a ray goes into the arena, `max` if it hits nothing. */
  constructor(cast) {
    this.cast = cast;
    this.seen = GRID.map(() => null); // each grid ray's reading, in stops over open ground in the sun; null in the sky
    this.next = 0;
    this.adapted = 0; // stops the eyes are set for, likewise
    this.flashes = 0; // light from blasts' flashes, against open ground in the sun, fading
    this.base = 1;
    this.ambient = this.direct = this.ref = 1;
    this.cover = 1;
    this.night = false;
    this.lamps = [];
    this.shadows = true;
    this.snap = true;
    this.was = new THREE.Vector3();
  }

  /**
   * A new map: its own `exposure`, the palette's `light` ({ ambient, direct }, the hemisphere and
   * sun intensities) and `cover`, whether it's `night` and its baked `lamps` (arena.js's
   * { at, rgb, radius, power }).
   */
  setMap(exposure, light, cover, night, lamps) {
    this.base = exposure;
    // Lambert paint under a light of intensity I shows I / pi of its color (under a lamp's pool, k).
    this.ambient = light.ambient / Math.PI;
    this.direct = (light.direct / Math.PI) * SUN_SHARE;
    this.ref = this.ambient + this.direct + (night ? LAMP_SHARE * NIGHT_POOL : 0);
    this.cover = cover;
    this.night = night;
    this.lamps = lamps;
    this.snap = true;
  }

  /** Whether the sun casts shadows (High): without, it lights every surface it faces. */
  setShadows(on) {
    this.shadows = on;
  }

  /** A blast of `radius` m at `p`, seen from `camera`. */
  flash(p, radius, camera) {
    dir.subVectors(p, camera.position);
    const d = dir.length(), k = FLASH * (radius / Math.max(d, radius)) ** 2;
    if (k < 0.05) return;
    dir.divideScalar(d);
    const facing = 0.35 + 0.65 * Math.max(0, dir.dot(camera.getWorldDirection(ahead)));
    const { x, y, z } = camera.position;
    const open = this.cast(x, y, z, dir.x, dir.y, dir.z, d) >= d - 0.5 ? 1 : 0.3;
    this.flashes += k * facing * open;
  }

  /** How bright the arena is at `p`, against the map's own exposure's ground (see `ref`). */
  surface(p, sunDir) {
    const { x, y, z } = p;
    let light = this.ambient;
    if (!this.shadows || this.cast(x, y, z, sunDir.x, sunDir.y, sunDir.z, SUN_REACH) >= SUN_REACH) light += this.direct;
    let pools = 0;
    for (const l of this.lamps) {
      const d = l.at.distanceTo(p);
      if (d < l.radius) pools += l.power * (1 - d / l.radius) ** 2 * (0.3 * l.rgb.r + 0.6 * l.rgb.g + 0.1 * l.rgb.b);
    }
    light += LAMP_SHARE * pools;
    if (this.cover < 1 && this.cast(x, y, z, 0, 1, 0, COVER_REACH) < COVER_REACH) light *= this.cover;
    return light / this.ref;
  }

  /** Re-reads grid ray `i` from `camera`. */
  meter(i, camera, sunDir) {
    const [u, v] = GRID[i], tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    dir.set(u * tan * camera.aspect, v * tan, -1).normalize().applyQuaternion(camera.quaternion);
    const { x, y, z } = camera.position;
    const d = this.cast(x, y, z, dir.x, dir.y, dir.z, REACH);
    // Read just short of where it lands, so rays from there don't start inside the surface.
    this.seen[i] = d >= REACH ? null : THREE.MathUtils.clamp(Math.log2(Math.max(this.surface(at.copy(camera.position).addScaledVector(dir, Math.max(d - 0.3, 0)), sunDir), 1e-3)), SEEN[0], SEEN[1]);
  }

  /**
   * Meters the view from `camera` (placed for this frame) with the sun along `sunDir`, adjusts
   * over `dt` s, and returns the exposure to draw it at.
   */
  update(dt, camera, sunDir, strength) {
    const jumped = this.snap || camera.position.distanceTo(this.was) > JUMP;
    this.was.copy(camera.position);
    for (let n = jumped ? GRID.length : PER_FRAME; n > 0; n--) {
      this.meter(this.next, camera, sunDir);
      this.next = (this.next + 1) % GRID.length;
    }
    let sum = 0, weights = 0;
    GRID.forEach(([, , w], i) => {
      if (this.seen[i] === null) return;
      sum += w * this.seen[i];
      weights += w;
    });
    let lum = 2 ** (weights ? sum / weights : 0) + this.flashes;
    this.flashes *= Math.exp(-dt / FLASH_TAU);
    if (!this.night) {
      const off = camera.getWorldDirection(ahead).dot(sunDir), edge = Math.cos(THREE.MathUtils.degToRad(GLARE_ANGLE));
      const { x, y, z } = camera.position;
      if (off > edge && this.cast(x, y, z, sunDir.x, sunDir.y, sunDir.z, SUN_REACH) >= SUN_REACH) lum += GLARE * ((off - edge) / (1 - edge)) ** 2;
    }
    const seen = Math.log2(lum);
    if (jumped) this.adapted = seen;
    else this.adapted += (seen - this.adapted) * (1 - Math.exp(-dt / (seen > this.adapted ? LIGHT_TAU : DARK_TAU)));
    this.snap = false;
    return this.base * 2 ** THREE.MathUtils.clamp(-strength * this.adapted, -UNDER, OVER);
  }
}
