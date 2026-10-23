//! A pilot's progression: the lifetime record the server signs and the browser keeps (see
//! server/src/main.rs), the tally of one match that's added to it, and the XP and level math.
//!
//! Records carry a format version and a random guest id, so a later server database can take a
//! verified record as a player's first row as it is.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The record format; bump when a field changes meaning.
pub const RECORD_VERSION: u8 = 1;

/// XP for a kill (a bot's is worth a quarter), and an assist earns the killer's XP times its
/// share of the damage; per hit point healed on a teammate; for being there at a match's end,
/// and for winning it.
pub const KILL_XP: f32 = 100.0;
pub const BOT_KILL_XP: f32 = 25.0;
pub const HEAL_XP: f32 = 0.5;
pub const MATCH_XP: u32 = 100;
pub const WIN_XP: u32 = 150;
/// Assists count for whoever dealt at least this share of a victim's damage (the killer aside).
pub const ASSIST_SHARE: f32 = 0.15;
/// Levels top out here.
pub const MAX_LEVEL: u32 = 99;

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
        for (weapon, n) in &other.weapon_kills {
            *self.weapon_kills.entry(weapon.clone()).or_default() += n;
        }
    }
}

/// One player's match so far: counts, plus the damage shares behind its assists (on humans and
/// on bots) and the exact healing, which its XP comes from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tally {
    pub stats: Stats,
    pub assist_share: f32,
    pub bot_assist_share: f32,
    pub healed: f32,
}

impl Tally {
    /// A kill of a human or a bot, with `weapon` (an id) if known.
    pub fn kill(&mut self, weapon: Option<&str>, bot: bool) {
        if bot {
            self.stats.bot_kills += 1;
        } else {
            self.stats.kills += 1;
        }
        if let Some(weapon) = weapon {
            *self.stats.weapon_kills.entry(weapon.into()).or_default() += 1;
        }
    }

    /// An assist on a human or a bot, for dealing `share` of its damage.
    pub fn assist(&mut self, share: f32, bot: bool) {
        if bot {
            (self.stats.bot_assists, self.bot_assist_share) = (self.stats.bot_assists + 1, self.bot_assist_share + share);
        } else {
            (self.stats.assists, self.assist_share) = (self.stats.assists + 1, self.assist_share + share);
        }
    }
}

/// A match's XP, by source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatchXp {
    pub kills: u32,
    pub assists: u32,
    pub healing: u32,
    pub completion: u32,
    pub win: u32,
}

impl MatchXp {
    pub fn total(&self) -> u32 {
        self.kills + self.assists + self.healing + self.completion + self.win
    }
}

/// XP for `tally`, plus the completion bonus if the player saw the match out, and the win bonus.
pub fn match_xp(tally: &Tally, completed: bool, won: bool) -> MatchXp {
    let s = &tally.stats;
    MatchXp {
        kills: (KILL_XP * s.kills as f32 + BOT_KILL_XP * s.bot_kills as f32).round() as u32,
        assists: (KILL_XP * tally.assist_share + BOT_KILL_XP * tally.bot_assist_share).round() as u32,
        healing: (HEAL_XP * tally.healed).round() as u32,
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
/// level it makes, their counts, and when the server last issued it (unix seconds).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub version: u8,
    /// 16 hex digits (a string, so JavaScript keeps every bit).
    pub id: String,
    pub callsign: String,
    pub xp: u32,
    pub level: u32,
    pub stats: Stats,
    pub issued: u64,
}

impl Record {
    /// A fresh guest with random id `id`.
    pub fn guest(id: u64, callsign: &str) -> Record {
        Record { version: RECORD_VERSION, id: format!("{id:016x}"), callsign: callsign.into(), xp: 0, level: 1, stats: Stats::default(), issued: 0 }
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
        t.kill(Some("pike"), false);
        t.kill(Some("pike"), true);
        t.kill(Some("grenade"), true);
        t.assist(0.5, false);
        t.assist(0.4, true);
        t.healed = 61.0;
        t.stats.deaths = 2;
        let xp = match_xp(&t, true, true);
        assert_eq!(xp, MatchXp { kills: 150, assists: 60, healing: 31, completion: 100, win: 150 });
        assert_eq!(xp.total(), 491);
        // Left mid-match: no completion or win.
        assert_eq!(match_xp(&t, false, true).total(), 241);
        assert_eq!(t.stats.weapon_kills, BTreeMap::from([("grenade".into(), 1), ("pike".into(), 2)]));
    }

    #[test]
    fn a_match_adds_to_the_record() {
        let base = Record::guest(0xabc, "Ace");
        assert_eq!(base.id, "0000000000000abc");
        let mut t = Tally::default();
        for _ in 0..5 {
            t.kill(Some("pike"), false);
        }
        t.healed = 10.4;
        let (next, xp) = base.with(&t, true, false);
        assert_eq!(xp.total(), 500 + 5 + 100);
        assert_eq!((next.xp, next.level, next.stats.kills, next.stats.matches, next.stats.wins, next.stats.healing), (605, 2, 5, 1, 0, 10));
        // Another, won: the counts and XP keep adding up.
        let (after, _) = next.with(&t, true, true);
        assert_eq!((after.stats.kills, after.stats.matches, after.stats.wins, after.stats.weapon_kills["pike"]), (10, 2, 1, 10));
    }
}
