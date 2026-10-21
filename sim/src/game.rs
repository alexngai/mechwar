//! Authoritative team deathmatch: applies each client's inputs through `step_mech`, resolves
//! hits with lag compensation, fills teams with bots, keeps score and runs the match clock.
//! Pure logic; `server/` owns the sockets.

use std::collections::VecDeque;

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::Pose;

use crate::bot::{self, Bot, Nav};
use crate::collide;
use crate::item;
use crate::net::{Event, InputMsg, MatchState, MechView, PlayerNet, Snapshot};
use crate::projectile::{self, Projectile};
use crate::weapon;
use crate::{Arena, Map, Mech, MechClass, TICK_HZ, Tuning, Vector, mech_capsule, spawn_mech, step_mech};

pub const TEAM_SIZE: usize = 4;
pub const MAX_PLAYERS: usize = 2 * TEAM_SIZE;
const _: () = assert!(MAX_PLAYERS <= 16, "Blast hits are a u16 bitmask of player ids");
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
/// Longest callsign, in characters.
pub const NAME_MAX: usize = 16;
/// A player may rename this often.
const RENAME_SECONDS: f32 = 2.0;
/// Bots' callsigns, by player id.
const BOT_NAMES: [&str; 8] = ["Kestrel", "Vane", "Cinder", "Ashlar", "Gantry", "Flint", "Sable", "Harrow"];

/// A typed callsign reduced to what others may see: ASCII letters, digits, space, `-`, `_` and
/// `.`, single spaces, trimmed, at most NAME_MAX characters. Empty if nothing is left.
pub fn sanitize_name(raw: &str) -> String {
    let kept: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.')).collect();
    let words: Vec<&str> = kept.split(' ').filter(|w| !w.is_empty()).collect();
    words.join(" ").chars().take(NAME_MAX).collect::<String>().trim_end().to_string()
}

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
    name: String,
    /// Tick of the last accepted rename, for rate limiting.
    renamed_at: Option<u32>,
}

/// A projectile in flight and its owner's team, kept in case the owner leaves.
struct Flying {
    p: Projectile,
    team: u8,
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
    /// Index into `map::MAPS`; clients load the same map from their Welcome.
    pub map: usize,
    arena: Arena,
    nav: &'static Nav,
    /// Feet positions per team and slot, from the map.
    spawns: [Vec<Vector>; 2],
    players: Vec<Player>,
    projectiles: Vec<Flying>,
    /// This tick's events; cleared at the start of each step.
    events: Vec<Event>,
    scores: [u16; 2],
    phase: Phase,
    /// Bumped whenever a player joins, leaves or renames; the server sends a Roster on change.
    roster_version: u32,
}

impl Game {
    pub fn new(tuning: Tuning, map: usize) -> Self {
        let data = Map::load(map);
        assert!(data.spawns.iter().all(|s| s.len() >= TEAM_SIZE), "map needs {TEAM_SIZE} spawns per team");
        Self {
            map,
            arena: Arena::new(&data),
            nav: Nav::for_map(map),
            spawns: data.spawns.map(|team| team.iter().map(|p| Vector::from_array(*p)).collect()),
            classes: MechClass::ALL.map(|c| tuning.for_class(c)),
            tick: 0,
            bots: true,
            score_limit: 25,
            match_seconds: 600.0,
            players: Vec::new(),
            projectiles: Vec::new(),
            events: Vec::new(),
            scores: [0; 2],
            phase: Phase::Playing { started_at: 0 },
            roster_version: 0,
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
            self.roster_version += 1;
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
            mech: spawn(&self.classes, class, self.spawns[usize::from(team)][slot]),
            inputs: VecDeque::new(),
            credit: 0.0,
            ack_seq: 0,
            history: VecDeque::new(),
            kills: 0,
            deaths: 0,
            respawn_at: None,
            name: if bot.is_some() { BOT_NAMES[usize::from(id) % BOT_NAMES.len()].into() } else { format!("Pilot-{id:02}") },
            renamed_at: None,
            bot,
        });
        self.roster_version += 1;
        Some(id)
    }

    pub fn leave(&mut self, id: u8) {
        self.players.retain(|p| p.id != id);
        self.roster_version += 1;
    }

    /// Sets a human's callsign from what they typed (sanitized), at most once per
    /// RENAME_SECONDS. An empty result falls back to `Pilot-NN`.
    pub fn set_name(&mut self, id: u8, raw: &str) {
        let tick = self.tick;
        let Some(p) = self.players.iter_mut().find(|p| p.id == id && p.bot.is_none()) else { return };
        if p.renamed_at.is_some_and(|at| tick < at + secs(RENAME_SECONDS)) {
            return;
        }
        let name = sanitize_name(raw);
        p.name = if name.is_empty() { format!("Pilot-{id:02}") } else { name };
        p.renamed_at = Some(tick);
        self.roster_version += 1;
    }

    /// Changes whenever the roster does.
    pub fn roster_version(&self) -> u32 {
        self.roster_version
    }

    /// Every player's id and callsign.
    pub fn roster(&self) -> Vec<(u8, String)> {
        self.players.iter().map(|p| (p.id, p.name.clone())).collect()
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
            if !self.players.is_empty() {
                self.players.clear();
                self.roster_version += 1;
            }
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
            let input = bot.think(&self.arena, self.nav, t, &p.mech, target.as_ref(), self.tick);
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
                let t = &self.classes[p.class.index()];
                step_mech(&self.arena, t, &mut p.mech, &msg.input);
                let mut shells = Vec::new();
                if p.mech.launched {
                    shells = projectile::volley(t, &p.mech, p.id, msg.seq);
                }
                if p.mech.shot && t.shot_speed > 0.0 {
                    shells.extend(weapon::volley(t, &p.mech, p.id, msg.seq));
                }
                if p.mech.threw {
                    shells.push(projectile::grenade(t, &p.mech, p.id, msg.seq));
                }
                for shell in shells {
                    self.events.push(Event::Launch(shell));
                    self.projectiles.push(Flying { p: shell, team: p.team });
                }
                if p.mech.shot && t.shot_speed <= 0.0 {
                    self.resolve_shot(i, msg.seq, msg.view_tick);
                }
                if self.players[i].mech.pulsed {
                    self.pulse(i);
                }
            }
        }

        // Mechs block each other; heavier ones shove lighter ones. Pairs go in a fixed order.
        for j in 1..self.players.len() {
            let (earlier, rest) = self.players.split_at_mut(j);
            let b = &mut rest[0];
            for a in earlier {
                let (ta, tb) = (&self.classes[a.class.index()], &self.classes[b.class.index()]);
                let share = tb.mech_mass / (ta.mech_mass + tb.mech_mass);
                collide::separate(&self.arena, ta, &mut a.mech, tb, &mut b.mech, share);
            }
        }

        // Projectiles fly once everyone has moved, against enemies where they stand now.
        // ponytail: no rewind, so shooters lead by their ping; fast-forward new projectiles by
        // half the shooter's RTT if hits feel late.
        let mut flying = std::mem::take(&mut self.projectiles);
        let mut bursts = Vec::new();
        flying.retain_mut(|f| {
            let enemies = || {
                self.players
                    .iter()
                    .filter(|q| q.team != f.team && q.mech.health > 0.0)
                    .map(|q| (&self.classes[q.class.index()], &q.mech))
            };
            let t = projectile::tuning_for(&self.classes[f.p.class.index()], f.p.n);
            match projectile::fly(&self.arena, &t, &mut f.p, |ray, max| projectile::first_mech(ray, max, enemies())) {
                Some(at) => {
                    bursts.push((f.p, f.team, at));
                    false
                }
                None => true,
            }
        });
        self.projectiles = flying;
        for (p, team, at) in bursts {
            self.burst(p, team, at);
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
        self.projectiles.clear();
        self.phase = Phase::Playing { started_at: self.tick };
        for p in &mut self.players {
            p.class = p.next_class;
            p.mech = spawn(&self.classes, p.class, self.spawns[usize::from(p.team)][p.slot]);
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
        self.spawns[usize::from(team)]
            .iter()
            .copied()
            .max_by(|a, b| threat(*a).total_cmp(&threat(*b)))
            .expect("teams have spawns")
    }

    /// Hitscan pellets from the shooter's eye (seeded by input `seq`) against enemies rewound to
    /// where the shooter saw them, each dealing `shot_damage` scaled by falloff. Teammates are
    /// passed through: no friendly fire.
    fn resolve_shot(&mut self, shooter: usize, seq: u32, view_tick: f32) {
        let t = &self.classes[self.players[shooter].class.index()];
        let (m, team, shooter_id) = (&self.players[shooter].mech, self.players[shooter].team, self.players[shooter].id);
        let view = view_tick.clamp(self.tick as f32 - MAX_REWIND_TICKS, self.tick as f32);
        let targets: Vec<(usize, Pose, &Tuning)> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, q)| q.team != team && q.mech.health > 0.0)
            .filter_map(|(j, q)| {
                let tt = &self.classes[q.class.index()];
                rewind(&q.history, view).map(|pos| (j, Pose::from_translation(pos + Vector::Y * (tt.mech_height * 0.5)), tt))
            })
            .collect();
        let mut hits = Vec::new();
        for ray in weapon::pellets(t, m, seq) {
            let mut best = self.arena.cast_ray(&ray, t.weapon_range).unwrap_or(t.weapon_range);
            let mut hit = None;
            for (j, pose, tt) in &targets {
                if let Some(toi) = mech_capsule(tt).cast_ray(pose, &ray, best, true) {
                    best = toi;
                    hit = Some(*j);
                }
            }
            // After the match ends shots still fly, but don't hit anyone.
            let hit = hit.filter(|_| matches!(self.phase, Phase::Playing { .. }));
            self.events.push(Event::Shot { shooter: shooter_id, end: ray.point_at(best), hit: hit.map(|j| self.players[j].id) });
            hits.extend(hit.map(|j| (j, t.shot_damage * weapon::falloff(t, best))));
        }
        for (j, damage) in hits {
            self.apply_damage(Some(shooter), j, damage);
        }
    }

    /// Splash from projectile `p` (fired by `team`) bursting at `at`, and its Blast event.
    fn burst(&mut self, p: Projectile, team: u8, at: Vector) {
        let t = projectile::tuning_for(&self.classes[p.class.index()], p.n);
        let hurt: Vec<(usize, f32)> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, q)| q.team != team && q.mech.health > 0.0)
            .map(|(j, q)| (j, projectile::splash(&self.arena, &t, p.primary, at, &self.classes[q.class.index()], &q.mech)))
            .filter(|&(_, damage)| damage > 0.0)
            .collect();
        let attacker = self.players.iter().position(|q| q.id == p.owner);
        let mut hits = 0;
        for (j, damage) in hurt {
            if matches!(self.phase, Phase::Playing { .. }) {
                hits |= 1 << self.players[j].id;
                self.apply_damage(attacker, j, damage);
            }
        }
        self.events.push(Event::Blast { owner: p.owner, seq: p.seq, n: p.n, primary: p.primary, class: p.class, pos: at, hits });
    }

    /// Player `user`'s EMP: jams every living enemy it reaches, and its Pulse event.
    /// ponytail: targets aren't rewound like shots, so at high ping one the user saw just inside
    /// the radius can be out of it by now; rewind with `history` if that shows in play.
    fn pulse(&mut self, user: usize) {
        let u = &self.players[user];
        let t = &self.classes[u.class.index()];
        let reached: Vec<usize> = (0..self.players.len())
            .filter(|&j| {
                let q = &self.players[j];
                q.team != u.team && q.mech.health > 0.0 && item::emp_reaches(&self.arena, t, &u.mech, &self.classes[q.class.index()], &q.mech)
            })
            .collect();
        let (owner, pos) = (u.id, item::emp_center(t, &u.mech));
        let mut hits = 0;
        for j in reached {
            item::jam(t, &mut self.players[j].mech);
            hits |= 1 << self.players[j].id;
        }
        self.events.push(Event::Pulse { owner, pos, hits });
    }

    /// Damages player `j` (less while braced) while the match is on, ending any repair. A kill
    /// scores for `attacker`, if they're still here.
    fn apply_damage(&mut self, attacker: Option<usize>, j: usize, amount: f32) {
        let target = &self.players[j];
        if !matches!(self.phase, Phase::Playing { .. }) || target.mech.health <= 0.0 {
            return;
        }
        let tt = &self.classes[target.class.index()];
        let braced = target.mech.class == MechClass::C && target.mech.ability_time > 0.0;
        let damage = amount * if braced { tt.brace_damage_mult } else { 1.0 };
        let respawn_at = self.tick + secs(tt.respawn_delay);
        let target = &mut self.players[j];
        target.mech.stop_repair(tt);
        target.mech.health -= damage;
        if target.mech.health > 0.0 {
            return;
        }
        target.mech.health = 0.0;
        target.deaths += 1;
        target.respawn_at = Some(respawn_at);
        let victim = target.id;
        let Some(a) = attacker else { return };
        let (killer, team) = (self.players[a].id, self.players[a].team);
        self.players[a].kills += 1;
        self.events.push(Event::Kill { killer, victim });
        self.scores[usize::from(team)] += 1;
        if self.scores[usize::from(team)] >= self.score_limit {
            self.end_match();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::InputMsg;
    use crate::{DT, Input};

    fn send(game: &mut Game, id: u8, input: Input) {
        game.push_input(id, InputMsg { seq: game.tick + 1, input, view_tick: game.tick as f32 });
    }

    fn mech(game: &Game, id: u8) -> Mech {
        game.players.iter().find(|p| p.id == id).unwrap().mech
    }

    #[test]
    fn emp_hits_only_enemies_in_reach() {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        // Joins alternate teams. Around the user: a teammate 5 m off, an enemy 8 m off, one 12 m
        // off behind the cover at (-15, 10), and one 23 m off, out of range.
        let [user, near, mate, walled, far] = [0, 1, 2, 3, 5];
        for (x, z) in [(-15.0, 18.0), (-15.0, 26.0), (-10.0, 18.0), (-15.0, 6.0), (0.0, 40.0), (5.0, 30.0)] {
            let id = game.join().unwrap();
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = Vector::new(x, 0.1, z);
        }
        assert!(game.players.iter().all(|p| p.team == p.id % 2), "teams aren't as the test assumes");

        send(&mut game, user, Input { emp: true, ..Input::default() });
        game.step();
        let pulse = game.events.iter().find_map(|e| match *e {
            Event::Pulse { owner, hits, .. } => Some((owner, hits)),
            _ => None,
        });
        assert_eq!(pulse, Some((user, 1 << near)));
        let hit = mech(&game, near);
        assert_eq!((hit.jammed, hit.fuel), (t.emp_jam, t.fuel_max - t.emp_drain));
        for id in [user, mate, walled, far] {
            let m = mech(&game, id);
            assert_eq!((m.jammed, m.fuel), (0.0, t.fuel_max), "player {id} was jammed");
        }
        assert_eq!(mech(&game, user).emps, t.emp_charges as u8 - 1);

        // The jammed enemy can't boost until the jam wears off, then can.
        let boost = Input { move_z: 1.0, boost: true, ..Input::default() };
        for ticks in 1.. {
            send(&mut game, near, boost);
            game.step();
            let m = mech(&game, near);
            if m.jammed > 0.0 {
                assert!(!m.boosting, "boosted while jammed");
                continue;
            }
            assert!(m.boosting, "still can't boost after the jam");
            assert!((ticks as f32 * DT - t.emp_jam).abs() <= DT, "jam lasted {ticks} ticks");
            break;
        }
    }
}
