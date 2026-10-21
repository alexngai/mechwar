//! Secondary-weapon projectiles: launched from the eye, flown one tick at a time against the
//! arena and whatever mechs the caller supplies, bursting with splash damage. Pure and
//! deterministic, so the server, the predicting client and remote replays fly identical paths
//! through the arena; only mech contacts can differ between them.

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Capsule, Pose, Ray, Rotation};
use serde::{Deserialize, Serialize};

use crate::{Arena, DT, Mech, MechClass, Tuning, Vector, aim_ray, mech_capsule};

/// Added to mech capsules for contact: projectiles aren't points.
pub const PROJECTILE_RADIUS: f32 = 0.25;
/// Splash at the radius edge, as a fraction of full damage.
const EDGE_DAMAGE: f32 = 0.3;
/// Bursts sit this far back from the surface they hit, so splash rays start outside it.
const STANDOFF: f32 = 0.1;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Projectile {
    pub owner: u8,
    /// The owner's input that launched it, and its index in the volley: with `owner`, its id.
    pub seq: u32,
    pub n: u8,
    /// The owner's class at launch, which picks the tuning it flies with.
    pub class: MechClass,
    pub pos: Vector,
    pub vel: Vector,
    pub age: f32,
}

impl Projectile {
    pub fn id(&self) -> (u8, u32, u8) {
        (self.owner, self.seq, self.n)
    }
}

/// The volley `m` launched this tick: from its eye along its aim, pitched up by `alt_loft_deg`,
/// as a level fan of `alt_count` spaced `alt_spread_deg` apart.
pub fn volley(t: &Tuning, m: &Mech, owner: u8, seq: u32) -> Vec<Projectile> {
    let eye = aim_ray(t, m).origin;
    let count = t.alt_count.max(1.0) as u8;
    let pitch = m.pitch + t.alt_loft_deg.to_radians();
    (0..count)
        .map(|n| {
            let fan = (f32::from(n) - f32::from(count - 1) * 0.5) * t.alt_spread_deg.to_radians();
            let dir = Rotation::from_rotation_y(m.yaw + fan) * Rotation::from_rotation_x(pitch) * Vector::NEG_Z;
            Projectile { owner, seq, n, class: m.class, pos: eye, vel: dir * t.alt_speed, age: 0.0 }
        })
        .collect()
}

/// Advances `p` one tick: gravity, then this tick's path against the arena and `hit_mech`, which
/// gives how far along a ray (up to a limit) the nearest mech stops it. Off the arena it bounces
/// if `alt_bounce` is set, else bursts; it always bursts on a mech or once its fuse runs out.
/// Returns where it burst.
pub fn fly(arena: &Arena, t: &Tuning, p: &mut Projectile, mut hit_mech: impl FnMut(&Ray, f32) -> Option<f32>) -> Option<Vector> {
    p.age += DT;
    p.vel.y -= t.alt_gravity * DT;
    let step = p.vel * DT;
    let len = step.length();
    if len > 1e-6 {
        let ray = Ray::new(p.pos, step / len);
        let wall = arena.cast_ray_normal(&ray, len);
        if let Some(toi) = hit_mech(&ray, wall.map_or(len, |(toi, _)| toi)) {
            return Some(ray.point_at((toi - STANDOFF).max(0.0)));
        }
        match wall {
            Some((toi, _)) if t.alt_bounce <= 0.0 => return Some(ray.point_at((toi - STANDOFF).max(0.0))),
            Some((toi, normal)) => {
                // The rest of this tick's travel is dropped; the shell leaves the surface next tick.
                p.pos = ray.point_at(toi) + normal * STANDOFF;
                p.vel = (p.vel - normal * (2.0 * p.vel.dot(normal))) * t.alt_bounce;
            }
            None => p.pos += step,
        }
    }
    // Half a tick of slack so the fuse lands on a whole tick despite float sums.
    (p.age >= t.alt_fuse - DT * 0.5).then_some(p.pos)
}

/// How far along `ray`, within `max`, the nearest of `mechs` stops a projectile.
pub fn first_mech<'a>(ray: &Ray, mut max: f32, mechs: impl IntoIterator<Item = (&'a Tuning, &'a Mech)>) -> Option<f32> {
    let mut best = None;
    for (t, m) in mechs {
        let c = mech_capsule(t);
        let shape = Capsule::new_y(c.half_height(), c.radius + PROJECTILE_RADIUS);
        let pose = Pose::from_translation(m.pos + Vector::Y * (t.mech_height * 0.5));
        if let Some(toi) = shape.cast_ray(&pose, ray, max, true) {
            max = toi;
            best = Some(toi);
        }
    }
    best
}

/// Damage a burst at `at` from a weapon tuned by `t` does to mech `m` (tuned by `tm`): full at
/// contact, falling linearly to EDGE_DAMAGE at `alt_radius`, none beyond it or through the arena.
pub fn splash(arena: &Arena, t: &Tuning, at: Vector, tm: &Tuning, m: &Mech) -> f32 {
    let c = mech_capsule(tm);
    let center = m.pos + Vector::Y * (tm.mech_height * 0.5);
    let h = c.half_height();
    let axis = Vector::new(center.x, at.y.clamp(center.y - h, center.y + h), center.z);
    let to = axis - at;
    let dist = to.length();
    let surface = (dist - c.radius).max(0.0);
    if surface >= t.alt_radius {
        return 0.0;
    }
    if surface > 0.0 && arena.cast_ray(&Ray::new(at, to / dist), surface).is_some() {
        return 0.0;
    }
    t.alt_damage * (1.0 - (1.0 - EDGE_DAMAGE) * surface / t.alt_radius)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Map, spawn_mech};
    use std::f32::consts::FRAC_PI_2;

    fn blockout() -> Arena {
        Arena::new(&Map::load(Map::index("blockout").unwrap()))
    }

    fn mech(class: MechClass, pos: [f32; 3], yaw: f32, pitch: f32) -> (Tuning, Mech) {
        let t = Tuning::default().for_class(class);
        let m = Mech { class, yaw, pitch, ..spawn_mech(&t, Vector::from_array(pos)) };
        (t, m)
    }

    /// Flies `p` against the arena alone until it bursts; returns the burst and every position.
    fn fly_out(arena: &Arena, t: &Tuning, mut p: Projectile) -> (Vector, Vec<Projectile>) {
        let mut path = vec![p];
        for _ in 0..1000 {
            if let Some(at) = fly(arena, t, &mut p, |_, _| None) {
                return (at, path);
            }
            path.push(p);
        }
        panic!("never burst");
    }

    #[test]
    fn rocket_bursts_at_the_wall() {
        // Facing +X toward the east wall, whose inner face is at x = 50.
        let arena = blockout();
        let (t, m) = mech(MechClass::B, [40.0, 0.0, 0.0], -FRAC_PI_2, 0.0);
        let (at, _) = fly_out(&arena, &t, volley(&t, &m, 0, 1)[0]);
        assert!(at.x < 50.0 && at.x > 49.85, "burst at {at}");
    }

    #[test]
    fn darts_fan_symmetrically() {
        let (t, m) = mech(MechClass::A, [0.0, 0.0, 0.0], 0.3, 0.1);
        let v = volley(&t, &m, 0, 1);
        assert_eq!(v.len(), 3);
        let aim = aim_ray(&t, &m).dir;
        let angle = |p: &Projectile| p.vel.normalize().angle_between(aim);
        assert!(angle(&v[1]) < 1e-3, "middle dart off the aim");
        assert!((angle(&v[0]) - angle(&v[2])).abs() < 1e-3);
        assert!((angle(&v[0]) - t.alt_spread_deg.to_radians()).abs() < 0.01);
    }

    #[test]
    fn mortar_bounces_then_fuses() {
        // Aimed down at open floor ahead.
        let arena = blockout();
        let (t, m) = mech(MechClass::C, [0.0, 0.0, 45.0], 0.0, -0.6);
        let (at, path) = fly_out(&arena, &t, volley(&t, &m, 0, 1)[0]);
        assert!(path.windows(2).any(|w| w[0].vel.y < 0.0 && w[1].vel.y > 0.0), "never bounced");
        assert!(path.iter().all(|p| p.pos.y >= 0.0) && at.y >= 0.0, "went under the floor");
        let ticks = path.len() as f32;
        assert!((ticks * DT - t.alt_fuse).abs() < DT, "burst after {} s", ticks * DT);
    }

    #[test]
    fn splash_falls_off_and_walls_block_it() {
        let arena = blockout();
        let (t, _) = mech(MechClass::B, [0.0; 3], 0.0, 0.0);
        let (tm, target) = mech(MechClass::B, [0.0, 0.0, 30.0], 0.0, 0.0);
        let r = mech_capsule(&tm).radius;
        let at = |surface: f32| Vector::new(r + surface, 2.5, 30.0);
        assert!((splash(&arena, &t, at(0.0), &tm, &target) - t.alt_damage).abs() < 1e-3);
        let edge = splash(&arena, &t, at(t.alt_radius - 1e-3), &tm, &target);
        assert!((edge - EDGE_DAMAGE * t.alt_damage).abs() < 0.01, "edge damage {edge}");
        assert_eq!(splash(&arena, &t, at(t.alt_radius + 0.1), &tm, &target), 0.0);

        // In range, but the east wall (x 50 to 51) stands between.
        let (tm, inside) = mech(MechClass::B, [48.0, 0.0, 0.0], 0.0, 0.0);
        assert_eq!(splash(&arena, &t, Vector::new(51.5, 2.5, 0.0), &tm, &inside), 0.0);
    }
}
