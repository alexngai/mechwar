//! Balance runner: plays a job's bot-only matches on every core and prints a CSV row per player
//! per match. `balance/evolve.py` writes the jobs and reads the rows.
//!
//!   cargo run --release -p sim --bin arena -- job.json > rows.csv
//!   cargo run --release -p sim --bin arena -- --policy     (today's policy, as JSON)
//!   cargo run --release -p sim --bin arena -- --brain      (genome 0's brain, as JSON)
//!
//! A job: `{"mode": "tdm", "seconds": 120, "skill": 0.5, "ideal": false,
//!   "genomes": {"base": {}, "x": {"class": "A", "build": {"primary": "pike", ...}, "policy": {...}}},
//!   "matches": [{"map": "foundry", "seed": 1, "teams": [["x", "base", ...], [...]]}]}`.
//! A genome without a class takes one at random per seat; without a build, one per life. A
//! match may set where each seat starts and its hull (`at`, `hull`): a drill.
//!
//! Stat tweaks, all optional: `"tuning": {"grenade_radius": 5}` sets tuning.json values (items,
//! abilities, movement; a class or weapon that sets the same value keeps its own),
//! `"classes": {"B": {"health_max": 110}}` classes.json overrides, and
//! `"weapons": {"rocket": {"alt_radius": 6.4}}` weapons.json stats.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

use serde::Deserialize;
use serde_json::{Map, Value};
use sim::bot::{Bot, Policy};
use sim::brain::Brain;
use sim::game::{Game, Mode};
use sim::{Arsenal, Loadout, MechClass, Slot, TICK_HZ, Tuning, arsenal, map};

#[derive(Deserialize)]
struct Job {
    #[serde(default = "tdm")]
    mode: String,
    #[serde(default = "two_minutes")]
    seconds: f32,
    #[serde(default = "half")]
    skill: f32,
    /// No aim error, reaction lag or turn cap.
    #[serde(default)]
    ideal: bool,
    genomes: BTreeMap<String, Genome>,
    matches: Vec<Match>,
    #[serde(default)]
    tuning: Map<String, Value>,
    #[serde(default)]
    classes: Value,
    #[serde(default)]
    weapons: Value,
}

fn tdm() -> String {
    "tdm".into()
}
fn two_minutes() -> f32 {
    120.0
}
fn half() -> f32 {
    0.5
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Genome {
    class: Option<MechClass>,
    build: Option<Build>,
    policy: Policy,
    /// When it uses items and abilities; genome 0's when left out.
    brain: Option<Brain>,
}

/// A build by weapons.json ids.
#[derive(Deserialize, Clone)]
struct Build {
    primary: String,
    secondary: String,
    offensive: String,
    support: String,
    ability: String,
}

#[derive(Deserialize)]
struct Match {
    map: String,
    seed: u64,
    teams: [Vec<String>; 2],
    /// A drill's set-up, seat by seat (team 0's, then team 1's): where each starts, and with what
    /// share of its hull (full when left out).
    #[serde(default)]
    at: Vec<[f32; 3]>,
    #[serde(default)]
    hull: Vec<f32>,
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| fail("usage: arena <job.json> | --policy"));
    if arg == "--policy" {
        println!("{}", serde_json::to_string(&Policy::default()).expect("policy serializes"));
        return;
    }
    if arg == "--brain" {
        println!("{}", serde_json::to_string(&Brain::default()).expect("brain serializes"));
        return;
    }
    let job: Job = serde_json::from_str(&std::fs::read_to_string(&arg).unwrap_or_else(|e| fail(&format!("{arg}: {e}")))).unwrap_or_else(|e| fail(&format!("{arg}: {e}")));
    let mode = Mode::from_key(&job.mode).filter(|m| *m != Mode::Deathmatch).unwrap_or_else(|| fail("mode: tdm, ma or siege"));
    for m in &job.matches {
        let index = map_index(&m.map);
        if !mode.fits(&map::Map::load(index)) {
            fail(&format!("{} doesn't play {}", m.map, job.mode));
        }
        for id in m.teams.iter().flatten() {
            let g = job.genomes.get(id).unwrap_or_else(|| fail(&format!("no genome {id}")));
            if let Some(b) = &g.build {
                loadout(g.class.unwrap_or_else(|| fail(&format!("genome {id} has a build but no class"))), b);
            }
        }
    }
    let mut tuning = Tuning::default();
    if job.ideal {
        (tuning.bot_aim_error_deg, tuning.bot_reaction_s, tuning.bot_turn_rate_deg) = (0.0, 0.0, 720.0);
        (tuning.bot_lead_error, tuning.bot_range_error) = (0.0, 0.0);
    }
    let mut values = serde_json::to_value(&tuning).expect("tuning serializes");
    for (name, value) in &job.tuning {
        if values.get(name).is_none() {
            fail(&format!("no tuning value {name}"));
        }
        values[name] = value.clone();
    }
    let tuning: Tuning = serde_json::from_value(values).unwrap_or_else(|e| fail(&format!("tuning: {e}")));
    let arsenal = Arsenal::tweaked(&tuning, &job.classes, &job.weapons);

    println!("match,map,seed,team,genome,class,primary,secondary,offensive,support,ability,kills,deaths,assists,dealt,taken,result,score,opp_score,seconds,uses_primary,uses_secondary,uses_offensive,uses_support,uses_ability,dealt_primary,dealt_secondary,dealt_offensive,dealt_support,dealt_ability,s_fight,s_fall_back,s_mend,s_move");
    let next = AtomicUsize::new(0);
    let (tx, rx) = mpsc::channel();
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..workers {
            let (tx, next, job, arsenal) = (tx.clone(), &next, &job, &arsenal);
            s.spawn(move || {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(m) = job.matches.get(i) else { break };
                    tx.send((i, play(job, mode, arsenal, i, m))).expect("main thread waits");
                }
            });
        }
        drop(tx);
        // Rows in match order, so the same job prints the same file.
        let mut done: BTreeMap<usize, String> = BTreeMap::new();
        let mut printed = 0;
        for (i, rows) in rx {
            done.insert(i, rows);
            while let Some(rows) = done.remove(&printed) {
                print!("{rows}");
                printed += 1;
            }
        }
    });
}

/// Plays match `i` to its end: its CSV rows.
fn play(job: &Job, mode: Mode, arsenal: &Arsenal, i: usize, m: &Match) -> String {
    let mut game = Game::with_arsenal(arsenal.clone(), map_index(&m.map));
    (game.headless, game.mode, game.match_seconds) = (true, mode, job.seconds);
    let mut seated = Vec::new();
    for (team, ids) in m.teams.iter().enumerate() {
        for (slot, id) in ids.iter().enumerate() {
            let g = &job.genomes[id];
            let seed = mix(m.seed.wrapping_mul(16).wrapping_add((team * 8 + slot) as u64));
            let class = g.class.unwrap_or(MechClass::ALL[(seed >> 33) as usize % 3]);
            let mut bot = Bot::new(seed);
            (bot.skill, bot.policy) = (job.skill, g.policy.clone());
            bot.brain = g.brain.clone().unwrap_or_default();
            bot.build = g.build.as_ref().map(|b| loadout(class, b));
            // A role for the first life under this policy.
            bot.respawned();
            let id_in_game = game.add_bot(team as u8, bot, class).unwrap_or_else(|| fail("more than four a team"));
            seated.push((id_in_game, team, id.as_str(), class, g.build.clone()));
        }
    }
    // Each faces the middle of the other side's spots.
    let side = |team: usize| {
        let spots: Vec<sim::Vector> = m.at.iter().zip(&seated).filter(|(_, s)| s.1 == team).map(|(a, _)| sim::Vector::from_array(*a)).collect();
        spots.iter().copied().sum::<sim::Vector>() / spots.len().max(1) as f32
    };
    for (k, spot) in m.at.iter().enumerate() {
        let (id, team, ..) = *seated.get(k).unwrap_or_else(|| fail("more spots than seats"));
        game.place(id, sim::Vector::from_array(*spot), side(1 - team), m.hull.get(k).copied().unwrap_or(1.0));
    }
    let limit = (job.seconds * TICK_HZ) as u32 + 1;
    while !game.match_state().ended && game.tick < limit {
        game.step();
    }
    let state = game.match_state();
    let mut rows = String::new();
    for (id, team, genome, class, build) in seated {
        let (tally, _) = game.tally(id).expect("seated");
        let s = &tally.stats;
        let result = match state.winner {
            Some(w) if usize::from(w) == team => 1.0,
            Some(_) => 0.0,
            None => 0.5,
        };
        let b = build.map_or_else(|| ["random"; 5].join(","), |b| [b.primary, b.secondary, b.offensive, b.support, b.ability].join(","));
        rows += &format!(
            "{i},{},{},{team},{genome},{class:?},{b},{},{},{},{:.1},{:.1},{result},{},{},{:.1},{},{},{}\n",
            m.map,
            m.seed,
            s.kills + s.bot_kills,
            s.deaths,
            s.assists + s.bot_assists,
            tally.dealt,
            tally.taken,
            state.scores[team],
            state.scores[1 - team],
            game.tick as f32 / TICK_HZ,
            tally.uses.map(|n| n.to_string()).join(","),
            tally.dealt_by.map(|d| format!("{d:.1}")).join(","),
            tally.doing.map(|n| n as f32 / TICK_HZ).iter().map(|s| format!("{s:.1}")).collect::<Vec<_>>().join(","),
        );
    }
    rows
}

/// `build` as a loadout for `class`, or exits naming what's wrong.
fn loadout(class: MechClass, b: &Build) -> Loadout {
    let index = |slot: Slot, id: &str| (0..).map_while(|i| arsenal::weapon(slot, i).map(|(w, _)| (i, w))).find(|(_, w)| *w == id).map(|(i, _)| i).unwrap_or_else(|| fail(&format!("no {slot:?} {id}")));
    let l = Loadout {
        primary: index(Slot::Primary, &b.primary),
        secondary: index(Slot::Secondary, &b.secondary),
        offensive: index(Slot::Offensive, &b.offensive),
        support: index(Slot::Support, &b.support),
        ability: index(Slot::Ability, &b.ability),
    };
    for slot in Slot::ALL {
        if !arsenal::fits(class, slot, l.get(slot)) {
            fail(&format!("{class:?} can't take its {slot:?}"));
        }
    }
    l
}

fn map_index(name: &str) -> usize {
    map::Map::index(name).unwrap_or_else(|| fail(&format!("no map {name}")))
}

/// splitmix64: well-spread bot seeds from a match seed and a seat.
fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn fail(why: &str) -> ! {
    eprintln!("arena: {why}");
    std::process::exit(2)
}
