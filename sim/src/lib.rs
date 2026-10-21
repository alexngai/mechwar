//! Shared mech sim: pure Rust so a native server can link it later.
//! The `wasm` feature adds the browser bindings in `wasm.rs`.

use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};

pub mod bot;
pub mod client;
pub mod game;
pub mod net;
#[cfg(feature = "wasm")]
mod wasm;

pub use rapier3d::prelude::Vector;

pub const TICK_HZ: f32 = 30.0;
pub const DT: f32 = 1.0 / TICK_HZ;

/// Every sim constant. Values live in `tuning.json` at the repo root, which also records
/// each value's source and slider range. Client-only keys (camera) are ignored here.
/// `tuning.json` is the B class; `classes.json` overrides values per class.
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

    pub mech_radius: f32,
    pub mech_height: f32,
    pub eye_height: f32,
    pub pitch_limit_deg: f32,

    pub health_max: f32,
    pub shot_damage: f32,
    pub respawn_delay: f32,

    pub ability_cooldown: f32,
    pub ability_duration: f32,
    pub slipstream_boost_mult: f32,
    pub brace_damage_mult: f32,
    pub brace_speed_mult: f32,

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
    /// This tuning with a class's `classes.json` overrides applied.
    pub fn for_class(&self, class: MechClass) -> Tuning {
        let classes: serde_json::Value = serde_json::from_str(include_str!("../../classes.json")).expect("classes.json is valid JSON");
        let mut merged = serde_json::to_value(self).expect("tuning serializes");
        if let Some(overrides) = classes[class.key()]["overrides"].as_object() {
            for (name, value) in overrides {
                assert!(merged.get(name).is_some(), "classes.json overrides unknown tuning field `{name}`");
                merged[name] = value.clone();
            }
        }
        serde_json::from_value(merged).expect("class overrides are numbers")
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

    fn key(self) -> &'static str {
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
    /// Class ability; like `dodge`, only on the tick the key went down.
    pub ability: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Mech {
    /// Picks the ability `step_mech` applies.
    pub class: MechClass,
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
    /// Where the aim ray from the eye lands (for the crosshair).
    pub aim_point: Vector,
    /// Set on ticks a shot fired.
    pub shot: bool,
}

/// Blockout box: center, half extents, tilt about X in degrees (positive raises the -Z end).
pub struct Block {
    pub center: [f32; 3],
    pub half: [f32; 3],
    pub tilt_x_deg: f32,
}

const fn block(center: [f32; 3], half: [f32; 3]) -> Block {
    Block { center, half, tilt_x_deg: 0.0 }
}

/// Original blockout arena, 100 x 100 m.
pub const ARENA: &[Block] = &[
    block([0.0, -0.5, 0.0], [50.0, 0.5, 50.0]), // floor, top at y=0
    block([50.5, 4.0, 0.0], [0.5, 4.0, 51.0]),  // perimeter walls
    block([-50.5, 4.0, 0.0], [0.5, 4.0, 51.0]),
    block([0.0, 4.0, 50.5], [51.0, 4.0, 0.5]),
    block([0.0, 4.0, -50.5], [51.0, 4.0, 0.5]),
    block([20.0, 2.5, -20.0], [10.0, 2.5, 8.0]), // raised platform, top at y=5
    // Ramp: top surface runs from (z=0, y=0) up to the platform edge (z=-12, y=5); 22.62 deg.
    Block { center: [20.0, 2.269, -6.096], half: [6.0, 0.25, 6.5], tilt_x_deg: 22.62 },
    block([-15.0, 2.0, 10.0], [4.0, 2.0, 1.5]), // cover
    block([-25.0, 2.0, -15.0], [1.5, 2.0, 5.0]),
    block([10.0, 1.5, 22.0], [3.0, 1.5, 3.0]),
    block([-5.0, 3.0, -30.0], [2.0, 3.0, 2.0]),
    block([30.0, 2.0, 20.0], [5.0, 2.0, 1.5]),
];

const SPAWN: Vector = Vector::new(0.0, 0.1, 25.0);

/// Static arena colliders for scene queries. Shared by the offline sim, the server and the client.
pub struct Arena {
    world: PhysicsWorld,
}

impl Default for Arena {
    fn default() -> Self {
        let mut world = PhysicsWorld::default();
        for b in ARENA {
            let [hx, hy, hz] = b.half;
            let collider = ColliderBuilder::cuboid(hx, hy, hz)
                .translation(Vector::from_array(b.center))
                .rotation(Vector::new(b.tilt_x_deg.to_radians(), 0.0, 0.0));
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
}

/// A fresh mech standing at `pos` with full fuel and health.
pub fn spawn_mech(t: &Tuning, pos: Vector) -> Mech {
    Mech { pos, fuel: t.fuel_max, health: t.health_max, ..Mech::default() }
}

/// Collision and hit shape, centered `mech_height / 2` above the feet.
pub fn mech_capsule(t: &Tuning) -> Capsule {
    let radius = t.mech_radius.min(t.mech_height * 0.5);
    Capsule::new_y(t.mech_height * 0.5 - radius, radius)
}

/// Eye position and look direction.
pub fn aim_ray(t: &Tuning, m: &Mech) -> Ray {
    let dir = Rotation::from_rotation_y(m.yaw) * Rotation::from_rotation_x(m.pitch) * Vector::NEG_Z;
    Ray::new(m.pos + Vector::Y * t.eye_height, dir)
}

/// Single-player wrapper used by the offline sandbox.
pub struct Sim {
    pub tuning: Tuning,
    pub class: MechClass,
    pub mech: Mech,
    arena: Arena,
}

impl Sim {
    pub fn new(tuning: Tuning) -> Self {
        let mut sim = Self { tuning, class: MechClass::B, mech: Mech::default(), arena: Arena::default() };
        sim.reset();
        sim
    }

    pub fn reset(&mut self) {
        self.mech = Mech { class: self.class, ..spawn_mech(&self.tuning, SPAWN) };
    }

    pub fn step(&mut self, input: &Input) {
        step_mech(&self.arena, &self.tuning, &mut self.mech, input);
    }
}

/// One fixed tick of one mech. The client predicts with this and the server replays the same inputs
/// through it, so both must see identical inputs, tuning and arena.
pub fn step_mech(arena: &Arena, t: &Tuning, m: &mut Mech, input: &Input) {
    m.shot = false;
    if m.health <= 0.0 {
        return;
    }

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

    // Fuel spenders: boost, dodge, hover.
    let mut used_fuel = false;
    // Starting needs boost_min_fuel so an empty tank doesn't flicker boost on each regen tick.
    let fuel_ok = slipstream || (m.fuel > 0.0 && (m.boosting || m.fuel >= t.boost_min_fuel));
    m.boosting = !brace && input.boost && has_move && fuel_ok;
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

    // Heat. ponytail: one shot per tick max, so fire_rate above TICK_HZ caps at 30/s.
    m.fire_wait -= DT;
    m.shot = input.fire && !m.overheated && m.fire_wait <= 0.0;
    if m.shot {
        m.fire_wait += 1.0 / t.fire_rate;
        m.heat += t.heat_per_shot;
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
        let mut sim = Sim::new(t.clone());
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
        let mut sim = Sim::new(t.clone());
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
    fn slipstream_boosts_free_and_faster() {
        let (mut sim, t) = class_sim(MechClass::A);
        sim.step(&Input { ability: true, ..Input::default() });
        let boost = Input { move_z: 1.0, boost: true, ..Input::default() };
        run(&mut sim, boost, 60);
        assert_eq!(sim.mech.fuel, t.fuel_max, "slipstream burned fuel");
        assert!((speed(&sim) - t.boost_speed * t.slipstream_boost_mult).abs() < 0.05, "speed {}", speed(&sim));
        run(&mut sim, boost, 74); // past the 4 s
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

}
