// The objective modes on the client.
// - Capture zones (Missile Assault's silos, Siege's AA gun): a ring on the ground and a beacon into
//   the sky in the color of whoever holds it (our side blue, theirs red, nobody white), and the
//   capture's progress as a second ring filling in.
// - Missile Assault: each silo's launch pad (hatch doors, lamps in its holder's color), whose rocket
//   climbs slowly out of the tube when it fires, turns over and dives onto the enemy base.
// - Siege: the energy station (green, filling with what it holds), dropped energy, each base's drop
//   zone, the AA gun (a twin-barrelled flak gun that turns on the enemy ship and fires on it while
//   its side holds the gun), and the battleships (deployables of kind 4) with the fire between them
//   and the bases, and their engines' drone; and the stage the match is at, as a line of text.
import * as THREE from 'three';
import { hot } from './fx.js';

const NEUTRAL = 0xd8dde6, ENERGY = 0x5dff9a;
/** Seconds a rocket flies, launch to impact; matches objective::MISSILE_FLIGHT. */
const FLIGHT = 10;
/**
 * The first RISE of the flight it climbs straight up out of its tube (TUBE m down) to RISE_HEIGHT
 * over the pad, slow at first; then it arcs over, topping out at least APEX over the pad, and dives.
 */
const RISE = 0.28, TUBE = 5, RISE_HEIGHT = 32, APEX = 60;
/** A pad's hatch stays open this long (ms) for a launch, its doors taking DOOR_MS to slide. */
const OPEN_MS = 3500, DOOR_MS = 600;
const UP = new THREE.Vector3(0, 1, 0);
const BEACON_HEIGHT = 60;
/** Match sim/src/siege.rs: STATION_CAP, AA_RANGE, DUEL_RANGE, BOMBARD_RANGE, BASE_RADIUS, LAUNCH_EU, BASE_HULL, SHIP_HULL. */
const STATION_CAP = 400, AA_RANGE = 150, DUEL_RANGE = 120, BOMBARD_RANGE = 6, BASE_RADIUS = 14, LAUNCH_EU = 500, BASE_HULL = 1000;
export const SHIP_HULL = 3000;
/** The AA gun fires a burst of AA_BURST rounds AA_GAP ms apart every AA_EVERY ms, while firing; it turns at AA_TURN rad/s. */
const AA_BURST = 4, AA_GAP = 110, AA_EVERY = 1000, AA_TURN = 1.6;
/** The deployable kinds of a battleship, and of a team mode's base gun. */
export const SHIP = 4, SENTRY = 5, HAULER = 6, WALKER = 7, ARC = 8, PULSE = 9, CRAWLER = 10, BRUTE = 11, MORTAR = 12, NODE = 13, EXCAVATOR = 14, HIVE = 15;
/** Co-op's lane enemies, and its bosses among them. */
export const FOES = [WALKER, CRAWLER, BRUTE, MORTAR, NODE, EXCAVATOR, HIVE];
export const BOSSES = [EXCAVATOR, HIVE];
/** Match defense.rs: the reactor's hull, and a walker's in wave `n`. */
export const REACTOR_HULL = 2000;
export const walkerHull = (n) => 100 + 12 * n;
/** Match defense.rs `species`: a lane enemy's hull in wave `n`, and (here) how high its middle is. */
// (A boss's, for a full team: it comes with less for fewer pilots, so its bar starts short of full then.)
export const foeHull = (kind, n) => ({ [CRAWLER]: 30 + 3 * n, [BRUTE]: 600 + 50 * n, [MORTAR]: 140 + 14 * n, [NODE]: 150 + 12 * n, [EXCAVATOR]: 3000, [HIVE]: 5000 })[kind] ?? walkerHull(n);
export const foeMiddle = (kind) => ({ [CRAWLER]: 0.6, [BRUTE]: 2.5, [MORTAR]: 1.8, [NODE]: 2.2, [EXCAVATOR]: 4, [HIVE]: 6 })[kind] ?? 2;
export const FOE_NAMES = { [WALKER]: 'Infested walker', [CRAWLER]: 'Crawler', [BRUTE]: 'Ore brute', [MORTAR]: 'Mortar walker', [NODE]: 'Shield node', [EXCAVATOR]: 'The Excavator', [HIVE]: 'The Hive walker' };
/** Match defense.rs: what pilots build (`TOWERS`, in Build::Place's order), their prices, their reach at tier 1 (m: tuning's turret ranges, game.rs's ARC_RANGE and PULSE_RADIUS) and how it grows a tier. */
export const TOWER_NAMES = ['MG tower', 'Rocket tower', 'Arc pylon', 'Pulse pylon'];
export const TOWER_PRICES = [100, 150, 175, 200];
const TOWER_REACH = [30, 45, 20, 14];
export const towerReach = (k, tier = 1) => TOWER_REACH[k] * (1 + 0.15 * (tier - 1));
/** Match game.rs SENTRY_SHIELD: a base gun's shield. */
export const SENTRY_SHIELD = 400;
/** A base gun's muzzles, this high over its foot (deploy::SENTRY_HEIGHT). */
export const SENTRY_HEIGHT = 5.5;

export class Objectives {
  /** `cast(ox, oy, oz, dx, dy, dz, max)`: how far a ray goes into the arena, up to `max`. */
  constructor(scene, fx, sound, cast) {
    Object.assign(this, { scene, fx, sound, cast, silos: [], aa: [], zones: [], labels: [], stations: [], dropZones: [], bases: [], missiles: [], ships: new Map(), sentries: new Map(), drops: [], stands: [], flags: [], walkers: new Map(), gates: [], reactor: null, pylons: new Map(), ghost: null, lanes: null, shells: [], cores: [], fire: {}, seen: null });
    this.dropGeometry = new THREE.OctahedronGeometry(0.6);
    this.dropMaterial = hot(new THREE.MeshBasicMaterial({ color: ENERGY }));
  }

  /** Builds the zones and stations of `map` (its JSON), clearing the last map's. */
  setMap(map) {
    const gone = (o) => {
      this.scene.remove(o);
      o.traverse((m) => { if (m.geometry !== this.dropGeometry) m.geometry?.dispose(); if (m.material !== this.dropMaterial) m.material?.dispose(); });
    };
    for (const z of [...this.silos, ...this.aa, ...this.stations, ...this.dropZones, ...this.stands]) gone(z.group);
    for (const f of this.flags) gone(f);
    for (const s of [...this.ships.values(), ...this.sentries.values()]) gone(s.group);
    if (this.hauler) gone(this.hauler.group);
    this.hauler = null;
    for (const w of [...(this.walkers?.values() ?? []), ...(this.pylons?.values() ?? [])]) gone(w.group);
    this.walkers = new Map();
    this.pylons = new Map();
    if (this.lanes) gone(this.lanes);
    this.lanes = null;
    for (const g of [...(this.gates ?? []), ...(this.reactor ? [this.reactor] : [])]) gone(g.group);
    // Co-op Defense: the reactor, and the gates the walkers come out of, fungus round their mouths.
    const d = map.objectives?.defense;
    this.reactor = d ? { group: reactorMesh(), at: new THREE.Vector3(...d.reactor) } : null;
    if (this.reactor) {
      this.reactor.group.position.copy(this.reactor.at);
      this.scene.add(this.reactor.group);
    }
    this.gates = (d?.gates ?? []).map((at) => ({ ...marker(this.scene, at, 5, FUNGUS), shown: null }));
    for (const m of [...this.missiles.map((m) => m.mesh), ...this.drops]) this.scene.remove(m);
    Object.assign(this, { missiles: [], ships: new Map(), sentries: new Map(), drops: [] });
    const o = map.objectives ?? {};
    this.bases = (o.bases ?? []).map((b) => new THREE.Vector3(...b));
    const zone = ({ at, radius, band }) => ({ ...marker(this.scene, at, radius, NEUTRAL), radius, band, shown: null, owner: -1 });
    this.silos = (o.silos ?? []).map((spot) => {
      // A launch pad, its beacon rising from it.
      const s = zone(spot), padAt = new THREE.Vector3(...(spot.pad ?? spot.at));
      s.pad = padMesh();
      s.pad.position.copy(padAt);
      s.group.add(s.pad);
      s.pad.position.sub(s.at);
      s.beacon.position.copy(s.pad.position).addScaledVector(UP, BEACON_HEIGHT / 2);
      return Object.assign(s, { padAt, launchAt: -Infinity, level: false });
    });
    this.aa = o.aa ? [zone(o.aa)] : [];
    for (const s of this.aa) {
      // The gun, its beacon rising from it.
      s.gun = aaMesh();
      s.gunAt = new THREE.Vector3(...(o.aa.pad ?? o.aa.at));
      s.gun.position.copy(s.gunAt).sub(s.at);
      s.group.add(s.gun);
      s.beacon.position.copy(s.gun.position).addScaledVector(UP, BEACON_HEIGHT / 2);
      Object.assign(s, { level: false, burstAt: -Infinity, rounds: 0, yaw: 0, pitch: 0.5 });
    }
    // Each base's drop zone: where energy carried home is banked.
    this.dropZones = this.bases.map((at) => ({ ...marker(this.scene, at.toArray(), BASE_RADIUS, ENERGY), shown: null }));
    for (const d of this.dropZones) fill(d, BASE_RADIUS, 0);
    this.seen = null;
    this.stations = (o.stations ?? []).map(({ at, radius, band }) => ({ ...marker(this.scene, at, radius, ENERGY), radius, band, shown: null }));
    this.sky = o.sky ?? 50;
    // Capture the Flag: each team's stand, a plinth in its zone, and its flag.
    this.stands = (o.flags ?? []).map(({ at, radius, band }) => {
      const s = { ...marker(this.scene, at, radius, NEUTRAL), radius, band, shown: null };
      s.group.add(plinthMesh());
      return s;
    });
    this.flags = this.stands.map(() => {
      const flag = flagMesh();
      this.scene.add(flag);
      return flag;
    });
  }

  /**
   * Capture the Flag from `ctf` (seven floats a flag, then the captures: see WasmNetClient.ctf),
   * for a player on `myTeam`: each stand in its side's color, filling as a raid on it gets on,
   * and each flag on its stand, over its carrier (`top(id)`: where over them, or null), or where
   * it lies. Hidden in other modes.
   */
  drawFlags(ctf, myTeam, friend, foe, top, now) {
    const on = ctf.length >= 14;
    this.stands.forEach((s, t) => {
      const flag = this.flags[t], color = t === myTeam ? friend : foe;
      s.group.visible = flag.visible = on;
      if (!on) return;
      const [state, by, x, y, z, taking] = ctf.subarray(7 * t, 7 * t + 6);
      for (const m of [s.ring, s.fill, s.beacon]) m.material.color.setHex(color);
      fill(s, s.radius, taking);
      if (state === 1) {
        const at = top(by);
        flag.visible = !!at;
        if (at) flag.position.copy(at);
      } else if (state === 2) flag.position.set(x, y, z);
      else flag.position.copy(s.at).y += PLINTH_HEIGHT;
      // Its beacon over the stand only while the flag's home.
      s.beacon.visible = state === 0;
      flag.userData.cloth.material.color.setHex(color);
      flag.userData.banner.rotation.y = 0.35 * Math.sin(now / 280 + 2 * t);
    });
  }

  /** Whether feet at `feet` stand in the enemy stand (of `myTeam`'s foe) while its flag's home: the raid's progress and whether it's held off, or null. */
  raiding(feet, ctf, myTeam) {
    const t = 1 - myTeam, s = this.stands[t];
    if (!s || ctf[7 * t] !== 0 || Math.hypot(feet.x - s.at.x, feet.z - s.at.z) > s.radius || Math.abs(feet.y - s.at.y) > s.band) return null;
    return { taking: ctf[7 * t + 5], contested: !!ctf[7 * t + 6] };
  }

  /**
   * Convoy's hauler from `list` (deployable floats), eased toward where the server has it, legs
   * striding as it walks (each landing a stomp), lights in the color of the side walking it
   * (`convoy`: see WasmNetClient.convoy) for a player on `myTeam`, blinking while both sides are
   * at it; dark and smoking while stalled.
   */
  drawHauler(list, convoy, myTeam, friend, foe, dt, now) {
    let i = 0;
    while (i < list.length && list[i] !== HAULER) i += 10;
    if (i >= list.length) {
      if (this.hauler) this.scene.remove(this.hauler.group);
      this.hauler = null;
      return;
    }
    const [, , , x, y, z, yaw, , , hull] = list.subarray(i, i + 10);
    let h = this.hauler;
    if (!h) {
      h = this.hauler = { group: haulerMesh(), yaw, gait: 0, lift: [0, 0, 0, 0], stalled: hull <= 0 };
      h.group.position.set(x, y, z);
      this.scene.add(h.group);
    }
    const { group } = h, before = group.position.clone();
    group.position.lerp(new THREE.Vector3(x, y, z), 1 - Math.exp(-10 * dt));
    h.yaw += Math.atan2(Math.sin(yaw - h.yaw), Math.cos(yaw - h.yaw)) * (1 - Math.exp(-4 * dt));
    group.rotation.y = h.yaw;
    // Diagonal pairs stride in turn, a foot sweeping back on the ground and swinging forward up in the air.
    h.gait += (Math.hypot(group.position.x - before.x, group.position.z - before.z) / HAULER_STRIDE) * Math.PI;
    group.userData.legs.forEach((leg, k) => {
      const p = h.gait + (k === 0 || k === 3 ? 0 : Math.PI), lift = Math.max(0, Math.sin(p)) * 1.1;
      leg.foot.set(leg.rest.x, lift, leg.rest.z + Math.cos(p) * HAULER_STRIDE * 0.5);
      if (h.lift[k] > 0.05 && lift <= 0.05) this.sound.step('hauler', leg.foot.clone().applyMatrix4(group.matrixWorld));
      h.lift[k] = lift;
      pose(leg);
    });
    const stalled = hull <= 0, top = group.position.clone().setY(group.position.y + HAULER_TOP);
    if (stalled !== h.stalled) {
      if (stalled) {
        this.sound.fieldDown(top);
        this.fx.explosion(top, 0.8);
      } else this.sound.deploy(top);
      h.stalled = stalled;
    }
    if (stalled) this.fx.smoke(top, dt, 0.15);
    const [, , pusher, , contested] = convoy;
    const blink = contested && Math.floor(now / 300) % 2;
    const color = stalled ? 0x1a1c20 : blink ? 0xffb347 : pusher < 0 || pusher === undefined ? NEUTRAL : pusher === myTeam ? friend : foe;
    for (const a of group.userData.accents) a.material.color.setHex(color);
  }

  /**
   * Co-op Defense from `defense` (see WasmNetClient.defense): the reactor glowing as its hull
   * holds (cold blue, guttering to red as it goes), and the gates' fungus pulsing, brighter during
   * a wave. Hidden in other modes.
   */
  drawDefense(defense, now) {
    const on = defense.length >= 5;
    if (this.reactor) this.reactor.group.visible = on;
    for (const g of this.gates) g.group.visible = on;
    if (!on) return;
    const [, , breakLeft, hull] = defense, health = Math.max(hull, 0) / REACTOR_HULL;
    const core = this.reactor?.group.userData.core;
    if (core) {
      core.material.color.setRGB(0.3 + 0.7 * (1 - health), 0.5 * health + 0.1, 0.9 * health + 0.1);
      core.scale.setScalar(0.9 + 0.1 * Math.sin(now / (120 + 400 * health)));
    }
    const pulse = 0.5 + 0.5 * Math.sin(now / (breakLeft < 0 ? 180 : 600));
    for (const g of this.gates) for (const m of [g.ring, g.fill, g.beacon]) m.material.opacity = 0.25 + 0.5 * pulse;
  }

  /**
   * Co-op's infested walkers from `list` (deployable floats): bodies eased to where the server has
   * them, faced the way they walk, legs striding; gun pods trained as the server has them (their
   * muzzles into `guns`, for shot effects); fungus pulsing on their hulls.
   */
  drawWalkers(list, dt, now, guns, wave = 1) {
    const live = new Set();
    for (let i = 0; i < list.length; i += 10) {
      const kind = list[i];
      if (!FOES.includes(kind)) continue;
      const [, , owner, x, y, z, yaw, pitch] = list.subarray(i, i + 8);
      let w = this.walkers.get(owner);
      if (!w) {
        w = { kind, group: ({ [CRAWLER]: crawlerMesh, [BRUTE]: bruteMesh, [MORTAR]: mortarMesh, [NODE]: nodeMesh, [EXCAVATOR]: excavatorMesh, [HIVE]: hiveMesh })[kind]?.() ?? walkerMesh(), heading: 0, gait: 0, aim: yaw, rear: 0 };
        w.group.position.set(x, y, z);
        this.scene.add(w.group);
        this.walkers.set(owner, w);
      }
      live.add(owner);
      const { group } = w, before = group.position.clone();
      group.position.lerp(new THREE.Vector3(x, y, z), 1 - Math.exp(-12 * dt));
      const dx = group.position.x - before.x, dz = group.position.z - before.z, moved = Math.hypot(dx, dz);
      if (moved > 1e-3) w.heading += Math.atan2(Math.sin(Math.atan2(-dx, -dz) - w.heading), Math.cos(Math.atan2(-dx, -dz) - w.heading)) * (1 - Math.exp(-6 * dt));
      group.rotation.y = w.heading;
      const { legs, stride, phases, pod, muzzle, body, fungus, drill, sac } = group.userData;
      // The Excavator's drill turns as it goes; the Hive walker's sac heaves.
      if (drill) drill.rotation.z += 6 * dt;
      if (sac) sac.scale.setScalar(sac.userData.r * (1 + 0.12 * Math.sin(now / 180)));
      w.gait += (moved / stride) * Math.PI;
      legs.forEach((leg, k) => {
        const p = w.gait + phases[k], lift = Math.max(0, Math.sin(p)) * stride * 0.35;
        leg.foot.set(leg.rest.x, lift, leg.rest.z + Math.cos(p) * stride * 0.5);
        pose(leg);
      });
      // A walker's gun pod turns on its own, toward what the server has it aimed at; a brute
      // rears up (the server's pitch 1) before it smashes down.
      if (pod) {
        w.aim += Math.atan2(Math.sin(yaw - w.aim), Math.cos(yaw - w.aim)) * (1 - Math.exp(-14 * dt));
        pod.rotation.y = w.aim - w.heading;
        guns.set(`${owner}:2`, muzzle.getWorldPosition(new THREE.Vector3()));
      }
      // A brute rears up, and a mortar walker raises its tube, as the server pitches them up.
      if (body) {
        w.rear += (pitch - w.rear) * (1 - Math.exp(-(pitch > w.rear ? 4 : 18) * dt));
        body.rotation.x = (body.userData.rest ?? 0) + 0.45 * w.rear;
      }
      // The hive's fungus pulses on it, thicker each wave.
      const grown = 0.8 + 0.05 * wave;
      for (const [k, f] of fungus.entries()) f.scale.setScalar((f.userData.r ?? 1) * grown * (1 + 0.18 * Math.sin(now / 260 + k * 1.7)));
    }
    for (const [owner, w] of this.walkers) {
      if (live.has(owner)) continue;
      // Gone: shot down (a burst and spores), or walked into the reactor.
      const at = w.group.position.clone().setY(w.group.position.y + 1.5);
      if (!this.reactor || at.distanceTo(this.reactor.at) > 14) {
        const big = BOSSES.includes(w.kind) ? 3 : w.kind === BRUTE ? 1.6 : w.kind === CRAWLER ? 1 : w.kind === NODE ? 1.2 : 0.7;
        this.fx.explosion(at, big);
        this.sound.blast(4 * big, at);
      }
      this.scene.remove(w.group);
      this.walkers.delete(owner);
    }
  }

  /**
   * Co-op's pylons from `list` (deployable floats), sized by tier (`tiers`, by owner): the arc
   * pylon's coil mast, its ball crackling; the pulse pylon's dish, its ring breathing.
   */
  drawPylons(list, tiers, accent, now) {
    const live = new Set();
    for (let i = 0; i < list.length; i += 10) {
      const kind = list[i];
      if (kind !== ARC && kind !== PULSE) continue;
      const [, , owner, x, y, z, yaw] = list.subarray(i, i + 7);
      let p = this.pylons.get(owner);
      if (!p) {
        p = { group: pylonMesh(kind) };
        this.scene.add(p.group);
        this.pylons.set(owner, p);
        this.sound.deploy({ x, y, z });
      }
      live.add(owner);
      p.group.position.set(x, y, z);
      p.group.rotation.y = yaw;
      p.group.scale.setScalar(1 + 0.15 * ((tiers.get(owner) ?? 1) - 1));
      const { glow } = p.group.userData;
      glow.material.color.setHex(accent);
      glow.scale.setScalar(kind === ARC ? 1 + 0.25 * Math.random() : 1 + 0.1 * Math.sin(now / 300));
    }
    for (const [owner, p] of this.pylons) {
      if (live.has(owner)) continue;
      this.scene.remove(p.group);
      this.pylons.delete(owner);
    }
  }

  /**
   * Co-op's building aids: the lanes walkers walk, glowing faintly on the ground (`lanes`, six
   * floats a stretch; brighter while building), and the ghost of tower `k` at `spot` (xyz and
   * why not, -1 if it can go there), its reach ringed round it, green where it can go, red where
   * not. `k` < 0 hides the ghost.
   */
  drawBuild(lanes, k, spot, now) {
    if (!this.lanes && lanes.length) {
      // A ribbon LANE_WIDTH wide along each stretch, just over the ground.
      const corners = [];
      for (let i = 0; i < lanes.length; i += 6) {
        const [ax, ay, az, bx, by, bz] = lanes.slice(i, i + 6), len = Math.hypot(bx - ax, bz - az) || 1;
        const [sx, sz] = [(-(bz - az) / len) * LANE_WIDTH * 0.5, ((bx - ax) / len) * LANE_WIDTH * 0.5];
        const [a0, a1, b0, b1] = [[ax - sx, ay + 0.3, az - sz], [ax + sx, ay + 0.3, az + sz], [bx - sx, by + 0.3, bz - sz], [bx + sx, by + 0.3, bz + sz]];
        corners.push(...a0, ...b0, ...a1, ...a1, ...b0, ...b1);
      }
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
      this.lanes = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: LANE_COLOR, side: THREE.DoubleSide }));
      this.scene.add(this.lanes);
    }
    if (this.lanes) this.lanes.material.color.setHex(LANE_COLOR).multiplyScalar((k >= 0 ? 0.9 : 0.4) * (0.8 + 0.2 * Math.sin(now / 400)));
    if (!this.ghost) {
      const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
      const ghost = new THREE.Group();
      ghost.add(new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 1.8, 12).translate(0, 0.9, 0), material));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64).rotateX(-Math.PI / 2), material);
      ring.position.y = 0.15;
      ghost.add(ring);
      ghost.userData = { material, ring };
      this.ghost = ghost;
      this.scene.add(ghost);
    }
    this.ghost.visible = k >= 0 && spot.length === 4;
    if (!this.ghost.visible) return;
    const ok = spot[3] < 0;
    this.ghost.position.set(spot[0], spot[1], spot[2]);
    this.ghost.userData.material.color.setHex(ok ? 0x6dff9a : 0xff5a4a);
    this.ghost.userData.ring.scale.setScalar(towerReach(k));
  }

  /**
   * Co-op salvage from `cores` (four floats each: xyz, 1 for a boss's): a glowing core turning
   * over the ground with a beam of light up from it, a boss's bigger and hotter.
   */
  drawCores(cores, now) {
    while (this.cores.length < cores.length / 4) {
      const group = new THREE.Group(), glow = hot(new THREE.MeshBasicMaterial({ color: 0xffd27a }));
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.6), glow);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 30, 6, 1, true), hot(new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
      beam.position.y = 15;
      group.add(core, beam);
      group.userData = { core, glow };
      this.scene.add(group);
      this.cores.push(group);
    }
    this.cores.forEach((group, k) => {
      group.visible = k < cores.length / 4;
      if (!group.visible) return;
      const [x, y, z, rare] = cores.slice(4 * k, 4 * k + 4);
      group.position.set(x, y + 1.4 + 0.25 * Math.sin(now / 400 + k), z);
      group.userData.core.rotation.set(now / 900, now / 600, 0);
      group.userData.core.scale.setScalar(rare ? 1.6 : 1);
      group.userData.glow.color.setHex(rare ? 0xff9a3c : 0xffd27a);
    });
  }

  /** A mortar shell fired `from` (xyz), landing at `to` in `flight` seconds, at `now` (ms). */
  shell(from, to, flight, now) {
    const orb = part(this.scene, ball, foeGlow, ...from);
    orb.scale.setScalar(0.35);
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 4, 40).rotateX(-Math.PI / 2), hot(new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
    ring.position.set(to[0], to[1] + 0.2, to[2]);
    this.scene.add(ring);
    this.shells.push({ ball: orb, ring, from: new THREE.Vector3(...from), to: new THREE.Vector3(...to), flight: flight * 1000, at: now });
  }

  /** Mortar shells on their arcs, each landing ringed in red till it lands (then a blast). */
  drawShells(now) {
    this.shells = this.shells.filter((s) => {
      const u = Math.min((now - s.at) / s.flight, 1), lob = Math.max(12, s.from.distanceTo(s.to) * 0.45);
      s.ball.position.lerpVectors(s.from, s.to, u).y += 4 * lob * u * (1 - u);
      s.ring.material.opacity = 0.4 + 0.5 * Math.abs(Math.sin(now / (60 + 200 * (1 - u))));
      if (u < 1) return true;
      this.fx.explosion(s.to.clone().setY(s.to.y + 1), 1.2);
      this.sound.blast(5, s.to);
      for (const m of [s.ball, s.ring]) this.scene.remove(m);
      s.ring.geometry.dispose();
      return false;
    });
  }

  /** The reactor as a mark for the glass and radar, in co-op. */
  defenseMarks(defense) {
    return this.reactor && defense.length >= 5 ? [{ label: 'REACTOR', at: this.reactor.at, owner: this.myTeam ?? 0, contested: false }] : [];
  }

  /** The hauler as a mark for the glass and radar, in the color of the side walking it, blinking while contested. */
  haulerMarks(convoy) {
    if (!this.hauler || convoy.length < 6) return [];
    return [{ label: 'CONVOY', at: this.hauler.group.position, owner: convoy[2], contested: !!convoy[4] }];
  }

  /** Each flag where it is, as a mark for the glass and radar (blinking while it lies dropped). */
  flagMarks(ctf, top) {
    if (ctf.length < 14) return [];
    return this.stands.flatMap((s, t) => {
      const [state, by, x, y, z] = ctf.subarray(7 * t, 7 * t + 5);
      const at = state === 1 ? top(by) : state === 2 ? new THREE.Vector3(x, y, z) : s.at;
      return at ? [{ label: 'FLAG', at, owner: t, contested: state === 2 }] : [];
    });
  }

  /**
   * Shows each zone's state from `zones` (three floats each: holder, progress, contested; see
   * WasmNetClient.zones), colored by side for a player on `myTeam`.
   */
  update(zones, myTeam, friend, foe, now) {
    const color = (team) => (team < 0 ? NEUTRAL : team === myTeam ? friend : foe);
    // The mode on says which: Missile Assault's three silos, or Siege's AA gun; none in the rest.
    [this.zones, this.labels] = zones.length === 9 ? [this.silos, ['A', 'B', 'C']] : zones.length === 3 ? [this.aa, ['AA']] : [[], []];
    this.myTeam = myTeam;
    this.aaOwner = this.zones === this.aa ? zones[0] : -1;
    for (const s of [...this.silos, ...this.aa]) s.group.visible = this.zones.includes(s);
    // Each objective changing hands, as cues: ours now, ours no more, theirs now. (Not on the first
    // look at a set, which is where things already stood.)
    const cues = [], first = this.seen !== this.zones;
    this.seen = this.zones;
    this.zones.forEach((s, i) => {
      const [owner, progress, contested] = zones.subarray(3 * i, 3 * i + 3);
      if (!first && owner !== s.owner) {
        const label = this.labels[i];
        if (owner === myTeam) cues.push({ kind: 'took', label });
        else if (s.owner === myTeam) cues.push({ kind: 'lost', label });
        else if (owner >= 0) cues.push({ kind: 'enemy', label });
      }
      s.owner = owner;
      const flash = contested && Math.floor(now / 250) % 2 === 0;
      s.ring.material.color.setHex(flash ? 0xffffff : color(owner));
      s.beacon.material.color.setHex(color(owner));
      // The fill ring shows how far a capture has got, in the color of the side it's going to.
      fill(s, s.radius, Math.abs(progress));
      s.fill.material.color.setHex(color(progress > 0 ? 0 : progress < 0 ? 1 : -1));
      if (s.pad) this.showPad(s, color(owner), now);
      if (s.gun) s.gun.userData.lamp.material.color.setHex(color(owner));
    });
    return cues;
  }

  /**
   * Siege's drop zones, shown while Siege is on (`on`): ours in our color, pulsing while we carry
   * energy home (`carrying`), theirs in theirs.
   */
  showDropZones(on, myTeam, friend, foe, carrying, now) {
    this.dropZones.forEach((d, team) => {
      d.group.visible = on;
      const ours = team === myTeam, color = ours ? friend : foe;
      d.ring.material.color.setHex(color);
      d.beacon.material.color.setHex(color);
      d.ring.material.opacity = ours && carrying ? 0.55 + 0.4 * Math.sin(now / 160) : 0.5;
      fill(d, BASE_RADIUS, ours && carrying ? 1 : 0);
      d.fill.material.color.setHex(ENERGY);
    });
  }

  /** Whether a mech with its feet at `feet` stands in `team`'s drop zone. */
  inDropZone(feet, team) {
    const base = this.bases[team];
    return !!base && Math.hypot(feet.x - base.x, feet.z - base.z) <= BASE_RADIUS + 1;
  }

  /** Energy banked at `team`'s drop zone: a green burst there. */
  banked(team) {
    const base = this.bases[team];
    if (base) this.fx.bank(base.clone().addScaledVector(UP, 0.5), BASE_RADIUS);
  }

  /**
   * The stage a siege is at for `myTeam`, as a line for the top of the glass: gathering (with the
   * bank's progress to a launch, and what we carry), or a ship up (ours or theirs, cruising,
   * bombarding, or both dueling), with what to do about it. `floats` as for `siege`, `hull` the
   * bases' hull ([team 0, team 1]).
   */
  stage(myTeam, floats, hull, carried) {
    const ours = this.ships.get(myTeam), theirs = this.ships.get(1 - myTeam);
    const aa = this.aaOwner === myTeam ? 'HOLD' : 'TAKE', ship = (s) => `${Math.max(0, Math.ceil(s.hull))}/${SHIP_HULL}`;
    const over = (s) => {
      const base = this.bases[1 - s.team];
      return !!base && Math.hypot(s.pos.x - base.x, s.pos.z - base.z) <= BOMBARD_RANGE + 1;
    };
    if (ours && theirs) return `${aa === 'HOLD' ? 'HOLD' : 'CAPTURE'} THE AA TO DESTROY THE ENEMY SHIP   [OURS ${ship(ours)} · THEIRS ${ship(theirs)}]`;
    if (theirs && over(theirs)) return `ENEMY SHIP HITTING OUR BASE · SHOOT IT DOWN   [SHIP ${ship(theirs)} · BASE ${hull[myTeam]}/${BASE_HULL}]`;
    if (theirs) return `ENEMY SHIP INBOUND · ${aa === 'HOLD' ? 'DEFEND' : 'TAKE'} THE AA, SHOOT IT DOWN   [SHIP ${ship(theirs)}]`;
    if (ours && over(ours)) return `OUR SHIP HAS REACHED THEIR BASE   [THEIR BASE ${hull[1 - myTeam]}/${BASE_HULL}]`;
    if (ours) return `OUR SHIP IS UP · ESCORT IT, ${aa} THE AA   [SHIP ${ship(ours)}]`;
    const bank = Math.floor(floats[this.stations.length + myTeam] ?? 0);
    return carried > 0
      ? `CARRYING ${carried} EU · RETURN TO THE DROP ZONE   [${bank}/${LAUNCH_EU}]`
      : `GATHER AT THE ENERGY STATION AND RETURN TO THE DROP ZONE   [${bank}/${LAUNCH_EU}]`;
  }

  /**
   * The AA gun: set on its surface, turned on the enemy ship of its holder in reach (the sim's own
   * test: it's hurting that ship), firing flak bursts at it; otherwise scanning the sky.
   */
  manAA(now, dt) {
    const s = this.aa[0];
    if (!s?.group.visible) return;
    if (!s.level) s.level = level(s.gun, s.gunAt, this.cast);
    const holder = this.aaOwner, target = [...this.ships.values()].find((ship) => holder >= 0 && ship.team !== holder && ship.pos.distanceTo(s.at) <= AA_RANGE);
    let yaw = s.yaw + 0.25 * dt, pitch = 0.45;
    if (target) {
      const to = target.group.position.clone().sub(s.gunAt);
      [yaw, pitch] = [Math.atan2(-to.x, -to.z), Math.atan2(to.y, Math.hypot(to.x, to.z))];
    }
    const turn = (from, to) => from + THREE.MathUtils.clamp(Math.atan2(Math.sin(to - from), Math.cos(to - from)), -AA_TURN * dt, AA_TURN * dt);
    s.yaw = turn(s.yaw, yaw);
    s.pitch = turn(s.pitch, pitch);
    const { head, cradle, tips } = s.gun.userData;
    head.rotation.y = s.yaw;
    cradle.rotation.x = s.pitch;
    if (!target) return;
    // On target, a burst every AA_EVERY ms: rounds from each barrel in turn, tracers up and flak
    // bursting round the ship.
    if (now - s.burstAt >= AA_EVERY) [s.burstAt, s.rounds] = [now, 0];
    while (s.rounds < AA_BURST && now - s.burstAt >= s.rounds * AA_GAP) {
      const tip = tips[s.rounds % 2].getWorldPosition(new THREE.Vector3());
      const at = target.group.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14));
      this.fx.muzzleLight(tip);
      this.fx.muzzle(tip, at.clone().sub(tip).normalize());
      this.fx.beam(tip, at);
      this.fx.explosion(at, 0.35);
      this.sound.shot('flak', tip);
      this.sound.blast(2.5, at);
      s.rounds++;
    }
  }

  /** Silo `s`'s pad: set level with what it stands on (once it can tell), its lamps in `lamp` (flashing through a launch), its doors open for one. */
  showPad(s, lamp, now) {
    if (!s.level) s.level = level(s.pad, s.padAt, this.cast);
    const since = now - s.launchAt, launching = since < OPEN_MS;
    const open = launching ? Math.min(since / DOOR_MS, 1) : Math.max(0, 1 - (since - OPEN_MS) / DOOR_MS);
    const { doors, lamps } = s.pad.userData;
    doors.forEach((door, k) => (door.position.x = (k ? 1 : -1) * (1.2 + 2.3 * open)));
    for (const l of lamps) l.material.color.setHex(launching && Math.floor(now / 120) % 2 ? 0xffb347 : lamp);
    // The beacon steps aside while a rocket climbs out of it.
    s.beacon.visible = !launching;
  }

  /**
   * The objective a mech with its feet at `feet` stands in, if any (zones as for `update`), with
   * how far it's come to `myTeam`'s side (`share`: 0 theirs, 0.5 neutral, 1 ours), whether it's
   * contested, and whether it's ours and secure.
   */
  standing(feet, zones, myTeam) {
    const i = this.zones.findIndex((s) => Math.hypot(feet.x - s.at.x, feet.z - s.at.z) <= s.radius && Math.abs(feet.y - s.at.y) <= s.band);
    if (i < 0) return null;
    const [owner, progress, contested] = zones.subarray(3 * i, 3 * i + 3), mine = myTeam === 0 ? progress : -progress;
    return { label: this.labels[i], share: (mine + 1) / 2, contested: !!contested, secure: owner === myTeam && mine >= 1 && !contested };
  }

  /** Siege's stations and drops from `floats` (WasmNetClient.siege: each station's EU, the two banks, then xyz and EU per drop). */
  siege(floats, now) {
    this.stations.forEach((s, i) => {
      s.group.visible = floats.length > 0;
      fill(s, s.radius, (floats[i] ?? STATION_CAP) / STATION_CAP);
    });
    const first = this.stations.length + 2, n = Math.max(0, (floats.length - first) / 4);
    while (this.drops.length < n) {
      const mesh = new THREE.Mesh(this.dropGeometry, this.dropMaterial);
      this.scene.add(mesh);
      this.drops.push(mesh);
    }
    this.drops.forEach((mesh, k) => {
      mesh.visible = k < n;
      if (k < n) mesh.position.set(floats[first + 4 * k], floats[first + 1 + 4 * k] + 0.4 * Math.sin(now / 300 + k), floats[first + 2 + 4 * k]);
      mesh.rotation.y = now / 600;
    });
  }

  /**
   * The battleships among `list` (WasmNetClient.deployables), colored by side for `myTeam`, and the
   * fire they trade: with each other in range, with the AA gun's holder (`zones`), and on the base
   * they've reached. `guns` gets each ship's gun, by `${owner}:2` as MG turrets' are.
   */
  drawShips(list, zones, myTeam, friend, foe, now, dt, guns) {
    const live = new Set();
    for (let i = 0; i < list.length; i += 10) {
      if (list[i] !== SHIP) continue;
      const [, team, owner, x, y, z, , , , hull] = list.subarray(i, i + 10);
      let s = this.ships.get(team);
      if (!s) {
        s = { group: shipMesh(), team, pos: new THREE.Vector3(x, y, z) };
        this.scene.add(s.group);
        this.ships.set(team, s);
        const ahead = this.bases[1 - team] && this.bases[team] ? new THREE.Vector3().subVectors(this.bases[1 - team], this.bases[team]) : new THREE.Vector3(0, 0, -1);
        s.group.rotation.y = Math.atan2(-ahead.x, -ahead.z);
      }
      live.add(team);
      s.pos.set(x, y, z);
      s.hull = hull;
      s.group.position.lerp(s.pos, s.group.position.lengthSq() ? 1 - Math.exp(-8 * dt) : 1);
      s.group.userData.accent.color.setHex(team === myTeam ? friend : foe);
      guns.set(`${owner}:2`, s.group.position.clone().addScaledVector(UP, -6));
      // Engines.
      for (const e of s.group.userData.engines) this.fx.thrust(e.getWorldPosition(new THREE.Vector3()), backward(s.group), 2.2, dt, true);
    }
    for (const [team, s] of this.ships) if (!live.has(team)) { this.scene.remove(s.group); this.ships.delete(team); }
    this.sound.ships([...this.ships.values()].map((s) => s.group.position));
    // The fire between them, a burst every so often.
    const every = (key, ms) => now - (this.fire[key] ?? -Infinity) >= ms && (this.fire[key] = now);
    const [a, b] = [this.ships.get(0), this.ships.get(1)];
    if (a && b && a.pos.distanceTo(b.pos) <= DUEL_RANGE && every('duel', 300)) {
      for (const [from, to] of [[a, b], [b, a]]) this.tracer(from.group.position, to.group.position);
      // Their broadsides boom every other volley.
      if (every('duelGuns', 600)) for (const s of [a, b]) this.sound.shipGun(s.group.position);
    }
    this.manAA(now, dt);
    for (const s of this.ships.values()) {
      const base = this.bases[1 - s.team];
      if (base && Math.hypot(s.pos.x - base.x, s.pos.z - base.z) <= BOMBARD_RANGE + 1 && every(`bomb${s.team}`, 700)) {
        this.tracer(s.group.position.clone().addScaledVector(UP, -6), base);
        this.fx.explosion(base, 1.2);
        this.sound.shipGun(s.group.position);
        this.sound.blast(14, base);
      }
    }
  }

  /**
   * The team modes' base guns among `list` (WasmNetClient.deployables): each a tower with a gun head
   * the server turns (yaw, pitch), its lamps and stripe in its side's color. `guns` gets each one's
   * muzzle, by `${owner}:2` as MG turrets' are.
   */
  drawSentries(list, myTeam, friend, foe, dt, guns) {
    const live = new Set();
    for (let i = 0; i < list.length; i += 10) {
      if (list[i] !== SENTRY) continue;
      const [, team, owner, x, y, z, yaw, pitch, , hull] = list.subarray(i, i + 10);
      let s = this.sentries.get(owner);
      if (!s) {
        s = { group: sentryMesh(), yaw, pitch, offline: hull <= 0 };
        s.group.position.set(x, y, z);
        this.scene.add(s.group);
        this.sentries.set(owner, s);
      }
      live.add(owner);
      // Shot offline: its hum sags away and it slumps, dark and smoking, till it reboots.
      const offline = hull <= 0, top = s.group.position.clone().setY(y + SENTRY_HEIGHT + 1);
      if (offline !== s.offline) {
        if (offline) {
          this.sound.fieldDown(top);
          this.fx.explosion(top, 0.5);
        } else this.sound.deploy(top);
        s.offline = offline;
      }
      if (offline) this.fx.smoke(top, dt, 0.15);
      // Eased toward the server's aim, so 30 Hz steps don't judder.
      const ease = 1 - Math.exp(-14 * dt), turn = Math.atan2(Math.sin(yaw - s.yaw), Math.cos(yaw - s.yaw));
      s.yaw += turn * ease;
      s.pitch += ((offline ? -0.5 : pitch) - s.pitch) * ease;
      const { head, cradle, tips, accents } = s.group.userData;
      head.rotation.y = s.yaw;
      cradle.rotation.x = s.pitch;
      if (!offline) s.group.userData.dish.rotation.y += 2.5 * dt;
      for (const a of accents) a.material.color.setHex(offline ? 0x1a1c20 : team === myTeam ? friend : foe);
      guns.set(`${owner}:2`, tips[Math.floor(performance.now() / 50) % 2].getWorldPosition(new THREE.Vector3()));
    }
    for (const [owner, s] of this.sentries) if (!live.has(owner)) { this.scene.remove(s.group); this.sentries.delete(owner); }
  }

  tracer(from, to) {
    this.fx.beam(from, to);
    this.fx.impact(to);
  }

  /** `team`'s ship went down: a big blast where it was. */
  shipDown(team) {
    const s = this.ships.get(team);
    if (!s) return;
    this.fx.explosion(s.group.position, 3);
    this.sound.blast(20, s.group.position);
  }

  /** The station a mech with its feet at `feet` stands in (its index), or -1. */
  stationAt(feet) {
    return this.stations.findIndex((s) => Math.hypot(feet.x - s.at.x, feet.z - s.at.z) <= s.radius && Math.abs(feet.y - s.at.y) <= s.band);
  }

  /** `team`'s battleship lifted off from over its base: the rumble of it. */
  shipLaunched(team) {
    const base = this.bases[team];
    if (base) this.sound.shipLaunch(base.clone().setY(this.sky));
  }

  /** Silo `silo`, held by `team` (`accent`: its side's color), fired at the other team's base. */
  launch(silo, team, now, accent) {
    const s = this.silos[silo], to = this.bases[1 - team];
    if (!s || !to) return;
    s.launchAt = now;
    this.sound.silo(s.padAt);
    const mesh = rocketMesh(accent);
    this.scene.add(mesh);
    // Up out of the tube to the top of the climb, then a curve over (its control point straight
    // above, so it turns over smoothly) and down onto the base.
    const top = s.padAt.clone().addScaledVector(UP, RISE_HEIGHT);
    const over = top.clone().setY(Math.max(top.y, to.y) + APEX + 0.25 * Math.hypot(to.x - top.x, to.z - top.z));
    this.missiles.push({ mesh, pad: s.padAt.clone(), top, over, to: to.clone(), start: now });
  }

  /** Flies the rockets on (flame, and smoke billowing from the pad as they clear it); each lands with a blast. */
  step(now, dt) {
    const at = (m, t) => {
      if (t < RISE) {
        const u = t / RISE;
        return m.pad.clone().addScaledVector(UP, -TUBE + (RISE_HEIGHT + TUBE) * u * u);
      }
      const v = (t - RISE) / (1 - RISE), w = 1 - v;
      return new THREE.Vector3().addScaledVector(m.top, w * w).addScaledVector(m.over, 2 * v * w).addScaledVector(m.to, v * v);
    };
    this.missiles = this.missiles.filter((m) => {
      const t = (now - m.start) / 1000 / FLIGHT;
      if (t >= 1) {
        this.scene.remove(m.mesh);
        this.fx.explosion(m.to, 2.2);
        this.sound.blast(16, m.to);
        return false;
      }
      const p = at(m, t), heading = at(m, Math.min(t + 0.005, 1)).sub(p).normalize();
      m.mesh.position.copy(p);
      m.mesh.quaternion.setFromUnitVectors(UP, heading);
      m.at = p;
      const nozzle = p.clone().addScaledVector(heading, -3.4), back = heading.clone().negate();
      this.fx.thrust(nozzle, back, 2.4, dt);
      this.fx.smoke(nozzle, dt, 0.6);
      if (t < RISE) this.fx.smoke(m.pad, dt, 0.75);
      return true;
    });
  }

  /** The rockets in flight, for their roar (Sound.exhausts). */
  exhausts() {
    return this.missiles.filter((m) => m.at).map(({ at }) => ({ x: at.x, y: at.y, z: at.z, big: true }));
  }

  /**
   * What the glass marks, in the modes that play them (`zones` and `siege` as for `update` and
   * `siege`): each zone's label in its holder's color (flashing contested), each station, and our
   * drop zone.
   */
  markers(zones, siege) {
    if (!zones.length) return [];
    const marks = this.zones.map((s, i) => ({ label: this.labels[i], at: s.at, owner: zones[3 * i], contested: !!zones[3 * i + 2] }));
    if (!siege.length) return marks;
    const drop = this.bases[this.myTeam];
    return marks.concat(
      this.stations.map((s) => ({ label: 'E', at: s.at, owner: -1, contested: false, color: ENERGY })),
      drop ? [{ label: 'DROP', at: drop, owner: this.myTeam, contested: false }] : [],
    );
  }
}

/** A ring of `radius` on the ground at `at`, a fill ring inside it, and a beacon, in `color`. */
function marker(scene, at, radius, color) {
  const group = new THREE.Group();
  group.position.set(...at);
  const flat = (geometry, opacity) => {
    const mesh = new THREE.Mesh(geometry.rotateX(-Math.PI / 2), hot(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })));
    mesh.position.y = 0.15;
    group.add(mesh);
    return mesh;
  };
  const ring = flat(new THREE.RingGeometry(radius - 0.5, radius, 64), 0.8);
  const fill = flat(new THREE.RingGeometry(radius - 2.2, radius - 0.9, 64), 0.6);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, BEACON_HEIGHT, 10, 1, true),
    hot(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })),
  );
  beacon.position.y = BEACON_HEIGHT / 2;
  group.add(beacon);
  scene.add(group);
  return { group, ring, fill, beacon, at: new THREE.Vector3(...at) };
}

/**
 * A silo's launch pad, its top at y 0: a concrete slab, a hazard-yellow frame round the tube's
 * mouth, two hatch doors over it (`userData.doors`, sliding apart along x), and a lamp post at each
 * corner (`userData.lamps`).
 */
function padMesh() {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x5b5f63, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.5, metalness: 0.5 });
  const hazard = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.6 });
  const box = (w, h, d, x, y, z, material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  box(7.2, 0.3, 7.2, 0, -0.1, 0, concrete);
  box(4.8, 0.05, 4.8, 0, 0.06, 0, new THREE.MeshBasicMaterial({ color: 0x050505 })); // the tube's dark mouth
  for (const k of [-1, 1]) {
    box(5.4, 0.12, 0.3, 0, 0.1, k * 2.55, hazard);
    box(0.3, 0.12, 5.4, k * 2.55, 0.1, 0, hazard);
  }
  const doors = [-1, 1].map((k) => box(2.4, 0.14, 4.8, k * 1.2, 0.14, 0, steel));
  const lamps = [];
  for (const [x, z] of [[-3.2, -3.2], [3.2, -3.2], [-3.2, 3.2], [3.2, 3.2]]) {
    box(0.18, 1.4, 0.18, x, 0.7, z, steel);
    lamps.push(box(0.42, 0.3, 0.42, x, 1.55, z, hot(new THREE.MeshBasicMaterial({ color: NEUTRAL }))));
  }
  group.userData = { doors, lamps };
  return group;
}

/**
 * Sets `pad` at `at` level with the surface under it, found with `cast` (three rays down): tilted on
 * a slope, as on Crash Site's bow. Whether it could tell (the arena may not have loaded yet).
 */
function level(pad, at, cast) {
  const below = (dx, dz) => {
    const d = cast(at.x + dx, at.y + 3, at.z + dz, 0, -1, 0, 8);
    return d < 8 ? at.y + 3 - d : null;
  };
  const [h, hx, hz] = [below(0, 0), below(2, 0), below(0, 2)];
  if (h === null || hx === null || hz === null) return false;
  const normal = new THREE.Vector3().crossVectors(new THREE.Vector3(0, hz - h, 2), new THREE.Vector3(2, hx - h, 0)).normalize();
  pad.quaternion.setFromUnitVectors(UP, normal);
  pad.position.y += h - at.y;
  return true;
}

/**
 * The AA gun, its base at y 0: a plinth, a head that turns (`userData.head`, yaw) with a cradle that
 * elevates (`userData.cradle`, pitch, its barrels along -z at 0) holding two long barrels whose
 * muzzles are `userData.tips`, and a lamp in its holder's color (`userData.lamp`).
 */
function aaMesh() {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x5b5f63, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.5, metalness: 0.5 });
  const olive = new THREE.MeshStandardMaterial({ color: 0x4f5a3c, roughness: 0.7, metalness: 0.2 });
  const hazard = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.6 });
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3, 0.8, 8), concrete).translateY(0.4));
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(2.65, 2.65, 0.14, 8), hazard).translateY(0.82));
  const head = new THREE.Group();
  head.position.y = 0.9;
  group.add(head);
  head.add(new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2, 1, 12), olive).translateY(0.5));
  for (const x of [-1.15, 1.15]) head.add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.8, 1.6), olive).translateX(x).translateY(1.6));
  const cradle = new THREE.Group();
  cradle.position.y = 2.1;
  head.add(cradle);
  cradle.add(new THREE.Mesh(new THREE.BoxGeometry(1.9, 1, 1.8), steel));
  const tips = [-0.45, 0.45].map((x) => {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 5, 10).rotateX(Math.PI / 2), steel);
    barrel.position.set(x, 0.1, -3.2);
    cradle.add(barrel);
    const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 10).rotateX(Math.PI / 2), steel);
    brake.position.set(x, 0.1, -5.5);
    cradle.add(brake);
    const tip = new THREE.Object3D();
    tip.position.set(x, 0.1, -5.9);
    cradle.add(tip);
    return tip;
  });
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), hot(new THREE.MeshBasicMaterial({ color: NEUTRAL })));
  lamp.position.set(0, 0.65, 0.95);
  cradle.add(lamp);
  group.userData = { head, cradle, tips, lamp };
  return group;
}

/**
 * A base gun, its foot at y 0 and its muzzles SENTRY_HEIGHT up: a concrete tower banded in hazard
 * yellow, a platform, and an armored head that turns (`userData.head`, yaw) over a cradle that
 * elevates (`userData.cradle`, pitch, the guns along -z at 0) holding a pair of jacketed heavy MGs
 * (`userData.tips`) under a spinning radar dish (`userData.dish`); lamps and a stripe in its side's
 * color (`userData.accents`).
 */
function sentryMesh() {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x6a6e72, roughness: 0.9 });
  const armor = new THREE.MeshStandardMaterial({ color: 0x32373d, roughness: 0.45, metalness: 0.55 });
  const hazard = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.6 });
  const accent = () => hot(new THREE.MeshBasicMaterial({ color: NEUTRAL }));
  const add = (parent, geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  add(group, new THREE.BoxGeometry(2.2, 0.5, 2.2), concrete, 0, 0.25, 0);
  add(group, new THREE.CylinderGeometry(0.7, 0.95, 3.8, 8), concrete, 0, 2.4, 0);
  for (const y of [1.2, 3.6]) add(group, new THREE.CylinderGeometry(0.88, 0.88, 0.25, 8), hazard, 0, y, 0);
  add(group, new THREE.CylinderGeometry(1.25, 1.1, 0.35, 12), armor, 0, 4.45, 0);
  const accents = [];
  const head = new THREE.Group();
  head.position.y = 4.6;
  group.add(head);
  add(head, new THREE.BoxGeometry(1.7, 1.1, 1.9), armor, 0, 0.55, 0.15);
  add(head, new THREE.BoxGeometry(1.4, 0.7, 0.6), armor, 0, 0.9, -0.9).rotation.x = -0.5; // sloped front plate
  accents.push(add(head, new THREE.BoxGeometry(1.72, 0.14, 1.4), accent(), 0, 0.85, 0.3));
  for (const x of [-0.95, 0.95]) accents.push(add(head, new THREE.BoxGeometry(0.16, 0.16, 0.16), accent(), x, 1.15, 0.9));
  const dish = new THREE.Group();
  dish.position.set(0, 1.35, 0.6);
  head.add(dish);
  add(dish, new THREE.CylinderGeometry(0.05, 0.05, 0.4, 6), armor, 0, 0.2, 0);
  add(dish, new THREE.CylinderGeometry(0.45, 0.1, 0.12, 12), armor, 0, 0.45, 0).rotation.x = 1.2;
  const cradle = new THREE.Group();
  cradle.position.y = SENTRY_HEIGHT - 4.6;
  head.add(cradle);
  const tips = [-0.32, 0.32].map((x) => {
    add(cradle, new THREE.CylinderGeometry(0.16, 0.16, 1.6, 10).rotateX(Math.PI / 2), armor, x, 0, -1.4); // cooling jacket
    add(cradle, new THREE.CylinderGeometry(0.07, 0.07, 1.2, 8).rotateX(Math.PI / 2), armor, x, 0, -2.6);
    const tip = new THREE.Object3D();
    tip.position.set(x, 0, -3.2);
    cradle.add(tip);
    return tip;
  });
  group.userData = { head, cradle, tips, dish, accents };
  return group;
}

/** A silo's rocket, nose along +y: body, nose cone, four fins, a band in `accent` (its side's color), the nozzle. */
function rocketMesh(accent) {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.45, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.6 });
  const add = (geometry, material, y) => group.add(new THREE.Mesh(geometry, material).translateY(y));
  add(new THREE.CylinderGeometry(0.55, 0.55, 5.2, 14), shell, 0);
  add(new THREE.ConeGeometry(0.55, 1.6, 14), shell, 3.4);
  add(new THREE.CylinderGeometry(0.57, 0.57, 0.5, 14), hot(new THREE.MeshBasicMaterial({ color: accent })), 1.6);
  add(new THREE.CylinderGeometry(0.34, 0.5, 0.6, 12), dark, -2.9);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.3, 1.0), dark);
    fin.position.set(Math.sin((k * Math.PI) / 2) * 0.85, -2.2, Math.cos((k * Math.PI) / 2) * 0.85);
    fin.rotation.y = (k * Math.PI) / 2;
    group.add(fin);
  }
  return group;
}

/** Sets marker `s`'s fill ring to `share` (0 to 1) of a full turn, rebuilt only when it changes. */
function fill(s, radius, share) {
  const key = Math.round(share * 100);
  if (key === s.shown) return;
  s.shown = key;
  s.fill.geometry.dispose();
  s.fill.geometry = new THREE.RingGeometry(radius - 2.2, radius - 0.9, 64, 1, Math.PI / 2, share * Math.PI * 2).rotateX(-Math.PI / 2);
}

/** A flag stand's plinth, its top at PLINTH_HEIGHT: a low concrete drum with a steel collar. */
const PLINTH_HEIGHT = 0.8;
function plinthMesh() {
  const group = new THREE.Group();
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, PLINTH_HEIGHT, 16), new THREE.MeshStandardMaterial({ color: 0x5b5f63, roughness: 0.9 }));
  drum.position.y = PLINTH_HEIGHT / 2;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.12, 16), new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.5, metalness: 0.5 }));
  collar.position.y = PLINTH_HEIGHT - 0.05;
  group.add(drum, collar);
  return group;
}

/** A flag, its foot at y 0: a tall pole, a glowing banner off its top (`userData.banner`, its `cloth`), a finial. */
function flagMesh() {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 8), new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.4, metalness: 0.7 }));
  pole.position.y = 2.5;
  const banner = new THREE.Group();
  banner.position.y = 4.1;
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.3, 0.06), hot(new THREE.MeshBasicMaterial({ color: NEUTRAL })));
  cloth.position.x = 1.15;
  banner.add(cloth);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), hot(new THREE.MeshBasicMaterial({ color: 0xffffff })));
  finial.position.y = 5.05;
  group.add(pole, banner, finial);
  group.userData = { banner, cloth };
  return group;
}

/** Convoy's hauler: how far a foot sweeps in a stride, and how high its payload stands. */
const HAULER_STRIDE = 3.2, HAULER_TOP = 6.4;
/** A leg's two segments (thigh and shin), each this long. */
const HAULER_LEG = 3.4;

/** Sets `leg`'s thigh and shin between its hip, a knee bent up and out, and its foot (in the walker's frame). */
function pose(leg) {
  const { hip, foot, thigh, shin } = leg, len = leg.len ?? HAULER_LEG;
  const mid = hip.clone().add(foot).multiplyScalar(0.5), half = hip.distanceTo(foot) / 2;
  const knee = mid.addScaledVector(UP, Math.sqrt(Math.max(len ** 2 - half ** 2, 0.25)));
  knee.x += Math.sign(hip.x) * 0.18 * len;
  for (const [mesh, a, b] of [[thigh, hip, knee], [shin, knee, foot]]) {
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
    mesh.scale.y = a.distanceTo(b);
  }
}

/**
 * Convoy's hauler, walking along -Z: a squat armored chassis with plated flanks (cover to crouch
 * behind), a great warhead slung on top in hazard bands, a sensor head, and four jointed legs
 * (`userData.legs`: hip, foot, rest, thigh, shin), with light strips (`userData.accents`) in the
 * color of whoever walks it.
 */
function haulerMesh() {
  const group = new THREE.Group();
  const armor = new THREE.MeshStandardMaterial({ color: 0x4c5249, roughness: 0.7, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.5, metalness: 0.6 });
  const hazard = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.6 });
  const warhead = new THREE.MeshStandardMaterial({ color: 0x8a8f86, roughness: 0.45, metalness: 0.5 });
  const accents = [];
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(4.4, 1.4, 6.2), armor, 0, 3.4, 0); // chassis
  add(new THREE.BoxGeometry(3.6, 0.6, 5.2), dark, 0, 2.5, 0); // belly
  for (const x of [-1, 1]) {
    add(new THREE.BoxGeometry(0.35, 2.4, 5.6), armor, x * 2.35, 3.6, 0); // flank plates
    // Flat (not bloomed): long strips glowing would swamp the walker at a distance.
    accents.push(add(new THREE.BoxGeometry(0.08, 0.14, 4.6), new THREE.MeshBasicMaterial({ color: NEUTRAL }), x * 2.56, 4.2, 0));
  }
  // The payload: a warhead in its cradle, banded in hazard yellow.
  const body = add(new THREE.CylinderGeometry(1.45, 1.45, 5.6, 20), warhead, 0, 5.2, 0.2);
  body.rotation.x = Math.PI / 2;
  const nose = add(new THREE.ConeGeometry(1.45, 1.6, 20), warhead, 0, 5.2, -3.4);
  nose.rotation.x = -Math.PI / 2;
  for (const z of [-1.6, 1.2]) add(new THREE.CylinderGeometry(1.5, 1.5, 0.35, 20), hazard, 0, 5.2, z).rotation.x = Math.PI / 2;
  for (const z of [-2, 2]) add(new THREE.BoxGeometry(3.4, 0.9, 0.5), dark, 0, 4.4, z); // cradle
  // The sensor head, its eye lit.
  add(new THREE.BoxGeometry(1.6, 0.9, 1.0), dark, 0, 3.6, -3.5);
  accents.push(add(new THREE.BoxGeometry(1.0, 0.22, 0.1), hot(new THREE.MeshBasicMaterial({ color: NEUTRAL })), 0, 3.7, -4.02));
  accents.push(add(new THREE.SphereGeometry(0.25, 10, 8), hot(new THREE.MeshBasicMaterial({ color: NEUTRAL })), 0, HAULER_TOP + 0.1, 1.2));
  const segment = new THREE.CylinderGeometry(0.32, 0.26, 1, 8);
  const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => {
    const hip = new THREE.Vector3(sx * 2.0, 3.0, sz * 2.4), rest = new THREE.Vector3(sx * 5.0, 0, sz * 4.2);
    add(new THREE.SphereGeometry(0.55, 10, 8), dark, hip.x, hip.y, hip.z);
    const leg = { hip, rest, foot: rest.clone(), thigh: add(segment, armor, 0, 0, 0), shin: add(segment, dark, 0, 0, 0) };
    pose(leg);
    return leg;
  });
  group.userData = { legs, accents };
  return group;
}

/** Co-op's fungus, glowing orange; a walker's stride. */
const FUNGUS = 0xff7a1f;
const WALKER_STRIDE = 1.4;
/** How wide co-op's lanes are drawn on the ground (m), and in what (a hazard red, to stand out on any map's floor). */
const LANE_WIDTH = 1.6;
const LANE_COLOR = 0xff3b1f;

/**
 * Co-op's infested walker, walking along -Z: a rusted industrial chassis on four jointed legs
 * (`userData.legs`), a gun pod on top that turns on its own (`userData.pod`, its `muzzle`), and
 * orange fungus bulging from its seams (`userData.fungus`), the hive mind's mark on it.
 */
function walkerMesh() {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x8a6a2a, roughness: 0.8, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.6, metalness: 0.5 });
  const glow = hot(new THREE.MeshBasicMaterial({ color: FUNGUS }));
  const add = (parent, geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  add(group, new THREE.BoxGeometry(2.0, 0.9, 2.5), paint, 0, 2.0, 0);
  add(group, new THREE.BoxGeometry(1.6, 0.4, 2.0), dark, 0, 1.45, 0);
  const pod = new THREE.Group();
  pod.position.set(0, 2.75, -0.2);
  group.add(pod);
  add(pod, new THREE.BoxGeometry(0.9, 0.6, 1.1), dark, 0, 0, 0);
  add(pod, new THREE.CylinderGeometry(0.09, 0.09, 1.3, 8), dark, 0, 0, -1.0).rotation.x = Math.PI / 2;
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -1.7);
  pod.add(muzzle);
  add(pod, new THREE.SphereGeometry(0.12, 8, 6), glow, 0, 0.12, -0.56); // its eye, taken over
  const fungus = [[0.8, 2.5, 0.6, 0.32], [-0.9, 2.3, -0.4, 0.26], [0.3, 2.5, 1.1, 0.22], [-0.5, 1.6, 0.9, 0.2], [1.0, 1.9, -0.9, 0.18], [-0.2, 3.1, 0.3, 0.16]]
    .map(([x, y, z, r]) => add(group, new THREE.SphereGeometry(r, 10, 8), glow, x, y, z));
  const segment = new THREE.CylinderGeometry(0.16, 0.12, 1, 6);
  const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => {
    const hip = new THREE.Vector3(sx * 0.9, 1.8, sz * 1.0), rest = new THREE.Vector3(sx * 2.0, 0, sz * 1.7);
    const leg = { hip, rest, foot: rest.clone(), len: 1.6, thigh: add(group, segment, paint, 0, 0, 0), shin: add(group, segment, dark, 0, 0, 0) };
    pose(leg);
    return leg;
  });
  group.userData = { legs, pod, muzzle, fungus, stride: WALKER_STRIDE, phases: [0, Math.PI, Math.PI, 0] };
  return group;
}

/** A lane enemy's parts: rusted paint, dark steel and the glowing fungus (shared). */
const foePaint = new THREE.MeshStandardMaterial({ color: 0x8a6a2a, roughness: 0.8, metalness: 0.3 });
const foeDark = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.6, metalness: 0.5 });
const foeHazard = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.7, metalness: 0.3 });
const foeGlow = hot(new THREE.MeshBasicMaterial({ color: FUNGUS }));
const ball = new THREE.SphereGeometry(1, 10, 8);
function part(parent, geometry, material, x, y, z) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}
/** Fungus blobs `[x, y, z, r]` on `parent`. */
function blobs(parent, spots) {
  return spots.map(([x, y, z, r]) => {
    const blob = part(parent, ball, foeGlow, x, y, z);
    blob.userData.r = r;
    blob.scale.setScalar(r);
    return blob;
  });
}
/** Jointed legs from hips `[x, y, z]` to rest feet `[x, z]`, `len` a segment, `thick` round. */
function legsOf(group, hips, feet, len, thick) {
  const segment = new THREE.CylinderGeometry(thick, thick * 0.75, 1, 6);
  return hips.map(([x, y, z], k) => {
    const leg = { hip: new THREE.Vector3(x, y, z), rest: new THREE.Vector3(feet[k][0], 0, feet[k][1]), foot: new THREE.Vector3(feet[k][0], 0, feet[k][1]), len, thigh: part(group, segment, foePaint, 0, 0, 0), shin: part(group, segment, foeDark, 0, 0, 0) };
    pose(leg);
    return leg;
  });
}

/**
 * Co-op's crawler, along -Z: a knee-high spider drone, a flat body on six scuttling legs (in two
 * tripods), its back one swollen fungal blister about to burst, two taken-over eyes.
 */
function crawlerMesh() {
  const group = new THREE.Group();
  part(group, new THREE.BoxGeometry(1.1, 0.35, 1.3), foeDark, 0, 0.75, 0);
  part(group, new THREE.BoxGeometry(0.9, 0.12, 1.0), foePaint, 0, 0.98, 0);
  for (const x of [-0.22, 0.22]) part(group, ball, foeGlow, x, 0.8, -0.66).scale.setScalar(0.08);
  const fungus = blobs(group, [[0, 1.15, 0.1, 0.42], [0.35, 1.05, 0.4, 0.18], [-0.3, 1.0, -0.3, 0.14]]);
  const rows = [-0.45, 0, 0.45];
  const hips = rows.flatMap((z) => [[-0.5, 0.75, z], [0.5, 0.75, z]]);
  const feet = rows.flatMap((z) => [[-1.15, z * 1.6], [1.15, z * 1.6]]);
  const legs = legsOf(group, hips, feet, 0.75, 0.06);
  // Tripods: front and back on one side with the middle on the other.
  const phases = [0, Math.PI, Math.PI, 0, 0, Math.PI];
  group.userData = { legs, fungus, stride: 0.8, phases };
  return group;
}

/**
 * Co-op's mortar walker, along -Z: a walker's chassis on four legs splayed wide, a fat tube on its
 * back angled up (`userData.body`, raised further as it digs in), fungus round the breech.
 */
function mortarMesh() {
  const group = new THREE.Group();
  part(group, new THREE.BoxGeometry(2.2, 0.9, 2.6), foePaint, 0, 1.8, 0);
  part(group, new THREE.BoxGeometry(1.8, 0.4, 2.2), foeDark, 0, 1.25, 0);
  const tube = new THREE.Group();
  tube.position.set(0, 2.3, 0.4);
  tube.userData.rest = -0.6;
  tube.rotation.x = -0.6;
  group.add(tube);
  part(tube, new THREE.CylinderGeometry(0.42, 0.5, 2.6, 12), foeDark, 0, 1.1, 0);
  part(tube, new THREE.TorusGeometry(0.46, 0.08, 6, 16).rotateX(Math.PI / 2), foeHazard, 0, 2.3, 0);
  part(tube, ball, foeGlow, 0, 2.4, 0).scale.set(0.3, 0.05, 0.3); // the glow down its mouth
  const fungus = blobs(group, [[0.7, 2.4, 1.0, 0.28], [-0.8, 2.3, 0.9, 0.22], [0.9, 1.8, -0.9, 0.18], [-0.4, 2.4, -0.8, 0.16]]);
  const legs = legsOf(group, [[-1, 1.6, -1.1], [1, 1.6, -1.1], [-1, 1.6, 1.1], [1, 1.6, 1.1]], [[-2.4, -2.0], [2.4, -2.0], [-2.4, 2.0], [2.4, 2.0]], 1.6, 0.14);
  group.userData = { legs, body: tube, fungus, stride: 1.3, phases: [0, Math.PI, Math.PI, 0] };
  return group;
}

/**
 * Co-op's shield node, along -Z: a tall thin tripod, a mast up from its hub to a great glowing
 * fungal bulb (what throws the dome), smaller growths down the mast.
 */
function nodeMesh() {
  const group = new THREE.Group();
  part(group, new THREE.CylinderGeometry(0.5, 0.7, 0.6, 8), foeDark, 0, 1.6, 0);
  part(group, new THREE.CylinderGeometry(0.12, 0.18, 2.6, 6), foePaint, 0, 3.2, 0);
  part(group, new THREE.TorusGeometry(0.55, 0.06, 6, 20).rotateX(Math.PI / 2), foeHazard, 0, 4.0, 0);
  const fungus = blobs(group, [[0, 4.6, 0, 0.6], [0.2, 3.1, 0.15, 0.16], [-0.18, 2.6, -0.12, 0.13]]);
  const hips = [0, 1, 2].map((k) => [0.4 * Math.sin((k * 2 * Math.PI) / 3), 1.5, 0.4 * Math.cos((k * 2 * Math.PI) / 3)]);
  const feet = [0, 1, 2].map((k) => [1.6 * Math.sin((k * 2 * Math.PI) / 3), 1.6 * Math.cos((k * 2 * Math.PI) / 3)]);
  const legs = legsOf(group, hips, feet, 1.2, 0.08);
  group.userData = { legs, fungus, stride: 1.0, phases: [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3] };
  return group;
}

/**
 * Co-op's first boss, the Excavator, along -Z: a mining drill rig on two great treads, its body
 * and cab over them, a huge cone drill on an arm out front (`userData.drill`, turning), fungus
 * thick over its back.
 */
function excavatorMesh() {
  const group = new THREE.Group();
  for (const x of [-2.6, 2.6]) {
    part(group, new THREE.BoxGeometry(1.8, 2.0, 9.0), foeDark, x, 1.0, 0.5);
    for (let z = -3; z <= 4; z += 1.75) part(group, new THREE.CylinderGeometry(0.8, 0.8, 1.9, 10).rotateZ(Math.PI / 2), foePaint, x, 1.0, z);
  }
  part(group, new THREE.BoxGeometry(5.0, 3.0, 7.0), foePaint, 0, 3.4, 1.0);
  part(group, new THREE.BoxGeometry(2.2, 2.0, 2.4), foeDark, -1.2, 5.9, 2.4); // the cab
  part(group, ball, foeGlow, -1.2, 6.0, 1.18).scale.set(0.8, 0.3, 0.05); // its window, taken over
  part(group, new THREE.BoxGeometry(5.1, 0.5, 7.1), foeHazard, 0, 2.1, 1.0);
  part(group, new THREE.BoxGeometry(1.6, 1.4, 3.2), foeDark, 0, 3.6, -3.4); // the arm
  const drill = new THREE.Group();
  drill.position.set(0, 3.6, -5.2);
  group.add(drill);
  const cone = part(drill, new THREE.ConeGeometry(2.0, 4.2, 10), foeHazard, 0, 0, -2.0);
  cone.rotation.x = -Math.PI / 2;
  for (let k = 0; k < 4; k++) part(drill, new THREE.BoxGeometry(0.25, 3.6, 0.3), foeDark, 0, 0, -1.6).rotation.z = (k * Math.PI) / 4;
  const fungus = blobs(group, [[1.8, 5.1, 3.6, 0.9], [-1.9, 5.0, -0.5, 0.7], [0.6, 5.2, 0.8, 0.6], [2.4, 4.0, -1.8, 0.5], [-2.5, 3.8, 3.8, 0.55], [1.0, 4.4, 4.6, 0.45]]);
  group.userData = { legs: [], drill, fungus, stride: 1, phases: [] };
  return group;
}

/**
 * Co-op's last boss, the Hive walker, along -Z: a towering six-legged walker, a long hull slung
 * between its legs, and on its back the hive's sac (`userData.sac`), great and heaving, crawlers
 * clinging round it.
 */
function hiveMesh() {
  const group = new THREE.Group();
  part(group, new THREE.BoxGeometry(5.0, 2.4, 9.0), foePaint, 0, 6.4, 0);
  part(group, new THREE.BoxGeometry(4.2, 1.0, 8.0), foeDark, 0, 4.9, 0);
  part(group, new THREE.BoxGeometry(2.4, 1.6, 2.0), foeDark, 0, 6.6, -5.2); // its head
  for (const x of [-0.6, 0.6]) part(group, ball, foeGlow, x, 6.8, -6.25).scale.setScalar(0.25);
  const sac = part(group, ball, foeGlow, 0, 9.6, 0.8);
  sac.userData.r = 3.0;
  sac.scale.setScalar(3.0);
  const fungus = blobs(group, [[2.4, 8.0, -2.6, 0.8], [-2.3, 8.1, 3.4, 0.9], [1.6, 7.8, 4.2, 0.6], [-1.8, 7.9, -3.2, 0.55]]);
  const rows = [-3.2, 0, 3.2];
  const hips = rows.flatMap((z) => [[-2.4, 6.0, z], [2.4, 6.0, z]]);
  const feet = rows.flatMap((z) => [[-6.5, z * 1.4], [6.5, z * 1.4]]);
  const legs = legsOf(group, hips, feet, 4.4, 0.4);
  group.userData = { legs, sac, fungus, stride: 3.2, phases: [0, Math.PI, Math.PI, 0, 0, Math.PI] };
  return group;
}

/**
 * Co-op's ore brute, along -Z: a squat ore hauler on four thick legs, a great hazard-striped plow
 * plate across its front, a cab on top; its body (`userData.body`) rears back to smash down.
 * Fungus bulges from its seams.
 */
function bruteMesh() {
  const group = new THREE.Group(), body = new THREE.Group();
  body.position.y = 2.4;
  group.add(body);
  part(body, new THREE.BoxGeometry(3.8, 2.0, 4.2), foePaint, 0, 0.4, 0.3);
  part(body, new THREE.BoxGeometry(3.4, 0.6, 3.6), foeDark, 0, -0.8, 0.3);
  part(body, new THREE.BoxGeometry(1.8, 1.2, 1.6), foeDark, -0.6, 1.9, 0.9); // the cab
  part(body, ball, foeGlow, -0.6, 2.0, 0.08).scale.set(0.5, 0.18, 0.05); // its window, taken over
  // The plow: a plate leaning forward, striped.
  const plow = new THREE.Group();
  plow.position.set(0, 0, -2.1);
  plow.rotation.x = -0.25;
  body.add(plow);
  part(plow, new THREE.BoxGeometry(5.2, 2.6, 0.35), foeHazard, 0, 0, 0);
  for (let k = -2; k <= 2; k++) part(plow, new THREE.BoxGeometry(0.45, 2.62, 0.37), foeDark, k * 1.05, 0, 0).rotation.z = 0.5;
  const fungus = blobs(body, [[1.6, 1.3, 1.6, 0.55], [-1.7, 0.9, 1.9, 0.45], [1.2, 1.5, -1.2, 0.35], [-1.0, 1.4, -1.5, 0.3], [0.2, 1.5, 2.3, 0.4], [1.95, -0.2, 0.2, 0.3]]);
  const hips = [[-1.6, 2.0, -1.4], [1.6, 2.0, -1.4], [-1.6, 2.0, 1.8], [1.6, 2.0, 1.8]];
  const feet = [[-2.8, -1.8], [2.8, -1.8], [-2.8, 2.4], [2.8, 2.4]];
  const legs = legsOf(group, hips, feet, 1.9, 0.32);
  group.userData = { legs, body, fungus, stride: 2.2, phases: [0, Math.PI, Math.PI, 0] };
  return group;
}

/**
 * A co-op pylon, its foot at y 0, its glowing part `userData.glow`: the arc pylon a mast wound
 * with coils, a ball at its top; the pulse pylon a squat drum under an emitter ring.
 */
function pylonMesh(kind) {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x50565e, roughness: 0.5, metalness: 0.6 });
  const glow = new THREE.Mesh(kind === ARC ? new THREE.SphereGeometry(0.35, 12, 8) : new THREE.TorusGeometry(0.9, 0.12, 8, 24), hot(new THREE.MeshBasicMaterial({ color: 0xffffff })));
  const add = (geometry, y) => {
    const mesh = new THREE.Mesh(geometry, steel);
    mesh.position.y = y;
    group.add(mesh);
  };
  add(new THREE.CylinderGeometry(0.7, 0.9, 0.4, 10), 0.2);
  if (kind === ARC) {
    add(new THREE.CylinderGeometry(0.12, 0.18, 2.6, 8), 1.6);
    for (const y of [1.0, 1.6, 2.2]) add(new THREE.TorusGeometry(0.32 - 0.05 * y, 0.06, 6, 16).rotateX(Math.PI / 2), y);
    glow.position.y = 3.0;
  } else {
    add(new THREE.CylinderGeometry(0.55, 0.65, 1.6, 12), 1.2);
    glow.rotation.x = Math.PI / 2;
    glow.position.y = 2.2;
  }
  group.add(glow);
  group.userData = { glow };
  return group;
}

/**
 * Co-op's reactor, its foot at y 0: a squat plant drum, a glowing core column (`userData.core`)
 * inside four struts, and rings round it.
 */
function reactorMesh() {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.5, metalness: 0.6 });
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(5, 5.5, 3, 24), steel);
  drum.position.y = 1.5;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 11, 16), hot(new THREE.MeshBasicMaterial({ color: 0x66ccff })));
  core.position.y = 8.5;
  group.add(drum, core);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2, strut = new THREE.Mesh(new THREE.BoxGeometry(0.5, 12, 0.5), steel);
    strut.position.set(2.6 * Math.cos(a), 9, 2.6 * Math.sin(a));
    group.add(strut);
  }
  for (const y of [5, 9, 13]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.18, 8, 24), steel);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    group.add(ring);
  }
  group.userData = { core };
  return group;
}

/** A battleship, bow along -Z: hull, keel, bridge, two engines, and a stripe in its side's color (`userData.accent`). */
function shipMesh() {
  const group = new THREE.Group(), metal = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.6, metalness: 0.4 });
  const box = (w, h, d, x, y, z, material = metal) => group.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material).translateX(x).translateY(y).translateZ(z));
  box(8, 3.5, 24, 0, 0, 0); // hull
  box(4, 2, 18, 0, -2.6, -1); // keel
  box(5, 3, 6, 0, 3.2, 6); // bridge
  box(2.4, 1.2, 9, 0, 2.3, -6); // forward gun deck
  const accent = hot(new THREE.MeshBasicMaterial({ color: NEUTRAL }));
  box(8.1, 0.5, 20, 0, 0.6, -1, accent);
  group.userData.accent = accent;
  group.userData.engines = [-3, 3].map((x) => {
    const engine = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 5, 10).rotateX(Math.PI / 2), metal);
    engine.position.set(x, -0.5, 13);
    group.add(engine);
    const nozzle = new THREE.Object3D();
    nozzle.position.set(x, -0.5, 15.8);
    group.add(nozzle);
    return nozzle;
  });
  return group;
}

const backward = (group) => new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion);
