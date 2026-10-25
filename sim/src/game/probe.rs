//! Stuck probe: bot-only matches on every map, logging each bot that stays within 2 m for 5 s or
//! more, sorted by why (pushing but not moving, repairing, perched, or standing about), and the
//! share of bot time spent so. A diagnostic, not a check (`--ignored`):
//! PROBE_MAP=<name> PROBE_SECS=<s> PROBE_SEEDS=<n> PROBE_SHOW=<kind|all|none> \
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
