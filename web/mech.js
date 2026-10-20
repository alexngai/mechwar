// Original procedural mech: a reverse-joint walker built from boxes and posed every frame from
// sim state. It's rigid parts on joints, so there's no skinned mesh; legs use two-bone IK.
import * as THREE from 'three';

// Hull paint by team: -1 offline, 0 blue, 1 red.
const PAINT = { '-1': 0x8a8f5c, 0: 0x4f6f8f, 1: 0x8f4f4a };
const trimMat = new THREE.MeshLambertMaterial({ color: 0x2f3236, flatShading: true });
const jointMat = new THREE.MeshLambertMaterial({ color: 0x1b1d20, flatShading: true });
const glowMat = new THREE.MeshBasicMaterial({ color: 0x7fe0ff });

// Model space: meters at mech_height 5, feet at y = 0, facing -Z.
const HIP_Y = 2.9, HIP_X = 0.72, THIGH = 1.75, SHIN = 1.7, ANKLE_Y = 0.3;
const UP = new THREE.Vector3(0, 1, 0);
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), local = new THREE.Vector3(), moveDir = new THREE.Vector3();
const pole = new THREE.Vector3(), world = new THREE.Vector3(), flame = new THREE.Vector3();

const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
const clamp = THREE.MathUtils.clamp;

/** Stretch a segment mesh (built along Y) from a to b. */
function place(mesh, a, b) {
  mesh.position.lerpVectors(a, b, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, v1.subVectors(b, a).normalize());
}

/** Two-bone IK: the joint for a chain of lengths a and b from `root` to `end`, bending toward `bendDir`. */
function solveJoint(root, end, a, b, bendDir, out) {
  const d = v1.subVectors(end, root);
  const len = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  d.normalize();
  const along = (a * a - b * b + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(a * a - along * along, 0));
  const bend = v2.copy(bendDir).addScaledVector(d, -bendDir.dot(d)).normalize();
  return out.copy(root).addScaledVector(d, along).addScaledVector(bend, h);
}

export class Mech {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;
    this.team = -1;
    this.hull = new THREE.MeshLambertMaterial({ color: PAINT[-1], flatShading: true });
    this.barrels = new THREE.MeshLambertMaterial({ color: 0x2a2c30, flatShading: true });
    this.nozzleMat = new THREE.MeshLambertMaterial({ color: 0x3a2f28, flatShading: true });
    this.t = 0;
    this.phase = 0;
    this.squash = 0;
    this.airTime = 0;
    this.grounded = true;
    this.alive = true;
    this.wreck = 0;
    this.flash = 0;
    this.dodgeRoll = 0;
    this.nextGun = 0;
    this.tracerLife = 0;

    const root = (this.root = new THREE.Group());
    const body = (this.body = new THREE.Group());
    body.position.y = HIP_Y;
    root.add(body);
    const part = (mesh, x, y, z, rx = 0) => {
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      body.add(mesh);
      return mesh;
    };
    part(box(1.5, 0.5, 1.2, jointMat), 0, 0, 0.05); // hip block
    part(box(2.2, 1.1, 1.8, this.hull), 0, 0.8, 0.1); // main hull
    part(box(2.0, 0.7, 1.0, this.hull), 0, 0.75, -0.95, 0.45); // sloped nose
    part(box(1.3, 0.16, 0.06, glowMat), 0, 0.95, -1.38, 0.45); // visor slit
    part(box(1.7, 0.3, 1.4, this.hull), 0, 1.45, 0.25, -0.06); // roof plate
    part(box(1.3, 1.0, 0.7, trimMat), 0, 0.85, 1.3); // backpack
    part(box(0.06, 0.9, 0.06, trimMat), -0.75, 1.95, 0.7); // antenna

    // Thruster nozzles under the backpack; `exit` marks where flame leaves.
    this.nozzles = [-0.4, 0.4].map((x) => {
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 0.45, 8), this.nozzleMat);
      nozzle.position.set(x, 0.35, 1.55);
      nozzle.rotation.x = -0.6;
      body.add(nozzle);
      const exit = new THREE.Object3D();
      exit.position.y = -0.3;
      nozzle.add(exit);
      return exit;
    });

    // Weapon pods pitch with aim and fire alternately.
    this.guns = [-1, 1].map((side) => {
      const pod = new THREE.Group();
      pod.position.set(side * 1.45, 0.9, -0.1);
      body.add(pod);
      pod.add(box(0.55, 0.6, 1.3, this.hull));
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 1.4, 8), this.barrels);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, -0.05, -1.3);
      pod.add(barrel);
      const tip = new THREE.Object3D();
      tip.position.set(0, -0.05, -2.0);
      pod.add(tip);
      return { pod, tip };
    });

    // Legs live in root space and are re-solved every frame.
    this.legs = [-1, 1].map((side, i) => {
      const thigh = box(0.42, THIGH, 0.55, this.hull);
      const shin = box(0.3, SHIN, 0.36, trimMat);
      const knee = box(0.48, 0.48, 0.48, jointMat);
      const foot = new THREE.Group();
      const sole = box(0.75, 0.24, 1.3, trimMat);
      sole.position.set(0, 0.12, -0.2);
      const heel = box(0.3, 0.2, 0.45, jointMat);
      heel.position.set(0, 0.1, 0.55);
      foot.add(sole, heel);
      root.add(thigh, shin, knee, foot);
      return {
        side, i, thigh, shin, knee, foot, lifted: false,
        target: new THREE.Vector3(side * 0.85, 0, -0.1),
        hip: new THREE.Vector3(), ankle: new THREE.Vector3(), joint: new THREE.Vector3(),
      };
    });

    this.tracer = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xfff0a0 }),
    );
    this.tracer.frustumCulled = false; // setFromPoints doesn't refresh the bounding sphere
    this.tracer.visible = false;
    scene.add(root, this.tracer);
  }

  setTeam(team) {
    this.team = team;
  }

  /**
   * Pose from sim state: { pos, yaw, pitch, scale, vel, grounded, boosting, hovering, health,
   * heat (0-1), overheated }. Also emits thruster, footstep, smoke and death effects.
   */
  update(dt, s) {
    this.t += dt;
    const { root, body } = this;
    root.position.copy(s.pos);
    root.rotation.y = s.yaw;
    root.scale.setScalar(s.scale);

    const alive = s.health > 0;
    if (this.alive && !alive) this.fx.explosion(world.copy(s.pos).addScaledVector(UP, 3 * s.scale));
    this.alive = alive;
    this.wreck = alive ? 0 : Math.min(1, this.wreck + dt * 2);

    // Gait: one full step cycle covers two strides; stride grows with speed so feet don't slide.
    local.copy(s.vel).applyAxisAngle(UP, -s.yaw).divideScalar(s.scale);
    const speed = Math.hypot(local.x, local.z);
    const grounded = alive && s.grounded;
    const moving = grounded && speed > 0.6;
    const stride = clamp(speed * 0.12, 0.3, 1.4);
    if (moving) this.phase += ((Math.PI * speed) / (2 * stride)) * dt;
    moveDir.set(local.x, 0, local.z).normalize();

    if (grounded && !this.grounded && this.airTime > 0.3) this.squash = Math.min(0.5, this.airTime * 0.3);
    this.airTime = grounded ? 0 : this.airTime + dt;
    this.grounded = grounded;
    this.squash = Math.max(0, this.squash - dt * 2);
    this.dodgeRoll = damp(this.dodgeRoll, 0, 4, dt);
    this.flash = Math.max(0, this.flash - dt * 6);

    // Body bobs with the gait, leans into motion, sinks on landing and slumps when destroyed.
    const bob = moving ? 0.08 * (1 - Math.cos(2 * this.phase)) * Math.min(speed / 6, 1) : 0;
    const sway = alive && s.hovering ? 0.06 * Math.sin(this.t * 5) : 0;
    body.position.y = HIP_Y - bob - this.squash * 0.6 - this.wreck * 1.5 + sway;
    body.rotation.x = damp(body.rotation.x, alive ? clamp(local.z / 16, -1, 1) * 0.25 : -0.45 * this.wreck, 6, dt);
    body.rotation.z = damp(body.rotation.z, alive ? -clamp(local.x / 16, -1, 1) * 0.2 + this.dodgeRoll : 0.25 * this.wreck, 8, dt);
    for (const gun of this.guns) gun.pod.rotation.x = alive ? s.pitch - body.rotation.x : -0.5;

    // Feet swing forward in the air and slide back while planted; knees point backward.
    for (const leg of this.legs) {
      const p = this.phase + leg.i * Math.PI;
      let x = leg.side * 0.85, y = 0, z = -0.1;
      if (!alive) {
        x = leg.side * 1.25;
        z = -0.4;
      } else if (!grounded) {
        x = leg.side * 0.9;
        y = s.hovering ? 1.1 : 0.55;
        z = 0.3;
      } else if (moving) {
        const reach = -Math.cos(p) * stride, lift = Math.max(0, Math.sin(p));
        x += moveDir.x * reach;
        z += moveDir.z * reach;
        y = lift * 0.5 * Math.min(speed / 4, 1);
        if (leg.lifted && lift === 0) this.fx.dust(leg.foot.getWorldPosition(world));
        leg.lifted = lift > 0;
      }
      const rate = moving ? 30 : 10;
      leg.target.set(damp(leg.target.x, x, rate, dt), damp(leg.target.y, y, rate, dt), damp(leg.target.z, z, rate, dt));
      leg.hip.set(leg.side * HIP_X, body.position.y, 0);
      leg.ankle.copy(leg.target).y += ANKLE_Y;
      solveJoint(leg.hip, leg.ankle, THIGH, SHIN, pole.set(leg.side * 0.2, 0, 1), leg.joint);
      place(leg.thigh, leg.hip, leg.joint);
      place(leg.shin, leg.joint, leg.ankle);
      leg.knee.position.copy(leg.joint);
      leg.foot.position.copy(leg.target);
      leg.foot.rotation.x = alive && leg.target.y > 0.05 ? -0.3 : 0;
    }

    root.updateMatrixWorld(true);
    const thrusting = alive && (s.boosting || s.hovering);
    this.nozzleMat.emissive.setRGB(thrusting ? 1 : 0.15, thrusting ? 0.45 : 0.05, 0);
    if (thrusting) {
      // Boost pushes flame back, hover straight down.
      if (s.hovering) flame.set(0, -1, 0.15).normalize();
      else flame.set(0, -0.35, 1).normalize().applyQuaternion(root.quaternion);
      for (const exit of this.nozzles) this.fx.thrust(exit.getWorldPosition(world), flame, s.hovering ? 1.4 : 1, dt);
    }
    if (!alive) this.fx.smoke(world.copy(s.pos).addScaledVector(UP, 2.2 * s.scale), dt, 0.18);
    if (alive && s.overheated) for (const gun of this.guns) this.fx.smoke(gun.tip.getWorldPosition(world), dt, 0.75);

    const heat = Math.max(s.heat ?? 0, 0);
    this.barrels.emissive.setRGB(heat * 0.9, heat * 0.25, heat * 0.05);
    this.hull.color.setHex(PAINT[this.team] ?? PAINT[-1]).multiplyScalar(1 - 0.75 * this.wreck);
    this.hull.emissive.setScalar(this.flash * 0.7);
    this.tracerLife -= dt;
    this.tracer.visible = this.tracerLife > 0;
  }

  /** Muzzle flash and tracer from the next barrel to `end`, with sparks there. */
  fire(end) {
    const gun = this.guns[(this.nextGun ^= 1)];
    const from = gun.tip.getWorldPosition(world);
    this.tracer.geometry.setFromPoints([from, end]);
    this.tracerLife = 0.06;
    this.fx.muzzle(from, flame.subVectors(end, from).normalize());
    this.fx.impact(end);
  }

  hit() {
    this.flash = 1;
  }

  /** Side-jet burst and a roll toward `dir` (-1 left, +1 right). */
  dodge(dir) {
    this.dodgeRoll = -dir * 0.4;
    this.fx.burst(this.body.getWorldPosition(world), flame.set(-dir, 0, 0).applyQuaternion(this.root.quaternion));
  }

  dispose() {
    this.scene.remove(this.root, this.tracer);
    this.root.traverse((o) => o.geometry?.dispose());
    for (const m of [this.hull, this.barrels, this.nozzleMat]) m.dispose();
  }
}
