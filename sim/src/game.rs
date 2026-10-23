//! Authoritative team deathmatch: applies each client's inputs through `step_mech`, resolves
//! hits with lag compensation, fills teams with bots, keeps score and runs the match clock.
//! Pure logic; `server/` owns the sockets.

use std::collections::VecDeque;

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Pose, Ray};

use crate::arsenal;
use crate::bot::{self, Bot, Nav};
use crate::collide;
use crate::deploy::{self, Deployable, Kind};
use crate::item::{self, Item};
use crate::net::{Cloud, Event, InputMsg, MatchState, MechView, Orb, PlayerNet, Snapshot};
use crate::progress::{self, Tally};
use crate::projectile::{self, Projectile};
use crate::weapon;
use crate::{Arena, Arsenal, DT, Loadout, Map, Mech, MechClass, Slot, TICK_HZ, Tuning, Vector, aim_ray, hit_shape, spawn_mech, step_mech};

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
/// until it runs dry, or fades after ORB_SECONDS. A Salve drops the same orb for its side alone.
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
    /// Tick the player can launch from the hangar at, while destroyed or not launched yet.
    respawn_at: Option<u32>,
    /// Asked to launch: a human stays in the hangar until they do (bots launch on their own).
    launch: bool,
    /// Server-driven player; None for a human.
    bot: Option<Bot>,
    name: String,
    /// Tick of the last accepted rename, for rate limiting.
    renamed_at: Option<u32>,
    /// This match's tally toward the player's progression, and their level (0 for bots).
    tally: Tally,
    level: u8,
    /// Damage taken this life: (attacker id, amount, tick), for crediting assists.
    ledger: Vec<(u8, f32, u32)>,
}

/// What dealt damage, for counting kills by weapon.
#[derive(Clone, Copy, Debug)]
pub enum Cause {
    /// A weapon (or a thrown item), by index into its slot's weapons.json list.
    Weapon { slot: Slot, index: u8 },
    Unknown,
}

/// Damage older than this doesn't count toward an assist (s).
const ASSIST_WINDOW: f32 = 15.0;

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
    /// Bots' skill, 0 (raw) to 1 (sharp): each bot's own spreads around it.
    pub bot_skill: f32,
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
    clouds: Vec<Cloud>,
    deployables: Vec<Deployable>,
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
            bot_skill: 0.5,
            score_limit: 25,
            match_seconds: 600.0,
            players: Vec::new(),
            projectiles: Vec::new(),
            orbs: Vec::new(),
            clouds: Vec::new(),
            deployables: Vec::new(),
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

    /// Player `id` launching as `class` carrying `loadout`: from the hangar, as soon as their
    /// respawn delay is up. Out in the arena it only takes before their first input (respawning
    /// them in place); otherwise changes wait for the next launch.
    pub fn pick(&mut self, id: u8, class: MechClass, loadout: Loadout) {
        let loadout = self.arsenal.clamp(loadout);
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
        if p.respawn_at.is_some() {
            (p.next_class, p.next_loadout, p.launch) = (class, loadout, true);
        } else if p.ack_seq == 0 && p.mech.health > 0.0 {
            (p.class, p.loadout, p.next_class, p.next_loadout) = (class, loadout, class, loadout);
            p.mech = spawn(&self.arsenal, class, loadout, p.mech.pos);
        }
    }

    /// Sends player `id` to the hangar, ready to launch: a human joining, or a new match.
    pub fn dock(&mut self, id: u8) {
        let tick = self.tick;
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
        (p.mech.health, p.respawn_at, p.launch) = (0.0, Some(tick), false);
    }

    /// `pick` with the class's own weapons.
    pub fn pick_class(&mut self, id: u8, class: MechClass) {
        self.pick(id, class, Loadout::of(class));
    }

    fn team_count(&self, team: u8) -> usize {
        self.players.iter().filter(|p| p.team == team).count()
    }

    fn add_player(&mut self, team: u8, mut bot: Option<Bot>, class: MechClass) -> Option<u8> {
        let id = (0..MAX_PLAYERS as u8).find(|id| !self.players.iter().any(|p| p.id == *id))?;
        let slot = (0..TEAM_SIZE).find(|s| !self.players.iter().any(|p| p.team == team && p.slot == *s))?;
        // Humans start with the class's own weapons until they launch; bots pick a build.
        let loadout = bot.as_mut().map_or(Loadout::of(class), |b| b.pick_loadout(&self.arsenal, class));
        self.players.push(Player {
            id,
            team,
            slot,
            class,
            loadout,
            next_class: class,
            next_loadout: loadout,
            mech: spawn(&self.arsenal, class, loadout, self.spawns[usize::from(team)][slot]),
            inputs: VecDeque::new(),
            credit: 0.0,
            ack_seq: 0,
            history: VecDeque::new(),
            kills: 0,
            deaths: 0,
            respawn_at: None,
            launch: false,
            name: if bot.is_some() { BOT_NAMES[usize::from(id) % BOT_NAMES.len()].into() } else { format!("Pilot-{id:02}") },
            renamed_at: None,
            tally: Tally::default(),
            level: 0,
            ledger: Vec::new(),
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

    /// Every player's id, callsign and level (0 for bots).
    pub fn roster(&self) -> Vec<(u8, String, u8)> {
        self.players.iter().map(|p| (p.id, p.name.clone(), p.level)).collect()
    }

    /// Player `id`'s callsign.
    pub fn name(&self, id: u8) -> Option<&str> {
        self.players.iter().find(|p| p.id == id).map(|p| p.name.as_str())
    }

    /// Shows a human's level by their callsign.
    pub fn set_level(&mut self, id: u8, level: u32) {
        let level = level.min(u32::from(u8::MAX)) as u8;
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id && p.bot.is_none() && p.level != level) {
            p.level = level;
            self.roster_version += 1;
        }
    }

    /// Player `id`'s tally this match, and their team.
    pub fn tally(&self, id: u8) -> Option<(&Tally, u8)> {
        self.players.iter().find(|p| p.id == id).map(|p| (&p.tally, p.team))
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
                    self.add_player(team, Some(Bot::with_skill(seed, self.bot_skill)), class);
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
            let p = &self.players[i];
            if p.respawn_at.is_some_and(|at| self.tick >= at) && (p.launch || p.bot.is_some()) {
                let pos = self.respawn_point(p.team);
                let p = &mut self.players[i];
                // A bot picks a new build each life, as a player might in the hangar.
                if let Some(bot) = &mut p.bot {
                    p.next_loadout = bot.pick_loadout(&self.arsenal, p.next_class);
                }
                (p.class, p.loadout) = (p.next_class, p.next_loadout);
                p.mech = spawn(&self.arsenal, p.class, p.loadout, pos);
                p.ledger.clear();
                (p.respawn_at, p.launch) = (None, false);
            }
        }

        // Bots queue one input per tick. Each knows only the enemies it has seen, heard or felt
        // (`Bot::perceive`), skipping fresh launches it can't hurt yet, plus what its teammates
        // radio in of those they see; it fights the one it picks from those in view, favoring one
        // a teammate is already on. With nothing to go on it groups on its team's lead (a human
        // if there's one alive), and a repair torch follows the nearest teammate and gets the
        // most hurt one it can see within twice its beam's reach.
        let alive = |p: &Player| p.mech.health > 0.0;
        let lead_of = |team: u8| {
            let mates = || self.players.iter().filter(move |p| p.team == team && alive(p));
            mates().find(|p| p.bot.is_none()).or_else(|| mates().min_by_key(|p| p.id)).map(|p| p.id)
        };
        let leads = [lead_of(0), lead_of(1)];
        let engaged: [Vec<u8>; 2] = [0, 1].map(|team| self.players.iter().filter(|p| p.team == team).filter_map(|p| p.bot.as_ref()?.focus()).collect());
        // First every bot looks and listens...
        let mut seen: Vec<(Option<u8>, Vec<(u8, Mech, f32)>)> = Vec::with_capacity(self.players.len());
        let mut radio: [Vec<(u8, u8, Vector)>; 2] = [Vec::new(), Vec::new()]; // (from, enemy, where)
        for i in 0..self.players.len() {
            let me = &self.players[i];
            if me.bot.is_none() {
                seen.push((None, Vec::new()));
                continue;
            }
            let t = self.arsenal.of(&me.mech);
            let hurt = |q: &Player| q.mech.health / self.arsenal.of(&q.mech).health_max;
            let enemies: Vec<(u8, Mech, f32)> = self
                .players
                .iter()
                .filter(|q| q.team != me.team && q.mech.health > 0.0 && q.mech.shield <= 0.0)
                .map(|q| (q.id, q.mech, hurt(q)))
                .collect();
            let (team, id) = (usize::from(me.team), me.id);
            let p = &mut self.players[i];
            let bot = p.bot.as_mut().expect("checked above");
            bot.engaged.clone_from(&engaged[team]);
            bot.smoke.clone_from(&self.clouds);
            let focus = bot.perceive(&self.arena, t, &p.mech, &enemies, self.tick);
            radio[team].extend(bot.sightings().map(|(enemy, at)| (id, enemy, at)));
            seen.push((focus, enemies));
        }
        // ...then hears its team's radio, and acts.
        for i in 0..self.players.len() {
            let me = &self.players[i];
            if me.bot.is_none() {
                continue;
            }
            let t = self.arsenal.of(&me.mech);
            let hurt = |q: &&Player| q.mech.health / self.arsenal.of(&q.mech).health_max;
            let mates = || self.players.iter().filter(|q| q.team == me.team && q.id != me.id && alive(q));
            let heal = (t.alt_beam > 0.0)
                .then(|| {
                    mates()
                        .filter(|q| hurt(q) < 0.8)
                        .filter(|q| q.mech.pos.distance(me.mech.pos) < 2.0 * t.alt_beam && bot::sees(&self.arena, t, &me.mech, &q.mech))
                        .min_by(|a, b| hurt(a).total_cmp(&hurt(b)))
                        .map(|q| q.mech)
                })
                .flatten();
            let dist = |q: &&Player| q.mech.pos.distance(me.mech.pos);
            let lead = if t.alt_beam > 0.0 {
                mates().min_by(|a, b| dist(a).total_cmp(&dist(b)))
            } else {
                leads[usize::from(me.team)].filter(|&l| l != me.id).and_then(|l| mates().find(|q| q.id == l))
            }
            .map(|q| q.mech.pos);
            let team = usize::from(me.team);
            let p = &mut self.players[i];
            let bot = p.bot.as_mut().expect("checked above");
            for &(from, enemy, at) in &radio[team] {
                if from != p.id {
                    bot.told(enemy, at, self.tick);
                }
            }
            bot.lead = lead;
            bot.orbs.clear();
            bot.orbs.extend(self.orbs.iter().filter(|o| o.dropped.is_none_or(|(_, side)| usize::from(side) == team)).map(|o| o.pos));
            let (focus, enemies) = &seen[i];
            let target = focus.and_then(|id| enemies.iter().find(|e| e.0 == id)).map(|e| e.1);
            let mut input = bot.think_with(&self.arena, self.nav, t, &p.mech, target.as_ref(), heal.as_ref(), self.tick);
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
                    projectile::cap(t, p.id, self.projectiles.iter_mut().map(|f| &mut f.p));
                    shells = projectile::volley(t, &p.mech, p.id, msg.seq);
                }
                if p.mech.shot && t.shot_speed > 0.0 {
                    shells.extend(weapon::volley(t, &p.mech, p.id, msg.seq));
                }
                if p.mech.threw {
                    shells.push(projectile::thrown(t, &p.mech, p.id, msg.seq));
                }
                if p.mech.sprung {
                    projectile::set_off(p.id, self.projectiles.iter_mut().map(|f| &mut f.p));
                }
                for shell in shells {
                    self.events.push(Event::Launch(shell));
                    self.projectiles.push(Flying { p: shell, team: p.team });
                }
                if p.mech.shot && t.shot_speed <= 0.0 {
                    self.resolve_shot(i, msg.seq, msg.view_tick);
                }
                if self.players[i].mech.pulsed {
                    match Item::of(self.players[i].mech.loadout, false) {
                        Item::Orb => self.drop_orb(i),
                        Item::Dome => self.deploy(i, Kind::Dome),
                        Item::Barrier => self.deploy(i, Kind::Barrier),
                        _ => self.pulse(i),
                    }
                }
                if self.players[i].mech.beaming {
                    self.beam(i);
                }
                if self.arsenal.of(&self.players[i].mech).alt_lock_time > 0.0 {
                    let team = self.players[i].team;
                    let chests = self.chests(|q| q.team != team);
                    let t = self.arsenal.of(&self.players[i].mech).clone();
                    projectile::track(&self.arena, &t, &mut self.players[i].mech, &chests);
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

        // Projectiles fly once everyone has moved, against enemies where they stand now, and
        // their shields.
        // ponytail: no rewind, so shooters lead by their ping; fast-forward new projectiles by
        // half the shooter's RTT if hits feel late.
        let mut flying = std::mem::take(&mut self.projectiles);
        let mut bursts = Vec::new();
        let chests = self.chests(|_| true);
        let sizes = items(&self.arsenal);
        flying.retain_mut(|f| {
            let enemies = || {
                self.players
                    .iter()
                    .filter(|q| q.team != f.team && q.mech.health > 0.0)
                    .map(|q| (self.arsenal.of(&q.mech), &q.mech))
            };
            let t = projectile::tuning_for(self.arsenal.get(f.p.class, f.p.loadout), &f.p);
            if let Some(&(_, goal)) = chests.iter().find(|(id, _)| f.p.target == id + 1) {
                projectile::home(&t, &mut f.p, goal);
            }
            let burst = projectile::fly(&self.arena, &t, &mut f.p, |ray, max| {
                let dome = deploy::stops(&self.deployables, sizes, f.team, ray, max);
                projectile::first_mech(ray, dome.unwrap_or(max), enemies()).or(dome)
            });
            match burst.or_else(|| projectile::triggered(&t, &f.p, enemies()).then_some(f.p.pos)) {
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
        // A limpet gone (set off, or burst on a mech or by its fuse) frees G to throw another.
        for q in &mut self.players {
            q.mech.limpet &= self.projectiles.iter().any(|f| f.p.owner == q.id && projectile::item(&f.p) == Some(Item::Limpet));
        }

        // Orbs heal everyone alive around them (a Salve's, its side only), a tick's worth each,
        // until they run dry or fade. A Salve's healing of teammates counts for its dropper.
        let mut mended = Vec::new();
        for orb in &mut self.orbs {
            for p in self.players.iter_mut().filter(|p| p.mech.health > 0.0 && orb.dropped.is_none_or(|(_, team)| team == p.team)) {
                let t = self.arsenal.of(&p.mech);
                if (p.mech.pos + Vector::Y * (t.mech_height * 0.5)).distance(orb.pos) <= ORB_RADIUS {
                    let heal = (ORB_RATE * DT).min(orb.health).min(t.health_max - p.mech.health);
                    p.mech.health += heal;
                    orb.health -= heal;
                    mended.extend(orb.dropped.filter(|&(by, _)| by != p.id).map(|(by, _)| (by, heal)));
                }
            }
        }
        for (by, heal) in mended {
            if let Some(p) = self.players.iter_mut().find(|p| p.id == by) {
                p.tally.healed += heal;
            }
        }
        let tick = self.tick;
        self.orbs.retain(|o| o.health > 1e-3 && tick < o.fades_at);
        self.clouds.retain(|c| tick < c.fades_at);
        let deployed = self.deployables.len();
        self.deployables.retain(|d| tick < d.expires);
        if self.deployables.len() != deployed {
            self.arena.set_barriers(items(&self.arsenal), &self.deployables);
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
        self.orbs.clear();
        self.clouds.clear();
        self.deployables.clear();
        self.arena.set_barriers(items(&self.arsenal), &[]);
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
            p.tally = Tally::default();
            p.ledger.clear();
        }
        // Humans start each match in the hangar.
        let humans: Vec<u8> = self.players.iter().filter(|p| p.bot.is_none()).map(|p| p.id).collect();
        for id in humans {
            self.dock(id);
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
            let wall = self.arena.cast_ray(&ray, t.weapon_range).unwrap_or(t.weapon_range);
            let mut best = deploy::stops(&self.deployables, t, team, &ray, wall).unwrap_or(wall);
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
        let cause = Cause::Weapon { slot: Slot::Primary, index: m.loadout.primary };
        for (j, damage) in hits {
            self.apply_damage_by(Some(shooter), j, damage, cause);
        }
    }

    /// Splash from projectile `p` (fired by `team`) bursting at `at` (or smoke, from a Pall), and
    /// its Blast event.
    fn burst(&mut self, p: Projectile, team: u8, at: Vector) {
        let t = projectile::tuning_for(self.arsenal.get(p.class, p.loadout), &p);
        if projectile::item(&p) == Some(Item::Smoke) {
            self.clouds.push(Cloud { pos: at, radius: t.smoke_radius, fades_at: self.tick + secs(t.smoke_seconds) });
        }
        // A dome shields what's inside from a burst outside it, as a wall would.
        let shielded = |q: &Player| {
            let to = q.mech.pos + Vector::Y * (self.arsenal.of(&q.mech).mech_height * 0.5) - at;
            deploy::stops(&self.deployables, &t, team, &Ray::new(at, to.normalize_or_zero()), to.length()).is_some()
        };
        let hurt: Vec<(usize, f32)> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, q)| q.team != team && q.mech.health > 0.0 && !shielded(q))
            .map(|(j, q)| (j, projectile::splash(&self.arena, &t, p.primary, at, self.arsenal.of(&q.mech), &q.mech)))
            .filter(|&(_, damage)| damage > 0.0)
            .collect();
        let attacker = self.players.iter().position(|q| q.id == p.owner);
        let slot = if projectile::item(&p).is_some() { Slot::Offensive } else { Slot::weapon(p.primary) };
        let cause = Cause::Weapon { slot, index: p.loadout.get(slot) };
        let mut hits = 0;
        for (j, damage) in hurt {
            if matches!(self.phase, Phase::Playing { .. }) {
                hits |= 1 << self.players[j].id;
                self.apply_damage_by(attacker, j, damage, cause);
            }
        }
        self.events.push(Event::Blast { owner: p.owner, seq: p.seq, n: p.n, primary: p.primary, class: p.class, loadout: p.loadout, charge: p.charge, pos: at, hits });
        for bomblet in projectile::split(self.arsenal.get(p.class, p.loadout), &p, at) {
            self.events.push(Event::Launch(bomblet));
            self.projectiles.push(Flying { p: bomblet, team });
        }
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
                q.team != u.team && q.mech.health > 0.0 && q.mech.shield <= 0.0 && item::emp_reaches(&self.arena, t, &u.mech, self.arsenal.of(&q.mech), &q.mech)
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

    /// Player `user`'s Salve: a repair orb at its feet, for its side.
    fn drop_orb(&mut self, user: usize) {
        let u = &self.players[user];
        let orb = Orb { pos: self.orb_spot(u.mech.pos), health: ORB_HEALTH, fades_at: self.tick + secs(ORB_SECONDS), dropped: Some((u.id, u.team)) };
        self.orbs.push(orb);
    }

    /// Player `user` puts down a deployable of `kind`, in place of any it had out. A barrier
    /// that would stand in a mech doesn't go up, and the charge comes back.
    fn deploy(&mut self, user: usize, kind: Kind) {
        let u = &self.players[user];
        let mechs = self.players.iter().filter(|q| q.mech.health > 0.0).map(|q| (self.arsenal.of(&q.mech), &q.mech));
        match deploy::place(&self.arena, self.arsenal.of(&u.mech), &u.mech, kind, u.team, u.id, self.tick, mechs) {
            Some(d) => {
                deploy::add(&mut self.deployables, d);
                self.arena.set_barriers(items(&self.arsenal), &self.deployables);
            }
            None => self.players[user].mech.emps += 1,
        }
    }

    /// Where an orb for a mech at `feet` floats: over the ground below, if it's in the air.
    fn orb_spot(&self, feet: Vector) -> Vector {
        let ground = self.arena.cast_ray(&Ray::new(feet + Vector::Y * 0.5, Vector::NEG_Y), 60.0).map_or(feet, |d| feet + Vector::Y * (0.5 - d));
        ground + Vector::Y * ORB_HEIGHT
    }

    /// Player `user`'s held beam this tick: mends the teammate it touches, burns the enemy.
    /// ponytail: targets aren't rewound like shots; rewind with `history` if beams slip at high ping.
    fn beam(&mut self, user: usize) {
        let u = &self.players[user];
        let t = self.arsenal.of(&u.mech);
        let others = self.players.iter().enumerate().filter(|&(j, q)| j != user && q.mech.health > 0.0).map(|(_, q)| (q.id, self.arsenal.of(&q.mech), &q.mech));
        let (mut end, mut hit) = weapon::beam(&self.arena, t, &u.mech, others);
        // Another side's dome stops it short.
        let eye = aim_ray(t, &u.mech).origin;
        if let Some(toi) = deploy::stops(&self.deployables, t, u.team, &Ray::new(eye, (end - eye).normalize_or_zero()), end.distance(eye)) {
            (end, hit) = (eye + (end - eye).normalize_or_zero() * toi, None);
        }
        let (owner, team, heal, burn) = (u.id, u.team, t.alt_beam_heal * DT, t.alt_damage * DT);
        self.players[user].mech.beam_end = end;
        self.events.push(Event::Beam { owner, end, hit });
        let Some(j) = hit.and_then(|id| self.players.iter().position(|q| q.id == id)) else { return };
        if self.players[j].team == team {
            let max = self.arsenal.of(&self.players[j].mech).health_max;
            let q = &mut self.players[j].mech;
            let healed = heal.min(max - q.health).max(0.0);
            q.health += healed;
            self.players[user].tally.healed += healed;
        } else {
            let index = self.players[user].mech.loadout.secondary;
            self.apply_damage_by(Some(user), j, burn, Cause::Weapon { slot: Slot::Secondary, index });
        }
    }

    /// `apply_damage_by` with no known cause.
    #[cfg(test)]
    fn apply_damage(&mut self, attacker: Option<usize>, j: usize, amount: f32) {
        self.apply_damage_by(attacker, j, amount, Cause::Unknown);
    }

    /// Damages player `j` (less while braced) while the match is on, ending any repair. A kill
    /// drops a health orb, and scores for `attacker`, if they're still here; it goes on the
    /// attacker's tally (by `cause`'s weapon), as an assist on the tally of anyone else who dealt
    /// enough of the victim's recent damage, and as a death on the victim's.
    fn apply_damage_by(&mut self, attacker: Option<usize>, j: usize, amount: f32, cause: Cause) {
        let target = &self.players[j];
        if !matches!(self.phase, Phase::Playing { .. }) || target.mech.health <= 0.0 || target.mech.shield > 0.0 {
            return;
        }
        let tt = self.arsenal.of(&target.mech);
        let braced = target.mech.class == MechClass::C && target.mech.ability_time > 0.0;
        let damage = amount * if braced { tt.brace_damage_mult } else { 1.0 };
        let respawn_at = self.tick + secs(tt.respawn_delay);
        let (tick, from) = (self.tick, attacker.map(|a| (self.players[a].id, self.players[a].mech.pos)));
        let target = &mut self.players[j];
        // A bot feels where the hit came from.
        if let (Some((id, pos)), Some(bot)) = (from, &mut target.bot) {
            bot.hurt_by(id, pos, tick);
        }
        target.mech.end_repair(tt);
        // Assist shares count the health a hit took, not its overkill.
        if let Some((id, _)) = from {
            target.ledger.push((id, damage.min(target.mech.health), tick));
        }
        target.mech.health -= damage;
        if target.mech.health > 0.0 {
            return;
        }
        target.mech.health = 0.0;
        target.deaths += 1;
        target.tally.stats.deaths += 1;
        target.respawn_at = Some(respawn_at);
        // Credit: the killer by weapon, and assists by share of the recent damage.
        let (bot, ledger) = (target.bot.is_some(), std::mem::take(&mut target.ledger));
        let (victim, fell) = (target.id, target.mech.pos);
        let killer = from.map(|(id, _)| id);
        let recent = |&&(_, _, at): &&(u8, f32, u32)| tick.saturating_sub(at) < secs(ASSIST_WINDOW);
        let total: f32 = ledger.iter().filter(recent).map(|l| l.1).sum();
        let mut shares: Vec<(u8, f32)> = Vec::new();
        for &(id, dealt, _) in ledger.iter().filter(recent).filter(|l| Some(l.0) != killer) {
            match shares.iter_mut().find(|s| s.0 == id) {
                Some(s) => s.1 += dealt,
                None => shares.push((id, dealt)),
            }
        }
        for (id, dealt) in shares {
            if total > 0.0 && dealt / total >= progress::ASSIST_SHARE
                && let Some(p) = self.players.iter_mut().find(|p| p.id == id)
            {
                p.tally.assist(dealt / total, bot);
            }
        }
        if let Some(a) = attacker {
            let weapon = match cause {
                Cause::Weapon { slot, index } => arsenal::weapon(slot, index).map(|(id, _)| id.to_string()),
                Cause::Unknown => None,
            };
            self.players[a].tally.kill(weapon.as_deref(), bot);
        }
        self.orbs.push(Orb { pos: self.orb_spot(fell), health: ORB_HEALTH, fades_at: self.tick + secs(ORB_SECONDS), dropped: None });
        let Some(a) = attacker else { return };
        let (killer, team) = (self.players[a].id, self.players[a].team);
        self.players[a].kills += 1;
        self.events.push(Event::Kill { killer, victim });
        self.scores[usize::from(team)] += 1;
        if self.scores[usize::from(team)] >= self.score_limit {
            self.end_match();
        }
    }

    /// The match's map, score and clock, as players see them.
    pub fn match_state(&self) -> MatchState {
        let (ended, winner, until) = match self.phase {
            Phase::Playing { started_at } => (false, None, started_at + secs(self.match_seconds)),
            Phase::Ended { winner, restart_at } => (true, winner, restart_at),
        };
        MatchState {
            map: self.map as u8,
            next_map: self.next_map as u8,
            scores: self.scores,
            seconds_left: (until.saturating_sub(self.tick) as f32 / TICK_HZ).ceil() as u16,
            ended,
            winner,
        }
    }

    /// How many humans and bots are playing.
    pub fn headcount(&self) -> (usize, usize) {
        let bots = self.players.iter().filter(|p| p.bot.is_some()).count();
        (self.players.len() - bots, bots)
    }

    /// State for one recipient: its own full mech and input ack, everyone's views, the match.
    pub fn snapshot(&self, id: u8) -> Snapshot {
        let me = self.players.iter().find(|p| p.id == id);
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
                    docked: p.respawn_at.is_some_and(|at| self.tick >= at),
                    view: MechView::from(&p.mech),
                })
                .collect(),
            events: self.events.clone(),
            orbs: self.orbs.clone(),
            clouds: self.clouds.clone(),
            deployables: self.deployables.clone(),
            hangar: me.and_then(|p| p.respawn_at).map(|at| at.saturating_sub(self.tick) as f32 * DT),
            state: self.match_state(),
        }
    }
}

impl Game {
    /// Chest positions, by player id, of the living players `which` picks: what lock-on aims at.
    fn chests(&self, which: impl Fn(&Player) -> bool) -> Vec<(u8, Vector)> {
        self.players
            .iter()
            .filter(|q| q.mech.health > 0.0 && which(q))
            .map(|q| (q.id, q.mech.pos + Vector::Y * (self.arsenal.of(&q.mech).mech_height * 0.5)))
            .collect()
    }
}

/// Item values, the same for every mech: what deployables are sized by.
fn items(arsenal: &Arsenal) -> &Tuning {
    arsenal.get(MechClass::B, Loadout::default())
}

/// A fresh mech of `class` carrying `loadout` at `pos`.
fn spawn(arsenal: &Arsenal, class: MechClass, loadout: Loadout, pos: Vector) -> Mech {
    let t = arsenal.get(class, loadout);
    let mut m = Mech { class, loadout, shield: t.spawn_shield, ..spawn_mech(t, pos) };
    item::fill(t, &mut m);
    m
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

    /// Drops every fresh spawn's shield, so tests can hurt and jam mechs straight away.
    fn unshield(game: &mut Game) {
        for p in &mut game.players {
            p.mech.shield = 0.0;
        }
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
    fn kills_and_assists_go_on_the_tallies() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let (killer, helper, victim) = (game.join().unwrap(), game.join().unwrap(), game.join().unwrap());
        let at = |game: &Game, id| game.players.iter().position(|p| p.id == id).unwrap();
        unshield(&mut game);
        let v = at(&game, victim);
        game.players[v].mech.health = 100.0;
        game.apply_damage(Some(at(&game, helper)), v, 40.0);
        // The killer's overkill doesn't dilute the helper's 40%.
        game.apply_damage_by(Some(at(&game, killer)), v, 1e3, Cause::Weapon { slot: Slot::Primary, index: 0 });
        let weapon = arsenal::weapon(Slot::Primary, 0).unwrap().0.to_string();
        let tally = |id| game.tally(id).unwrap().0.clone();
        let (k, h, d) = (tally(killer), tally(helper), tally(victim));
        assert_eq!((k.stats.kills, k.stats.weapon_kills.get(&weapon), k.stats.assists), (1, Some(&1), 0));
        assert_eq!((h.stats.kills, h.stats.assists), (0, 1));
        assert!((h.assist_share - 0.4).abs() < 1e-4, "share {}", h.assist_share);
        assert_eq!(d.stats.deaths, 1);
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
        unshield(&mut game);
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
        // A Light carrying the Heavy's weapons fires the flak's hitscan pellets and a grenade, not
        // the SMG's single round or the scatter's flak volley.
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let id = game.join().unwrap();
        let heavy = Loadout::of(MechClass::C);
        game.dock(id);
        game.pick(id, MechClass::A, heavy);
        game.step();
        send(&mut game, id, Input { fire: true, alt_fire: true, ..Input::default() });
        game.step();
        let m = mech(&game, id);
        assert_eq!((m.class, m.loadout), (MechClass::A, heavy));
        let t = game.arsenal.get(MechClass::C, heavy);
        let launched: Vec<Projectile> = game.events.iter().filter_map(|e| if let Event::Launch(p) = e { Some(*p) } else { None }).collect();
        let pellets = game.events.iter().filter(|e| matches!(e, Event::Shot { .. })).count();
        assert!(t.pellets > 1.0 && pellets == t.pellets as usize, "{pellets} flak pellets");
        assert!(!launched.iter().any(|p| p.primary), "the flak launched projectiles");
        assert_eq!(launched.len(), t.alt_count.max(1.0) as usize, "mortar shells");
        assert!(launched.iter().all(|p| (p.class, p.loadout) == (MechClass::A, heavy)));
    }

    #[test]
    fn beams_mend_teammates_and_burn_enemies() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        // Joins alternate teams: the user, an enemy 8 m behind them (clear, as in the EMP test),
        // and a teammate.
        let [user, enemy, mate] = [0, 1, 2];
        for (x, z) in [(-15.0, 18.0), (-15.0, 26.0), (30.0, 30.0)] {
            let id = game.join().unwrap();
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = Vector::new(x, 0.1, z);
        }
        unshield(&mut game);
        let mender = (0u8..).map(|s| Loadout { primary: 0, secondary: s, ..Loadout::default() }).find(|&l| game.arsenal.get(MechClass::B, l).alt_beam > 0.0).unwrap();
        game.pick(user, MechClass::B, mender);
        game.players.iter_mut().find(|p| p.id == user).unwrap().mech.loadout = mender;
        let t = game.arsenal.get(MechClass::B, mender).clone();
        let beam = Input { yaw: std::f32::consts::PI, alt_fire: true, ..Input::default() };
        send(&mut game, user, beam);
        game.step();
        let on = game.events.iter().find_map(|e| if let Event::Beam { owner, hit, .. } = *e { Some((owner, hit)) } else { None });
        assert_eq!(on, Some((user, Some(enemy))));
        assert!((mech(&game, enemy).health - (t.health_max - t.alt_damage * DT)).abs() < 1e-4, "enemy health {}", mech(&game, enemy).health);
        assert!(mech(&game, user).heat > 0.0, "beaming ran cold");

        // Put the teammate there, hurt: it mends, capped at full.
        let p = game.players.iter_mut().find(|p| p.id == mate).unwrap();
        (p.mech.pos, p.mech.health) = (Vector::new(-15.0, 0.1, 24.0), t.health_max - 1.0);
        for _ in 0..secs(1.0) {
            send(&mut game, user, beam);
            game.step();
        }
        assert_eq!(mech(&game, mate).health, t.health_max);
        assert!(!game.events.iter().any(|e| matches!(e, Event::Launch(_))), "a beam launched a shell");
    }

    #[test]
    fn humans_launch_from_the_hangar_when_they_choose_and_spawn_shielded() {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        let (pilot, enemy) = (game.join().unwrap(), game.join().unwrap());
        game.dock(pilot);
        for _ in 0..secs(t.respawn_delay) + 5 {
            game.step();
        }
        assert!(mech(&game, pilot).health <= 0.0, "spawned without launching");
        assert_eq!(game.snapshot(pilot).hangar, Some(0.0));
        assert!(game.snapshot(enemy).players.iter().any(|p| p.id == pilot && p.docked), "a docked pilot is drawn");

        // Launching spawns them next tick, shielded: hits do nothing until they act.
        game.pick(pilot, MechClass::A, Loadout::of(MechClass::A));
        game.step();
        let m = mech(&game, pilot);
        assert!(m.health > 0.0 && m.shield > 0.0 && m.class == MechClass::A, "didn't launch shielded: {m:?}");
        assert_eq!(game.snapshot(pilot).hangar, None);
        let j = game.players.iter().position(|p| p.id == pilot).unwrap();
        game.apply_damage(None, j, 10.0);
        assert_eq!(mech(&game, pilot).health, m.health, "hurt through the shield");
        send(&mut game, pilot, Input { yaw: 1.0, pitch: 0.2, ..Input::default() });
        game.step();
        assert!(mech(&game, pilot).shield > 0.0, "looking around dropped the shield");
        send(&mut game, pilot, Input { move_z: 1.0, ..Input::default() });
        game.step();
        assert_eq!(mech(&game, pilot).shield, 0.0, "moving kept the shield");
        game.apply_damage(None, j, 10.0);
        assert!(mech(&game, pilot).health < m.health, "the shield never dropped");
        // Standing still, it lasts `spawn_shield` at most.
        let p = &mut game.players[j].mech;
        (p.shield, p.health) = (t.spawn_shield, t.health_max);
        for _ in 0..secs(t.spawn_shield) + 1 {
            send(&mut game, pilot, Input::default());
            game.step();
        }
        assert_eq!(mech(&game, pilot).shield, 0.0, "an idle pilot stayed shielded");

        // Out in the arena a pick waits for the next launch; destroyed, they wait in the hangar.
        game.pick(pilot, MechClass::C, Loadout::of(MechClass::C));
        game.apply_damage(None, j, 1000.0);
        for _ in 0..secs(t.respawn_delay) + 5 {
            game.step();
        }
        assert!(mech(&game, pilot).health <= 0.0, "respawned on its own");
        game.pick(pilot, MechClass::C, Loadout::of(MechClass::C));
        game.step();
        assert_eq!(mech(&game, pilot).class, MechClass::C);
    }

    #[test]
    fn bots_spread_skill_around_the_server_default() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bot_skill = 0.9;
        game.join().unwrap();
        game.step();
        let skills: Vec<f32> = game.players.iter().filter_map(|p| p.bot.as_ref()).map(|b| b.skill).collect();
        assert!(skills.len() > 4 && skills.iter().all(|s| (0.65..=1.0).contains(s)), "{skills:?}");
        assert!(skills.iter().any(|&s| s != skills[0]), "every bot alike: {skills:?}");
    }

    #[test]
    fn bots_radio_their_team_what_they_see() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let human = game.join().unwrap();
        // One bot looking north at the human; one far off, looking away.
        let (spotter, deaf) = (game.add_player(1, Some(Bot::new(1)), MechClass::B).unwrap(), game.add_player(1, Some(Bot::new(2)), MechClass::B).unwrap());
        for (id, pos, yaw) in [(human, Vector::new(0.0, 0.1, 0.0), 0.0), (spotter, Vector::new(0.0, 0.1, 20.0), 0.0), (deaf, Vector::new(40.0, 0.1, 40.0), std::f32::consts::PI)] {
            let m = &mut game.players.iter_mut().find(|p| p.id == id).unwrap().mech;
            (m.pos, m.yaw) = (pos, yaw);
        }
        unshield(&mut game);
        let knows = |game: &Game, id: u8| game.players.iter().find(|p| p.id == id).unwrap().bot.as_ref().unwrap().knows(human);
        game.step();
        assert!(knows(&game, spotter), "the spotter never saw the human");
        assert!(knows(&game, deaf), "the other bot wasn't told");
    }

    #[test]
    fn untouched_orbs_fade() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        game.join().unwrap();
        game.orbs.push(Orb { pos: Vector::new(30.0, ORB_HEIGHT, 30.0), health: ORB_HEALTH, fades_at: game.tick + secs(ORB_SECONDS), dropped: None });
        for _ in 0..secs(ORB_SECONDS) - 1 {
            game.step();
        }
        assert_eq!(game.orbs.len(), 1, "faded early");
        game.step();
        assert!(game.orbs.is_empty(), "never faded");
    }

    /// A game on blockout with no bots and an exact, full-damage gun: the dome's owner (team 0)
    /// at (0, 40) facing south (-z), and an enemy (team 1) at (0, 22). The owner carries `support`.
    fn standoff(support: &str) -> (Game, u8, u8) {
        let t = Tuning { spread_deg: 0.0, bloom_per_shot: 0.0, falloff_start: 1000.0, falloff_end: 1000.0, ..Tuning::default() };
        let mut game = Game::new(t, Map::index("blockout").unwrap());
        game.bots = false;
        let [owner, enemy] = [0, 1];
        for z in [40.0, 22.0] {
            let id = game.join().unwrap();
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = Vector::new(0.0, 0.1, z);
        }
        game.pick(owner, MechClass::B, Loadout { support: arsenal::index(Slot::Support, support), ..Loadout::of(MechClass::B) });
        game.pick(enemy, MechClass::B, Loadout::named("pike", "rocket"));
        unshield(&mut game);
        (game, owner, enemy)
    }

    /// Input aiming player `from`'s eye at player `to`'s chest.
    fn aim_at(game: &Game, from: u8, to: u8) -> Input {
        let (a, b) = (mech(game, from), mech(game, to));
        let t = game.arsenal.of(&a);
        let d = b.pos + Vector::Y * (game.arsenal.of(&b).mech_height * 0.5) - (a.pos + Vector::Y * t.eye_height);
        Input { yaw: libm::atan2f(-d.x, -d.z), pitch: (d.y / d.length()).asin(), ..Input::default() }
    }

    #[test]
    fn domes_stop_the_other_sides_shots_but_let_their_own_out() {
        let (mut game, owner, enemy) = standoff("dome");
        send(&mut game, owner, Input { emp: true, ..Input::default() });
        game.step();
        assert_eq!(game.deployables.iter().map(|d| (d.kind, d.owner)).collect::<Vec<_>>(), [(Kind::Dome, owner)]);
        let (dome, max) = (game.deployables[0].pos, game.arsenal.of(&mech(&game, owner)).health_max);

        // The enemy's rifle and rocket stop at the dome, splash and all.
        for fire in [Input { fire: true, ..aim_at(&game, enemy, owner) }, Input { alt_fire: true, ..aim_at(&game, enemy, owner) }] {
            for _ in 0..secs(1.5) {
                send(&mut game, enemy, fire);
                game.step();
                for e in &game.events {
                    if let Event::Shot { end, .. } | Event::Blast { pos: end, .. } = *e {
                        assert!(end.distance(dome) > items(&game.arsenal).dome_radius - 0.5, "a shot got in to {end}");
                    }
                }
            }
        }
        assert_eq!(mech(&game, owner).health, max, "hurt through the dome");
        // The owner shoots out.
        for _ in 0..5 {
            let fire = Input { fire: true, ..aim_at(&game, owner, enemy) };
            send(&mut game, owner, fire);
            game.step();
        }
        assert!(mech(&game, enemy).health < max, "the owner's shots didn't get out");
        // Gone once its time's up.
        for _ in 0..secs(items(&game.arsenal).dome_seconds) {
            game.step();
        }
        assert!(game.deployables.is_empty(), "the dome outlived its time");
    }

    #[test]
    fn barriers_block_movement_and_shots_until_they_expire() {
        let (mut game, owner, enemy) = standoff("barrier");
        let t = items(&game.arsenal).clone();
        send(&mut game, owner, Input { emp: true, ..Input::default() });
        game.step();
        let wall = game.deployables[0];
        assert_eq!(wall.kind, Kind::Barrier);
        assert!((wall.pos.z - (40.0 - t.barrier_distance)).abs() < 0.1, "at {}", wall.pos);
        // The enemy's shots stop at it.
        for _ in 0..10 {
            let fire = Input { fire: true, ..aim_at(&game, enemy, owner) };
            send(&mut game, enemy, fire);
            game.step();
        }
        let max = game.arsenal.of(&mech(&game, owner)).health_max;
        assert_eq!(mech(&game, owner).health, max, "shot through the barrier");
        // The owner walks into it and stops.
        let r = game.arsenal.of(&mech(&game, owner)).mech_radius;
        for _ in 0..secs(2.0) {
            send(&mut game, owner, Input { move_z: 1.0, ..Input::default() });
            game.step();
        }
        let stopped = mech(&game, owner).pos.z;
        assert!(stopped > wall.pos.z + t.barrier_thickness * 0.5 + r - 0.1, "walked into it, to z {stopped}");
        // Once it's gone, the way's clear.
        while !game.deployables.is_empty() {
            game.step();
        }
        for _ in 0..secs(1.0) {
            send(&mut game, owner, Input { move_z: 1.0, ..Input::default() });
            game.step();
        }
        assert!(mech(&game, owner).pos.z < wall.pos.z - 2.0, "still blocked at z {}", mech(&game, owner).pos.z);
    }

    #[test]
    fn salve_orbs_heal_only_their_side() {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        // Joins alternate teams: the user, an enemy and a teammate, side by side.
        let [user, enemy, mate] = [0, 1, 2];
        for x in [0.0, 3.0, -3.0] {
            let id = game.join().unwrap();
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = Vector::new(x, 0.1, 0.0);
        }
        let salve = Loadout { support: arsenal::index(Slot::Support, "orb"), ..Loadout::of(MechClass::B) };
        game.pick(user, MechClass::B, salve);
        unshield(&mut game);
        for p in &mut game.players {
            p.mech.health = 50.0;
        }

        send(&mut game, user, Input { emp: true, ..Input::default() });
        game.step();
        assert!(!game.events.iter().any(|e| matches!(e, Event::Pulse { .. })), "the Salve went off as an EMP");
        assert_eq!(game.orbs.iter().map(|o| o.dropped).collect::<Vec<_>>(), [Some((user, 0))]);
        for _ in 0..secs(1.0) {
            game.step();
        }
        let hp = |id| mech(&game, id).health;
        assert!(hp(user) > 50.0 && hp(mate) > 50.0, "didn't heal its side: {} and {}", hp(user), hp(mate));
        assert_eq!(hp(enemy), 50.0, "healed the other side");
        // Mending the teammate (not itself) counts for the user.
        assert!((game.tally(user).unwrap().0.healed - (hp(mate) - 50.0)).abs() < 1e-3);
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
        unshield(&mut game);
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
            game.pick(shooter, MechClass::B, Loadout::named("pike", "rocket"));
            for (id, pos) in [(shooter, Vector::new(0.0, 4.1, 16.0)), (hider, Vector::new(0.0, 0.1, -1.85))] {
                game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
            }
            unshield(&mut game);
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
            m.loadout = Loadout::named("pike", "rocket"); // whatever build the bot rolled
            m.yaw = std::f32::consts::PI; // the bot faces south, at the human
        }
        unshield(&mut game);
        // The bot's rocket, 2 m past the human's chest and flying on.
        let chest = Vector::new(0.0, 0.1 + t.mech_height * 0.5, 0.0);
        let p = Projectile { owner: bot, seq: 1, n: 0, primary: false, class: MechClass::B, loadout: Loadout::named("pike", "rocket"), charge: 0.0, target: 0, pos: chest + Vector::Z * 2.0, vel: Vector::Z * t.alt_speed, age: 0.5 };
        game.projectiles.push(Flying { p, team: 1 });
        game.step();
        let hits = game.events.iter().find_map(|e| if let Event::Blast { owner, hits, .. } = *e { Some((owner, hits)) } else { None });
        assert_eq!(hits, Some((bot, 1 << human)));
    }
}
