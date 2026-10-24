//! Abilities: one per mech on F, picked like a weapon from weapons.json's `abilities`, each
//! fitting only the classes it lists. Using one starts, for most, a spell (`Mech::ability_time`)
//! it stays on for, and its cooldown counts down once that ends (by its time, or early: a Power
//! shot spent, Camouflage dropped). A mech spawns with its ability ready. `step_mech` runs them, so the client predicts them like
//! fuel; what they do to others (Bulwark's cut, boosted damage, a mech hidden) is the server's.
//!
//! - Speed boost refills fuel, then boost burns none and runs faster. Vent dumps all heat at once.
//!   Bulwark trades boost for less damage and more speed on foot.
//! - Camouflage hides the mech from enemies' tags and radar, turrets and bots, until it runs out
//!   or the mech fires or uses an item.
//! - Power shot boosts the next shot or volley (a burst, all of it); Barrage and Artillery boost
//!   everything fired or thrown while they last, Artillery's blasts wider too (`boost`).

use std::sync::OnceLock;

use crate::arsenal::Slot;
use crate::{DT, Loadout, Mech, Tuning};

/// What an ability does, by its weapons.json id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ability {
    Slipstream,
    Vent,
    Brace,
    Cloak,
    Power,
    Barrage,
    Artillery,
}

impl Ability {
    /// The ability `loadout` carries.
    pub fn of(loadout: Loadout) -> Ability {
        let list = list();
        list[usize::from(loadout.ability).min(list.len() - 1)]
    }

    /// Its cooldown, and the seconds it stays on once used (0 for Vent, which is instant).
    fn timing(self, t: &Tuning) -> (f32, f32) {
        match self {
            Ability::Slipstream => (t.slipstream_cooldown, t.slipstream_duration),
            Ability::Vent => (t.vent_cooldown, 0.0),
            Ability::Brace => (t.brace_cooldown, t.brace_duration),
            Ability::Cloak => (t.cloak_cooldown, t.cloak_duration),
            Ability::Power => (t.power_cooldown, t.power_duration),
            Ability::Barrage => (t.barrage_cooldown, t.barrage_duration),
            Ability::Artillery => (t.artillery_cooldown, t.artillery_duration),
        }
    }

    /// What it multiplies a boosted shot's damage and blast radius by.
    pub fn boost(self, t: &Tuning) -> (f32, f32) {
        match self {
            Ability::Power => (t.power_damage_mult, 1.0),
            Ability::Barrage => (t.barrage_damage_mult, 1.0),
            Ability::Artillery => (t.artillery_damage_mult, t.artillery_radius_mult),
            _ => (1.0, 1.0),
        }
    }
}

/// The abilities weapons.json lists, in order.
fn list() -> &'static [Ability] {
    static LIST: OnceLock<Vec<Ability>> = OnceLock::new();
    LIST.get_or_init(|| {
        (0..)
            .map_while(|i| crate::arsenal::weapon(Slot::Ability, i))
            .map(|(id, _)| match id {
                "slipstream" => Ability::Slipstream,
                "vent" => Ability::Vent,
                "brace" => Ability::Brace,
                "cloak" => Ability::Cloak,
                "power" => Ability::Power,
                "barrage" => Ability::Barrage,
                "artillery" => Ability::Artillery,
                _ => panic!("weapons.json lists ability `{id}`, which does nothing"),
            })
            .collect()
    })
}

/// Whether `m` carries `ability` and it's on.
pub fn on(m: &Mech, ability: Ability) -> bool {
    m.ability_time > 0.0 && Ability::of(m.loadout) == ability
}

/// What `m`'s damage this tick is multiplied by: more if what it fired is boosted.
pub fn damage_mult(t: &Tuning, m: &Mech) -> f32 {
    if m.boosted { Ability::of(m.loadout).boost(t).0 } else { 1.0 }
}

/// One tick of `m`'s ability before it moves: the spell runs down, then the cooldown, and `press`
/// off cooldown uses it.
pub(crate) fn step(t: &Tuning, m: &mut Mech, press: bool) {
    let ability = Ability::of(m.loadout);
    // Half a tick of slack, as items' charges have, so each ends on a whole tick despite float sums.
    let down = |left: f32| if left - DT < DT * 0.5 { 0.0 } else { left - DT };
    if m.ability_time > 0.0 {
        m.ability_time = down(m.ability_time);
    } else {
        m.ability_cooldown = down(m.ability_cooldown);
    }
    if press && m.ability_cooldown <= 0.0 {
        (m.ability_cooldown, m.ability_time) = ability.timing(t);
        match ability {
            Ability::Slipstream => m.fuel = t.fuel_max,
            Ability::Vent => (m.heat, m.overheated) = (0.0, false),
            _ => {}
        }
    }
}

/// Once `m` has fired this tick: whether what it fired is boosted (`Mech::boosted`). A Power shot
/// is spent by a volley or a shot (a burst by its last round), and Camouflage dropped by firing,
/// bursting shells or mines, or using an item.
pub(crate) fn fired(m: &mut Mech) {
    let (ability, on) = (Ability::of(m.loadout), m.ability_time > 0.0);
    let fired = m.shot || m.launched;
    m.boosted = on && match ability {
        Ability::Power => fired,
        Ability::Barrage | Ability::Artillery => true,
        _ => false,
    };
    let spent = match ability {
        Ability::Power => m.launched || m.shot && m.burst_left == 0,
        Ability::Cloak => fired || m.beaming || m.alt_pressed || m.threw || m.sprung || m.pulsed,
        _ => false,
    };
    if on && spent {
        m.ability_time = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arsenal::index;
    use crate::{Arsenal, Input, Map, MechClass, Sim, projectile};

    /// An offline sim of `class` carrying ability `id` and `primary`, aimed level.
    fn with(class: MechClass, id: &str, primary: &str) -> Sim {
        let mut sim = Sim::with_map(Tuning::default(), Map::index("blockout").unwrap());
        sim.class = class;
        sim.loadout = Loadout { ability: index(Slot::Ability, id), primary: index(Slot::Primary, primary), ..Loadout::of(class) };
        sim.tuning = Arsenal::new(&sim.tuning).get(class, sim.loadout).clone();
        sim.reset();
        sim
    }

    #[test]
    fn power_boosts_one_shot_and_a_burst_whole() {
        for (primary, rounds) in [("pike", 1), ("triplet", 3)] {
            let mut sim = with(MechClass::B, "power", primary);
            sim.step(&Input { ability: true, ..Input::default() });
            assert!(sim.mech.ability_time > 0.0 && !sim.mech.boosted, "{primary}: boosted before firing");
            let mut boosted = 0;
            for _ in 0..30 {
                sim.step(&Input { fire: true, ..Input::default() });
                if sim.mech.shot {
                    boosted += u32::from(sim.mech.boosted);
                }
            }
            assert_eq!(boosted, rounds, "{primary}: boosted the wrong rounds");
            assert_eq!(sim.mech.ability_time, 0.0, "{primary}: still armed");
        }
    }

    #[test]
    fn barrage_boosts_everything_while_it_lasts() {
        let t = Tuning::default();
        let mut sim = with(MechClass::C, "barrage", "stitcher");
        sim.step(&Input { ability: true, fire: true, ..Input::default() });
        assert!(sim.mech.shot && sim.mech.boosted);
        assert_eq!(damage_mult(&t, &sim.mech), t.barrage_damage_mult);
        for _ in 0..=(t.barrage_duration / DT).round() as usize {
            sim.step(&Input::default());
        }
        sim.step(&Input { fire: true, ..Input::default() });
        assert!(!sim.mech.boosted, "boosted after it ran out");
    }

    #[test]
    fn artillery_blasts_wider_and_harder() {
        let t = Tuning::default();
        let m = Mech { loadout: Loadout { ability: index(Slot::Ability, "artillery"), ..Loadout::of(MechClass::C) }, ..crate::spawn_mech(&t, crate::Vector::ZERO) };
        let plain = projectile::volley(&t, &m, 0, 1)[0];
        let boosted = projectile::volley(&t, &Mech { boosted: true, ..m }, 0, 1)[0];
        let ratio = projectile::radius(&t, &boosted) / projectile::radius(&t, &plain);
        assert!((ratio - t.artillery_radius_mult).abs() < 1e-4, "radius x{ratio}");
        let ratio = projectile::tuning_for(&t, &boosted).alt_damage / projectile::tuning_for(&t, &plain).alt_damage;
        assert!((ratio - t.artillery_damage_mult).abs() < 1e-4, "damage x{ratio}");
    }

    #[test]
    fn cooldowns_count_from_when_the_spell_ends() {
        let t = Tuning::default();
        let ready = |sim: &Sim| sim.mech.ability_cooldown <= 0.0;
        // Barrage runs its course, then its whole cooldown.
        let mut sim = with(MechClass::C, "barrage", "squall");
        sim.step(&Input { ability: true, ..Input::default() });
        let mut ticks = 1;
        while !ready(&sim) {
            sim.step(&Input::default());
            ticks += 1;
        }
        // The cooldown takes over the tick after the spell ends.
        let secs = ticks as f32 * DT;
        assert!((secs - (t.barrage_duration + t.barrage_cooldown + DT)).abs() < DT * 0.5, "ready after {secs} s");
        // Camouflage dropped early by a shot counts from the shot.
        let mut sim = with(MechClass::A, "cloak", "stitcher");
        sim.step(&Input { ability: true, ..Input::default() });
        for _ in 0..30 {
            sim.step(&Input::default());
        }
        sim.step(&Input { fire: true, ..Input::default() });
        assert!(!on(&sim.mech, Ability::Cloak));
        let mut ticks = 0;
        while !ready(&sim) {
            sim.step(&Input::default());
            ticks += 1;
        }
        assert!((ticks as f32 * DT - t.cloak_cooldown).abs() <= DT, "ready {} s after the shot", ticks as f32 * DT);
    }

    #[test]
    fn camouflage_drops_on_firing() {
        let mut sim = with(MechClass::A, "cloak", "stitcher");
        sim.step(&Input { ability: true, ..Input::default() });
        sim.step(&Input::default());
        assert!(on(&sim.mech, Ability::Cloak));
        sim.step(&Input { fire: true, ..Input::default() });
        assert!(sim.mech.shot && !on(&sim.mech, Ability::Cloak), "fired and stayed hidden");
    }
}
