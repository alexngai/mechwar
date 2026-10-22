//! Shared mech sim: pure Rust so a native server can link it later.
//! The `wasm` feature adds the browser bindings in `wasm.rs`.

use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};

pub mod arsenal;
pub mod bot;
pub mod client;
pub mod collide;
pub mod game;
pub mod item;
pub mod map;
pub mod net;
pub mod projectile;
pub mod weapon;
#[cfg(feature = "wasm")]
mod wasm;

pub use arsenal::{Arsenal, Loadout};
pub use map::Map;
pub use rapier3d::prelude::Vector;

pub const TICK_HZ: f32 = 30.0;
pub const DT: f32 = 1.0 / TICK_HZ;

/// Every sim constant. Values live in `tuning.json` at the repo root, which also records
/// each value's source and slider range. Client-only keys (camera) are ignored here.
/// `tuning.json` is the B class with its own weapons; `classes.json` overrides values per class
/// and `weapons.json` per weapon (see `arsenal.rs`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Tuning {
    pub walk_speed: f32,
    pub ground_accel: f32,
    pub ground_decel: f32,
    pub air_control: f32,
    pub gravity: f32,
    pub max_slope_deg: f32,
    pub step_height: f32,
    pub snap_distance: f32,
    pub skin: f32,

    pub boost_speed: f32,
    pub boost_accel: f32,
    pub boost_drain: f32,
    pub boost_min_fuel: f32,

    pub dodge_speed: f32,
    pub dodge_duration: f32,
    pub dodge_drag: f32,
    pub dodge_cooldown: f32,
    pub dodge_fuel_cost: f32,

    pub hover_rise_speed: f32,
    pub hover_rise_time: f32,
    pub hover_sink_speed: f32,
    pub hover_response: f32,
    pub hover_drain: f32,
    pub hover_min_fuel: f32,

    pub fuel_max: f32,
    pub fuel_regen: f32,
    pub fuel_regen_delay: f32,

    pub heat_max: f32,
    pub fire_rate: f32,
    pub heat_per_shot: f32,
    pub heat_decay: f32,
    pub heat_decay_delay: f32,
    pub overheat_decay: f32,
    pub overheat_release: f32,
    pub weapon_range: f32,

    /// Primary weapon: spread cone and bloom (deg), pellets per shot, hitscan falloff, and
    /// projectile primaries when `shot_speed > 0`; see `weapon.rs`.
    pub spread_deg: f32,
    pub bloom_per_shot: f32,
    pub bloom_max: f32,
    pub bloom_recovery: f32,
    pub pellets: f32,
    pub falloff_start: f32,
    pub falloff_end: f32,
    pub falloff_floor: f32,
    pub shot_speed: f32,
    pub shot_gravity: f32,
    pub shot_radius: f32,

    pub mech_radius: f32,
    pub mech_height: f32,
    pub eye_height: f32,
    pub pitch_limit_deg: f32,
    /// Shares out pushes when mechs collide: heavier mechs shove lighter ones.
    pub mech_mass: f32,

    pub health_max: f32,
    pub shot_damage: f32,
    pub respawn_delay: f32,

    pub ability_cooldown: f32,
    pub ability_duration: f32,
    pub slipstream_boost_mult: f32,
    pub brace_damage_mult: f32,
    pub brace_speed_mult: f32,

    /// Secondary weapon: a volley of `alt_count` projectiles; see `projectile.rs`.
    pub alt_cooldown: f32,
    pub alt_heat: f32,
    pub alt_count: f32,
    pub alt_spread_deg: f32,
    pub alt_speed: f32,
    pub alt_loft_deg: f32,
    pub alt_gravity: f32,
    pub alt_bounce: f32,
    pub alt_fuse: f32,
    pub alt_damage: f32,
    pub alt_radius: f32,

    /// Stop-to-repair: shut down for `repair_windup`, then heal at `repair_rate`; once it ends,
    /// still shut down for `repair_standup` while standing back up.
    pub repair_windup: f32,
    pub repair_rate: f32,
    pub repair_standup: f32,

    /// Items, one per slot, each with charges that recharge one at a time; see `item.rs`.
    /// Offensive: a thrown grenade, flown like a secondary shell.
    pub grenade_charges: f32,
    pub grenade_recharge: f32,
    pub grenade_speed: f32,
    pub grenade_loft_deg: f32,
    pub grenade_gravity: f32,
    pub grenade_bounce: f32,
    pub grenade_fuse: f32,
    pub grenade_damage: f32,
    pub grenade_radius: f32,
    /// Support: an EMP that drains nearby enemies' fuel and jams their boost.
    pub emp_charges: f32,
    pub emp_recharge: f32,
    pub emp_radius: f32,
    pub emp_drain: f32,
    pub emp_jam: f32,

    pub bot_turn_rate_deg: f32,
    pub bot_aim_error_deg: f32,
    pub bot_reaction_s: f32,
}

impl Tuning {
    /// Parses the tuning.json format: `{ "name": { "value": 1.0, "source": "...", ... } }`.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        #[derive(Deserialize)]
        struct Entry {
            value: f32,
        }
        let entries: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json)?;
        let mut values = serde_json::Map::new();
        for (name, entry) in entries {
            let Entry { value } = serde_json::from_value(entry)?;
            values.insert(name, value.into());
        }
        serde_json::from_value(values.into())
    }
}

impl Tuning {
    /// This tuning for `class` carrying its own weapons. Builds every loadout: keep an `Arsenal`
    /// where it's needed often.
    pub fn for_class(&self, class: MechClass) -> Tuning {
        Arsenal::new(self).get(class, Loadout::of(class)).clone()
    }
}

/// Mech weight class: A light, B medium (the base tuning), C heavy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MechClass {
    A,
    #[default]
    B,
    C,
}

impl MechClass {
    pub const ALL: [MechClass; 3] = [MechClass::A, MechClass::B, MechClass::C];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_index(i: u8) -> Option<MechClass> {
        Self::ALL.get(usize::from(i)).copied()
    }

    pub(crate) fn key(self) -> &'static str {
        ["A", "B", "C"][self.index()]
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Self::from_json(include_str!("../../tuning.json")).expect("tuning.json is valid")
    }
}

/// One tick of player intent. `dodge` is -1/+1 (left/right) only on the tick the key went down.
#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize)]
pub struct Input {
    pub move_x: f32,
    pub move_z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub boost: bool,
    pub hover: bool,
    pub dodge: i8,
    pub fire: bool,
    /// Secondary weapon, held like `fire`.
    pub alt_fire: bool,
    /// Class ability; like `dodge`, only on the tick the key went down.
    pub ability: bool,
    /// Held to repair; see `step_mech`.
    pub repair: bool,
    /// Items, also only on the tick the key went down.
    pub grenade: bool,
    pub emp: bool,
}

impl Input {
    /// Untrusted input reduced to what a real client can send: finite, axes in [-1, 1], dodge a direction.
    pub fn sanitized(self) -> Input {
        let finite = |v: f32| if v.is_finite() { v } else { 0.0 };
        Input {
            move_x: finite(self.move_x).clamp(-1.0, 1.0),
            move_z: finite(self.move_z).clamp(-1.0, 1.0),
            yaw: finite(self.yaw),
            pitch: finite(self.pitch),
            dodge: self.dodge.signum(),
            ..self
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Mech {
    /// Picks the ability `step_mech` applies.
    pub class: MechClass,
    /// The weapons carried; with `class`, picks this mech's tuning (`Arsenal::of`).
    pub loadout: Loadout,
    /// Dead at 0 or below: `step_mech` leaves a dead mech alone.
    pub health: f32,
    /// Seconds the ability stays active, and until it can be used again.
    pub ability_time: f32,
    pub ability_cooldown: f32,
    /// Feet position (bottom of the capsule).
    pub pos: Vector,
    pub vel: Vector,
    pub yaw: f32,
    pub pitch: f32,
    pub grounded: bool,
    pub boosting: bool,
    pub hovering: bool,
    pub hover_time: f32,
    pub fuel: f32,
    pub fuel_regen_wait: f32,
    pub dodge_cooldown: f32,
    pub dodge_time: f32,
    pub heat: f32,
    pub heat_wait: f32,
    pub overheated: bool,
    pub fire_wait: f32,
    /// Seconds until the secondary can fire again.
    pub alt_wait: f32,
    /// Degrees the primary's cone has grown from firing, on top of `spread_deg`.
    pub bloom: f32,
    /// Where the aim ray from the eye lands (for the crosshair).
    pub aim_point: Vector,
    /// Set on ticks a shot fired.
    pub shot: bool,
    /// Set on ticks the secondary launched a volley.
    pub launched: bool,
    /// The secondary trigger as of the last tick, and set on ticks it went down: a press bursts
    /// the mech's armed shells in flight (`projectile::detonate`).
    pub alt_held: bool,
    pub alt_pressed: bool,
    /// Seconds into the current repair; 0 when not repairing.
    pub repair_time: f32,
    /// Seconds left standing back up after a repair: still shut down, and still crouched.
    pub stand_up: f32,
    /// Item charges left, and seconds until the next one comes back (0 when full).
    pub grenades: u8,
    pub grenade_wait: f32,
    pub emps: u8,
    pub emp_wait: f32,
    /// Seconds an enemy EMP keeps boost off.
    pub jammed: f32,
    /// Set on ticks a grenade was thrown, and an EMP went off.
    pub threw: bool,
    pub pulsed: bool,
}

/// Static arena colliders for scene queries. Shared by the offline sim, the server and the client.
pub struct Arena {
    pub(crate) world: PhysicsWorld,
}

impl Arena {
    pub fn new(map: &Map) -> Self {
        let mut world = PhysicsWorld::default();
        for b in &map.solids {
            let [hx, hy, hz] = b.half;
            let rotation = Rotation::from_rotation_y(b.yaw.to_radians()) * Rotation::from_rotation_x(b.tilt.to_radians());
            let collider = ColliderBuilder::cuboid(hx, hy, hz)
                .translation(Vector::from_array(b.center))
                .rotation(rotation.to_scaled_axis());
            world.insert_collider(collider, None);
        }
        // Builds the broad phase so scene queries see the static colliders. No physics step runs.
        world.detect_collisions(&(), &());
        Self { world }
    }
}

impl Arena {
    /// Distance along `ray` (unit direction) to the first arena surface within `max`.
    pub fn cast_ray(&self, ray: &Ray, max: f32) -> Option<f32> {
        self.world.query_pipeline().cast_ray(ray, max, true).map(|(_, toi)| toi)
    }

    /// Like `cast_ray`, plus the surface normal there.
    pub fn cast_ray_normal(&self, ray: &Ray, max: f32) -> Option<(f32, Vector)> {
        self.world.query_pipeline().cast_ray_and_get_normal(ray, max, true).map(|(_, hit)| (hit.time_of_impact, hit.normal))
    }
}

impl Mech {
    /// Ends a running repair (released, full, or damaged on the server); it stands back up first.
    pub fn end_repair(&mut self, t: &Tuning) {
        if self.repair_time > 0.0 {
            self.repair_time = 0.0;
            self.stand_up = t.repair_standup;
        }
    }
}

/// A fresh mech standing at `pos` with full fuel, health and item charges.
pub fn spawn_mech(t: &Tuning, pos: Vector) -> Mech {
    Mech { pos, fuel: t.fuel_max, health: t.health_max, grenades: t.grenade_charges as u8, emps: t.emp_charges as u8, ..Mech::default() }
}

/// Collision shape, centered `mech_height / 2` above the feet.
pub fn mech_capsule(t: &Tuning) -> Capsule {
    capsule(t, t.mech_height)
}

/// A repairing mech crouches: its hit shape is this much of its height.
pub const CROUCH: f32 = 0.8;

/// What shots and blasts hit, and its center: the collision shape, but crouched while repairing.
/// (Collision keeps full height: a repairing mech doesn't move, and standing up can't snag.)
pub fn hit_shape(t: &Tuning, m: &Mech) -> (Capsule, Vector) {
    let height = t.mech_height * if m.repair_time > 0.0 || m.stand_up > 0.0 { CROUCH } else { 1.0 };
    (capsule(t, height), m.pos + Vector::Y * (height * 0.5))
}

fn capsule(t: &Tuning, height: f32) -> Capsule {
    let radius = t.mech_radius.min(height * 0.5);
    Capsule::new_y(height * 0.5 - radius, radius)
}

/// Eye position and look direction.
pub fn aim_ray(t: &Tuning, m: &Mech) -> Ray {
    let dir = Rotation::from_rotation_y(m.yaw) * Rotation::from_rotation_x(m.pitch) * Vector::NEG_Z;
    Ray::new(m.pos + Vector::Y * t.eye_height, dir)
}

/// Single-player wrapper used by the offline sandbox.
pub struct Sim {
    /// For `class` carrying `loadout`.
    pub tuning: Tuning,
    pub class: MechClass,
    pub loadout: Loadout,
    pub mech: Mech,
    /// Secondary fire and grenades in flight; offline they only meet the arena.
    pub projectiles: Vec<projectile::Projectile>,
    /// Where projectiles burst since the page last took them, with their blast radius.
    pub blasts: Vec<(f32, Vector)>,
    /// Where hitscan pellets stopped since the page last took them.
    pub shots: Vec<Vector>,
    /// Steps so far: stands in for the input seq that seeds the spread online and tells this
    /// mech's projectiles apart.
    seq: u32,
    arena: Arena,
    /// Team 0's first spawn on the map.
    spawn: Vector,
}

impl Sim {
    pub fn new(tuning: Tuning) -> Self {
        Self::with_map(tuning, map::DEFAULT)
    }

    pub fn with_map(tuning: Tuning, map: usize) -> Self {
        let map = Map::load(map);
        let spawn = Vector::from_array(map.spawns[0][0]);
        let mut sim = Self { tuning, class: MechClass::B, loadout: Loadout::of(MechClass::B), mech: Mech::default(), projectiles: Vec::new(), blasts: Vec::new(), shots: Vec::new(), seq: 0, arena: Arena::new(&map), spawn };
        sim.reset();
        sim
    }

    pub fn reset(&mut self) {
        self.mech = Mech { class: self.class, loadout: self.loadout, ..spawn_mech(&self.tuning, self.spawn) };
    }

    pub fn step(&mut self, input: &Input) {
        self.seq += 1;
        let t = &self.tuning;
        step_mech(&self.arena, t, &mut self.mech, input);
        if self.mech.alt_pressed {
            projectile::detonate(0, &mut self.projectiles);
        }
        if self.mech.launched {
            self.projectiles.extend(projectile::volley(t, &self.mech, 0, self.seq));
        }
        if self.mech.threw {
            self.projectiles.push(projectile::grenade(t, &self.mech, 0, self.seq));
        }
        if self.mech.shot && t.shot_speed > 0.0 {
            self.projectiles.extend(weapon::volley(t, &self.mech, 0, self.seq));
        } else if self.mech.shot {
            let arena = &self.arena;
            self.shots.extend(weapon::pellets(t, &self.mech, self.seq).iter().map(|r| r.point_at(arena.cast_ray(r, t.weapon_range).unwrap_or(t.weapon_range))));
        }
        let (arena, blasts) = (&self.arena, &mut self.blasts);
        self.projectiles.retain_mut(|p| {
            let radius = projectile::radius(t, p);
            match projectile::fly(arena, &projectile::tuning_for(t, p.n), p, |_, _| None) {
                Some(at) => {
                    blasts.push((radius, at));
                    false
                }
                None => true,
            }
        });
    }

    pub fn arena(&self) -> &Arena {
        &self.arena
    }
}

/// One fixed tick of one mech. The client predicts with this and the server replays the same inputs
/// through it, so both must see identical inputs, tuning and arena.
pub fn step_mech(arena: &Arena, t: &Tuning, m: &mut Mech, input: &Input) {
    // Last tick's shot widens the cone from now on; its own pellets used the cone before the kick.
    if m.shot {
        m.bloom = (m.bloom + t.bloom_per_shot).min(t.bloom_max);
    }
    m.shot = false;
    m.launched = false;
    m.alt_pressed = false;
    m.threw = false;
    m.pulsed = false;
    if m.health <= 0.0 {
        return;
    }

    // Repair: holding it shuts the mech down, ignoring every other input but look, and after the
    // wind-up heals. Letting go, full health or damage (on the server) ends it, and it stays shut
    // down a moment more standing back up. There's no cooldown: it can go straight back down.
    let repairing = input.repair && (m.repair_time > 0.0 || m.health < t.health_max);
    if repairing {
        m.stand_up = 0.0;
        m.repair_time += DT;
        // The partial first tick keeps the total heal at exactly rate * (time - windup).
        m.health = (m.health + t.repair_rate * (m.repair_time - t.repair_windup).clamp(0.0, DT)).min(t.health_max);
        if m.health >= t.health_max {
            m.end_repair(t);
        }
    } else {
        m.end_repair(t);
    }
    let shutdown = repairing || m.stand_up > 0.0;
    // Half a tick of slack so the stand-up ends on a whole tick despite float sums.
    m.stand_up = if m.stand_up > DT * 1.5 { m.stand_up - DT } else { 0.0 };
    let input = &if shutdown { Input { yaw: input.yaw, pitch: input.pitch, ..Input::default() } } else { *input };

    m.yaw = input.yaw;
    let pitch_limit = t.pitch_limit_deg.to_radians();
    m.pitch = input.pitch.clamp(-pitch_limit, pitch_limit);
    let yaw_rot = Rotation::from_rotation_y(m.yaw);
    let forward = yaw_rot * Vector::NEG_Z;
    let right = yaw_rot * Vector::X;
    let wish = (forward * input.move_z + right * input.move_x).clamp_length_max(1.0);
    let has_move = wish.length_squared() > 1e-6;

    m.dodge_cooldown = (m.dodge_cooldown - DT).max(0.0);
    m.dodge_time = (m.dodge_time - DT).max(0.0);

    // Class ability: Slipstream (A) frees and speeds up boost, Vent (B) dumps heat at once,
    // Brace (C) trades speed and boost for less damage (applied by the server).
    m.ability_time = (m.ability_time - DT).max(0.0);
    m.ability_cooldown = (m.ability_cooldown - DT).max(0.0);
    if input.ability && m.ability_cooldown <= 0.0 {
        m.ability_time = t.ability_duration;
        m.ability_cooldown = t.ability_cooldown;
        if m.class == MechClass::B {
            m.heat = 0.0;
            m.overheated = false;
        }
    }
    let slipstream = m.class == MechClass::A && m.ability_time > 0.0;
    let brace = m.class == MechClass::C && m.ability_time > 0.0;
    item::step(t, m, input);

    // Fuel spenders: boost, dodge, hover.
    let mut used_fuel = false;
    // Starting needs boost_min_fuel so an empty tank doesn't flicker boost on each regen tick.
    let fuel_ok = slipstream || (m.fuel > 0.0 && (m.boosting || m.fuel >= t.boost_min_fuel));
    // Thrusters push forward: boost needs a forward input (W, or W with a strafe to curve).
    m.boosting = !brace && m.jammed <= 0.0 && input.boost && input.move_z > 0.1 && fuel_ok;
    if m.boosting && !slipstream {
        m.fuel -= t.boost_drain * DT;
        used_fuel = true;
    }

    if input.dodge != 0 && m.dodge_cooldown <= 0.0 && m.fuel >= t.dodge_fuel_cost {
        // Raise velocity along the dodge direction to dodge_speed; keep the rest.
        let dir = right * f32::from(input.dodge.signum());
        let along = m.vel.dot(dir);
        if along < t.dodge_speed {
            m.vel += dir * (t.dodge_speed - along);
        }
        m.fuel -= t.dodge_fuel_cost;
        used_fuel = true;
        m.dodge_cooldown = t.dodge_cooldown;
        m.dodge_time = t.dodge_duration;
    }

    let can_hover = m.fuel > 0.0 && (m.hovering || m.fuel >= t.hover_min_fuel);
    if input.hover && can_hover {
        if !m.hovering {
            m.hover_time = 0.0;
        }
        m.hovering = true;
        m.fuel -= t.hover_drain * DT;
        used_fuel = true;
    } else {
        m.hovering = false;
    }

    m.fuel = m.fuel.max(0.0);
    if used_fuel {
        m.fuel_regen_wait = t.fuel_regen_delay;
    } else {
        m.fuel_regen_wait = (m.fuel_regen_wait - DT).max(0.0);
        if m.fuel_regen_wait == 0.0 {
            m.fuel = (m.fuel + t.fuel_regen * DT).min(t.fuel_max);
        }
    }

    // Horizontal: move toward the target velocity at a capped acceleration.
    let target = wish
        * if m.boosting {
            t.boost_speed * if slipstream { t.slipstream_boost_mult } else { 1.0 }
        } else {
            t.walk_speed * if brace { t.brace_speed_mult } else { 1.0 }
        };
    let mut accel = if m.dodge_time > 0.0 {
        t.dodge_drag
    } else if m.boosting {
        t.boost_accel
    } else if has_move {
        t.ground_accel
    } else {
        t.ground_decel
    };
    if !m.grounded {
        accel *= t.air_control;
    }
    let h = Vector::new(m.vel.x, 0.0, m.vel.z);
    let dv = target - h;
    let h = h + dv.clamp_length_max(accel * DT);
    m.vel.x = h.x;
    m.vel.z = h.z;

    // Vertical: authored hover curve while hovering, gravity otherwise.
    if m.hovering {
        let target_vy = hover_curve(t, m.hover_time);
        m.vel.y += (target_vy - m.vel.y) * (t.hover_response * DT).min(1.0);
        m.hover_time += DT;
    } else if m.grounded {
        // Pushing into the floor every tick makes Rapier's slide stall; snap_to_ground holds slopes.
        m.vel.y = 0.0;
    } else {
        m.vel.y -= t.gravity * DT;
    }

    // Kinematic move against the arena.
    let shape = mech_capsule(t);
    let radius = shape.radius;
    let pose = Pose::from_translation(m.pos + Vector::Y * (t.mech_height * 0.5));
    let controller = KinematicCharacterController {
        offset: CharacterLength::Absolute(t.skin),
        max_slope_climb_angle: t.max_slope_deg.to_radians(),
        min_slope_slide_angle: t.max_slope_deg.to_radians(),
        snap_to_ground: (t.snap_distance > 0.0).then_some(CharacterLength::Absolute(t.snap_distance)),
        autostep: (t.step_height > 0.0).then_some(CharacterAutostep {
            max_height: CharacterLength::Absolute(t.step_height),
            min_width: CharacterLength::Absolute(radius),
            include_dynamic_bodies: false,
        }),
        ..Default::default()
    };
    let queries = arena.world.query_pipeline();
    let max_slope = controller.max_slope_climb_angle;
    let vel = &mut m.vel;
    let moved = controller.move_shape(DT, &queries, &shape, &pose, *vel * DT, |hit| {
        // Drop velocity into walls and ceilings. Walkable slopes are left alone so speed
        // isn't bled off every tick on ramps. ponytail: this also fires for ledges autostep
        // then climbs, zeroing speed into the step; skip hits below step_height if curbs get added.
        let mut n = hit.hit.normal1;
        if n.dot(hit.translation_remaining) > 0.0 {
            n = -n; // face the normal against the motion
        }
        let into = vel.dot(n);
        if into < 0.0 && Vector::Y.angle_between(n) > max_slope {
            *vel -= n * into;
        }
    });
    m.pos += moved.translation;
    m.grounded = moved.grounded;
    if m.grounded && m.vel.y < 0.0 {
        m.vel.y = 0.0;
    }

    // Aim ray from the eye against the arena; the server adds mechs to this for hits.
    let ray = aim_ray(t, m);
    let toi = arena.cast_ray(&ray, t.weapon_range).unwrap_or(t.weapon_range);
    m.aim_point = ray.point_at(toi);

    // Both weapons share one heat meter, and overheating locks both.
    // ponytail: one shot per tick max, so fire_rate above TICK_HZ caps at 30/s.
    m.fire_wait -= DT;
    m.alt_wait = (m.alt_wait - DT).max(0.0);
    m.bloom = (m.bloom - t.bloom_recovery * DT).max(0.0);
    m.shot = input.fire && !m.overheated && m.fire_wait <= 0.0;
    m.launched = input.alt_fire && !m.overheated && m.alt_wait <= 0.0;
    m.alt_pressed = input.alt_fire && !m.alt_held;
    m.alt_held = input.alt_fire;
    if m.shot {
        m.fire_wait += 1.0 / t.fire_rate;
        m.heat += t.heat_per_shot;
    }
    if m.launched {
        m.alt_wait = t.alt_cooldown;
        m.heat += t.alt_heat;
    }
    if m.shot || m.launched {
        m.heat_wait = t.heat_decay_delay;
        if m.heat >= t.heat_max {
            m.heat = t.heat_max;
            m.overheated = true;
        }
    } else {
        m.heat_wait = (m.heat_wait - DT).max(0.0);
        if m.heat_wait == 0.0 {
            let decay = if m.overheated { t.overheat_decay } else { t.heat_decay };
            m.heat = (m.heat - decay * DT).max(0.0);
        }
    }
    m.fire_wait = m.fire_wait.max(0.0);
    if m.overheated && m.heat <= t.overheat_release {
        m.overheated = false;
    }
}

/// Target vertical speed `time` seconds into a hover: eases from the rise speed down to a slow sink.
pub fn hover_curve(t: &Tuning, time: f32) -> f32 {
    let x = if t.hover_rise_time > 0.0 { (time / t.hover_rise_time).clamp(0.0, 1.0) } else { 1.0 };
    let s = x * x * (3.0 - 2.0 * x);
    t.hover_rise_speed * (1.0 - s) - t.hover_sink_speed * s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(sim: &mut Sim, input: Input, ticks: usize) {
        for _ in 0..ticks {
            sim.step(&input);
        }
    }

    #[test]
    fn fuel_drain_regen_and_dodge_cooldown() {
        let t = Tuning::default();
        let mut sim = Sim::with_map(t.clone(), map::Map::index("blockout").unwrap());
        let idle = Input::default();
        run(&mut sim, idle, 30);
        assert!(sim.mech.grounded, "mech should land on the floor");
        assert_eq!(sim.mech.fuel, t.fuel_max);

        // Boost for 1 s drains boost_drain.
        run(&mut sim, Input { move_z: 1.0, boost: true, ..idle }, TICK_HZ as usize);
        let after_boost = sim.mech.fuel;
        assert!((t.fuel_max - after_boost - t.boost_drain).abs() < 0.01, "fuel {after_boost}");

        // No regen during the delay, then regen at fuel_regen.
        let delay_ticks = (t.fuel_regen_delay / DT) as usize;
        run(&mut sim, idle, delay_ticks - 1);
        assert_eq!(sim.mech.fuel, after_boost, "regenerated during the delay");
        run(&mut sim, idle, 2);
        assert!(sim.mech.fuel > after_boost, "no regen after the delay");
        let before = sim.mech.fuel;
        run(&mut sim, idle, 12);
        let regen = sim.mech.fuel - before;
        assert!((regen - t.fuel_regen * 12.0 * DT).abs() < 0.01, "regen {regen}");

        // Dodge costs fuel and starts the cooldown; a second press during cooldown does nothing.
        run(&mut sim, idle, 200); // refill
        let dodge = Input { dodge: 1, ..idle };
        sim.step(&dodge);
        assert_eq!(sim.mech.fuel, t.fuel_max - t.dodge_fuel_cost);
        assert_eq!(sim.mech.dodge_cooldown, t.dodge_cooldown);
        sim.step(&dodge);
        assert_eq!(sim.mech.fuel, t.fuel_max - t.dodge_fuel_cost, "dodged during cooldown");

        // Once the cooldown runs out, dodge works again (one tick of float slack).
        let cooldown_ticks = (t.dodge_cooldown / DT).round() as usize;
        run(&mut sim, idle, cooldown_ticks);
        assert!(sim.mech.dodge_cooldown < DT);
        let before = sim.mech.fuel;
        sim.step(&dodge);
        assert_eq!(sim.mech.fuel, before - t.dodge_fuel_cost);
    }

    fn class_sim(class: MechClass) -> (Sim, Tuning) {
        let t = Tuning::default().for_class(class);
        let mut sim = Sim::with_map(t.clone(), map::Map::index("blockout").unwrap());
        sim.class = class;
        sim.reset();
        // A long clear run down the middle of the arena.
        sim.mech.pos = Vector::new(0.0, 0.1, 45.0);
        (sim, t)
    }

    fn speed(sim: &Sim) -> f32 {
        sim.mech.vel.x.hypot(sim.mech.vel.z)
    }

    #[test]
    fn vent_dumps_heat_once_per_cooldown() {
        let (mut sim, t) = class_sim(MechClass::B);
        let fire = Input { fire: true, ..Input::default() };
        let vent = Input { ability: true, ..Input::default() };
        run(&mut sim, fire, 120);
        assert!(sim.mech.overheated);
        sim.step(&vent);
        assert_eq!(sim.mech.heat, 0.0);
        assert!(!sim.mech.overheated);
        assert_eq!(sim.mech.ability_cooldown, t.ability_cooldown);
        run(&mut sim, fire, 30);
        let heat = sim.mech.heat;
        sim.step(&vent);
        assert!(sim.mech.heat > 0.0 && sim.mech.heat <= heat, "vented again during the cooldown");
    }

    #[test]
    fn secondary_shares_heat() {
        let (mut sim, t) = class_sim(MechClass::B);
        let alt = Input { alt_fire: true, ..Input::default() };
        sim.step(&alt);
        assert!(sim.mech.launched);
        assert_eq!(sim.mech.heat, t.alt_heat);
        assert_eq!(sim.projectiles.len(), 1);
        sim.step(&alt);
        assert!(!sim.mech.launched, "fired again during the cooldown");

        // Firing for the length of the cooldown overheats with the secondary ready again.
        run(&mut sim, Input { fire: true, ..Input::default() }, (t.alt_cooldown * TICK_HZ) as usize);
        assert!(sim.mech.overheated && sim.mech.alt_wait <= 0.0, "test needs a ready secondary while overheated");
        sim.step(&Input { fire: true, alt_fire: true, ..Input::default() });
        assert!(!sim.mech.launched && !sim.mech.shot, "fired while overheated");
    }

    #[test]
    fn no_burst_before_arming() {
        let (mut sim, _) = class_sim(MechClass::B);
        let alt = Input { alt_fire: true, ..Input::default() };
        // Fire, let go, and press again two ticks in: too early, so the rocket flies on.
        sim.step(&alt);
        sim.step(&Input::default());
        sim.step(&alt);
        assert!(sim.mech.alt_pressed);
        assert_eq!((sim.projectiles.len(), sim.blasts.len()), (1, 0), "burst before arming");
        // Pressed again once armed, it bursts.
        sim.step(&Input::default());
        run(&mut sim, Input::default(), (projectile::ARM * TICK_HZ) as usize);
        sim.step(&alt);
        assert_eq!((sim.projectiles.len(), sim.blasts.len()), (0, 1));
    }

    #[test]
    fn held_secondary_doesnt_burst() {
        let (mut sim, _) = class_sim(MechClass::B);
        let alt = Input { alt_fire: true, ..Input::default() };
        // Held from the launch on, well past arming.
        run(&mut sim, alt, 30);
        assert_eq!((sim.projectiles.len(), sim.blasts.len()), (1, 0), "a held trigger burst the rocket");
        sim.step(&Input::default());
        sim.step(&alt);
        assert_eq!((sim.projectiles.len(), sim.blasts.len()), (0, 1));
    }

    #[test]
    fn mortar_bursts_mid_air() {
        let (mut sim, t) = class_sim(MechClass::C);
        let aim = Input { pitch: 0.2, ..Input::default() };
        sim.step(&Input { alt_fire: true, ..aim });
        run(&mut sim, aim, 10);
        // Where this tick's flight takes it.
        let mut next = sim.projectiles[0];
        assert!(projectile::fly(sim.arena(), &t, &mut next, |_, _| None).is_none());
        sim.step(&Input { alt_fire: true, ..aim });
        assert!(sim.projectiles.is_empty());
        assert_eq!(sim.blasts, [(t.alt_radius, next.pos)]);
        assert!(next.pos.y > 3.0, "burst at {} isn't mid-air", next.pos);
    }

    #[test]
    fn boost_needs_forward() {
        let (mut sim, t) = class_sim(MechClass::B);
        run(&mut sim, Input { move_x: 1.0, boost: true, ..Input::default() }, 30);
        assert!(!sim.mech.boosting, "boosted with only a strafe");
        assert_eq!(sim.mech.fuel, t.fuel_max, "a strafe with boost held burned fuel");
        run(&mut sim, Input { move_z: 1.0, boost: true, ..Input::default() }, 45);
        assert!(sim.mech.boosting);
        assert!((speed(&sim) - t.boost_speed).abs() < 0.05, "speed {}", speed(&sim));
    }

    #[test]
    fn dash_distance() {
        // A dash from standing with no keys held after it: about three widths, stopped in 0.6 s.
        for class in MechClass::ALL {
            let (mut sim, t) = class_sim(class);
            run(&mut sim, Input::default(), 10);
            let start = sim.mech.pos;
            sim.step(&Input { dodge: 1, ..Input::default() });
            run(&mut sim, Input::default(), (0.6 * TICK_HZ) as usize);
            let moved = sim.mech.pos.x - start.x;
            let widths = moved / (2.0 * t.mech_radius);
            assert!(speed(&sim) < 0.05, "{class:?} still sliding at {} m/s", speed(&sim));
            // The slim Wisp covers a few more of its own widths.
            assert!((2.0..=5.5).contains(&widths), "{class:?} dashed {moved} m, {widths} widths");
            if class == MechClass::B {
                assert!((7.0..=9.5).contains(&moved), "Lancer dashed {moved} m");
            }
        }
    }

    #[test]
    fn slipstream_boosts_free_and_faster() {
        let (mut sim, t) = class_sim(MechClass::A);
        sim.step(&Input { ability: true, ..Input::default() });
        let boost = Input { move_z: 1.0, boost: true, ..Input::default() };
        run(&mut sim, boost, 30);
        assert_eq!(sim.mech.fuel, t.fuel_max, "slipstream burned fuel");
        assert!((speed(&sim) - t.boost_speed * t.slipstream_boost_mult).abs() < 0.05, "speed {}", speed(&sim));
        // Wait out the 4 s back at the start, then boost again.
        sim.mech.pos = Vector::new(0.0, 0.1, 45.0);
        run(&mut sim, Input::default(), 100);
        run(&mut sim, boost, 30);
        assert!(sim.mech.fuel < t.fuel_max, "boost stayed free after slipstream");
        assert!((speed(&sim) - t.boost_speed).abs() < 0.05, "speed {}", speed(&sim));
    }

    #[test]
    fn brace_slows_and_grounds_boost() {
        let (mut sim, t) = class_sim(MechClass::C);
        sim.step(&Input { ability: true, ..Input::default() });
        let boost = Input { move_z: 1.0, boost: true, ..Input::default() };
        run(&mut sim, boost, 60);
        assert!(!sim.mech.boosting, "boosted while braced");
        assert!((speed(&sim) - t.walk_speed * t.brace_speed_mult).abs() < 0.05, "speed {}", speed(&sim));
        run(&mut sim, boost, 120); // past the 5 s
        assert!(sim.mech.boosting);
        assert!((speed(&sim) - t.boost_speed).abs() < 0.05, "speed {}", speed(&sim));
    }

    #[test]
    fn repair_heals_after_windup_and_restarts_at_once() {
        let (mut sim, t) = class_sim(MechClass::B);
        let repair = Input { repair: true, ..Input::default() };
        run(&mut sim, Input::default(), 30); // land
        sim.mech.health = 40.0;

        let windup = (t.repair_windup * TICK_HZ).round() as usize;
        run(&mut sim, repair, windup - 1);
        assert_eq!(sim.mech.health, 40.0, "healed during the wind-up");
        assert!(sim.mech.repair_time > 0.0, "repair never started");
        run(&mut sim, repair, 31);
        let want = 40.0 + t.repair_rate * ((windup + 30) as f32 * DT - t.repair_windup);
        assert!((sim.mech.health - want).abs() < 0.01, "health {} after a second of healing, want {want}", sim.mech.health);

        // Held on, it fills up and ends by itself.
        let to_full = ((t.health_max - sim.mech.health) / t.repair_rate * TICK_HZ).round() as usize;
        run(&mut sim, repair, to_full + 1);
        assert_eq!(sim.mech.health, t.health_max);
        assert_eq!(sim.mech.repair_time, 0.0, "still repairing at full health");

        // No cooldown: hurt again, it starts over on the next tick, wind-up and all.
        sim.mech.health = 50.0;
        sim.step(&repair);
        assert!(sim.mech.repair_time > 0.0, "no fresh repair");
        assert_eq!(sim.mech.health, 50.0, "healed without a wind-up");
    }

    #[test]
    fn repair_shuts_the_mech_down() {
        let (mut sim, t) = class_sim(MechClass::A);
        run(&mut sim, Input::default(), 30); // land
        sim.mech.health = 10.0;
        let everything = Input { move_x: 1.0, move_z: 1.0, boost: true, hover: true, dodge: 1, fire: true, alt_fire: true, ability: true, ..Input::default() };
        let start = sim.mech.pos;
        for _ in 0..60 {
            sim.step(&Input { repair: true, ..everything });
            let m = &sim.mech;
            assert!(!m.shot && !m.launched && !m.boosting && !m.hovering, "acted while shut down: {m:?}");
        }
        let m = sim.mech;
        assert!(m.pos.distance(start) < 1e-3, "moved {} m while shut down", m.pos.distance(start));
        assert_eq!((m.fuel, m.heat, m.dodge_cooldown, m.ability_cooldown), (t.fuel_max, 0.0, 0.0, 0.0));
        assert!(m.health > 10.0, "never healed");

        // Let go, it stays shut down and crouched while it stands back up, then all comes back.
        let standup = (t.repair_standup * TICK_HZ).round() as usize;
        for i in 1..=standup {
            sim.step(&everything);
            let m = &sim.mech;
            assert!(!m.shot && !m.launched && !m.boosting && m.pos.distance(start) < 1e-3, "acted while standing up: {m:?}");
            // Crouched until it's up, at the end of the last tick.
            assert!(i == standup || hit_shape(&t, m).1.y < m.pos.y + 0.5 * t.mech_height, "uncrouched {i} ticks into standing up");
        }
        sim.step(&everything);
        let m = sim.mech;
        assert!(m.shot && m.launched && m.boosting && m.dodge_cooldown > 0.0 && m.ability_time > 0.0, "still shut down: {m:?}");
        assert_eq!((m.repair_time, m.stand_up), (0.0, 0.0));
        assert_eq!(hit_shape(&t, &m).1.y, m.pos.y + 0.5 * t.mech_height);
    }
}
