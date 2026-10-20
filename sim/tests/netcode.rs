//! Netcode checks without sockets: one Game and two NetClients joined by in-memory links
//! with a fixed latency each way.

use std::collections::VecDeque;
use std::ops::Range;

use sim::client::NetClient;
use sim::game::Game;
use sim::net::{self, ClientMsg, Event, ServerMsg};
use sim::{DT, Input, Tuning, Vector};

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
        let mut game = Game::new(Tuning::default());
        let clients = (0..2)
            .map(|_| {
                let id = game.join().expect("room for two");
                let mut c = NetClient::default();
                c.receive(&net::encode(&ServerMsg::Welcome { id }), 0.0);
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
            let mut msg: ClientMsg = net::decode(&bytes).unwrap();
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
    let mut h = Harness::new();
    let mut last: Vec<Vector> = h.clients.iter().map(|c| c.1.mech.pos).collect();
    let mut travelled = [0f32; 2];
    let mut max_correction = 0f32;
    for tick in 0..300u32 {
        let i = Input::default();
        // A walks with a slow turn, boosts, dodges, hovers and fires; B strafes, dodges and hovers.
        let a = match tick {
            0..60 => Input { move_z: 1.0, yaw: tick as f32 * 0.01, ..i },
            60..90 => Input { move_z: 1.0, boost: true, yaw: 0.6, ..i },
            90 => Input { dodge: 1, yaw: 0.6, ..i },
            91..130 => Input { hover: true, move_x: -1.0, yaw: 0.6, ..i },
            _ => Input { fire: tick < 160, pitch: -0.2, yaw: 0.6, ..i },
        };
        let b = Input {
            move_x: if (tick / 20) % 2 == 0 { 1.0 } else { -1.0 },
            dodge: if tick == 100 { -1 } else { 0 },
            hover: (150..180).contains(&tick),
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
            let d = b.mech.pos + Vector::Y * (t.mech_height * 0.5) - eye;
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
