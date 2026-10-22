//! Authoritative team deathmatch: applies each client's inputs through `step_mech`, resolves
//! hits with lag compensation, fills teams with bots, keeps score and runs the match clock.
//! Pure logic; `server/` owns the sockets.

use std::collections::VecDeque;

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Pose, Ray};

use crate::bot::{self, Bot, Nav};
use crate::collide;
use crate::item;
use crate::net::{Event, InputMsg, MatchState, MechView, Orb, PlayerNet, Snapshot};
use crate::projectile::{self, Projectile};
use crate::weapon;
use crate::{Arena, Arsenal, DT, Loadout, Map, Mech, MechClass, TICK_HZ, Tuning, Vector, hit_shape, spawn_mech, step_mech};

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
/// A destroyed mech drops a health orb holding ORB_HEALTH, floating ORB_HEIGHT over the ground
/// where it fell. It heals every mech whose chest is within ORB_RADIUS at ORB_RATE (either team)
/// until it runs dry, or fades after ORB_SECONDS.
pub const ORB_HEALTH: f32 = 25.0;
pub const ORB_RADIUS: f32 = 6.0;
const ORB_RATE: f32 = 10.0;
const ORB_SECONDS: f32 = 30.0;
const ORB_HEIGHT: f32 = 1.5;

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
    loadout: Loadout,
    /// Class and weapons to take at the next spawn.
    next_class: MechClass,
    next_loadout: Loadout,
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
    /// Tuning per class and loadout.
    arsenal: Arsenal,
    pub tick: u32,
    /// Fill empty slots with bots while at least one human is connected.
    pub bots: bool,
    /// Team kills that win the match.
    pub score_limit: u16,
    pub match_seconds: f32,
    /// Index into `map::MAPS`; clients load the same map from their Welcome, and switch with
    /// the match state's.
    pub map: usize,
    /// Maps to rotate through, dealt like a shuffled deck: each plays once before any repeats,
    /// never twice in a row. Empty to stay on `map`.
    pub rotation: Vec<usize>,
    /// The rest of the current deck; the next map comes off the end.
    upcoming: Vec<usize>,
    next_map: usize,
    /// xorshift64 state for shuffling the rotation.
    rng: u64,
    arena: Arena,
    nav: &'static Nav,
    /// Feet positions per team and slot, from the map.
    spawns: [Vec<Vector>; 2],
    players: Vec<Player>,
    projectiles: Vec<Flying>,
    orbs: Vec<Orb>,
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
            rotation: Vec::new(),
            upcoming: Vec::new(),
            next_map: map,
            rng: 0x9E37_79B9_7F4A_7C15,
            arena: Arena::new(&data),
            nav: Nav::for_map(map),
            spawns: data.spawns.map(|team| team.iter().map(|p| Vector::from_array(*p)).collect()),
            arsenal: Arsenal::new(&tuning),
            tick: 0,
            bots: true,
            score_limit: 25,
            match_seconds: 600.0,
            players: Vec::new(),
            projectiles: Vec::new(),
            orbs: Vec::new(),
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

    /// Class and weapons for this player's next spawn; immediate if they haven't moved yet.
    pub fn pick(&mut self, id: u8, class: MechClass, loadout: Loadout) {
        let loadout = self.arsenal.clamp(loadout);
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
        (p.next_class, p.next_loadout) = (class, loadout);
        if p.ack_seq == 0 && p.mech.health > 0.0 {
            (p.class, p.loadout) = (class, loadout);
            p.mech = spawn(&self.arsenal, class, loadout, p.mech.pos);
        }
    }

    /// `pick` with the class's own weapons.
    pub fn pick_class(&mut self, id: u8, class: MechClass) {
        self.pick(id, class, Loadout::of(class));
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
            loadout: Loadout::of(class),
            next_class: class,
            next_loadout: Loadout::of(class),
            mech: spawn(&self.arsenal, class, Loadout::of(class), self.spawns[usize::from(team)][slot]),
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
            Phase::Ended { restart_at, .. } if self.tick >= restart_at => {
                self.load_map(self.next_map);
                self.start_match();
            }
            _ => {}
        }

        for i in 0..self.players.len() {
            if self.players[i].respawn_at.is_some_and(|at| self.tick >= at) {
                let pos = self.respawn_point(self.players[i].team);
                let p = &mut self.players[i];
                (p.class, p.loadout) = (p.next_class, p.next_loadout);
                p.mech = spawn(&self.arsenal, p.class, p.loadout, pos);
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
            let t = self.arsenal.of(&me.mech);
            let enemies = || self.players.iter().filter(|p| p.team != me.team && p.mech.health > 0.0);
            let dist = |p: &&Player| p.mech.pos.distance(me.mech.pos);
            let target = enemies()
                .filter(|p| bot::sees(&self.arena, t, &me.mech, &p.mech))
                .min_by(|a, b| dist(a).total_cmp(&dist(b)))
                .or_else(|| enemies().min_by(|a, b| dist(a).total_cmp(&dist(b))))
                .map(|p| p.mech);
            let p = &mut self.players[i];
            let bot = p.bot.as_mut().expect("checked above");
            let mut input = bot.think(&self.arena, self.nav, t, &p.mech, target.as_ref(), self.tick);
            // Burst a shell that has flown past the target with the target inside its blast.
            if let Some(tm) = &target {
                let tt = self.arsenal.of(tm);
                let chest = tm.pos + Vector::Y * (tt.mech_height * 0.5);
                input.alt_fire |= self.projectiles.iter().any(|f| {
                    let ts = self.arsenal.get(f.p.class, f.p.loadout);
                    f.p.owner == p.id && projectile::armed(&f.p) && f.p.vel.dot(chest - f.p.pos) < 0.0 && projectile::splash(&self.arena, ts, false, f.p.pos, tt, tm) > 0.0
                });
            }
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
                let t = self.arsenal.of(&p.mech);
                step_mech(&self.arena, t, &mut p.mech, &msg.input);
                if p.mech.alt_pressed {
                    projectile::detonate(p.id, self.projectiles.iter_mut().map(|f| &mut f.p));
                }
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
                let (ta, tb) = (self.arsenal.of(&a.mech), self.arsenal.of(&b.mech));
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
                    .map(|q| (self.arsenal.of(&q.mech), &q.mech))
            };
            let t = projectile::tuning_for(self.arsenal.get(f.p.class, f.p.loadout), &f.p);
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

        // Orbs heal everyone alive around them, a tick's worth each, until they run dry or fade.
        for orb in &mut self.orbs {
            for p in self.players.iter_mut().filter(|p| p.mech.health > 0.0) {
                let t = self.arsenal.of(&p.mech);
                if (p.mech.pos + Vector::Y * (t.mech_height * 0.5)).distance(orb.pos) <= ORB_RADIUS {
                    let heal = (ORB_RATE * DT).min(orb.health).min(t.health_max - p.mech.health);
                    p.mech.health += heal;
                    orb.health -= heal;
                }
            }
        }
        let tick = self.tick;
        self.orbs.retain(|o| o.health > 1e-3 && tick < o.fades_at);

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
        self.orbs.clear();
        self.phase = Phase::Playing { started_at: self.tick };
        for p in &mut self.players {
            (p.class, p.loadout) = (p.next_class, p.next_loadout);
            p.mech = spawn(&self.arsenal, p.class, p.loadout, self.spawns[usize::from(p.team)][p.slot]);
            if let Some(bot) = &mut p.bot {
                bot.respawned();
            }
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
        // The next map comes off the deck; an empty deck is shuffled anew, not leading with this map.
        if self.rotation.len() > 1 {
            if self.upcoming.is_empty() {
                self.upcoming = self.shuffled(self.rotation.clone());
                if self.upcoming.last() == Some(&self.map) {
                    self.upcoming.swap(0, self.rotation.len() - 1);
                }
            }
            self.next_map = self.upcoming.pop().expect("a refilled deck has maps");
        }
    }

    /// Rotates through `maps` from here on, shuffling with `seed`. The first deck leaves out the
    /// current map, so every map has played before any comes round again.
    pub fn rotate(&mut self, maps: Vec<usize>, seed: u64) {
        self.rng = seed | 1;
        self.upcoming = self.shuffled(maps.iter().copied().filter(|&m| m != self.map).collect());
        self.rotation = maps;
    }

    /// `maps` in a random order (Fisher-Yates, on the xorshift64 state).
    fn shuffled(&mut self, mut maps: Vec<usize>) -> Vec<usize> {
        for i in (1..maps.len()).rev() {
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 7;
            self.rng ^= self.rng << 17;
            maps.swap(i, (self.rng % (i as u64 + 1)) as usize);
        }
        maps
    }

    /// Swaps in map `index`: its arena, nav and spawns. Matches start on it from their spawns.
    fn load_map(&mut self, index: usize) {
        if index == self.map {
            return;
        }
        let data = Map::load(index);
        self.map = index;
        self.arena = Arena::new(&data);
        self.nav = Nav::for_map(index);
        self.spawns = data.spawns.map(|team| team.iter().map(|p| Vector::from_array(*p)).collect());
        for p in &mut self.players {
            p.history.clear();
        }
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
        let t = self.arsenal.of(&self.players[shooter].mech);
        let (m, team, shooter_id) = (&self.players[shooter].mech, self.players[shooter].team, self.players[shooter].id);
        let view = view_tick.clamp(self.tick as f32 - MAX_REWIND_TICKS, self.tick as f32);
        // ponytail: the crouch is as of now, not rewound; it only differs for the 0.3 s at most
        // that a repair has been starting or ending. Rewind it too if that shows.
        let targets: Vec<_> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, q)| q.team != team && q.mech.health > 0.0)
            .filter_map(|(j, q)| {
                let (shape, center) = hit_shape(self.arsenal.of(&q.mech), &Mech { pos: rewind(&q.history, view)?, ..q.mech });
                Some((j, Pose::from_translation(center), shape))
            })
            .collect();
        let mut hits = Vec::new();
        for ray in weapon::pellets(t, m, seq) {
            let mut best = self.arena.cast_ray(&ray, t.weapon_range).unwrap_or(t.weapon_range);
            let mut hit = None;
            for (j, pose, shape) in &targets {
                if let Some(toi) = shape.cast_ray(pose, &ray, best, true) {
                    best = toi;
                    hit = Some(*j);
                }
            }
            // After the match ends shots still fly, but don't hit anyone.
            let hit = hit.filter(|_| matches!(self.phase, Phase::Playing { .. }));
            self.events.push(Event::Shot { shooter: shooter_id, end: ray.point_at(best), hit: hit.map(|j| self.players[j].id) });
            hits.extend(hit.map(|j| (j, t.shot_damage * weapon::power(t, m.shot_charge) * weapon::falloff(t, best))));
        }
        for (j, damage) in hits {
            self.apply_damage(Some(shooter), j, damage);
        }
    }

    /// Splash from projectile `p` (fired by `team`) bursting at `at`, and its Blast event.
    fn burst(&mut self, p: Projectile, team: u8, at: Vector) {
        let t = projectile::tuning_for(self.arsenal.get(p.class, p.loadout), &p);
        let hurt: Vec<(usize, f32)> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, q)| q.team != team && q.mech.health > 0.0)
            .map(|(j, q)| (j, projectile::splash(&self.arena, &t, p.primary, at, self.arsenal.of(&q.mech), &q.mech)))
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
        self.events.push(Event::Blast { owner: p.owner, seq: p.seq, n: p.n, primary: p.primary, class: p.class, loadout: p.loadout, charge: p.charge, pos: at, hits });
    }

    /// Player `user`'s EMP: jams every living enemy it reaches, and its Pulse event.
    /// ponytail: targets aren't rewound like shots, so at high ping one the user saw just inside
    /// the radius can be out of it by now; rewind with `history` if that shows in play.
    fn pulse(&mut self, user: usize) {
        let u = &self.players[user];
        let t = self.arsenal.of(&u.mech);
        let reached: Vec<usize> = (0..self.players.len())
            .filter(|&j| {
                let q = &self.players[j];
                q.team != u.team && q.mech.health > 0.0 && item::emp_reaches(&self.arena, t, &u.mech, self.arsenal.of(&q.mech), &q.mech)
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
    /// drops a health orb, and scores for `attacker`, if they're still here.
    fn apply_damage(&mut self, attacker: Option<usize>, j: usize, amount: f32) {
        let target = &self.players[j];
        if !matches!(self.phase, Phase::Playing { .. }) || target.mech.health <= 0.0 {
            return;
        }
        let tt = self.arsenal.of(&target.mech);
        let braced = target.mech.class == MechClass::C && target.mech.ability_time > 0.0;
        let damage = amount * if braced { tt.brace_damage_mult } else { 1.0 };
        let respawn_at = self.tick + secs(tt.respawn_delay);
        let target = &mut self.players[j];
        target.mech.end_repair(tt);
        target.mech.health -= damage;
        if target.mech.health > 0.0 {
            return;
        }
        target.mech.health = 0.0;
        target.deaths += 1;
        target.respawn_at = Some(respawn_at);
        let (victim, fell) = (target.id, target.mech.pos);
        // Over the ground below, if it went down in the air.
        let ground = self.arena.cast_ray(&Ray::new(fell + Vector::Y * 0.5, Vector::NEG_Y), 60.0).map_or(fell, |d| fell + Vector::Y * (0.5 - d));
        self.orbs.push(Orb { pos: ground + Vector::Y * ORB_HEIGHT, health: ORB_HEALTH, fades_at: self.tick + secs(ORB_SECONDS) });
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
                    loadout: p.loadout,
                    bot: p.bot.is_some(),
                    kills: p.kills,
                    deaths: p.deaths,
                    view: MechView::from(&p.mech),
                })
                .collect(),
            events: self.events.clone(),
            orbs: self.orbs.clone(),
            state: MatchState {
                map: self.map as u8,
                next_map: self.next_map as u8,
                scores: self.scores,
                seconds_left: (until.saturating_sub(self.tick) as f32 / TICK_HZ).ceil() as u16,
                ended,
                winner,
            },
        }
    }
}

/// A fresh mech of `class` carrying `loadout` at `pos`.
fn spawn(arsenal: &Arsenal, class: MechClass, loadout: Loadout, pos: Vector) -> Mech {
    Mech { class, loadout, ..spawn_mech(arsenal.get(class, loadout), pos) }
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
    fn rotation_plays_every_map_before_any_repeats() {
        let maps: Vec<usize> = crate::map::ROTATION.iter().map(|name| Map::index(name).unwrap()).collect();
        for seed in [1, 42, 0xdead_beef, 1_792_656_822_821_000_000] {
            let mut game = Game::new(Tuning::default(), maps[0]);
            game.rotate(maps.clone(), seed);
            // Deal 4 decks' worth without loading each map: only the order matters here.
            let mut played = vec![game.map];
            for _ in 1..maps.len() * 4 {
                game.end_match();
                assert_ne!(game.next_map, game.map, "seed {seed}: the same map twice in a row: {played:?}");
                game.map = game.next_map;
                played.push(game.map);
            }
            for deck in played.chunks(maps.len()) {
                let mut seen = deck.to_vec();
                seen.sort();
                seen.dedup();
                assert_eq!(seen.len(), maps.len(), "seed {seed}: a deck missed a map: {played:?}");
            }
        }
    }

    #[test]
    fn matches_rotate_to_another_map() {
        let (foundry, saltworks) = (Map::index("foundry").unwrap(), Map::index("saltworks").unwrap());
        let mut game = Game::new(Tuning::default(), foundry);
        game.bots = false;
        let id = game.join().unwrap();
        // Without a rotation it stays put.
        game.end_match();
        (0..=secs(POST_MATCH_SECONDS)).for_each(|_| game.step());
        assert_eq!(game.map, foundry);

        game.rotate(vec![foundry, saltworks], 42);
        game.end_match();
        let s = game.snapshot(id).state;
        assert_eq!((s.map, s.next_map), (foundry as u8, saltworks as u8), "the next map isn't announced");
        (0..=secs(POST_MATCH_SECONDS)).for_each(|_| game.step());
        assert_eq!((game.map, game.snapshot(id).state.map), (saltworks, saltworks as u8));
        let pos = mech(&game, id).pos;
        let spawns = Map::load(saltworks).spawns;
        assert!(spawns.iter().flatten().any(|p| Vector::from_array(*p).distance(pos) < 1.0), "not on a Saltworks spawn: {pos}");
    }

    #[test]
    fn destroyed_mechs_drop_orbs_that_heal_until_dry() {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        let (killer, victim, far) = (game.join().unwrap(), game.join().unwrap(), game.join().unwrap());
        let at = |game: &Game, id| game.players.iter().position(|p| p.id == id).unwrap();
        for (id, x) in [(killer, 3.0), (victim, 0.0), (far, 20.0)] {
            let i = at(&game, id);
            game.players[i].mech.pos = Vector::new(x, 0.05, 0.0);
        }
        // Killed in mid-air, it drops its orb over the floor below.
        let v = at(&game, victim);
        game.players[v].mech.pos.y = 10.0;
        game.apply_damage(Some(at(&game, killer)), v, 1e3);
        let orb = game.orbs[0];
        assert!(orb.pos.distance(Vector::new(0.0, ORB_HEIGHT, 0.0)) < 0.05, "orb at {}", orb.pos);
        assert_eq!(game.snapshot(killer).orbs.len(), 1);

        for id in [killer, far] {
            let i = at(&game, id);
            game.players[i].mech.health = 40.0;
        }
        for _ in 0..(3.0 * TICK_HZ) as u32 {
            game.step();
        }
        // The killer, beside it, takes all 25 over 2.5 s; the one 20 m off gets none.
        assert!((mech(&game, killer).health - (40.0 + ORB_HEALTH)).abs() < 1e-3, "killer at {}", mech(&game, killer).health);
        assert_eq!(mech(&game, far).health, 40.0);
        assert!(game.orbs.is_empty(), "a dry orb lingers");
    }

    #[test]
    fn a_picked_loadout_fires_its_weapons() {
        // A Wisp carrying the Bulwark's weapons fires flak pellets and a mortar shell, not the
        // Stitcher's hitscan or the darts.
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let id = game.join().unwrap();
        let heavy = Loadout::of(MechClass::C);
        game.pick(id, MechClass::A, heavy);
        send(&mut game, id, Input { fire: true, alt_fire: true, ..Input::default() });
        game.step();
        let m = mech(&game, id);
        assert_eq!((m.class, m.loadout), (MechClass::A, heavy));
        let t = game.arsenal.get(MechClass::C, heavy);
        let launched: Vec<Projectile> = game.events.iter().filter_map(|e| if let Event::Launch(p) = e { Some(*p) } else { None }).collect();
        assert_eq!(launched.iter().filter(|p| p.primary).count(), t.pellets as usize, "flak pellets");
        assert_eq!(launched.iter().filter(|p| !p.primary).count(), t.alt_count.max(1.0) as usize, "mortar shells");
        assert!(launched.iter().all(|p| (p.class, p.loadout) == (MechClass::A, heavy)));
        assert!(!game.events.iter().any(|e| matches!(e, Event::Shot { .. })), "hitscan fired");
    }

    #[test]
    fn untouched_orbs_fade() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        game.join().unwrap();
        game.orbs.push(Orb { pos: Vector::new(30.0, ORB_HEIGHT, 30.0), health: ORB_HEALTH, fades_at: game.tick + secs(ORB_SECONDS) });
        for _ in 0..secs(ORB_SECONDS) - 1 {
            game.step();
        }
        assert_eq!(game.orbs.len(), 1, "faded early");
        game.step();
        assert!(game.orbs.is_empty(), "never faded");
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

    #[test]
    fn rocket_airburst_clips_a_mech_behind_cover() {
        // A thin wall 3 m high, the shooter on a pedestal 16 m in front of it, and an enemy right
        // behind it. The rocket is aimed into the wall's face just under its top.
        let t = Tuning::default();
        let solid = |center, half| crate::map::Solid { center, half, yaw: 0.0, tilt: 0.0 };
        let map = Map {
            name: "cover".into(),
            solids: vec![solid([0.0, -0.5, 0.0], [50.0, 0.5, 50.0]), solid([0.0, 1.5, 0.0], [4.0, 1.5, 0.25]), solid([0.0, 2.0, 16.0], [2.0, 2.0, 2.0])],
            spawns: [vec![], vec![]],
            nav: vec![],
            pads: vec![],
            size: [100.0, 100.0],
        };
        // Returns the blast, where the rocket was a tick before plus that tick's travel, and the
        // enemy's health after.
        let shoot = |burst: bool| {
            let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
            game.bots = false;
            game.arena = Arena::new(&map);
            let (shooter, hider) = (game.join().unwrap(), game.join().unwrap());
            for (id, pos) in [(shooter, Vector::new(0.0, 4.1, 16.0)), (hider, Vector::new(0.0, 0.1, -1.85))] {
                game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
            }
            for _ in 0..10 {
                send(&mut game, shooter, Input::default());
                send(&mut game, hider, Input::default());
                game.step();
            }
            let d = Vector::new(0.0, 2.7, 0.25) - (mech(&game, shooter).pos + Vector::Y * t.eye_height);
            let aim = Input { yaw: (-d.x).atan2(-d.z), pitch: d.y.atan2(d.x.hypot(d.z)), ..Input::default() };
            send(&mut game, shooter, Input { alt_fire: true, ..aim });
            game.step();
            for _ in 0..60 {
                // Pressed when this tick's flight ends just before the wall, still above its top.
                let p = game.projectiles.first().expect("rocket in flight").p;
                let was = p.pos + p.vel * DT;
                send(&mut game, shooter, Input { alt_fire: burst && was.z < 3.3, ..aim });
                game.step();
                if let Some(at) = game.events.iter().find_map(|e| if let Event::Blast { pos, .. } = *e { Some(pos) } else { None }) {
                    return (at, was, mech(&game, hider).health);
                }
            }
            panic!("no blast");
        };

        let (at, _, health) = shoot(false);
        assert!((at.z - 0.25).abs() < 0.2 && at.y < 3.0, "impact at {at}, not the wall's face");
        assert_eq!(health, t.health_max, "the wall should have stopped the splash");

        let (at, was, health) = shoot(true);
        assert!(at.distance(was) < 1e-4, "burst at {at}, not where the rocket was ({was})");
        assert!(at.z > 0.25 && at.y > 3.0, "burst at {at} isn't over the front of the wall");
        assert!(health < t.health_max, "the burst missed the enemy behind the wall");
    }

    #[test]
    fn bots_burst_shells_that_pass_their_target() {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        let human = game.join().unwrap();
        let bot = game.add_player(1, Some(Bot::new(1)), MechClass::B).unwrap();
        for (id, pos) in [(human, Vector::new(0.0, 0.1, 0.0)), (bot, Vector::new(0.0, 0.1, -20.0))] {
            let m = &mut game.players.iter_mut().find(|p| p.id == id).unwrap().mech;
            m.pos = pos;
            m.alt_wait = 10.0; // so the bot doesn't press to fire
        }
        // The bot's rocket, 2 m past the human's chest and flying on.
        let chest = Vector::new(0.0, 0.1 + t.mech_height * 0.5, 0.0);
        let p = Projectile { owner: bot, seq: 1, n: 0, primary: false, class: MechClass::B, loadout: Loadout::of(MechClass::B), charge: 0.0, pos: chest + Vector::Z * 2.0, vel: Vector::Z * t.alt_speed, age: 0.5 };
        game.projectiles.push(Flying { p, team: 1 });
        game.step();
        let hits = game.events.iter().find_map(|e| if let Event::Blast { owner, hits, .. } = *e { Some((owner, hits)) } else { None });
        assert_eq!(hits, Some((bot, 1 << human)));
    }
}
