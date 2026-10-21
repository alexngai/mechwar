//! Authoritative team deathmatch: applies each client's inputs through `step_mech`, resolves
//! hits with lag compensation, fills teams with bots, keeps score and runs the match clock.
//! Pure logic; `server/` owns the sockets.

use std::collections::VecDeque;

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::Pose;

use crate::bot::{self, Bot};
use crate::net::{Event, InputMsg, MatchState, MechView, PlayerNet, Snapshot};
use crate::{Arena, Mech, MechClass, TICK_HZ, Tuning, Vector, aim_ray, mech_capsule, spawn_mech, step_mech};

pub const TEAM_SIZE: usize = 4;
pub const MAX_PLAYERS: usize = 2 * TEAM_SIZE;
/// Spawn x per team slot; team 0 spawns at z = +40, team 1 at z = -40.
const SPAWN_X: [f32; TEAM_SIZE] = [0.0, -15.0, 15.0, -30.0];
const POST_MATCH_SECONDS: f32 = 10.0;
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
    team: u8,
    /// Index into the team's spawn points, used for the first spawn of each match.
    slot: usize,
    class: MechClass,
    /// Class to take at the next spawn.
    next_class: MechClass,
    mech: Mech,
    inputs: VecDeque<InputMsg>,
    /// Inputs this player may still apply; see CREDIT_PER_TICK.
    credit: f32,
    ack_seq: u32,
    /// (tick, feet position, alive) at the end of recent ticks, for rewinding.
    history: VecDeque<(u32, Vector, bool)>,
    kills: u16,
    deaths: u16,
    respawn_at: Option<u32>,
    /// Server-driven player; None for a human.
    bot: Option<Bot>,
}

enum Phase {
    Playing { started_at: u32 },
    /// Shots do no damage until the next match starts at `restart_at`.
    Ended { winner: Option<u8>, restart_at: u32 },
}

pub struct Game {
    /// Tuning per class, indexed by `MechClass::index`.
    classes: [Tuning; 3],
    pub tick: u32,
    /// Fill empty slots with bots while at least one human is connected.
    pub bots: bool,
    /// Team kills that win the match.
    pub score_limit: u16,
    pub match_seconds: f32,
    arena: Arena,
    players: Vec<Player>,
    /// This tick's events; cleared at the start of each step.
    events: Vec<Event>,
    scores: [u16; 2],
    phase: Phase,
}

impl Game {
    pub fn new(tuning: Tuning) -> Self {
        Self {
            classes: MechClass::ALL.map(|c| tuning.for_class(c)),
            tick: 0,
            bots: true,
            score_limit: 25,
            match_seconds: 600.0,
            arena: Arena::default(),
            players: Vec::new(),
            events: Vec::new(),
            scores: [0; 2],
            phase: Phase::Playing { started_at: 0 },
        }
    }

    /// Adds a human to the team with fewer humans, taking a bot's slot there if needed.
    /// None when every slot already holds a human.
    pub fn join(&mut self) -> Option<u8> {
        let humans = |team| self.players.iter().filter(|p| p.team == team && p.bot.is_none()).count();
        let team = if humans(1) < humans(0) { 1 } else { 0 };
        if self.team_count(team) >= TEAM_SIZE {
            let bot = self.players.iter().position(|p| p.team == team && p.bot.is_some())?;
            self.players.remove(bot);
        }
        self.add_player(team, None, MechClass::B)
    }

    /// Class for this player's next spawn; immediate if they haven't moved yet.
    pub fn pick_class(&mut self, id: u8, class: MechClass) {
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
        p.next_class = class;
        if p.ack_seq == 0 && p.mech.health > 0.0 {
            p.class = class;
            p.mech = spawn(&self.classes, class, p.mech.pos);
        }
    }

    fn team_count(&self, team: u8) -> usize {
        self.players.iter().filter(|p| p.team == team).count()
    }

    fn add_player(&mut self, team: u8, bot: Option<Bot>, class: MechClass) -> Option<u8> {
        let id = (0..MAX_PLAYERS as u8).find(|id| !self.players.iter().any(|p| p.id == *id))?;
        let slot = (0..TEAM_SIZE).find(|s| !self.players.iter().any(|p| p.team == team && p.slot == *s))?;
        self.players.push(Player {
            id,
            team,
            slot,
            class,
            next_class: class,
            mech: spawn(&self.classes, class, spawn_point(team, slot)),
            inputs: VecDeque::new(),
            credit: 0.0,
            ack_seq: 0,
            history: VecDeque::new(),
            kills: 0,
            deaths: 0,
            respawn_at: None,
            bot,
        });
        Some(id)
    }

    pub fn leave(&mut self, id: u8) {
        self.players.retain(|p| p.id != id);
    }

    /// Queue a client's input. Clients are untrusted, so the input is sanitized here.
    pub fn push_input(&mut self, id: u8, mut msg: InputMsg) {
        msg.input = msg.input.sanitized();
        if !msg.view_tick.is_finite() {
            msg.view_tick = 0.0;
        }
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

        // Bots top up both teams while any human is here; an empty server keeps no one and
        // holds the match at its start, so the clock runs from the first human's arrival.
        if self.players.iter().any(|p| p.bot.is_none()) {
            for team in 0..2 {
                while self.bots && self.team_count(team) < TEAM_SIZE {
                    let seed = u64::from(self.tick) << 8 | self.players.len() as u64;
                    let class = MechClass::ALL[(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 33) as usize % 3];
                    self.add_player(team, Some(Bot::new(seed)), class);
                }
            }
        } else {
            self.players.clear();
            self.start_match();
        }

        match self.phase {
            Phase::Playing { started_at } if self.tick >= started_at + secs(self.match_seconds) => self.end_match(),
            Phase::Ended { restart_at, .. } if self.tick >= restart_at => self.start_match(),
            _ => {}
        }

        for i in 0..self.players.len() {
            if self.players[i].respawn_at.is_some_and(|at| self.tick >= at) {
                let pos = self.respawn_point(self.players[i].team);
                let p = &mut self.players[i];
                p.class = p.next_class;
                p.mech = spawn(&self.classes, p.class, pos);
                p.respawn_at = None;
            }
        }

        // Bots queue one input per tick, aiming at the nearest visible enemy as of now (else the
        // nearest enemy, to go find).
        for i in 0..self.players.len() {
            let me = &self.players[i];
            if me.bot.is_none() {
                continue;
            }
            let t = &self.classes[me.class.index()];
            let enemies = || self.players.iter().filter(|p| p.team != me.team && p.mech.health > 0.0);
            let dist = |p: &&Player| p.mech.pos.distance(me.mech.pos);
            let target = enemies()
                .filter(|p| bot::sees(&self.arena, t, &me.mech, &p.mech))
                .min_by(|a, b| dist(a).total_cmp(&dist(b)))
                .or_else(|| enemies().min_by(|a, b| dist(a).total_cmp(&dist(b))))
                .map(|p| p.mech);
            let p = &mut self.players[i];
            let bot = p.bot.as_mut().expect("checked above");
            let input = bot.think(&self.arena, t, &p.mech, target.as_ref(), self.tick);
            bot.seq += 1;
            p.inputs.push_back(InputMsg { seq: bot.seq, input, view_tick: self.tick as f32 });
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
                step_mech(&self.arena, &self.classes[p.class.index()], &mut p.mech, &msg.input);
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

    /// Fresh scores, and everyone back at their team spawn with full health.
    fn start_match(&mut self) {
        self.scores = [0; 2];
        self.phase = Phase::Playing { started_at: self.tick };
        for p in &mut self.players {
            p.class = p.next_class;
            p.mech = spawn(&self.classes, p.class, spawn_point(p.team, p.slot));
            p.respawn_at = None;
            p.kills = 0;
            p.deaths = 0;
        }
    }

    fn end_match(&mut self) {
        let [a, b] = self.scores;
        let winner = match a.cmp(&b) {
            std::cmp::Ordering::Greater => Some(0),
            std::cmp::Ordering::Less => Some(1),
            std::cmp::Ordering::Equal => None,
        };
        self.phase = Phase::Ended { winner, restart_at: self.tick + secs(POST_MATCH_SECONDS) };
    }

    /// The team spawn farthest from the nearest living enemy.
    fn respawn_point(&self, team: u8) -> Vector {
        let threat = |spawn: Vector| {
            self.players
                .iter()
                .filter(|p| p.team != team && p.mech.health > 0.0)
                .map(|p| p.mech.pos.distance(spawn))
                .fold(f32::MAX, f32::min)
        };
        (0..TEAM_SIZE)
            .map(|slot| spawn_point(team, slot))
            .max_by(|a, b| threat(*a).total_cmp(&threat(*b)))
            .expect("teams have spawns")
    }

    /// Hitscan from the shooter's eye against enemies rewound to where the shooter saw them.
    /// Teammates are passed through: no friendly fire.
    fn resolve_shot(&mut self, shooter: usize, view_tick: f32) {
        let shooter_class = self.players[shooter].class;
        let t = &self.classes[shooter_class.index()];
        let (m, team) = (&self.players[shooter].mech, self.players[shooter].team);
        let ray = aim_ray(t, m);
        // step_mech already cast this ray against the arena; aim_point is where it stopped.
        let mut best = (m.aim_point - ray.origin).length();
        let mut hit = None;
        let view = view_tick.clamp(self.tick as f32 - MAX_REWIND_TICKS, self.tick as f32);
        for (j, target) in self.players.iter().enumerate() {
            if target.team == team || target.mech.health <= 0.0 {
                continue;
            }
            let Some(pos) = rewind(&target.history, view) else { continue };
            let tt = &self.classes[target.class.index()];
            let pose = Pose::from_translation(pos + Vector::Y * (tt.mech_height * 0.5));
            if let Some(toi) = mech_capsule(tt).cast_ray(&pose, &ray, best, true) {
                best = toi;
                hit = Some(j);
            }
        }
        // After the match ends shots still fly, but don't hit anyone.
        let hit = hit.filter(|_| matches!(self.phase, Phase::Playing { .. }));

        let shooter_id = self.players[shooter].id;
        let end = ray.point_at(best);
        self.events.push(Event::Shot { shooter: shooter_id, end, hit: hit.map(|j| self.players[j].id) });
        let Some(j) = hit else { return };

        let target = &self.players[j];
        let braced = target.mech.class == MechClass::C && target.mech.ability_time > 0.0;
        let damage = self.classes[shooter_class.index()].shot_damage
            * if braced { self.classes[target.class.index()].brace_damage_mult } else { 1.0 };
        let respawn_at = self.tick + secs(self.classes[self.players[j].class.index()].respawn_delay);
        let target = &mut self.players[j];
        target.mech.health -= damage;
        if target.mech.health <= 0.0 {
            target.mech.health = 0.0;
            target.deaths += 1;
            target.respawn_at = Some(respawn_at);
            let victim = target.id;
            self.players[shooter].kills += 1;
            self.events.push(Event::Kill { killer: shooter_id, victim });
            self.scores[usize::from(team)] += 1;
            if self.scores[usize::from(team)] >= self.score_limit {
                self.end_match();
            }
        }
    }

    /// State for one recipient: its own full mech and input ack, everyone's views, the match.
    pub fn snapshot(&self, id: u8) -> Snapshot {
        let me = self.players.iter().find(|p| p.id == id);
        let (ended, winner, until) = match self.phase {
            Phase::Playing { started_at } => (false, None, started_at + secs(self.match_seconds)),
            Phase::Ended { winner, restart_at } => (true, winner, restart_at),
        };
        Snapshot {
            tick: self.tick,
            ack_seq: me.map_or(0, |p| p.ack_seq),
            me: me.map_or_else(Mech::default, |p| p.mech),
            players: self
                .players
                .iter()
                .map(|p| PlayerNet {
                    id: p.id,
                    team: p.team,
                    class: p.class,
                    bot: p.bot.is_some(),
                    kills: p.kills,
                    deaths: p.deaths,
                    view: MechView::from(&p.mech),
                })
                .collect(),
            events: self.events.clone(),
            state: MatchState {
                scores: self.scores,
                seconds_left: (until.saturating_sub(self.tick) as f32 / TICK_HZ).ceil() as u16,
                ended,
                winner,
            },
        }
    }
}

/// A fresh mech of `class` at `pos`.
fn spawn(classes: &[Tuning; 3], class: MechClass, pos: Vector) -> Mech {
    Mech { class, ..spawn_mech(&classes[class.index()], pos) }
}

fn spawn_point(team: u8, slot: usize) -> Vector {
    Vector::new(SPAWN_X[slot], 0.1, if team == 0 { 40.0 } else { -40.0 })
}

fn secs(s: f32) -> u32 {
    (s * TICK_HZ).round() as u32
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
