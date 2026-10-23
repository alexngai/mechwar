//! Primary weapon: the spread cone (base plus bloom), pellets seeded per shot, damage falloff
//! with range, and projectile primaries (`shot_speed > 0`) flown by `projectile.rs`.
//! Deterministic from (mech state, input seq), so the client predicts exactly what the server fires.

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Pose, Ray, Rotation};

use crate::projectile::Projectile;
use crate::{Arena, Mech, Tuning, Vector, aim_ray, hit_shape};

/// Where a held beam (`alt_beam`) stops, from the eye along the aim: the first wall, or the
/// first of `mechs` (id, tuning, mech) in its way, whose id comes back too.
pub fn beam<'a>(arena: &Arena, t: &Tuning, m: &Mech, mechs: impl IntoIterator<Item = (u8, &'a Tuning, &'a Mech)>) -> (Vector, Option<u8>) {
    let ray = aim_ray(t, m);
    let (mut best, mut hit) = (arena.cast_ray(&ray, t.alt_beam).unwrap_or(t.alt_beam), None);
    for (id, tq, q) in mechs {
        let (shape, center) = hit_shape(tq, q);
        if let Some(toi) = shape.cast_ray(&Pose::from_translation(center), &ray, best, true) {
            (best, hit) = (toi, Some(id));
        }
    }
    (ray.point_at(best), hit)
}

/// The rays this tick's shot fires from the eye: `pellets` of them, each the aim offset in a cone
/// of `spread_deg + m.bloom` (`in_cone`).
/// ponytail: the client knows the seed, so a cheat could counter-aim the spread; seed from a
/// server secret if that matters.
pub fn pellets(t: &Tuning, m: &Mech, seq: u32) -> Vec<Ray> {
    let eye = aim_ray(t, m).origin;
    let cone = (t.spread_deg + m.bloom).to_radians();
    (0..t.pellets.max(1.0) as u32).map(|n| Ray::new(eye, in_cone(m.yaw, m.pitch, cone, seq, n))).collect()
}

/// Pellet `n` of shot `seq`: the aim (`yaw`, `pitch`) offset by a seeded point in a cone `cone`
/// radians wide. Uses only + * sqrt and glam's (libm) rotations, so WASM and native agree to the bit.
pub fn in_cone(yaw: f32, pitch: f32, cone: f32, seq: u32, n: u32) -> Vector {
    let mut rng = u64::from(seq) << 32 | u64::from(n);
    let (x, y) = loop {
        let (x, y) = (unit(&mut rng) * 2.0 - 1.0, unit(&mut rng) * 2.0 - 1.0);
        if x * x + y * y <= 1.0 {
            break (x, y);
        }
    };
    // Tangent-plane offset: within 1% of the cone angle up to 10 degrees.
    (Rotation::from_rotation_y(yaw) * Rotation::from_rotation_x(pitch) * Vector::new(x * cone, y * cone, -1.0)).normalize()
}

/// Primary projectiles for this tick's shot, one per pellet ray, flying faster the more it was
/// charged (and bursting harder and wider: `projectile::tuning_for`).
pub fn volley(t: &Tuning, m: &Mech, owner: u8, seq: u32) -> Vec<Projectile> {
    let speed = t.shot_speed * (1.0 + (t.charge_speed - 1.0) * m.shot_charge);
    pellets(t, m, seq)
        .iter()
        .enumerate()
        .map(|(n, ray)| Projectile {
            owner, seq, n: n as u8, primary: true, class: m.class, loadout: m.loadout, charge: m.shot_charge, target: 0,
            pos: ray.origin, vel: ray.dir * speed, age: 0.0,
        })
        .collect()
}

/// Damage (and heat) multiplier of a shot fired with `charge` (0-1).
pub fn power(t: &Tuning, charge: f32) -> f32 {
    1.0 + (t.charge_damage - 1.0) * charge
}

/// Damage multiplier for a hitscan hit `dist` away: 1 up to `falloff_start`, then linear down to
/// `falloff_floor` at `falloff_end` and beyond.
pub fn falloff(t: &Tuning, dist: f32) -> f32 {
    let span = t.falloff_end - t.falloff_start;
    let x = if span > 0.0 { ((dist - t.falloff_start) / span).clamp(0.0, 1.0) } else { f32::from(dist > t.falloff_start) };
    1.0 - (1.0 - t.falloff_floor) * x
}

/// Shell `n` of shot `seq`'s share of a speed jitter, uniform in [-1, 1), seeded apart from its
/// spread (`in_cone`).
pub fn jitter(seq: u32, n: u32) -> f32 {
    let mut rng = (u64::from(seq) << 32 | u64::from(n)) ^ 0x5EED_5EED_5EED_5EED;
    unit(&mut rng) * 2.0 - 1.0
}

/// splitmix64 step, uniform in [0, 1).
fn unit(state: &mut u64) -> f32 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MechClass, spawn_mech};

    #[test]
    fn pellets_stay_in_the_cone_and_vary_by_seq() {
        let t = Tuning::default().for_class(MechClass::C);
        let m = Mech { yaw: 0.4, pitch: -0.2, ..spawn_mech(&t, Vector::ZERO) };
        let aim = aim_ray(&t, &m).dir;
        let a = pellets(&t, &m, 7);
        assert_eq!(a.len(), t.pellets as usize);
        assert!(a.iter().all(|r| r.dir.angle_between(aim) <= t.spread_deg.to_radians() * 1.01));
        assert!(a.windows(2).all(|w| w[0].dir != w[1].dir), "pellets overlap");
        assert_ne!(a[0].dir, pellets(&t, &m, 8)[0].dir, "seq doesn't reseed");
        assert_eq!(a[0].dir, pellets(&t, &m, 7)[0].dir);
    }

    #[test]
    fn falloff_near_mid_far() {
        let t = Tuning::default();
        assert_eq!(falloff(&t, t.falloff_start - 1.0), 1.0);
        let mid = falloff(&t, (t.falloff_start + t.falloff_end) * 0.5);
        assert!((mid - (1.0 + t.falloff_floor) * 0.5).abs() < 1e-5, "mid {mid}");
        assert_eq!(falloff(&t, t.falloff_end + 50.0), t.falloff_floor);
    }
}
