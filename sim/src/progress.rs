//! A pilot's progression: the lifetime record the server signs and the browser keeps (see
//! server/src/main.rs), the tally of one match that's added to it, the XP and level math, and
//! the weapons and items it unlocks. Each mech starts with its own two weapons and two items
//! (classes.json's `weapons`) and a few more (its `unlocked`); levels earn points that unlock the
//! rest, mech by mech, at weapons.json's `unlock` prices.
//!
//! Records carry a format version and a random guest id, so a later server database can take a
//! verified record as a player's first row as it is.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{Loadout, MechClass, Slot, arsenal};

/// The record format; bump when a field changes meaning.
pub const RECORD_VERSION: u8 = 1;

/// XP for a kill (a bot's is worth a quarter), shared out as kill credit (`KILLER_BONUS`); per hit
/// point healed on a teammate; for being there at a match's end, and for winning it.
pub const KILL_XP: f32 = 100.0;
pub const BOT_KILL_XP: f32 = 25.0;
pub const HEAL_XP: f32 = 0.5;
pub const MATCH_XP: u32 = 100;
pub const WIN_XP: u32 = 150;
/// XP for each capture of an objective, to every mech in on it; for each EU banked in Siege, and
/// each point of hull shot off an enemy battleship.
pub const CAPTURE_XP: f32 = 50.0;
pub const EU_XP: f32 = 0.5;
pub const SHIP_XP: f32 = 0.05;
/// Kill credit: everyone who damaged a victim lately gets their share of that damage, and the
/// killer this much more, so a solo kill is worth 1.25 kills and a stolen one little.
pub const KILLER_BONUS: f32 = 0.25;
/// Whoever dealt at least this share of a victim's damage (the killer aside) is told of their
/// assist and has it counted; a smaller share still earns its credit.
pub const ASSIST_SHARE: f32 = 0.15;
/// Levels top out here.
pub const MAX_LEVEL: u32 = 99;
/// Unlock points each level past the first earns.
pub const POINTS_PER_LEVEL: u32 = 3;

/// Counts kept across matches. Kills and assists on humans and on bots are kept apart; healing
/// is hit points mended on teammates; weapon kills (humans and bots alike) are by weapon id,
/// with `grenade` for the item.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stats {
    pub matches: u32,
    pub wins: u32,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub bot_kills: u32,
    pub bot_assists: u32,
    pub healing: u32,
    pub weapon_kills: BTreeMap<String, u32>,
    /// Objectives taken (silos).
    pub captures: u32,
}

impl Stats {
    fn add(&mut self, other: &Stats) {
        self.matches += other.matches;
        self.wins += other.wins;
        self.kills += other.kills;
        self.deaths += other.deaths;
        self.assists += other.assists;
        self.bot_kills += other.bot_kills;
        self.bot_assists += other.bot_assists;
        self.healing += other.healing;
        self.captures += other.captures;
        for (weapon, n) in &other.weapon_kills {
            *self.weapon_kills.entry(weapon.clone()).or_default() += n;
        }
    }
}

/// One player's match so far: counts, plus the kill credit behind its kills and assists (on
/// humans and on bots) and the exact healing, which its XP comes from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tally {
    pub stats: Stats,
    pub kill_credit: f32,
    pub bot_kill_credit: f32,
    pub assist_share: f32,
    pub bot_assist_share: f32,
    pub healed: f32,
    /// XP from objectives: captures, energy banked, ships shot.
    pub objective_xp: f32,
}

impl Tally {
    /// A kill of a human or a bot, with `weapon` (an id) if known, earning `credit` (the
    /// killer's share of the damage plus `KILLER_BONUS`).
    pub fn kill(&mut self, weapon: Option<&str>, bot: bool, credit: f32) {
        if bot {
            (self.stats.bot_kills, self.bot_kill_credit) = (self.stats.bot_kills + 1, self.bot_kill_credit + credit);
        } else {
            (self.stats.kills, self.kill_credit) = (self.stats.kills + 1, self.kill_credit + credit);
        }
        if let Some(weapon) = weapon {
            *self.stats.weapon_kills.entry(weapon.into()).or_default() += 1;
        }
    }

    /// A hand in killing a human or a bot, for dealing `share` of its damage: whether that's
    /// enough to count as an assist (`ASSIST_SHARE`).
    pub fn assist(&mut self, share: f32, bot: bool) -> bool {
        let counts = share >= ASSIST_SHARE;
        if bot {
            (self.stats.bot_assists, self.bot_assist_share) = (self.stats.bot_assists + u32::from(counts), self.bot_assist_share + share);
        } else {
            (self.stats.assists, self.assist_share) = (self.stats.assists + u32::from(counts), self.assist_share + share);
        }
        counts
    }

    /// In on taking an objective.
    pub fn capture(&mut self) {
        self.stats.captures += 1;
        self.objective_xp += CAPTURE_XP;
    }

    /// Banked `eu` in Siege.
    pub fn bank(&mut self, eu: f32) {
        self.objective_xp += EU_XP * eu;
    }

    /// Shot `hull` off an enemy battleship.
    pub fn hit_ship(&mut self, hull: f32) {
        self.objective_xp += SHIP_XP * hull;
    }
}

/// A match's XP, by source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatchXp {
    pub kills: u32,
    pub assists: u32,
    pub healing: u32,
    #[serde(default)]
    pub objectives: u32,
    pub completion: u32,
    pub win: u32,
}

impl MatchXp {
    pub fn total(&self) -> u32 {
        self.kills + self.assists + self.healing + self.objectives + self.completion + self.win
    }
}

/// XP for `tally`, plus the completion bonus if the player saw the match out, and the win bonus.
pub fn match_xp(tally: &Tally, completed: bool, won: bool) -> MatchXp {
    MatchXp {
        kills: (KILL_XP * tally.kill_credit + BOT_KILL_XP * tally.bot_kill_credit).round() as u32,
        assists: (KILL_XP * tally.assist_share + BOT_KILL_XP * tally.bot_assist_share).round() as u32,
        healing: (HEAL_XP * tally.healed).round() as u32,
        objectives: tally.objective_xp.round() as u32,
        completion: if completed { MATCH_XP } else { 0 },
        win: if completed && won { WIN_XP } else { 0 },
    }
}

/// The level `xp` reaches: level n takes 250·n·(n-1) XP in all (0, 500, 1500, 3000, 5000…).
pub fn level(xp: u32) -> u32 {
    (1..MAX_LEVEL).take_while(|&n| level_xp(n + 1) <= xp).last().map_or(1, |n| n + 1)
}

/// Total XP level `n` starts at.
pub fn level_xp(n: u32) -> u32 {
    250 * n * (n - 1)
}

/// A pilot's lifetime record: who (a random guest id, and their callsign), their XP and the
/// level it makes, their counts, the weapons and items they've unlocked (ids by mech: `A`, `B`,
/// `C`), and when the server last issued it (unix seconds).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub version: u8,
    /// 16 hex digits (a string, so JavaScript keeps every bit).
    pub id: String,
    pub callsign: String,
    pub xp: u32,
    pub level: u32,
    pub stats: Stats,
    #[serde(default)]
    pub unlocks: BTreeMap<String, Vec<String>>,
    pub issued: u64,
}

impl Record {
    /// A fresh guest with random id `id`.
    pub fn guest(id: u64, callsign: &str) -> Record {
        Record { version: RECORD_VERSION, id: format!("{id:016x}"), callsign: callsign.into(), xp: 0, level: 1, stats: Stats::default(), unlocks: BTreeMap::new(), issued: 0 }
    }

    /// This record with `tally`'s match added (completed or not, won or not): the new record,
    /// and the XP it brought.
    pub fn with(&self, tally: &Tally, completed: bool, won: bool) -> (Record, MatchXp) {
        let gained = match_xp(tally, completed, won);
        let mut next = self.clone();
        next.stats.add(&tally.stats);
        next.stats.healing += tally.healed.round() as u32;
        if completed {
            next.stats.matches += 1;
            next.stats.wins += u32::from(won);
        }
        next.xp = next.xp.saturating_add(gained.total());
        next.level = level(next.xp);
        (next, gained)
    }

    /// Unlock points earned by level and not yet spent. Unlocks a mech now starts with are free.
    pub fn points(&self) -> u32 {
        let spent: u32 = self.unlocks.iter().flat_map(|(key, ids)| ids.iter().filter(|id| !arsenal::starts_unlocked(key, id))).map(|id| arsenal::price(id)).sum();
        (POINTS_PER_LEVEL * self.level.saturating_sub(1)).saturating_sub(spent)
    }

    /// Whether `class` may carry the weapon, item or ability at `index` in `slot`'s list: its own,
    /// or one that fits it (`arsenal::fits`) it starts with or has unlocked.
    pub fn owns(&self, class: MechClass, slot: Slot, index: u8) -> bool {
        index == Loadout::of(class).get(slot)
            || arsenal::fits(class, slot, index)
                && arsenal::weapon(slot, index).is_some_and(|(id, _)| {
                    arsenal::starts_unlocked(class.key(), id) || self.unlocks.get(class.key()).is_some_and(|ids| ids.iter().any(|u| u == id))
                })
    }

    /// `loadout` for `class`, with each weapon, item and ability this pilot doesn't own for it
    /// swapped for its own.
    pub fn allowed(&self, class: MechClass, loadout: Loadout) -> Loadout {
        let own = Loadout::of(class);
        Slot::ALL.into_iter().fold(loadout, |l, slot| if self.owns(class, slot, l.get(slot)) { l } else { l.with(slot, own.get(slot)) })
    }

    /// Spends points unlocking the weapon, item or ability at `index` in `slot`'s list for
    /// `class`. False, changing nothing, if there's no such thing, it doesn't fit the class, it's
    /// owned already or the points fall short.
    pub fn unlock(&mut self, class: MechClass, slot: Slot, index: u8) -> bool {
        let Some((id, price)) = arsenal::weapon(slot, index) else { return false };
        if !arsenal::fits(class, slot, index) || self.owns(class, slot, index) || price > self.points() {
            return false;
        }
        self.unlocks.entry(class.key().into()).or_default().push(id.into());
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_follow_the_curve() {
        assert_eq!([0, 499, 500, 1499, 1500, 3000, 4999, 5000].map(level), [1, 1, 2, 2, 3, 4, 4, 5]);
        assert_eq!(level(u32::MAX), MAX_LEVEL);
        assert_eq!((1..=MAX_LEVEL).map(|n| level(level_xp(n))).collect::<Vec<_>>(), (1..=MAX_LEVEL).collect::<Vec<_>>());
    }

    #[test]
    fn xp_weighs_humans_above_bots_and_counts_the_rest() {
        let mut t = Tally::default();
        t.kill(Some("pike"), false, 1.25);
        t.kill(Some("pike"), true, 1.25);
        t.kill(Some("grenade"), true, 0.75);
        assert!(t.assist(0.5, false));
        assert!(t.assist(0.4, true));
        // A sliver earns its credit, but isn't an assist.
        assert!(!t.assist(0.1, false));
        t.healed = 61.0;
        t.stats.deaths = 2;
        let xp = match_xp(&t, true, true);
        assert_eq!(xp, MatchXp { kills: 175, assists: 70, healing: 31, objectives: 0, completion: 100, win: 150 });
        assert_eq!(xp.total(), 526);
        assert_eq!((t.stats.kills, t.stats.bot_kills, t.stats.assists, t.stats.bot_assists), (1, 2, 1, 1));
        // Left mid-match: no completion or win.
        assert_eq!(match_xp(&t, false, true).total(), 276);
        assert_eq!(t.stats.weapon_kills, BTreeMap::from([("grenade".into(), 1), ("pike".into(), 2)]));
    }

    #[test]
    fn a_match_adds_to_the_record() {
        let base = Record::guest(0xabc, "Ace");
        assert_eq!(base.id, "0000000000000abc");
        let mut t = Tally::default();
        for _ in 0..5 {
            t.kill(Some("pike"), false, 1.0);
        }
        t.healed = 10.4;
        let (next, xp) = base.with(&t, true, false);
        assert_eq!(xp.total(), 500 + 5 + 100);
        assert_eq!((next.xp, next.level, next.stats.kills, next.stats.matches, next.stats.wins, next.stats.healing), (605, 2, 5, 1, 0, 10));
        // Another, won: the counts and XP keep adding up.
        let (after, _) = next.with(&t, true, true);
        assert_eq!((after.stats.kills, after.stats.matches, after.stats.wins, after.stats.weapon_kills["pike"]), (10, 2, 1, 10));
    }

    #[test]
    fn levels_earn_points_that_unlock_weapons_mech_by_mech() {
        let (light, heavy) = (MechClass::A, MechClass::C);
        let mut r = Record::guest(1, "Ace");
        let wanted = Loadout::named("pike", "spindle");
        let rail = wanted.secondary;
        // Each mech owns its own two weapons and the two more it starts with; nothing else until unlocked.
        let starts = [(light, "kiln", "darts"), (MechClass::B, "triplet", "spindle"), (heavy, "gyre", "furnace")];
        for (class, primary, secondary) in starts {
            let own = Loadout::of(class);
            let (primary, secondary) = (arsenal::index(Slot::Primary, primary), arsenal::index(Slot::Secondary, secondary));
            assert!([own.primary, primary].into_iter().all(|p| r.owns(class, Slot::Primary, p)));
            assert!([own.secondary, secondary].into_iter().all(|s| r.owns(class, Slot::Secondary, s)));
            assert!(!r.unlock(class, Slot::Primary, primary), "unlocked one it starts with");
        }
        assert!(!r.owns(light, Slot::Secondary, rail) && !r.owns(light, Slot::Primary, wanted.primary));
        assert_eq!(r.points(), 0);
        assert!(!r.unlock(light, Slot::Secondary, rail), "unlocked with no points");

        r.level = 2;
        assert_eq!(r.points(), POINTS_PER_LEVEL);
        assert!(r.unlock(light, Slot::Secondary, rail));
        assert_eq!(r.points(), POINTS_PER_LEVEL - arsenal::price("spindle"));
        assert!(!r.unlock(light, Slot::Secondary, rail), "unlocked twice");
        assert!(r.owns(light, Slot::Secondary, rail) && !r.owns(heavy, Slot::Secondary, rail), "an unlock is for one mech");
        // Locked weapons in a loadout fall back to the mech's own.
        assert_eq!(r.allowed(light, wanted), Loadout { primary: Loadout::of(light).primary, secondary: rail, ..Loadout::of(light) });
        assert_eq!(r.allowed(heavy, wanted), Loadout::of(heavy));
        assert!(!r.unlock(heavy, Slot::Primary, 200), "no such weapon");
    }

    #[test]
    fn items_unlock_mech_by_mech_with_the_same_points() {
        let (light, heavy) = (MechClass::A, MechClass::C);
        let (limpet, smoke, orb) = (arsenal::index(Slot::Offensive, "limpet"), arsenal::index(Slot::Offensive, "smoke"), arsenal::index(Slot::Support, "orb"));
        let mut r = Record::guest(1, "Ace");
        // Every mech starts with the Tumbler and the Brownout, and owns no other item.
        for class in MechClass::ALL {
            let own = Loadout::of(class);
            assert_eq!((own.offensive, own.support), (arsenal::index(Slot::Offensive, "grenade"), arsenal::index(Slot::Support, "emp")));
            assert!(r.owns(class, Slot::Offensive, own.offensive) && r.owns(class, Slot::Support, own.support));
            assert!(!r.owns(class, Slot::Offensive, limpet) && !r.owns(class, Slot::Offensive, smoke) && !r.owns(class, Slot::Support, orb));
        }
        let wanted = Loadout { offensive: limpet, support: orb, ..Loadout::of(light) };
        assert_eq!(r.allowed(light, wanted), Loadout::of(light), "carried locked items");

        // Weapons and items spend the same points, and the record keeps their ids side by side.
        r.level = 3;
        assert!(r.unlock(light, Slot::Secondary, arsenal::index(Slot::Secondary, "spindle")));
        assert!(r.unlock(light, Slot::Support, orb));
        assert_eq!(r.points(), 2 * POINTS_PER_LEVEL - arsenal::price("spindle") - arsenal::price("orb"));
        assert_eq!(r.unlocks["A"], ["spindle", "orb"]);
        assert!(!r.unlock(light, Slot::Support, orb), "unlocked twice");
        assert!(r.owns(light, Slot::Support, orb) && !r.owns(heavy, Slot::Support, orb), "an unlock is for one mech");
        assert_eq!(r.allowed(light, wanted), Loadout { support: orb, ..Loadout::of(light) });
        assert!(!r.unlock(light, Slot::Offensive, limpet), "unlocked past the points left");
        assert!(!r.unlock(light, Slot::Support, 200), "no such item");
    }

    #[test]
    fn abilities_fit_their_classes_and_unlock_like_items() {
        let (light, medium, heavy) = (MechClass::A, MechClass::B, MechClass::C);
        let (cloak, power) = (arsenal::index(Slot::Ability, "cloak"), arsenal::index(Slot::Ability, "power"));
        let mut r = Record { level: 3, ..Record::guest(1, "Ace") };
        // Each mech starts with its own ability, which fits it, and owns no other.
        for class in MechClass::ALL {
            let own = Loadout::of(class).ability;
            assert!(arsenal::fits(class, Slot::Ability, own) && r.owns(class, Slot::Ability, own));
            assert!(!r.owns(class, Slot::Ability, power));
        }
        // One that doesn't fit the class can't be unlocked or carried, points or not.
        assert!(!r.unlock(heavy, Slot::Ability, cloak), "unlocked one that doesn't fit");
        assert!(r.unlock(light, Slot::Ability, power) && r.unlock(medium, Slot::Ability, power));
        assert_eq!(r.allowed(light, Loadout { ability: power, ..Loadout::of(light) }).ability, power);
        assert_eq!(r.allowed(heavy, Loadout { ability: power, ..Loadout::of(heavy) }).ability, Loadout::of(heavy).ability);
        // Nor one a record somehow holds for a class it doesn't fit (say, refit since).
        r.unlocks.entry("C".into()).or_default().push("cloak".into());
        assert!(!r.owns(heavy, Slot::Ability, cloak));
    }

    #[test]
    fn records_from_before_unlocks_still_read() {
        let old = r#"{"version":1,"id":"00000000000000ab","callsign":"Ace","xp":600,"level":2,"stats":{"matches":1},"issued":5}"#;
        let r: Record = serde_json::from_str(old).unwrap();
        assert_eq!((r.unlocks.len(), r.points()), (0, POINTS_PER_LEVEL));
        // Points spent on one a mech has since started with come back.
        let bought = Record { level: 2, unlocks: [("A".to_string(), vec!["kiln".to_string()])].into(), ..Record::guest(1, "Ace") };
        assert_eq!(bought.points(), POINTS_PER_LEVEL);
    }
}
