//! Netcode checks without sockets: one Game and two NetClients joined by in-memory links
//! with a fixed latency each way.

use std::collections::VecDeque;
use std::ops::Range;

use sim::client::NetClient;
use sim::game::Game;
use sim::net::{self, ClientMsg, Event, InputMsg, ServerMsg};
use sim::{DT, Input, Map, MechClass, TICK_HZ, Tuning, Vector};

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

impl Harness {
    fn new() -> Self {
        Self::with_classes([MechClass::B; 2])
    }

    /// Classes are picked before any input, so both spawn in them.
    fn with_classes(classes: [MechClass; 2]) -> Self {
        let mut game = Game::new(Tuning::default(), blockout());
        game.bots = false;
        let clients = classes
            .into_iter()
            .map(|class| {
                let id = game.join().expect("room for two");
                game.pick_class(id, class);
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

/// A stands still and fires at where it *sees* B during `fire`, while B strafes with `strafe(tick)`.
/// Returns (hits before B's first death, shots before it, whether B died) and the harness.
fn duel(no_rewind: bool, ticks: u32, fire: Range<u32>, strafe: impl Fn(u32) -> f32) -> (u32, u32, bool, Harness) {
    let mut h = Harness::new();
    h.no_rewind = no_rewind;
    let t = Tuning::default();
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
    let t = Tuning::default();
    let zigzag = |tick: u32| if (tick / 20) % 2 == 0 { 1.0 } else { -1.0 };
    let (hits, shots, killed, h) = duel(false, 300, 0..300, zigzag);
    assert!(killed, "B never died: {hits}/{shots} hits");
    assert_eq!(hits, shots, "with lag compensation every shot at the drawn target should hit");
    assert_eq!(hits, (t.health_max / t.shot_damage).ceil() as u32);
    assert_eq!(h.clients[0].1.kills, 1);
    assert_eq!(h.clients[1].1.deaths, 1);
    // Killed around tick 70; respawn_delay (3 s) later B is back at full health.
    assert_eq!(h.clients[1].1.mech.health, t.health_max, "B didn't respawn");
}

#[test]
fn rewind_is_what_makes_shots_land() {
    // B runs one way at full walk speed. A sees it ~7 ticks (233 ms) late, which at 9 m/s is
    // 2.1 m: more than the capsule radius, so only rewinding to A's view can hit.
    let run = |_| 1.0;
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
    let t = Tuning::default();
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
    let mut game = Game::new(Tuning::default(), blockout());
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
    let t = Tuning::default();
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
    let t = Tuning::default();
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

    // Post-match: shots fly but nobody dies, then a fresh match starts with everyone healthy.
    let restarted = loop {
        let s = step(&mut game);
        assert!(!s.events.iter().any(|e| matches!(e, Event::Kill { .. })), "kill after the match ended");
        if !s.state.ended {
            break s;
        }
    };
    assert_eq!(restarted.state.scores, [0, 0]);
    let classes = class_tunings();
    assert!(restarted.players.iter().all(|p| p.view.health == classes[p.class.index()].health_max && p.kills == 0 && p.deaths == 0));

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
    let mut game = Game::new(Tuning::default(), blockout());
    let human = game.join().unwrap();
    game.step();
    assert!(game.join().is_some(), "a bot should give up its slot");
    game.step();
    assert_eq!(bots(&game, human), 6);
    assert_eq!(game.snapshot(human).players.len(), 8);
}

fn class_tunings() -> [Tuning; 3] {
    MechClass::ALL.map(|c| Tuning::default().for_class(c))
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
    let mut game = Game::new(Tuning::default(), blockout());
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
fn class_applies_now_then_on_respawn() {
    let classes = class_tunings();
    let (mut game, shooter, victim) = duel_game();

    // Picked before any input: spawn as a Bulwark right away.
    game.pick_class(victim, MechClass::C);
    game.step();
    assert_eq!(player(&game, victim).class, MechClass::C);
    assert_eq!(game.snapshot(victim).me.health, classes[MechClass::C.index()].health_max);

    // Once moving, a new pick waits for the next spawn.
    let mut seq = 0;
    send(&mut game, victim, &mut seq, 1, Input::default());
    game.step();
    game.pick_class(victim, MechClass::A);
    game.step();
    assert_eq!(player(&game, victim).class, MechClass::C);

    shoot_until_kill(&mut game, shooter, victim);
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

    // Brace on the first tick, then a burst inside the 5 s window and another after it.
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
fn hostile_inputs_are_sanitized() {
    let t = Tuning::default();
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
