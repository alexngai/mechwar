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
/// hurt teammate in sight within twice the beam's reach), following (by its lead) or otherwise.
/// PROBE_MAP=<name> PROBE_SECS=<s> PROBE_SEEDS=<n> cargo test -p sim --release --lib torch_probe -- --ignored --nocapture
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
        mend: u64,
        follow: u64,
        credit: f32,
        deaths: u32,
    }
    let only = std::env::var("PROBE_MAP").ok();
    let run: f32 = std::env::var("PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(180.0);
    let seeds: u64 = std::env::var("PROBE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(2);
    let mut arms = [Arm::default(), Arm::default()]; // [torches, the rest]
    let mut scores = [0u32; 2]; // [the torches' side, the other]
    for (index, (name, _)) in crate::map::MAPS.iter().enumerate() {
        if only.as_deref().is_some_and(|m| m != *name) {
            continue;
        }
        for seed in 0..seeds {
            let mut game = Game::new(Tuning::default(), index);
            (game.score_limit, game.match_seconds, game.tick) = (u16::MAX, 1e7, seed as u32 * 7919);
            let human = game.join().unwrap();
            game.dock(human);
            game.step();
            // Torches on each side in turn, as the docked human's place is on side 0.
            let side = (seed % 2) as u8;
            let torches: Vec<u8> = game.players.iter().filter(|p| p.team == side && p.bot.is_some()).map(|p| p.id).step_by(2).collect();
            let mut roller = Bot::new(seed + 1);
            for _ in 0..secs(run) {
                game.step();
                // Each life its side's build: a torch, or another secondary, on a gun a torch bot picks.
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
                        if torch(&l) == want && long.contains(&l.primary) {
                            break l;
                        }
                    };
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
                    if let Some(q) = foe {
                        arm.fight += 1;
                        arm.fight_in_reach += u64::from(q.mech.pos.distance(p.mech.pos) < reach);
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
        }
    }
    println!("== kills: torch side {} other side {} ({:.1}% to the torch side)", scores[0], scores[1], 100.0 * scores[0] as f32 / (scores[0] + scores[1]).max(1) as f32);
    for (label, a) in ["torch", "other"].iter().zip(&arms) {
        let min = a.alive as f32 / TICK_HZ / 60.0;
        let share = |n: u64| 100.0 * n as f32 / a.alive.max(1) as f32;
        println!(
            "== {label}: {min:.0} bot-min | per min: healed {:.1} burned {:.1} credit {:.2} deaths {:.2} | time: fight {:.0}% (in beam reach {:.0}%) mend {:.0}% follow {:.0}% other {:.0}% | beam on mate {:.1}% foe {:.1}% nothing {:.1}%",
            a.healed / min,
            a.burned / min,
            a.credit / min,
            a.deaths as f32 / min,
            share(a.fight),
            share(a.fight_in_reach),
            share(a.mend),
            share(a.follow),
            share(a.alive - a.fight - a.mend - a.follow),
            share(a.beam_mate),
            share(a.beam_foe),
            share(a.beam_none),
        );
    }
}
