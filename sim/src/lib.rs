//! Shared mech sim: pure Rust so a native server can link it later.
//! The `wasm` feature adds the browser bindings in `wasm.rs`.

use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};

pub mod ability;
pub mod arsenal;
pub mod bot;
pub mod client;
pub mod collide;
pub mod deploy;
pub mod game;
pub mod item;
pub mod map;
pub mod melee;
pub mod net;
pub mod objective;
pub mod progress;
pub mod projectile;
pub mod siege;
pub mod weapon;
#[cfg(feature = "wasm")]
mod wasm;

pub use ability::Ability;
pub use arsenal::{Arsenal, Loadout, Slot};
pub use map::{Map, Pad};
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
    /// Heat sheds `heat_decay` a second when full, rising to `heat_decay_cool` times that as it
    /// empties, from `heat_decay_delay` s after the last shot.
    pub heat_decay: f32,
    pub heat_decay_delay: f32,
    pub heat_decay_cool: f32,
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
    /// A bouncing projectile primary glances off the arena at `shot_bounce` of its speed and
    /// bursts at `shot_fuse` s (0: on reaching `weapon_range`), or on a mech.
    pub shot_bounce: f32,
    pub shot_fuse: f32,
    /// A seeking projectile primary (`shot_turn` > 0, degrees a second) turns toward whichever
    /// enemy is nearest its owner's aim within `shot_seek_cone` degrees, as of each tick
    /// (`projectile::seek`); with none there, it flies straight.
    pub shot_turn: f32,
    pub shot_seek_cone: f32,
    /// Spin-up primaries fire at `spin_start` of `fire_rate` from rest, reaching all of it after
    /// `spin_up` s of trigger (0: no spin-up), and spin down over `spin_down` s. They hold fire
    /// until spun for `spin_delay` s.
    pub spin_up: f32,
    pub spin_down: f32,
    pub spin_start: f32,
    pub spin_delay: f32,
    /// Burst primaries fire `burst` shots `burst_gap` s apart per pull, `fire_rate` bursts a second.
    pub burst: f32,
    pub burst_gap: f32,
    /// Charge primaries build charge over `charge_time` s while held (0: none) and fire on
    /// release, hitting (and heating) `charge_damage` times as hard at full charge; a projectile
    /// also flies `charge_speed` times as fast and bursts `charge_radius` times as wide.
    pub charge_time: f32,
    pub charge_damage: f32,
    pub charge_speed: f32,
    pub charge_radius: f32,

    pub mech_radius: f32,
    pub mech_height: f32,
    pub eye_height: f32,
    pub pitch_limit_deg: f32,
    /// Shares out pushes when mechs collide: heavier mechs shove lighter ones.
    pub mech_mass: f32,

    pub health_max: f32,
    pub shot_damage: f32,
    pub respawn_delay: f32,
    /// Seconds a launch is shielded at most (`Mech::shield`).
    pub spawn_shield: f32,

    /// Abilities (`ability.rs`): each one's cooldown and how long it stays on, and what it does.
    pub slipstream_cooldown: f32,
    pub slipstream_duration: f32,
    pub slipstream_boost_mult: f32,
    pub vent_cooldown: f32,
    pub brace_cooldown: f32,
    pub brace_duration: f32,
    pub brace_damage_mult: f32,
    pub brace_speed_mult: f32,
    pub cloak_cooldown: f32,
    pub cloak_duration: f32,
    pub power_cooldown: f32,
    pub power_duration: f32,
    pub power_damage_mult: f32,
    pub barrage_cooldown: f32,
    pub barrage_duration: f32,
    pub barrage_damage_mult: f32,
    pub artillery_cooldown: f32,
    pub artillery_duration: f32,
    pub artillery_damage_mult: f32,
    pub artillery_radius_mult: f32,

    /// Secondary weapon: a volley of `alt_count` projectiles; see `projectile.rs`.
    pub alt_cooldown: f32,
    pub alt_heat: f32,
    pub alt_count: f32,
    pub alt_spread_deg: f32,
    pub alt_cone: f32,
    pub alt_speed: f32,
    /// Each shell's speed varies by up to this share either way, seeded per shell.
    pub alt_speed_jitter: f32,
    pub alt_loft_deg: f32,
    pub alt_gravity: f32,
    pub alt_bounce: f32,
    pub alt_fuse: f32,
    pub alt_damage: f32,
    pub alt_radius: f32,
    /// A heat-fed launcher spends this share of the mech's heat on each shell (and fires even
    /// overheated); how hot the mech ran, as a share of `heat_max`, is the shell's charge, which
    /// scales its damage and radius up to `alt_charge_damage` and `alt_charge_radius` times.
    pub alt_heat_fed: f32,
    pub alt_charge_damage: f32,
    pub alt_charge_radius: f32,
    /// Mines: shells that stick where they land (`alt_stick` 1), burst when an enemy comes within
    /// `alt_trigger`, and at most `alt_max` of a mech's live at once (the oldest burst first).
    pub alt_stick: f32,
    pub alt_trigger: f32,
    pub alt_max: f32,
    /// `alt_release` 1: the secondary fires when its trigger is let go, not pressed.
    pub alt_release: f32,
    /// `alt_pierce` 1: shells fly through domes and barriers, wearing each they cross by their
    /// damage, rather than stopping on them.
    pub alt_pierce: f32,
    /// A lock-on launcher (`alt_lock_time` > 0): pressing `aux` picks the enemy nearest its aim
    /// within `alt_lock_cone` degrees, which locks once kept there that long; the lock then holds
    /// `alt_lock_hold` seconds wherever the mech looks, and its shells home on it, turning up to
    /// `alt_turn` degrees a second (`projectile::track`).
    pub alt_lock_time: f32,
    pub alt_lock_cone: f32,
    pub alt_lock_hold: f32,
    pub alt_turn: f32,
    /// Homing shells fly straight this many seconds before they start to turn, so a volley fans
    /// out before it closes in.
    pub alt_home_delay: f32,
    /// A splitting shell bursting in the air (its fuse, or a press) scatters `alt_split` bomblets
    /// in a ring at `alt_split_speed`, each bursting on contact for `alt_split_damage` over
    /// `alt_split_radius`.
    pub alt_split: f32,
    pub alt_split_damage: f32,
    pub alt_split_radius: f32,
    pub alt_split_speed: f32,
    /// A beam secondary (`alt_beam` > 0, its reach in m) launches nothing: held, it runs from the
    /// eye along the aim to the first mech or wall (or bends to a mech off the aim, holding on
    /// one it's on: `weapon::beam`), mending a teammate `alt_beam_heal` hp/s or burning an enemy `alt_damage`
    /// hp/s, for `alt_heat` heat/s.
    pub alt_beam: f32,
    pub alt_beam_heal: f32,
    /// A melee secondary (`alt_melee` > 0, its reach in m) launches nothing: held, it winds up
    /// over `alt_charge_time`; let go, it lunges at an enemy within `alt_lunge` ahead (at up to
    /// `alt_lunge_speed`), and strikes, throwing what it hits with `alt_impulse` over its mass;
    /// see `melee.rs`. Charge scales the blow by `alt_charge_damage`, as it does a heat-fed shell.
    pub alt_melee: f32,
    pub alt_charge_time: f32,
    pub alt_lunge: f32,
    pub alt_lunge_speed: f32,
    pub alt_impulse: f32,

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
    /// Offensive: a remote mine, thrown like the grenade; it sticks, and bursts when set off (or
    /// after `limpet_fuse`).
    pub limpet_charges: f32,
    pub limpet_recharge: f32,
    pub limpet_fuse: f32,
    pub limpet_damage: f32,
    pub limpet_radius: f32,
    /// Offensive: smoke, thrown like the grenade; it bursts into a cloud of `smoke_radius` for
    /// `smoke_seconds`.
    pub smoke_charges: f32,
    pub smoke_recharge: f32,
    pub smoke_fuse: f32,
    pub smoke_radius: f32,
    pub smoke_seconds: f32,
    /// Support: a repair orb dropped at the feet, healing the mech's side (see game.rs `ORB_*`).
    pub orb_charges: f32,
    pub orb_recharge: f32,
    /// Support: a half-sphere shield at the feet that the other side's shots stop at
    /// (`deploy.rs`), for `dome_seconds` or until they've worn off its `dome_hull`.
    pub dome_charges: f32,
    pub dome_recharge: f32,
    pub dome_radius: f32,
    pub dome_seconds: f32,
    pub dome_hull: f32,
    /// Support: a wall `barrier_distance` ahead across the aim, for `barrier_seconds` or until
    /// the other side's shots have worn off its `barrier_hull`.
    pub barrier_charges: f32,
    pub barrier_recharge: f32,
    pub barrier_width: f32,
    pub barrier_height: f32,
    pub barrier_thickness: f32,
    pub barrier_distance: f32,
    pub barrier_seconds: f32,
    pub barrier_hull: f32,
    /// Offensive: turrets, set down `turret_distance` ahead, lasting `turret_seconds` unless
    /// their hull's shot off. Each trains on the nearest enemy it sees in range at
    /// `turret_turn_deg` a second and, after `turret_warmup`, fires: the MG bursts of
    /// `mg_turret_burst` hitscan rounds, the other a rocket (the Rocket's, dealing
    /// `rocket_turret_damage`) every `rocket_turret_cooldown`.
    pub turret_distance: f32,
    pub turret_height: f32,
    pub turret_radius: f32,
    pub turret_hull: f32,
    pub turret_seconds: f32,
    pub turret_turn_deg: f32,
    pub turret_warmup: f32,
    pub mg_turret_charges: f32,
    pub mg_turret_recharge: f32,
    pub mg_turret_range: f32,
    pub mg_turret_damage: f32,
    pub mg_turret_rate: f32,
    pub mg_turret_burst: f32,
    pub mg_turret_pause: f32,
    pub mg_turret_spread_deg: f32,
    pub rocket_turret_charges: f32,
    pub rocket_turret_recharge: f32,
    pub rocket_turret_range: f32,
    pub rocket_turret_damage: f32,
    pub rocket_turret_cooldown: f32,

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
    /// The ability (`ability.rs`); like `dodge`, only on the tick the key went down.
    pub ability: bool,
    /// Held to repair; see `step_mech`.
    pub repair: bool,
    /// Items, also only on the tick the key went down: G uses the offensive item (named for the
    /// Tumbler grenade, the one every mech starts with), T the support item (the Brownout EMP).
    pub grenade: bool,
    pub emp: bool,
    /// The secondary's second control (middle mouse), held: a lock-on launcher locks with it.
    pub aux: bool,
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
    pub class: MechClass,
    /// The weapons, items and ability carried; with `class`, picks this mech's tuning
    /// (`Arsenal::of`).
    pub loadout: Loadout,
    /// Dead at 0 or below: `step_mech` leaves a dead mech alone.
    pub health: f32,
    /// Seconds the ability stays on, and until it can be used again.
    pub ability_time: f32,
    pub ability_cooldown: f32,
    /// Set on ticks what the mech fires or throws is boosted by its ability (`ability::fired`).
    pub boosted: bool,
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
    /// The primary's mechanics: spin 0-1 (spin-up weapons), shots left in a burst, charge 0-1
    /// (charge weapons), and the charge the last shot fired with.
    pub spin: f32,
    pub burst_left: u8,
    pub charge: f32,
    pub shot_charge: f32,
    /// The charge the last secondary launched with (heat-fed launchers), or a melee secondary's
    /// wind-up so far.
    pub alt_charge: f32,
    /// Seconds left that a melee strike just let go can land (`melee::STRIKE`): the server's
    /// to resolve and end. It lands as wound, and boosted by the ability, when it was let go.
    pub strike: f32,
    pub strike_charge: f32,
    pub strike_boosted: bool,
    /// How hard (m/s) the mech hit a wall this tick riding a pad's arc, as a thrown mech does.
    pub slam: f32,
    /// Lock-on: the enemy being locked (its id + 1; 0 for none), and for how long.
    pub lock: u8,
    pub lock_time: f32,
    /// A seeking primary's mark (`projectile::seek`): the enemy nearest the aim (its id + 1; 0
    /// for none), which its shots in flight turn toward.
    pub seek: u8,
    /// Where the aim ray from the eye lands (for the crosshair).
    pub aim_point: Vector,
    /// Set on ticks a shot fired.
    pub shot: bool,
    /// Set on ticks the secondary launched a volley.
    pub launched: bool,
    /// The secondary trigger as of the last tick, and set on ticks it went down: a press bursts
    /// the mech's armed shells in flight (`projectile::detonate`). A mine layer's is `aux`'s.
    pub alt_held: bool,
    pub alt_pressed: bool,
    /// The same for the secondary's second control (`Input::aux`).
    pub aux_held: bool,
    pub aux_pressed: bool,
    /// Seconds into the current repair; 0 when not repairing.
    pub repair_time: f32,
    /// Seconds left standing back up after a repair: still shut down, and still crouched.
    pub stand_up: f32,
    /// Item charges left, and seconds until the next one comes back (0 when full): the offensive
    /// item's (named for the Tumbler grenade, which every mech starts with) and the support
    /// item's (the Brownout EMP).
    pub grenades: u8,
    pub grenade_wait: f32,
    pub emps: u8,
    pub emp_wait: f32,
    /// Seconds an enemy EMP keeps boost off.
    pub jammed: f32,
    /// Set on ticks the offensive item was thrown, and the support item used.
    pub threw: bool,
    pub pulsed: bool,
    /// A limpet of ours is down (or flying), so G sets it off; set on the tick it did.
    pub limpet: bool,
    pub sprung: bool,
    /// Holding a beam secondary on, where the beam stopped and on whom (set by whoever knows the
    /// mechs: `weapon::beam`, which holds on that mech while it can).
    pub beaming: bool,
    pub beam_end: Vector,
    pub beam_on: Option<u8>,
    /// Seconds of shield left, fresh from launching (`spawn_shield`): no damage or jam until it
    /// runs out or the pilot does anything but look around, so a mech can't be spawn camped.
    pub shield: f32,
    /// Riding a jump pad's arc: no steering or boost until it lands, or hovers or dodges out.
    pub pad_arc: bool,
}

/// Static arena colliders for scene queries, and the map's jump pads. Shared by the offline sim,
/// the server and the client.
pub struct Arena {
    pub(crate) world: PhysicsWorld,
    pub pads: Vec<Pad>,
    /// Half the map's width and depth: no mech gets past these, however high it flies.
    pub half: [f32; 2],
    /// Barriers standing (`deploy.rs`), and their walls.
    barriers: Vec<(deploy::Deployable, ColliderHandle)>,
}

/// A jump pad fires for feet this close to its center (and within half a meter of its height).
pub const PAD_RADIUS: f32 = 2.5;

/// The launch that carries a mech from `from` up to a pad's apex and down onto its landing.
pub fn pad_velocity(pad: &Pad, from: Vector, gravity: f32) -> Vector {
    let to = Vector::from_array(pad.to);
    let up = (2.0 * gravity * (pad.apex - from.y).max(0.0)).sqrt();
    let time = up / gravity + (2.0 * (pad.apex - to.y).max(0.0) / gravity).sqrt();
    Vector::new(to.x - from.x, 0.0, to.z - from.z) / time.max(DT) + Vector::Y * up
}

impl Arena {
    pub fn new(map: &Map) -> Self {
        let mut world = PhysicsWorld::default();
        for collider in map.colliders() {
            world.insert_collider(collider, None);
        }
        // Builds the broad phase so scene queries see the static colliders. No physics step runs.
        world.detect_collisions(&(), &());
        Self { world, pads: map.pads.clone(), half: map.size.map(|s| s / 2.0), barriers: Vec::new() }
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

/// A fresh mech standing at `pos` with full fuel, health and item charges (for the starting
/// items: `item::fill` refills them for others).
pub fn spawn_mech(t: &Tuning, pos: Vector) -> Mech {
    let mut m = Mech { pos, fuel: t.fuel_max, health: t.health_max, ..Mech::default() };
    item::fill(t, &mut m);
    m
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
    /// Secondary fire and thrown items in flight; offline they only meet the arena.
    pub projectiles: Vec<projectile::Projectile>,
    /// Where projectiles burst since the page last took them: blast radius, where, the shot's charge.
    pub blasts: Vec<(f32, Vector, f32)>,
    /// Smoke hanging about (fading at `seq`s, as ticks).
    pub clouds: Vec<net::Cloud>,
    /// What's been put down (placed and expiring by `seq`, as ticks).
    pub deployables: Vec<deploy::Deployable>,
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
        let mut sim = Self { tuning, class: MechClass::B, loadout: Loadout::of(MechClass::B), mech: Mech::default(), projectiles: Vec::new(), blasts: Vec::new(), clouds: Vec::new(), deployables: Vec::new(), shots: Vec::new(), seq: 0, arena: Arena::new(&map), spawn };
        sim.reset();
        sim
    }

    pub fn reset(&mut self) {
        self.mech = Mech { class: self.class, loadout: self.loadout, ..spawn_mech(&self.tuning, self.spawn) };
        item::fill(&self.tuning, &mut self.mech);
    }

    pub fn step(&mut self, input: &Input) {
        self.seq += 1;
        let t = &self.tuning;
        step_mech(&self.arena, t, &mut self.mech, input);
        melee::lunge(&self.arena, t, &mut self.mech, std::iter::empty());
        if self.mech.alt_pressed {
            projectile::detonate(0, &mut self.projectiles);
        }
        if self.mech.launched && t.alt_melee <= 0.0 {
            projectile::cap(t, 0, &mut self.projectiles);
            self.projectiles.extend(projectile::volley(t, &self.mech, 0, self.seq));
        }
        if self.mech.threw && item::Item::of(self.mech.loadout, true).thrown() {
            self.projectiles.push(projectile::thrown(t, &self.mech, 0, self.seq));
        }
        if self.mech.sprung {
            projectile::set_off(0, &mut self.projectiles);
        }
        // Deployables go down offline too, though turrets find nothing to shoot.
        let offensive = match item::Item::of(self.mech.loadout, true) {
            item::Item::MgTurret => Some(deploy::Kind::MgTurret),
            item::Item::RocketTurret => Some(deploy::Kind::RocketTurret),
            _ => None,
        };
        let support = match item::Item::of(self.mech.loadout, false) {
            item::Item::Dome => Some(deploy::Kind::Dome),
            item::Item::Barrier => Some(deploy::Kind::Barrier),
            _ => None,
        };
        for kind in [offensive.filter(|_| self.mech.threw), support.filter(|_| self.mech.pulsed)].into_iter().flatten() {
            match deploy::place(&self.arena, t, &self.mech, kind, 0, 0, self.seq, std::iter::empty()) {
                Some(d) => deploy::add(&mut self.deployables, d),
                None => self.mech.emps += 1,
            }
        }
        let seq = self.seq;
        self.deployables.retain(|d| seq < d.expires);
        self.arena.set_barriers(t, &self.deployables);
        if self.mech.beaming {
            (self.mech.beam_end, self.mech.beam_on) = weapon::beam(&self.arena, t, &self.mech, []);
        }
        if self.mech.shot && t.shot_speed > 0.0 {
            self.projectiles.extend(weapon::volley(t, &self.mech, 0, self.seq));
        } else if self.mech.shot {
            let arena = &self.arena;
            self.shots.extend(weapon::pellets(t, &self.mech, self.seq).iter().map(|r| r.point_at(arena.cast_ray(r, t.weapon_range).unwrap_or(t.weapon_range))));
        }
        let (arena, blasts, clouds, mut bomblets, seq) = (&self.arena, &mut self.blasts, &mut self.clouds, Vec::new(), self.seq);
        self.projectiles.retain_mut(|p| {
            let radius = projectile::radius(t, p);
            match projectile::fly(arena, &projectile::tuning_for(t, p), p, |_, _| None) {
                Some(at) if projectile::item(p) == Some(item::Item::Smoke) => {
                    clouds.push(net::Cloud { pos: at, radius: t.smoke_radius, fades_at: seq + (t.smoke_seconds * TICK_HZ).round() as u32 });
                    false
                }
                Some(at) => {
                    blasts.push((radius, at, p.charge));
                    bomblets.extend(projectile::split(t, p, at));
                    false
                }
                None => true,
            }
        });
        self.projectiles.extend(bomblets);
        self.clouds.retain(|c| seq < c.fades_at);
        if !self.projectiles.iter().any(|p| projectile::item(p) == Some(item::Item::Limpet)) {
            self.mech.limpet = false;
        }
    }

    pub fn arena(&self) -> &Arena {
        &self.arena
    }

    /// Steps so far.
    pub fn ticks(&self) -> u32 {
        self.seq
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
    m.aux_pressed = false;
    m.threw = false;
    m.pulsed = false;
    m.sprung = false;
    m.beaming = false;
    m.slam = 0.0;
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
    let acted = input.move_x != 0.0 || input.move_z != 0.0 || input.dodge != 0;
    let acted = acted || input.boost || input.hover || input.fire || input.alt_fire || input.ability || input.repair || input.grenade || input.emp;
    m.shield = if acted { 0.0 } else { (m.shield - DT).max(0.0) };

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
    m.strike = (m.strike - DT).max(0.0);

    // The ability: Speed boost frees and speeds up boost, and Bulwark trades it for less damage
    // (applied by the server) and more speed on foot. What it does to firing comes after it.
    ability::step(t, m, input.ability);
    let slipstream = ability::on(m, Ability::Slipstream);
    let brace = ability::on(m, Ability::Brace);
    item::step(t, m, input);

    // Fuel spenders: boost, dodge, hover.
    let mut used_fuel = false;
    // Starting needs boost_min_fuel so an empty tank doesn't flicker boost on each regen tick.
    let fuel_ok = slipstream || (m.fuel > 0.0 && (m.boosting || m.fuel >= t.boost_min_fuel));
    // Thrusters push forward: boost needs a forward input (W, or W with a strafe to curve).
    m.boosting = !brace && !m.pad_arc && m.jammed <= 0.0 && input.boost && input.move_z > 0.1 && fuel_ok;
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
        m.pad_arc = false; // a dodge breaks a pad's arc
    }

    let can_hover = m.fuel > 0.0 && (m.hovering || m.fuel >= t.hover_min_fuel);
    if input.hover && can_hover {
        if !m.hovering {
            m.hover_time = 0.0;
        }
        m.hovering = true;
        m.pad_arc = false; // so does a hover
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
    // On a pad's arc the horizontal speed is left alone, so the mech lands where the pad aims.
    if !m.pad_arc {
        let h = Vector::new(m.vel.x, 0.0, m.vel.z);
        let dv = target - h;
        let h = h + dv.clamp_length_max(accel * DT);
        m.vel.x = h.x;
        m.vel.z = h.z;
    }

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
    let (vel, arcing, mut slam) = (&mut m.vel, m.pad_arc, 0.0f32);
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
            if arcing {
                slam = slam.max(-into);
            }
        }
    });
    m.slam = slam;
    m.pos += moved.translation;
    m.grounded = moved.grounded;
    if m.grounded && m.vel.y < 0.0 {
        m.vel.y = 0.0;
    }
    // The map's edge: the perimeter walls stand on it, and above them it holds anyone hovering,
    // dashing or thrown over.
    let [hx, hz] = arena.half.map(|h| h - radius);
    if m.pos.x.abs() > hx {
        m.pos.x = m.pos.x.clamp(-hx, hx);
        m.vel.x = 0.0;
    }
    if m.pos.z.abs() > hz {
        m.pos.z = m.pos.z.clamp(-hz, hz);
        m.vel.z = 0.0;
    }
    if m.grounded {
        m.pad_arc = false;
        // Standing on a jump pad throws the mech (not one shut down for repairs).
        let on = |p: &&Pad| {
            let (dx, dz) = (m.pos.x - p.at[0], m.pos.z - p.at[2]);
            (m.pos.y - p.at[1]).abs() < 0.5 && dx * dx + dz * dz < PAD_RADIUS * PAD_RADIUS
        };
        if let Some(pad) = arena.pads.iter().find(on).filter(|_| !shutdown) {
            m.vel = pad_velocity(pad, m.pos, t.gravity);
            m.pad_arc = true;
            m.grounded = false;
        }
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
    let ready = !m.overheated && m.fire_wait <= 0.0;
    if m.overheated || shutdown {
        (m.burst_left, m.charge) = (0, 0.0);
    }
    if t.spin_up > 0.0 {
        m.spin = if input.fire && !m.overheated { (m.spin + DT / t.spin_up).min(1.0) } else { (m.spin - DT / t.spin_down.max(DT)).max(0.0) };
    }
    if t.charge_time > 0.0 {
        // Held, the trigger charges a ready shot; let go and it fires.
        if input.fire && ready {
            m.charge = (m.charge + DT / t.charge_time).min(1.0);
        }
        m.shot = !input.fire && m.charge > 0.0 && ready;
    } else {
        // A burst, once started, fires out whether the trigger's held or not; a spin-up gun once
        // its barrels have wound up (the epsilon: spin builds in DT steps).
        let wound = t.spin_up <= 0.0 || m.spin * t.spin_up >= t.spin_delay - 1e-4;
        m.shot = (input.fire || m.burst_left > 0) && ready && wound;
    }
    // A heat-fed launcher fires even overheated: it spends heat rather than making it. So does a
    // melee secondary strike, the last resort of a mech whose guns are locked.
    // Most secondaries fire on the press; a release-fired one (a lock-on launcher) when let go.
    // Shutting down to repair lets go of the trigger, but doesn't swing a melee secondary.
    let pulled = if t.alt_release > 0.5 { !input.alt_fire && m.alt_held } else { input.alt_fire };
    let pulled = pulled && !(shutdown && t.alt_melee > 0.0);
    let beam = t.alt_beam > 0.0;
    let hot_ok = t.alt_heat_fed > 0.0 || t.alt_melee > 0.0 || !m.overheated;
    m.launched = !beam && pulled && hot_ok && m.alt_wait <= 0.0;
    // A winding secondary winds up from a fresh press while it's held and ready; let go, its
    // strike takes the wind-up.
    if t.alt_charge_time > 0.0 {
        if m.launched {
            m.strike_charge = m.alt_charge;
        }
        let wound = if input.alt_fire && m.alt_held { m.alt_charge } else { 0.0 };
        m.alt_charge = if input.alt_fire && m.alt_wait <= 0.0 { (wound + DT / t.alt_charge_time).min(1.0) } else { wound };
    }
    m.beaming = beam && input.alt_fire && !m.overheated;
    if !m.beaming {
        m.beam_on = None;
    }
    // Mines go off by themselves: a press lays more, and the middle button bursts all those down.
    m.alt_pressed = if t.alt_stick > 0.5 { input.aux && !m.aux_held } else { input.alt_fire && !m.alt_held && t.alt_release < 0.5 && !beam };
    m.alt_held = input.alt_fire;
    m.aux_pressed = input.aux && !m.aux_held;
    m.aux_held = input.aux;
    if m.shot {
        (m.shot_charge, m.charge) = (m.charge, 0.0);
        let burst = t.burst.max(1.0);
        m.burst_left = if m.burst_left > 0 { m.burst_left - 1 } else { burst as u8 - 1 };
        let spun = if t.spin_up > 0.0 { t.spin_start + (1.0 - t.spin_start) * m.spin } else { 1.0 };
        let cycle = 1.0 / (t.fire_rate * spun).max(1e-3);
        // Within a burst the next shot follows the gap; the gaps come out of the cycle, so
        // `fire_rate` stays bursts per second.
        m.fire_wait += if m.burst_left > 0 {
            t.burst_gap
        } else if burst > 1.0 {
            (cycle - t.burst_gap * (burst - 1.0)).max(t.burst_gap)
        } else {
            cycle
        };
        m.heat += t.heat_per_shot * weapon::power(t, m.shot_charge);
    }
    if m.launched {
        m.alt_wait = t.alt_cooldown;
        let spent = m.heat * t.alt_heat_fed;
        if t.alt_charge_time <= 0.0 {
            m.alt_charge = if t.alt_heat_fed > 0.0 { m.heat / t.heat_max.max(1.0) } else { 0.0 };
        }
        m.heat += t.alt_heat - spent;
        if t.alt_melee > 0.0 {
            m.strike = melee::STRIKE;
            m.fire_wait = m.fire_wait.max(melee::RECOVERY);
        }
    }
    if m.beaming {
        m.heat += t.alt_heat * DT;
    }
    if (m.shot || m.launched || m.beaming) && m.heat >= t.heat_max {
        m.heat = t.heat_max;
        m.overheated = true;
    }
    // Only firing makes heat, and it sheds a moment after the last shot, trigger held or not (a
    // shot charging too), so a slow gun cools between shots while a fast one, firing inside that
    // moment, doesn't; and faster the cooler it runs, so short bursts pay.
    if m.shot || m.launched || m.beaming {
        m.heat_wait = t.heat_decay_delay;
    } else {
        m.heat_wait = (m.heat_wait - DT).max(0.0);
        if m.heat_wait == 0.0 {
            let cool = 1.0 + (t.heat_decay_cool - 1.0) * (1.0 - m.heat / t.heat_max.max(1.0));
            let decay = if m.overheated { t.overheat_decay } else { t.heat_decay * cool };
            m.heat = (m.heat - decay * DT).max(0.0);
        }
    }
    m.fire_wait = m.fire_wait.max(0.0);
    if m.overheated && m.heat <= t.overheat_release {
        m.overheated = false;
    }
    ability::fired(m);
    if m.launched && t.alt_melee > 0.0 {
        m.strike_boosted = m.boosted;
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
        armed_sim(class, Loadout::of(class))
    }

    /// `class_sim` carrying `loadout`.
    fn armed_sim(class: MechClass, loadout: Loadout) -> (Sim, Tuning) {
        let t = Arsenal::new(&Tuning::default()).get(class, loadout).clone();
        let mut sim = Sim::with_map(t.clone(), map::Map::index("blockout").unwrap());
        (sim.class, sim.loadout) = (class, loadout);
        sim.reset();
        // A long clear run down the middle of the arena.
        sim.mech.pos = Vector::new(0.0, 0.1, 45.0);
        (sim, t)
    }

    fn speed(sim: &Sim) -> f32 {
        sim.mech.vel.x.hypot(sim.mech.vel.z)
    }

    #[test]
    fn spin_up_ramps_the_fire_rate() {
        let mut sim = weapon_sim(|t| (t.fire_rate, t.spin_up, t.spin_start, t.heat_per_shot) = (20.0, 1.0, 0.1, 0.0));
        let fired = shots(&mut sim, Input { fire: true, ..Input::default() }, 60);
        let (early, late) = (fired.iter().filter(|&&i| i < 15).count(), fired.iter().filter(|&&i| i >= 45).count());
        assert!(late > 2 * early, "early {early}, late {late}");
        run(&mut sim, Input::default(), 30);
        assert_eq!(sim.mech.spin, 0.0, "never spun down");
    }

    #[test]
    fn spin_delay_holds_fire_until_wound_up() {
        let mut sim = weapon_sim(|t| (t.fire_rate, t.spin_up, t.spin_start, t.spin_delay, t.heat_per_shot) = (20.0, 1.2, 0.2, 0.2, 0.0));
        let fire = Input { fire: true, ..Input::default() };
        // 0.2 s is six ticks: the sixth fires.
        assert_eq!(shots(&mut sim, fire, 6).first(), Some(&5));
        // Let go briefly once spun up: still spinning, it fires again at once.
        run(&mut sim, fire, 45);
        run(&mut sim, Input::default(), 3);
        assert_eq!(shots(&mut sim, fire, 1), [0]);
    }

    #[test]
    fn a_tap_fires_a_whole_burst() {
        let mut sim = weapon_sim(|t| (t.fire_rate, t.burst, t.burst_gap, t.heat_per_shot) = (2.0, 3.0, 0.07, 0.0));
        let mut fired = shots(&mut sim, Input { fire: true, ..Input::default() }, 1);
        fired.extend(shots(&mut sim, Input::default(), 30).iter().map(|i| i + 1));
        assert_eq!(fired, [0, 2, 4]);
    }

    #[test]
    fn charge_fires_on_release_harder_the_longer_its_held() {
        let mut sim = weapon_sim(|t| (t.fire_rate, t.charge_time, t.charge_damage, t.heat_per_shot) = (2.0, 1.0, 3.0, 0.0));
        let fire = Input { fire: true, ..Input::default() };
        assert!(shots(&mut sim, fire, 45).is_empty(), "fired while held");
        sim.step(&Input::default());
        assert!(sim.mech.shot && sim.mech.shot_charge == 1.0, "full charge: {}", sim.mech.shot_charge);
        run(&mut sim, Input::default(), 30);
        sim.step(&fire);
        sim.step(&Input::default());
        assert!(sim.mech.shot && sim.mech.shot_charge < 0.05, "a tap: {}", sim.mech.shot_charge);
    }

    #[test]
    fn charged_shells_fly_faster_and_hit_harder_and_wider() {
        let mut sim = weapon_sim(|t| {
            (t.charge_time, t.charge_damage, t.charge_speed, t.charge_radius, t.heat_per_shot) = (1.0, 1.5, 2.5, 3.5, 0.0);
            (t.shot_speed, t.shot_gravity, t.shot_radius) = (60.0, 0.0, 1.0);
        });
        run(&mut sim, Input { fire: true, ..Input::default() }, 45);
        sim.step(&Input::default());
        let p = *sim.projectiles.iter().find(|p| p.primary).expect("fired a shell");
        let charged = projectile::tuning_for(&sim.tuning, &p);
        assert!((p.vel.length() - 150.0).abs() < 0.5, "{} m/s", p.vel.length());
        assert!((charged.shot_damage - 1.5 * sim.tuning.shot_damage).abs() < 1e-3 && (projectile::radius(&sim.tuning, &p) - 3.5).abs() < 1e-4);
    }

    /// A Medium sim with its tuning changed by `set`.
    fn weapon_sim(set: impl Fn(&mut Tuning)) -> Sim {
        let (mut sim, _) = class_sim(MechClass::B);
        set(&mut sim.tuning);
        sim
    }

    /// The ticks, of the next `ticks`, that `input` fires the primary on.
    fn shots(sim: &mut Sim, input: Input, ticks: usize) -> Vec<usize> {
        (0..ticks).filter(|_| (sim.step(&input), sim.mech.shot).1).collect()
    }

    #[test]
    fn pile_drivers_wind_up_then_strike_on_release_even_overheated_locking_the_guns() {
        let mut sim = weapon_sim(|t| (t.alt_melee, t.alt_charge_time, t.alt_release) = (3.0, 0.8, 1.0));
        let t = sim.tuning.clone();
        (sim.mech.heat, sim.mech.overheated) = (t.heat_max, true);
        for _ in 0..(0.4 * TICK_HZ) as usize {
            sim.step(&Input { alt_fire: true, ..Input::default() });
        }
        assert!((sim.mech.alt_charge - 0.5).abs() < 0.05 && !sim.mech.launched, "wound {}", sim.mech.alt_charge);
        sim.step(&Input::default());
        assert!(sim.mech.launched && sim.projectiles.is_empty(), "no strike, or it launched something");
        assert!(sim.mech.strike > 0.0 && sim.mech.fire_wait >= melee::RECOVERY - DT, "strike {}, guns {}", sim.mech.strike, sim.mech.fire_wait);
        // The strike keeps the wind-up, which a press while it's out doesn't touch.
        sim.step(&Input { alt_fire: true, ..Input::default() });
        assert!((sim.mech.strike_charge - 0.5).abs() < 0.05 && sim.mech.alt_charge == 0.0, "struck {}, winding {}", sim.mech.strike_charge, sim.mech.alt_charge);
        // Shutting down to repair lets go without a swing.
        (sim.mech.alt_wait, sim.mech.health) = (0.0, 50.0);
        sim.step(&Input { alt_fire: true, ..Input::default() });
        sim.step(&Input { alt_fire: true, repair: true, ..Input::default() });
        assert!(!sim.mech.launched, "swung on shutting down");
    }

    #[test]
    fn a_wound_rocket_punch_carries_the_mech_along_its_aim() {
        // How far (level, and up at most) a punch let go after `hold` s looking `pitch` up carries
        // the mech down the clear run, with nothing to lunge at.
        let punch = |hold: f32, pitch: f32| {
            let mut sim = weapon_sim(|t| (t.alt_melee, t.alt_charge_time, t.alt_release) = (3.0, 0.8, 1.0));
            let (start, mut top) = (sim.mech.pos, 0.0f32);
            for _ in 0..(hold * TICK_HZ).round() as usize {
                sim.step(&Input { alt_fire: true, pitch, ..Input::default() });
            }
            for _ in 0..(2.0 * TICK_HZ) as usize {
                sim.step(&Input { pitch, ..Input::default() });
                top = top.max(sim.mech.pos.y - start.y);
            }
            (Vector::new(sim.mech.pos.x - start.x, 0.0, sim.mech.pos.z - start.z).length(), top)
        };
        let t = weapon_sim(|_| {}).tuning;
        let ((full, _), (half, _), (jab, _)) = (punch(1.0, 0.0), punch(0.4, 0.0), punch(1.0 / TICK_HZ, 0.0));
        assert!((full - t.alt_lunge).abs() < 1.0, "a full wind-up went {full} m");
        assert!((half - 0.5 * t.alt_lunge).abs() < 1.0, "half went {half} m");
        assert!(jab < 1.0, "a tap went {jab} m");
        // Looking up, it climbs that far along the aim.
        let (level, rise) = punch(1.0, 0.6);
        assert!((rise - t.alt_lunge * 0.6f32.sin()).abs() < 1.0 && (level - t.alt_lunge * 0.6f32.cos()).abs() < 1.5, "went {level} m and rose {rise} m");
    }

    #[test]
    fn heat_fed_shells_spend_heat_for_power_even_overheated() {
        let mut sim = weapon_sim(|t| (t.alt_heat_fed, t.alt_heat, t.alt_charge_damage, t.alt_charge_radius) = (1.0, 0.0, 5.0, 3.0));
        let t = sim.tuning.clone();
        (sim.mech.heat, sim.mech.overheated) = (t.heat_max, true);
        sim.step(&Input { alt_fire: true, ..Input::default() });
        assert!(sim.mech.launched && sim.mech.heat == 0.0 && !sim.mech.overheated, "heat {}, overheated {}", sim.mech.heat, sim.mech.overheated);
        let full = projectile::tuning_for(&t, sim.projectiles.last().expect("launched"));
        assert!((full.alt_damage - 5.0 * t.alt_damage).abs() < 1e-3 && (full.alt_radius - 3.0 * t.alt_radius).abs() < 1e-3);
        // Spending a third leaves two thirds, and the shell is still as hot as the mech ran.
        sim.tuning.alt_heat_fed = 1.0 / 3.0;
        (sim.mech.heat, sim.mech.alt_wait) = (t.heat_max, 0.0);
        sim.step(&Input { alt_fire: true, ..Input::default() });
        assert!(sim.mech.launched && (sim.mech.heat - t.heat_max * 2.0 / 3.0).abs() < 1e-3, "heat {}", sim.mech.heat);
        let hot = projectile::tuning_for(&sim.tuning, sim.projectiles.last().expect("launched"));
        assert!((hot.alt_damage - 5.0 * t.alt_damage).abs() < 1e-3, "damage {}", hot.alt_damage);
    }

    #[test]
    fn mines_stick_go_off_near_enemies_cap_and_burst_on_aux() {
        let mut sim = weapon_sim(|t| {
            (t.alt_stick, t.alt_trigger, t.alt_max, t.alt_fuse, t.alt_count, t.alt_cooldown, t.alt_heat) = (1.0, 3.0, 2.0, 20.0, 1.0, 0.1, 0.0);
            (t.alt_speed, t.alt_gravity, t.alt_loft_deg, t.alt_bounce) = (30.0, 18.0, 0.0, 0.0);
        });
        let down = Input { pitch: -0.8, ..Input::default() };
        let lay = Input { alt_fire: true, ..down };
        sim.step(&lay);
        run(&mut sim, down, 30);
        let mine = sim.projectiles[0];
        assert_eq!(mine.vel, Vector::ZERO, "didn't stick");
        run(&mut sim, down, 30);
        assert_eq!(sim.projectiles[0].pos, mine.pos, "moved after sticking");
        let t = sim.tuning.clone();
        let near = Mech { pos: mine.pos + Vector::X * 2.0, ..spawn_mech(&t, Vector::ZERO) };
        let far = Mech { pos: mine.pos + Vector::X * 20.0, ..near };
        assert!(projectile::triggered(&t, &mine, [(&t, &near)]) && !projectile::triggered(&t, &mine, [(&t, &far)]));
        // Laying more doesn't set off those down, but past the cap of two the oldest goes.
        for _ in 0..2 {
            sim.step(&lay);
            run(&mut sim, down, 30);
        }
        assert_eq!(sim.projectiles.len(), 2);
        assert!(sim.projectiles.iter().all(|p| p.seq != mine.seq), "the oldest mine is still down");
        // The middle button sets off every one down at once.
        sim.step(&Input { aux: true, ..down });
        run(&mut sim, down, 2);
        assert!(sim.projectiles.is_empty(), "{} mines still down", sim.projectiles.len());
    }

    #[test]
    fn release_fired_secondaries_fire_when_let_go() {
        let mut sim = weapon_sim(|t| (t.alt_release, t.alt_heat) = (1.0, 0.0));
        sim.step(&Input { alt_fire: true, ..Input::default() });
        assert!(!sim.mech.launched, "fired on the press");
        run(&mut sim, Input { alt_fire: true, ..Input::default() }, 10);
        sim.step(&Input::default());
        assert!(sim.mech.launched, "didn't fire when let go");
    }

    #[test]
    fn lock_on_picks_on_a_press_locks_then_holds_off_aim_and_shells_home() {
        let mut t = Tuning::default();
        (t.alt_lock_time, t.alt_lock_cone, t.alt_lock_hold, t.alt_turn, t.alt_speed, t.alt_fuse) = (0.5, 30.0, 1.0, 180.0, 40.0, 3.0);
        let arena = Arena::new(&map::Map::load(map::Map::index("blockout").unwrap()));
        let mut m = spawn_mech(&t, Vector::new(0.0, 0.1, 45.0));
        let eye = aim_ray(&t, &m).origin;
        // Both are in the cone; the press picks the one nearer the aim.
        let (ahead, aside) = ((7, eye + Vector::new(3.0, 0.0, -20.0)), (9, eye + Vector::new(8.0, 0.0, -20.0)));
        let press = |m: &mut Mech, chests: &[(u8, Vector)]| {
            m.aux_pressed = true;
            projectile::track(&arena, &t, m, chests);
            m.aux_pressed = false;
        };
        let ticks = |s: f32| (s * TICK_HZ) as usize + 1;

        // Looking away before the lock is made drops it.
        press(&mut m, &[ahead, aside]);
        assert_eq!((m.lock, m.lock_time), (8, 0.0));
        m.yaw = 1.5;
        projectile::track(&arena, &t, &mut m, &[ahead, aside]);
        assert_eq!(m.lock, 0, "kept a lock it lost before it was made");

        // Kept in the cone, it locks; then it holds wherever the mech looks, for `alt_lock_hold`.
        m.yaw = 0.0;
        press(&mut m, &[ahead, aside]);
        for _ in 0..ticks(t.alt_lock_time) {
            projectile::track(&arena, &t, &mut m, &[ahead, aside]);
        }
        assert!(m.lock == 8 && m.lock_time >= t.alt_lock_time, "lock {} for {}", m.lock, m.lock_time);
        m.yaw = 1.5;
        for _ in 0..ticks(t.alt_lock_hold) - 3 {
            projectile::track(&arena, &t, &mut m, &[ahead, aside]);
        }
        assert_eq!(m.lock, 8, "lost the lock looking away");
        let mut p = projectile::volley(&t, &m, 0, 1)[0];
        assert_eq!(p.target, 8);
        for _ in 0..4 {
            projectile::track(&arena, &t, &mut m, &[ahead, aside]);
        }
        assert_eq!(m.lock, 0, "held past alt_lock_hold");

        // Firing spends a lock.
        press(&mut m, &[ahead]);
        m.launched = true;
        projectile::track(&arena, &t, &mut m, &[ahead]);
        assert_eq!(m.lock, 0, "kept the lock after firing");
        // Homing on a goal off to the side turns the shell toward it.
        let dir = p.vel.normalize();
        let goal = p.pos + dir * 15.0 + Vector::Y.cross(dir) * 15.0;
        for _ in 0..10 {
            projectile::home(&t, &mut p, goal);
            p.pos += p.vel * DT;
        }
        assert!(p.vel.normalize().dot((goal - p.pos).normalize()) > 0.95, "didn't turn toward the goal");
    }

    #[test]
    fn splitting_shells_scatter_bomblets_in_the_air_only() {
        let t = Tuning { alt_split: 6.0, alt_split_damage: 10.0, alt_split_radius: 2.5, ..Tuning::default() };
        let m = spawn_mech(&t, Vector::new(0.0, 0.1, 45.0));
        let mut p = projectile::volley(&t, &m, 0, 1)[0];
        p.age = 0.1;
        assert!(projectile::split(&t, &p, p.pos).is_empty(), "split on contact");
        p.age = f32::INFINITY; // pressed, or its fuse ran out
        let bomblets = projectile::split(&t, &p, p.pos);
        assert_eq!(bomblets.len(), 6);
        let b = projectile::tuning_for(&t, &bomblets[0]);
        assert_eq!((b.alt_damage, b.alt_radius, b.alt_split), (10.0, 2.5, 0.0));
        assert!(bomblets.iter().all(|b| b.n >= projectile::BOMBLET && !projectile::armed(b)) && projectile::split(&t, &bomblets[0], p.pos).is_empty());
    }

    #[test]
    fn vent_dumps_heat_once_per_cooldown() {
        let (mut sim, t) = class_sim(MechClass::B);
        let fire = Input { fire: true, ..Input::default() };
        let vent = Input { ability: true, ..Input::default() };
        fire_until_overheated(&mut sim);
        sim.step(&vent);
        assert_eq!(sim.mech.heat, 0.0);
        assert!(!sim.mech.overheated);
        assert_eq!(sim.mech.ability_cooldown, t.vent_cooldown);
        run(&mut sim, fire, 30);
        let heat = sim.mech.heat;
        sim.step(&vent);
        assert!(sim.mech.heat > 0.0 && sim.mech.heat <= heat, "vented again during the cooldown");
    }

    /// Holds the primary's trigger until the mech overheats (within 20 s).
    fn fire_until_overheated(sim: &mut Sim) {
        let fire = Input { fire: true, ..Input::default() };
        for _ in 0..(20.0 * TICK_HZ) as usize {
            sim.step(&fire);
            if sim.mech.overheated {
                return;
            }
        }
        panic!("never overheated");
    }

    #[test]
    fn heat_sheds_a_moment_after_the_last_shot_faster_when_cool() {
        let (mut sim, t) = class_sim(MechClass::B);
        let fire = Input { fire: true, ..Input::default() };
        // Firing steadily, it doesn't cool between shots.
        run(&mut sim, fire, 2);
        let held = sim.mech.heat;
        sim.step(&fire);
        assert!(sim.mech.heat >= held, "cooled between shots");
        // With the next shot a while off, as a slow gun's is, it cools once `heat_decay_delay` is up
        // after the last, trigger held; faster low than high.
        sim.mech.fire_wait = 0.0;
        sim.step(&fire);
        assert!(sim.mech.shot);
        sim.mech.fire_wait = 10.0;
        let hot = sim.mech.heat;
        run(&mut sim, fire, (t.heat_decay_delay * TICK_HZ) as usize - 1);
        assert_eq!(sim.mech.heat, hot, "cooled before the delay was up");
        run(&mut sim, fire, 2);
        assert!(sim.mech.heat < hot, "never cooled with the trigger held");
        sim.mech.heat = 0.9 * t.heat_max;
        sim.step(&fire);
        let high = 0.9 * t.heat_max - sim.mech.heat;
        sim.mech.heat = 0.1 * t.heat_max;
        sim.step(&fire);
        let low = 0.1 * t.heat_max - sim.mech.heat;
        assert!(high > 0.0 && low > 2.0 * high, "high {high}, low {low}");
    }

    #[test]
    fn secondary_shares_heat() {
        let (mut sim, t) = armed_sim(MechClass::B, Loadout::named("pike", "rocket"));
        let alt = Input { alt_fire: true, ..Input::default() };
        sim.step(&alt);
        assert!(sim.mech.launched);
        assert_eq!(sim.mech.heat, t.alt_heat);
        assert_eq!(sim.projectiles.len(), 1);
        sim.step(&alt);
        assert!(!sim.mech.launched, "fired again during the cooldown");

        // Overheating takes longer than the cooldown, so the secondary is ready again.
        fire_until_overheated(&mut sim);
        assert!(sim.mech.alt_wait <= 0.0, "test needs a ready secondary while overheated");
        sim.step(&Input { fire: true, alt_fire: true, ..Input::default() });
        assert!(!sim.mech.launched && !sim.mech.shot, "fired while overheated");
    }

    #[test]
    fn no_burst_before_arming() {
        let (mut sim, _) = armed_sim(MechClass::B, Loadout::named("pike", "rocket"));
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
        let (mut sim, _) = armed_sim(MechClass::B, Loadout::named("pike", "rocket"));
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
        assert_eq!(sim.blasts, [(t.alt_radius, next.pos, 0.0)]);
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
            // The slim Light covers a few more of its own widths.
            assert!((2.0..=5.5).contains(&widths), "{class:?} dashed {moved} m, {widths} widths");
            if class == MechClass::B {
                assert!((7.0..=9.5).contains(&moved), "Medium dashed {moved} m");
            }
        }
    }

    #[test]
    fn speed_boost_refills_fuel_then_boosts_free_and_faster() {
        let (mut sim, t) = class_sim(MechClass::A);
        sim.mech.fuel = 1.0;
        sim.step(&Input { ability: true, ..Input::default() });
        assert_eq!(sim.mech.fuel, t.fuel_max, "speed boost didn't refill the tank");
        let boost = Input { move_z: 1.0, boost: true, ..Input::default() };
        run(&mut sim, boost, 30);
        assert_eq!(sim.mech.fuel, t.fuel_max, "speed boost burned fuel");
        assert!((speed(&sim) - t.boost_speed * t.slipstream_boost_mult).abs() < 0.05, "speed {}", speed(&sim));
        // Wait out the 4 s back at the start, then boost again.
        sim.mech.pos = Vector::new(0.0, 0.1, 45.0);
        run(&mut sim, Input::default(), 100);
        run(&mut sim, boost, 30);
        assert!(sim.mech.fuel < t.fuel_max, "boost stayed free after the speed boost");
        assert!((speed(&sim) - t.boost_speed).abs() < 0.05, "speed {}", speed(&sim));
    }

    #[test]
    fn bulwark_speeds_up_on_foot_and_grounds_boost() {
        let (mut sim, t) = class_sim(MechClass::C);
        sim.step(&Input { ability: true, ..Input::default() });
        let boost = Input { move_z: 1.0, boost: true, ..Input::default() };
        run(&mut sim, boost, 60);
        assert!(!sim.mech.boosting, "boosted behind the bulwark");
        assert!(t.brace_speed_mult > 1.0 && (speed(&sim) - t.walk_speed * t.brace_speed_mult).abs() < 0.05, "speed {}", speed(&sim));
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
