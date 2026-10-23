//! Netcode checks without sockets: one Game and two NetClients joined by in-memory links
//! with a fixed latency each way.

use std::collections::VecDeque;
use std::ops::Range;

use sim::client::NetClient;
use sim::game::Game;
use sim::net::{self, ClientMsg, Event, InputMsg, PlayerNet, ServerMsg};
use sim::{DT, Input, Loadout, Map, MechClass, Slot, TICK_HZ, Tuning, Vector};

/// The original blockout arena: the duels below rely on its open line between the slot-0 spawns.
fn blockout() -> usize {
    Map::index("blockout").unwrap()
}

/// One-way latency: 67 ms each way, about 133 ms round trip.
const LATENCY_TICKS: u32 = 2;

struct Harness {
    game: Game,
    clients: Vec<(u8, NetClient)>,
    /// (deliver at tick, player id, bytes)
    up: VecDeque<(u32, u8, Vec<u8>)>,
    down: VecDeque<(u32, u8, Vec<u8>)>,
    tick: u32,
    /// Strip lag compensation by claiming every input saw the present.
    no_rewind: bool,
}

/// The base tuning with no spawn shield, so a fresh mech can be hit straight away.
fn unshielded() -> Tuning {
    Tuning { spawn_shield: 0.0, ..Tuning::default() }
}

/// Base tuning with the primary narrowed to one exact ray at full damage, for tests that count
/// hits. Server side only: the clients still predict with the compiled-in tuning.
fn laser() -> Tuning {
    Tuning { spread_deg: 0.0, bloom_per_shot: 0.0, falloff_start: 1000.0, falloff_end: 1000.0, ..unshielded() }
}

impl Harness {
    fn new() -> Self {
        Self::tuned(laser(), [MechClass::B; 2])
    }

    fn with_classes(classes: [MechClass; 2]) -> Self {
        Self::tuned(unshielded(), classes)
    }

    /// Classes are picked before any input, so both spawn in them.
    fn tuned(tuning: Tuning, classes: [MechClass; 2]) -> Self {
        let mut game = Game::new(tuning, blockout());
        game.bots = false;
        let clients = classes
            .into_iter()
            .map(|class| {
                let id = game.join().expect("room for two");
                // A Medium carries tuning.json's own weapons, the rifle and rocket; the rest their own.
                game.pick(id, class, if class == MechClass::B { base_weapons() } else { Loadout::of(class) });
                let mut c = NetClient::default();
                c.receive(&net::encode(&ServerMsg::Welcome { id, map: blockout() as u8 }), 0.0);
                (id, c)
            })
            .collect();
        Self { game, clients, up: VecDeque::new(), down: VecDeque::new(), tick: 0, no_rewind: false }
    }

    fn now(&self) -> f64 {
        f64::from(self.tick) * f64::from(DT) * 1000.0
    }

    /// One tick: both clients predict and send, due messages land, the server steps and replies.
    fn step(&mut self, inputs: [Input; 2]) {
        let now = self.now();
        for (k, (id, c)) in self.clients.iter_mut().enumerate() {
            self.up.push_back((self.tick + LATENCY_TICKS, *id, c.tick(inputs[k], now)));
        }
        while self.up.front().is_some_and(|m| m.0 <= self.tick) {
            let (_, id, bytes) = self.up.pop_front().unwrap();
            let Some(ClientMsg::Input(mut msg)) = net::decode(&bytes) else { panic!("clients only send inputs here") };
            if self.no_rewind {
                msg.view_tick = f32::MAX;
            }
            self.game.push_input(id, msg);
        }
        self.game.step();
        for (id, _) in &self.clients {
            let snapshot = net::encode(&ServerMsg::Snapshot(self.game.snapshot(*id)));
            self.down.push_back((self.tick + LATENCY_TICKS, *id, snapshot));
        }
        while self.down.front().is_some_and(|m| m.0 <= self.tick) {
            let (_, id, bytes) = self.down.pop_front().unwrap();
            self.clients.iter_mut().find(|c| c.0 == id).unwrap().1.receive(&bytes, now);
        }
        self.tick += 1;
    }
}

#[test]
fn prediction_matches_server() {
    // Light and heavy: prediction must use the same class tuning as the server.
    let mut h = Harness::with_classes([MechClass::A, MechClass::C]);
    let mut last: Vec<Vector> = h.clients.iter().map(|c| c.1.mech.pos).collect();
    let mut travelled = [0f32; 2];
    let mut max_correction = 0f32;
    for tick in 0..300u32 {
        let i = Input::default();
        // A walks with a slow turn, boosts, dodges, hovers and fires; B strafes, dodges and hovers.
        let a = match tick {
            0..60 => Input { move_z: 1.0, yaw: tick as f32 * 0.01, ..i },
            60..90 => Input { move_z: 1.0, boost: true, yaw: 0.6, ability: tick == 60, ..i },
            90 => Input { dodge: 1, yaw: 0.6, ..i },
            91..130 => Input { hover: true, move_x: -1.0, yaw: 0.6, ..i },
            _ => Input { fire: tick < 160, pitch: -0.2, yaw: 0.6, ..i },
        };
        let b = Input {
            move_x: if (tick / 20) % 2 == 0 { 1.0 } else { -1.0 },
            dodge: if tick == 100 { -1 } else { 0 },
            hover: (150..180).contains(&tick),
            ability: tick == 120,
            ..i
        };
        h.step([a, b]);
        for (k, (_, c)) in h.clients.iter().enumerate() {
            max_correction = max_correction.max(c.correction);
            if tick > 10 {
                travelled[k] += (c.mech.pos - last[k]).length();
            }
            last[k] = c.mech.pos;
        }
    }
    assert!(max_correction < 1e-5, "prediction drifted from the server by {max_correction} m");
    for (k, moved) in travelled.iter().enumerate() {
        assert!(*moved > 30.0, "client {k} only travelled {moved} m, so the test proved nothing");
    }
}

#[test]
fn prediction_matches_server_through_repair() {
    let t = unshielded();
    let mut h = Harness::new();
    let a_id = h.clients[0].0;
    let (mut max_correction, mut a_shots, mut repaired_for) = (0f32, 0, 0f32);
    let (mut hurt, mut still_at) = (t.health_max, Vector::ZERO);
    let mut last = h.clients[0].1.mech.pos;
    let mut walked = 0.0;
    for tick in 0..300u32 {
        // B fires at A for a second; A waits it out, then holds repair with everything else
        // pressed (all ignored) for 4.5 s, then walks off.
        let now = h.now();
        let b = &h.clients[1].1;
        let b_input = b.remotes(now).first().map_or_else(Input::default, |a| {
            let d = a.view.pos + Vector::Y * (t.mech_height * 0.5) - (b.mech.pos + Vector::Y * t.eye_height);
            Input { yaw: (-d.x).atan2(-d.z), pitch: d.y.atan2(d.x.hypot(d.z)), fire: tick < 30, ..Input::default() }
        });
        let a_input = match tick {
            0..45 => Input::default(),
            45..180 => Input { repair: true, move_z: 1.0, boost: true, fire: true, alt_fire: true, dodge: i8::from(tick == 60), ..Input::default() },
            _ => Input { move_z: 1.0, yaw: 0.6, ..Input::default() },
        };
        h.step([a_input, b_input]);
        a_shots += h.game.snapshot(a_id).events.iter().filter(|e| matches!(e, Event::Shot { shooter, .. } if *shooter == a_id)).count();
        max_correction = h.clients.iter().map(|c| c.1.correction).fold(max_correction, f32::max);
        let a = &h.clients[0].1.mech;
        repaired_for = repaired_for.max(a.repair_time);
        if tick == 45 {
            (hurt, still_at) = (a.health, a.pos);
        }
        if tick == 179 {
            assert!(a.pos.distance(still_at) < 1e-3, "A moved {} m while repairing", a.pos.distance(still_at));
            assert!(a.health > hurt + 20.0, "A only healed from {hurt} to {}", a.health);
        }
        if tick >= 180 {
            walked += (a.pos - last).length();
        }
        last = a.pos;
    }
    assert!(hurt < t.health_max - 20.0, "B's shots didn't land, so the test proved little");
    assert!(repaired_for > t.repair_windup + 2.0, "A only repaired for {repaired_for} s");
    assert_eq!(a_shots, 0, "A fired while repairing");
    assert!(walked > 10.0, "A only walked {walked} m after repairing");
    assert!(max_correction < 1e-5, "prediction drifted from the server by {max_correction} m");
}

/// A stands still and fires at where it *sees* B during `fire`, while B strafes with `strafe(tick)`.
/// Returns (hits before B's first death, shots before it, whether B died) and the harness.
fn duel(no_rewind: bool, ticks: u32, fire: Range<u32>, strafe: impl Fn(u32) -> f32) -> (u32, u32, bool, Harness) {
    let mut h = Harness::new();
    h.no_rewind = no_rewind;
    let t = unshielded();
    let (mut hits, mut shots, mut killed) = (0, 0, false);
    for tick in 0..ticks {
        let now = h.now();
        let a = &h.clients[0].1;
        let aim = a.remotes(now).first().map(|b| {
            let eye = a.mech.pos + Vector::Y * t.eye_height;
            let d = b.view.pos + Vector::Y * (t.mech_height * 0.5) - eye;
            ((-d.x).atan2(-d.z), d.y.atan2(d.x.hypot(d.z)))
        });
        let a_input = match aim {
            Some((yaw, pitch)) => Input { yaw, pitch, fire: !killed && fire.contains(&tick), ..Input::default() },
            None => Input::default(),
        };
        h.step([a_input, Input { move_x: strafe(tick), ..Input::default() }]);

        for e in std::mem::take(&mut h.clients[0].1.events) {
            match e {
                Event::Shot { shooter: 0, hit, .. } if !killed => {
                    shots += 1;
                    hits += u32::from(hit == Some(1));
                }
                Event::Kill { killer: 0, victim: 1 } => killed = true,
                _ => {}
            }
        }
    }
    (hits, shots, killed, h)
}

#[test]
fn lag_compensated_hits_kill_and_respawn() {
    let t = unshielded();
    let zigzag = |tick: u32| if (tick / 20) % 2 == 0 { 1.0 } else { -1.0 };
    let (hits, shots, killed, h) = duel(false, 300, 0..300, zigzag);
    assert!(killed, "B never died: {hits}/{shots} hits");
    assert_eq!(hits, shots, "with lag compensation every shot at the drawn target should hit");
    assert_eq!(hits, (t.health_max / t.shot_damage).ceil() as u32);
    assert_eq!(h.clients[0].1.kills, 1);
    assert_eq!(h.clients[1].1.deaths, 1);
    // Killed around tick 70, B waits in the hangar (ready once respawn_delay is up) until it
    // launches, then it's back at full health.
    let mut h = h;
    assert!(h.clients[1].1.mech.health <= 0.0, "B respawned without launching");
    assert_eq!(h.clients[1].1.hangar, Some(0.0));
    let b = h.clients[1].0;
    h.game.pick_class(b, MechClass::B);
    for _ in 0..LATENCY_TICKS * 2 + 2 {
        h.step([Input::default(); 2]);
    }
    assert_eq!(h.clients[1].1.mech.health, t.health_max, "B didn't launch");
}

#[test]
fn rewind_is_what_makes_shots_land() {
    // B runs one way at 9 m/s (three quarters of walk speed, so it stays clear of cover). A sees
    // it ~7 ticks (233 ms) late: 2.1 m, more than the capsule radius, so only rewinding can hit.
    let run = |_| 0.75;
    let (hits, shots, ..) = duel(false, 50, 25..40, run);
    assert!(shots >= 3 && hits == shots, "with rewind: {hits}/{shots}");
    let (hits, shots, ..) = duel(true, 50, 25..40, run);
    assert!(shots >= 3 && hits == 0, "without rewind: {hits}/{shots}");
}

fn send(game: &mut Game, id: u8, seq: &mut u32, n: u32, input: Input) {
    for _ in 0..n {
        *seq += 1;
        game.push_input(id, InputMsg { seq: *seq, input, view_tick: 0.0 });
    }
}

#[test]
fn input_backlog_drains_and_rate_is_capped() {
    let t = unshielded();
    let mut game = Game::new(t.clone(), blockout());
    game.bots = false;
    let id = game.join().unwrap();
    let (mut seq, idle) = (0, Input::default());

    // A frame hitch: one tick gets no input, the next gets two, then 1 per tick again. The
    // backlog must clear, not linger as permanent extra latency.
    for n in [1, 1, 0, 2] {
        send(&mut game, id, &mut seq, n, idle);
        game.step();
    }
    for _ in 0..5 {
        send(&mut game, id, &mut seq, 1, idle);
        game.step();
    }
    assert_eq!(game.snapshot(id).ack_seq, seq, "inputs still queued after a one-off burst");

    // A client sending at twice the tick rate must not move faster than walk speed.
    let start = game.snapshot(id).me.pos;
    let walk = Input { move_z: 1.0, ..idle };
    for _ in 0..60 {
        send(&mut game, id, &mut seq, 2, walk);
        game.step();
    }
    let moved = (game.snapshot(id).me.pos - start).length();
    assert!(moved < t.walk_speed * 2.0 * 1.1, "moved {moved} m in 2 s sending inputs at 2x");
}

fn bots(game: &Game, id: u8) -> usize {
    game.snapshot(id).players.iter().filter(|p| p.bot).count()
}

fn team_of(game: &Game, id: u8) -> u8 {
    game.snapshot(id).players.iter().find(|p| p.id == id).unwrap().team
}

#[test]
fn teams_fill_and_balance() {
    let mut game = Game::new(unshielded(), blockout());
    let a = game.join().unwrap();
    game.step();
    let s = game.snapshot(a);
    assert_eq!(s.players.len(), 8);
    for team in 0..2 {
        assert_eq!(s.players.iter().filter(|p| p.team == team).count(), 4, "team {team} not full");
    }
    assert_eq!(bots(&game, a), 7, "a lone human should get 7 bots");

    let b = game.join().unwrap();
    game.step();
    assert_ne!(team_of(&game, a), team_of(&game, b), "second human should balance onto the other team");
    assert_eq!(bots(&game, a), 6);
    assert_eq!(game.snapshot(a).players.len(), 8);

    for _ in 0..6 {
        assert!(game.join().is_some());
    }
    assert_eq!(bots(&game, a), 0);
    assert!(game.join().is_none(), "a 9th human should be turned away");
}

#[test]
fn no_friendly_fire() {
    let t = unshielded();
    let mut game = Game::new(t.clone(), blockout());
    game.bots = false;
    let shooter = game.join().unwrap();
    let _enemy = game.join().unwrap();
    let mate = game.join().unwrap();
    assert_eq!(team_of(&game, shooter), team_of(&game, mate));
    game.step();

    // Spawn slots put the teammate 15 m to the shooter's left on the same line.
    let (from, to) = (game.snapshot(shooter).me.pos, game.snapshot(mate).me.pos);
    let d = to + Vector::Y * (t.mech_height * 0.5) - (from + Vector::Y * t.eye_height);
    let aim = Input { yaw: (-d.x).atan2(-d.z), pitch: d.y.atan2(d.x.hypot(d.z)), fire: true, ..Input::default() };
    let mut seq = 0;
    let mut shots = 0;
    for _ in 0..30 {
        send(&mut game, shooter, &mut seq, 1, aim);
        game.step();
        for e in game.snapshot(shooter).events {
            if let Event::Shot { hit, end, .. } = e {
                shots += 1;
                assert_eq!(hit, None, "hit a teammate");
                assert!((end - from).length() > d.length() + 5.0, "shot stopped short of the teammate");
            }
        }
    }
    assert!(shots >= 5);
    assert_eq!(game.snapshot(mate).me.health, t.health_max);
}

#[test]
fn match_ends_and_restarts() {
    let t = unshielded();
    let mut game = Game::new(t.clone(), blockout());
    game.score_limit = 2;
    let human = game.join().unwrap();
    let mut seq = 0;
    let mut step = |game: &mut Game| {
        send(game, human, &mut seq, 1, Input::default());
        game.step();
        game.snapshot(human)
    };

    let mut ticks = 0;
    let ended = loop {
        let s = step(&mut game);
        if s.state.ended {
            break s.state;
        }
        ticks += 1;
        assert!(ticks < 60 * 30, "nobody reached 2 kills in 60 s");
    };
    let winner = ended.winner.expect("a score-limit win isn't a draw");
    assert_eq!(ended.scores[usize::from(winner)], 2);

    // Post-match: shots fly but nobody dies, then a fresh match starts with every bot healthy and
    // every human back in the hangar.
    let restarted = loop {
        let s = step(&mut game);
        assert!(!s.events.iter().any(|e| matches!(e, Event::Kill { .. })), "kill after the match ended");
        if !s.state.ended {
            break s;
        }
    };
    assert_eq!(restarted.state.scores, [0, 0]);
    let classes = class_tunings();
    let fresh = |p: &PlayerNet| if p.bot { p.view.health == classes[p.class.index()].health_max } else { p.docked };
    assert!(restarted.players.iter().all(|p| fresh(p) && p.kills == 0 && p.deaths == 0));

    // Time limit with no kills is a draw.
    let mut game = Game::new(t, blockout());
    game.bots = false;
    game.match_seconds = 1.0;
    let human = game.join().unwrap();
    for _ in 0..31 {
        game.step();
    }
    let state = game.snapshot(human).state;
    assert!(state.ended && state.winner.is_none() && state.scores == [0, 0]);
}

#[test]
fn second_human_replaces_a_bot() {
    let mut game = Game::new(unshielded(), blockout());
    let human = game.join().unwrap();
    game.step();
    assert!(game.join().is_some(), "a bot should give up its slot");
    game.step();
    assert_eq!(bots(&game, human), 6);
    assert_eq!(game.snapshot(human).players.len(), 8);
}

fn class_tunings() -> [Tuning; 3] {
    MechClass::ALL.map(|c| unshielded().for_class(c))
}

fn player(game: &Game, id: u8) -> sim::net::PlayerNet {
    game.snapshot(id).players.into_iter().find(|p| p.id == id).unwrap()
}

/// Input for `shooter` aiming at `victim`'s chest as the server has them now.
fn aim_at(game: &Game, shooter: u8, victim: u8, fire: bool) -> Input {
    let classes = class_tunings();
    let (s, v) = (player(game, shooter), player(game, victim));
    let (st, vt) = (&classes[s.class.index()], &classes[v.class.index()]);
    let d = v.view.pos + Vector::Y * (vt.mech_height * 0.5) - (s.view.pos + Vector::Y * st.eye_height);
    Input { yaw: (-d.x).atan2(-d.z), pitch: d.y.atan2(d.x.hypot(d.z)), fire, ..Input::default() }
}

/// `shooter` (no latency) holds aim on `victim`'s chest and fires until a kill; returns the hits.
fn shoot_until_kill(game: &mut Game, shooter: u8, victim: u8) -> u32 {
    let (mut shooter_seq, mut victim_seq, mut hits) = (0, 0, 0);
    for _ in 0..(30.0 * TICK_HZ) as u32 {
        let aim = aim_at(game, shooter, victim, true);
        send(game, shooter, &mut shooter_seq, 1, aim);
        send(game, victim, &mut victim_seq, 1, Input::default());
        game.step();
        for e in game.snapshot(shooter).events {
            match e {
                Event::Shot { hit: Some(h), .. } if h == victim => hits += 1,
                Event::Kill { victim: k, .. } if k == victim => return hits,
                _ => {}
            }
        }
    }
    panic!("no kill in 30 s after {hits} hits");
}

fn duel_game() -> (Game, u8, u8) {
    duel_game_with(laser())
}

fn duel_game_with(tuning: Tuning) -> (Game, u8, u8) {
    let mut game = Game::new(tuning, blockout());
    game.bots = false;
    let shooter = game.join().unwrap();
    let victim = game.join().unwrap();
    (game, shooter, victim)
}

#[test]
fn heavier_class_takes_more_hits() {
    let classes = class_tunings();
    for class in [MechClass::A, MechClass::C] {
        let (mut game, shooter, victim) = duel_game();
        game.pick_class(victim, class);
        game.step();
        let needed = (classes[class.index()].health_max / classes[MechClass::B.index()].shot_damage).ceil() as u32;
        assert_eq!(shoot_until_kill(&mut game, shooter, victim), needed, "{class:?}");
    }
}

#[test]
fn class_applies_now_then_at_the_next_launch() {
    let classes = class_tunings();
    let (mut game, shooter, victim) = duel_game();

    // Picked before any input: spawn as a Heavy right away.
    game.pick_class(victim, MechClass::C);
    game.step();
    assert_eq!(player(&game, victim).class, MechClass::C);
    assert_eq!(game.snapshot(victim).me.health, classes[MechClass::C.index()].health_max);

    // Once moving, a new pick does nothing; the next launch, from the hangar, takes its own.
    let mut seq = 0;
    send(&mut game, victim, &mut seq, 1, Input::default());
    game.step();
    game.pick_class(victim, MechClass::A);
    game.step();
    assert_eq!(player(&game, victim).class, MechClass::C);

    shoot_until_kill(&mut game, shooter, victim);
    game.pick_class(victim, MechClass::A);
    for _ in 0..(classes[MechClass::C.index()].respawn_delay * TICK_HZ) as u32 + 2 {
        game.step();
    }
    assert_eq!(player(&game, victim).class, MechClass::A);
    assert_eq!(game.snapshot(victim).me.health, classes[MechClass::A.index()].health_max);
}

#[test]
fn brace_cuts_damage() {
    let classes = class_tunings();
    let (bulwark, hit) = (&classes[MechClass::C.index()], classes[MechClass::B.index()].shot_damage);
    let (mut game, shooter, victim) = duel_game();
    game.pick_class(victim, MechClass::C);
    game.step();

    // Bulwark on the first tick, then a burst inside the 5 s window and another after it.
    let (mut shooter_seq, mut victim_seq) = (0, 0);
    let (mut braced, mut unbraced) = (Vec::new(), Vec::new());
    let mut last = game.snapshot(victim).me.health;
    for tick in 0..(8.0 * TICK_HZ) as u32 {
        let secs = tick as f32 / TICK_HZ;
        let fire = (0.5..1.5).contains(&secs) || (6.0..7.0).contains(&secs);
        let aim = aim_at(&game, shooter, victim, fire);
        send(&mut game, shooter, &mut shooter_seq, 1, aim);
        send(&mut game, victim, &mut victim_seq, 1, Input { ability: tick == 0, ..Input::default() });
        game.step();
        let hits = game.snapshot(shooter).events.iter().filter(|e| matches!(e, Event::Shot { hit: Some(h), .. } if *h == victim)).count();
        let health = game.snapshot(victim).me.health;
        if hits > 0 {
            let per_hit = (last - health) / hits as f32;
            if secs < 5.0 { braced.push(per_hit) } else { unbraced.push(per_hit) }
        }
        last = health;
    }
    assert!(!braced.is_empty() && !unbraced.is_empty(), "no hits landed");
    assert!(braced.iter().all(|d| (d - hit * bulwark.brace_damage_mult).abs() < 1e-3), "braced hits: {braced:?}");
    assert!(unbraced.iter().all(|d| (d - hit).abs() < 1e-3), "unbraced hits: {unbraced:?}");
}

#[test]
fn damage_cancels_repair() {
    let t = unshielded();
    let (mut game, shooter, victim) = duel_game();
    let (mut shooter_seq, mut victim_seq) = (0, 0);
    let repair = Input { repair: true, ..Input::default() };
    let mut tick = |game: &mut Game, shoot: bool, victim_input: Input| {
        let aim = aim_at(game, shooter, victim, shoot);
        send(game, shooter, &mut shooter_seq, 1, aim);
        send(game, victim, &mut victim_seq, 1, victim_input);
        game.step();
    };

    for _ in 0..15 {
        tick(&mut game, true, Input::default());
    }
    let hurt = game.snapshot(victim).me.health;
    assert!(hurt < t.health_max, "no hits landed");
    for _ in 0..((t.repair_windup + 1.0) * TICK_HZ) as u32 {
        tick(&mut game, false, repair);
    }
    let healed = game.snapshot(victim).me.health;
    assert!(healed > hurt + 0.5 * t.repair_rate, "repair healed {hurt} only to {healed}");
    assert!(player(&game, victim).view.repairing, "others can't see the repair");

    // One hit ends it; held on, it starts over at once, wind-up first.
    tick(&mut game, true, repair);
    let me = game.snapshot(victim).me;
    assert!(me.health < healed, "the shot missed");
    assert!(me.repair_time <= DT * 1.01, "the hit didn't restart the wind-up ({} s in)", me.repair_time);
    for _ in 0..(t.repair_windup * TICK_HZ) as u32 - 2 {
        tick(&mut game, false, repair);
    }
    assert_eq!(game.snapshot(victim).me.health, me.health, "healed during the wind-up");
    assert!(player(&game, victim).view.repairing, "didn't start over");
}

#[test]
fn hostile_inputs_are_sanitized() {
    let t = unshielded();
    let mut game = Game::new(t.clone(), blockout());
    game.bots = false;
    let id = game.join().unwrap();
    let start = game.snapshot(id).me.pos;
    let ticks = 60u32;
    for seq in 1..=ticks {
        let input = if seq % 2 == 0 {
            Input { move_x: f32::NAN, move_z: f32::INFINITY, yaw: f32::NAN, pitch: f32::NEG_INFINITY, dodge: i8::MIN, ..Input::default() }
        } else {
            Input { move_z: 1e9, boost: true, ..Input::default() }
        };
        game.push_input(id, InputMsg { seq, input, view_tick: f32::NAN });
        game.step();
    }
    let me = game.snapshot(id).me;
    assert!(me.pos.is_finite() && me.vel.is_finite() && me.yaw.is_finite() && me.pitch.is_finite(), "non-finite state: {me:?}");
    let max = t.boost_speed * ticks as f32 / TICK_HZ * 1.1;
    assert!((me.pos - start).length() <= max, "moved {} m, more than boost allows", (me.pos - start).length());
}

fn xz_gap(a: Vector, b: Vector) -> f32 {
    Vector::new(a.x - b.x, 0.0, a.z - b.z).length()
}

#[test]
fn head_on_mechs_block() {
    let (mut game, north, south) = duel_game();
    let touching = 2.0 * unshielded().mech_radius;
    // Round capsules pushing head-on eventually slip past each other on any tiny offset; they
    // must never overlap, and must hold each other up for at least half a second first.
    let (mut north_seq, mut south_seq, mut met) = (0, 0, None);
    for tick in 0..(6.0 * TICK_HZ) as u32 {
        send(&mut game, north, &mut north_seq, 1, Input { move_z: 1.0, ..Input::default() });
        send(&mut game, south, &mut south_seq, 1, Input { move_z: 1.0, yaw: std::f32::consts::PI, ..Input::default() });
        game.step();
        let (n, s) = (player(&game, north).view.pos, player(&game, south).view.pos);
        assert!(xz_gap(n, s) >= touching - 0.01, "mechs overlap: gap {}", xz_gap(n, s));
        if xz_gap(n, s) < touching + 0.1 {
            met.get_or_insert(tick);
        }
        if met.is_some_and(|at| tick < at + TICK_HZ as u32 / 2) {
            assert!(n.z > s.z, "mechs passed each other within half a second of meeting");
        }
    }
    assert!(met.is_some(), "the mechs never met, so the test proved nothing");
}

#[test]
fn prediction_through_contact() {
    let mut h = Harness::new();
    let touching = 2.0 * unshielded().mech_radius;
    let toward = |yaw| Input { move_z: 1.0, yaw, ..Input::default() };
    let away = |yaw| Input { move_z: -1.0, yaw, ..Input::default() };
    let pi = std::f32::consts::PI;
    let (mut contact_correction, mut last_contact, mut first_contact) = (0f32, 0, None);
    for tick in 0..(10.0 * TICK_HZ) as u32 {
        // Walk into each other for 6 s, then back off.
        let inputs = if tick < 180 { [toward(0.0), toward(pi)] } else { [away(0.0), away(pi)] };
        h.step(inputs);
        let s = h.game.snapshot(0);
        let gap = xz_gap(s.players[0].view.pos, s.players[1].view.pos);
        let correction = h.clients.iter().map(|c| c.1.correction).fold(0.0, f32::max);
        if gap < touching + 0.5 {
            first_contact.get_or_insert(tick);
            last_contact = tick;
            contact_correction = contact_correction.max(correction);
        } else if first_contact.is_none() {
            assert!(correction < 1e-5, "correction {correction} before any contact");
        }
        if first_contact.is_some() && tick > last_contact + 15 {
            for (_, c) in &h.clients {
                assert!(c.render_offset.length() < 0.01, "render offset {} 0.5 s after contact", c.render_offset.length());
            }
        }
    }
    assert!(first_contact.is_some(), "the mechs never met");
    assert!(contact_correction < 0.5, "correction {contact_correction} m during contact");
}

/// Yaw and pitch from `id`'s eye to `at`, as the server has them now.
fn look(game: &Game, id: u8, at: Vector) -> Input {
    let p = player(game, id);
    let d = at - (p.view.pos + Vector::Y * class_tunings()[p.class.index()].eye_height);
    Input { yaw: (-d.x).atan2(-d.z), pitch: d.y.atan2(d.x.hypot(d.z)), ..Input::default() }
}

/// `shooter` waits out its cooldown, launches one volley with `aim`, and holds still until it
/// bursts. Returns the Blast.
fn launch(game: &mut Game, shooter: u8, seq: &mut u32, aim: Input) -> (Vector, u16) {
    for _ in 0..(10.0 * TICK_HZ) as u32 {
        let ready = game.snapshot(shooter).me.alt_wait <= 0.0;
        send(game, shooter, seq, 1, Input { alt_fire: ready, ..aim });
        game.step();
        if ready {
            break;
        }
    }
    for _ in 0..(10.0 * TICK_HZ) as u32 {
        for e in game.snapshot(shooter).events {
            if let Event::Blast { owner, pos, hits, .. } = e
                && owner == shooter
            {
                return (pos, hits);
            }
        }
        send(game, shooter, seq, 1, aim);
        game.step();
    }
    panic!("no blast in 10 s");
}

#[test]
fn rockets_splash_enemies_only() {
    let t = unshielded();
    let mut game = Game::new(t.clone(), blockout());
    game.bots = false;
    let shooter = game.join().unwrap();
    game.pick(shooter, MechClass::B, base_weapons());
    let enemy = game.join().unwrap();
    let mate = game.join().unwrap();
    assert_eq!(team_of(&game, shooter), team_of(&game, mate));
    game.step();
    let mut seq = 0;
    let health = |game: &Game, id| game.snapshot(id).me.health;

    // The floor 2 m beside the teammate, then the shooter's own feet: nobody on the team is hurt.
    let beside = player(&game, mate).view.pos + Vector::new(t.mech_radius + 2.0, 0.0, 0.0);
    let aim = look(&game, shooter, beside);
    let (at, hits) = launch(&mut game, shooter, &mut seq, aim);
    assert!(at.distance(beside) < 1.0, "burst at {at}, not beside the teammate");
    let feet = player(&game, shooter).view.pos + Vector::new(0.0, 0.0, -1.5);
    let aim = look(&game, shooter, feet);
    let (_, own) = launch(&mut game, shooter, &mut seq, aim);
    assert_eq!((hits, own), (0, 0));
    assert_eq!((health(&game, mate), health(&game, shooter)), (t.health_max, t.health_max));

    // Straight at the enemy: near-full damage, and rockets alone finish it.
    let chest = |game: &Game| player(game, enemy).view.pos + Vector::Y * (t.mech_height * 0.5);
    let aim = look(&game, shooter, chest(&game));
    let (_, hits) = launch(&mut game, shooter, &mut seq, aim);
    assert_eq!(hits, 1 << enemy);
    let dealt = t.health_max - health(&game, enemy);
    assert!(dealt > 0.9 * t.alt_damage && dealt <= t.alt_damage, "a direct rocket did {dealt}");
    let needed = (t.health_max / dealt).ceil() as u32;
    for _ in 1..needed {
        let aim = look(&game, shooter, chest(&game));
        launch(&mut game, shooter, &mut seq, aim);
    }
    assert_eq!(health(&game, enemy), 0.0);
    assert_eq!(player(&game, shooter).kills, 1);
}

#[test]
fn predicted_blast_matches_server() {
    let mut h = Harness::new();
    let (id, watcher) = (h.clients[0].0, 1);
    let aim = Input { pitch: -0.3, ..Input::default() }; // the floor ahead; the enemy is far beyond
    let (mut server, mut local, mut seen) = (Vec::new(), Vec::new(), Vec::new());
    for tick in 0..(4.0 * TICK_HZ) as u32 {
        h.step([Input { alt_fire: tick == 5, ..aim }, Input::default()]);
        server.extend(h.game.snapshot(id).events.iter().filter_map(|e| match *e {
            Event::Blast { pos, .. } => Some(pos),
            _ => None,
        }));
        local.extend(h.clients[0].1.blasts.drain(..).map(|b| b.2));
        let now = h.now();
        h.clients[watcher].1.projectiles(now);
        seen.extend(h.clients[watcher].1.blasts.drain(..).map(|b| b.2));
    }
    assert_eq!(server.len(), 1, "server blasts: {server:?}");
    assert_eq!(local, server, "the predicted burst should land exactly where the server's did");
    assert_eq!(seen, server, "the other client's replay should burst there too");
    assert!(h.clients[0].1.projectiles.is_empty());
}

#[test]
fn predicted_airburst_matches_server() {
    let t = unshielded();
    let mut h = Harness::new();
    let (id, watcher) = (h.clients[0].0, 1);
    let (mut server, mut local, mut seen) = (Vec::new(), Vec::new(), Vec::new());
    let mut max_correction = 0f32;
    // A level rocket at the far enemy, burst by a second press 12 ticks later, well short of it.
    for tick in 0..(2.0 * TICK_HZ) as u32 {
        h.step([Input { alt_fire: tick == 5 || tick == 17, ..Input::default() }, Input::default()]);
        server.extend(h.game.snapshot(id).events.iter().filter_map(|e| match *e {
            Event::Blast { pos, .. } => Some(pos),
            _ => None,
        }));
        local.extend(h.clients[0].1.blasts.drain(..).map(|b| b.2));
        let now = h.now();
        h.clients[watcher].1.projectiles(now);
        seen.extend(h.clients[watcher].1.blasts.drain(..).map(|b| b.2));
        max_correction = max_correction.max(h.clients[0].1.correction);
    }
    assert_eq!(server.len(), 1, "server blasts: {server:?}");
    assert_eq!(local, server, "the predicted burst should land exactly where the server's did");
    assert_eq!(seen, server, "the other client's replay should burst there too");
    let eye = h.clients[0].1.mech.pos + Vector::Y * t.eye_height;
    let flown = server[0].distance(eye);
    assert!((flown - 13.0 * t.alt_speed * DT).abs() < 0.5, "burst {flown} m out, not 13 ticks of flight");
    assert!(max_correction < 1e-5, "the burst threw prediction off by {max_correction} m");
}

#[test]
fn bots_use_secondaries() {
    let mut game = Game::new(unshielded(), blockout());
    let human = game.join().unwrap();
    let mut launched = [false; 3];
    for _ in 0..(30.0 * TICK_HZ) as u32 {
        game.step();
        for e in game.snapshot(human).events {
            if let Event::Launch(p) = e {
                launched[p.class.index()] = true;
            }
        }
    }
    let present: Vec<MechClass> = game.snapshot(human).players.iter().filter(|p| p.bot).map(|p| p.class).collect();
    for class in MechClass::ALL.into_iter().filter(|c| present.contains(c)) {
        assert!(launched[class.index()], "{class:?} bots never fired their secondary");
    }
    assert!(present.iter().any(|c| *c != present[0]), "all bots were {:?}, so the test proved little", present[0]);
}

/// Primary `id`'s index in weapons.json.
fn primary(id: &str) -> u8 {
    (0..).find(|&i| sim::arsenal::weapon(Slot::Primary, i).expect("no such primary").0 == id).unwrap()
}

/// The weapons tuning.json describes: the rifle and the rocket.
fn base_weapons() -> Loadout {
    let rocket = (0..).find(|&i| sim::arsenal::weapon(Slot::Secondary, i).expect("no rocket").0 == "rocket").unwrap();
    Loadout { primary: primary("pike"), secondary: rocket, ..Loadout::default() }
}

#[test]
fn spread_matches_server() {
    // A sprays, and C taps its HEAT gun (the projectile primary) at the floor ahead; the enemy is
    // far beyond either.
    let mut h = Harness::with_classes([MechClass::A, MechClass::C]);
    let (wisp, bulwark) = (h.clients[0].0, h.clients[1].0);
    h.game.pick(bulwark, MechClass::C, Loadout { primary: primary("kiln"), ..Loadout::of(MechClass::C) });
    let aim = Input { pitch: -0.35, ..Input::default() };
    let (mut server_shots, mut local_shots, mut server_slugs, mut local_slugs, mut seen_slugs) = (vec![], vec![], vec![], vec![], vec![]);
    let (mut max_bloom, mut max_correction) = (0f32, 0f32);
    for tick in 0..(3.0 * TICK_HZ) as u32 {
        let fire = (5..65).contains(&tick);
        let tap = (5..75).contains(&tick) && tick % 16 < 2;
        h.step([Input { fire, ..aim }, Input { fire: tap, ..aim }]);
        for e in h.game.snapshot(wisp).events {
            match e {
                Event::Shot { shooter, end, .. } if shooter == wisp => server_shots.push(end),
                Event::Blast { owner, primary: true, pos, .. } if owner == bulwark => server_slugs.push(pos),
                _ => {}
            }
        }
        local_shots.append(&mut h.clients[0].1.shots);
        local_slugs.extend(h.clients[1].1.blasts.drain(..).map(|b| b.2));
        let now = h.now();
        h.clients[0].1.projectiles(now);
        seen_slugs.extend(h.clients[0].1.blasts.drain(..).filter(|b| b.0 == bulwark).map(|b| b.2));
        max_bloom = max_bloom.max(h.clients[0].1.mech.bloom);
        max_correction = h.clients.iter().map(|c| c.1.correction).fold(max_correction, f32::max);
    }
    assert!(server_shots.len() > 20 && local_shots == server_shots, "predicted tracers differ from the server's shots");
    assert!(max_bloom > 2.0, "bloom only reached {max_bloom} deg");
    let spread = server_shots.iter().map(|p| p.distance(server_shots[0])).fold(0.0, f32::max);
    assert!(spread > 0.3, "shots all landed within {spread} m, so the spread did nothing");
    assert!(server_slugs.len() >= 3, "only {} slugs burst", server_slugs.len());
    assert_eq!(local_slugs, server_slugs, "predicted slugs burst somewhere else");
    assert_eq!(seen_slugs, server_slugs, "the other client's slug replay burst somewhere else");
    assert!(max_correction < 1e-5, "prediction drifted by {max_correction} m");
}

#[test]
fn falloff_scales_hit_damage() {
    // One exact shot across the 80 m between the slot-0 spawns, with falloff ranges that make
    // that distance near, mid and far.
    let t = unshielded();
    let mut dealt = vec![];
    for (start, end) in [(200.0, 300.0), (40.0, 120.0), (10.0, 20.0)] {
        let (mut game, shooter, victim) = duel_game_with(Tuning { falloff_start: start, falloff_end: end, ..laser() });
        game.step();
        let eye = player(&game, shooter).view.pos + Vector::Y * t.eye_height;
        let aim = aim_at(&game, shooter, victim, true);
        send(&mut game, shooter, &mut 0, 1, aim);
        game.step();
        let Some(Event::Shot { end: hit_at, hit: Some(_), .. }) = game.snapshot(shooter).events.into_iter().find(|e| matches!(e, Event::Shot { .. })) else {
            panic!("the shot missed");
        };
        dealt.push((t.health_max - game.snapshot(victim).me.health, hit_at.distance(eye)));
    }
    let [(near, _), (mid, dist), (far, _)] = dealt[..] else { unreachable!() };
    assert_eq!(near, t.shot_damage);
    let want = t.shot_damage * (1.0 - (1.0 - t.falloff_floor) * (dist - 40.0) / 80.0);
    assert!((mid - want).abs() < 1e-3 && mid < near, "mid-range hit did {mid}, want {want}");
    assert!((far - t.shot_damage * t.falloff_floor).abs() < 1e-4, "far hit did {far}");
}

#[test]
fn shotgun_hits() {
    let classes = class_tunings();
    let flak = &classes[MechClass::C.index()];
    let (mut game, shooter, victim) = duel_game_with(unshielded());
    game.pick_class(shooter, MechClass::C);
    game.step();
    // The victim walks up to about 12 m, inside the falloff, and stops.
    let (mut shooter_seq, mut victim_seq) = (0, 0);
    while player(&game, victim).view.pos.distance(player(&game, shooter).view.pos) > 12.0 {
        send(&mut game, victim, &mut victim_seq, 1, Input { move_z: 1.0, yaw: std::f32::consts::PI, ..Input::default() });
        game.step();
    }
    for _ in 0..10 {
        send(&mut game, victim, &mut victim_seq, 1, Input { yaw: std::f32::consts::PI, ..Input::default() });
        game.step();
    }
    let before = game.snapshot(victim).me.health;
    let (mut pellets, mut hit) = (0, 0);
    for tick in 0..TICK_HZ as u32 {
        let aim = aim_at(&game, shooter, victim, tick == 0);
        send(&mut game, shooter, &mut shooter_seq, 1, aim);
        send(&mut game, victim, &mut victim_seq, 1, Input { yaw: std::f32::consts::PI, ..Input::default() });
        game.step();
        for e in game.snapshot(shooter).events {
            if let Event::Shot { shooter: from, hit: to, .. } = e
                && from == shooter
            {
                pellets += 1;
                hit += u32::from(to == Some(victim));
            }
        }
    }
    let dealt = before - game.snapshot(victim).me.health;
    assert!(flak.pellets > 1.0 && pellets == flak.pellets as u32, "{pellets} pellets");
    assert!(hit >= pellets - 1, "{hit} of {pellets} pellets hit at 12 m");
    let full = flak.pellets * flak.shot_damage;
    assert!(dealt > 0.85 * full && dealt <= full + 1e-3, "a flak shot did {dealt} of {full}");
}

#[test]
fn predicted_grenade_matches_server() {
    use sim::projectile::GRENADE;
    let t = unshielded();
    let mut h = Harness::new();
    let (id, watcher) = (h.clients[0].0, 1);
    // A grenade, a rocket and an EMP on one input, aimed at the floor ahead; the enemy is far beyond.
    let aim = Input { pitch: -0.3, ..Input::default() };
    let (mut launched, mut server, mut local, mut seen, mut pulses) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut max_correction = 0f32;
    for tick in 0..(4.0 * TICK_HZ) as u32 {
        let press = tick == 5;
        h.step([Input { grenade: press, alt_fire: press, emp: press, ..aim }, Input::default()]);
        for e in h.game.snapshot(id).events {
            match e {
                Event::Launch(p) => launched.push(p.n),
                Event::Blast { n, pos, .. } => server.push((if n == GRENADE { t.grenade_radius } else { t.alt_radius }, pos)),
                Event::Pulse { owner, hits, .. } => pulses.push((owner, hits)),
                _ => {}
            }
        }
        local.extend(h.clients[0].1.blasts.drain(..).map(|b| (b.1, b.2)));
        let now = h.now();
        h.clients[watcher].1.projectiles(now);
        seen.extend(h.clients[watcher].1.blasts.drain(..).map(|b| (b.1, b.2)));
        max_correction = max_correction.max(h.clients[0].1.correction);
    }
    assert_eq!(launched, [0, GRENADE], "a rocket and a grenade with distinct ids");
    assert_eq!(server.len(), 2, "server blasts: {server:?}");
    assert_eq!(local, server, "predicted bursts should land exactly where the server's did");
    assert_eq!(seen, server, "the other client's replays should burst there too");
    assert!(h.clients[0].1.projectiles.is_empty());
    assert_eq!(pulses, [(id, 0)], "the EMP reached no one");
    assert!(max_correction < 1e-5, "items threw prediction off by {max_correction} m");
    assert_eq!((h.clients[0].1.mech.grenades, h.clients[0].1.mech.emps), (t.grenade_charges as u8 - 1, t.emp_charges as u8 - 1));
}

#[test]
fn predicted_limpet_matches_server() {
    use sim::projectile::LIMPET;
    let mut h = Harness::new();
    let (id, watcher) = (h.clients[0].0, 1);
    let limpet = (0..).find(|&i| sim::arsenal::weapon(Slot::Offensive, i).expect("no limpet").0 == "limpet").unwrap();
    h.game.pick(id, MechClass::B, Loadout { offensive: limpet, ..base_weapons() });
    // Thrown at the floor ahead, then set off once it has stuck; the enemy is far beyond.
    let aim = Input { pitch: -0.3, ..Input::default() };
    let (mut server, mut local, mut seen) = (Vec::new(), Vec::new(), Vec::new());
    let mut max_correction = 0f32;
    for tick in 0..(4.0 * TICK_HZ) as u32 {
        h.step([Input { grenade: tick == 5 || tick == 60, ..aim }, Input::default()]);
        for e in h.game.snapshot(id).events {
            if let Event::Blast { n: LIMPET, pos, .. } = e {
                server.push(pos);
            }
        }
        local.extend(h.clients[0].1.blasts.drain(..).map(|b| b.2));
        let now = h.now();
        h.clients[watcher].1.projectiles(now);
        seen.extend(h.clients[watcher].1.blasts.drain(..).map(|b| b.2));
        max_correction = max_correction.max(h.clients[0].1.correction);
    }
    assert_eq!(server.len(), 1, "server blasts: {server:?}");
    assert_eq!(local, server, "the predicted burst should land where the server's did");
    assert_eq!(seen, server, "the other client's replay should burst there too");
    assert!(!h.clients[0].1.mech.limpet && h.clients[0].1.projectiles.is_empty());
    assert!(max_correction < 1e-5, "the limpet threw prediction off by {max_correction} m");
}

#[test]
fn barriers_predict_as_the_server_has_them() {
    use sim::deploy::Kind;
    let t = unshielded();
    let mut h = Harness::new();
    let (a, watcher) = (h.clients[0].0, 1);
    let barrier = (0..).find(|&i| sim::arsenal::weapon(Slot::Support, i).expect("no barrier").0 == "barrier").unwrap();
    h.game.pick(a, MechClass::B, Loadout { support: barrier, ..base_weapons() });
    // A raises a barrier ahead, then walks into it for a few seconds.
    let mut max_correction = 0f32;
    for tick in 0..(4.0 * TICK_HZ) as u32 {
        let input = if tick == 5 { Input { emp: true, ..Input::default() } } else { Input { move_z: if tick > 5 { 1.0 } else { 0.0 }, ..Input::default() } };
        h.step([input, Input::default()]);
        max_correction = max_correction.max(h.clients[0].1.correction);
    }
    let wall = h.game.snapshot(a).deployables.iter().find(|d| d.kind == Kind::Barrier).copied().expect("no barrier");
    let (me, r) = (h.clients[0].1.mech, t.for_class(MechClass::B).mech_radius);
    assert!(me.pos.z > wall.pos.z + t.barrier_thickness * 0.5 + r - 0.1, "walked into the barrier, to z {}", me.pos.z);
    assert!(max_correction < 1e-4, "prediction was off by {max_correction} m");
    // The other client has the wall too.
    let ray = rapier3d::prelude::Ray::new(Vector::new(0.0, 2.0, wall.pos.z + 10.0), Vector::NEG_Z);
    let hit = h.clients[watcher].1.arena().cast_ray(&ray, 20.0).expect("no wall");
    assert!((hit - (10.0 - t.barrier_thickness * 0.5)).abs() < 0.05, "the wall's {hit} m off");
}

#[test]
fn owners_see_their_turrets_rockets() {
    use sim::projectile::TURRET;
    let mut h = Harness::new();
    let (a, b) = (h.clients[0].0, h.clients[1].0);
    let turret = (0..).find(|&i| sim::arsenal::weapon(Slot::Offensive, i).expect("no rocket turret").0 == "rocket_turret").unwrap();
    h.game.pick(a, MechClass::B, Loadout { offensive: turret, ..base_weapons() });
    // Walk at each other until 45 m apart, then A sets the turret down and both stand.
    let (mut placed, mut seen, mut burst) = (false, false, false);
    for _ in 0..(10.0 * TICK_HZ) as u32 {
        let s = h.game.snapshot(a);
        let gap = xz_gap(s.players[0].view.pos, s.players[1].view.pos);
        let walk = !placed && gap > 45.0;
        let ia = Input { move_z: if walk { 1.0 } else { 0.0 }, grenade: !walk && !placed, ..Input::default() };
        placed |= ia.grenade;
        h.step([ia, Input { move_z: if walk { 1.0 } else { 0.0 }, yaw: std::f32::consts::PI, ..Input::default() }]);
        let now = h.now();
        let own = &mut h.clients[0].1;
        seen |= own.projectiles(now).iter().any(|d| d.p.n == TURRET && d.p.owner == a && !d.predicted);
        burst |= !own.blasts.is_empty();
        own.blasts.clear();
        if seen && burst {
            break;
        }
    }
    assert!(placed && seen, "A never saw its turret's rockets");
    assert!(burst, "nor one burst");
    assert!(h.game.snapshot(b).me.health < unshielded().health_max, "no rocket hit B");
}

#[test]
fn emp_jams_the_other_client() {
    let t = unshielded();
    let mut h = Harness::new();
    let (a, b) = (h.clients[0].0, h.clients[1].0);
    let pi = std::f32::consts::PI;
    // Walk at each other until 10 m apart; then A pulses once while B tries to boost sideways.
    let (mut pulsed, mut hits, mut jammed_ticks, mut boosted_after) = (None, None, 0, false);
    for tick in 0..(10.0 * TICK_HZ) as u32 {
        let s = h.game.snapshot(a);
        let gap = xz_gap(s.players[0].view.pos, s.players[1].view.pos);
        let close = pulsed.is_some() || gap < 10.0;
        let press = close && pulsed.is_none();
        if press {
            pulsed = Some(tick);
        }
        let ia = if close { Input { emp: press, ..Input::default() } } else { Input { move_z: 1.0, ..Input::default() } };
        let ib = if close { Input { move_z: 1.0, boost: true, yaw: pi, ..Input::default() } } else { Input { move_z: 1.0, yaw: pi, ..Input::default() } };
        h.step([ia, ib]);
        for e in std::mem::take(&mut h.clients[0].1.events) {
            if let Event::Pulse { owner, hits: bits, .. } = e
                && owner == a
            {
                hits = Some(bits);
            }
        }
        let victim = &h.clients[1].1.mech;
        if victim.jammed > 0.0 {
            jammed_ticks += 1;
            assert!(!victim.boosting, "B's prediction boosted while jammed");
        } else if jammed_ticks > 0 {
            boosted_after |= victim.boosting;
        }
    }
    assert!(pulsed.is_some(), "A and B never got within 10 m");
    assert_eq!(hits, Some(1 << b), "A's client should see its EMP jam B");
    // B learns of the jam about a round trip after the server applied it, then it wears off in step.
    let full = (t.emp_jam * TICK_HZ).round() as u32;
    assert!((full - 2 * LATENCY_TICKS - 2..=full).contains(&jammed_ticks), "B's client was jammed for {jammed_ticks} ticks");
    assert!(boosted_after, "B never boosted again after the jam");
}

#[test]
fn names_are_sanitized() {
    use sim::game::{NAME_MAX, sanitize_name};
    assert_eq!(sanitize_name("  <b>Ana</b>\u{7}  "), "bAnab");
    assert_eq!(sanitize_name("Grey  🙂  Wolf"), "Grey Wolf");
    assert_eq!(sanitize_name("abcdefghijklmnopqrstuvwxyz").len(), NAME_MAX);
    assert_eq!(sanitize_name("abcdefghijklmno pq"), "abcdefghijklmno", "a cut at a space is trimmed");
    assert_eq!(sanitize_name("\u{202e}\u{200b}"), "");

    let (mut game, a, _) = duel_game();
    let name = |game: &Game| game.roster().into_iter().find(|p| p.0 == a).unwrap().1;
    assert_eq!(name(&game), format!("Pilot-{a:02}"));
    game.set_name(a, "Kite");
    assert_eq!(name(&game), "Kite");
    game.set_name(a, "Kite Two");
    assert_eq!(name(&game), "Kite", "renamed again within 2 s");
    for _ in 0..(2.0 * TICK_HZ) as u32 {
        game.step();
    }
    game.set_name(a, "🙂");
    assert_eq!(name(&game), format!("Pilot-{a:02}"), "an empty name falls back to the default");
}

#[test]
fn roster_reaches_clients() {
    let mut game = Game::new(unshielded(), blockout());
    let a = game.join().unwrap();
    let b = game.join().unwrap();
    game.step(); // bots fill the rest
    let mut clients: Vec<NetClient> = [a, b].iter().map(|_| NetClient::default()).collect();
    let mut seen = game.roster_version();
    let deliver = |game: &Game, clients: &mut Vec<NetClient>| {
        let bytes = net::encode(&ServerMsg::Roster(game.roster()));
        for c in clients.iter_mut() {
            c.receive(&bytes, 0.0);
        }
    };
    deliver(&game, &mut clients);
    assert_eq!(clients[1].names[&b], format!("Pilot-{b:02}"));
    let bots: Vec<_> = game.snapshot(a).players.iter().filter(|p| p.bot).map(|p| clients[0].names[&p.id].clone()).collect();
    assert_eq!(bots.len(), 6);
    assert!(bots.iter().all(|n| !n.starts_with("Pilot")), "bots should have callsigns: {bots:?}");

    // A names itself through the protocol; the roster version moves and B learns it.
    let Some(ClientMsg::Name(raw)) = net::decode(&clients[0].name_msg("  Kite!! ")) else { panic!("not a Name message") };
    game.set_name(a, &raw);
    assert_ne!(game.roster_version(), seen);
    seen = game.roster_version();
    deliver(&game, &mut clients);
    assert_eq!(clients[1].names[&a], "Kite");

    // A leaves: gone from B's roster.
    game.leave(a);
    assert_ne!(game.roster_version(), seen);
    deliver(&game, &mut clients);
    assert!(!clients[1].names.contains_key(&a));
}
