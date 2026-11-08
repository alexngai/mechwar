// How the cockpit rides the mech. The pilot's gaze holds steady (eyes do, and the aim must: shots
// go along the view), while the cabin round it moves. It rocks onto each planted foot as the weight
// shifts, and every footfall, landing, shot, hit and nearby blast jolts it, the pilot's head
// swinging on the seat behind (a spring) and settling. The world view goes where the head goes
// (`eye`, a shift that never turns the view, so the reticle stays true); the cockpit pass is drawn
// from the head as it sits in the cabin (`cabin`, `tilt`, `nod`), so the frame and dash are what
// visibly jolt and sway, as they would round a strapped-in pilot.
import * as THREE from 'three';

// The head on the seat: a spring of HEAD_HZ, damped to HEAD_DAMP of critical, so a jolt overshoots
// once, a little, and settles. The cabin's roll and pitch about the eye are springs too.
const HEAD_HZ = 3, HEAD_DAMP = 0.45;
const TIP_HZ = 2.2, TIP_DAMP = 0.5;
const SUBSTEP = 1 / 120; // s: the springs' largest step, so slow frames don't blow them up
// Per class, at the peak: m of head travel for a footfall and a landing (an ordinary jump's; a
// longer fall jolts up to twice as hard), the weight shift's sway either side (m), and how far the
// cabin rolls into it and kicks over on a footfall (rad). The Light skips; the Heavy lumbers.
const FEEL = {
  A: { step: 0.008, land: 0.035, sway: 0.02, lean: 0.005, stomp: 0.0025 },
  B: { step: 0.012, land: 0.045, sway: 0.03, lean: 0.007, stomp: 0.0035 },
  C: { step: 0.02, land: 0.06, sway: 0.045, lean: 0.011, stomp: 0.005 },
};
// A shot: m of head travel per degree of the weapon's aim kick (see `recoil` in main.js), thrown
// forward as the gun shoves the cabin back, and half as much up.
const SHOT = 0.005;
// Taking a hit, at full strength: m of head travel toward where it came from (the cabin is
// knocked away from it), and rad the cabin tips away from it (rolling from the side, pitching
// from ahead or behind).
const HIT = 0.03, HIT_TIP = 0.008;
// A blast shoves from up to BLAST_REACH of its radii away, harder the closer, as hard as a hit at
// its edge for a radius-5 blast (bigger ones up to half again).
const BLAST_REACH = 3;

/** A damped spring about 0: `x` its displacement, `v` its rate. */
class Spring {
  constructor(hz, damp) {
    this.w = 2 * Math.PI * hz;
    this.z = damp;
    // An impulse `v` peaks at gain * v / w (the first crest of the damped sine).
    const s = Math.sqrt(1 - damp * damp);
    this.gain = Math.exp((-damp / s) * Math.atan(s / damp));
    this.x = 0;
    this.v = 0;
  }

  /** Strikes it so it swings out to `peak` (signed) before coming back. */
  kick(peak) {
    this.v += (peak * this.w) / this.gain;
  }

  step(dt) {
    const { w, z } = this;
    for (let n = Math.ceil(dt / SUBSTEP), h = dt / Math.max(n, 1); n > 0; n--) {
      this.v += (-w * w * this.x - 2 * z * w * this.v) * h;
      this.x += this.v * h;
    }
  }

  reset() {
    this.x = this.v = 0;
  }
}

const q = new THREE.Quaternion(), toward = new THREE.Vector3();

export class Ride {
  constructor() {
    // The head's travel from where it sits in the cabin, in view space (x right, y up, z back).
    this.head = [new Spring(HEAD_HZ, HEAD_DAMP), new Spring(HEAD_HZ, HEAD_DAMP), new Spring(HEAD_HZ, HEAD_DAMP)];
    this.roll = new Spring(TIP_HZ, TIP_DAMP);
    this.pitch = new Spring(TIP_HZ, TIP_DAMP);
    this.cls = 'B';
    this.shift = 0; // where the weight is, -1 on the left foot to 1 on the right, eased
    /** Where the eye sits off the cabin's eye point, in view space: shift the world camera by it. */
    this.eye = new THREE.Vector3();
    /** Where the head sits in the cabin, in view space: the cockpit camera's position. */
    this.cabin = new THREE.Vector3();
    /** The cabin's roll about the eye, rad, counterclockwise as the pilot sees it. */
    this.tilt = 0;
    /** The cabin's pitch about the eye, rad, nose up. */
    this.nod = 0;
  }

  get feel() {
    return FEEL[this.cls] ?? FEEL.B;
  }

  /** Kicks the head by `x`, `y`, `z` m (view space), and the cabin's roll by `roll` and pitch by `pitch` rad. */
  jolt(x, y, z, roll = 0, pitch = 0) {
    const [hx, hy, hz] = this.head;
    hx.kick(x);
    hy.kick(y);
    hz.kick(z);
    this.roll.kick(roll);
    this.pitch.kick(pitch);
  }

  /** A shot from a gun whose aim kick is `kick` degrees: the head's thrown forward and a touch up. */
  shot(kick) {
    this.jolt(0, SHOT * kick * 0.5, -SHOT * kick);
  }

  /**
   * Knocked by something at `from` (world space; null if it can't be told, when the knock comes
   * from any side) as hard as `strength` (1 a hit), seen from `camera`: the cabin's thrown away
   * from it, so the head swings toward it, and the cabin tips away.
   */
  shove(from, strength, camera) {
    if (from) toward.subVectors(from, camera.position);
    else toward.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    toward.applyQuaternion(q.copy(camera.quaternion).invert());
    toward.y *= 0.4; // a knock rocks the cabin far more than it lifts it
    if (toward.lengthSq() < 1e-6) toward.set(0, 0, -1);
    toward.normalize();
    const k = HIT * strength, tip = HIT_TIP * strength;
    // Knocked from the left, its right side dips; from ahead, its nose lifts.
    this.jolt(toward.x * k, toward.y * k, toward.z * k, toward.x * tip, -toward.z * tip);
  }

  /** A blast of `radius` m at `at` (world space), seen from `camera`. */
  blast(at, radius, camera) {
    const d = at.distanceTo(camera.position), reach = radius * BLAST_REACH;
    if (d >= reach) return;
    this.shove(at, (1 - d / reach) * THREE.MathUtils.clamp(radius / 5, 0.4, 1.5) * 1.5, camera);
  }

  /**
   * Follows our own `mech` (its `footfall`, `landed`, `pace` and `phase`, so call this once a
   * frame after its update) for `dt` s, the jolts scaled by `bounce` and the weight shift by
   * `sway` (tuning.json's ride_bounce and ride_sway; 0 turns either off), and sets `eye`, `cabin`,
   * `tilt` and `nod`.
   */
  update(dt, mech, bounce, sway) {
    this.cls = mech.cls;
    const f = this.feel;
    // A footfall comes down as the body bottoms out; the head carries on down into the seat, and
    // the cabin kicks over toward the planted foot.
    if (mech.footfall) this.jolt(0, -f.step, 0, -mech.footfall * f.stomp);
    if (mech.landed) this.jolt(0, -f.land * THREE.MathUtils.clamp(mech.landed / 1.2, 0.6, 2), 0);
    for (const s of [...this.head, this.roll, this.pitch]) s.step(dt);
    // Leg i is in the air while sin(phase + i pi) > 0 (see Mech update): the weight's on the right
    // foot (legs[1]) as sin(phase) climbs over 0 and on the left as it drops under.
    this.shift += (Math.sin(mech.phase) * mech.pace - this.shift) * (1 - Math.exp(-8 * dt));
    const [hx, hy, hz] = this.head;
    this.cabin.set(hx.x, hy.x, hz.x).multiplyScalar(bounce);
    this.eye.copy(this.cabin).x += this.shift * f.sway * sway;
    this.tilt = this.roll.x * bounce - this.shift * f.lean * sway;
    this.nod = this.pitch.x * bounce;
  }
}
