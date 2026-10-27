//! What one mech's weapons can do to another at a range, read off their stats as a player reads
//! the crosshair card: the damage a second a fair shooter lands on a strafing mech (`dps`), and
//! what two mechs' weapons make of a straight duel at each range (`edge`, `best_range`). For bots'
//! choices (where to fight from, whom to fight first). Approximate by design: `threat_probe` (in
//! the tests) checks it against duels played out by bots.

use std::f32::consts::PI;

use crate::bot::{AltUse, alt_use};
use crate::Tuning;

/// How often a strafing target turns about, on average (s): bots every 0.8 to 2 s.
const TURN_EVERY: f32 = 1.4;
/// How long a shooter's aim stays off a target that has turned, in reaction times: it sees the
/// turn late, then reads the new motion.
const TURN_LAG: f32 = 2.0;
/// Time a secondary takes the aim from the gun, each launch (s).
const ALT_AIM: f32 = 0.4;
/// Share of the misses a bouncing round with a long fuse still lands, lying where a mech walks
/// into it (at a 3 s fuse or longer).
const LINGER: f32 = 0.15;
/// Heat a careful shooter fires between, as shares of the max (the bots' default policy's).
const HEAT_HIGH: f32 = 0.85;
const HEAT_LOW: f32 = 0.4;
/// A fight long enough to wind a spin-up gun and bloom a spread, when heat never stops it (s).
const ENGAGEMENT: f32 = 4.0;
/// Share of a shell's damage its blast lands on a mech it bursts near, on average (full at
/// contact, 30% at its edge).
const SPLASH_SHARE: f32 = 0.6;
/// Ranges `best_range` weighs (m).
pub const RANGES: [f32; 20] = [5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0, 90.0, 100.0, 110.0, 120.0];

/// Damage a second, by weapon, and the share of the time the gun fires (the rest it cools).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Dps {
    pub primary: f32,
    pub secondary: f32,
    pub duty: f32,
}

impl Dps {
    pub fn total(self) -> f32 {
        self.primary + self.secondary
    }
}

/// The damage a second a mech carrying `t` lands on one carrying `target`, strafing, `range` off,
/// firing both weapons as heat allows. The shooter aims like a skill 0.5 bot.
pub fn dps(t: &Tuning, target: &Tuning, range: f32) -> Dps {
    let aim = aim_sigma(t);
    let (primary, primary_heat, interval) = primary_rate(t, target, range, aim);
    let (secondary, secondary_heat) = secondary_rate(t, target, range, aim);
    // Both share one heat meter: fire for as long as the band between careful bounds allows,
    // then cool (after the delay) back down.
    let band = (HEAT_HIGH - HEAT_LOW) * t.heat_max;
    let mid = 0.5 * (HEAT_HIGH + HEAT_LOW);
    let cooling = t.heat_decay * (1.0 + (t.heat_decay_cool - 1.0) * (1.0 - mid));
    // A slow gun cools between its shots too.
    let between = if interval > t.heat_decay_delay { cooling * (interval - t.heat_decay_delay) / interval } else { 0.0 };
    let heating = primary_heat + secondary_heat - between;
    let (duty, fire) = if heating <= 0.0 {
        (1.0, ENGAGEMENT)
    } else {
        let fire = band / heating;
        (fire / (fire + t.heat_decay_delay + band / cooling), fire)
    };
    // The secondary fires whenever it's ready (the gun holds to let it), its heat counted against
    // the gun; and while it takes the aim, the gun waits.
    let lent = if secondary > 0.0 { (1.0 - ALT_AIM / t.alt_cooldown.max(ALT_AIM)).max(0.0) } else { 1.0 };
    Dps { primary: primary * duty * lent * spun(t, fire) * bloomed(t, target, range, aim, interval, fire), secondary, duty }
}

/// Damage a second at each of RANGES, to read off at any range (`at`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Curve(pub [f32; RANGES.len()]);

impl Curve {
    /// `t`'s total damage a second on `target` by range.
    pub fn of(t: &Tuning, target: &Tuning) -> Curve {
        Curve(RANGES.map(|r| dps(t, target, r).total()))
    }

    /// At `range`, between the ranges either side (the nearest's, short of the first or past the
    /// last).
    pub fn at(&self, range: f32) -> f32 {
        let k = RANGES.iter().position(|&r| r >= range).unwrap_or(RANGES.len());
        if k == 0 {
            self.0[0]
        } else if k == RANGES.len() {
            self.0[k - 1]
        } else {
            let (r0, r1) = (RANGES[k - 1], RANGES[k]);
            self.0[k - 1] + (self.0[k] - self.0[k - 1]) * (range - r0) / (r1 - r0)
        }
    }
}

/// A skill 0.5 bot's aim error, per axis (radians): its aim wanders within ±`bot_aim_error_deg`.
fn aim_sigma(t: &Tuning) -> f32 {
    t.bot_aim_error_deg.to_radians() / libm::sqrtf(3.0)
}

/// The radius of a disc as big as `t`'s mech seen side on (a capsule).
fn silhouette(t: &Tuning) -> f32 {
    let (r, h) = (t.mech_radius, t.mech_height);
    libm::sqrtf((2.0 * r * (h - 2.0 * r).max(0.0) + PI * r * r) / PI)
}

/// Chance a round aimed at `target`'s middle from `range` off lands, or bursts close enough to
/// count. Its miss, per axis, adds a cone `cone` radians wide (uniform in a disc), the aim error,
/// the target's strafing the shooter couldn't foresee over a `flight` s flight (it turned), and
/// for a round that drops `gravity` its misjudged range; a blast `splash` wide widens the target,
/// and a homing round takes out what it can turn through (`homing` degrees over the flight).
/// Over the spells the shooter's aim lags a target that has just turned, it adds that lag.
#[allow(clippy::too_many_arguments)]
fn hit_chance(t: &Tuning, target: &Tuning, range: f32, cone: f32, aim: f32, flight: f32, splash: f32, gravity: f32, homing: f32) -> f32 {
    let reach = silhouette(target) + 0.5 * splash;
    let v = target.walk_speed;
    // A turn during the flight puts the round off by up to twice the motion since.
    let dodge2 = (flight / TURN_EVERY).min(1.0) * 4.0 / 3.0 * (v * flight).powi(2);
    let drop = 0.5 * gravity * flight * flight;
    let lob = t.bot_range_error * drop.min(range);
    let kept = (1.0 - homing / 60.0).clamp(0.2, 1.0);
    let spread = range * cone / 2.0;
    let steady = kept * kept * (spread * spread + (range * aim).powi(2) + dodge2.min((v * TURN_EVERY).powi(2))) + lob * lob;
    let chance = |sigma2: f32| 1.0 - libm::expf(-reach * reach / (2.0 * sigma2.max(1e-6)));
    let lag = TURN_LAG * t.bot_reaction_s;
    let turned = (lag / TURN_EVERY).min(1.0);
    (1.0 - turned) * chance(steady) + turned * chance(steady + kept * kept * (v * lag).powi(2))
}

/// Farthest a primary round counts: its range, or for a projectile how far it carries before its
/// fuse or the ground stops it.
fn reach(t: &Tuning, speed: f32) -> f32 {
    let mut r = t.weapon_range;
    if speed > 0.0 {
        if t.shot_fuse > 0.0 {
            r = r.min(speed * t.shot_fuse);
        }
        if t.shot_gravity > 0.0 {
            r = r.min(speed * speed / t.shot_gravity);
        }
    }
    r
}

/// The primary's damage a second while firing (before heat, spin and bloom), the heat it makes a
/// second, and the time between its rounds (s).
fn primary_rate(t: &Tuning, target: &Tuning, range: f32, aim: f32) -> (f32, f32, f32) {
    let charged = t.charge_time > 0.0;
    let (power, speed, splash) = if charged {
        (t.charge_damage, t.shot_speed * t.charge_speed, t.shot_radius * t.charge_radius)
    } else {
        (1.0, t.shot_speed, t.shot_radius)
    };
    // `fire_rate` is pulls a second; a charge gun charges after each cycle.
    let cycle = 1.0 / t.fire_rate.max(1e-3) + if charged { t.charge_time } else { 0.0 };
    let rounds = t.burst.max(1.0) / cycle;
    let heat = t.heat_per_shot * power * rounds;
    if range > reach(t, speed) {
        return (0.0, heat, 1.0 / rounds);
    }
    let projectile = speed > 0.0;
    let flight = if projectile { range / speed } else { 0.0 };
    let per_round = if projectile {
        let hit = hit_chance(t, target, range, t.spread_deg.to_radians(), aim, flight, splash, t.shot_gravity, t.shot_turn * flight);
        t.shot_damage * power * lingered(hit, t.shot_bounce, t.shot_fuse) * splash_share(splash)
    } else {
        t.shot_damage * crate::weapon::falloff(t, range) * hit_chance(t, target, range, t.spread_deg.to_radians(), aim, 0.0, 0.0, 0.0, 0.0)
    };
    (per_round * t.pellets.max(1.0) * rounds, heat, 1.0 / rounds)
}

/// `hit`, with what a bouncing round fused `fuse` s lands of its misses later.
fn lingered(hit: f32, bounce: f32, fuse: f32) -> f32 {
    if bounce > 0.0 && fuse >= 1.0 { hit + (1.0 - hit) * LINGER * (fuse / 3.0).min(1.0) } else { hit }
}

/// How much of a hit a blast `splash` wide lands, on average (a direct round lands all of it).
fn splash_share(splash: f32) -> f32 {
    if splash > 0.0 { SPLASH_SHARE + (1.0 - SPLASH_SHARE) / (1.0 + splash) } else { 1.0 }
}

/// Share of `fire_rate` a spin-up gun fires at over a `fire` s spell: it waits `spin_delay`, then
/// winds from `spin_start` to full over `spin_up`.
fn spun(t: &Tuning, fire: f32) -> f32 {
    if t.spin_up <= 0.0 {
        return 1.0;
    }
    let lost = t.spin_delay + t.spin_up * (1.0 - t.spin_start) * 0.5;
    ((fire - lost) / fire).clamp(0.0, 1.0)
}

/// What bloom costs a gun over a `fire` s spell, as a share of its hits: bloom grows by
/// `bloom_per_shot` a round, recovering `bloom_recovery` a second, up to `bloom_max`.
fn bloomed(t: &Tuning, target: &Tuning, range: f32, aim: f32, interval: f32, fire: f32) -> f32 {
    if t.bloom_per_shot <= 0.0 || t.bloom_max <= 0.0 {
        return 1.0;
    }
    let rise = t.bloom_per_shot / interval - t.bloom_recovery;
    let mean = if rise <= 0.0 {
        0.5 * t.bloom_per_shot
    } else {
        let up = t.bloom_max / rise;
        if fire <= up { 0.5 * rise * fire } else { t.bloom_max - 0.5 * t.bloom_max * up / fire }
    };
    let projectile = t.shot_speed > 0.0;
    let flight = if projectile { range / t.shot_speed } else { 0.0 };
    let splash = if projectile { t.shot_radius } else { 0.0 };
    let at = |spread: f32| hit_chance(t, target, range, spread.to_radians(), aim, flight, splash, t.shot_gravity, t.shot_turn * flight);
    let base = at(t.spread_deg);
    if base > 0.0 { at(t.spread_deg + mean) / base } else { 1.0 }
}

/// The secondary's damage a second, fired whenever it's ready at a range where it's any use, and
/// the heat it makes a second then (none where it isn't fired).
fn secondary_rate(t: &Tuning, target: &Tuning, range: f32, aim: f32) -> (f32, f32) {
    let cooldown = t.alt_cooldown.max(0.25);
    let heat = t.alt_heat / cooldown;
    let damage = match alt_use(t) {
        // A torch burns what it's held on, and heats while held.
        AltUse::Beam => return if range <= t.alt_beam { (t.alt_damage * 0.9, t.alt_heat) } else { (0.0, 0.0) },
        // A rocket punch wound up and let go lunges its reach.
        AltUse::Melee => {
            let cycle = cooldown + t.alt_charge_time;
            let lands = range <= t.alt_lunge + t.mech_radius + target.mech_radius;
            return if lands { (0.9 * t.alt_damage * t.alt_charge_damage / cycle, t.alt_heat / cycle) } else { (0.0, 0.0) };
        }
        // A heat-fed launcher spends heat, firing hotter the hotter it runs (the bots' 60%).
        AltUse::HeatFed => t.alt_damage * (1.0 + (t.alt_charge_damage - 1.0) * 0.6),
        _ => t.alt_damage,
    };
    let carry = if t.alt_gravity > 0.0 { (t.alt_speed * t.alt_speed / t.alt_gravity).min(t.alt_speed * t.alt_fuse) } else { t.alt_speed * t.alt_fuse };
    // Bots hold a blast back from a target this close (it would catch them too).
    let near = alt_use(t) != AltUse::Lock && range < t.alt_radius + 2.0;
    if t.alt_speed <= 0.0 || range > carry || near {
        return (0.0, 0.0);
    }
    let flight = range / t.alt_speed;
    // A lock-on launcher's fan homes once it has spread out: about half lands, less up close.
    let chance = if alt_use(t) == AltUse::Lock {
        0.5 * (range / 30.0).min(1.0)
    } else {
        lingered(hit_chance(t, target, range, t.alt_spread_deg.to_radians(), aim, flight, t.alt_radius, t.alt_gravity, t.alt_turn * flight), t.alt_bounce, t.alt_fuse)
    };
    let mut per_launch = t.alt_count.max(1.0) * damage * chance * splash_share(t.alt_radius);
    // A cluster canister's bomblets, scattered, land about half; mines wait for someone to walk on them.
    per_launch += t.alt_split * t.alt_split_damage * chance * 0.5;
    if t.alt_stick > 0.0 {
        per_launch *= 0.25;
    }
    (per_launch / cooldown, heat)
}

/// The share of a straight duel `range` off that a mech carrying `mine` wins against one carrying
/// `theirs`: their time to kill it over both times (0.5 even, 1 a sure win).
pub fn edge(mine: &Tuning, theirs: &Tuning, range: f32) -> f32 {
    let mine_kills = theirs.health_max / dps(mine, theirs, range).total().max(1e-3);
    let theirs_kills = mine.health_max / dps(theirs, mine, range).total().max(1e-3);
    theirs_kills / (mine_kills + theirs_kills)
}

/// The range (of `RANGES`) where `mine` does best against `theirs`, and its edge there.
pub fn best_range(mine: &Tuning, theirs: &Tuning) -> (f32, f32) {
    RANGES.iter().map(|&r| (r, edge(mine, theirs, r))).fold((RANGES[0], f32::MIN), |best, (r, e)| if e > best.1 { (r, e) } else { best })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Arsenal, Loadout, MechClass};

    fn kit(class: MechClass, primary: &str, secondary: &str) -> Tuning {
        Arsenal::new(&Tuning::default()).get(class, Loadout::named(primary, secondary)).clone()
    }

    #[test]
    fn close_guns_win_close_and_long_guns_win_long() {
        let (flak, rifle) = (kit(MechClass::B, "squall", "rocket"), kit(MechClass::B, "pike", "rocket"));
        // Flak shreds up close and falls away; the rifle holds on.
        let (near, far) = (dps(&flak, &rifle, 10.0).primary, dps(&flak, &rifle, 70.0).primary);
        assert!(near > 3.0 * far, "flak {near} close, {far} far");
        assert!(edge(&flak, &rifle, 10.0) > 0.5 && edge(&flak, &rifle, 70.0) < 0.5);
        let (flak_best, rifle_best) = (best_range(&flak, &rifle).0, best_range(&rifle, &flak).0);
        assert!(flak_best + 20.0 <= rifle_best, "flak best at {flak_best} m, rifle at {rifle_best} m");
        // A grenade rifle reaches no farther than its grenades carry.
        let hail = kit(MechClass::B, "hail", "rocket");
        assert_eq!(dps(&hail, &rifle, 150.0).primary, 0.0);
        // Even matchups are even.
        assert!((edge(&rifle, &rifle, 40.0) - 0.5).abs() < 1e-4);
        // A curve reads its ranges back, and between them in between.
        let curve = Curve::of(&rifle, &flak);
        assert_eq!(curve.at(40.0), dps(&rifle, &flak, 40.0).total());
        let mid = curve.at(42.5);
        assert!((mid - 0.5 * (curve.at(40.0) + curve.at(45.0))).abs() < 1e-4);
        // A big Heavy is easier to hit than a small Light.
        let (light, heavy) = (kit(MechClass::A, "pike", "rocket"), kit(MechClass::C, "pike", "rocket"));
        assert!(dps(&rifle, &heavy, 60.0).primary > dps(&rifle, &light, 60.0).primary);
    }

    #[test]
    fn every_kit_reads_sanely() {
        // Every primary and secondary, in every class, against every class: finite, never
        // negative, and a duel's shares between nothing and all.
        let arsenal = Arsenal::new(&Tuning::default());
        let kits: Vec<Tuning> = MechClass::ALL
            .iter()
            .flat_map(|&c| (0..).map_while(move |p| crate::arsenal::weapon(crate::Slot::Primary, p).map(|_| (c, p))))
            .flat_map(|(c, p)| (0..).map_while(move |s| crate::arsenal::weapon(crate::Slot::Secondary, s).map(|_| (c, p, s))))
            .map(|(c, p, s)| arsenal.get(c, Loadout { primary: p, secondary: s, ..Loadout::of(c) }).clone())
            .collect();
        for mine in &kits {
            for theirs in kits.iter().step_by(7) {
                for &r in &RANGES {
                    let d = dps(mine, theirs, r);
                    assert!(d.primary.is_finite() && d.primary >= 0.0 && d.secondary.is_finite() && d.secondary >= 0.0, "{d:?} at {r} m");
                    let e = edge(mine, theirs, r);
                    assert!((0.0..=1.0).contains(&e), "edge {e} at {r} m");
                }
            }
        }
    }

    #[test]
    fn heat_caps_sustained_fire() {
        // A gun that heats faster than it sheds fires only part of the time.
        let rifle = kit(MechClass::B, "pike", "piston");
        let mut hot = rifle.clone();
        hot.heat_per_shot *= 4.0;
        assert!(dps(&hot, &rifle, 40.0).primary < 0.6 * dps(&rifle, &rifle, 40.0).primary);
        // A secondary out of its reach makes no heat: the gun fires as if it weren't there.
        let mut bare = rifle.clone();
        bare.alt_heat = 0.0;
        assert_eq!(dps(&rifle, &rifle, 40.0), dps(&bare, &rifle, 40.0));
    }
}
