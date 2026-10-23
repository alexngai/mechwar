//! Deployables: what a mech puts down to stay a while, from its support slot: the shield dome
//! and the barrier. The server owns them: it places them when the item's used (`place`), carries
//! them in snapshots, and clears them when they expire. A mech has at most one of each kind out.
//!
//! A dome stops the other side's shots crossing into it (`stops`): hitscan, projectiles and
//! splash alike. Its own side shoots out freely, and mechs walk through. A barrier is a wall in
//! the arena itself (`Arena::set_barriers`), blocking movement and shots for everyone, so clients
//! add it to their own arenas from snapshots and predict against it like any wall.

use rapier3d::prelude::{Collider, ColliderBuilder, ColliderHandle, Ray, Rotation};
use serde::{Deserialize, Serialize};

use crate::{Arena, Mech, TICK_HZ, Tuning, Vector, hit_shape};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    Dome,
    Barrier,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Deployable {
    pub kind: Kind,
    pub team: u8,
    pub owner: u8,
    /// Its base on the ground: a dome's center, a barrier's bottom middle.
    pub pos: Vector,
    /// A barrier faces along this yaw (as a mech's aim does), standing across it.
    pub yaw: f32,
    /// Ticks it went down at, and goes at.
    pub placed: u32,
    pub expires: u32,
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
/// its feet, or a barrier `barrier_distance` ahead across its aim, each on the ground below. None
/// when a barrier would stand in one of `mechs`.
#[allow(clippy::too_many_arguments)]
pub fn place<'a>(arena: &Arena, t: &Tuning, m: &Mech, kind: Kind, team: u8, owner: u8, tick: u32, mut mechs: impl Iterator<Item = (&'a Tuning, &'a Mech)>) -> Option<Deployable> {
    let (at, seconds) = match kind {
        Kind::Dome => (m.pos, t.dome_seconds),
        Kind::Barrier => (m.pos + Rotation::from_rotation_y(m.yaw) * Vector::NEG_Z * t.barrier_distance, t.barrier_seconds),
    };
    // The ground below, from a little over the mech's feet (so a barrier on a slope or step finds it).
    let from = Vector::new(at.x, m.pos.y + 2.0, at.z);
    let pos = arena.cast_ray(&Ray::new(from, Vector::NEG_Y), 60.0).map_or(at, |d| from + Vector::NEG_Y * d);
    let d = Deployable { kind, team, owner, pos, yaw: m.yaw, placed: tick, expires: tick + (seconds * TICK_HZ).round() as u32 };
    (kind != Kind::Barrier || !mechs.any(|(tm, q)| d.blocks(t, tm, q))).then_some(d)
}

/// `list` with `d` added, in place of any of its owner's of the same kind.
pub fn add(list: &mut Vec<Deployable>, d: Deployable) {
    list.retain(|e| (e.owner, e.kind) != (d.owner, d.kind));
    list.push(d);
}

/// How far along `ray` (a unit direction), within `max`, a dome of another side than `team`
/// stops a shot coming at it from outside. A shot from inside one passes.
pub fn stops(list: &[Deployable], t: &Tuning, team: u8, ray: &Ray, max: f32) -> Option<f32> {
    let r = t.dome_radius;
    list.iter()
        .filter(|d| d.kind == Kind::Dome && d.team != team)
        .filter_map(|d| {
            let to = ray.origin - d.pos;
            if to.length_squared() <= r * r {
                return None;
            }
            let b = to.dot(ray.dir);
            let disc = b * b - (to.length_squared() - r * r);
            let toi = -b - disc.max(0.0).sqrt();
            // Through the dome's upper half (the rest is underground), within reach.
            (disc >= 0.0 && (0.0..=max).contains(&toi) && ray.point_at(toi).y >= d.pos.y).then_some(toi)
        })
        .min_by(f32::total_cmp)
}

impl Arena {
    /// Makes the barriers in `list` walls of the arena, and clears those that have gone.
    pub fn set_barriers(&mut self, t: &Tuning, list: &[Deployable]) {
        let key = |d: &Deployable| (d.owner, d.placed);
        let walls: Vec<&Deployable> = list.iter().filter(|d| d.kind == Kind::Barrier).collect();
        let (world, before) = (&mut self.world, self.barriers.len());
        self.barriers.retain(|&(k, handle)| {
            let keep = walls.iter().any(|d| key(d) == k);
            if !keep {
                world.remove_collider(handle);
            }
            keep
        });
        let mut changed = self.barriers.len() != before;
        for d in walls {
            if !self.barriers.iter().any(|&(k, _)| k == key(d)) {
                let handle: ColliderHandle = self.world.insert_collider(d.wall(t), None);
                self.barriers.push((key(d), handle));
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
    fn domes_stop_the_other_sides_shots_from_outside() {
        let t = Tuning::default();
        let dome = Deployable { kind: Kind::Dome, team: 0, owner: 0, pos: Vector::ZERO, yaw: 0.0, placed: 0, expires: 100 };
        let list = [dome];
        let at = |from: Vector| {
            let to = Vector::new(0.0, 1.0, 0.0) - from;
            stops(&list, &t, 1, &Ray::new(from, to.normalize()), to.length())
        };
        // From outside, the other side's shot stops at the surface; its own side's doesn't.
        let outside = Vector::new(20.0, 1.0, 0.0);
        let surface = (t.dome_radius * t.dome_radius - 1.0).sqrt();
        assert!((at(outside).unwrap() - (20.0 - surface)).abs() < 0.01);
        assert_eq!(stops(&list, &t, 0, &Ray::new(outside, Vector::NEG_X), 30.0), None, "stopped its own side");
        // From inside, out; and over the top or under the ground, nothing.
        assert_eq!(stops(&list, &t, 1, &Ray::new(Vector::new(1.0, 1.0, 0.0), Vector::X), 30.0), None);
        assert_eq!(stops(&list, &t, 1, &Ray::new(Vector::new(20.0, t.dome_radius + 1.0, 0.0), Vector::NEG_X), 40.0), None);
        assert_eq!(stops(&list, &t, 1, &Ray::new(Vector::new(20.0, -1.0, 0.0), Vector::NEG_X), 40.0), None);
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
        // None where it'd stand in a mech.
        let there = spawn_mech(&t, wall.pos);
        assert_eq!(place(&arena, &t, &m, Kind::Barrier, 0, 0, 1, [(&t, &there)].into_iter()), None);
    }
}
