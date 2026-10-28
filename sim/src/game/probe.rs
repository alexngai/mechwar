//! Stuck probe: bot-only matches on every map, logging each bot that stays within 2 m for 5 s or
//! more, sorted by why (pushing but not moving, repairing, perched, or standing about), and the
//! share of bot time spent so. A diagnostic, not a check (`--ignored`):
//! PROBE_MAP=<name> PROBE_MODE=<key> PROBE_SECS=<s> PROBE_SEEDS=<n> PROBE_SHOW=<kind|all|none> \
//!   cargo test -p sim --release --lib stuck_probe -- --ignored --nocapture

use std::collections::BTreeMap;

use super::*;

struct Episode {
    from: u32,
    at: Vector,
    note: Option<String>,
    kind: &'static str,
}

#[test]
#[ignore = "probe"]
fn stuck_probe() {
    let only = std::env::var("PROBE_MAP").ok();
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(180.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let window = secs(5.0);
    for (index, (name, _)) in crate::map::MAPS.iter().enumerate() {
        if only.as_deref().is_some_and(|m| m != *name) {
            continue;
        }
        let (mut alive_ticks, mut stuck_ticks, mut episodes) = (0u64, 0u64, 0);
        let mut kinds: BTreeMap<&str, f32> = BTreeMap::new();
        for seed in 0..seeds {
            let mut game = Game::new(Tuning::default(), index);
            if let Some(mode) = std::env::var("PROBE_MODE").ok().and_then(|m| Mode::from_key(&m)) {
                game.mode = mode;
            }
            (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
            let human = game.join().unwrap();
            game.dock(human);
            let mut open: BTreeMap<u8, Episode> = BTreeMap::new();
            for _ in 0..secs(run) {
                game.step();
                for p in &game.players {
                    let Some(bot) = &p.bot else { continue };
                    let alive = p.mech.health > 0.0 && p.respawn_at.is_none();
                    let moved = open.get(&p.id).is_none_or(|e| flat(p.mech.pos - e.at).length() > 2.0);
                    if alive {
                        alive_ticks += 1;
                    }
                    if !alive || moved {
                        if let Some(e) = open.remove(&p.id)
                            && let Some(note) = e.note
                        {
                            let held = game.tick - e.from;
                            stuck_ticks += u64::from(held);
                            episodes += 1;
                            *kinds.entry(e.kind).or_insert(0.0) += held as f32 / TICK_HZ;
                            if verbose(e.kind) {
                                println!("[{name} s{seed}] {} bot {} stuck {:.1}s {}{note}", e.kind, p.id, held as f32 / TICK_HZ, if alive { "" } else { "(died) " });
                            }
                        }
                        if alive {
                            open.insert(p.id, Episode { from: game.tick, at: p.mech.pos, note: None, kind: "" });
                        }
                        continue;
                    }
                    let e = open.get_mut(&p.id).unwrap();
                    if game.tick - e.from == window {
                        let t = game.arsenal.of(&p.mech);
                        let i = &bot.last;
                        let focus = bot.focus().and_then(|f| game.players.iter().find(|q| q.id == f));
                        let target = focus.map(|q| {
                            format!("target {} at {:.0}m sees={}", q.id, flat(q.mech.pos - p.mech.pos).length(), bot::sees(&game.arena, t, &p.mech, &q.mech))
                        });
                        e.kind = if (i.move_x.abs() + i.move_z.abs()) > 0.3 && !i.repair {
                            "BLOCKED"
                        } else if i.repair || p.mech.repair_time > 0.0 {
                            "repairing"
                        } else if bot.describe(game.nav, &p.mech).contains("perched=true") {
                            "perched"
                        } else {
                            "idle"
                        };
                        e.note = Some(format!(
                            "\n    pos={:.1} vel={:.1} hp={:.0}% heat={:.0}% class={:?} prim={} sec={} {}\n    input move=({:.2},{:.2}) boost={} hover={} repair={} fire={}\n    {}",
                            p.mech.pos,
                            p.mech.vel,
                            100.0 * p.mech.health / t.health_max,
                            100.0 * p.mech.heat / t.heat_max,
                            p.class,
                            crate::arsenal::weapon(Slot::Primary, p.loadout.primary).unwrap().0,
                            crate::arsenal::weapon(Slot::Secondary, p.loadout.secondary).unwrap().0,
                            target.unwrap_or_default(),
                            i.move_x,
                            i.move_z,
                            i.boost,
                            i.hover,
                            i.repair,
                            i.fire,
                            bot.describe(game.nav, &p.mech),
                        ));
                    }
                }
            }
            for (id, e) in open {
                if let Some(note) = e.note {
                    let held = game.tick - e.from;
                    stuck_ticks += u64::from(held);
                    episodes += 1;
                    *kinds.entry(e.kind).or_insert(0.0) += held as f32 / TICK_HZ;
                    if verbose(e.kind) {
                        println!("[{name} s{seed}] {} bot {id} stuck {:.1}s (at end) {note}", e.kind, held as f32 / TICK_HZ);
                    }
                }
            }
        }
        println!("== {name}: {episodes} episodes, {:.1}% of bot-alive time stuck ≥5 s; seconds by kind {kinds:?}", 100.0 * stuck_ticks as f32 / alive_ticks.max(1) as f32);
    }
}

/// Grenade rifle against Rifle in bot-only matches on every map: every other bot on each side
/// carries the grenade rifle, the rest the rifle (other slots as they roll). Per arm: damage and
/// kills per alive minute, and shots (by range to the target) and damage (by range to the one hit).
/// PROBE_SEEDS=<n> PROBE_FROM=<first seed> PROBE_SECS=<s> cargo test -p sim --release --lib hail_match_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn hail_match_probe() {
    #[derive(Default)]
    struct Arm {
        alive: u64,
        shots: [u32; 5],
        dealt: [f32; 5],
        kills: u32,
        deaths: u32,
    }
    // Range buckets: under 15, 15-30, 30-42, 42-60 m, 60 and over (or no target).
    let bucket = |r: f32| [15.0, 30.0, 42.0, 60.0].iter().take_while(|&&b| r >= b).count();
    let only = std::env::var("PROBE_MAP").ok();
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(180.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(2);
    let (hail, pike) = (Loadout::named("hail", "darts").primary, Loadout::named("pike", "darts").primary);
    let mut arms = [Arm::default(), Arm::default()]; // [hail, pike]
    for (index, (name, _)) in crate::map::MAPS.iter().enumerate() {
        if only.as_deref().is_some_and(|m| m != *name) {
            continue;
        }
        let from: u64 = std::env::var("PROBE_FROM").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
        for seed in from..from + seeds {
            let mut game = Game::new(Tuning::default(), index);
            (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
            let human = game.join().unwrap();
            game.dock(human);
            game.step();
            let grenadiers: Vec<u8> = (0..2u8).flat_map(|team| game.players.iter().filter(|p| p.team == team && p.bot.is_some()).map(|p| p.id).skip(seed as usize % 2).step_by(2).collect::<Vec<_>>()).collect();
            let arm_of = |id: u8| usize::from(!grenadiers.contains(&id));
            let mut roller = Bot::new(seed + 1);
            for _ in 0..secs(run) {
                game.step();
                for i in 0..game.players.len() {
                    let p = &game.players[i];
                    let want = if grenadiers.contains(&p.id) { hail } else { pike };
                    if p.bot.is_none() || p.mech.health <= 0.0 || p.loadout.primary == want {
                        continue;
                    }
                    let class = p.class;
                    let Some(loadout) = (0..2000).map(|_| roller.pick_loadout(&game.arsenal, class)).find(|l| l.primary == want) else { continue };
                    let p = &mut game.players[i];
                    (p.loadout, p.next_loadout) = (loadout, loadout);
                    p.mech = Mech { shield: p.mech.shield, ..spawn(&game.arsenal, class, loadout, p.mech.pos) };
                }
                let tick = game.tick;
                for q in &game.players {
                    for &(by, dealt, _) in q.ledger.iter().filter(|l| l.2 == tick) {
                        let Some(p) = game.players.iter().find(|p| p.id == by && p.bot.is_some()) else { continue };
                        arms[arm_of(by)].dealt[bucket(flat(q.mech.pos - p.mech.pos).length())] += dealt;
                    }
                }
                for p in &game.players {
                    let Some(bot) = &p.bot else { continue };
                    if p.mech.health <= 0.0 || p.respawn_at.is_some() {
                        continue;
                    }
                    let arm = &mut arms[arm_of(p.id)];
                    arm.alive += 1;
                    if p.mech.shot {
                        let foe = bot.focus().and_then(|f| game.players.iter().find(|q| q.id == f));
                        arm.shots[foe.map_or(4, |q| bucket(flat(q.mech.pos - p.mech.pos).length()))] += 1;
                    }
                }
            }
            for p in game.players.iter().filter(|p| p.bot.is_some()) {
                arms[arm_of(p.id)].kills += u32::from(p.kills);
                arms[arm_of(p.id)].deaths += u32::from(p.deaths);
            }
        }
    }
    for (label, a) in ["hail", "pike"].iter().zip(&arms) {
        let mins = a.alive as f32 / TICK_HZ / 60.0;
        let (shots, dealt) = (a.shots.iter().sum::<u32>(), a.dealt.iter().sum::<f32>());
        println!(
            "{label}: {:.0} alive-min, dealt {:.0}/min, {:.2}/shot, kills {:.2}/min, deaths {:.2}/min, kill share {:.1}%",
            mins,
            dealt / mins,
            dealt / shots.max(1) as f32,
            a.kills as f32 / mins,
            a.deaths as f32 / mins,
            100.0 * a.kills as f32 / (arms[0].kills + arms[1].kills).max(1) as f32
        );
        println!("   shots by range <15/15-30/30-42/42-60/60+ {:?}", a.shots.map(|s| format!("{:.0}%", 100.0 * s as f32 / shots.max(1) as f32)));
        println!("   dealt by range                         {:?}", a.dealt.map(|d| format!("{:.0}%", 100.0 * d / dealt.max(1.0))));
        println!("   dealt per shot by range                {:?}", std::array::from_fn::<_, 5, _>(|k| format!("{:.2}", a.dealt[k] / a.shots[k].max(1) as f32)));
    }
}

fn verbose(kind: &str) -> bool {
    std::env::var("PROBE_SHOW").map_or(kind == "BLOCKED" || kind == "idle", |k| k == "all" || k == kind)
}

fn flat(v: Vector) -> Vector {
    Vector::new(v.x, 0.0, v.z)
}

/// Torch probe: bot-only Team Deathmatch on every map, every other bot on one side carrying a
/// repair torch and every other bot another secondary (all on guns a torch bot would pick): each
/// side's kills, and per bot-minute alive the torches' and the rest's healing, burning, kill
/// credit and deaths, and their time fighting (an enemy in view), mending (no enemy in view, a
/// hurt teammate in sight within twice the beam's reach), following (by its lead) or otherwise;
/// items thrown; in fights within the beam's reach, the gun's shots a second and the share of
/// time the bot runs hot (3/4 heat); and of its time mending, the share with the beam on, the
/// nearest teammate out of reach, cooling (40% heat or more), or none of those. PROBE_ANYGUN=1 puts both sides on any gun (as sweeps do), not just the
/// ones a torch bot picks; PROBE_OWN=1 gives every bot its class's own items and ability.
/// PROBE_MAP=<name> PROBE_SECS=<s> PROBE_SEEDS=<n> PROBE_ANYGUN=1 cargo test -p sim --release --lib torch_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn torch_probe() {
    #[derive(Default)]
    struct Arm {
        alive: u64,
        healed: f32,
        burned: f32,
        beam_mate: u64,
        beam_foe: u64,
        beam_none: u64,
        fight: u64,
        fight_in_reach: u64,
        fight_gun: u64,
        fight_hot: u64,
        mend: u64,
        // Ticks mending (`Doing::Mend`): beam on, the mate out of reach, too hot, or otherwise.
        mending: [u64; 4],
        follow: u64,
        threw: u64,
        credit: f32,
        deaths: u32,
    }
    impl Arm {
        fn add(&mut self, o: &Arm) {
            (self.alive, self.healed, self.burned) = (self.alive + o.alive, self.healed + o.healed, self.burned + o.burned);
            (self.beam_mate, self.beam_foe, self.beam_none) = (self.beam_mate + o.beam_mate, self.beam_foe + o.beam_foe, self.beam_none + o.beam_none);
            (self.fight, self.fight_in_reach, self.fight_gun, self.fight_hot) = (self.fight + o.fight, self.fight_in_reach + o.fight_in_reach, self.fight_gun + o.fight_gun, self.fight_hot + o.fight_hot);
            (self.mend, self.follow, self.credit, self.deaths) = (self.mend + o.mend, self.follow + o.follow, self.credit + o.credit, self.deaths + o.deaths);
            self.mending = std::array::from_fn(|k| self.mending[k] + o.mending[k]);
            self.threw += o.threw;
        }
    }
    let only = std::env::var("PROBE_MAP").ok();
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(180.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(2);
    let any_gun = std::env::var("PROBE_ANYGUN").is_ok();
    let own = std::env::var("PROBE_OWN").is_ok();
    // Its matches into a thread's tallies: [torches, the rest], and [the torches' side, the other]'s kills.
    let play = |index: usize, seed: u64, arms: &mut [Arm; 2], scores: &mut [u32; 2]| {
        let mut game = Game::new(Tuning::default(), index);
        (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
        let human = game.join().unwrap();
        game.dock(human);
        game.step();
        // Torches on each side in turn, as the docked human's place is on side 0.
        let side = (seed % 2) as u8;
        let torches: Vec<u8> = game.players.iter().filter(|p| p.team == side && p.bot.is_some()).map(|p| p.id).step_by(2).collect();
        let mender = Loadout::named("hail", "mender").secondary;
        let mut roller = Bot::new(seed + 1);
        for _ in 0..secs(run) {
            game.step();
            // Each life its side's build: a torch, or another secondary, on a gun a torch bot
            // picks (or any gun: another build's, the torch put in its secondary's place).
            for i in 0..game.players.len() {
                let p = &game.players[i];
                let want = torches.contains(&p.id);
                if p.bot.is_none() || p.mech.health <= 0.0 || (game.arsenal.of(&p.mech).alt_beam > 0.0) == want {
                    continue;
                }
                let class = p.class;
                let torch = |l: &Loadout| game.arsenal.get(class, *l).alt_beam > 0.0;
                let long: Vec<u8> = (0..100).map(|_| roller.pick_loadout(&game.arsenal, class)).filter(torch).map(|l| l.primary).collect();
                let loadout = loop {
                    let l = roller.pick_loadout(&game.arsenal, class);
                    if any_gun && !torch(&l) {
                        break if want { Loadout { secondary: mender, ..l } } else { l };
                    }
                    if !any_gun && torch(&l) == want && long.contains(&l.primary) {
                        break l;
                    }
                };
                let kit = Loadout::of(class);
                let loadout = if own { Loadout { offensive: kit.offensive, support: kit.support, ability: kit.ability, ..loadout } } else { loadout };
                let p = &mut game.players[i];
                (p.loadout, p.next_loadout) = (loadout, loadout);
                p.mech = Mech { shield: p.mech.shield, ..spawn(&game.arsenal, class, loadout, p.mech.pos) };
            }
            let beams: Vec<(u8, Option<u8>)> = game.events.iter().filter_map(|e| if let Event::Beam { owner, hit, .. } = *e { Some((owner, hit)) } else { None }).collect();
            for p in &game.players {
                let Some(bot) = &p.bot else { continue };
                if p.mech.health <= 0.0 || p.respawn_at.is_some() {
                    continue;
                }
                let t = game.arsenal.of(&p.mech);
                let arm = &mut arms[usize::from(!torches.contains(&p.id))];
                arm.alive += 1;
                arm.threw += u64::from(p.mech.threw);
                if let Some(&(_, hit)) = beams.iter().find(|b| b.0 == p.id) {
                    match hit.and_then(|h| game.players.iter().find(|q| q.id == h)) {
                        Some(q) if q.team == p.team => arm.beam_mate += 1,
                        Some(_) => (arm.beam_foe, arm.burned) = (arm.beam_foe + 1, arm.burned + t.alt_damage / TICK_HZ),
                        None => arm.beam_none += 1,
                    }
                }
                let foe = bot.focus().and_then(|f| game.players.iter().find(|q| q.id == f)).filter(|q| q.mech.health > 0.0 && bot::sees(&game.arena, t, &p.mech, &q.mech));
                let reach = 28.0; // the torch's, for both sides
                let hurt_mate = game.players.iter().any(|q| {
                    q.team == p.team && q.id != p.id && q.mech.health > 0.0 && q.mech.health < 0.8 * game.arsenal.of(&q.mech).health_max && q.mech.pos.distance(p.mech.pos) < 2.0 * reach && bot::sees(&game.arena, t, &p.mech, &q.mech)
                });
                if bot.doing() == bot::Doing::Mend {
                    let mate = game.players.iter().filter(|q| q.team == p.team && q.id != p.id && q.mech.health > 0.0).map(|q| q.mech.pos.distance(p.mech.pos)).fold(f32::MAX, f32::min);
                    let k = if p.mech.beaming {
                        0
                    } else if mate > t.alt_beam {
                        1
                    } else if p.mech.heat >= 0.4 * t.heat_max {
                        2
                    } else {
                        3
                    };
                    arm.mending[k] += 1;
                }
                if let Some(q) = foe {
                    arm.fight += 1;
                    if q.mech.pos.distance(p.mech.pos) < reach {
                        arm.fight_in_reach += 1;
                        arm.fight_gun += u64::from(p.mech.shot);
                        arm.fight_hot += u64::from(p.mech.heat >= 0.75 * t.heat_max);
                    }
                } else if hurt_mate {
                    arm.mend += 1;
                } else if bot.lead.is_some_and(|l| flat(l - p.mech.pos).length() < 12.0) {
                    arm.follow += 1;
                }
            }
        }
        scores[0] += u32::from(game.scores[usize::from(side)]);
        scores[1] += u32::from(game.scores[usize::from(1 - side)]);
        for p in game.players.iter().filter(|p| p.bot.is_some()) {
            let arm = &mut arms[usize::from(!torches.contains(&p.id))];
            arm.healed += p.tally.healed;
            arm.credit += p.tally.bot_kill_credit + p.tally.bot_assist_share + p.tally.kill_credit + p.tally.assist_share;
            arm.deaths += p.tally.stats.deaths;
        }
    };
    // Every map and seed, taken in turn by a thread a core.
    let jobs: Vec<(usize, u64)> = crate::map::MAPS.iter().enumerate().filter(|(_, (name, _))| only.as_deref().is_none_or(|m| m == *name)).flat_map(|(i, _)| (0..seeds).map(move |s| (i, s))).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    let runs: Vec<([Arm; 2], [u32; 2])> = std::thread::scope(|s| {
        let threads: Vec<_> = (0..cores)
            .map(|_| {
                s.spawn(|| {
                    let (mut arms, mut scores) = ([Arm::default(), Arm::default()], [0u32; 2]);
                    while let Some(&(index, seed)) = jobs.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) {
                        play(index, seed, &mut arms, &mut scores);
                    }
                    (arms, scores)
                })
            })
            .collect();
        threads.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let (mut arms, mut scores) = ([Arm::default(), Arm::default()], [0u32; 2]);
    for (a, s) in &runs {
        arms[0].add(&a[0]);
        arms[1].add(&a[1]);
        (scores[0], scores[1]) = (scores[0] + s[0], scores[1] + s[1]);
    }
    println!("== kills: torch side {} other side {} ({:.1}% to the torch side)", scores[0], scores[1], 100.0 * scores[0] as f32 / (scores[0] + scores[1]).max(1) as f32);
    for (label, a) in ["torch", "other"].iter().zip(&arms) {
        let min = a.alive as f32 / TICK_HZ / 60.0;
        let share = |n: u64| 100.0 * n as f32 / a.alive.max(1) as f32;
        println!(
            "== {label}: {min:.0} bot-min | per min: healed {:.1} burned {:.1} throws {:.2} credit {:.2} deaths {:.2} | time: fight {:.0}% (in beam reach {:.0}%; in it, shots {:.2}/s, hot {:.0}%) mend {:.0}% follow {:.0}% other {:.0}% | beam on mate {:.1}% foe {:.1}% nothing {:.1}%",
            a.healed / min,
            a.burned / min,
            a.threw as f32 / min,
            a.credit / min,
            a.deaths as f32 / min,
            share(a.fight),
            share(a.fight_in_reach),
            a.fight_gun as f32 * TICK_HZ / a.fight_in_reach.max(1) as f32,
            100.0 * a.fight_hot as f32 / a.fight_in_reach.max(1) as f32,
            share(a.mend),
            share(a.follow),
            share(a.alive - a.fight - a.mend - a.follow),
            share(a.beam_mate),
            share(a.beam_foe),
            share(a.beam_none),
        );
        let m = a.mending.iter().sum::<u64>().max(1) as f32;
        println!("== {label}: mending {:.1}% of the time: beam on {:.0}%, nearest mate out of reach {:.0}%, hot {:.0}%, else {:.0}%", share(a.mending.iter().sum()), 100.0 * a.mending[0] as f32 / m, 100.0 * a.mending[1] as f32 / m, 100.0 * a.mending[2] as f32 / m, 100.0 * a.mending[3] as f32 / m);
    }
}

/// Pile driver probe: a bot with `PROBE_PRIMARY` (default the SMG) and the pile driver, or the
/// rocket to compare, against a human Medium in the open on Blockout, standing or strafing, from
/// 8, 15 and 25 m. Counts wind-ups, releases, hits and damage, and where the bot's time goes.
/// PROBE_SEEDS=<n> PROBE_SECS=<s> cargo test -p sim --release --lib piston_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn piston_probe() {
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(20.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(8);
    let primary = std::env::var("PROBE_PRIMARY").unwrap_or_else(|_| "stitcher".into());
    let t0 = Tuning::default();
    for secondary in ["piston", "rocket"] {
        for range in [8.0, 15.0, 25.0] {
            for strafe in [false, true] {
                let (mut winds, mut releases, mut charge, mut early, mut out_of_reach, mut hits) = (0u32, 0u32, 0.0f32, 0u32, 0u32, 0u32);
                let (mut alt_dmg, mut gun_dmg, mut ticks, mut firing, mut winding, mut beyond, mut dist_sum) = (0.0f32, 0.0f32, 0u32, 0u32, 0u32, 0u32, 0.0f32);
                let mut misses_lateral = 0.0f32;
                for seed in 1..=seeds {
                    let mut game = Game::new(t0.clone(), crate::map::Map::index("blockout").unwrap());
                    game.bots = false;
                    let human = game.join().unwrap();
                    let bot = game.add_player(1, Some(Bot::new(seed)), MechClass::B).unwrap();
                    for (id, pos) in [(human, Vector::new(0.0, 0.1, -5.0)), (bot, Vector::new(0.0, 0.1, -5.0 + range))] {
                        let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                        p.mech.pos = pos;
                        // Venting, the Medium's simplest ability.
                        p.mech.loadout = Loadout { ability: 1, ..Loadout::named(&primary, secondary) };
                        (p.mech.grenades, p.mech.emps) = (0, 0);
                    }
                    for p in &mut game.players {
                        p.mech.shield = 0.0;
                    }
                    let (mut was_alt, mut released_at) = (false, None::<(u32, Vector)>);
                    for k in 0..secs(run) {
                        let side = if strafe && (k / secs(1.2)) % 2 == 0 { 1.0 } else if strafe { -1.0 } else { 0.0 };
                        let tick = game.tick;
                        game.push_input(human, InputMsg { seq: tick + 1, input: crate::Input { move_x: side, ..crate::Input::default() }, view_tick: tick as f32 });
                        let hp = |g: &Game| g.players.iter().find(|p| p.id == human).unwrap().mech.health;
                        let before = hp(&game);
                        game.step();
                        let drop = before - hp(&game);
                        let (b, h) = (game.players.iter().find(|p| p.id == bot).unwrap(), game.players.iter().find(|p| p.id == human).unwrap());
                        let t = game.arsenal.of(&b.mech);
                        let input = b.bot.as_ref().unwrap().last;
                        let gap = flat(h.mech.pos - b.mech.pos).length();
                        ticks += 1;
                        dist_sum += gap;
                        firing += u32::from(input.fire);
                        winding += u32::from(input.alt_fire && t.alt_melee > 0.0);
                        beyond += u32::from(gap > 0.85 * t.alt_lunge + 2.0 * t.mech_radius);
                        winds += u32::from(input.alt_fire && !was_alt && t.alt_melee > 0.0);
                        was_alt = input.alt_fire;
                        if b.mech.launched {
                            releases += 1;
                            charge += b.mech.strike_charge;
                            early += u32::from(t.alt_melee > 0.0 && b.mech.strike_charge < 0.8);
                            out_of_reach += u32::from(t.alt_melee > 0.0 && gap - 2.0 * t.mech_radius > t.alt_lunge * b.mech.strike_charge + t.alt_melee);
                            released_at = Some((game.tick, h.mech.pos));
                        }
                        let struck = game.events.iter().any(|e| matches!(*e, Event::Strike { owner, hit, .. } if owner == bot && hit == human));
                        let fresh = struck && h.knock.is_some_and(|kn| kn.until == game.tick + secs(melee::KNOCK_SECONDS) && !kn.slammed);
                        let blasted = game.events.iter().any(|e| matches!(*e, Event::Blast { owner, primary: false, hits, .. } if owner == bot && hits & 1 << human != 0));
                        hits += u32::from(fresh || blasted);
                        if std::env::var("PROBE_TRACE").is_ok() && seed == 1 && (b.mech.launched || fresh || blasted) {
                            println!("  t{} launched={} fresh={fresh} blasted={blasted} gap={gap:.1} charge={:.2} events={:?}", game.tick, b.mech.launched, b.mech.strike_charge, game.events.iter().filter(|e| matches!(e, Event::Strike { .. } | Event::Blast { .. })).collect::<Vec<_>>());
                        }
                        if struck || blasted {
                            alt_dmg += drop;
                        } else {
                            gun_dmg += drop;
                        }
                        // A strike that's run out without landing: how far the target got from where it stood at the release.
                        if let Some((at, from)) = released_at
                            && t.alt_melee > 0.0
                            && b.mech.strike <= 0.0
                            && game.tick > at
                        {
                            if !fresh {
                                misses_lateral += flat(h.mech.pos - from).length();
                            }
                            released_at = None;
                        }
                        let hm = &mut game.players.iter_mut().find(|p| p.id == human).unwrap().mech;
                        hm.health = t0.health_max * 10.0;
                        // No grenades, turrets or EMPs (they come back over time): only the guns count.
                        let bm = &mut game.players.iter_mut().find(|p| p.id == bot).unwrap().mech;
                        (bm.grenades, bm.emps) = (0, 0);
                    }
                }
                let n = seeds as f32 * run / 60.0;
                println!(
                    "{secondary:6} {range:>2} m {:8}: winds {:.1}/min, releases {:.1}/min (charge {:.2}, early {early}, out of reach {out_of_reach}), hits {hits}/{releases} = {:.0}%, alt {:.0}/min, gun {:.0}/min | dist {:.1} m, beyond lunge {:.0}%, firing {:.0}%, winding {:.0}%, miss drift {:.1} m",
                    if strafe { "strafing" } else { "standing" },
                    winds as f32 / n,
                    releases as f32 / n,
                    charge / releases.max(1) as f32,
                    100.0 * hits as f32 / releases.max(1) as f32,
                    alt_dmg / n,
                    gun_dmg / n,
                    dist_sum / ticks as f32,
                    100.0 * beyond as f32 / ticks as f32,
                    100.0 * firing as f32 / ticks as f32,
                    100.0 * winding as f32 / ticks as f32,
                    misses_lateral / (releases - hits).max(1) as f32,
                );
            }
        }
    }
}

/// Pile drivers in bot-only matches on every map: every other bot on one side (sides alternate by
/// seed) carries it, the rest of both sides other secondaries, all on guns a pile-driver bot picks.
/// Counts releases, how many go with no enemy in view, hits and their damage, and the side's kills.
/// PROBE_SEEDS=<n> PROBE_SECS=<s> cargo test -p sim --release --lib piston_match_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn piston_match_probe() {
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(180.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(2);
    let (mut alive, mut releases, mut blind, mut hits, mut dealt, mut deaths) = (0u64, 0u32, 0u32, 0u32, 0.0f32, 0u32);
    let mut scores = [0u32; 2];
    for (index, _) in crate::map::MAPS.iter().enumerate() {
        for seed in 0..seeds {
            let mut game = Game::new(Tuning::default(), index);
            (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
            let human = game.join().unwrap();
            game.dock(human);
            game.step();
            let side = (seed % 2) as u8;
            let drivers: Vec<u8> = game.players.iter().filter(|p| p.team == side && p.bot.is_some()).map(|p| p.id).step_by(2).collect();
            let mut roller = Bot::new(seed + 1);
            for _ in 0..secs(run) {
                game.step();
                for i in 0..game.players.len() {
                    let p = &game.players[i];
                    let want = drivers.contains(&p.id);
                    if p.bot.is_none() || p.mech.health <= 0.0 || (game.arsenal.of(&p.mech).alt_melee > 0.0) == want {
                        continue;
                    }
                    let class = p.class;
                    let melee = |l: &Loadout| game.arsenal.get(class, *l).alt_melee > 0.0;
                    // The guns a pile-driver bot of this class picks, and a build on one of them
                    // (bounded: none for a class that never rolls it).
                    let close: Vec<u8> = (0..1000).map(|_| roller.pick_loadout(&game.arsenal, class)).filter(melee).map(|l| l.primary).collect();
                    let Some(loadout) = (0..10_000).map(|_| roller.pick_loadout(&game.arsenal, class)).find(|l| melee(l) == want && close.contains(&l.primary)) else {
                        continue;
                    };
                    let p = &mut game.players[i];
                    (p.loadout, p.next_loadout) = (loadout, loadout);
                    p.mech = Mech { shield: p.mech.shield, ..spawn(&game.arsenal, class, loadout, p.mech.pos) };
                }
                for p in game.players.iter().filter(|p| drivers.contains(&p.id) && p.mech.health > 0.0 && p.respawn_at.is_none()) {
                    let (t, bot) = (game.arsenal.of(&p.mech), p.bot.as_ref().unwrap());
                    alive += 1;
                    if p.mech.launched {
                        releases += 1;
                        let seen = bot.focus().and_then(|f| game.players.iter().find(|q| q.id == f)).is_some_and(|q| bot::sees(&game.arena, t, &p.mech, &q.mech));
                        blind += u32::from(!seen);
                    }
                    for e in &game.events {
                        if let Event::Strike { owner, hit, .. } = *e
                            && owner == p.id
                            && game.players.iter().find(|q| q.id == hit).is_some_and(|q| q.knock.is_some_and(|k| !k.slammed && k.until == game.tick + secs(melee::KNOCK_SECONDS)))
                        {
                            hits += 1;
                            dealt += t.alt_damage * melee::power(t, p.mech.strike_charge);
                        }
                    }
                }
            }
            scores[0] += u32::from(game.scores[usize::from(side)]);
            scores[1] += u32::from(game.scores[usize::from(1 - side)]);
            deaths += game.players.iter().filter(|p| drivers.contains(&p.id)).map(|p| p.tally.stats.deaths).sum::<u32>();
        }
    }
    let min = alive as f32 / TICK_HZ / 60.0;
    println!(
        "== pile drivers: {min:.0} bot-min | releases {:.2}/min ({:.0}% with no enemy in view), hits {:.0}%, strike damage {:.0}/min, deaths {:.2}/min | kills: their side {} other {} ({:.1}%)",
        releases as f32 / min,
        100.0 * blind as f32 / releases.max(1) as f32,
        100.0 * hits as f32 / releases.max(1) as f32,
        dealt / min,
        deaths as f32 / min,
        scores[0],
        scores[1],
        100.0 * scores[0] as f32 / (scores[0] + scores[1]).max(1) as f32,
    );
}

/// Threat probe: a Medium bot holding still at a set range from a Medium human strafing in the
/// open, its items and ability held back, against `threat::dps`: the damage a second each weapon
/// landed, played out and modelled. A check on the model, not a test (`--ignored`). Knobs:
/// PROBE_KIT (one weapon's rows), PROBE_STILL, PROBE_TURNS=random, PROBE_DEBUG (fire and heat; for a
/// projectile primary, its releases and where its rounds passed the target).
/// PROBE_SECS=<s> PROBE_SEEDS=<n> cargo test -p sim --release --lib threat_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn threat_probe() {
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(20.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(4);
    let t0 = Tuning::default();
    let arsenal = crate::Arsenal::new(&t0);
    let ranges = [10.0, 20.0, 30.0, 45.0, 60.0, 80.0];
    let debug = std::env::var("PROBE_DEBUG").is_ok();
    // PROBE_STILL: the human stands still, to tell aim from leading. PROBE_TURNS=random: it turns
    // about every 0.8 to 2 s, as bots do, not every 1.2 s (a shot that waits can lock onto that).
    let still = std::env::var("PROBE_STILL").is_ok();
    let random = std::env::var("PROBE_TURNS").is_ok_and(|s| s == "random");
    let only = std::env::var("PROBE_KIT").ok();
    let kits: Vec<(&str, &str)> = ["stitcher", "triplet", "pike", "gyre", "squall", "kiln", "hail", "talon"].map(|p| (p, "-")).into_iter()
        .chain(["darts", "hornet", "rocket", "spindle", "furnace", "mortar", "splitter", "warren"].map(|s| ("pike", s)))
        .collect();
    println!("{:9} {:9} {}", "primary", "secondary", ranges.map(|r| format!("{r:>13.0} m")).join(""));
    for (primary, secondary) in kits {
        if only.as_deref().is_some_and(|k| k != primary && k != secondary) {
            continue;
        }
        let loadout = crate::Loadout::named(primary, if secondary == "-" { "rocket" } else { secondary });
        let (mine, theirs) = (arsenal.get(MechClass::B, loadout), arsenal.get(MechClass::B, crate::Loadout::default()));
        let mut cells = Vec::new();
        for range in ranges {
            let (mut gun, mut alt) = (0.0f32, 0.0f32);
            let (mut fires, mut shots, mut hot, mut focused) = (0u32, 0u32, 0.0f32, 0u32);
            let mut doing: BTreeMap<String, u32> = BTreeMap::new();
            // PROBE_DEBUG, projectile primaries: releases (count, charge, ticks held), and each slug's
            // closest pass by the target's middle, by how long the target had been on its leg at launch
            // (0.3 s quarters; the last, 0.9 s or more).
            let (mut releases, mut charge, mut held, mut holding) = (0u32, 0.0f32, 0u32, 0u32);
            let mut legs = [(0u32, 0u32, 0.0f32, 0.0f32); 4]; // (slugs, hits, ahead of its motion (m), above (m)) of misses
            for seed in 1..=seeds {
                let mut flying: BTreeMap<u32, (Vector, f32, Vector, u32)> = BTreeMap::new(); // seq: (last, closest, offset, leg)
                let mut game = Game::new(t0.clone(), crate::map::Map::index("blockout").unwrap());
                game.bots = false;
                let human = game.join().unwrap();
                // It holds its fire to cool rather than falling back (pinned, it would only turn away).
                let mut brain = Bot::new(seed);
                for a in [crate::brain::Action::FallBackToCool, crate::brain::Action::FallBackToMend] {
                    brain.brain.0.remove(&a);
                }
                let bot = game.add_player(1, Some(brain), MechClass::B).unwrap();
                // Down the open west side, the human strafing across the line (east first, clear of the wall).
                let (from, spot) = (Vector::new(-36.0, 0.1, -42.0), Vector::new(-36.0, 0.1, -42.0 + range));
                for (id, pos) in [(human, from), (bot, spot)] {
                    let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                    p.mech.pos = pos;
                    if id == bot {
                        p.mech.loadout = loadout;
                    }
                }
                for p in &mut game.players {
                    p.mech.shield = 0.0;
                }
                let face = { let d = spot - from; libm::atan2f(-d.x, -d.z) };
                let (mut rng, mut side, mut turned, mut turn_at) = (seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1, -1.0, 0, secs(1.2));
                for k in 0..secs(run) {
                    if k == turn_at {
                        rng ^= rng << 13;
                        rng ^= rng >> 7;
                        rng ^= rng << 17;
                        (side, turned) = (-side, k);
                        turn_at += if random { secs(0.8 + 1.2 * (rng >> 40) as f32 / (1u64 << 24) as f32) } else { secs(1.2) };
                    }
                    let side = if still { 0.0 } else { side };
                    let tick = game.tick;
                    game.push_input(human, InputMsg { seq: tick + 1, input: crate::Input { move_x: side, yaw: face, ..crate::Input::default() }, view_tick: tick as f32 });
                    game.step();
                    if debug {
                        let b = game.players.iter().find(|p| p.id == bot).unwrap();
                        let bt = b.bot.as_ref().unwrap();
                        (fires, shots, hot) = (fires + u32::from(bt.last.fire), shots + u32::from(b.mech.shot), hot + b.mech.heat / game.arsenal.of(&b.mech).heat_max);
                        *doing.entry(format!("{:?}", bt.doing())).or_insert(0u32) += 1;
                        focused += u32::from(bt.focus().is_some());
                        holding = if bt.last.fire { holding + 1 } else { holding };
                        if b.mech.shot {
                            (releases, charge, held, holding) = (releases + 1, charge + b.mech.shot_charge, held + holding, 0);
                        }
                        let h = mech_of(&game, human);
                        let mid = h.pos + Vector::Y * (game.arsenal.of(&h).mech_height * 0.5);
                        let leg = ((k - turned) / secs(0.3)).min(3) as usize;
                        let pass = |f: &mut (Vector, f32, Vector, u32), to: Vector| {
                            let (d, at) = (to - f.0, mid - f.0);
                            let s = (at.dot(d) / d.length_squared().max(1e-6)).clamp(0.0, 1.0);
                            let off = f.0 + d * s - mid;
                            if off.length() < f.1 {
                                (f.1, f.2) = (off.length(), off * Vector::new(h.vel.x.signum(), 1.0, 1.0));
                            }
                            f.0 = to;
                        };
                        for e in &game.events {
                            match *e {
                                Event::Launch(p) if p.owner == bot && p.primary => {
                                    flying.insert(p.seq, (p.pos, f32::MAX, Vector::ZERO, leg as u32));
                                }
                                Event::Blast { owner, seq, primary: true, pos, hits, .. } if owner == bot => {
                                    if let Some(mut f) = flying.remove(&seq) {
                                        pass(&mut f, pos);
                                        let l = &mut legs[f.3 as usize];
                                        if hits & 1 << human != 0 {
                                            (l.0, l.1) = (l.0 + 1, l.1 + 1);
                                        } else {
                                            (l.0, l.2, l.3) = (l.0 + 1, l.2 + f.2.x, l.3 + f.2.y);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        for f in game.projectiles.iter().filter(|f| f.p.owner == bot && f.p.primary) {
                            if let Some(e) = flying.get_mut(&f.p.seq) {
                                pass(e, f.p.pos);
                            }
                        }
                    }
                    for p in &mut game.players {
                        if p.id == bot {
                            (p.mech.pos, p.mech.vel, p.mech.grenades, p.mech.emps, p.mech.ability_cooldown) = (spot, Vector::ZERO, 0, 0, 99.0);
                            // The gun alone, in the primaries' rows.
                            if secondary == "-" {
                                p.mech.alt_wait = 99.0;
                            }
                        } else {
                            p.mech.health = p.mech.health.max(1.0e3);
                        }
                    }
                }
                let tally = &game.players.iter().find(|p| p.id == bot).unwrap().tally;
                (gun, alt) = (gun + tally.dealt_by[0], alt + tally.dealt_by[1]);
            }
            let played = run * seeds as f32;
            if debug {
                let n = secs(run) as f32 * seeds as f32;
                println!("{primary} {secondary} {range} m: fire held {:.0}%, shot {:.1}/s, heat {:.0}%, focused {:.0}%, {doing:?}", 100.0 * fires as f32 / n, shots as f32 / played, 100.0 * hot / n, 100.0 * focused as f32 / n);
                if releases > 0 && legs.iter().any(|l| l.0 > 0) {
                    let legs = legs.map(|(n, hit, ahead, up)| format!("{hit}/{n} hit, misses {:+.1} m ahead {:+.1} m up", ahead / (n - hit).max(1) as f32, up / (n - hit).max(1) as f32));
                    println!("  released at {:.2} charge after {:.2} s held; slugs by quarter of the target's leg at launch: {}", charge / releases as f32, held as f32 / releases as f32 / TICK_HZ, legs.join(" | "));
                }
            }
            let mut model = crate::threat::dps(mine, theirs, range);
            if secondary == "-" {
                let mut gun = mine.clone();
                (gun.alt_heat, gun.alt_damage) = (0.0, 0.0);
                model = crate::threat::dps(&gun, theirs, range);
            }
            cells.push(format!("  {:>4.1}/{:<4.1}{:>4.1}/{:<4.1}", gun / played, model.primary, alt / played, model.secondary));
        }
        println!("{primary:9} {secondary:9} {}", cells.join(""));
    }
    println!("each cell: primary played/modelled, secondary played/modelled (damage a second)");
}

/// Secondary probe: a bot (`PROBE_CLASS` A/B/C, default B) with `PROBE_PRIMARY` (default the rifle)
/// and each of `PROBE_ALTS` (default Scatter, Furnace, Cluster launcher, Rocket) against a human
/// (`PROBE_TARGET`, default B) in the open on Blockout, standing or strafing (1.2 s each way), from
/// each of `PROBE_RANGES` m. Its ability stays on cooldown and it has no items, so only its guns
/// count. Per minute: launches, the secondary's and the gun's damage; of the secondary's bursts,
/// how many caught the target, and where the rest went (above its top, short, past, aside); time
/// hot enough to feed a heat-fed launcher, and with the secondary ready.
/// PROBE_SEEDS=<n> PROBE_SECS=<s> cargo test -p sim --release --lib alt_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn alt_probe() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let run: f32 = env("PROBE_SECS", "20").parse().unwrap();
    let seeds: u64 = env("PROBE_SEEDS", "8").parse().unwrap();
    let primary = env("PROBE_PRIMARY", "pike");
    let class_of = |s: &str| match s {
        "A" => MechClass::A,
        "C" => MechClass::C,
        _ => MechClass::B,
    };
    let (class, target_class) = (class_of(&env("PROBE_CLASS", "B")), class_of(&env("PROBE_TARGET", "B")));
    let ranges: Vec<f32> = env("PROBE_RANGES", "15,30,45").split(',').map(|r| r.parse().unwrap()).collect();
    let t0 = Tuning::default();
    for secondary in env("PROBE_ALTS", "darts,furnace,splitter,rocket").split(',') {
        for &range in &ranges {
            for strafe in [false, true] {
                #[derive(Default)]
                struct N {
                    ticks: u32,
                    launches: u32,
                    alt_dmg: f32,
                    gun_dmg: f32,
                    bursts: u32,
                    caught: u32,
                    over: u32,
                    short: u32,
                    long: u32,
                    aside: u32,
                    bomblets: u32,
                    bomblets_caught: u32,
                    hot: u32,
                    ready: u32,
                    pressing: u32,
                    heat_at_launch: f32,
                }
                let mut n = N::default();
                for seed in 1..=seeds {
                    let mut game = Game::new(t0.clone(), crate::map::Map::index("blockout").unwrap());
                    game.bots = false;
                    let human = game.join().unwrap();
                    let bot = game.add_player(1, Some({
                        let mut b = Bot::new(seed);
                        b.skill = env("PROBE_SKILL", "1").parse().unwrap();
                        b.policy.heat_fed = env("PROBE_HEATFED", "0.6").parse().unwrap();
                        b
                    }), class).unwrap();
                    let loadout = Loadout::named(&primary, secondary);
                    for (id, pos, c) in [(human, Vector::new(0.0, 0.1, -5.0), target_class), (bot, Vector::new(0.0, 0.1, -5.0 + range), class)] {
                        let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                        let l = Loadout { ability: if c == MechClass::C { 2 } else { 1 }, ..loadout };
                        (p.class, p.loadout, p.next_loadout) = (c, l, l);
                        p.mech = Mech { class: c, ..spawn(&game.arsenal, c, l, pos) };
                        p.mech.shield = 0.0;
                    }
                    for k in 0..secs(run) {
                        let side = if strafe && (k / secs(1.2)) % 2 == 0 { 1.0 } else if strafe { -1.0 } else { 0.0 };
                        let tick = game.tick;
                        game.push_input(human, InputMsg { seq: tick + 1, input: crate::Input { move_x: side, ..crate::Input::default() }, view_tick: tick as f32 });
                        let dealt = |g: &Game| g.tally(bot).unwrap().0.dealt_by;
                        let before = dealt(&game);
                        let heat_before = mech_of(&game, bot).heat;
                        game.step();
                        let after = dealt(&game);
                        n.alt_dmg += after[1] - before[1];
                        n.gun_dmg += after[0] - before[0];
                        let (b, h) = (mech_of(&game, bot), mech_of(&game, human));
                        let (t, th) = (game.arsenal.of(&b), game.arsenal.of(&h));
                        n.ticks += 1;
                        n.hot += u32::from(b.heat >= 0.6 * t.heat_max);
                        n.ready += u32::from(b.alt_wait <= 0.0);
                        n.pressing += u32::from(game.players.iter().find(|p| p.id == bot).unwrap().bot.as_ref().unwrap().last.alt_fire);
                        if b.launched {
                            n.launches += 1;
                            n.heat_at_launch += heat_before / t.heat_max;
                        }
                        for e in &game.events {
                            let Event::Blast { owner, primary: false, n: k, hits, pos, .. } = *e else { continue };
                            if owner != bot || k >= projectile::TURRET {
                                continue;
                            }
                            let caught = hits & 1 << human != 0;
                            if k >= projectile::BOMBLET {
                                n.bomblets += 1;
                                n.bomblets_caught += u32::from(caught);
                                continue;
                            }
                            n.bursts += 1;
                            if caught {
                                n.caught += 1;
                                continue;
                            }
                            // Where it went, from the bot's side of the target.
                            let (to, off) = (flat(h.pos - b.pos).normalize_or_zero(), flat(pos - h.pos));
                            let (along, across) = (off.dot(to), off.dot(Vector::new(-to.z, 0.0, to.x)).abs());
                            if pos.y > h.pos.y + th.mech_height && along.abs() < 3.0 && across < 3.0 {
                                n.over += 1;
                            } else if across > along.abs() {
                                n.aside += 1;
                            } else if along < 0.0 {
                                n.short += 1;
                            } else {
                                n.long += 1;
                            }
                        }
                        let hm = &mut game.players.iter_mut().find(|p| p.id == human).unwrap().mech;
                        hm.health = th.health_max;
                        let bm = &mut game.players.iter_mut().find(|p| p.id == bot).unwrap().mech;
                        (bm.grenades, bm.emps, bm.ability_cooldown) = (0, 0, 99.0);
                    }
                }
                let mins = n.ticks as f32 / TICK_HZ / 60.0;
                let pct = |x: u32, of: u32| 100.0 * x as f32 / of.max(1) as f32;
                println!(
                    "{secondary:8} {range:>2} m {:8}: launches {:.1}/min (heat {:.0}%), alt {:.0}/min, gun {:.0}/min | bursts caught {}/{} = {:.0}% (over {:.0}%, short {:.0}%, long {:.0}%, aside {:.0}%), bomblets {}/{} | hot {:.0}%, ready {:.0}%, pressing {:.0}%",
                    if strafe { "strafing" } else { "standing" },
                    n.launches as f32 / mins,
                    100.0 * n.heat_at_launch / n.launches.max(1) as f32,
                    n.alt_dmg / mins,
                    n.gun_dmg / mins,
                    n.caught,
                    n.bursts,
                    pct(n.caught, n.bursts),
                    pct(n.over, n.bursts),
                    pct(n.short, n.bursts),
                    pct(n.long, n.bursts),
                    pct(n.aside, n.bursts),
                    n.bomblets_caught,
                    n.bomblets,
                    pct(n.hot, n.ticks),
                    pct(n.ready, n.ticks),
                    pct(n.pressing, n.ticks),
                );
            }
        }
    }
}

fn mech_of(game: &Game, id: u8) -> Mech {
    game.players.iter().find(|p| p.id == id).unwrap().mech
}

/// Ability probe: a Heavy bot with each of `PROBE_BUILDS` (primary:secondary pairs) and Artillery
/// or Barrage against a human Medium in the open on Blockout, `PROBE_RANGE` m off (default 30),
/// standing or strafing. Each case runs twice, the ability live and held on cooldown, so the gap
/// is what it adds. Per minute: uses, and damage by gun and secondary; per use, the heat it went
/// on at (as a share), and of its spell, the share of ticks the gun fired and the launches.
/// PROBE_SEEDS=<n> PROBE_SECS=<s> cargo test -p sim --release --lib ability_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn ability_probe() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let run: f32 = env("PROBE_SECS", "60").parse().unwrap();
    let seeds: u64 = env("PROBE_SEEDS", "8").parse().unwrap();
    let range: f32 = env("PROBE_RANGE", "30").parse().unwrap();
    let t0 = Tuning::default();
    for build in env("PROBE_BUILDS", "squall:mortar,gyre:rocket,hail:mortar,kiln:darts").split(',') {
        let (primary, secondary) = build.split_once(':').unwrap();
        for ability in env("PROBE_ABILITIES", "artillery,barrage").split(',') {
            for strafe in [false, true] {
                let mut line = format!("{primary:6} {secondary:8} {ability:9} {:8}", if strafe { "strafing" } else { "standing" });
                let mut base = 0.0;
                for live in [false, true] {
                    let (mut ticks, mut uses, mut gun, mut alt, mut heat, mut spell, mut firing, mut launches) = (0u32, 0u32, 0.0f32, 0.0f32, 0.0f32, 0u32, 0u32, 0u32);
                    for seed in 1..=seeds {
                        let mut game = Game::new(t0.clone(), crate::map::Map::index("blockout").unwrap());
                        game.bots = false;
                        let human = game.join().unwrap();
                        let bot = game.add_player(1, Some({
                            let mut b = Bot::new(seed);
                            b.skill = env("PROBE_SKILL", "1").parse().unwrap();
                            // Trigger variants for both: as genome 0's, or on the secondary ready, or cool.
                            use crate::brain::{Action, Curve::*, Feature::*};
                            let rule = match env("PROBE_TRIGGER", "fire").as_str() {
                                "alt" => vec![(Engaged, Above(0.5)), (AltReady, Above(0.5)), (Range, AtMost(1.0))],
                                "cool" => vec![(Engaged, Above(0.5)), (Fire, Above(0.5)), (Range, AtMost(1.0)), (Heat, AtMost(0.45))],
                                "altcool" => vec![(Engaged, Above(0.5)), (AltReady, Above(0.5)), (Range, AtMost(1.0)), (Heat, AtMost(0.45))],
                                _ => vec![(Engaged, Above(0.5)), (Fire, Above(0.5)), (Range, AtMost(1.0))],
                            };
                            b.brain.0.insert(Action::Artillery, vec![rule.clone()]);
                            b.brain.0.insert(Action::Barrage, vec![rule]);
                            b
                        }), MechClass::C).unwrap();
                        for (id, pos, c, l) in [
                            (human, Vector::new(0.0, 0.1, -5.0), MechClass::B, Loadout::of(MechClass::B)),
                            (bot, Vector::new(0.0, 0.1, -5.0 + range), MechClass::C, Loadout { ability: arsenal::index(Slot::Ability, ability), ..Loadout::named(primary, secondary) }),
                        ] {
                            let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                            (p.class, p.loadout, p.next_loadout) = (c, l, l);
                            p.mech = Mech { class: c, shield: 0.0, ..spawn(&game.arsenal, c, l, pos) };
                        }
                        for k in 0..secs(run) {
                            let side = if strafe && (k / secs(1.2)) % 2 == 0 { 1.0 } else if strafe { -1.0 } else { 0.0 };
                            let tick = game.tick;
                            game.push_input(human, InputMsg { seq: tick + 1, input: crate::Input { move_x: side, ..crate::Input::default() }, view_tick: tick as f32 });
                            let dealt = |g: &Game| g.tally(bot).unwrap().0.dealt_by;
                            let (before, was) = (dealt(&game), mech_of(&game, bot));
                            game.step();
                            let (after, b) = (dealt(&game), mech_of(&game, bot));
                            (gun, alt) = (gun + after[0] - before[0], alt + after[1] - before[1]);
                            ticks += 1;
                            let t = game.arsenal.of(&b);
                            if b.ability_time > was.ability_time {
                                uses += 1;
                                heat += was.heat / t.heat_max;
                            }
                            if b.ability_time > 0.0 {
                                spell += 1;
                                firing += u32::from(game.players.iter().find(|p| p.id == bot).unwrap().bot.as_ref().unwrap().last.fire);
                                launches += u32::from(b.launched);
                            }
                            let hm = &mut game.players.iter_mut().find(|p| p.id == human).unwrap().mech;
                            hm.health = t0.health_max;
                            let bm = &mut game.players.iter_mut().find(|p| p.id == bot).unwrap().mech;
                            (bm.grenades, bm.emps) = (0, 0);
                            if !live {
                                bm.ability_cooldown = 99.0;
                            }
                        }
                    }
                    let mins = ticks as f32 / TICK_HZ / 60.0;
                    let total = (gun + alt) / mins;
                    if live {
                        line += &format!(
                            " | live {total:.0}/min (gun {:.0}, alt {:.0}), adds {:+.0}/min = {:+.1}% | {:.2} uses/min at heat {:.0}%, spell: gun firing {:.0}% of ticks, {:.1} launches",
                            gun / mins,
                            alt / mins,
                            total - base,
                            100.0 * (total - base) / base.max(1.0),
                            uses as f32 / mins,
                            100.0 * heat / uses.max(1) as f32,
                            100.0 * firing as f32 / spell.max(1) as f32,
                            launches as f32 / uses.max(1) as f32,
                        );
                    } else {
                        base = total;
                        line += &format!(" | off {total:.0}/min (gun {:.0}, alt {:.0})", gun / mins, alt / mins);
                    }
                }
                println!("{line}");
            }
        }
    }
}

/// A secondary in bot-only matches on every map: every bot carries `PROBE_ALT` (other slots as
/// they roll, bounded). Per bot alive-minute: time fighting, launches, the secondary's damage; per
/// launch, damage and heat, and launches by range to the target (under 20, 20-40, 40-60, 60-90,
/// 90 m and over). Of fight ticks with the target in sight: the share hot enough to feed a
/// heat-fed launcher (`Policy::heat_fed`), with the secondary ready, and both.
/// PROBE_ALT=<id> PROBE_SEEDS=<n> PROBE_SECS=<s> cargo test -p sim --release --lib alt_match_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn alt_match_probe() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let run: f32 = env("PROBE_SECS", "120").parse().unwrap();
    let seeds: u64 = env("PROBE_SEEDS", "2").parse().unwrap();
    let alt = env("PROBE_ALT", "furnace");
    let want = Loadout::named("pike", &alt).secondary;
    let bucket = |r: f32| [20.0, 40.0, 60.0, 90.0].iter().take_while(|&&b| r >= b).count();
    let (mut alive, mut fight, mut sight, mut hot, mut ready, mut both, mut launches, mut dealt, mut heat) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u32, 0.0f32, 0.0f32);
    let (mut by_range, mut dealt_by_range, mut total) = ([0u32; 5], [0.0f32; 5], 0.0f32);
    for (index, _) in crate::map::MAPS.iter().enumerate() {
        for seed in 0..seeds {
            let mut game = Game::new(Tuning::default(), index);
            (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
            let human = game.join().unwrap();
            game.dock(human);
            game.step();
            let mut roller = Bot::new(seed + 1);
            // Each launch's owner and the range it went at, by (owner, seq), to credit its damage.
            let mut flying: Vec<(u8, u32, usize)> = Vec::new();
            for _ in 0..secs(run) {
                for i in 0..game.players.len() {
                    let p = &game.players[i];
                    if p.bot.is_none() || p.mech.health <= 0.0 || p.loadout.secondary == want {
                        continue;
                    }
                    let class = p.class;
                    let Some(loadout) = (0..2000).map(|_| roller.pick_loadout(&game.arsenal, class)).find(|l| l.secondary == want) else { continue };
                    let p = &mut game.players[i];
                    (p.loadout, p.next_loadout) = (loadout, loadout);
                    p.mech = Mech { shield: p.mech.shield, ..spawn(&game.arsenal, class, loadout, p.mech.pos) };
                }
                if let Ok(h) = std::env::var("PROBE_HEATFED") {
                    for p in &mut game.players {
                        if let Some(b) = &mut p.bot {
                            b.policy.heat_fed = h.parse().unwrap();
                        }
                    }
                }
                let before: Vec<f32> = game.players.iter().map(|p| p.tally.dealt_by[1]).collect();
                let all_before: f32 = game.players.iter().map(|p| p.tally.dealt).sum();
                game.step();
                total += game.players.iter().map(|p| p.tally.dealt).sum::<f32>() - all_before;
                for (k, p) in game.players.iter().enumerate() {
                    let Some(bot) = &p.bot else { continue };
                    if p.mech.health <= 0.0 || p.respawn_at.is_some() {
                        continue;
                    }
                    let t = game.arsenal.of(&p.mech);
                    let d = p.tally.dealt_by[1] - before.get(k).copied().unwrap_or(0.0);
                    dealt += d;
                    alive += 1;
                    let foe = bot.focus().and_then(|f| game.players.iter().find(|q| q.id == f));
                    if foe.is_some() {
                        fight += 1;
                    }
                    if let Some(q) = foe.filter(|q| bot::sees(&game.arena, t, &p.mech, &q.mech)) {
                        let _ = q;
                        sight += 1;
                        let (h, r) = (p.mech.heat >= bot.policy.heat_fed * t.heat_max, p.mech.alt_wait <= 0.0);
                        (hot, ready, both) = (hot + u64::from(h), ready + u64::from(r), both + u64::from(h && r));
                    }
                    if p.mech.launched {
                        launches += 1;
                        heat += p.mech.heat / t.heat_max;
                        let b = foe.map_or(4, |q| bucket(flat(q.mech.pos - p.mech.pos).length()));
                        by_range[b] += 1;
                        flying.push((p.id, p.ack_seq, b));
                    }
                }
                // Credit each Blast's damage to the range its launch went at.
                for e in &game.events {
                    if let Event::Blast { owner, seq, primary: false, hits, .. } = *e
                        && hits != 0
                        && let Some(&(_, _, b)) = flying.iter().find(|f| f.0 == owner && f.1 == seq)
                    {
                        dealt_by_range[b] += 1.0;
                    }
                }
                if flying.len() > 400 {
                    flying.drain(..200);
                }
            }
        }
    }
    let mins = alive as f32 / TICK_HZ / 60.0;
    let pct = |x: u64, of: u64| 100.0 * x as f32 / of.max(1) as f32;
    println!(
        "{alt}: {mins:.0} alive-min, all dealt {:.0}/min, fight {:.0}%, in sight {:.0}% | launches {:.2}/min, dealt {:.1}/min, {:.1}/launch, heat at launch {:.0}% | in sight: hot {:.0}%, ready {:.0}%, both {:.0}%",
        total / mins,
        pct(fight, alive),
        pct(sight, alive),
        launches as f32 / mins,
        dealt / mins,
        dealt / launches.max(1) as f32,
        100.0 * heat / launches.max(1) as f32,
        pct(hot, sight),
        pct(ready, sight),
        pct(both, sight),
    );
    println!("   launches by range <20/20-40/40-60/60-90/90+ {:?}", by_range.map(|n| format!("{:.0}%", 100.0 * n as f32 / launches.max(1) as f32)));
    println!("   share of those with a hit                {:?}", std::array::from_fn::<_, 5, _>(|k| format!("{:.0}%", 100.0 * dealt_by_range[k] / by_range[k].max(1) as f32)));
}

/// Post probe: bot-only Team Deathmatch on the rotation maps (PROBE_SECS each), sampling every
/// bot every tick: of its time fighting (an enemy in view), how much at a post, in the open or
/// with cover to step out of, and hidden in that cover; and how far it stood from its post.
/// A diagnostic (`--ignored`):
/// cargo test -p sim --release --lib post_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn post_probe() {
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(120.0);
    for name in crate::map::ROTATION {
        let mut game = Game::new(Tuning::default(), crate::map::Map::index(name).unwrap());
        (game.score_limit, game.match_seconds) = (u16::MAX, 1e7);
        let human = game.join().unwrap();
        game.dock(human);
        let (mut fighting, mut posted, mut covered, mut hidden) = (0u32, 0u32, 0u32, 0u32);
        for _ in 0..secs(run) {
            game.step();
            for p in game.players.iter().filter(|p| p.mech.health > 0.0) {
                let Some(b) = p.bot.as_ref() else { continue };
                // Fighting, or hidden at its post.
                let post = b.post_state();
                if b.doing() != crate::bot::Doing::Fight && post.is_none() {
                    continue;
                }
                fighting += 1;
                if let Some((cover, cooling)) = post {
                    posted += 1;
                    covered += u32::from(cover);
                    hidden += u32::from(cooling);
                }
            }
        }
        let pct = |n: u32| 100.0 * n as f32 / fighting.max(1) as f32;
        println!("{name:10} fighting {:5.0} bot-s: at a post {:3.0}%, with cover to step out of {:3.0}%, hidden in it {:3.0}%", fighting as f32 / TICK_HZ, pct(posted), pct(covered), pct(hidden));
    }
}

/// Shield probe: two rifle bots 26 m apart on blockout, with a dome put up around one (or none,
/// the baseline) or a barrier between them once they've met. Over its life, each side's share of
/// time standing idle and firing, overall and with only the shield between them, and the hull
/// worn off it; PROBE_SHOW logs what each bot was doing every third of a second.
/// PROBE_SEEDS=<n> PROBE_SHOW=1 cargo test -p sim --release --lib shield_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn shield_probe() {
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
    let show = std::env::var("PROBE_SHOW").is_ok();
    for case in ["none", "dome on A", "dome on B", "barrier"] {
        // Per side (the shield's own, the other), ticks alive, idle (still and not firing), firing;
        // and the shield's hull worn off.
        let (mut alive, mut idle, mut fired, mut worn) = ([0u32; 2], [0u32; 2], [0u32; 2], 0.0);
        // Ticks where only the shield stands between them (each in the other's clear line but for it).
        let (mut walled, mut walled_idle, mut walled_fired) = ([0u32; 2], [0u32; 2], [0u32; 2]);
        for seed in 0..seeds {
            let t = Tuning::default();
            let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
            (game.score_limit, game.match_seconds) = (u16::MAX, 1e7);
            game.bots = false;
            let human = game.join().unwrap();
            game.dock(human);
            let a = game.add_player(0, Some(Bot::new(10 + seed)), MechClass::B).unwrap();
            let b = game.add_player(1, Some(Bot::new(20 + seed)), MechClass::B).unwrap();
            let (pa, pb) = (Vector::new(0.0, 0.1, 40.0), Vector::new(0.0, 0.1, 14.0));
            for (id, pos) in [(a, pa), (b, pb)] {
                let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                (p.mech.pos, p.mech.loadout) = (pos, Loadout::named("pike", "rocket"));
            }
            // Let them see each other and start fighting first.
            for _ in 0..secs(0.4) {
                game.step();
            }
            let at = |game: &Game, id| game.players.iter().find(|p| p.id == id).unwrap().mech.pos;
            let tick = game.tick;
            let i = items(&game.arsenal).clone();
            // B's barrier goes up halfway, across the way to A.
            let d = at(&game, a) - at(&game, b);
            let (team, owner, pos, yaw, hull, kind, life) = match case {
                "none" | "dome on A" => (0, a, at(&game, a), 0.0, i.dome_hull, Kind::Dome, i.dome_seconds),
                "dome on B" => (1, b, at(&game, b), 0.0, i.dome_hull, Kind::Dome, i.dome_seconds),
                _ => (1, b, at(&game, b) + d * 0.5, libm::atan2f(-d.x, -d.z), i.barrier_hull, Kind::Barrier, i.barrier_seconds),
            };
            let pos = Vector::new(pos.x, 0.0, pos.z);
            if case != "none" {
                game.deployables.push(Deployable { kind, team, owner, pos, yaw, pitch: 0.0, hull, placed: tick, expires: tick + secs(life), ready: 0, burst: 0 });
            }
            game.arena.set_barriers(&i, &game.deployables);
            if show {
                println!("--- {case} seed {seed}: up for {life} s, hull {hull}");
            }
            let mut log: BTreeMap<u8, Vec<String>> = BTreeMap::new();
            for k in 0..secs(life) {
                let before = [a, b].map(|id| at(&game, id));
                for p in &mut game.players {
                    if p.mech.health > 0.0 {
                        p.mech.health = game.arsenal.of(&p.mech).health_max;
                    }
                }
                let hull_before = game.deployables.iter().find(|d| d.kind == kind).map_or(0.0, |d| d.hull);
                game.step();
                worn += hull_before - game.deployables.iter().find(|d| d.kind == kind).map_or(hull_before, |d| d.hull);
                for (n, id) in [a, b].into_iter().enumerate() {
                    let p = game.players.iter().find(|p| p.id == id).unwrap();
                    let bot = p.bot.as_ref().unwrap();
                    let speed = flat(p.mech.pos - before[n]).length() * TICK_HZ;
                    let side = usize::from(p.team != team);
                    let other = game.players.iter().find(|q| q.id == if id == a { b } else { a }).unwrap();
                    let ts = game.arsenal.of(&p.mech);
                    let (eye, chest) = (p.mech.pos + Vector::Y * ts.eye_height, other.mech.pos + Vector::Y * (game.arsenal.of(&other.mech).mech_height * 0.5));
                    let ray = Ray::new(eye, (chest - eye).normalize_or_zero());
                    let len = chest.distance(eye);
                    let clear = game.arena.cast_past_barriers(&ray, len).is_none();
                    let shielded = case != "none" && (deploy::stops(&game.deployables, &i, &ray, len).is_some() || game.arena.cast_ray(&ray, len).is_some());
                    if p.mech.health > 0.0 && other.mech.health > 0.0 && clear && shielded {
                        walled[side] += 1;
                        walled_idle[side] += u32::from(speed < 0.5 && !bot.last.fire);
                        walled_fired[side] += u32::from(bot.last.fire);
                    }
                    if p.mech.health > 0.0 {
                        alive[side] += 1;
                        idle[side] += u32::from(speed < 0.5 && !bot.last.fire);
                        fired[side] += u32::from(bot.last.fire);
                    }
                    if k % 10 == 0 {
                        let inside = flat(p.mech.pos - pos).length() < i.dome_radius;
                        log.entry(id).or_default().push(format!(
                            "{:?}{}{}{}{} v{:.0}{}{}",
                            bot.doing(),
                            if p.mech.heat >= 0.6 * game.arsenal.of(&p.mech).heat_max { "H" } else { "" },
                            if bot.post_state().is_some() { "P" } else { "" },
                            if bot.focus().is_some() { "*" } else { "" },
                            if kind == Kind::Dome && inside { "(in)" } else { "" },
                            speed,
                            if bot.last.fire { " F" } else { "" },
                            if p.mech.health <= 0.0 { " DEAD" } else { "" },
                        ));
                    }
                }
            }
            if show {
                for (id, l) in log {
                    println!("  {}: {}", if id == a { "A" } else { "B" }, l.join(" | "));
                }
            }
        }
        let pct = |n: u32, of: u32| 100.0 * n as f32 / of.max(1) as f32;
        println!(
            "{case:10} owner side idle {:3.0}% firing {:3.0}% | other side idle {:3.0}% firing {:3.0}% | hull worn {:.0} per shield",
            pct(idle[0], alive[0]), pct(fired[0], alive[0]), pct(idle[1], alive[1]), pct(fired[1], alive[1]), worn / seeds as f32
        );
        for side in 0..2 {
            println!(
                "    {} side, {:.1} s/run with only the shield between: idle {:3.0}%, firing {:3.0}%",
                ["owner", "other"][side], walled[side] as f32 / TICK_HZ / seeds as f32, pct(walled_idle[side], walled[side]), pct(walled_fired[side], walled[side])
            );
        }
    }
}

/// Objective probe: bot-only Convoy and Missile Assault (or PROBE_MODE's) on every map that plays
/// it. Of bot time alive with an order: the share standing still and not firing, by what it was
/// about (holding at its order with no enemy in view, fighting one in view, keeping its post on
/// one gone from view, falling back, mending or repairing, or walking but blocked); and the share
/// on the objective (in a silo its side doesn't hold securely, or in reach of the hauler).
/// PROBE_SHOW=1 logs each still stretch of 3 s or more.
/// PROBE_MAP=<name> PROBE_MODE=<key> PROBE_SECS=<s> PROBE_SEEDS=<n> cargo test -p sim --release --lib objective_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn objective_probe() {
    let only = std::env::var("PROBE_MAP").ok();
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(180.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
    let show = std::env::var("PROBE_SHOW").is_ok();
    let modes: Vec<Mode> = std::env::var("PROBE_MODE").ok().and_then(|m| Mode::from_key(&m)).map_or(vec![Mode::Convoy, Mode::MissileAssault], |m| vec![m]);
    for mode in modes {
        for (index, (name, _)) in crate::map::MAPS.iter().enumerate() {
            if only.as_deref().is_some_and(|m| m != *name) || !mode.fits(&Map::load(index)) {
                continue;
            }
            let (mut ordered, mut on_obj, mut still_on_obj) = (0u64, 0u64, 0u64);
            let mut still: BTreeMap<&str, u64> = BTreeMap::new();
            for seed in 0..seeds {
                let mut game = Game::new(Tuning::default(), index);
                game.mode = mode;
                (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
                let human = game.join().unwrap();
                game.dock(human);
                // Each bot's still stretch: since when, and what it was about at its start.
                let mut stretch: BTreeMap<u8, (u32, &str, String)> = BTreeMap::new();
                for _ in 0..secs(run) {
                    let before: BTreeMap<u8, Vector> = game.players.iter().map(|p| (p.id, p.mech.pos)).collect();
                    game.step();
                    let hauler = game.deployables.iter().find(|d| d.kind == Kind::Hauler).map(|d| d.pos);
                    for p in &game.players {
                        let Some(bot) = &p.bot else { continue };
                        let (alive, order) = (p.mech.health > 0.0 && p.respawn_at.is_none(), bot.order);
                        let moved = before.get(&p.id).is_none_or(|&b| flat(p.mech.pos - b).length() > 0.5 * DT);
                        let (i, t) = (&bot.last, game.arsenal.of(&p.mech));
                        let Some(order) = order.filter(|_| alive) else {
                            stretch.remove(&p.id);
                            continue;
                        };
                        ordered += 1;
                        let on = match (&game.assault, hauler) {
                            (Some(a), _) => a.silos.iter().any(|z| z.holds(p.mech.pos) && !z.state.secure(p.team)),
                            (_, Some(h)) => flat(p.mech.pos - h).length() <= convoy::ESCORT_RANGE && (p.mech.pos.y - h.y).abs() <= 6.0,
                            _ => false,
                        };
                        on_obj += u64::from(on);
                        if moved || i.fire || i.alt_fire {
                            if let Some((from, kind, note)) = stretch.remove(&p.id)
                                && show
                                && game.tick - from >= secs(3.0)
                            {
                                println!("[{} {name} s{seed}] bot {} still {:.1}s {kind}{note}", mode.key(), p.id, (game.tick - from) as f32 * DT);
                            }
                            continue;
                        }
                        still_on_obj += u64::from(on);
                        let seen = |q: &&Player| q.team != p.team && q.mech.health > 0.0 && bot::sees(&game.arena, t, &p.mech, &q.mech);
                        let target = bot.focus().and_then(|f| game.players.iter().find(|q| q.id == f));
                        let kind = match bot.doing() {
                            bot::Doing::FallBack => "fallback",
                            bot::Doing::Mend => "mend",
                            _ if i.repair || p.mech.repair_time > 0.0 => "repair",
                            _ if (i.move_x.abs() + i.move_z.abs()) > 0.3 => "blocked",
                            _ if bot.focus().is_some() && target.is_none_or(|q| bot::sees(&game.arena, t, &p.mech, &q.mech)) => "fight",
                            _ if bot.focus().is_some() => "post",
                            _ if flat(order - p.mech.pos).length() < 3.0 && game.players.iter().any(|q| seen(&q)) => "hold, enemy in sight",
                            _ if flat(order - p.mech.pos).length() < 3.0 && on => "hold, on it",
                            _ if flat(order - p.mech.pos).length() < 3.0 => "hold, off it",
                            _ => "other",
                        };
                        *still.entry(kind).or_insert(0) += 1;
                        stretch.entry(p.id).or_insert_with(|| {
                            let state = match (&game.assault, hauler) {
                                (Some(a), _) => a.silos.iter().enumerate().filter(|(_, z)| z.holds(p.mech.pos)).map(|(k, z)| format!("silo {k} {:?} in it {:?}", z.state, [0, 1].map(|t| game.players.iter().filter(|q| q.team == t && q.mech.health > 0.0 && z.holds(q.mech.pos)).count()))).collect::<String>(),
                                (_, Some(h)) => format!("hauler {:.0}m off, {:?}", flat(h - p.mech.pos).length(), game.convoy.as_ref().map(|c| (c.pusher, c.escorts, c.contested, c.stalled))),
                                _ => String::new(),
                            };
                            let note = format!(
                                "\n    pos={:.1} order={:.1} on={on} {state} team={} heat={:.0}% input move=({:.2},{:.2}) yaw={:.2} fire={}\n    {}",
                                p.mech.pos,
                                order,
                                p.team,
                                100.0 * p.mech.heat / t.heat_max,
                                i.move_x,
                                i.move_z,
                                i.yaw,
                                i.fire,
                                bot.describe(game.nav, &p.mech)
                            );
                            (game.tick, kind, note)
                        });
                    }
                }
            }
            let pct = |n: u64| 100.0 * n as f32 / ordered.max(1) as f32;
            let total: u64 = still.values().sum();
            let by: Vec<String> = still.iter().map(|(k, &n)| format!("{k} {:.1}%", pct(n))).collect();
            println!(
                "== {} {name}: {:.0} bot-s ordered; still {:.1}% ({}); on the objective {:.1}%, still there {:.1}%",
                mode.key(),
                ordered as f32 * DT,
                pct(total),
                by.join(", "),
                pct(on_obj),
                pct(still_on_obj)
            );
        }
    }
}

/// CTF probe: bot-only Capture the Flag on every map that plays it. Each carry (a flag in a
/// raider's hands, off its stand or off the ground, until it falls or scores): the share that
/// score, how much of the way home it got, how long it lasted, what the carrier was about, how
/// many of its side were within ESCORT m of it and how many enemies saw it.
/// PROBE_MAP=<name> PROBE_SECS=<s> PROBE_SEEDS=<n> cargo test -p sim --release --lib ctf_probe -- --ignored --nocapture
#[test]
#[ignore = "probe"]
fn ctf_probe() {
    const ESCORT: f32 = 20.0;
    let only = std::env::var("PROBE_MAP").ok();
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(300.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(4);
    for (index, (name, _)) in crate::map::MAPS.iter().enumerate() {
        if only.as_deref().is_some_and(|m| m != *name) || !Mode::CaptureTheFlag.fits(&Map::load(index)) {
            continue;
        }
        let (mut carries, mut scored, mut takes) = (0u32, 0u32, 0u32);
        let (mut progress, mut ticks, mut escorts, mut seen_by) = (0.0f32, 0u64, 0u64, 0u64);
        let mut doing: BTreeMap<&str, u64> = BTreeMap::new();
        for seed in 0..seeds {
            let mut game = Game::new(Tuning::default(), index);
            game.mode = Mode::CaptureTheFlag;
            (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
            let human = game.join().unwrap();
            game.dock(human);
            // Per flag, its carry so far: how far from home it started and is now.
            let mut carry: [Option<(f32, f32)>; 2] = [None; 2];
            for _ in 0..secs(run) {
                let caps = game.ctf.as_ref().map_or([0; 2], |c| c.captures);
                game.step();
                takes += game.events.iter().filter(|e| matches!(e, Event::Flag { what: Happened::Taken, .. })).count() as u32;
                let Some(c) = game.ctf.as_ref() else { continue };
                for f in 0..2 {
                    let carrier = match c.flags[f] {
                        ctf::Flag::Carried { by } => game.players.iter().find(|p| p.id == by),
                        _ => None,
                    };
                    let Some(p) = carrier else {
                        if let Some((from, now)) = carry[f].take() {
                            carries += 1;
                            scored += u32::from(c.captures[1 - f] > caps[1 - f]);
                            progress += if c.captures[1 - f] > caps[1 - f] { 1.0 } else { (1.0 - now / from.max(1.0)).max(0.0) };
                        }
                        continue;
                    };
                    let d = flat(c.stands[usize::from(p.team)].at - p.mech.pos).length();
                    carry[f].get_or_insert((d, d)).1 = d;
                    ticks += 1;
                    escorts += game.players.iter().filter(|q| q.team == p.team && q.id != p.id && q.mech.health > 0.0 && flat(q.mech.pos - p.mech.pos).length() <= ESCORT).count() as u64;
                    seen_by += game.players.iter().filter(|q| q.team != p.team && q.mech.health > 0.0 && bot::sees(&game.arena, game.arsenal.of(&q.mech), &q.mech, &p.mech)).count() as u64;
                    let kind = p.bot.as_ref().map_or("human", |b| match b.doing() {
                        bot::Doing::Fight => "fight",
                        bot::Doing::FallBack => "fall back",
                        bot::Doing::Mend => "mend",
                        bot::Doing::Move => "move",
                        bot::Doing::Trade => "trade",
                    });
                    *doing.entry(kind).or_insert(0) += 1;
                }
            }
        }
        let per = |n: u64| n as f32 / ticks.max(1) as f32;
        let by: Vec<String> = doing.iter().map(|(k, &n)| format!("{k} {:.0}%", 100.0 * per(n))).collect();
        println!(
            "== ctf {name}: {takes} takes, {carries} carries, {:.0}% scored, {:.0}% of the way home on average, {:.1} s a carry; carrier {}; {:.1} of its side within {ESCORT:.0} m, seen by {:.1}",
            100.0 * scored as f32 / carries.max(1) as f32,
            100.0 * progress / carries.max(1) as f32,
            ticks as f32 * DT / carries.max(1) as f32,
            by.join(", "),
            per(escorts),
            per(seen_by),
        );
    }
}
