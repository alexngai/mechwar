//! Authoritative match: applies each client's inputs through `step_mech`, resolves hits with
//! lag compensation, and builds snapshots. Pure logic; `server/` owns the sockets.

use std::collections::VecDeque;

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::Pose;

use crate::net::{ClientMsg, Event, PlayerNet, Snapshot};
use crate::{Arena, Mech, TICK_HZ, Tuning, Vector, aim_ray, mech_capsule, spawn_mech, step_mech};

pub const MAX_PLAYERS: usize = 2;
const SPAWNS: [Vector; MAX_PLAYERS] = [Vector::new(0.0, 0.1, 40.0), Vector::new(0.0, 0.1, -40.0)];
/// Inputs queued beyond this drop oldest first.
const MAX_QUEUED: usize = 8;
/// Input credit earned per tick. 2% over real time lets a client with a slightly fast clock drain
/// its backlog, and caps what sending inputs too fast can gain at +2% speed.
const CREDIT_PER_TICK: f32 = 1.02;
/// Credit banked while no inputs arrive (about the client's 0.25 s catch-up cap), so the burst
/// after a hitch is applied at once instead of lingering as extra latency.
const MAX_CREDIT: f32 = 8.0;
/// Furthest back a shot may rewind its targets.
const MAX_REWIND_TICKS: f32 = 0.3 * TICK_HZ;
const HISTORY_TICKS: usize = TICK_HZ as usize;

struct Player {
    id: u8,
    mech: Mech,
    inputs: VecDeque<ClientMsg>,
    /// Inputs this player may still apply; see CREDIT_PER_TICK.
    credit: f32,
    ack_seq: u32,
    /// (tick, feet position, alive) at the end of recent ticks, for rewinding.
    history: VecDeque<(u32, Vector, bool)>,
    kills: u16,
    deaths: u16,
    respawn_at: Option<u32>,
}

pub struct Game {
    pub tuning: Tuning,
    pub tick: u32,
    arena: Arena,
    players: Vec<Player>,
    /// This tick's events; cleared at the start of each step.
    events: Vec<Event>,
}

impl Game {
    pub fn new(tuning: Tuning) -> Self {
        Self { tuning, tick: 0, arena: Arena::default(), players: Vec::new(), events: Vec::new() }
    }

    /// Adds a player at a free spawn, or None when the match is full.
    pub fn join(&mut self) -> Option<u8> {
        let id = (0..MAX_PLAYERS as u8).find(|id| !self.players.iter().any(|p| p.id == *id))?;
        self.players.push(Player {
            id,
            mech: spawn_mech(&self.tuning, SPAWNS[usize::from(id)]),
            inputs: VecDeque::new(),
            credit: 0.0,
            ack_seq: 0,
            history: VecDeque::new(),
            kills: 0,
            deaths: 0,
            respawn_at: None,
        });
        Some(id)
    }

    pub fn leave(&mut self, id: u8) {
        self.players.retain(|p| p.id != id);
    }

    pub fn push_input(&mut self, id: u8, msg: ClientMsg) {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            p.inputs.push_back(msg);
            if p.inputs.len() > MAX_QUEUED {
                p.inputs.pop_front();
            }
        }
    }

    pub fn step(&mut self) {
        self.tick += 1;
        self.events.clear();

        for p in &mut self.players {
            if p.respawn_at.is_some_and(|at| self.tick >= at) {
                p.mech = spawn_mech(&self.tuning, SPAWNS[usize::from(p.id)]);
                p.respawn_at = None;
            }
        }

        // Inputs are applied exactly as the client predicted them, never guessed or repeated,
        // so reconciliation corrections stay at zero over a reliable transport.
        // ponytail: no jitter buffer, so while a client's send phase sits on the tick boundary
        // remote viewers can see 0- and 2-step ticks; add an adaptive buffer (or client time
        // dilation) if that shows in play.
        for i in 0..self.players.len() {
            let p = &mut self.players[i];
            p.credit = (p.credit + CREDIT_PER_TICK).min(MAX_CREDIT);
            while self.players[i].credit >= 1.0 {
                let Some(msg) = self.players[i].inputs.pop_front() else { break };
                let p = &mut self.players[i];
                p.credit -= 1.0;
                p.ack_seq = msg.seq;
                step_mech(&self.arena, &self.tuning, &mut p.mech, &msg.input);
                if p.mech.shot {
                    self.resolve_shot(i, msg.view_tick);
                }
            }
        }

        for p in &mut self.players {
            p.history.push_back((self.tick, p.mech.pos, p.mech.health > 0.0));
            if p.history.len() > HISTORY_TICKS {
                p.history.pop_front();
            }
        }
    }

    /// Hitscan from the shooter's eye against targets rewound to where the shooter saw them.
    fn resolve_shot(&mut self, shooter: usize, view_tick: f32) {
        let t = &self.tuning;
        let m = &self.players[shooter].mech;
        let ray = aim_ray(t, m);
        // step_mech already cast this ray against the arena; aim_point is where it stopped.
        let mut best = (m.aim_point - ray.origin).length();
        let mut hit = None;
        let view = view_tick.clamp(self.tick as f32 - MAX_REWIND_TICKS, self.tick as f32);
        let capsule = mech_capsule(t);
        for (j, target) in self.players.iter().enumerate() {
            if j == shooter || target.mech.health <= 0.0 {
                continue;
            }
            let Some(pos) = rewind(&target.history, view) else { continue };
            let pose = Pose::from_translation(pos + Vector::Y * (t.mech_height * 0.5));
            if let Some(toi) = capsule.cast_ray(&pose, &ray, best, true) {
                best = toi;
                hit = Some(j);
            }
        }

        let shooter_id = self.players[shooter].id;
        let end = ray.point_at(best);
        self.events.push(Event::Shot { shooter: shooter_id, end, hit: hit.map(|j| self.players[j].id) });
        let Some(j) = hit else { return };

        let damage = self.tuning.shot_damage;
        let respawn_at = self.tick + (self.tuning.respawn_delay * TICK_HZ).round() as u32;
        let target = &mut self.players[j];
        target.mech.health -= damage;
        if target.mech.health <= 0.0 {
            target.mech.health = 0.0;
            target.deaths += 1;
            target.respawn_at = Some(respawn_at);
            let victim = target.id;
            self.players[shooter].kills += 1;
            self.events.push(Event::Kill { killer: shooter_id, victim });
        }
    }

    /// State for one recipient: everyone's mechs plus that recipient's input ack.
    pub fn snapshot(&self, id: u8) -> Snapshot {
        Snapshot {
            tick: self.tick,
            ack_seq: self.players.iter().find(|p| p.id == id).map_or(0, |p| p.ack_seq),
            players: self
                .players
                .iter()
                .map(|p| PlayerNet { id: p.id, mech: p.mech, kills: p.kills, deaths: p.deaths })
                .collect(),
            events: self.events.clone(),
        }
    }
}

/// Feet position at fractional tick `at`, interpolated like the client draws it; None if dead then.
fn rewind(history: &VecDeque<(u32, Vector, bool)>, at: f32) -> Option<Vector> {
    let (first, last) = (history.front()?, history.back()?);
    if at >= last.0 as f32 {
        return last.2.then_some(last.1);
    }
    if at <= first.0 as f32 {
        return first.2.then_some(first.1);
    }
    let i = history.iter().position(|h| h.0 as f32 > at)?;
    let (a, b) = (history[i - 1], history[i]);
    let f = (at - a.0 as f32) / (b.0 - a.0) as f32;
    (a.2 && b.2).then(|| a.1.lerp(b.1, f))
}
