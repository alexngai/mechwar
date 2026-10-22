//! Weapons and loadouts. `weapons.json` lists the primaries and secondaries; each sets tuning
//! values in its slot's tuning.json group (`primary` or `secondary`) over tuning.json's own,
//! which are the Lancer's weapons. A mech's tuning is tuning.json, then its class's
//! `classes.json` overrides (which set no weapon values), then its primary's and secondary's.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Mech, MechClass, Tuning};

/// The weapons a mech carries: indices into weapons.json's `primaries` and `secondaries`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Loadout {
    pub primary: u8,
    pub secondary: u8,
}

impl Loadout {
    /// `class`'s own weapons, from classes.json's `weapons`.
    pub fn of(class: MechClass) -> Loadout {
        static OWN: OnceLock<[Loadout; 3]> = OnceLock::new();
        OWN.get_or_init(|| {
            MechClass::ALL.map(|class| {
                let index = |slot: Slot| {
                    let id = classes_json()[class.key()]["weapons"][slot.group()].as_str().expect("classes.json names each class's weapons");
                    let at = slot.list(weapons_json()).iter().position(|w| w["id"] == id);
                    u8::try_from(at.unwrap_or_else(|| panic!("classes.json names unknown weapon `{id}`"))).expect("under 256 weapons")
                };
                Loadout { primary: index(Slot::Primary), secondary: index(Slot::Secondary) }
            })
        })[class.index()]
    }
}

#[derive(Clone, Copy)]
enum Slot {
    Primary,
    Secondary,
}

impl Slot {
    /// The tuning.json group of the values this slot's weapons set.
    fn group(self) -> &'static str {
        match self {
            Slot::Primary => "primary",
            Slot::Secondary => "secondary",
        }
    }

    /// This slot's weapons in `weapons` (weapons.json's format).
    fn list(self, weapons: &Value) -> &Vec<Value> {
        let key = match self {
            Slot::Primary => "primaries",
            Slot::Secondary => "secondaries",
        };
        weapons[key].as_array().filter(|list| !list.is_empty()).unwrap_or_else(|| panic!("weapons.json needs {key}"))
    }
}

/// Tuning for every class with every loadout, built up front: mechs and projectiles look theirs
/// up every tick.
#[derive(Clone, Debug)]
pub struct Arsenal {
    primaries: usize,
    secondaries: usize,
    /// By class, then primary, then secondary.
    tunings: Vec<Tuning>,
}

impl Arsenal {
    /// From `base` with the compiled-in classes.json and weapons.json.
    pub fn new(base: &Tuning) -> Self {
        Self::with(base, classes_json(), weapons_json())
    }

    /// Like `new`, with `classes` and `weapons` (in their files' formats) instead.
    pub fn with(base: &Tuning, classes: &Value, weapons: &Value) -> Self {
        let (primaries, secondaries) = (Slot::Primary.list(weapons), Slot::Secondary.list(weapons));
        let base = serde_json::to_value(base).expect("tuning serializes");
        let mut tunings = Vec::with_capacity(MechClass::ALL.len() * primaries.len() * secondaries.len());
        for class in MechClass::ALL {
            let body = merge(&base, &classes[class.key()]["overrides"], None);
            for p in primaries {
                let armed = merge(&body, &p["stats"], Some(Slot::Primary));
                for s in secondaries {
                    tunings.push(serde_json::from_value(merge(&armed, &s["stats"], Some(Slot::Secondary))).expect("tuning values are numbers"));
                }
            }
        }
        Self { primaries: primaries.len(), secondaries: secondaries.len(), tunings }
    }

    pub fn get(&self, class: MechClass, loadout: Loadout) -> &Tuning {
        let Loadout { primary, secondary } = self.clamp(loadout);
        &self.tunings[(class.index() * self.primaries + usize::from(primary)) * self.secondaries + usize::from(secondary)]
    }

    /// Mech `m`'s tuning.
    pub fn of(&self, m: &Mech) -> &Tuning {
        self.get(m.class, m.loadout)
    }

    /// `loadout` with each index in range: clients may send anything.
    pub fn clamp(&self, loadout: Loadout) -> Loadout {
        let last = |n: usize| u8::try_from(n - 1).unwrap_or(u8::MAX);
        Loadout { primary: loadout.primary.min(last(self.primaries)), secondary: loadout.secondary.min(last(self.secondaries)) }
    }
}

/// `values` with `overrides` (an object of numbers; anything else sets nothing) applied. A
/// weapon's (`slot`) may only set its slot's group; a class's (None) may set no weapon's.
fn merge(values: &Value, overrides: &Value, slot: Option<Slot>) -> Value {
    let mut merged = values.clone();
    for (name, value) in overrides.as_object().into_iter().flatten() {
        let group = groups().get(name).and_then(Value::as_str).unwrap_or_else(|| panic!("`{name}` is not a tuning value"));
        match slot {
            Some(slot) => assert!(group == slot.group(), "a {} weapon can't set `{name}` ({group})", slot.group()),
            None => assert!(group != "primary" && group != "secondary", "classes.json can't set weapon value `{name}`; weapons.json does"),
        }
        merged[name] = value.clone();
    }
    merged
}

pub(crate) fn classes_json() -> &'static Value {
    static JSON: OnceLock<Value> = OnceLock::new();
    JSON.get_or_init(|| serde_json::from_str(include_str!("../../classes.json")).expect("classes.json is valid JSON"))
}

pub(crate) fn weapons_json() -> &'static Value {
    static JSON: OnceLock<Value> = OnceLock::new();
    JSON.get_or_init(|| serde_json::from_str(include_str!("../../weapons.json")).expect("weapons.json is valid JSON"))
}

/// Each tuning value's tuning.json group.
fn groups() -> &'static Map<String, Value> {
    static GROUPS: OnceLock<Map<String, Value>> = OnceLock::new();
    GROUPS.get_or_init(|| {
        let entries: Map<String, Value> = serde_json::from_str(include_str!("../../tuning.json")).expect("tuning.json is valid JSON");
        entries.into_iter().map(|(name, entry)| (name, entry["group"].clone())).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_carry_their_own_weapons_and_loadouts_swap_them() {
        let base = Tuning::default();
        let arsenal = Arsenal::new(&base);
        let (wisp, bulwark) = (Loadout::of(MechClass::A), Loadout::of(MechClass::C));
        assert_ne!(wisp, bulwark);
        // The Lancer's own weapons are tuning.json's.
        let lancer = arsenal.get(MechClass::B, Loadout::of(MechClass::B));
        assert_eq!((lancer.fire_rate, lancer.alt_damage), (base.fire_rate, base.alt_damage));
        // A Wisp body with the Bulwark's weapons: the Wisp's health, the flak and the mortar.
        let swapped = arsenal.get(MechClass::A, bulwark);
        let (own, heavy) = (arsenal.get(MechClass::A, wisp), arsenal.get(MechClass::C, bulwark));
        assert_eq!(swapped.health_max, own.health_max);
        assert_eq!((swapped.pellets, swapped.shot_speed, swapped.alt_bounce), (heavy.pellets, heavy.shot_speed, heavy.alt_bounce));
        assert_ne!(swapped.fire_rate, own.fire_rate);
    }

    #[test]
    fn out_of_range_loadouts_clamp() {
        let arsenal = Arsenal::new(&Tuning::default());
        let wild = arsenal.clamp(Loadout { primary: 200, secondary: 200 });
        assert!(usize::from(wild.primary) < arsenal.primaries && usize::from(wild.secondary) < arsenal.secondaries);
        let _ = arsenal.get(MechClass::C, Loadout { primary: 200, secondary: 200 });
    }

    #[test]
    #[should_panic(expected = "weapons.json does")]
    fn classes_cant_set_weapon_values() {
        let classes = serde_json::json!({ "A": { "overrides": { "fire_rate": 3 } } });
        Arsenal::with(&Tuning::default(), &classes, weapons_json());
    }
}
