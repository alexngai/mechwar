//! Primary weapon: the spread cone (base plus bloom), pellets seeded per shot, damage falloff
//! with range, and projectile primaries (`shot_speed > 0`) flown by `projectile.rs`.
//! Deterministic from (mech state, input seq), so the client predicts exactly what the server fires.

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Pose, Ray, Rotation};

use crate::ability::{self, Ability};
use crate::projectile::Projectile;
use crate::{Arena, Mech, Tuning, Vector, aim_ray, hit_shape};

/// A held beam bends to a mech this far off the aim (the cosine of the cone's half-angle): wide
/// enough to keep a teammate mending while the gun's on an enemy.
pub const BEAM_SNAP_COS: f32 = 0.866_025; // 30 degrees

/// Where a held beam (`alt_beam`) stops, and on which of `mechs` (id, tuning, mech), if any. It
/// holds on the mech it's on (`m.beam_on`) while that's within `BEAM_SNAP_COS` of the aim, in
/// reach and clear view, and not cloaked. Otherwise it runs from the eye along the aim to the first
/// wall or mech, or, missing them all, bends to the mech nearest the aim that's in the cone so.
pub fn beam<'a>(arena: &Arena, t: &Tuning, m: &Mech, mechs: impl IntoIterator<Item = (u8, &'a Tuning, &'a Mech)>) -> (Vector, Option<u8>) {
    let ray = aim_ray(t, m);
    let (mut best, mut hit) = (arena.cast_ray(&ray, t.alt_beam).unwrap_or(t.alt_beam), None);
    let mut snap: Option<((bool, f32), Vector, u8)> = None; // ((held, cosine off the aim), end, id)
    for (id, tq, q) in mechs {
        let (shape, center) = hit_shape(tq, q);
        let pose = Pose::from_translation(center);
        if let Some(toi) = shape.cast_ray(&pose, &ray, best, true) {
            (best, hit) = (toi, Some(id));
        }
        let to = (center - ray.origin).normalize_or_zero();
        let rank = (m.beam_on == Some(id), to.dot(ray.dir));
        if rank.1 > BEAM_SNAP_COS && snap.is_none_or(|s| rank > s.0) && !ability::on(q, Ability::Cloak) {
            let bent = Ray::new(ray.origin, to);
            if let Some(toi) = shape.cast_ray(&pose, &bent, t.alt_beam, true)
                && arena.cast_ray(&bent, toi).is_none()
            {
                snap = Some((rank, bent.point_at(toi), id));
            }
        }
    }
    match snap {
        Some(((held, _), end, id)) if hit.is_none() || held && hit != Some(id) => (end, Some(id)),
        _ => (ray.point_at(best), hit),
    }
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
    let speed = speed(t, m.shot_charge);
    pellets(t, m, seq)
        .iter()
        .enumerate()
        .map(|(n, ray)| Projectile {
            owner, seq, n: n as u8, primary: true, class: m.class, loadout: m.loadout, charge: m.shot_charge, boosted: m.boosted,
            target: m.seek, pos: ray.origin, vel: ray.dir * speed, age: 0.0,
        })
        .collect()
}

/// How fast a primary projectile fired with `charge` (0-1) flies.
pub fn speed(t: &Tuning, charge: f32) -> f32 {
    t.shot_speed * (1.0 + (t.charge_speed - 1.0) * charge)
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
    use crate::{Loadout, Map, MechClass, spawn_mech};

    #[test]
    fn beams_bend_to_a_mech_just_off_the_aim() {
        let arena = Arena::new(&Map::load(Map::index("blockout").unwrap()));
        let t = Tuning { alt_beam: 28.0, ..Tuning::default() };
        // A mech 20 m ahead, aimed at, then a little and well off to the side.
        let me = spawn_mech(&t, Vector::new(0.0, 0.1, 40.0));
        let mut other = spawn_mech(&t, Vector::new(0.0, 0.1, 20.0));
        let (yaw, pitch) = crate::bot::look_at(me.pos + Vector::Y * t.eye_height, hit_shape(&t, &other).1);
        let at = |other: &Mech, off: f32| beam(&arena, &t, &Mech { yaw: yaw + off.to_radians(), pitch, ..me }, [(1, &t, other)]).1;
        assert_eq!((at(&other, 0.0), at(&other, 6.0), at(&other, 25.0), at(&other, 35.0)), (Some(1), Some(1), Some(1), None));
        // Not to one cloaked.
        let cloak = (0u8..).find(|&ability| Ability::of(Loadout { ability, ..Loadout::default() }) == Ability::Cloak).unwrap();
        (other.loadout.ability, other.ability_time) = (cloak, 1.0);
        assert_eq!(at(&other, 6.0), None, "found a cloaked mech");
    }

    #[test]
    fn beams_hold_on_the_mech_they_are_on() {
        let arena = Arena::new(&Map::load(Map::index("blockout").unwrap()));
        let t = Tuning { alt_beam: 28.0, ..Tuning::default() };
        // A mate 20 m ahead, and an enemy 15 m off 20 degrees to the right of it.
        let me = spawn_mech(&t, Vector::new(0.0, 0.1, 40.0));
        let mate = spawn_mech(&t, Vector::new(0.0, 0.1, 20.0));
        let eye = me.pos + Vector::Y * t.eye_height;
        let (yaw, pitch) = crate::bot::look_at(eye, hit_shape(&t, &mate).1);
        let enemy = spawn_mech(&t, me.pos + Vector::new(-(yaw - 20f32.to_radians()).sin(), 0.0, -(yaw - 20f32.to_radians()).cos()) * 15.0);
        let (eyaw, epitch) = crate::bot::look_at(eye, hit_shape(&t, &enemy).1);
        let on = |beam_on, yaw, pitch| beam(&arena, &t, &Mech { yaw, pitch, beam_on, ..me }, [(1, &t, &mate), (2, &t, &enemy)]).1;
        // Aimed at the enemy, the beam's on it, unless it's on the mate already: then it stays.
        assert_eq!(on(None, yaw, pitch), Some(1));
        assert_eq!(on(None, eyaw, epitch), Some(2));
        assert_eq!(on(Some(1), eyaw, epitch), Some(1), "let go of the mate");
        // Until the mate's out of the cone.
        assert_eq!(on(Some(1), yaw + 40f32.to_radians(), pitch), None);
    }

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
