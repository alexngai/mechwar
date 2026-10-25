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
