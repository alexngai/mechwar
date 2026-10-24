// The objective modes on the client.
// - Capture zones (Missile Assault's silos, Siege's AA gun): a ring on the ground and a beacon into
//   the sky in the color of whoever holds it (our side blue, theirs red, nobody white), and the
//   capture's progress as a second ring filling in.
// - Missile Assault: each silo's launch pad (hatch doors, lamps in its holder's color), whose rocket
//   climbs slowly out of the tube when it fires, turns over and dives onto the enemy base.
// - Siege: the energy station (green, filling with what it holds), dropped energy, and the
//   battleships (deployables of kind 4) with the fire between them, the AA gun and the bases, and
//   their engines' drone.
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
/** Match sim/src/siege.rs: STATION_CAP, SHIP_HULL, AA_RANGE, DUEL_RANGE, BOMBARD_RANGE. */
const STATION_CAP = 400, AA_RANGE = 150, DUEL_RANGE = 120, BOMBARD_RANGE = 6;
export const SHIP_HULL = 3000;
/** The deployable kind of a battleship. */
export const SHIP = 4;

export class Objectives {
  /** `cast(ox, oy, oz, dx, dy, dz, max)`: how far a ray goes into the arena, up to `max`. */
  constructor(scene, fx, sound, cast) {
    Object.assign(this, { scene, fx, sound, cast, silos: [], aa: [], zones: [], labels: [], stations: [], bases: [], missiles: [], ships: new Map(), drops: [], fire: {}, seen: null });
    this.dropGeometry = new THREE.OctahedronGeometry(0.6);
    this.dropMaterial = hot(new THREE.MeshBasicMaterial({ color: ENERGY }));
  }

  /** Builds the zones and stations of `map` (its JSON), clearing the last map's. */
  setMap(map) {
    const gone = (o) => {
      this.scene.remove(o);
      o.traverse((m) => { if (m.geometry !== this.dropGeometry) m.geometry?.dispose(); if (m.material !== this.dropMaterial) m.material?.dispose(); });
    };
    for (const z of [...this.silos, ...this.aa, ...this.stations]) gone(z.group);
    for (const s of this.ships.values()) gone(s.group);
    for (const m of [...this.missiles.map((m) => m.mesh), ...this.drops]) this.scene.remove(m);
    Object.assign(this, { missiles: [], ships: new Map(), drops: [] });
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
    this.seen = null;
    this.stations = (o.stations ?? []).map(({ at, radius, band }) => ({ ...marker(this.scene, at, radius, ENERGY), radius, band, shown: null }));
    this.sky = o.sky ?? 50;
  }

  /**
   * Shows each zone's state from `zones` (three floats each: holder, progress, contested; see
   * WasmNetClient.zones), colored by side for a player on `myTeam`.
   */
  update(zones, myTeam, friend, foe, now) {
    const color = (team) => (team < 0 ? NEUTRAL : team === myTeam ? friend : foe);
    // The mode on says which: Missile Assault's three silos, or Siege's AA gun; none in the rest.
    [this.zones, this.labels] = zones.length === 9 ? [this.silos, ['A', 'B', 'C']] : zones.length === 3 ? [this.aa, ['AA']] : [[], []];
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
    });
    return cues;
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
    const holder = zones.length ? zones[0] : -1, aa = this.aa[0]?.at;
    for (const s of this.ships.values()) {
      if (aa && holder >= 0 && holder !== s.team && s.pos.distanceTo(aa) <= AA_RANGE && every(`aa${s.team}`, 220)) this.tracer(aa.clone().addScaledVector(UP, 2), s.group.position);
      const base = this.bases[1 - s.team];
      if (base && Math.hypot(s.pos.x - base.x, s.pos.z - base.z) <= BOMBARD_RANGE + 1 && every(`bomb${s.team}`, 700)) {
        this.tracer(s.group.position.clone().addScaledVector(UP, -6), base);
        this.fx.explosion(base, 1.2);
        this.sound.shipGun(s.group.position);
        this.sound.blast(14, base);
      }
    }
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
   * `siege`): each zone's label in its holder's color (flashing contested), and each station.
   */
  markers(zones, siege) {
    if (!zones.length) return [];
    const marks = this.zones.map((s, i) => ({ label: this.labels[i], at: s.at, owner: zones[3 * i], contested: !!zones[3 * i + 2] }));
    return siege.length ? marks.concat(this.stations.map((s) => ({ label: 'E', at: s.at, owner: -1, contested: false, color: ENERGY }))) : marks;
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
