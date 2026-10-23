//! Projectiles, for the secondary and for projectile primaries (`weapon.rs`): launched from the eye, flown one tick at a time against the
//! arena and whatever mechs the caller supplies, bursting with splash damage. Pure and
//! deterministic, so the server, the predicting client and remote replays fly identical paths
//! through the arena; only mech contacts can differ between them.

use std::borrow::Cow;

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Capsule, Pose, Ray, Rotation};
use serde::{Deserialize, Serialize};

use crate::item::Item;
use crate::{Arena, DT, Loadout, Mech, MechClass, Tuning, Vector, aim_ray, hit_shape, weapon};

/// Added to mech capsules for contact: projectiles aren't points.
pub const PROJECTILE_RADIUS: f32 = 0.25;
/// Splash at the radius edge, as a fraction of full damage.
const EDGE_DAMAGE: f32 = 0.3;
/// Bursts sit this far back from the surface they hit, so splash rays start outside it.
const STANDOFF: f32 = 0.1;
/// Seconds a secondary shell flies before its owner's next press can burst it, so the click that
/// fired it can't burst it at the muzzle.
pub const ARM: f32 = 0.2;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Projectile {
    pub owner: u8,
    /// The owner's input that launched it, its index in the volley, and which weapon fired it:
    /// with `owner`, its id.
    pub seq: u32,
    pub n: u8,
    pub primary: bool,
    /// The owner's class and loadout at launch, which pick the tuning it flies with.
    pub class: MechClass,
    pub loadout: Loadout,
    /// The shot's charge, 0-1 (see `tuning_for`).
    pub charge: f32,
    /// The player a homing shell is locked on (their id + 1; 0 for none): see `home`.
    pub target: u8,
    pub pos: Vector,
    pub vel: Vector,
    pub age: f32,
}

impl Projectile {
    pub fn id(&self) -> Id {
        (self.owner, self.seq, self.n, self.primary)
    }
}

/// (owner, seq, n, primary).
pub type Id = (u8, u32, u8, bool);

/// What a projectile flies and bursts with: the secondary's `alt_*` values, or the primary's
/// `shot_*` ones (no bounce, bursting at `weapon_range`).
struct Ballistics {
    gravity: f32,
    bounce: f32,
    fuse: f32,
    damage: f32,
    radius: f32,
    /// Mines stick where they land, and burst for an enemy within `trigger`.
    stick: bool,
    trigger: f32,
}

fn ballistics(t: &Tuning, primary: bool) -> Ballistics {
    if primary {
        let fuse = t.weapon_range / t.shot_speed.max(1.0);
        Ballistics { gravity: t.shot_gravity, bounce: 0.0, fuse, damage: t.shot_damage, radius: t.shot_radius, stick: false, trigger: 0.0 }
    } else {
        Ballistics {
            gravity: t.alt_gravity, bounce: t.alt_bounce, fuse: t.alt_fuse, damage: t.alt_damage, radius: t.alt_radius,
            stick: t.alt_stick > 0.5, trigger: t.alt_trigger,
        }
    }
}

/// The volley `m` launched this tick: from its eye along its aim, pitched up by `alt_loft_deg`,
/// as a level fan of `alt_count` spaced `alt_spread_deg` apart, or with `alt_cone` 1 a cone
/// `alt_spread_deg` wide that each shell lands in at random (seeded, like a primary's pellets);
/// each flies at `alt_speed`, give or take `alt_speed_jitter` of it (seeded too).
pub fn volley(t: &Tuning, m: &Mech, owner: u8, seq: u32) -> Vec<Projectile> {
    let eye = aim_ray(t, m).origin;
    let count = t.alt_count.max(1.0) as u8;
    let pitch = m.pitch + t.alt_loft_deg.to_radians();
    (0..count)
        .map(|n| {
            let dir = if t.alt_cone > 0.0 {
                weapon::in_cone(m.yaw, pitch, t.alt_spread_deg.to_radians(), seq, u32::from(n))
            } else {
                let fan = (f32::from(n) - f32::from(count - 1) * 0.5) * t.alt_spread_deg.to_radians();
                Rotation::from_rotation_y(m.yaw + fan) * Rotation::from_rotation_x(pitch) * Vector::NEG_Z
            };
            let target = if t.alt_lock_time > 0.0 && m.lock_time >= t.alt_lock_time { m.lock } else { 0 };
            let speed = t.alt_speed * (1.0 + t.alt_speed_jitter * weapon::jitter(seq, u32::from(n)));
            Projectile { owner, seq, n, primary: false, class: m.class, loadout: m.loadout, charge: m.alt_charge, target, pos: eye, vel: dir * speed, age: 0.0 }
        })
        .collect()
}

/// Thrown items carry these volley indices, clear of any secondary volley's, so an item and a
/// volley launched on the same input keep distinct ids: grenades, limpets and smoke.
pub const GRENADE: u8 = u8::MAX;
pub const LIMPET: u8 = u8::MAX - 1;
pub const SMOKE: u8 = u8::MAX - 2;
/// A rocket turret's rockets (`deploy.rs`) carry this volley index, below the items'.
pub const TURRET: u8 = u8::MAX - 3;
/// A splitting shell's bomblets carry volley indices from here up (below the turret's).
pub const BOMBLET: u8 = 100;
/// Seconds a bomblet falls before bursting, if it hasn't hit anything.
const BOMBLET_FUSE: f32 = 2.0;

/// The thrown item `p` is, if it's one.
pub fn item(p: &Projectile) -> Option<Item> {
    match p.n {
        _ if p.primary => None,
        GRENADE => Some(Item::Grenade),
        LIMPET => Some(Item::Limpet),
        SMOKE => Some(Item::Smoke),
        _ => None,
    }
}

/// The offensive item `m` threw this tick: a one-shell volley on the item's ballistics.
pub fn thrown(t: &Tuning, m: &Mech, owner: u8, seq: u32) -> Projectile {
    let item = Item::of(m.loadout, true);
    let n = match item {
        Item::Limpet => LIMPET,
        Item::Smoke => SMOKE,
        _ => GRENADE,
    };
    Projectile { n, charge: 0.0, target: 0, ..volley(&t.thrown(item), m, owner, seq)[0] }
}

/// The tuning projectile `p` flies and bursts with, given its owner's tuning `t`: thrown items
/// swap their ballistics into the secondary's fields, and a charged shell (a primary's charge,
/// or a heat-fed secondary's) hits harder and wider.
pub fn tuning_for<'a>(t: &'a Tuning, p: &Projectile) -> Cow<'a, Tuning> {
    if let Some(item) = item(p) {
        return Cow::Owned(t.thrown(item));
    }
    if p.n == TURRET && !p.primary {
        return Cow::Borrowed(t);
    }
    if p.n >= BOMBLET && !p.primary {
        let mut b = t.clone();
        (b.alt_damage, b.alt_radius, b.alt_fuse) = (t.alt_split_damage, t.alt_split_radius, BOMBLET_FUSE);
        (b.alt_bounce, b.alt_stick, b.alt_trigger, b.alt_split, b.alt_turn) = (0.0, 0.0, 0.0, 0.0, 0.0);
        return Cow::Owned(b);
    }
    if p.charge <= 0.0 {
        return Cow::Borrowed(t);
    }
    let mut charged = t.clone();
    if p.primary {
        charged.shot_damage *= weapon::power(t, p.charge);
        charged.shot_radius *= 1.0 + (t.charge_radius - 1.0) * p.charge;
    } else {
        charged.alt_damage *= 1.0 + (t.alt_charge_damage - 1.0) * p.charge;
        charged.alt_radius *= 1.0 + (t.alt_charge_radius - 1.0) * p.charge;
    }
    Cow::Owned(charged)
}

/// How wide projectile `p`'s burst spreads, given its owner's tuning `t`.
pub fn radius(t: &Tuning, p: &Projectile) -> f32 {
    ballistics(&tuning_for(t, p), p.primary).radius
}

/// Whether `p` is a secondary shell (not an item or primary fire) its owner can burst yet.
pub fn armed(p: &Projectile) -> bool {
    !p.primary && p.n < BOMBLET && p.age >= ARM - DT * 0.5
}

/// The bomblets shell `p` (tuned by its owner's `t`) scatters bursting at `at`: none unless its
/// weapon splits and it burst in the air, by its fuse or a press rather than on contact.
pub fn split(t: &Tuning, p: &Projectile, at: Vector) -> Vec<Projectile> {
    let fused = p.age >= ballistics(&tuning_for(t, p), p.primary).fuse - DT * 0.5;
    if p.primary || p.n >= BOMBLET || t.alt_split < 1.0 || !fused {
        return Vec::new();
    }
    let count = t.alt_split.min(20.0) as u8;
    (0..count)
        .map(|k| {
            let out = Rotation::from_rotation_y(std::f32::consts::TAU * f32::from(k) / f32::from(count)) * Vector::X * t.alt_split_speed;
            let vel = if p.vel.is_finite() { p.vel * 0.2 } else { Vector::ZERO } + out + Vector::NEG_Y * 2.0;
            Projectile { n: BOMBLET + k, charge: 0.0, target: 0, pos: at, vel, age: 0.0, ..*p }
        })
        .collect()
}

/// Before `owner` launches a volley tuned by `t`, bursts its oldest live secondary shells beyond
/// `alt_max` (as `detonate` does), so a mine layer keeps at most that many down.
pub fn cap<'a>(t: &Tuning, owner: u8, shells: impl IntoIterator<Item = &'a mut Projectile>) {
    let mut own: Vec<_> = shells.into_iter().filter(|p| p.owner == owner && !p.primary && p.n < BOMBLET && p.age.is_finite()).collect();
    let excess = (own.len() + t.alt_count.max(1.0) as usize).saturating_sub(t.alt_max.max(1.0) as usize);
    for p in own.iter_mut().take(excess) {
        p.age = f32::INFINITY;
    }
}

/// Lock-on, after `m`'s tick (`t.alt_lock_time` > 0): pressing `aux` picks the enemy nearest
/// the aim within the cone, in sight and in reach (of `chests`, by player id). Kept there for
/// `alt_lock_time` it locks, and the lock then holds `alt_lock_hold` wherever the mech looks, so
/// a volley can curve onto it from an angle. Losing it before then, its death, or firing drops it.
pub fn track(arena: &Arena, t: &Tuning, m: &mut Mech, chests: &[(u8, Vector)]) {
    if t.alt_lock_time <= 0.0 || m.health <= 0.0 || m.launched {
        (m.lock, m.lock_time) = (0, 0.0);
        return;
    }
    let ray = aim_ray(t, m);
    let (reach, cone) = (t.alt_speed * t.alt_fuse, t.alt_lock_cone.to_radians());
    // How far off the aim `chest` is, if it's in the cone, in sight and in reach.
    let sighted = |chest: Vector| {
        let to = chest - ray.origin;
        let (dist, angle) = (to.length(), ray.dir.angle_between(to));
        let clear = || arena.cast_ray(&Ray::new(ray.origin, to / dist), dist).is_none();
        (dist <= reach && angle <= cone && clear()).then_some(angle)
    };
    if m.aux_pressed {
        let nearest = chests.iter().filter_map(|&(id, chest)| Some((id, sighted(chest)?))).min_by(|a, b| a.1.total_cmp(&b.1));
        (m.lock, m.lock_time) = (nearest.map_or(0, |(id, _)| id + 1), 0.0);
        return;
    }
    let chest = chests.iter().find(|(id, _)| m.lock == id + 1).map(|&(_, chest)| chest);
    let made = m.lock_time >= t.alt_lock_time;
    match chest {
        Some(chest) if (made || sighted(chest).is_some()) && m.lock_time < t.alt_lock_time + t.alt_lock_hold => m.lock_time += DT,
        _ => (m.lock, m.lock_time) = (0, 0.0),
    }
}

/// Turns homing shell `p` (tuned by `t`) toward `goal`, by at most this tick's `alt_turn`, once
/// it's flown `alt_home_delay`.
pub fn home(t: &Tuning, p: &mut Projectile, goal: Vector) {
    let (speed, want) = (p.vel.length(), (goal - p.pos).normalize_or_zero());
    if p.primary || t.alt_turn <= 0.0 || p.age < t.alt_home_delay || speed < 1e-3 || want == Vector::ZERO {
        return;
    }
    let have = p.vel / speed;
    let axis = have.cross(want).normalize_or_zero();
    if axis != Vector::ZERO {
        p.vel = Rotation::from_axis_angle(axis, have.angle_between(want).min(t.alt_turn.to_radians() * DT)) * have * speed;
    }
}

/// Whether mine `p` (tuned by `t`), stuck and armed, has any of `mechs` within its trigger reach.
pub fn triggered<'a>(t: &Tuning, p: &Projectile, mechs: impl IntoIterator<Item = (&'a Tuning, &'a Mech)>) -> bool {
    let b = ballistics(t, p.primary);
    if b.trigger <= 0.0 || p.vel != Vector::ZERO || p.age < ARM {
        return false;
    }
    mechs.into_iter().any(|(tm, m)| {
        let (c, center) = hit_shape(tm, m);
        let h = c.half_height();
        let axis = Vector::new(center.x, p.pos.y.clamp(center.y - h, center.y + h), center.z);
        axis.distance(p.pos) - c.radius <= b.trigger
    })
}

/// A fresh secondary press by `owner` (`Mech::alt_pressed`): each of its armed shells bursts at
/// the end of its next tick of flight, as if its fuse had run out.
pub fn detonate<'a>(owner: u8, shells: impl IntoIterator<Item = &'a mut Projectile>) {
    for p in shells.into_iter().filter(|p| p.owner == owner && armed(p)) {
        p.age = f32::INFINITY;
    }
}

/// Owner `owner` set off its limpets (`Mech::sprung`): each bursts at the end of its next tick.
pub fn set_off<'a>(owner: u8, shells: impl IntoIterator<Item = &'a mut Projectile>) {
    for p in shells.into_iter().filter(|p| p.owner == owner && item(p) == Some(Item::Limpet)) {
        p.age = f32::INFINITY;
    }
}

/// Advances `p` one tick: gravity, then this tick's path against the arena and `hit_mech`, which
/// gives how far along a ray (up to a limit) the nearest mech stops it. Off the arena it sticks if
/// it's a mine (and stays put from then on), bounces if its weapon bounces, else bursts; it always
/// bursts on a mech or once its fuse runs out. Returns where it burst.
pub fn fly(arena: &Arena, t: &Tuning, p: &mut Projectile, mut hit_mech: impl FnMut(&Ray, f32) -> Option<f32>) -> Option<Vector> {
    let b = ballistics(t, p.primary);
    p.age += DT;
    if b.stick && p.vel == Vector::ZERO {
        return (p.age >= b.fuse - DT * 0.5).then_some(p.pos);
    }
    p.vel.y -= b.gravity * DT;
    let step = p.vel * DT;
    let len = step.length();
    if len > 1e-6 {
        let ray = Ray::new(p.pos, step / len);
        let wall = arena.cast_ray_normal(&ray, len);
        if let Some(toi) = hit_mech(&ray, wall.map_or(len, |(toi, _)| toi)) {
            return Some(ray.point_at((toi - STANDOFF).max(0.0)));
        }
        match wall {
            Some((toi, normal)) if b.stick => {
                p.pos = ray.point_at(toi) + normal * STANDOFF;
                p.vel = Vector::ZERO;
            }
            Some((toi, _)) if b.bounce <= 0.0 => return Some(ray.point_at((toi - STANDOFF).max(0.0))),
            Some((toi, normal)) => {
                // The rest of this tick's travel is dropped; the shell leaves the surface next tick.
                p.pos = ray.point_at(toi) + normal * STANDOFF;
                p.vel = (p.vel - normal * (2.0 * p.vel.dot(normal))) * b.bounce;
            }
            None => p.pos += step,
        }
    }
    // Half a tick of slack so the fuse lands on a whole tick despite float sums.
    (p.age >= b.fuse - DT * 0.5).then_some(p.pos)
}

/// How far along `ray`, within `max`, the nearest of `mechs` stops a projectile.
pub fn first_mech<'a>(ray: &Ray, mut max: f32, mechs: impl IntoIterator<Item = (&'a Tuning, &'a Mech)>) -> Option<f32> {
    let mut best = None;
    for (t, m) in mechs {
        let (c, center) = hit_shape(t, m);
        let shape = Capsule::new_y(c.half_height(), c.radius + PROJECTILE_RADIUS);
        let pose = Pose::from_translation(center);
        if let Some(toi) = shape.cast_ray(&pose, ray, max, true) {
            max = toi;
            best = Some(toi);
        }
    }
    best
}

/// Damage a burst at `at` from a weapon tuned by `t` (the primary if `primary`) does to mech `m`
/// (tuned by `tm`): full at contact, falling linearly to EDGE_DAMAGE at the weapon's radius, none
/// beyond it or through the arena.
pub fn splash(arena: &Arena, t: &Tuning, primary: bool, at: Vector, tm: &Tuning, m: &Mech) -> f32 {
    let b = ballistics(t, primary);
    let (c, center) = hit_shape(tm, m);
    let h = c.half_height();
    let axis = Vector::new(center.x, at.y.clamp(center.y - h, center.y + h), center.z);
    let to = axis - at;
    let dist = to.length();
    let surface = (dist - c.radius).max(0.0);
    if surface >= b.radius {
        return 0.0;
    }
    if surface > 0.0 && arena.cast_ray(&Ray::new(at, to / dist), surface).is_some() {
        return 0.0;
    }
    b.damage * (1.0 - (1.0 - EDGE_DAMAGE) * surface / b.radius)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Map, mech_capsule, spawn_mech};
    use std::f32::consts::FRAC_PI_2;

    #[test]
    fn repairing_mechs_crouch_under_head_high_shots() {
        let t = Tuning::default();
        let mut m = spawn_mech(&t, Vector::ZERO);
        // Level, at 90% of the mech's height: over a crouch (80%), into a standing mech.
        let ray = Ray::new(Vector::new(0.0, 0.9 * t.mech_height, 20.0), Vector::NEG_Z);
        assert!(first_mech(&ray, 50.0, [(&t, &m)]).is_some(), "missed a standing mech");
        m.repair_time = DT;
        assert!(first_mech(&ray, 50.0, [(&t, &m)]).is_none(), "hit a crouched mech over its head");
    }

    fn blockout() -> Arena {
        Arena::new(&Map::load(Map::index("blockout").unwrap()))
    }

    fn mech(class: MechClass, pos: [f32; 3], yaw: f32, pitch: f32) -> (Tuning, Mech) {
        armed(class, Loadout::of(class), pos, yaw, pitch)
    }

    /// `mech` carrying `loadout`.
    fn armed(class: MechClass, loadout: Loadout, pos: [f32; 3], yaw: f32, pitch: f32) -> (Tuning, Mech) {
        let t = crate::Arsenal::new(&Tuning::default()).get(class, loadout).clone();
        let m = Mech { class, loadout, yaw, pitch, ..spawn_mech(&t, Vector::from_array(pos)) };
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
        let (t, m) = armed(MechClass::B, Loadout::named("pike", "rocket"), [40.0, 0.0, 0.0], -FRAC_PI_2, 0.0);
        let (at, _) = fly_out(&arena, &t, volley(&t, &m, 0, 1)[0]);
        assert!(at.x < 50.0 && at.x > 49.85, "burst at {at}");
    }

    #[test]
    fn fans_spread_symmetrically() {
        let (t, m) = mech(MechClass::A, [0.0, 0.0, 0.0], 0.3, 0.1);
        let t = Tuning { alt_count: 3.0, alt_spread_deg: 4.0, alt_cone: 0.0, alt_loft_deg: 0.0, ..t };
        let v = volley(&t, &m, 0, 1);
        assert_eq!(v.len(), 3);
        let aim = aim_ray(&t, &m).dir;
        let angle = |p: &Projectile| p.vel.normalize().angle_between(aim);
        assert!(angle(&v[1]) < 1e-3, "middle dart off the aim");
        assert!((angle(&v[0]) - angle(&v[2])).abs() < 1e-3);
        assert!((angle(&v[0]) - t.alt_spread_deg.to_radians()).abs() < 0.01);
    }

    #[test]
    fn scatter_fills_a_cone() {
        let (t, m) = armed(MechClass::A, Loadout::named("stitcher", "darts"), [0.0, 0.0, 0.0], 0.3, 0.1);
        assert!(t.alt_cone > 0.0 && t.alt_count > 3.0, "the scatter isn't a cone volley");
        let v = volley(&t, &m, 0, 7);
        assert_eq!(v.len(), t.alt_count as usize);
        let aim = aim_ray(&t, &m).dir;
        let angles: Vec<f32> = v.iter().map(|p| p.vel.normalize().angle_between(aim)).collect();
        assert!(angles.iter().all(|a| *a <= t.alt_spread_deg.to_radians() * 1.01), "a pellet left the cone: {angles:?}");
        assert!(v.windows(2).all(|w| w[0].vel != w[1].vel), "pellets overlap");
        // Not a level fan: some climb and some dip.
        assert!(v.iter().any(|p| p.vel.y > aim.y * t.alt_speed + 0.1) && v.iter().any(|p| p.vel.y < aim.y * t.alt_speed - 0.1));
        assert_ne!(v[0].vel, volley(&t, &m, 0, 8)[0].vel, "seq doesn't reseed");
    }

    #[test]
    fn homing_waits_out_its_delay() {
        let (t, m) = mech(MechClass::B, [0.0, 0.0, 0.0], 0.0, 0.0);
        let t = Tuning { alt_turn: 90.0, alt_home_delay: 0.4, ..t };
        let mut p = volley(&t, &m, 0, 1)[0];
        let (dir, goal) = (p.vel, p.pos + Vector::X * 30.0);
        p.age = 0.39;
        home(&t, &mut p, goal);
        assert_eq!(p.vel, dir, "turned during the delay");
        p.age = 0.4;
        home(&t, &mut p, goal);
        assert!(p.vel.angle_between(dir) > 0.0, "didn't turn once it was over");
    }

    #[test]
    fn speeds_vary_within_the_jitter() {
        let (t, m) = mech(MechClass::B, [0.0, 0.0, 0.0], 0.0, 0.0);
        let t = Tuning { alt_count: 8.0, alt_speed_jitter: 0.2, ..t };
        let speeds: Vec<f32> = volley(&t, &m, 0, 3).iter().map(|p| p.vel.length()).collect();
        assert!(speeds.iter().all(|s| (s / t.alt_speed - 1.0).abs() <= 0.2 + 1e-4), "{speeds:?}");
        let spread = speeds.iter().fold(0f32, |a, s| a.max(*s)) - speeds.iter().fold(f32::MAX, |a, s| a.min(*s));
        assert!(spread > 0.1 * t.alt_speed, "speeds barely vary: {speeds:?}");
        assert_eq!(volley(&t, &m, 0, 3)[5].vel, volley(&t, &m, 0, 3)[5].vel);
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
        assert!((splash(&arena, &t, false, at(0.0), &tm, &target) - t.alt_damage).abs() < 1e-3);
        let edge = splash(&arena, &t, false, at(t.alt_radius - 1e-3), &tm, &target);
        assert!((edge - EDGE_DAMAGE * t.alt_damage).abs() < 0.01, "edge damage {edge}");
        assert_eq!(splash(&arena, &t, false, at(t.alt_radius + 0.1), &tm, &target), 0.0);

        // In range, but the east wall (x 50 to 51) stands between.
        let (tm, inside) = mech(MechClass::B, [48.0, 0.0, 0.0], 0.0, 0.0);
        assert_eq!(splash(&arena, &t, false, Vector::new(51.5, 2.5, 0.0), &tm, &inside), 0.0);
    }
}
