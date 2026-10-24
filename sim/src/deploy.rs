//! Deployables: what a mech puts down to stay a while. From its support slot, the shield dome
//! and the barrier; from its offensive slot, the MG and rocket turrets. The server owns them: it
//! places them when the item's used (`place`), carries them in snapshots, mans the turrets
//! (game.rs), and clears them when they expire or, a turret, are shot down. A mech has at most
//! one of each kind out.
//!
//! A dome stops every shot crossing its surface, either way and whichever side fired it
//! (`stops`): hitscan, projectiles, splash and beams alike. Shots inside it hit, so the way to get
//! someone under one is to walk in after them; mechs walk through. A barrier is a wall in
//! the arena itself (`Arena::set_barriers`), blocking movement and shots for everyone, so clients
//! add it to their own arenas from snapshots and predict against it like any wall. A turret is a
//! tripod gun that trains on the nearest enemy it can see (`train`) and fires at it; mechs walk
//! through it, and the other side's shots hit it (`first_turret`).

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Capsule, Collider, ColliderBuilder, ColliderHandle, Pose, Ray, Rotation};
use serde::{Deserialize, Serialize};

use crate::bot::{look_at, wrap};
use crate::{Arena, DT, Mech, TICK_HZ, Tuning, Vector, hit_shape};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    Dome,
    Barrier,
    MgTurret,
    RocketTurret,
}

impl Kind {
    pub fn turret(self) -> bool {
        matches!(self, Kind::MgTurret | Kind::RocketTurret)
    }
}

/// A turret's gun is on target once trained within this of its aim, in yaw and pitch (radians).
const ON_TARGET: f32 = 0.05;

/// Lock-on and homing (`projectile::track`, `home`) know turrets by ids past every player's:
/// this, plus twice the owner's id, plus 1 for a rocket turret.
pub const TARGET: u8 = 64;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Deployable {
    pub kind: Kind,
    pub team: u8,
    pub owner: u8,
    /// Its base on the ground: a dome's center, a barrier's bottom middle.
    pub pos: Vector,
    /// A barrier faces along this yaw (as a mech's aim does), standing across it; a turret's gun
    /// points along it and `pitch`.
    pub yaw: f32,
    pub pitch: f32,
    /// What's left to shoot off it: a turret's hull, infinite for the rest.
    pub hull: f32,
    /// Ticks it went down at, and goes at.
    pub placed: u32,
    pub expires: u32,
    /// A turret fires again from this tick, with this many rounds of its burst left.
    pub ready: u32,
    pub burst: u8,
}

impl Deployable {
    /// A barrier's wall: a box everything collides with.
    fn wall(&self, t: &Tuning) -> Collider {
        ColliderBuilder::cuboid(t.barrier_width * 0.5, t.barrier_height * 0.5, t.barrier_thickness * 0.5)
            .translation(self.pos + Vector::Y * (t.barrier_height * 0.5))
            .rotation(Rotation::from_rotation_y(self.yaw).to_scaled_axis())
            .build()
    }

    /// Whether a barrier here would stand in mech `m` (tuned by `tm`).
    fn blocks(&self, t: &Tuning, tm: &Tuning, m: &Mech) -> bool {
        let (c, center) = hit_shape(tm, m);
        let at = Rotation::from_rotation_y(-self.yaw) * (center - self.pos);
        let reach = c.radius;
        at.x.abs() < t.barrier_width * 0.5 + reach
            && at.z.abs() < t.barrier_thickness * 0.5 + reach
            && at.y + c.half_height() + reach > 0.0
            && at.y - c.half_height() - reach < t.barrier_height
    }
}

/// What mech `m` (player `owner`, on `team`) puts down using `kind` on tick `tick`: a dome around
/// its feet, a barrier `barrier_distance` ahead across its aim, or a turret `turret_distance`
/// ahead facing it (each short of a wall in the way), on the ground below. None when a barrier
/// would stand in one of `mechs` (pass spawn points as mechs too, so none boxes a spawn in).
#[allow(clippy::too_many_arguments)]
pub fn place<'a>(arena: &Arena, t: &Tuning, m: &Mech, kind: Kind, team: u8, owner: u8, tick: u32, mut mechs: impl Iterator<Item = (&'a Tuning, &'a Mech)>) -> Option<Deployable> {
    // Ahead along the aim, but this side of any wall in the way (checked a metre up, so steps and
    // ramps don't count), less `clear`: nothing goes down through a wall or inside a block.
    let ahead = |d: f32, clear: f32| {
        let dir = Rotation::from_rotation_y(m.yaw) * Vector::NEG_Z;
        let wall = arena.cast_ray(&Ray::new(m.pos + Vector::Y, dir), d + clear).map_or(d, |w| (w - clear).clamp(0.0, d));
        m.pos + dir * wall
    };
    let (at, seconds, hull) = match kind {
        Kind::Dome => (m.pos, t.dome_seconds, f32::INFINITY),
        Kind::Barrier => (ahead(t.barrier_distance, t.barrier_thickness * 0.5 + 0.1), t.barrier_seconds, f32::INFINITY),
        Kind::MgTurret | Kind::RocketTurret => (ahead(t.turret_distance, t.turret_radius + 0.1), t.turret_seconds, t.turret_hull),
    };
    // The ground below, from a little over the mech's feet (so a barrier on a slope or step finds it).
    let from = Vector::new(at.x, m.pos.y + 2.0, at.z);
    let pos = arena.cast_ray(&Ray::new(from, Vector::NEG_Y), 60.0).map_or(at, |d| from + Vector::NEG_Y * d);
    let ticks = |s: f32| (s * TICK_HZ).round() as u32;
    let d = Deployable { kind, team, owner, pos, yaw: m.yaw, pitch: 0.0, hull, placed: tick, expires: tick + ticks(seconds), ready: tick + ticks(t.turret_warmup), burst: 0 };
    (kind != Kind::Barrier || !mechs.any(|(tm, q)| d.blocks(t, tm, q))).then_some(d)
}

/// Where turret `d`'s gun is.
pub fn gun(t: &Tuning, d: &Deployable) -> Vector {
    d.pos + Vector::Y * t.turret_height
}

/// Turret `d`'s id for lock-on and homing (see `TARGET`).
pub fn target_id(d: &Deployable) -> u8 {
    TARGET + 2 * d.owner + u8::from(d.kind == Kind::RocketTurret)
}

/// The middle of turret `d`'s body.
pub fn center(t: &Tuning, d: &Deployable) -> Vector {
    body(t, d).1
}

/// The standing turrets in `list` that `which` picks, as lock-on and homing targets: their ids,
/// and their guns (aimed at the body's middle, missiles curving down onto it hit the floor short).
pub fn targets<'a>(list: &'a [Deployable], t: &'a Tuning, which: impl Fn(&Deployable) -> bool + 'a) -> impl Iterator<Item = (u8, Vector)> + 'a {
    list.iter().filter(move |d| d.kind.turret() && d.hull > 0.0 && which(d)).map(|d| (target_id(d), gun(t, d)))
}

/// Turret `d`'s body, for shots to hit: a capsule up to its gun, and its center.
fn body(t: &Tuning, d: &Deployable) -> (Capsule, Vector) {
    let r = t.turret_radius.min(t.turret_height * 0.5);
    (Capsule::new_y(t.turret_height * 0.5 - r, r), d.pos + Vector::Y * (t.turret_height * 0.5))
}

/// Turret `d` as a stand-in mech, with the tuning that sizes it as one (for splash).
pub fn as_mech(t: &Tuning, d: &Deployable) -> (Tuning, Mech) {
    (Tuning { mech_height: t.turret_height, mech_radius: t.turret_radius, ..t.clone() }, Mech { pos: d.pos, ..Mech::default() })
}

/// The nearest turret of another side than `team` (and not shot down already) along `ray` within
/// `max`: its index in `list`, and how far.
pub fn first_turret(list: &[Deployable], t: &Tuning, team: u8, ray: &Ray, max: f32) -> Option<(usize, f32)> {
    list.iter()
        .enumerate()
        .filter(|(_, d)| d.kind.turret() && d.team != team && d.hull > 0.0)
        .filter_map(|(k, d)| {
            let (shape, center) = body(t, d);
            shape.cast_ray(&Pose::from_translation(center), ray, max, true).map(|toi| (k, toi))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
}

/// Trains turret `d`'s gun on `goal`, turning at most this tick's `turret_turn_deg` (as a bot
/// turns); whether it's on target.
pub fn train(t: &Tuning, d: &mut Deployable, goal: Vector) -> bool {
    let (yaw, pitch) = look_at(gun(t, d), goal);
    let max = t.turret_turn_deg.to_radians() * DT;
    d.yaw += wrap(yaw - d.yaw).clamp(-max, max);
    d.pitch += (pitch - d.pitch).clamp(-max, max);
    wrap(yaw - d.yaw).abs() < ON_TARGET && (pitch - d.pitch).abs() < ON_TARGET
}

/// `list` with `d` added, in place of any of its owner's of the same kind.
pub fn add(list: &mut Vec<Deployable>, d: Deployable) {
    list.retain(|e| (e.owner, e.kind) != (d.owner, d.kind));
    list.push(d);
}

/// How far along `ray` (a unit direction), within `max`, a dome's surface stops a shot: going in
/// from outside, or out from inside, whoever fired it. A shot that stays inside passes.
pub fn stops(list: &[Deployable], t: &Tuning, ray: &Ray, max: f32) -> Option<f32> {
    let r = t.dome_radius;
    list.iter()
        .filter(|d| d.kind == Kind::Dome)
        .filter_map(|d| {
            let to = ray.origin - d.pos;
            let b = to.dot(ray.dir);
            let disc = b * b - (to.length_squared() - r * r);
            // Where the line meets the sphere: from outside, the near side; from inside, the far.
            let inside = to.length_squared() <= r * r;
            let toi = -b + if inside { 1.0 } else { -1.0 } * disc.max(0.0).sqrt();
            // Through the dome's upper half (the rest is underground), within reach.
            (disc >= 0.0 && (0.0..=max).contains(&toi) && ray.point_at(toi).y >= d.pos.y).then_some(toi)
        })
        .min_by(f32::total_cmp)
}

impl Arena {
    /// Makes the barriers in `list` walls of the arena, and clears those that have gone.
    pub fn set_barriers(&mut self, t: &Tuning, list: &[Deployable]) {
        let walls: Vec<&Deployable> = list.iter().filter(|d| d.kind == Kind::Barrier).collect();
        let (world, before) = (&mut self.world, self.barriers.len());
        self.barriers.retain(|(had, handle)| {
            let keep = walls.iter().any(|d| *d == had);
            if !keep {
                world.remove_collider(*handle);
            }
            keep
        });
        let mut changed = self.barriers.len() != before;
        for d in walls {
            if !self.barriers.iter().any(|(had, _)| had == d) {
                let handle: ColliderHandle = self.world.insert_collider(d.wall(t), None);
                self.barriers.push((*d, handle));
                changed = true;
            }
        }
        if changed {
            self.world.detect_collisions(&(), &());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Map, spawn_mech};

    #[test]
    fn domes_stop_shots_crossing_them_either_way() {
        let t = Tuning::default();
        let dome = Deployable { kind: Kind::Dome, team: 0, owner: 0, pos: Vector::ZERO, yaw: 0.0, pitch: 0.0, hull: f32::INFINITY, placed: 0, expires: 100, ready: 0, burst: 0 };
        let list = [dome];
        let at = |from: Vector| {
            let to = Vector::new(0.0, 1.0, 0.0) - from;
            stops(&list, &t, &Ray::new(from, to.normalize()), to.length())
        };
        // From outside, a shot stops at the surface (its side's own too: domes don't ask).
        let outside = Vector::new(20.0, 1.0, 0.0);
        let surface = (t.dome_radius * t.dome_radius - 1.0).sqrt();
        assert!((at(outside).unwrap() - (20.0 - surface)).abs() < 0.01);
        // From inside, out: stopped at the far side. Inside to inside: through.
        let out = stops(&list, &t, &Ray::new(Vector::new(1.0, 1.0, 0.0), Vector::X), 30.0).unwrap();
        assert!((out - (surface - 1.0)).abs() < 0.01, "stopped {out} m out");
        assert_eq!(stops(&list, &t, &Ray::new(Vector::new(1.0, 1.0, 0.0), Vector::X), surface - 1.5), None);
        // Over the top or under the ground, nothing.
        assert_eq!(stops(&list, &t, &Ray::new(Vector::new(20.0, t.dome_radius + 1.0, 0.0), Vector::NEG_X), 40.0), None);
        assert_eq!(stops(&list, &t, &Ray::new(Vector::new(20.0, -1.0, 0.0), Vector::NEG_X), 40.0), None);
    }

    #[test]
    fn barriers_are_walls_until_cleared() {
        let t = Tuning::default();
        let mut arena = Arena::new(&Map::load(Map::index("blockout").unwrap()));
        let m = Mech { yaw: 0.0, ..spawn_mech(&t, Vector::new(0.0, 0.0, 40.0)) };
        let wall = place(&arena, &t, &m, Kind::Barrier, 0, 0, 1, std::iter::empty()).unwrap();
        // Across the aim, 4 m ahead (the mech faces -z).
        assert!((wall.pos - Vector::new(0.0, 0.0, 40.0 - t.barrier_distance)).length() < 0.05, "at {}", wall.pos);
        let eye = Ray::new(Vector::new(0.0, 2.0, 40.0), Vector::NEG_Z);
        let before = arena.cast_ray(&eye, 30.0);
        arena.set_barriers(&t, &[wall]);
        let hit = arena.cast_ray(&eye, 30.0).unwrap();
        assert!((hit - (t.barrier_distance - t.barrier_thickness * 0.5)).abs() < 0.05, "hit at {hit}");
        arena.set_barriers(&t, &[]);
        assert_eq!(arena.cast_ray(&eye, 30.0), before, "the wall stayed");
        // Offline too: the sandbox's mech walks into its own and stops.
        let mut sim = crate::Sim::with_map(t.clone(), Map::index("blockout").unwrap());
        sim.loadout = crate::Loadout { support: crate::item::Item::Barrier.index(), ..sim.loadout };
        sim.reset();
        let start = sim.mech.pos.z;
        sim.step(&crate::Input { emp: true, ..crate::Input::default() });
        assert_eq!(sim.deployables.len(), 1);
        for _ in 0..60 {
            sim.step(&crate::Input { move_z: 1.0, ..crate::Input::default() });
        }
        assert!(sim.mech.pos.z > start - t.barrier_distance + t.barrier_thickness * 0.5, "walked through, to z {} from {start}", sim.mech.pos.z);
        // Short of a wall in the way: facing the east wall (inner face x = 50) from 3 m off.
        let near = Mech { yaw: -std::f32::consts::FRAC_PI_2, ..spawn_mech(&t, Vector::new(47.0, 0.0, 0.0)) };
        for kind in [Kind::Barrier, Kind::MgTurret] {
            let d = place(&arena, &t, &near, kind, 0, 0, 1, std::iter::empty()).unwrap();
            assert!(d.pos.x < 50.0 - t.barrier_thickness * 0.5 && d.pos.y < 0.5, "{kind:?} went down at {}", d.pos);
        }
        // None where it'd stand in a mech.
        let there = spawn_mech(&t, wall.pos);
        assert_eq!(place(&arena, &t, &m, Kind::Barrier, 0, 0, 1, [(&t, &there)].into_iter()), None);
    }
}
