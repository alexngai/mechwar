//! Weapons, items and loadouts. `weapons.json` lists the primaries and secondaries; each sets
//! tuning values in its slot's tuning.json group (`primary` or `secondary`) over tuning.json's
//! own, which are the Medium's weapons. A mech's tuning is tuning.json, then its class's
//! `classes.json` overrides (which set no weapon values), then its primary's and secondary's.
//! It also lists the items for the offensive and support slots (`item.rs`) and the abilities
//! (`ability.rs`), which set nothing: their values are tuning.json's, which a class may adjust.
//! An entry with `classes` fits only those classes; the rest fit every class.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Mech, MechClass, Tuning};

/// What a mech carries: indices into weapons.json's `primaries`, `secondaries`, `offensive`,
/// `support` and `abilities` lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Loadout {
    pub primary: u8,
    pub secondary: u8,
    pub offensive: u8,
    pub support: u8,
    pub ability: u8,
}

impl Loadout {
    /// `class`'s own weapons, items and ability, from classes.json's `weapons`.
    pub fn of(class: MechClass) -> Loadout {
        static OWN: OnceLock<[Loadout; 3]> = OnceLock::new();
        OWN.get_or_init(|| {
            MechClass::ALL.map(|class| {
                let mut own = Loadout::default();
                for slot in Slot::ALL {
                    let id = classes_json()[class.key()]["weapons"][slot.key()].as_str().expect("classes.json names each class's weapons, items and ability");
                    let at = slot.list(weapons_json()).iter().position(|w| w["id"] == id);
                    *own.get_mut(slot) = u8::try_from(at.unwrap_or_else(|| panic!("classes.json names unknown `{id}`"))).expect("under 256 a slot");
                }
                own
            })
        })[class.index()]
    }

    /// What's in `slot`: an index into its list.
    pub fn get(self, slot: Slot) -> u8 {
        match slot {
            Slot::Primary => self.primary,
            Slot::Secondary => self.secondary,
            Slot::Offensive => self.offensive,
            Slot::Support => self.support,
            Slot::Ability => self.ability,
        }
    }

    fn get_mut(&mut self, slot: Slot) -> &mut u8 {
        match slot {
            Slot::Primary => &mut self.primary,
            Slot::Secondary => &mut self.secondary,
            Slot::Offensive => &mut self.offensive,
            Slot::Support => &mut self.support,
            Slot::Ability => &mut self.ability,
        }
    }

    /// This loadout with `slot` holding `index`.
    pub fn with(mut self, slot: Slot, index: u8) -> Loadout {
        *self.get_mut(slot) = index;
        self
    }

    /// The weapons with ids `primary` and `secondary`, and the first items and ability.
    #[cfg(test)]
    pub(crate) fn named(primary: &str, secondary: &str) -> Loadout {
        Loadout::default().with(Slot::Primary, index(Slot::Primary, primary)).with(Slot::Secondary, index(Slot::Secondary, secondary))
    }
}

/// Where a weapon, item or ability goes: weapons.json's list for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Slot {
    Primary,
    Secondary,
    Offensive,
    Support,
    Ability,
}

impl Slot {
    pub const ALL: [Slot; 5] = [Slot::Primary, Slot::Secondary, Slot::Offensive, Slot::Support, Slot::Ability];

    /// The weapon slot, primary or not.
    pub fn weapon(primary: bool) -> Slot {
        if primary { Slot::Primary } else { Slot::Secondary }
    }

    pub fn from_index(i: u8) -> Option<Slot> {
        Self::ALL.get(usize::from(i)).copied()
    }

    /// Its key in classes.json's `weapons`; for a weapon, also the tuning.json group of the
    /// values it sets.
    fn key(self) -> &'static str {
        match self {
            Slot::Primary => "primary",
            Slot::Secondary => "secondary",
            Slot::Offensive => "offensive",
            Slot::Support => "support",
            Slot::Ability => "ability",
        }
    }

    /// This slot's list in `weapons` (weapons.json's format).
    fn list(self, weapons: &Value) -> &Vec<Value> {
        let key = match self {
            Slot::Primary => "primaries",
            Slot::Secondary => "secondaries",
            Slot::Offensive => "offensive",
            Slot::Support => "support",
            Slot::Ability => "abilities",
        };
        weapons[key].as_array().filter(|list| !list.is_empty()).unwrap_or_else(|| panic!("weapons.json needs {key}"))
    }
}

/// Index of the weapon or item with id `id` in `slot`'s list.
pub(crate) fn index(slot: Slot, id: &str) -> u8 {
    slot.list(weapons_json()).iter().position(|w| w["id"] == id).unwrap_or_else(|| panic!("no `{id}` in {slot:?}")) as u8
}

/// Tuning for every class with every loadout, built up front: mechs and projectiles look theirs
/// up every tick.
#[derive(Clone, Debug)]
pub struct Arsenal {
    primaries: usize,
    secondaries: usize,
    /// How many offensive and support items, and abilities, there are.
    items: [usize; 3],
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
        let items = [Slot::Offensive, Slot::Support, Slot::Ability].map(|slot| slot.list(weapons).len());
        Self { primaries: primaries.len(), secondaries: secondaries.len(), items, tunings }
    }

    pub fn get(&self, class: MechClass, loadout: Loadout) -> &Tuning {
        let Loadout { primary, secondary, .. } = self.clamp(loadout);
        &self.tunings[(class.index() * self.primaries + usize::from(primary)) * self.secondaries + usize::from(secondary)]
    }

    /// Mech `m`'s tuning.
    pub fn of(&self, m: &Mech) -> &Tuning {
        self.get(m.class, m.loadout)
    }

    /// How many primaries and secondaries there are to pick from.
    pub fn counts(&self) -> (usize, usize) {
        (self.primaries, self.secondaries)
    }

    /// `loadout` with each index in range: clients may send anything.
    pub fn clamp(&self, loadout: Loadout) -> Loadout {
        let last = |n: usize| u8::try_from(n - 1).unwrap_or(u8::MAX);
        Loadout {
            primary: loadout.primary.min(last(self.primaries)),
            secondary: loadout.secondary.min(last(self.secondaries)),
            offensive: loadout.offensive.min(last(self.items[0])),
            support: loadout.support.min(last(self.items[1])),
            ability: loadout.ability.min(last(self.items[2])),
        }
    }
}

/// `values` with `overrides` (an object of numbers; anything else sets nothing) applied. A
/// weapon's (`slot`) may only set its slot's group; a class's (None) may set no weapon's.
fn merge(values: &Value, overrides: &Value, slot: Option<Slot>) -> Value {
    let mut merged = values.clone();
    for (name, value) in overrides.as_object().into_iter().flatten() {
        let group = groups().get(name).and_then(Value::as_str).unwrap_or_else(|| panic!("`{name}` is not a tuning value"));
        match slot {
            Some(slot) => assert!(group == slot.key(), "a {} weapon can't set `{name}` ({group})", slot.key()),
            None => assert!(group != "primary" && group != "secondary", "classes.json can't set weapon value `{name}`; weapons.json does"),
        }
        merged[name] = value.clone();
    }
    merged
}

/// The id and unlock price (weapons.json's `id` and `unlock`) of the weapon, item or ability in
/// `slot` at `index` into its list; None past the end.
pub fn weapon(slot: Slot, index: u8) -> Option<(&'static str, u32)> {
    let w = slot.list(weapons_json()).get(usize::from(index))?;
    Some((w["id"].as_str().unwrap_or_default(), w["unlock"].as_u64().map_or(0, |p| p as u32)))
}

/// Whether `class` may carry the entry at `index` in `slot`'s list: it's there, and its
/// `classes`, if it lists any, include `class`.
pub fn fits(class: MechClass, slot: Slot, index: u8) -> bool {
    slot.list(weapons_json()).get(usize::from(index)).is_some_and(|w| w["classes"].as_array().is_none_or(|c| c.iter().any(|k| k == class.key())))
}

/// The unlock price of the weapon, item or ability with id `id` (0 for none).
pub fn price(id: &str) -> u32 {
    Slot::ALL.iter().flat_map(|s| s.list(weapons_json())).find(|w| w["id"] == id).and_then(|w| w["unlock"].as_u64()).map_or(0, |p| p as u32)
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
        // A Medium with the rifle and rocket is tuning.json as it stands.
        let lancer = arsenal.get(MechClass::B, Loadout::named("pike", "rocket"));
        assert_eq!((lancer.fire_rate, lancer.alt_damage), (base.fire_rate, base.alt_damage));
        // A Light body with the Heavy's weapons: the Light's health, the flak and the grenade launcher.
        let swapped = arsenal.get(MechClass::A, bulwark);
        let (own, heavy) = (arsenal.get(MechClass::A, wisp), arsenal.get(MechClass::C, bulwark));
        assert_eq!(swapped.health_max, own.health_max);
        assert_eq!((swapped.pellets, swapped.shot_speed, swapped.alt_bounce), (heavy.pellets, heavy.shot_speed, heavy.alt_bounce));
        assert_ne!(swapped.fire_rate, own.fire_rate);
    }

    #[test]
    fn out_of_range_loadouts_clamp() {
        let arsenal = Arsenal::new(&Tuning::default());
        let wild = arsenal.clamp(Loadout { primary: 200, secondary: 200, offensive: 200, support: 200, ability: 200 });
        assert!(usize::from(wild.primary) < arsenal.primaries && usize::from(wild.secondary) < arsenal.secondaries);
        assert!(usize::from(wild.offensive) < arsenal.items[0] && usize::from(wild.support) < arsenal.items[1] && usize::from(wild.ability) < arsenal.items[2]);
        let _ = arsenal.get(MechClass::C, Loadout { primary: 200, secondary: 200, offensive: 200, support: 200, ability: 200 });
    }

    #[test]
    #[should_panic(expected = "weapons.json does")]
    fn classes_cant_set_weapon_values() {
        let classes = serde_json::json!({ "A": { "overrides": { "fire_rate": 3 } } });
        Arsenal::with(&Tuning::default(), &classes, weapons_json());
    }
}
