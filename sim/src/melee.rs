//! Melee secondaries (`alt_melee` > 0, the reach in m): the rocket punch, a booster-driven ram.
//! Held, its booster spools up over `alt_charge_time`; let go, it strikes instead of launching
//! anything, hitting harder the more it wound (`alt_charge_damage` times at full), and the booster
//! carries the mech up to `alt_lunge` as far: onto an enemy ahead in that range, else straight
//! along its aim, so it's a charge too, and a way up. A hit throws the victim along the striker's facing, up off its feet:
//! an impulse (`alt_impulse`) over the victim's mass, so a Light flies more than twice as far as a
//! Heavy, and the striker doesn't recoil. It rides that throw as it would a jump pad's arc, until
//! it lands, hovers or dodges out, and slamming into a wall on the way hurts it.
//!
//! The lunge is the striker's own move, predicted against enemies where it last saw them (as it
//! predicts being blocked by them); strikes, throws and slams are the server's (`Game::strike`).

use rapier3d::prelude::{Ray, Rotation};

use crate::ability::{self, Ability};
use crate::{Arena, Mech, Tuning, Vector};

/// Seconds a strike can land in after its release, or as long as its lunge, if longer.
pub const STRIKE: f32 = 0.35;
/// Seconds the guns stay locked after a strike, hit or miss.
pub const RECOVERY: f32 = 0.5;
/// Seconds after a throw that a second one throws half as far (so a victim can't be juggled), and
/// that hitting a wall while still in the air counts as a slam.
pub const KNOCK_SECONDS: f32 = 1.5;
/// A slam hurts `SLAM_DAMAGE` hp for each m/s it stops above `SLAM_SPEED`.
pub const SLAM_SPEED: f32 = 6.0;
pub const SLAM_DAMAGE: f32 = 1.5;
/// How far off the facing (degrees) a lunge goes for an enemy, and a strike reaches.
const LUNGE_CONE: f32 = 15.0;
const REACH_CONE: f32 = 50.0;
/// A throw's angle above the horizontal (radians), which lifts the victim off its feet.
const LIFT: f32 = 0.35;

/// Where `m` faces, level.
pub fn facing(m: &Mech) -> Vector {
    Rotation::from_rotation_y(m.yaw) * Vector::NEG_Z
}

/// How far apart `m`'s and `f`'s hulls are on the ground plane, and how far off `m`'s facing `f`
/// is (radians), if they're level with each other give or take `slack` and `m` can see `f`.
fn sized_up(arena: &Arena, t: &Tuning, m: &Mech, tf: &Tuning, f: &Mech, slack: f32) -> Option<(f32, f32)> {
    let d = Vector::new(f.pos.x - m.pos.x, 0.0, f.pos.z - m.pos.z);
    let level = m.pos.y < f.pos.y + tf.mech_height + slack && f.pos.y < m.pos.y + t.mech_height + slack;
    let (eye, chest) = (m.pos + Vector::Y * t.eye_height, f.pos + Vector::Y * (tf.mech_height * 0.5));
    let to = chest - eye;
    let seen = || arena.cast_ray(&Ray::new(eye, to / to.length()), to.length()).is_none();
    (f.health > 0.0 && level && seen()).then(|| (d.length() - t.mech_radius - tf.mech_radius, facing(m).angle_between(d)))
}

/// After `m`'s tick: a strike just let go fires the booster, carrying the mech `alt_lunge` times
/// its wind-up. It lunges at whichever of `foes` (not camouflaged) is nearest its facing within
/// that and the lunge cone, in sight, or with none there flies that far straight along the aim,
/// up or down (not down into the ground it stands on). The dash (up to `alt_lunge_speed`) is one
/// a dodge's drag eases off as it covers the distance, gravity held off while the booster burns
/// (`step_mech`), so it goes in a straight line and a miss doesn't carry it on past; unwound, it
/// strikes where it stands.
pub fn lunge<'a>(arena: &Arena, t: &Tuning, m: &mut Mech, foes: impl IntoIterator<Item = (&'a Tuning, &'a Mech)>) {
    if !m.launched || t.alt_melee <= 0.0 {
        return;
    }
    let range = t.alt_lunge * m.strike_charge;
    let near = foes.into_iter().filter(|(_, f)| !ability::on(f, Ability::Cloak)).filter_map(|(tf, f)| {
        let (gap, angle) = sized_up(arena, t, m, tf, f, t.alt_melee)?;
        (gap <= range && angle <= LUNGE_CONE.to_radians()).then_some((f.pos, gap, angle))
    });
    let (dir, far) = match near.min_by(|a, b| a.2.total_cmp(&b.2)) {
        Some((at, gap, _)) => (Vector::new(at.x - m.pos.x, 0.0, at.z - m.pos.z).normalize_or(facing(m)), gap),
        None => {
            let aim = Rotation::from_rotation_y(m.yaw) * Rotation::from_rotation_x(m.pitch) * Vector::NEG_Z;
            let aim = if m.grounded { Vector::new(aim.x, aim.y.max(0.0), aim.z) } else { aim };
            (aim.normalize_or(facing(m)), range * aim.length())
        }
    };
    if far <= 0.0 {
        return;
    }
    let drag = t.dodge_drag.max(1.0);
    let speed = (2.0 * drag * far).sqrt().min(t.alt_lunge_speed);
    m.vel = dir * speed;
    if dir.y > 0.0 {
        m.grounded = false;
    }
    m.dodge_time = speed / drag;
    m.strike = m.strike.max(m.dodge_time);
    m.pad_arc = false;
}

/// How hard `m`'s booster burns now (0-1): the wind-up its strike flies on, while its dash lasts.
pub fn burn(m: &Mech) -> f32 {
    if m.strike > 0.0 && m.dodge_time > 0.0 { m.strike_charge.max(0.05) } else { 0.0 }
}

/// Whether striking mech `m` reaches `f`: in front, level, in sight, and within `alt_melee` of its hull.
pub fn reaches(arena: &Arena, t: &Tuning, m: &Mech, tf: &Tuning, f: &Mech) -> Option<f32> {
    let (gap, angle) = sized_up(arena, t, m, tf, f, t.alt_melee)?;
    (gap <= t.alt_melee && angle <= REACH_CONE.to_radians()).then_some(gap)
}

/// How much harder than uncharged a strike wound `charge` (0-1) hits and throws.
pub fn power(t: &Tuning, charge: f32) -> f32 {
    1.0 + (t.alt_charge_damage - 1.0) * charge
}

/// The speed a strike from `t` wound `charge` throws a mech of mass `mass` at.
pub fn throw_speed(t: &Tuning, charge: f32, mass: f32) -> f32 {
    t.alt_impulse * power(t, charge) / mass.max(1.0)
}

/// Throws `m` along `dir` (level) at `speed`, lifted off its feet onto a pad's arc.
pub fn throw(m: &mut Mech, dir: Vector, speed: f32) {
    let up = (speed * LIFT.sin()).max(m.vel.y);
    m.vel = dir * (speed * LIFT.cos()) + Vector::Y * up;
    (m.pad_arc, m.grounded) = (true, false);
}
