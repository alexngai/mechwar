//! Primary weapon: the spread cone (base plus bloom), pellets seeded per shot, damage falloff
//! with range, and projectile primaries (`shot_speed > 0`) flown by `projectile.rs`.
//! Deterministic from (mech state, input seq), so the client predicts exactly what the server fires.

use rapier3d::prelude::{Ray, Rotation};

use crate::projectile::Projectile;
use crate::{Mech, Tuning, Vector, aim_ray};

/// The rays this tick's shot fires from the eye: `pellets` of them, each the aim offset by a
/// seeded point in a cone of `spread_deg + m.bloom`. Uses only + * sqrt and glam's (libm)
/// rotations, so WASM and native agree to the bit.
/// ponytail: the client knows the seed, so a cheat could counter-aim the spread; seed from a
/// server secret if that matters.
pub fn pellets(t: &Tuning, m: &Mech, seq: u32) -> Vec<Ray> {
    let eye = aim_ray(t, m).origin;
    let rot = Rotation::from_rotation_y(m.yaw) * Rotation::from_rotation_x(m.pitch);
    // Tangent-plane offset: within 1% of the cone angle up to 10 degrees.
    let cone = (t.spread_deg + m.bloom).to_radians();
    (0..t.pellets.max(1.0) as u32)
        .map(|n| {
            let mut rng = u64::from(seq) << 32 | u64::from(n);
            let (x, y) = loop {
                let (x, y) = (unit(&mut rng) * 2.0 - 1.0, unit(&mut rng) * 2.0 - 1.0);
                if x * x + y * y <= 1.0 {
                    break (x, y);
                }
            };
            Ray::new(eye, (rot * Vector::new(x * cone, y * cone, -1.0)).normalize())
        })
        .collect()
}

/// Primary projectiles for this tick's shot, one per pellet ray.
pub fn volley(t: &Tuning, m: &Mech, owner: u8, seq: u32) -> Vec<Projectile> {
    pellets(t, m, seq)
        .iter()
        .enumerate()
        .map(|(n, ray)| Projectile { owner, seq, n: n as u8, primary: true, class: m.class, loadout: m.loadout, pos: ray.origin, vel: ray.dir * t.shot_speed, age: 0.0 })
        .collect()
}

/// Damage multiplier for a hitscan hit `dist` away: 1 up to `falloff_start`, then linear down to
/// `falloff_floor` at `falloff_end` and beyond.
pub fn falloff(t: &Tuning, dist: f32) -> f32 {
    let span = t.falloff_end - t.falloff_start;
    let x = if span > 0.0 { ((dist - t.falloff_start) / span).clamp(0.0, 1.0) } else { f32::from(dist > t.falloff_start) };
    1.0 - (1.0 - t.falloff_floor) * x
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
