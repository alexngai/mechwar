//! Authoritative matches (team deathmatch, deathmatch, Missile Assault, Siege): applies each client's inputs through
//! `step_mech`, resolves hits with lag compensation, fills teams with bots, keeps score and runs
//! the match clock.
//! Pure logic; `server/` owns the sockets.

use std::collections::VecDeque;

use rapier3d::parry::query::RayCast;
use rapier3d::prelude::{Pose, Ray, Rotation};
use serde::{Deserialize, Serialize};

use crate::ability::{self, Ability};
use crate::arsenal;
use crate::bot::{self, Bot, Nav, Policy};
use crate::collide;
use crate::convoy::{self, Convoy, News};
use crate::defense::{self, Defense};
use crate::ctf::{self, Ctf, Happened};
use crate::deploy::{self, Deployable, Kind};
use crate::item::{self, Item};
use crate::map::Objectives;
use crate::net::{Cloud, Event, InputMsg, MatchState, MechView, Orb, PlayerNet, Snapshot};
use crate::objective::{self, Assault};
use crate::siege::{self, Siege};
use crate::progress::{self, Tally};
use crate::projectile::{self, Projectile};
use crate::weapon;
use crate::{Arena, Arsenal, DT, Loadout, Map, Mech, MechClass, Slot, TICK_HZ, Tuning, Vector, aim_ray, hit_shape, melee, spawn_mech, step_mech};

pub const TEAM_SIZE: usize = 4;
pub const MAX_PLAYERS: usize = 2 * TEAM_SIZE;
const _: () = assert!(MAX_PLAYERS <= 16, "Blast hits are a u16 bitmask of player ids");
const _: () = assert!(MAX_PLAYERS <= deploy::TARGET as usize, "turrets' lock-on ids follow the players'");
const POST_MATCH_SECONDS: f32 = 10.0;
/// A pilot's fight, for bots on its side: the enemy it hit within this long (s).
const HUMAN_FOCUS: f32 = 3.0;
/// A repair torch bot mends a pilot first, counting it this much (a share of its hull) worse hurt.
const HUMAN_HEAL: f32 = 0.15;
/// A team match opens with this long penned in the spawns (`Game::staging_seconds`).
pub const STAGING_SECONDS: f32 = 10.0;
/// A kill's worth in points, shared out as kill credit (`progress::KILLER_BONUS`).
const POINTS_PER_KILL: f32 = 100.0;
/// Points for each mech in a zone when its team takes it; a Siege pilot's for each EU they bank,
/// and each point of hull they shoot off the enemy ship.
const CAPTURE_POINTS: f32 = 50.0;
const EU_POINTS: f32 = 0.5;
/// Capture the Flag: points for taking the enemy flag off its stand (as for a zone), for
/// capturing it, and for carrying our own flag home.
const FLAG_CAPTURE_POINTS: f32 = 200.0;
const FLAG_RETURN_POINTS: f32 = 50.0;
/// Co-op Defense's walkers: guns that reach WALKER_RANGE, firing bursts of WALKER_BURST rounds
/// WALKER_RATE a second apart, WALKER_PAUSE between, each dealing WALKER_ROUND, from WALKER_WARMUP
/// after they come through a gate.
const WALKER_RANGE: f32 = 30.0;
const WALKER_BURST: u8 = 4;
const WALKER_RATE: f32 = 6.0;
const WALKER_PAUSE: f32 = 1.5;
const WALKER_ROUND: f32 = 3.0;
const WALKER_WARMUP: f32 = 1.0;
/// Co-op's crawler and brute (see `lane_enemies_strike`), and infested mechs: scrap for each point
/// of health shot off one, and how long a downed one's wreck lies (s).
const CRAWLER_TRIGGER: f32 = 3.0;
const CRAWLER_BLAST: f32 = 5.0;
const CRAWLER_DAMAGE: f32 = 60.0;
const CRAWLER_PILOT: f32 = 25.0;
const BRUTE_REACH: f32 = 8.0;
const BRUTE_WINDUP: f32 = 1.2;
const BRUTE_SMASH: f32 = 150.0;
const BRUTE_PILOT: f32 = 40.0;
const BRUTE_COOLDOWN: f32 = 4.0;
const ELITE_SCRAP: f32 = 1.5;
/// Co-op's mortar walker (see `shell_towers`) and shield node (`shield_foes`).
const MORTAR_RANGE: f32 = 60.0;
/// A mortar shells towers no further than this above or below it: on a map in storeys, not a
/// cliff's worth of terraces over its lane (where nothing can reach it to stop it).
const MORTAR_RISE: f32 = 24.0;
const MORTAR_COOLDOWN: f32 = 5.0;
const MORTAR_FLIGHT: f32 = 2.5;
const MORTAR_BLAST: f32 = 4.0;
const MORTAR_DAMAGE: f32 = 80.0;
const MORTAR_PILOT: f32 = 30.0;
const NODE_DOME: f32 = 250.0;
const NODE_DOME_STEP: f32 = 20.0;
const NODE_RECHARGE: f32 = 8.0;
/// Co-op's MG and rocket towers do these times what the item turrets do, to the hive.
const TOWER_MG_POWER: f32 = 2.2;
const TOWER_ROCKET_POWER: f32 = 1.6;
/// A flak blueprint's rounds burst this far round where they hit (m); a pilot picks up salvage
/// within SALVAGE_REACH.
const FLAK_BURST: f32 = 3.0;
const SALVAGE_REACH: f32 = 3.5;
/// Co-op's bots building (see `bots_build`): how often they plan (s), how near their spot they
/// build from, how far off a lane's line they look, and the mix of towers they want (by
/// `defense::TOWERS`).
const BOT_PLAN: f32 = 1.0;
const BOT_BUILD_REACH: f32 = 12.0;
const BOT_SPOTS: [f32; 3] = [7.0, 10.0, 13.0];
const BOT_MIX: [f32; 4] = [1.0, 1.0, 0.8, 0.5];
/// Co-op's bosses (see `bosses_act`).
const EXCAVATOR_REACH: f32 = 10.0;
const EXCAVATOR_DRILL: f32 = 60.0;
const EXCAVATOR_GRIND: f32 = 20.0;
const EXCAVATOR_FIRST: f32 = 12.0;
const EXCAVATOR_EVERY: f32 = 20.0;
const EXCAVATOR_UNDER: f32 = 4.0;
const UNDERGROUND: f32 = 30.0;
const QUAKE_RADIUS: f32 = 12.0;
const QUAKE_DAMAGE: f32 = 120.0;
const QUAKE_PILOT: f32 = 30.0;
const QUAKE_STUN: f32 = 3.0;
const HIVE_EVERY: f32 = 10.0;
const HIVE_BROOD: usize = 3;
const HIVE_BURST: usize = 8;
const HIVE_EMP: f32 = 25.0;
/// A boss's grind and quake reach no further than this above or below it.
const BOSS_BAND: f32 = 8.0;
const ELITE_WRECK: f32 = 2.0;
/// Co-op's reactor as a torch meets it: a ball REACTOR_BODY round, REACTOR_MIDDLE over its foot.
const REACTOR_MIDDLE: f32 = 6.0;
const REACTOR_BODY: f32 = 6.0;
/// Co-op's arc pylon: lightning from its top (PYLON_TOP up) at the nearest walker in sight within
/// ARC_RANGE, ARC_DAMAGE, jumping on to ARC_HOPS more, each the nearest unstruck within ARC_HOP of
/// the last, for ARC_FALLOFF of the one before; again after ARC_COOLDOWN. Its pulse pylon stuns
/// every walker within PULSE_RADIUS for PULSE_STUN, and shakes PULSE_DAMAGE off each; again after
/// PULSE_COOLDOWN. (Reach and cooldowns by tier: `defense::reach`, `rate`.)
const PYLON_TOP: f32 = 3.0;
const ARC_RANGE: f32 = 20.0;
const ARC_DAMAGE: f32 = 40.0;
const ARC_HOPS: usize = 3;
const ARC_HOP: f32 = 9.0;
const ARC_FALLOFF: f32 = 0.7;
const ARC_COOLDOWN: f32 = 1.5;
const PULSE_RADIUS: f32 = 14.0;
const PULSE_STUN: f32 = 2.5;
const PULSE_DAMAGE: f32 = 15.0;
const PULSE_COOLDOWN: f32 = 7.0;
/// Convoy: points a second for each mech escorting the hauler while it walks.
const ESCORT_POINTS: f32 = 2.0;
/// A dropped flag nobody can reach (no waypoint this near, or nothing under it) goes home.
const FLAG_REACH: f32 = 12.0;
const SHIP_POINTS: f32 = 0.05;
/// The team modes' base guns: they fire on enemies within SENTRY_RANGE of them, and in Siege on
/// the enemy ship within SENTRY_SHIP_RANGE; bursts of SENTRY_BURST rounds SENTRY_RATE a second
/// apart, SENTRY_PAUSE s between bursts, each round dealing SENTRY_ROUND, opening up on a fresh
/// contact SENTRY_ACQUIRE after it shows. The range covers the spawns (every map's are within 30 m
/// of a gun) and little past, so the guns stop spawn camping without holding the base for its team.
/// Each has a SENTRY_SHIELD that doesn't regenerate; shot through, the gun's offline for
/// SENTRY_OFFLINE, then comes back full and can't be hurt for SENTRY_IMMUNE.
const SENTRY_RANGE: f32 = 35.0;
const SENTRY_SHIP_RANGE: f32 = 90.0;
const SENTRY_BURST: u8 = 8;
const SENTRY_RATE: f32 = 10.0;
const SENTRY_PAUSE: f32 = 0.7;
const SENTRY_ROUND: f32 = 4.0;
const SENTRY_ACQUIRE: f32 = 0.6;
pub const SENTRY_SHIELD: f32 = 400.0;
const SENTRY_OFFLINE: f32 = 25.0;
const SENTRY_IMMUNE: f32 = 15.0;
/// Deathmatch is only played on maps up to this wide (m): on bigger ones eight pilots spend the
/// match looking for each other.
const DM_MAX_SIZE: f32 = 200.0;

/// How a match is played and won.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Mode {
    /// Two teams; each kill scores for the killer's.
    #[default]
    TeamDeathmatch,
    /// Everyone for themselves, ranked by points (kill credit).
    Deathmatch,
    /// Two teams; held silos fire on the enemy base, and the last base standing wins.
    MissileAssault,
    /// Two teams; banked energy launches a battleship at the enemy base, and the last base
    /// standing wins.
    Siege,
    /// Two teams; take the enemy flag from their base to yours, first to `ctf::CAPTURES_TO_WIN`.
    CaptureTheFlag,
    /// Two teams; escort the hauler from the middle into the enemy base, or push it further.
    Convoy,
    /// Co-op: the pilots (one team) hold a reactor against waves of walkers (`defense.rs`).
    Defense,
}

impl Mode {
    pub const ALL: [Mode; 7] = [Mode::TeamDeathmatch, Mode::Deathmatch, Mode::MissileAssault, Mode::Siege, Mode::CaptureTheFlag, Mode::Convoy, Mode::Defense];

    /// Pilots against pilots: the modes quick play deals (not co-op).
    pub fn versus(self) -> bool {
        self != Mode::Defense
    }

    /// As the lobby and the server's settings spell it.
    pub fn key(self) -> &'static str {
        match self {
            Mode::TeamDeathmatch => "tdm",
            Mode::Deathmatch => "dm",
            Mode::MissileAssault => "ma",
            Mode::Siege => "siege",
            Mode::CaptureTheFlag => "ctf",
            Mode::Convoy => "convoy",
            Mode::Defense => "defense",
        }
    }

    /// As players see it.
    pub fn name(self) -> &'static str {
        match self {
            Mode::TeamDeathmatch => "Team Deathmatch",
            Mode::Deathmatch => "Deathmatch",
            Mode::MissileAssault => "Missile Assault",
            Mode::Siege => "Siege",
            Mode::CaptureTheFlag => "Capture the Flag",
            Mode::Convoy => "Convoy",
            Mode::Defense => "Co-op Defense",
        }
    }

    pub fn from_key(key: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|m| m.key() == key)
    }

    /// Whether `map` plays this mode.
    pub fn fits(self, map: &Map) -> bool {
        if map.objectives.coop && self.versus() {
            return false;
        }
        match self {
            Mode::TeamDeathmatch => true,
            Mode::Deathmatch => map.size[0].max(map.size[1]) <= DM_MAX_SIZE,
            Mode::MissileAssault => Assault::new(&map.objectives, &[]).is_some(),
            Mode::Siege => Siege::new(&map.objectives, &[]).is_some(),
            Mode::CaptureTheFlag => Ctf::new(&map.objectives, &[]).is_some(),
            Mode::Convoy => Convoy::new(&map.objectives).is_some(),
            // Co-op plays the maps made for it (Foundry's stand-in data is for tests).
            Mode::Defense => map.objectives.coop && map.objectives.defense.as_ref().is_some_and(|d| !d.gates.is_empty()),
        }
    }
}
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
/// A destroyed mech drops a health orb holding `orb_health`, floating ORB_HEIGHT over the ground
/// where it fell. It heals every mech whose chest is within ORB_RADIUS at ORB_RATE (either team)
/// until it runs dry, or fades after ORB_SECONDS. A Salve drops the same orb for its side alone.
#[cfg(test)]
pub const ORB_HEALTH: f32 = 37.5;
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
    /// In Deathmatch, the player's own id.
    team: u8,
    /// Which of the team's spawns the first spawn of each match takes (`Game::start_points`).
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
    /// Kill credit this match, in points (POINTS_PER_KILL a kill), and objective points.
    points: f32,
    /// Siege energy carried.
    eu: f32,
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
    /// Tick the ability's on at the latest: its duration from the tick it was used, and
    /// ABILITY_SLACK.
    ability_until: u32,
    /// The last throw by a melee strike it took.
    knock: Option<Knock>,
}

/// A throw by a melee strike (`melee.rs`): who threw, with which secondary (for kill credit),
/// until when another throw goes half as far and hitting a wall counts as a slam, and whether
/// its slam is spent (it slammed, or came down first).
#[derive(Clone, Copy, Debug)]
struct Knock {
    by: u8,
    index: u8,
    until: u32,
    slammed: bool,
}

/// What dealt damage, for counting kills by weapon.
#[derive(Clone, Copy, Debug)]
pub enum Cause {
    /// A weapon (or a thrown item), by index into its slot's weapons.json list.
    Weapon { slot: Slot, index: u8 },
    Unknown,
}

/// Seconds an ability may stay on past its duration, for input arriving late. A mech only steps
/// on input, so without this cap one whose client stops sending (a tab in the background) would
/// keep it on, hidden by Camouflage say, for as long as it's away.
const ABILITY_SLACK: f32 = 1.0;

/// Damage older than this doesn't count toward an assist (s).
const ASSIST_WINDOW: f32 = 15.0;

/// A projectile in flight and its owner's team, kept in case the owner leaves.
struct Flying {
    p: Projectile,
    team: u8,
}

enum Phase {
    /// A team match's opening: everyone held in their team's pen round its spawns
    /// (`Arena::penned`), shots doing no damage, until `until`; then it plays.
    Staging { until: u32 },
    Playing { started_at: u32 },
    /// Shots do no damage until the next match starts at `restart_at`.
    Ended { winner: Option<u8>, restart_at: u32 },
}

pub struct Game {
    /// Damage curves of one kit on another (class, primary, secondary each), for bots weighing
    /// fights: made as matchups come up, and kept.
    matchups: std::collections::HashMap<[u8; 6], crate::threat::Curve>,
    /// Tuning per class and loadout.
    arsenal: Arsenal,
    pub tick: u32,
    /// Fill empty slots with bots while at least one human is connected.
    pub bots: bool,
    /// Bots' skill, 0 (raw) to 1 (sharp): each bot's own spreads around it.
    pub bot_skill: f32,
    /// Each side's bots' skill adjustment for the pilots they face: up as pilots kill them, down
    /// as they kill pilots, fading back (`Tuning::bot_adapt_*`). Bots take it on as they respawn.
    adapt: [f32; 2],
    /// Plays on with bots alone and no human connected, for balance runs (`add_bot` seats them).
    pub headless: bool,
    pub mode: Mode,
    /// Team kills that win the match; in Deathmatch, as many solo kills' worth of points.
    pub score_limit: u16,
    pub match_seconds: f32,
    /// How long each team match opens penned in its spawns, to launch and get ready (0 for none).
    pub staging_seconds: f32,
    /// Index into `map::MAPS`; clients load the same map from their Welcome, and switch with
    /// the match state's.
    pub map: usize,
    /// Modes and maps to rotate through, dealt like a shuffled deck: each pair plays once before
    /// any repeats, never the same map twice in a row. Empty to stay on `mode` and `map`.
    pub rotation: Vec<(Mode, usize)>,
    /// The rest of the current deck.
    upcoming: Vec<(Mode, usize)>,
    next: (Mode, usize),
    /// xorshift64 state for shuffling the rotation.
    rng: u64,
    arena: Arena,
    nav: &'static Nav,
    /// Feet positions per team and slot, from the map.
    spawns: [Vec<Vector>; 2],
    /// The map's extra Deathmatch spawns.
    dm_spawns: Vec<Vector>,
    /// Where the map's objective modes play, and this match's objective state (Missile Assault's,
    /// Siege's, Capture the Flag's or Convoy's).
    spots: Objectives,
    assault: Option<Assault>,
    siege: Option<Siege>,
    ctf: Option<Ctf>,
    convoy: Option<Convoy>,
    defense: Option<Defense>,
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
        Self::with_arsenal(Arsenal::new(&tuning), map)
    }

    /// `new` with weapons and classes other than the compiled-in ones: a balance run's tweaks
    /// (`Arsenal::tweaked`).
    pub fn with_arsenal(arsenal: Arsenal, map: usize) -> Self {
        let data = Map::load(map);
        assert!(data.spawns.iter().all(|s| s.len() >= TEAM_SIZE), "map needs {TEAM_SIZE} spawns per team");
        Self {
            matchups: std::collections::HashMap::new(),
            map,
            mode: Mode::default(),
            rotation: Vec::new(),
            upcoming: Vec::new(),
            next: (Mode::default(), map),
            rng: 0x9E37_79B9_7F4A_7C15,
            arena: Arena::new(&data),
            nav: Nav::for_map(map),
            spawns: data.spawns.map(|team| team.iter().map(|p| Vector::from_array(*p)).collect()),
            dm_spawns: data.dm_spawns.iter().map(|p| Vector::from_array(*p)).collect(),
            spots: data.objectives,
            assault: None,
            siege: None,
            ctf: None,
            convoy: None,
            defense: None,
            arsenal,
            tick: 0,
            bots: true,
            bot_skill: 0.5,
            adapt: [0.0; 2],
            headless: false,
            score_limit: 20,
            match_seconds: 600.0,
            staging_seconds: 0.0,
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

    /// Adds a human to the team with fewer humans (in Deathmatch, anywhere), taking a bot's slot
    /// there if needed. None when every slot already holds a human.
    pub fn join(&mut self) -> Option<u8> {
        let humans = |team| self.players.iter().filter(|p| p.team == team && p.bot.is_none()).count();
        // In co-op, everyone's on the one team.
        let team = if self.mode != Mode::Defense && humans(1) < humans(0) { 1 } else { 0 };
        let dm = self.mode == Mode::Deathmatch;
        let full = if dm { self.players.len() >= MAX_PLAYERS } else { self.team_count(team) >= TEAM_SIZE };
        if full {
            let bot = self.players.iter().position(|p| (dm || p.team == team) && p.bot.is_some())?;
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

    /// A team with a place for a bot: in Deathmatch any free place (the bot's id picks its team),
    /// else the first team short of TEAM_SIZE.
    fn open_team(&self) -> Option<u8> {
        match self.mode {
            Mode::Deathmatch => (self.players.len() < MAX_PLAYERS).then_some(0),
            // Co-op: bots only fill out the pilots' team; the enemy is walkers.
            Mode::Defense => (self.team_count(0) < TEAM_SIZE).then_some(0),
            _ => (0..2).find(|&team| self.team_count(team) < TEAM_SIZE),
        }
    }

    fn add_player(&mut self, team: u8, mut bot: Option<Bot>, class: MechClass) -> Option<u8> {
        let id = (0..MAX_PLAYERS as u8).find(|id| !self.players.iter().any(|p| p.id == *id))?;
        let (team, slot) = match self.mode {
            Mode::Deathmatch => (id, usize::from(id)),
            _ => (team, (0..TEAM_SIZE).find(|s| !self.players.iter().any(|p| p.team == team && p.slot == *s))?),
        };
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
            mech: spawn(&self.arsenal, class, loadout, self.spawn_point(team, slot)),
            inputs: VecDeque::new(),
            credit: 0.0,
            ack_seq: 0,
            history: VecDeque::new(),
            kills: 0,
            deaths: 0,
            points: 0.0,
            eu: 0.0,
            respawn_at: None,
            launch: false,
            name: if bot.is_some() { BOT_NAMES[usize::from(id) % BOT_NAMES.len()].into() } else { format!("Pilot-{id:02}") },
            renamed_at: None,
            tally: Tally::default(),
            level: 0,
            ledger: Vec::new(),
            ability_until: 0,
            knock: None,
            bot,
        });
        self.roster_version += 1;
        Some(id)
    }

    /// Seats `bot` on `team` (in Deathmatch, its own) as `class`: a balance run's line-up.
    pub fn add_bot(&mut self, team: u8, bot: Bot, class: MechClass) -> Option<u8> {
        self.add_player(team, Some(bot), class)
    }

    /// Puts player `id` at `pos` facing `toward`, with `hull` of its health and no spawn shield: a
    /// drill's set-up.
    pub fn place(&mut self, id: u8, pos: Vector, toward: Vector, hull: f32) {
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
        let max = self.arsenal.of(&p.mech).health_max;
        let d = toward - pos;
        (p.mech.pos, p.mech.yaw, p.mech.pitch, p.mech.health, p.mech.shield) = (pos, libm::atan2f(-d.x, -d.z), 0.0, hull * max, 0.0);
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
            while self.bots
                && let Some(team) = self.open_team()
            {
                let seed = u64::from(self.tick) << 8 | self.players.len() as u64;
                let class = MechClass::ALL[(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 33) as usize % 3];
                self.add_player(team, Some(Bot::with_skill(seed, self.bot_skill)), class);
            }
        } else if !self.headless {
            if !self.players.is_empty() {
                self.players.clear();
                self.roster_version += 1;
            }
            self.start_match();
        }

        match self.phase {
            Phase::Staging { until } if self.tick >= until => {
                self.phase = Phase::Playing { started_at: self.tick };
                self.arena.penned = false;
            }
            // (A co-op run lasts its waves.)
            Phase::Playing { started_at } if self.mode != Mode::Defense && self.tick >= started_at + secs(self.match_seconds) => self.end_match(),
            Phase::Ended { restart_at, .. } if self.tick >= restart_at => {
                self.load_map(self.next.1);
                self.set_mode(self.next.0);
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
        // most hurt one it can see within twice its beam's reach, to mend all but a scratch off
        // (stopping at 80% left the torch idle between fights, its mates going in short).
        let alive = |p: &Player| p.mech.health > 0.0;
        let lead_of = |team: u8| {
            let mates = || self.players.iter().filter(move |p| p.team == team && alive(p));
            mates().find(|p| p.bot.is_none()).or_else(|| mates().min_by_key(|p| p.id)).map(|p| p.id)
        };
        // By team (in Deathmatch everyone's alone: no lead, no radio).
        let teams = 0..MAX_PLAYERS as u8;
        let leads: Vec<Option<u8>> = teams.clone().map(lead_of).collect();
        // What each player is fighting: a bot's target; for a pilot, the enemy it hit last, within
        // HUMAN_FOCUS (so bots focus on, back up and flank a pilot's fight as a bot's).
        let fighting = |p: &Player| match &p.bot {
            Some(b) => b.focus(),
            None => self
                .players
                .iter()
                .filter(|e| e.team != p.team)
                .filter_map(|e| e.ledger.iter().rev().find(|l| l.0 == p.id).map(|l| (e.id, l.2)))
                .filter(|&(_, at)| self.tick.saturating_sub(at) < secs(HUMAN_FOCUS))
                .max_by_key(|&(_, at)| at)
                .map(|(id, _)| id),
        };
        let fights: Vec<Option<u8>> = self.players.iter().map(fighting).collect();
        let engaged: Vec<Vec<u8>> = teams.map(|team| self.players.iter().zip(&fights).filter(|(p, _)| p.team == team).filter_map(|(_, f)| *f).collect()).collect();
        // First every bot looks and listens...
        let mut seen: Vec<(Option<u8>, Vec<(u8, Mech, f32)>)> = Vec::with_capacity(self.players.len());
        let mut radio: Vec<Vec<(u8, u8, Vector)>> = vec![Vec::new(); MAX_PLAYERS]; // (from, enemy, where)
        // Objectives to take or hold, in Missile Assault, Siege, Capture the Flag and Convoy.
        let hauler = self.deployables.iter().find(|d| d.kind == Kind::Hauler).map(|d| d.pos);
        // Each team's bots take their jobs as its first bot's policy says.
        let plans = [0, 1].map(|team| self.players.iter().filter(|p| p.team == team).find_map(|p| p.bot.as_ref()).map(|b| &b.policy));
        let orders = match (&self.assault, &self.siege, &self.ctf, self.convoy.as_ref().zip(hauler)) {
            (Some(a), ..) => {
                // As many silos at once as its policy says.
                let spread = plans.map(|p| p.map_or(usize::MAX, |p| p.assault_spread.round().max(1.0) as usize));
                Some(a.orders_spread(&self.players.iter().map(|p| (p.team, p.mech.pos, p.bot.is_some(), p.mech.health > 0.0)).collect::<Vec<_>>(), spread))
            }
            (_, Some(s), ..) => {
                let ships = [0, 1].map(|t| self.deployables.iter().any(|d| d.kind == Kind::Ship && d.team == t));
                let crews = plans.map(|p| p.map_or_else(siege::Crew::default, Policy::siege_crew));
                Some(s.orders_by(&self.players.iter().map(|p| (p.team, p.mech.pos, p.bot.is_some(), p.eu)).collect::<Vec<_>>(), ships, crews))
            }
            (_, _, Some(c), _) => {
                let squads = plans.map(|p| p.map_or_else(ctf::Squads::default, Policy::ctf_squads));
                Some(c.orders_by(&self.players.iter().map(|p| (p.id, p.team, p.mech.pos, p.bot.is_some() && p.mech.health > 0.0)).collect::<Vec<_>>(), squads))
            }
            (.., Some((c, at))) => {
                let escorts = plans.map(|p| p.map_or_else(convoy::Escort::default, Policy::convoy_escort));
                Some(c.orders_by(&self.players.iter().map(|p| (p.team, p.mech.pos, p.bot.is_some(), p.mech.health > 0.0)).collect::<Vec<_>>(), at, escorts))
            }
            _ => self.defense.as_ref().map(|d| {
                let walkers: Vec<Vector> = self.deployables.iter().filter(|w| w.kind.lane_enemy()).map(|w| w.pos).collect();
                d.orders(&self.players.iter().map(|p| (p.id, p.team, p.bot.is_some() && p.mech.health > 0.0)).collect::<Vec<_>>(), &walkers)
            }),
        };
        // The bots' skill adjustments fade back to none.
        let fade = libm::expf(-DT / self.arsenal.get(MechClass::B, Loadout::of(MechClass::B)).bot_adapt_s.max(1.0));
        self.adapt = self.adapt.map(|a| a * fade);
        // Each side's hull over the other's, in mechs' worth (two sides only; in Deathmatch, none).
        let hull = |team: u8| self.players.iter().filter(|p| p.team == team && alive(p)).map(|p| p.mech.health / self.arsenal.of(&p.mech).health_max).sum::<f32>();
        let mut edge = [0.0; MAX_PLAYERS];
        if self.mode != Mode::Deathmatch {
            let (a, b) = (hull(0), hull(1));
            (edge[0], edge[1]) = (a - b, b - a);
        }
        // Each side's flag carrier's feet (Capture the Flag): a bot ordered there escorts it.
        let mut carriers = [None; MAX_PLAYERS];
        if let Some(c) = &self.ctf {
            for p in self.players.iter().filter(|p| c.carried_by(p.id).is_some()) {
                carriers[usize::from(p.team)] = Some(p.mech.pos);
            }
        }
        let mut matchups = std::mem::take(&mut self.matchups);
        // Which enemies have a clear line to which players (eye to middle, within their weapons'
        // reach): for bots weighing how an enemy's fire is split.
        let up = |q: &Player| q.mech.health > 0.0 && q.respawn_at.is_none();
        let mut lines: Vec<(u8, u8)> = Vec::new();
        for q in self.players.iter().filter(|q| up(q)) {
            let tq = self.arsenal.of(&q.mech);
            let eye = q.mech.pos + Vector::Y * tq.eye_height;
            for m in self.players.iter().filter(|m| m.team != q.team && up(m)) {
                let mid = m.mech.pos + Vector::Y * (self.arsenal.of(&m.mech).mech_height * 0.5);
                let d = mid - eye;
                if d.length() <= tq.weapon_range && self.arena.cast_ray(&Ray::new(eye, d / d.length()), d.length()).is_none() {
                    lines.push((q.id, m.id));
                }
            }
        }
        for i in 0..self.players.len() {
            let me = &self.players[i];
            if me.bot.is_none() {
                seen.push((None, Vec::new()));
                continue;
            }
            let t = self.arsenal.of(&me.mech);
            let hurt = |q: &Player| q.mech.health / self.arsenal.of(&q.mech).health_max;
            let mut enemies: Vec<(u8, Mech, f32)> = self
                .players
                .iter()
                .filter(|q| q.team != me.team && q.mech.health > 0.0 && q.mech.shield <= 0.0 && !cloaked(q))
                .map(|q| (q.id, q.mech, hurt(q)))
                .collect();
            // The other side's turrets too, each as a mech to fight (by its lock-on id), set so
            // the bot's chest-high aim lands on its body.
            let sizes = items(&self.arsenal);
            // Convoy's hauler only while the other side's walking it at us.
            let pushed_at_us = self.convoy.as_ref().is_some_and(|c| c.pusher == Some(1 - me.team));
            let foe = |d: &&Deployable| (d.kind.shootable() && d.kind != Kind::Hauler) || (d.kind == Kind::Hauler && pushed_at_us);
            enemies.extend(self.deployables.iter().filter(|d| d.hull > 0.0 && d.team != me.team).filter(foe).map(|d| {
                let at = deploy::center(sizes, d) - Vector::Y * (t.mech_height * 0.5);
                let full = match d.kind {
                    Kind::Sentry => SENTRY_SHIELD,
                    Kind::Hauler => convoy::SHIELD,
                    Kind::Walker | Kind::Crawler | Kind::Brute | Kind::Mortar | Kind::Node | Kind::Excavator | Kind::Hive => defense::hull(d.kind, defense::WAVES),
                    Kind::Arc | Kind::Pulse => defense::tower_hull(defense::TIERS),
                    _ => sizes.turret_hull,
                };
                (deploy::target_id(d), Mech { pos: at, health: d.hull, ..Mech::default() }, d.hull / full)
            }));
            // The kits of the enemies about (players, not turrets): each one's damage on it, and
            // its on them, by range.
            let kit = |m: &Mech| [m.class.index() as u8, m.loadout.primary, m.loadout.secondary];
            let mut curve = |a: &Mech, b: &Mech| {
                let key = [kit(a), kit(b)].concat().try_into().expect("six");
                *matchups.entry(key).or_insert_with(|| crate::threat::Curve::of(self.arsenal.of(a), self.arsenal.of(b)))
            };
            let foes: Vec<bot::FoeKit> = enemies
                .iter()
                .filter_map(|&(id, _, _)| self.players.iter().find(|q| q.id == id))
                .map(|q| {
                    let theirs = self.arsenal.of(&q.mech);
                    let watching = lines.iter().filter(|&&(from, to)| from == q.id && to != me.id).count() as u8;
                    bot::FoeKit { id: q.id, on_me: curve(&q.mech, &me.mech), mine: curve(&me.mech, &q.mech), hull: theirs.health_max, eye: theirs.eye_height, mid: theirs.mech_height * 0.5, watching }
                })
                .collect();
            let mates: Vec<(Vector, Option<u8>)> = self.players.iter().zip(&fights).filter(|(q, _)| q.team == me.team && q.id != me.id && up(q)).map(|(q, f)| (q.mech.pos, *f)).collect();
            let (team, id) = (usize::from(me.team), me.id);
            let p = &mut self.players[i];
            let bot = p.bot.as_mut().expect("checked above");
            bot.foes = foes;
            bot.mates = mates;
            bot.engaged.clone_from(&engaged[team]);
            bot.smoke.clone_from(&self.clouds);
            bot.team = p.team;
            bot.shields.clear();
            bot.shields.extend(self.deployables.iter().filter(|d| matches!(d.kind, Kind::Dome | Kind::Barrier)));
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
            let mid = |q: &Player| self.arsenal.of(&q.mech).mech_height * 0.5;
            let heal = (t.alt_beam > 0.0)
                .then(|| {
                    mates()
                        .filter(|q| hurt(q) < 0.97)
                        .filter(|q| q.mech.pos.distance(me.mech.pos) < 2.0 * t.alt_beam && bot::sees_at(&self.arena, t, &me.mech, q.mech.pos + Vector::Y * mid(q)))
                        // A pilot first, as if a little worse hurt than it is.
                        .min_by(|a, b| (hurt(a) - if a.bot.is_none() { HUMAN_HEAL } else { 0.0 }).total_cmp(&(hurt(b) - if b.bot.is_none() { HUMAN_HEAL } else { 0.0 })))
                        .map(|q| (q.mech, mid(q)))
                })
                .flatten();
            // A torch follows the nearest teammate without one (so two torches don't hold on each
            // other), and the lead follows no one (so the team doesn't hold on itself).
            let dist = |q: &&Player| q.mech.pos.distance(me.mech.pos);
            let torch = |q: &Player| self.arsenal.of(&q.mech).alt_beam > 0.0;
            let lead = leads[usize::from(me.team)]
                .filter(|&l| l != me.id)
                .and_then(|l| torch(me).then(|| mates().filter(|q| !torch(q)).min_by(|a, b| dist(a).total_cmp(&dist(b)))).flatten().or_else(|| mates().find(|q| q.id == l)))
                .map(|q| q.mech.pos);
            let team = usize::from(me.team);
            // Whether an enemy stands in the blast of its limpet, if it has one down.
            let reach = items(&self.arsenal).limpet_radius;
            let limpet_hits = me.mech.limpet
                && self.projectiles.iter().filter(|f| f.p.owner == me.id && projectile::item(&f.p) == Some(Item::Limpet)).any(|f| {
                    self.players.iter().any(|q| q.team != me.team && q.mech.health > 0.0 && (q.mech.pos + Vector::Y * (self.arsenal.of(&q.mech).mech_height * 0.5)).distance(f.p.pos) < reach)
                });
            let mates_near = self.players.iter().filter(|q| q.team == me.team && q.id != me.id && alive(q) && q.mech.pos.distance(me.mech.pos) < bot::MATES_NEAR).count() as u8;
            let p = &mut self.players[i];
            let bot = p.bot.as_mut().expect("checked above");
            bot.mates_near = mates_near;
            for &(from, enemy, at) in &radio[team] {
                if from != p.id {
                    bot.told(enemy, at, self.tick);
                }
            }
            bot.lead = lead;
            bot.edge = edge[team];
            bot.adapt = self.adapt.get(team).copied().unwrap_or(0.0);
            bot.order = orders.as_ref().and_then(|o| o[i]);
            bot.ward = carriers[team].filter(|&at| bot.order == Some(at));
            // The zone that order is in, if it's one to hold.
            let zones = self.assault.iter().flat_map(|a| a.silos.iter()).chain(self.siege.iter().flat_map(|s| std::iter::once(&s.aa).chain(s.stations.iter().map(|(z, _)| z))));
            bot.order_zone = bot.order.and_then(|o| zones.clone().find(|z| z.holds(o))).map(|z| crate::tactics::Hold { at: z.at, radius: z.radius, band: z.band });
            bot.limpet_hits = limpet_hits;
            bot.orbs.clear();
            bot.orbs.extend(self.orbs.iter().filter(|o| o.dropped.is_none_or(|(_, side)| usize::from(side) == team)).map(|o| o.pos));
            let (focus, enemies) = &seen[i];
            let target = focus.and_then(|id| enemies.iter().find(|e| e.0 == id)).map(|e| e.1);
            let mut input = if matches!(self.phase, Phase::Staging { .. }) {
                // Penned in for the opening: it waits facing the other side, and sets off as the pens open.
                bot.stand_by(t, &p.mech, self.arena.pens[1 - team].0)
            } else {
                let input = bot.think_with(&self.arena, self.nav, t, &p.mech, target.as_ref(), heal.as_ref().map(|(m, mid)| (m, *mid)), self.tick);
                if p.mech.health > 0.0 {
                    p.tally.doing[bot.doing() as usize] += 1;
                }
                input
            };
            #[cfg(test)]
            {
                bot.last = input;
            }
            // Burst a shell that has flown past the target with the target inside its blast, and a
            // splitting one as soon as any enemy it knows of (in view or not) is inside it: left to
            // reach them, it would burst on contact, whole, without its bomblets. Pressed now, it
            // still splits if it hits them in this tick's flight.
            input.alt_fire |= self.projectiles.iter().filter(|f| f.p.owner == p.id && projectile::armed(&f.p)).any(|f| {
                let ts = self.arsenal.get(f.p.class, f.p.loadout);
                let inside = |tm: &Mech| projectile::splash(&self.arena, ts, false, f.p.pos, self.arsenal.of(tm), tm) > 0.0;
                if ts.alt_split >= 1.0 {
                    enemies.iter().any(|e| bot.knows(e.0) && inside(&e.1))
                } else {
                    target.as_ref().is_some_and(|tm| f.p.vel.dot(tm.pos + Vector::Y * (self.arsenal.of(tm).mech_height * 0.5) - f.p.pos) < 0.0 && inside(tm))
                }
            });
            bot.seq += 1;
            p.inputs.push_back(InputMsg { seq: bot.seq, input, view_tick: self.tick as f32 });
        }
        self.matchups = matchups;

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
                let was = p.mech.ability_time;
                let (ready, beamed) = (p.mech.ability_cooldown <= 0.0, p.mech.beaming);
                step_mech(&self.arena, t, &mut p.mech, &msg.input);
                // A beam's use is its start; an ability's starts its cooldown (a Power shot can be
                // used and spent in a tick).
                let used = [p.mech.shot, p.mech.launched || p.mech.beaming && !beamed, p.mech.threw, p.mech.pulsed, ready && p.mech.ability_cooldown > 0.0];
                for (n, used) in p.tally.uses.iter_mut().zip(used) {
                    *n += u32::from(used);
                }
                if p.mech.launched && t.alt_melee > 0.0 {
                    // At foes where its client saw them, its newest snapshot's, as it predicted the lunge.
                    let (mut m, team) = (p.mech, p.team);
                    let seen = (msg.view_tick + crate::client::INTERP_TICKS).min(self.tick as f32);
                    let foes: Vec<Mech> = self.players.iter().filter(|q| q.team != team).filter_map(|q| Some(Mech { pos: rewind(&q.history, seen)?, ..q.mech })).collect();
                    melee::lunge(&self.arena, t, &mut m, foes.iter().map(|q| (self.arsenal.of(q), q)));
                    self.players[i].mech = m;
                }
                let p = &mut self.players[i];
                if p.mech.ability_time > was {
                    p.ability_until = self.tick + secs(p.mech.ability_time + ABILITY_SLACK);
                }
                if p.mech.alt_pressed {
                    projectile::detonate(p.id, self.projectiles.iter_mut().map(|f| &mut f.p));
                }
                let mut shells = Vec::new();
                if p.mech.launched && t.alt_melee <= 0.0 {
                    projectile::cap(t, p.id, self.projectiles.iter_mut().map(|f| &mut f.p));
                    shells = projectile::volley(t, &p.mech, p.id, msg.seq);
                }
                if p.mech.shot && t.shot_speed > 0.0 {
                    shells.extend(weapon::volley(t, &p.mech, p.id, msg.seq));
                }
                if p.mech.threw && Item::of(p.mech.loadout, true).thrown() {
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
                if self.players[i].mech.threw {
                    match Item::of(self.players[i].mech.loadout, true) {
                        Item::MgTurret => self.deploy(i, Kind::MgTurret),
                        Item::RocketTurret => self.deploy(i, Kind::RocketTurret),
                        _ => {}
                    }
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
                let t = self.arsenal.of(&self.players[i].mech);
                if t.alt_lock_time > 0.0 || t.shot_turn > 0.0 {
                    let team = self.players[i].team;
                    let mut chests = self.chests(|q| q.team != team && !cloaked(q));
                    chests.extend(deploy::targets(&self.deployables, items(&self.arsenal), |d| d.team != team));
                    let t = self.arsenal.of(&self.players[i].mech).clone();
                    projectile::track(&self.arena, &t, &mut self.players[i].mech, &chests);
                    projectile::seek(&self.arena, &t, &mut self.players[i].mech, &chests);
                }
                if self.players[i].mech.strike > 0.0 {
                    self.strike(i, msg.view_tick);
                }
                self.slam(i);
            }
        }

        for p in &mut self.players {
            if self.tick > p.ability_until {
                p.mech.ability_time = 0.0;
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
        // And the hauler and co-op's walkers block them all, unmoved.
        for d in self.deployables.iter().filter(|d| d.kind == Kind::Hauler || (d.kind.lane_enemy() && d.hull > 0.0)) {
            let (th, mut body) = deploy::as_mech(items(&self.arsenal), d);
            for p in &mut self.players {
                collide::separate(&self.arena, self.arsenal.of(&p.mech), &mut p.mech, &th, &mut body, 1.0);
            }
        }

        self.tend_sentries();
        self.man_turrets();

        // Projectiles fly once everyone has moved, against enemies where they stand now, and
        // their shields and turrets.
        // ponytail: no rewind, so shooters lead by their ping; fast-forward new projectiles by
        // half the shooter's RTT if hits feel late.
        let mut flying = std::mem::take(&mut self.projectiles);
        let (mut bursts, mut pierced) = (Vec::new(), Vec::new());
        let sizes = items(&self.arsenal);
        let mut chests = self.chests(|q| !cloaked(q));
        chests.extend(deploy::targets(&self.deployables, sizes, |_| true));
        flying.retain_mut(|f| {
            let enemies = || {
                self.players
                    .iter()
                    .filter(|q| q.team != f.team && q.mech.health > 0.0)
                    .map(|q| (self.arsenal.of(&q.mech), &q.mech))
            };
            let t = projectile::tuning_for(self.arsenal.get(f.p.class, f.p.loadout), &f.p);
            // A seeking primary's shots go for whatever its owner marks now.
            if f.p.primary && t.shot_turn > 0.0 {
                f.p.target = self.players.iter().find(|q| q.id == f.p.owner).map_or(0, |q| q.mech.seek);
            }
            if let Some(&(_, goal)) = chests.iter().find(|(id, _)| f.p.target == id + 1) {
                projectile::home(&t, &mut f.p, goal);
            }
            // A piercing shell passes the domes and barriers in its way, wearing each it goes into.
            let (pierce, owner) = (!f.p.primary && t.alt_pierce > 0.5, f.p.owner);
            let burst = projectile::fly(&self.arena, &t, &mut f.p, |ray, max| {
                let dome = deploy::stops(&self.deployables, sizes, ray, max);
                let turret = deploy::first_turret(&self.deployables, sizes, f.team, ray, if pierce { max } else { dome.unwrap_or(max) }).map(|(_, toi)| toi);
                if pierce {
                    let reach = turret.unwrap_or(max);
                    let mech = projectile::first_mech(ray, reach, enemies());
                    pierced.extend(deploy::pierced(&self.deployables, sizes, f.team, ray, mech.unwrap_or(reach)).map(|k| (k, t.alt_damage, owner)));
                    return mech.or(turret);
                }
                let max = turret.or(dome).unwrap_or(max);
                projectile::first_mech(ray, max, enemies()).or(turret).or(dome)
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
        for (k, damage, owner) in pierced {
            self.wear(k, damage, owner);
        }
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
        // A base gun or the hauler shot through stays, offline or stalled.
        self.deployables.retain(|d| tick < d.expires && (d.hull > 0.0 || matches!(d.kind, Kind::Sentry | Kind::Hauler)));
        if self.deployables.len() != deployed {
            self.arena.set_barriers(items(&self.arsenal), &self.deployables);
        }

        // Objectives are set out from the opening (nobody can reach them from the pens).
        if !matches!(self.phase, Phase::Ended { .. }) {
            self.step_objectives();
        }

        for p in &mut self.players {
            p.history.push_back((self.tick, p.mech.pos, p.mech.health > 0.0));
            if p.history.len() > HISTORY_TICKS {
                p.history.pop_front();
            }
        }
    }

    /// Fresh scores and objectives, and everyone back at their team spawn with full health. A new
    /// game's first match opens this way once it's set up (a team match's staging with it).
    pub fn start_match(&mut self) {
        self.scores = [0; 2];
        self.assault = None;
        self.siege = None;
        self.ctf = None;
        self.convoy = None;
        self.defense = None;
        self.projectiles.clear();
        self.orbs.clear();
        self.clouds.clear();
        self.deployables.clear();
        self.arena.set_barriers(items(&self.arsenal), &[]);
        self.phase = match self.mode {
            // (Co-op opens with its own break to get ready in, building.)
            Mode::Deathmatch | Mode::Defense => Phase::Playing { started_at: self.tick },
            _ if self.staging_seconds <= 0.0 => Phase::Playing { started_at: self.tick },
            _ => Phase::Staging { until: self.tick + secs(self.staging_seconds) },
        };
        self.arena.penned = matches!(self.phase, Phase::Staging { .. });
        let starts = self.start_points();
        for (p, start) in self.players.iter_mut().zip(starts) {
            (p.class, p.loadout) = (p.next_class, p.next_loadout);
            p.mech = spawn(&self.arsenal, p.class, p.loadout, start);
            if let Some(bot) = &mut p.bot {
                bot.respawned();
            }
            p.respawn_at = None;
            p.kills = 0;
            p.deaths = 0;
            p.points = 0.0;
            p.eu = 0.0;
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
        let winner = match self.mode {
            Mode::TeamDeathmatch => match self.scores[0].cmp(&self.scores[1]) {
                std::cmp::Ordering::Greater => Some(0),
                std::cmp::Ordering::Less => Some(1),
                std::cmp::Ordering::Equal => None,
            },
            Mode::Deathmatch => match self.standings()[..] {
                [a, b, ..] if (a.points, a.kills) == (b.points, b.kills) => None,
                [a, ..] => Some(a.team),
                [] => None,
            },
            // The base with more hull left (the other one's fallen, or the clock ran out).
            Mode::MissileAssault | Mode::Siege => self.base_hull().and_then(|[a, b]| match a.total_cmp(&b) {
                std::cmp::Ordering::Greater => Some(0),
                std::cmp::Ordering::Less => Some(1),
                std::cmp::Ordering::Equal => None,
            }),
            // Delivered, or pushed further when time ran out.
            Mode::Convoy => self.convoy.as_ref().and_then(Convoy::leader),
            // The pilots, holding through the last wave; the walkers, with the reactor down.
            Mode::Defense => self.defense.as_ref().and_then(|d| match d.stage {
                defense::Stage::Won => Some(0),
                _ if d.hull <= 0.0 => Some(1),
                _ => None,
            }),
            Mode::CaptureTheFlag => self.ctf.as_ref().and_then(|c| match c.captures[0].cmp(&c.captures[1]) {
                std::cmp::Ordering::Greater => Some(0),
                std::cmp::Ordering::Less => Some(1),
                std::cmp::Ordering::Equal => None,
            }),
        };
        self.phase = Phase::Ended { winner, restart_at: self.tick + secs(POST_MATCH_SECONDS) };
        // The next match comes off the deck: the top card for another map than this one (an empty
        // deck shuffled anew, or a fresh one under the last cards if they're all this map).
        // Without a rotation, it's this mode and map again.
        if self.rotation.len() <= 1 {
            self.next = (self.mode, self.map);
        } else {
            let map = self.map;
            let other = |deck: &[(Mode, usize)]| deck.iter().rposition(|&(_, m)| m != map);
            // (With one map in the rotation there's no other to find: just deal on.)
            if other(&self.upcoming).is_none() && (self.upcoming.is_empty() || self.rotation.iter().any(|&(_, m)| m != map)) {
                let mut deck = self.shuffled(self.rotation.clone());
                deck.append(&mut self.upcoming);
                self.upcoming = deck;
            }
            let i = other(&self.upcoming).unwrap_or(self.upcoming.len() - 1);
            self.next = self.upcoming.remove(i);
        }
    }

    /// The bases' hull, in the modes with bases.
    fn base_hull(&self) -> Option<[f32; 2]> {
        self.assault.as_ref().map(|a| a.hull).or(self.siege.as_ref().map(|s| s.hull))
    }

    /// Players best first: by points, then kills.
    fn standings(&self) -> Vec<&Player> {
        let mut by_rank: Vec<&Player> = self.players.iter().collect();
        by_rank.sort_by(|a, b| b.points.total_cmp(&a.points).then(b.kills.cmp(&a.kills)));
        by_rank
    }

    /// Rotates through `matches` (modes and maps) from here on, shuffling with `seed`. The first
    /// deck leaves out the current pair, so every pair has played before any comes round again.
    pub fn rotate(&mut self, matches: Vec<(Mode, usize)>, seed: u64) {
        self.rng = seed | 1;
        let now = (self.mode, self.map);
        self.upcoming = self.shuffled(matches.iter().copied().filter(|&m| m != now).collect());
        self.rotation = matches;
    }

    /// Switches to `mode` between matches, putting everyone on teams for it if it's to or from
    /// Deathmatch: there each their own; else humans in turn over the two teams, where bots fill in
    /// round them.
    fn set_mode(&mut self, mode: Mode) {
        let regroup = (mode == Mode::Deathmatch) != (self.mode == Mode::Deathmatch);
        self.mode = mode;
        if !regroup {
            return;
        }
        self.players.retain(|p| p.bot.is_none());
        for (i, p) in self.players.iter_mut().enumerate() {
            (p.team, p.slot) = match mode {
                Mode::Deathmatch => (p.id, usize::from(p.id)),
                _ => ((i % 2) as u8, i / 2),
            };
        }
        self.roster_version += 1;
    }

    /// `deck` in a random order (Fisher-Yates, on the xorshift64 state).
    fn shuffled(&mut self, mut deck: Vec<(Mode, usize)>) -> Vec<(Mode, usize)> {
        for i in (1..deck.len()).rev() {
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 7;
            self.rng ^= self.rng << 17;
            deck.swap(i, (self.rng % (i as u64 + 1)) as usize);
        }
        deck
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
        self.dm_spawns = data.dm_spawns.iter().map(|p| Vector::from_array(*p)).collect();
        self.spots = data.objectives;
        for p in &mut self.players {
            p.history.clear();
        }
    }

    /// Where slot `slot` of `team` joins a match: its own spawn, or in Deathmatch, a respawn's.
    fn spawn_point(&self, team: u8, slot: usize) -> Vector {
        match self.mode {
            Mode::Deathmatch => self.respawn_point(team),
            _ => self.spawns[usize::from(team)][slot],
        }
    }

    /// Where each player starts a match: on their slot's spawn, or in Deathmatch, each in turn on
    /// the spawn farthest from everyone placed before them.
    fn start_points(&self) -> Vec<Vector> {
        let mut placed = Vec::new();
        for p in &self.players {
            placed.push(match self.mode {
                Mode::Deathmatch => farthest(self.dm_pool(), &placed),
                _ => self.spawns[usize::from(p.team)][p.slot],
            });
        }
        placed
    }

    /// The spawn (the team's; in Deathmatch, any) farthest from the nearest living enemy.
    fn respawn_point(&self, team: u8) -> Vector {
        let foes: Vec<Vector> = self.players.iter().filter(|p| p.team != team && p.mech.health > 0.0).map(|p| p.mech.pos).collect();
        match self.mode {
            Mode::Deathmatch => farthest(self.dm_pool(), &foes),
            _ => farthest(self.spawns[usize::from(team)].iter().copied(), &foes),
        }
    }

    /// Deathmatch's spawns: both teams' and the map's own.
    fn dm_pool(&self) -> impl Iterator<Item = Vector> + '_ {
        self.spawns.iter().flatten().chain(&self.dm_spawns).copied()
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
        let (mut hits, mut wrecks) = (Vec::new(), Vec::new());
        for ray in weapon::pellets(t, m, seq) {
            let wall = self.arena.cast_ray(&ray, t.weapon_range).unwrap_or(t.weapon_range);
            let mut best = deploy::stops(&self.deployables, t, &ray, wall).unwrap_or(wall);
            let mut hit = None;
            for (j, pose, shape) in &targets {
                if let Some(toi) = shape.cast_ray(pose, &ray, best, true) {
                    best = toi;
                    hit = Some(*j);
                }
            }
            let turret = deploy::first_turret(&self.deployables, t, team, &ray, best);
            if let Some((_, toi)) = turret {
                (best, hit) = (toi, None);
            }
            let worn = worn(&self.deployables, t, team, turret, hit.is_some(), ray.point_at(best));
            // After the match ends shots still fly, but don't hit anyone.
            let hit = hit.filter(|_| matches!(self.phase, Phase::Playing { .. }));
            self.events.push(Event::Shot { shooter: shooter_id, end: ray.point_at(best), hit: hit.map(|j| self.players[j].id) });
            let damage = t.shot_damage * weapon::power(t, m.shot_charge) * weapon::falloff(t, best) * ability::damage_mult(t, m);
            hits.extend(hit.map(|j| (j, damage)));
            wrecks.extend(worn.map(|k| (k, damage)));
        }
        let cause = Cause::Weapon { slot: Slot::Primary, index: m.loadout.primary };
        for (j, damage) in hits {
            self.apply_damage_by(Some(shooter), j, damage, cause);
        }
        for (k, damage) in wrecks {
            self.wear(k, damage, shooter_id);
        }
    }

    /// Player `i`'s melee strike while it can land (`Mech::strike`): the nearest enemy it reaches,
    /// as it saw them (rewound to `view_tick`, as for shots), takes the blow and is thrown along
    /// its facing; a strike lands once.
    fn strike(&mut self, i: usize, view_tick: f32) {
        let (striker, team, striker_id) = (self.players[i].mech, self.players[i].team, self.players[i].id);
        if striker.health <= 0.0 {
            self.players[i].mech.strike = 0.0;
            return;
        }
        let t = self.arsenal.of(&striker);
        let view = view_tick.clamp(self.tick as f32 - MAX_REWIND_TICKS, self.tick as f32);
        let nearest = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, q)| q.team != team && q.mech.shield <= 0.0)
            .filter_map(|(j, q)| {
                let then = Mech { pos: rewind(&q.history, view)?, ..q.mech };
                Some((j, melee::reaches(&self.arena, t, &striker, self.arsenal.of(&q.mech), &then)?))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1));
        let Some((j, _)) = nearest.filter(|_| matches!(self.phase, Phase::Playing { .. })) else { return };
        // As wound and boosted when it was let go.
        let damage = t.alt_damage * melee::power(t, striker.strike_charge) * ability::damage_mult(t, &Mech { boosted: striker.strike_boosted, ..striker });
        let tv = self.arsenal.of(&self.players[j].mech);
        let (juggled, index) = (self.players[j].knock.is_some_and(|k| self.tick < k.until), striker.loadout.secondary);
        let speed = melee::throw_speed(t, striker.strike_charge, tv.mech_mass) * if juggled { 0.5 } else { 1.0 };
        let until = self.tick + secs(melee::KNOCK_SECONDS);
        let chest = self.players[j].mech.pos + Vector::Y * (tv.mech_height * 0.5);
        self.players[i].mech.strike = 0.0;
        let victim = &mut self.players[j];
        melee::throw(&mut victim.mech, melee::facing(&striker), speed);
        victim.knock = Some(Knock { by: striker_id, index, until, slammed: false });
        self.events.push(Event::Strike { owner: striker_id, hit: victim.id, pos: chest });
        self.apply_damage_by(Some(i), j, damage, Cause::Weapon { slot: Slot::Secondary, index });
    }

    /// Player `i`, thrown by a strike lately, hitting a wall hard while still riding the throw:
    /// the slam hurts it, as a blow from whoever threw it.
    fn slam(&mut self, i: usize) {
        let p = &self.players[i];
        let Some(k) = p.knock.filter(|k| !k.slammed && self.tick < k.until) else { return };
        if p.mech.slam <= melee::SLAM_SPEED {
            // Down, or out of the throw's arc another way, with no wall: no slam from it later.
            if !p.mech.pad_arc {
                self.players[i].knock = Some(Knock { slammed: true, ..k });
            }
            return;
        }
        let damage = (p.mech.slam - melee::SLAM_SPEED) * melee::SLAM_DAMAGE;
        let (id, pos) = (p.id, p.mech.pos + Vector::Y * (self.arsenal.of(&p.mech).mech_height * 0.5));
        self.players[i].knock = Some(Knock { slammed: true, ..k });
        self.events.push(Event::Strike { owner: k.by, hit: id, pos });
        let by = self.players.iter().position(|q| q.id == k.by);
        self.apply_damage_by(by, i, damage, Cause::Weapon { slot: Slot::Secondary, index: k.index });
    }

    /// Splash from projectile `p` (fired by `team`) bursting at `at` (or smoke, from a Pall), and
    /// its Blast event.
    fn burst(&mut self, p: Projectile, team: u8, at: Vector) {
        let t = projectile::tuning_for(self.arsenal.get(p.class, p.loadout), &p);
        if projectile::item(&p) == Some(Item::Smoke) {
            self.clouds.push(Cloud { pos: at, radius: t.smoke_radius, fades_at: self.tick + secs(t.smoke_seconds) });
        }
        // A dome shields what's on the far side of its surface from a burst, as a wall would.
        let shielded = |q: &Player| {
            let to = q.mech.pos + Vector::Y * (self.arsenal.of(&q.mech).mech_height * 0.5) - at;
            deploy::stops(&self.deployables, &t, &Ray::new(at, to.normalize_or_zero()), to.length()).is_some()
        };
        let hurt: Vec<(usize, f32)> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, q)| q.team != team && q.mech.health > 0.0 && !shielded(q))
            .map(|(j, q)| (j, projectile::splash(&self.arena, &t, p.primary, at, self.arsenal.of(&q.mech), &q.mech)))
            .filter(|&(_, damage)| damage > 0.0)
            .collect();
        // The other side's deployables in reach take it too: turrets (but not through a dome), and
        // domes and barriers by how near their surface it burst.
        // ponytail: a dome or barrier takes it through a wall too; the blast's only a few metres.
        let sizes = items(&self.arsenal);
        let domed = |d: &Deployable| {
            let to = deploy::gun(sizes, d) - at;
            deploy::stops(&self.deployables, sizes, &Ray::new(at, to.normalize_or_zero()), to.length()).is_some()
        };
        // A piercing shell wore the domes and barriers it went through already.
        let pierce = !p.primary && t.alt_pierce > 0.5;
        let wrecks: Vec<(usize, f32)> = (self.deployables.iter().enumerate())
            .filter(|(_, d)| d.team != team && d.hull > 0.0 && !(pierce && matches!(d.kind, Kind::Dome | Kind::Barrier)))
            .map(|(k, d)| {
                let damage = if matches!(d.kind, Kind::Dome | Kind::Barrier) {
                    projectile::blast(&t, p.primary, deploy::gap(sizes, d, at))
                } else if !d.kind.shootable() || domed(d) {
                    0.0
                } else {
                    let (tm, m) = deploy::as_mech(sizes, d);
                    projectile::splash(&self.arena, &t, p.primary, at, &tm, &m)
                };
                (k, damage)
            })
            .filter(|&(_, damage)| damage > 0.0)
            .collect();
        for (k, damage) in wrecks {
            self.wear(k, damage, p.owner);
        }
        let attacker = self.players.iter().position(|q| q.id == p.owner);
        let cause = if p.n == projectile::TURRET && !p.primary {
            Cause::Weapon { slot: Slot::Offensive, index: Item::RocketTurret.index() }
        } else {
            let slot = if projectile::item(&p).is_some() { Slot::Offensive } else { Slot::weapon(p.primary) };
            Cause::Weapon { slot, index: p.loadout.get(slot) }
        };
        let mut hits = 0;
        for (j, damage) in hurt {
            if matches!(self.phase, Phase::Playing { .. }) {
                hits |= 1 << self.players[j].id;
                self.apply_damage_by(attacker, j, damage, cause);
            }
        }
        self.events.push(Event::Blast { owner: p.owner, seq: p.seq, n: p.n, primary: p.primary, class: p.class, loadout: p.loadout, charge: p.charge, boosted: p.boosted, pos: at, hits });
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
        let orb = Orb { pos: self.orb_spot(u.mech.pos), health: self.arsenal.of(&u.mech).orb_health, fades_at: self.tick + secs(ORB_SECONDS), dropped: Some((u.id, u.team)) };
        self.orbs.push(orb);
    }

    /// Player `user` puts down a deployable of `kind`, in place of any it had out. A barrier
    /// that would stand in a mech doesn't go up, and the charge comes back.
    fn deploy(&mut self, user: usize, kind: Kind) {
        let u = &self.players[user];
        let mechs = self.players.iter().filter(|q| q.mech.health > 0.0).map(|q| (self.arsenal.of(&q.mech), &q.mech));
        // A spawn point counts as a Heavy standing there.
        let heavy = self.arsenal.get(MechClass::C, Loadout::of(MechClass::C));
        let dm = if self.mode == Mode::Deathmatch { &self.dm_spawns[..] } else { &[] };
        let spawns: Vec<Mech> = self.spawns.iter().flatten().chain(dm).map(|&pos| Mech { pos, ..Mech::default() }).collect();
        let mechs = mechs.chain(spawns.iter().map(|m| (heavy, m)));
        match deploy::place(&self.arena, self.arsenal.of(&u.mech), &u.mech, kind, u.team, u.id, self.tick, mechs) {
            Some(d) => {
                deploy::add(&mut self.deployables, d);
                self.arena.set_barriers(items(&self.arsenal), &self.deployables);
            }
            None if kind.turret() => self.players[user].mech.grenades += 1,
            None => self.players[user].mech.emps += 1,
        }
    }

    /// Each turret trains on the nearest enemy it sees in range (not through walls or smoke, nor
    /// a fresh spawn under its shield), and fires once on it and ready: the MG bursts of hitscan
    /// rounds (`turret_round`), the other a rocket led by its flight time.
    /// Each base's guns, in the team modes, where the map has them: built when missing (a new
    /// match clears them with the rest), facing the map's middle. One shot offline (no hull left)
    /// comes back when its `ready` comes round, `placed` then (0 till it first does).
    fn tend_sentries(&mut self) {
        let tick = self.tick;
        for d in self.deployables.iter_mut().filter(|d| d.kind == Kind::Sentry) {
            if d.hull <= 0.0 && tick >= d.ready {
                (d.hull, d.placed, d.ready, d.burst) = (SENTRY_SHIELD, tick, tick + secs(SENTRY_ACQUIRE), 0);
            }
        }
        if matches!(self.mode, Mode::Deathmatch | Mode::Defense) || self.deployables.iter().any(|d| d.kind == Kind::Sentry) {
            return;
        }
        for (team, spots) in self.spots.sentries.iter().enumerate() {
            for (k, at) in spots.iter().enumerate() {
                let pos = Vector::from_array(*at);
                let (yaw, _) = bot::look_at(pos, Vector::ZERO.with_y(pos.y));
                let (team, owner) = (team as u8, deploy::sentry_owner(team as u8, k));
                self.deployables.push(Deployable { kind: Kind::Sentry, team, owner, pos, yaw, pitch: 0.0, hull: SENTRY_SHIELD, placed: 0, expires: u32::MAX, ready: tick, burst: 0 });
            }
        }
    }

    fn man_turrets(&mut self) {
        let rocket = Loadout { secondary: arsenal::index(Slot::Secondary, "rocket"), ..Loadout::default() };
        let tick = self.tick;
        for k in 0..self.deployables.len() {
            let d = self.deployables[k];
            // A battleship's fought like a turret but doesn't fire on mechs: only the base, in siege.rs.
            if !d.kind.turret() || d.kind == Kind::Ship || d.hull <= 0.0 {
                continue;
            }
            let (t, rt) = (items(&self.arsenal), self.arsenal.get(MechClass::B, rocket));
            // A co-op tower's reach and rate of fire, by its tier and its builder's perks (1s for
            // anything else).
            let (reach, rate) = self.defense.as_ref().map_or((1.0, 1.0), |df| (df.reach_of(d.owner), df.rate_of(d.owner)));
            let (range, speed) = match d.kind {
                Kind::MgTurret => (t.mg_turret_range, f32::INFINITY),
                Kind::Sentry => (SENTRY_RANGE, f32::INFINITY),
                Kind::Walker => (WALKER_RANGE, f32::INFINITY),
                _ => (t.rocket_turret_range, rt.alt_speed),
            };
            let range = range * reach;
            let gun = deploy::gun(t, &d);
            let (arena, clouds) = (&self.arena, &self.clouds);
            // Not one across a dome's surface, which would only soak up the fire.
            let deployables = &self.deployables;
            let sighted = |chest: Vector, range: f32| {
                let (ray, dist) = (Ray::new(gun, (chest - gun).normalize_or_zero()), chest.distance(gun));
                dist <= range && arena.cast_ray(&ray, dist).is_none() && !item::hidden(clouds, gun, chest) && deploy::stops(deployables, t, &ray, dist).is_none()
            };
            // A base gun with no mech to fire on takes the enemy ship, if it's near.
            let ship = || {
                (d.kind == Kind::Sentry)
                    .then(|| deployables.iter().find(|s| s.kind == Kind::Ship && s.team != d.team && s.hull > 0.0 && sighted(s.pos, SENTRY_SHIP_RANGE)))
                    .flatten()
                    .map(|s| (s.pos, Vector::ZERO))
            };
            let target = (self.players.iter())
                .filter(|q| q.team != d.team && q.mech.health > 0.0 && q.mech.shield <= 0.0 && !cloaked(q))
                .map(|q| (q.mech.pos + Vector::Y * (self.arsenal.of(&q.mech).mech_height * 0.5), q.mech.vel))
                // In co-op, walkers fire on the team's towers too, and towers on walkers.
                .chain(
                    (deployables.iter())
                        .filter(|e| e.team != d.team && e.hull > 0.0 && e.kind.shootable() && d.kind.lane_enemy() != e.kind.lane_enemy())
                        .map(|e| (deploy::center(t, e), self.defense.as_ref().map_or(Vector::ZERO, |df| df.velocity(e.owner)))),
                )
                .filter(|&(chest, _)| sighted(chest, range))
                .min_by(|a, b| a.0.distance(gun).total_cmp(&b.0.distance(gun)))
                .or_else(ship);
            let Some((chest, vel)) = target else {
                if d.kind == Kind::Sentry {
                    let d = &mut self.deployables[k];
                    (d.ready, d.burst) = (d.ready.max(tick + secs(SENTRY_ACQUIRE)), 0);
                }
                continue;
            };
            let lead = chest.distance(gun) / speed;
            let on = deploy::train(t, &mut self.deployables[k], chest + vel * lead);
            if !on || tick < d.ready {
                continue;
            }
            let d = &mut self.deployables[k];
            if d.kind != Kind::RocketTurret {
                let (burst, rate_hz, pause) = match d.kind {
                    Kind::Sentry => (SENTRY_BURST, SENTRY_RATE, SENTRY_PAUSE),
                    Kind::Walker => (WALKER_BURST, WALKER_RATE, WALKER_PAUSE),
                    _ => (t.mg_turret_burst as u8, t.mg_turret_rate, t.mg_turret_pause),
                };
                if d.burst == 0 {
                    d.burst = burst;
                }
                d.burst -= 1;
                d.ready = tick + secs(if d.burst > 0 { 1.0 / rate_hz } else { pause } / rate);
                self.turret_round(k);
            } else {
                d.ready = tick + secs(t.rocket_turret_cooldown / rate);
                let dir = Rotation::from_rotation_y(d.yaw) * Rotation::from_rotation_x(d.pitch) * Vector::NEG_Z;
                let p = Projectile {
                    owner: d.owner, seq: tick, n: projectile::TURRET, primary: false, class: MechClass::B, loadout: rocket, charge: 0.0, boosted: false,
                    target: 0, pos: gun, vel: dir * rt.alt_speed, age: 0.0,
                };
                self.events.push(Event::Launch(p));
                self.projectiles.push(Flying { p, team: d.team });
            }
        }
    }

    /// One round from MG turret `k`, along its gun in a cone of `mg_turret_spread_deg`: it stops at
    /// the first wall, dome surface, or enemy mech or turret. A kill is its owner's.
    fn turret_round(&mut self, k: usize) {
        let (d, t) = (self.deployables[k], items(&self.arsenal));
        let ray = Ray::new(deploy::gun(t, &d), weapon::in_cone(d.yaw, d.pitch, t.mg_turret_spread_deg.to_radians(), self.tick, u32::from(d.owner)));
        let reach = self.defense.as_ref().map_or(1.0, |df| df.reach_of(d.owner));
        let range = match d.kind {
            Kind::Sentry => SENTRY_SHIP_RANGE,
            Kind::Walker => WALKER_RANGE,
            _ => t.mg_turret_range * reach,
        };
        let wall = self.arena.cast_ray(&ray, range).unwrap_or(range);
        let mut best = deploy::stops(&self.deployables, t, &ray, wall).unwrap_or(wall);
        let mut hit = None;
        for (j, q) in self.players.iter().enumerate().filter(|(_, q)| q.team != d.team && q.mech.health > 0.0) {
            let (shape, center) = hit_shape(self.arsenal.of(&q.mech), &q.mech);
            if let Some(toi) = shape.cast_ray(&Pose::from_translation(center), &ray, best, true) {
                (best, hit) = (toi, Some(j));
            }
        }
        let turret = deploy::first_turret(&self.deployables, t, d.team, &ray, best);
        if let Some((_, toi)) = turret {
            (best, hit) = (toi, None);
        }
        let worn = worn(&self.deployables, t, d.team, turret, hit.is_some(), ray.point_at(best));
        let hit = hit.filter(|_| matches!(self.phase, Phase::Playing { .. }));
        let damage = match d.kind {
            Kind::Sentry => SENTRY_ROUND,
            Kind::Walker => WALKER_ROUND,
            _ => t.mg_turret_damage,
        };
        self.events.push(Event::TurretShot { owner: d.owner, end: ray.point_at(best), hit: hit.map(|j| self.players[j].id) });
        let by = self.defense.as_ref().map_or(d.owner, |df| df.credit(d.owner));
        let owner = self.players.iter().position(|q| q.id == by);
        if let Some(j) = hit {
            self.apply_damage_by(owner, j, damage, Cause::Weapon { slot: Slot::Offensive, index: Item::MgTurret.index() });
        }
        // Base guns' rounds stop at the hauler but don't wear it.
        if let Some(k) = worn.filter(|&k| d.kind != Kind::Sentry || self.deployables[k].kind != Kind::Hauler) {
            self.wear(k, damage, d.owner);
            // A flak blueprint's rounds burst on the hive: half again on each other foe nearby.
            let flak = self.defense.as_ref().is_some_and(|df| df.tower_perk(d.owner, defense::Perk::Flak) > 0.0);
            if flak && self.deployables[k].kind.lane_enemy() {
                let at = ray.point_at(best);
                let t = items(&self.arsenal);
                let near: Vec<usize> = (0..self.deployables.len()).filter(|&j| j != k && self.deployables[j].kind.lane_enemy() && self.deployables[j].hull > 0.0 && deploy::center(t, &self.deployables[j]).distance(at) <= FLAK_BURST).collect();
                for j in near {
                    self.wear(j, 0.5 * damage, d.owner);
                }
            }
        }
    }

    /// Player `attacker` shoots `amount` off deployable `k` while the match is on, and hears of it
    /// if it's a turret (a hit marker); it's cleared at the tick's end once its hull's gone, but a
    /// base gun goes offline for SENTRY_OFFLINE (and can't be hurt for SENTRY_IMMUNE once back).
    fn wear(&mut self, k: usize, amount: f32, attacker: u8) {
        let tick = self.tick;
        let d = &mut self.deployables[k];
        let rebooting = d.kind == Kind::Sentry && d.placed > 0 && tick < d.placed + secs(SENTRY_IMMUNE);
        if !matches!(self.phase, Phase::Playing { .. }) || rebooting {
            return;
        }
        let standing = d.hull > 0.0;
        // Perks: a pilot's own guns hit the hive harder; a sabot blueprint's rockets go through
        // plating.
        // And a co-op tower's guns hit the hive far harder than the item turrets they're built on.
        let (mut hunter, mut sabot, mut power) = (0.0, false, 1.0);
        if let Some(df) = self.defense.as_ref().filter(|_| d.kind.lane_enemy()) {
            hunter = df.perk(attacker, defense::Perk::Hunter);
            let tower = df.tower(attacker).and_then(|_| attacker_kind(&self.deployables, attacker));
            sabot = tower == Some(Kind::RocketTurret) && df.tower_perk(attacker, defense::Perk::Sabot) > 0.0;
            power = match tower {
                Some(Kind::MgTurret) => TOWER_MG_POWER,
                Some(Kind::RocketTurret) => TOWER_ROCKET_POWER,
                _ => 1.0,
            };
        }
        let d = &mut self.deployables[k];
        let amount = amount * (1.0 + 0.2 * hunter) * power;
        let amount = if sabot { amount } else { defense::armored(d.kind, amount) };
        let dealt = amount.min(d.hull.max(0.0));
        d.hull -= amount;
        // (Points and XP for the hull shot off a ship, the hauler or a walker; in co-op, scrap for
        // a walker's, a tower's going to its builder.)
        let ship = matches!(d.kind, Kind::Ship | Kind::Hauler) || d.kind.lane_enemy();
        let attacker = self.defense.as_ref().map_or(attacker, |df| df.credit(attacker));
        if d.kind.lane_enemy()
            && let Some(df) = self.defense.as_mut()
        {
            df.earn(attacker, dealt);
        }
        let d = &mut self.deployables[k];
        // A boss shot down leaves salvage: a blueprint for whoever picks it up.
        if standing && d.hull <= 0.0 && d.kind.boss() {
            let at = d.pos;
            if let Some(df) = self.defense.as_mut() {
                df.cores.push((at, true));
            }
        }
        let d = &mut self.deployables[k];
        if standing && d.hull <= 0.0 {
            match d.kind {
                Kind::Sentry => (d.ready, d.burst) = (tick + secs(SENTRY_OFFLINE), 0),
                Kind::Hauler => d.ready = tick + secs(convoy::STALL_SECONDS),
                _ => {}
            }
        }
        if d.kind.shootable() {
            self.events.push(Event::TurretHit { attacker, wrecked: standing && d.hull <= 0.0 });
        }
        if let Some(p) = self.players.iter_mut().find(|p| p.id == attacker).filter(|_| ship) {
            p.points += SHIP_POINTS * dealt;
            p.tally.hit_ship(dealt);
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
        // A dome's surface stops it short.
        let eye = aim_ray(t, &u.mech).origin;
        if let Some(toi) = deploy::stops(&self.deployables, t, &Ray::new(eye, (end - eye).normalize_or_zero()), end.distance(eye)) {
            (end, hit) = (eye + (end - eye).normalize_or_zero() * toi, None);
        }
        let medic = self.defense.as_ref().map_or(0.0, |df| df.perk(u.id, defense::Perk::Medic));
        let (owner, team, heal, burn) = (u.id, u.team, t.alt_beam_heal * DT * (1.0 + 0.5 * medic), t.alt_damage * DT * ability::damage_mult(t, &u.mech));
        // In co-op it mends the team's towers, and the reactor, short of whatever else it meets.
        if let Some(df) = self.defense.as_mut().filter(|_| team == 0) {
            let (dir, reach) = ((end - eye).normalize_or_zero(), end.distance(eye));
            let towers = deploy::first_turret(&self.deployables, t, 1, &Ray::new(eye, dir), reach).filter(|&(k, _)| df.tower(self.deployables[k].owner).is_some());
            let core = df.reactor + Vector::Y * REACTOR_MIDDLE;
            let s = (core - eye).dot(dir).clamp(0.0, reach);
            let reactor = ((eye + dir * s - core).length() < REACTOR_BODY).then_some(s);
            match (towers, reactor) {
                (Some((k, toi)), r) if r.is_none_or(|s| toi < s) => {
                    let max = df.hull_max(self.deployables[k].owner);
                    let e = &mut self.deployables[k];
                    e.hull = (e.hull + heal).min(max);
                    (end, hit) = (eye + dir * toi, None);
                }
                (_, Some(s)) => {
                    df.hull = (df.hull + heal).min(defense::REACTOR_HULL);
                    (end, hit) = (eye + dir * s, None);
                }
                _ => {}
            }
        }
        (self.players[user].mech.beam_end, self.players[user].mech.beam_on) = (end, hit);
        self.events.push(Event::Beam { owner, end, hit });
        if let Some(k) = worn(&self.deployables, t, team, None, hit.is_some(), end) {
            self.wear(k, burn, owner);
        }
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
    /// drops a health orb, and scores for `attacker`, if they're still here; it shares out kill
    /// credit (points, and on tallies: the killer's by `cause`'s weapon, assists for the rest who
    /// dealt the victim's recent damage), and goes as a death on the victim's tally.
    fn apply_damage_by(&mut self, attacker: Option<usize>, j: usize, amount: f32, cause: Cause) {
        let target = &self.players[j];
        if !matches!(self.phase, Phase::Playing { .. }) || target.mech.health <= 0.0 || target.mech.shield > 0.0 {
            return;
        }
        let tt = self.arsenal.of(&target.mech);
        let braced = ability::on(&target.mech, Ability::Brace);
        let damage = amount * if braced { tt.brace_damage_mult } else { 1.0 };
        // Co-op perks: a reinforced frame takes less, a hive hunter deals more; a quick return
        // relaunches sooner.
        let perk = |id: Option<u8>, p| self.defense.as_ref().zip(id).map_or(0.0, |(df, id)| df.perk(id, p));
        let victim = Some(target.id).filter(|_| target.team == 0);
        let hunter = attacker.map(|a| self.players[a].id).filter(|_| target.team == 1);
        let damage = damage * (1.0 - 0.15 * perk(victim, defense::Perk::Frame)) * (1.0 + 0.2 * perk(hunter, defense::Perk::Hunter));
        let respawn_at = self.tick + secs(tt.respawn_delay * (1.0 - 0.3 * perk(victim, defense::Perk::Return)));
        let (tick, from) = (self.tick, attacker.map(|a| (self.players[a].id, self.players[a].mech.pos)));
        let target = &mut self.players[j];
        // A bot feels where the hit came from.
        if let (Some((id, pos)), Some(bot)) = (from, &mut target.bot) {
            bot.hurt_by(id, pos, tick);
        }
        target.mech.end_repair(tt);
        // Assist shares count the health a hit took, not its overkill.
        let took = damage.min(target.mech.health);
        if let Some((id, _)) = from {
            target.ledger.push((id, took, tick));
        }
        target.tally.taken += took;
        // In co-op, scrap for the health shot off an infested mech, and salvage where one falls.
        if let (Some(df), 1) = (self.defense.as_mut(), target.team) {
            if let Some((id, _)) = from {
                df.earn(id, ELITE_SCRAP * took);
            }
            if damage >= target.mech.health {
                df.cores.push((target.mech.pos, false));
            }
        }
        target.mech.health -= damage;
        let dead = target.mech.health <= 0.0;
        if let Some(a) = attacker.filter(|&a| a != j) {
            self.players[a].tally.dealt += took;
            if let Cause::Weapon { slot, .. } = cause {
                self.players[a].tally.dealt_by[slot as usize] += took;
            }
        }
        if !dead {
            return;
        }
        let target = &mut self.players[j];
        target.mech.health = 0.0;
        target.deaths += 1;
        target.tally.stats.deaths += 1;
        target.respawn_at = Some(respawn_at);
        // Kill credit: everyone their share of the recent damage, the killer KILLER_BONUS more.
        let (bot, ledger) = (target.bot.is_some(), std::mem::take(&mut target.ledger));
        let (victim, fell) = (target.id, target.mech.pos);
        let killer = from.map(|(id, _)| id);
        let recent = |&&(_, _, at): &&(u8, f32, u32)| tick.saturating_sub(at) < secs(ASSIST_WINDOW);
        let total: f32 = ledger.iter().filter(recent).map(|l| l.1).sum();
        let mut credits: Vec<(u8, f32)> = killer.map(|id| (id, progress::KILLER_BONUS)).into_iter().collect();
        for &(id, dealt, _) in ledger.iter().filter(recent).filter(|_| total > 0.0) {
            match credits.iter_mut().find(|c| c.0 == id) {
                Some(c) => c.1 += dealt / total,
                None => credits.push((id, dealt / total)),
            }
        }
        let weapon = match cause {
            Cause::Weapon { slot, index } => arsenal::weapon(slot, index).map(|(id, _)| id.to_string()),
            Cause::Unknown => None,
        };
        let mut assists = 0u16;
        for (id, credit) in credits {
            let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { continue };
            p.points += POINTS_PER_KILL * credit;
            if Some(id) == killer {
                p.tally.kill(weapon.as_deref(), bot, credit);
            } else if p.tally.assist(credit, bot) {
                assists |= 1 << id;
            }
        }
        let health = self.arsenal.of(&self.players[j].mech).orb_health;
        self.orbs.push(Orb { pos: self.orb_spot(fell), health, fades_at: self.tick + secs(ORB_SECONDS), dropped: None });
        // What it carried falls with it, for anyone to pick up.
        let (eu, spot) = (std::mem::take(&mut self.players[j].eu), self.orb_spot(fell));
        if let Some(s) = self.siege.as_mut().filter(|_| eu > 0.0) {
            s.drop(spot, eu, self.tick);
        }
        // A flag carried falls to the ground under them (where the orb floats over).
        let ground = spot - Vector::Y * ORB_HEIGHT;
        let reachable = self.reachable(ground).then_some(ground);
        if let Some((team, what)) = self.ctf.as_mut().and_then(|c| c.fell(victim, reachable)) {
            self.events.push(Event::Flag { team, what, by: Some(victim) });
        }
        self.players[j].mech.laden = false;
        let Some(a) = attacker else { return };
        let (killer, team) = (self.players[a].id, self.players[a].team);
        // A pilot's kill of a bot sharpens the bot's side a little; a bot's kill of a pilot eases
        // its own.
        let t = self.arsenal.get(MechClass::B, Loadout::of(MechClass::B));
        let (pilot_killed, pilot_died) = (self.players[a].bot.is_none() && self.players[j].bot.is_some(), self.players[j].bot.is_none() && self.players[a].bot.is_some());
        if let Some(side) = [(pilot_killed, self.players[j].team), (pilot_died, team)].into_iter().find(|&(hit, s)| hit && s < 2).map(|(_, s)| usize::from(s)) {
            let step = if pilot_killed { t.bot_adapt_step } else { -t.bot_adapt_step };
            self.adapt[side] = (self.adapt[side] + step).clamp(-t.bot_adapt_range, t.bot_adapt_range);
        }
        self.players[a].kills += 1;
        self.events.push(Event::Kill { killer, victim, assists });
        let won = match self.mode {
            Mode::TeamDeathmatch => {
                self.scores[usize::from(team)] += 1;
                self.scores[usize::from(team)] >= self.score_limit
            }
            Mode::Deathmatch => {
                let limit = f32::from(self.score_limit) * POINTS_PER_KILL * (1.0 + progress::KILLER_BONUS);
                self.players.iter().any(|p| p.points >= limit)
            }
            // Only a base falling, or the last capture, ends it.
            Mode::MissileAssault | Mode::Siege | Mode::CaptureTheFlag | Mode::Convoy | Mode::Defense => false,
        };
        if won {
            self.end_match();
        }
    }

    /// What happened this tick.
    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// The match's map, score and clock, as players see them.
    pub fn match_state(&self) -> MatchState {
        let (ended, winner, until) = match self.phase {
            Phase::Staging { until } => (false, None, until),
            Phase::Playing { started_at } => (false, None, started_at + secs(self.match_seconds)),
            Phase::Ended { winner, restart_at } => (true, winner, restart_at),
        };
        // In Deathmatch, the top two's points; in Missile Assault and Siege, the bases' hull; in
        // Capture the Flag, the captures.
        let scores = match self.mode {
            Mode::TeamDeathmatch => self.scores,
            Mode::CaptureTheFlag => self.ctf.as_ref().map_or([0; 2], |c| c.captures),
            // How far each team's pushed the hauler toward the other's base, in percent.
            Mode::Convoy => self.convoy.as_ref().map_or([0; 2], |c| c.pushed().map(|f| (f * 100.0).round() as u16)),
            // The reactor's hull, and the wave.
            Mode::Defense => self.defense.as_ref().map_or([defense::REACTOR_HULL as u16, 1], |d| [d.hull.ceil() as u16, u16::from(d.wave)]),
            Mode::MissileAssault | Mode::Siege => self.base_hull().unwrap_or([objective::BASE_HULL; 2]).map(|h| h.ceil() as u16),
            Mode::Deathmatch => {
                let top = self.standings();
                [0, 1].map(|i| top.get(i).map_or(0, |p| p.points.round() as u16))
            }
        };
        MatchState {
            mode: self.mode,
            map: self.map as u8,
            next_mode: self.next.0,
            next_map: self.next.1 as u8,
            scores,
            limit: match self.mode {
                Mode::CaptureTheFlag => ctf::CAPTURES_TO_WIN,
                Mode::Convoy => 100,
                Mode::Defense => u16::from(defense::WAVES),
                _ => self.score_limit,
            },
            seconds_left: (until.saturating_sub(self.tick) as f32 / TICK_HZ).ceil() as u16,
            staging: matches!(self.phase, Phase::Staging { .. }),
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
                    points: p.points.round() as u16,
                    eu: p.eu.round() as u8,
                    docked: p.respawn_at.is_some_and(|at| self.tick >= at),
                    view: MechView::from(&p.mech),
                })
                .collect(),
            events: self.events.clone(),
            orbs: self.orbs.clone(),
            clouds: self.clouds.clone(),
            deployables: self.deployables.clone(),
            zones: match (&self.assault, &self.siege) {
                (Some(a), _) => a.silos.iter().map(|z| z.state).collect(),
                (_, Some(s)) => vec![s.aa.state],
                _ => Vec::new(),
            },
            siege: self.siege.as_ref().map(Siege::net),
            ctf: self.ctf.as_ref().map(Ctf::net),
            defense: self.defense.as_ref().map(|d| d.net(self.tick)),
            convoy: self.convoy.as_ref().map(|c| {
                let stall = self.deployables.iter().find(|d| d.kind == Kind::Hauler && d.hull <= 0.0);
                c.net(stall.map_or(0.0, |d| d.ready.saturating_sub(self.tick) as f32 * DT))
            }),
            hangar: me.and_then(|p| p.respawn_at).map(|at| at.saturating_sub(self.tick) as f32 * DT),
            state: self.match_state(),
        }
    }
}

impl Game {
    fn step_objectives(&mut self) {
        match self.mode {
            Mode::MissileAssault => self.step_assault(),
            Mode::Siege => self.step_siege(),
            Mode::CaptureTheFlag => self.step_ctf(),
            Mode::Convoy => self.step_convoy(),
            Mode::Defense => self.step_defense(),
            _ => {}
        }
    }

    /// Missile Assault's tick: who stands in each silo (the living), captures (an event, and
    /// credit for each capturer), missiles fired, and the match's end when a base falls.
    fn step_assault(&mut self) {
        let waypoints = self.nav.points();
        let Some(mut assault) = self.assault.take().or_else(|| Assault::new(&self.spots, waypoints)) else { return };
        let living = || self.players.iter().filter(|p| p.mech.health > 0.0);
        let counts: Vec<[usize; 2]> = assault.silos.iter().map(|z| [0, 1].map(|t| living().filter(|p| p.team == t && z.holds(p.mech.pos)).count())).collect();
        let outcome = assault.step(self.tick, &counts);
        for &(zone, team) in &outcome.captured {
            self.events.push(Event::Captured { zone: zone as u8, team });
            let silo = &assault.silos[zone];
            for p in self.players.iter_mut().filter(|p| p.team == team && p.mech.health > 0.0 && silo.holds(p.mech.pos)) {
                p.points += CAPTURE_POINTS;
                p.tally.capture();
            }
        }
        self.events.extend(outcome.fired.iter().map(|&(silo, team)| Event::Missile { silo: silo as u8, team }));
        let fallen = assault.fallen().is_some();
        self.assault = Some(assault);
        if fallen {
            self.end_match();
        }
    }

    /// Siege's tick: ships gone down since the last, the AA gun's zone, energy drawn, carried,
    /// picked up and banked (with credit), launches, the ships' flight, and the match's end when a
    /// base falls.
    fn step_siege(&mut self) {
        let waypoints = self.nav.points();
        let Some(mut s) = self.siege.take().or_else(|| Siege::new(&self.spots, waypoints)) else { return };
        let ship_up = |list: &[Deployable], team: u8| list.iter().any(|d| d.kind == Kind::Ship && d.team == team);
        let up = [0, 1].map(|t| ship_up(&self.deployables, t));
        for team in (0..2).filter(|&t| s.up[usize::from(t)] && !up[usize::from(t)]) {
            self.events.push(Event::Ship { team, up: false });
        }
        let count = [0, 1].map(|t| self.players.iter().filter(|p| p.team == t && p.mech.health > 0.0 && s.aa.holds(p.mech.pos)).count());
        if let Some(team) = s.aa.step(count) {
            self.events.push(Event::Captured { zone: 0, team });
            for p in self.players.iter_mut().filter(|p| p.team == team && p.mech.health > 0.0 && s.aa.holds(p.mech.pos)) {
                p.points += CAPTURE_POINTS;
                p.tally.capture();
            }
        }
        let living: Vec<usize> = (0..self.players.len()).filter(|&i| self.players[i].mech.health > 0.0).collect();
        let mut mechs: Vec<(u8, Vector, f32)> = living.iter().map(|&i| (self.players[i].team, self.players[i].mech.pos, self.players[i].eu)).collect();
        let banked = s.energy(self.tick, &mut mechs, up[0] || up[1]);
        for ((&i, m), eu) in living.iter().zip(&mechs).zip(banked) {
            let p = &mut self.players[i];
            p.eu = m.2;
            if eu > 0.0 {
                p.points += EU_POINTS * eu;
                p.tally.bank(eu);
            }
        }
        if let Some(team) = s.launch(up) {
            let pos = s.ship_start(team);
            self.deployables.push(Deployable { kind: Kind::Ship, team, owner: deploy::ship_owner(team), pos, yaw: 0.0, pitch: 0.0, hull: siege::SHIP_HULL, placed: self.tick, expires: u32::MAX, ready: self.tick, burst: 0 });
            self.events.push(Event::Ship { team, up: true });
        }
        let flying: Vec<usize> = (0..self.deployables.len()).filter(|&k| self.deployables[k].kind == Kind::Ship && self.deployables[k].hull > 0.0).collect();
        let mut ships: Vec<siege::Ship> = flying.iter().map(|&k| (self.deployables[k].team, self.deployables[k].pos, self.deployables[k].hull)).collect();
        s.fly(&mut ships);
        for (&k, &(_, pos, hull)) in flying.iter().zip(&ships) {
            (self.deployables[k].pos, self.deployables[k].hull) = (pos, hull);
        }
        // Ships shot down this tick are cleared before the next, which tells of them.
        s.up = [0, 1].map(|t| ship_up(&self.deployables, t));
        let fallen = s.fallen().is_some();
        self.siege = Some(s);
        if fallen {
            self.end_match();
        }
    }
}

impl Game {
    /// Capture the Flag's tick: raids, pickups, returns and captures (events and credit), who's
    /// laden with a flag (and so out of Camouflage), and the match's end at the last capture.
    fn step_ctf(&mut self) {
        let Some(mut c) = self.ctf.take().or_else(|| Ctf::new(&self.spots, self.nav.points())) else { return };
        let living: Vec<(u8, u8, Vector)> = self.players.iter().filter(|p| p.mech.health > 0.0).map(|p| (p.id, p.team, p.mech.pos)).collect();
        for (team, what, by) in c.step(&living) {
            self.events.push(Event::Flag { team, what, by });
            let Some(p) = self.players.iter_mut().find(|p| Some(p.id) == by) else { continue };
            match what {
                Happened::Taken | Happened::Captured => {
                    p.points += if what == Happened::Taken { CAPTURE_POINTS } else { FLAG_CAPTURE_POINTS };
                    p.tally.capture();
                }
                Happened::Returned => p.points += FLAG_RETURN_POINTS,
                Happened::Dropped | Happened::PickedUp => {}
            }
        }
        for p in &mut self.players {
            p.mech.laden = c.carried_by(p.id).is_some();
            if p.mech.laden && ability::on(&p.mech, Ability::Cloak) {
                p.mech.ability_time = 0.0;
            }
        }
        let won = c.won().is_some();
        self.ctf = Some(c);
        if won {
            self.end_match();
        }
    }

    /// Convoy's tick: the hauler (put on its route's start when missing) stalled and back, walked
    /// on by its escorts (ground under it), their credit, and the match's end on delivery.
    fn step_convoy(&mut self) {
        let Some(mut c) = self.convoy.take().or_else(|| Convoy::new(&self.spots)) else { return };
        let tick = self.tick;
        if !self.deployables.iter().any(|d| d.kind == Kind::Hauler) {
            let (at, yaw) = c.at(c.along);
            let (pos, owner) = (self.ground(at), deploy::hauler_owner());
            self.deployables.push(Deployable { kind: Kind::Hauler, team: deploy::NEUTRAL, owner, pos, yaw, pitch: 0.0, hull: convoy::SHIELD, placed: tick, expires: u32::MAX, ready: tick, burst: 0 });
        }
        let k = self.deployables.iter().position(|d| d.kind == Kind::Hauler).expect("put there above");
        let mut news = Vec::new();
        let d = &mut self.deployables[k];
        if d.hull <= 0.0 && tick >= d.ready {
            d.hull = convoy::SHIELD;
            news.push(News::Rebooted);
        }
        let stalled = d.hull <= 0.0;
        if stalled && !c.stalled {
            news.push(News::Stalled);
        }
        c.stalled = stalled;
        let living: Vec<(u8, Vector)> = self.players.iter().filter(|p| p.mech.health > 0.0).map(|p| (p.team, p.mech.pos)).collect();
        let before = c.along;
        news.extend(c.step(&living, d.pos, stalled));
        if c.along != before {
            let (at, heading) = c.at(c.along);
            let pos = self.ground(at);
            let d = &mut self.deployables[k];
            // Facing the way it walks.
            (d.pos, d.yaw) = (pos, if c.along > before { heading } else { heading + std::f32::consts::PI });
            let hauler = pos;
            for p in self.players.iter_mut().filter(|p| Some(p.team) == c.pusher && p.mech.health > 0.0) {
                if (p.mech.pos - hauler).with_y(0.0).length() <= convoy::ESCORT_RANGE {
                    p.points += ESCORT_POINTS * DT;
                    p.tally.escort(DT);
                }
            }
        }
        let delivered = news.iter().any(|n| matches!(n, News::Delivered(_)));
        self.events.extend(news.into_iter().map(Event::Convoy));
        self.convoy = Some(c);
        if delivered {
            self.end_match();
        }
    }

    /// Co-op Defense's tick: breaks and waves, walkers put down at the gates and walked along
    /// their lanes (on the ground), taken off when they reach the reactor, news, and the end.
    fn step_defense(&mut self) {
        let tick = self.tick;
        let made = self.defense.take().or_else(|| {
            let (nav, arena) = (&self.nav, &self.arena);
            let mut d = Defense::new(self.spots.defense.as_ref()?, tick, |a, b| nav.route(arena, a, b))?;
            // Supply caches lie out at the waypoints furthest from the reactor: the far half (down
            // the cliff, on a map up one), worth going out for.
            let mut far: Vec<Vector> = nav.points().to_vec();
            far.sort_by(|a, b| (*b - d.reactor).length().total_cmp(&(*a - d.reactor).length()));
            far.truncate(far.len() / 2);
            d.set_cache_spots(far);
            Some(d)
        });
        let Some(mut d) = made else { return };
        // Infested mechs that reached the reactor hit it and are gone; downed ones go before they'd
        // relaunch.
        let mut news = Vec::new();
        let (reactor, reach) = (d.reactor, d.radius);
        let arsenal = &self.arsenal;
        let before = self.players.len();
        self.players.retain(|p| {
            let leaked = p.team == 1 && p.mech.health > 0.0 && (p.mech.pos - reactor).with_y(0.0).length() <= reach;
            let downed = p.team == 1 && p.respawn_at.is_some_and(|at| tick + secs(arsenal.of(&p.mech).respawn_delay - ELITE_WRECK) >= at);
            if leaked {
                d.leak(defense::ELITE_LEAK);
                news.push(defense::News::Hit);
            }
            !(leaked || downed)
        });
        if self.players.len() != before {
            self.roster_version += 1;
        }
        let pilots: Vec<u8> = self.players.iter().filter(|p| p.team == 0).map(|p| p.id).collect();
        let elites = self.players.iter().filter(|p| p.team == 1).count();
        let standing: Vec<u8> = self.deployables.iter().filter(|w| w.hull > 0.0).map(|w| w.owner).collect();
        let mut out = d.step(tick, &pilots, &standing, elites);
        out.news.extend(news);
        out.lost |= d.hull <= 0.0;
        for (owner, kind, at, hull) in out.spawn {
            self.put_foe(owner, kind, at, hull);
        }
        for at in out.elites {
            let seed = u64::from(tick) << 8 | 0x5a;
            let class = MechClass::ALL[(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 33) as usize % 3];
            if let Some(id) = self.add_player(1, Some(Bot::with_skill(seed, self.bot_skill)), class) {
                let feet = self.ground(at);
                let p = self.players.iter_mut().find(|p| p.id == id).unwrap();
                p.mech.pos = feet;
            }
        }
        // (Their facing is their gun's, trained by `man_turrets`; the client faces their bodies
        // the way they walk.)
        for (owner, at, _) in out.moves {
            let pos = self.ground(at);
            if let Some(w) = self.deployables.iter_mut().find(|w| w.kind.lane_enemy() && w.owner == owner) {
                // A burrowing Excavator goes under its lane.
                w.pos = if w.kind == Kind::Excavator && w.burst == 1 { pos - Vector::Y * UNDERGROUND } else { pos };
            }
        }
        self.deployables.retain(|w| !w.kind.lane_enemy() || !out.leaked.contains(&w.owner));
        self.events.extend(out.news.iter().map(|&n| Event::Defense(n)));
        // Salvage, and supply caches, to whoever walks over them; bots take their drafts as they come.
        let mut news = Vec::new();
        for i in (0..d.caches.len()).rev() {
            let at = d.caches[i];
            if let Some(p) = self.players.iter().find(|p| p.team == 0 && p.mech.health > 0.0 && (p.mech.pos - at).with_y(0.0).length() <= SALVAGE_REACH && (p.mech.pos.y - at.y).abs() < 4.0) {
                d.caches.remove(i);
                if let Some(s) = d.scrap.get_mut(usize::from(p.id)) {
                    *s += defense::CACHE_SCRAP;
                }
                news.push(defense::News::Cache { id: p.id });
            }
        }
        for i in (0..d.cores.len()).rev() {
            let (at, rare) = d.cores[i];
            if let Some(p) = self.players.iter().find(|p| p.team == 0 && p.mech.health > 0.0 && (p.mech.pos - at).with_y(0.0).length() <= SALVAGE_REACH) {
                d.cores.remove(i);
                d.offer(p.id, rare);
                news.push(defense::News::Salvage { id: p.id, rare });
            }
        }
        self.events.extend(news.into_iter().map(Event::Defense));
        for p in self.players.iter().filter(|p| p.bot.is_some()) {
            while d.offers.iter().any(|o| o.0 == p.id) {
                let pick = (tick + u32::from(p.id)) % 3;
                let n = d.offers.iter().find(|o| o.0 == p.id).map_or(1, |o| o.1.len() as u32);
                d.draft(p.id, (pick % n) as u8);
            }
        }
        self.defense = Some(d);
        self.bots_build();
        self.power_pylons();
        self.lane_enemies_strike();
        if out.lost || out.won {
            self.end_match();
        }
    }

    /// Player `id` takes perk `choice` (0-2) of their co-op draft on offer.
    pub fn draft(&mut self, id: u8, choice: u8) {
        if let Some(d) = self.defense.as_mut() {
            d.draft(id, choice);
        }
    }

    /// Player `id`'s build order in co-op (`defense::Build`), where they aim: a tower put down for
    /// its price in their scrap, the tower raised a tier for its upgrade, or (theirs) sold back.
    /// A refusal is news, for them.
    pub fn build(&mut self, id: u8, order: defense::Build) {
        let Some(i) = self.players.iter().position(|p| p.id == id && p.team == 0 && p.mech.health > 0.0) else { return };
        let aim = aim_ray(self.arsenal.of(&self.players[i].mech), &self.players[i].mech);
        if let Some(why) = self.build_along(id, order, &aim) {
            self.events.push(Event::Defense(defense::News::Refused { id, why }));
        }
    }

    /// `build`'s work for player `id` along `aim` (a bot's: down at its spot); why not, if not.
    fn build_along(&mut self, id: u8, order: defense::Build, aim: &Ray) -> Option<defense::Refusal> {
        let Some(i) = self.players.iter().position(|p| p.id == id) else { return Some(defense::Refusal::Reach) };
        let Some(d) = self.defense.as_ref() else { return Some(defense::Refusal::Reach) };
        let (m, aim) = (self.players[i].mech, *aim);
        match order {
            defense::Build::Place(k) => {
                let kind = *defense::TOWERS.get(usize::from(k)).unwrap_or(&Kind::MgTurret);
                let towers = self.deployables.iter().filter(|e| d.tower(e.owner).is_some()).map(|e| e.pos);
                match (d.spot(&self.arena, &aim, towers), d.free_tower()) {
                    (Err(why), _) => Some(why),
                    (_, None) => Some(defense::Refusal::Towers),
                    _ if d.scrap[usize::from(id)] < d.price_for(id, kind) => Some(defense::Refusal::Scrap),
                    (Ok(pos), Some(owner)) => {
                        let (tick, hull, cost) = (self.tick, defense::tower_hull(1) * (1.0 + 0.25 * d.perk(id, defense::Perk::Plating)), d.price_for(id, kind));
                        let ready = tick + secs(items(&self.arsenal).turret_warmup);
                        self.deployables.push(Deployable { kind, team: 0, owner, pos, yaw: m.yaw, pitch: 0.0, hull, placed: tick, expires: u32::MAX, ready, burst: 0 });
                        let d = self.defense.as_mut().unwrap();
                        d.scrap[usize::from(id)] -= cost;
                        d.towers.push(defense::Tower { owner, by: id, tier: 1, spent: cost, own: cost });
                        None
                    }
                }
            }
            defense::Build::Upgrade | defense::Build::Sell => {
                // The nearest of the team's towers along the aim, within reach.
                let k = deploy::first_turret(&self.deployables, items(&self.arsenal), 1, &aim, defense::REACH).map(|(k, _)| k).filter(|&k| d.tower(self.deployables[k].owner).is_some());
                match k {
                    None => Some(defense::Refusal::Tower),
                    Some(k) => {
                        let e = self.deployables[k];
                        let d = self.defense.as_mut().unwrap();
                        let (cost, tower) = {
                            let tower = d.towers.iter_mut().find(|t| t.owner == e.owner).unwrap();
                            (tower.upgrade(e.kind), *tower)
                        };
                        match order {
                            _ if order == defense::Build::Sell && tower.by != id => Some(defense::Refusal::Tower),
                            defense::Build::Sell => {
                                d.scrap[usize::from(id)] += d.refund_of(&tower);
                                d.towers.retain(|t| t.owner != e.owner);
                                self.deployables.remove(k);
                                None
                            }
                            _ if tower.tier >= defense::TIERS => Some(defense::Refusal::Full),
                            _ if d.scrap[usize::from(id)] < cost => Some(defense::Refusal::Scrap),
                            _ => {
                                d.scrap[usize::from(id)] -= cost;
                                let before = d.hull_max(e.owner);
                                let tower = d.towers.iter_mut().find(|t| t.owner == e.owner).unwrap();
                                (tower.tier, tower.spent) = (tower.tier + 1, tower.spent + cost);
                                if tower.by == id {
                                    tower.own += cost;
                                }
                                // Its new hull, less what it's lost.
                                self.deployables[k].hull += d.hull_max(e.owner) - before;
                                None
                            }
                        }
                    }
                }
            }
        }
    }

    /// Co-op's bots build too. In a break, every BOT_PLAN each bot of the pilots' without a plan
    /// makes one (`plan_build`); it heads there (its order), and once within BOT_BUILD_REACH,
    /// builds, down at the spot. A wave on, plans are dropped: it's time to fight.
    fn bots_build(&mut self) {
        let Some(d) = self.defense.as_ref() else { return };
        if !matches!(d.stage, defense::Stage::Break { .. }) {
            self.defense.as_mut().unwrap().plans.clear();
            return;
        }
        if self.tick % secs(BOT_PLAN) == 0 {
            let bots: Vec<u8> = self.players.iter().filter(|p| p.team == 0 && p.bot.is_some() && p.mech.health > 0.0 && !d.plans.iter().any(|q| q.0 == p.id)).map(|p| p.id).collect();
            for id in bots {
                if let Some(plan) = self.plan_build(id) {
                    self.defense.as_mut().unwrap().plans.push((id, plan.0, plan.1));
                }
            }
        }
        let plans = self.defense.as_ref().unwrap().plans.clone();
        for (id, at, order) in plans {
            let Some(p) = self.players.iter().find(|p| p.id == id && p.mech.health > 0.0) else { continue };
            if (p.mech.pos - at).with_y(0.0).length() > BOT_BUILD_REACH {
                continue;
            }
            self.build_along(id, order, &Ray::new(at + Vector::Y * 6.0, Vector::NEG_Y));
            self.defense.as_mut().unwrap().plans.retain(|q| q.0 != id);
        }
    }

    /// What bot `id` would build with its scrap: the tower it can afford the team has fewest of
    /// (for BOT_MIX), on the free spot BOT_SPOTS off a lane's line covered by fewest towers (nearer
    /// the reactor first); else the team's lowest tower raised a tier, if it can afford that.
    /// Where it'd stand, and the order.
    fn plan_build(&self, id: u8) -> Option<(Vector, defense::Build)> {
        let d = self.defense.as_ref()?;
        let scrap = d.scrap[usize::from(id)];
        let towers: Vec<Deployable> = self.deployables.iter().filter(|e| d.tower(e.owner).is_some()).copied().collect();
        let count = |kind| towers.iter().filter(|t| t.kind == kind).count() as f32;
        let kind = (0..defense::TOWERS.len()).filter(|&k| d.price_for(id, defense::TOWERS[k]) <= scrap).min_by(|&a, &b| (count(defense::TOWERS[a]) / BOT_MIX[a]).total_cmp(&(count(defense::TOWERS[b]) / BOT_MIX[b])));
        if let Some(k) = kind {
            // Towers and spots already planned crowd a spot alike.
            let taken: Vec<Vector> = towers.iter().map(|t| t.pos).chain(d.plans.iter().filter(|q| matches!(q.2, defense::Build::Place(_))).map(|q| q.1)).collect();
            let mut best: Option<(f32, Vector)> = None;
            for (a, b) in d.segments() {
                let across = (b - a).with_y(0.0).normalize_or_zero().cross(Vector::Y);
                for (f, off) in [0.25f32, 0.75].into_iter().flat_map(|f| BOT_SPOTS.into_iter().flat_map(move |o| [(f, o), (f, -o)])) {
                    let at = self.ground(a.lerp(b, f) + across * off);
                    let Ok(at) = d.spot(&self.arena, &Ray::new(at + Vector::Y * 6.0, Vector::NEG_Y), taken.iter().copied()) else { continue };
                    let score = 100.0 * taken.iter().filter(|t| t.distance(at) < 20.0).count() as f32 + 0.2 * at.distance(d.reactor);
                    if best.is_none_or(|(s, _)| score < s) {
                        best = Some((score, at));
                    }
                }
            }
            if let Some((_, at)) = best {
                return Some((at, defense::Build::Place(k as u8)));
            }
        }
        let low = towers.iter().filter_map(|t| d.tower(t.owner).map(|r| (t, r))).filter(|(t, r)| r.tier < defense::TIERS && r.upgrade(t.kind) <= scrap).min_by_key(|(_, r)| r.tier)?;
        Some((low.0.pos, defense::Build::Upgrade))
    }

    /// Co-op's unarmed lane enemies close in: a crawler with a tower or pilot within CRAWLER_TRIGGER
    /// blows up, CRAWLER_DAMAGE to every tower within CRAWLER_BLAST and CRAWLER_PILOT to every
    /// pilot (no scrap for it); a brute with a tower within BRUTE_REACH rears up (its pitch 1, for
    /// all to see) and BRUTE_WINDUP later smashes the ground, BRUTE_SMASH to every tower and
    /// BRUTE_PILOT to every pilot within its reach, then again after BRUTE_COOLDOWN.
    fn lane_enemies_strike(&mut self) {
        let tick = self.tick;
        let towers: Vec<usize> = (0..self.deployables.len()).filter(|&k| self.defense.as_ref().unwrap().tower(self.deployables[k].owner).is_some()).collect();
        let near = |a: Vector, b: Vector, r: f32| (a - b).with_y(0.0).length() <= r && (a.y - b.y).abs() < 4.0;
        self.shell_towers(&towers);
        self.shield_foes();
        self.bosses_act(&towers);
        for k in 0..self.deployables.len() {
            let e = self.deployables[k];
            if e.hull <= 0.0 || tick < e.ready {
                continue;
            }
            let (trigger, reach) = match e.kind {
                Kind::Crawler => (CRAWLER_TRIGGER, CRAWLER_BLAST),
                Kind::Brute => (BRUTE_REACH, BRUTE_REACH),
                _ => continue,
            };
            let pilots: Vec<usize> = (0..self.players.len()).filter(|&j| self.players[j].team == 0 && self.players[j].mech.health > 0.0).collect();
            let close = towers.iter().any(|&t| near(self.deployables[t].pos, e.pos, trigger)) || (e.kind == Kind::Crawler && pilots.iter().any(|&j| near(self.players[j].mech.pos, e.pos, trigger)));
            let (tower_damage, pilot_damage) = match e.kind {
                Kind::Crawler if close => (CRAWLER_DAMAGE, CRAWLER_PILOT),
                // A brute reared up comes down now; one that isn't yet rears up.
                Kind::Brute if e.pitch > 0.0 => (BRUTE_SMASH, BRUTE_PILOT),
                Kind::Brute if close => {
                    let b = &mut self.deployables[k];
                    (b.pitch, b.ready) = (1.0, tick + secs(BRUTE_WINDUP));
                    continue;
                }
                _ => continue,
            };
            let hit_towers: Vec<usize> = towers.iter().copied().filter(|&t| near(self.deployables[t].pos, e.pos, reach)).collect();
            let hit_pilots: Vec<usize> = pilots.into_iter().filter(|&j| near(self.players[j].mech.pos, e.pos, reach)).collect();
            for t in hit_towers {
                self.wear(t, tower_damage, e.owner);
            }
            for j in hit_pilots {
                self.apply_damage_by(None, j, pilot_damage, Cause::Unknown);
            }
            let e = &mut self.deployables[k];
            match e.kind {
                Kind::Crawler => e.hull = 0.0,
                _ => (e.pitch, e.ready) = (0.0, tick + secs(BRUTE_COOLDOWN)),
            }
        }
    }

    /// Co-op's mortar walkers: one with a tower within MORTAR_RANGE across (and MORTAR_RISE up or
    /// down) digs in (stops on its lane, its pitch 1 for all to see) and every MORTAR_COOLDOWN lobs
    /// a shell at the nearest, landing MORTAR_FLIGHT later where the tower stood (everyone sees
    /// where: dodge it, or not): then MORTAR_DAMAGE to every tower and MORTAR_PILOT to every pilot
    /// within MORTAR_BLAST.
    fn shell_towers(&mut self, towers: &[usize]) {
        let tick = self.tick;
        for k in 0..self.deployables.len() {
            let m = self.deployables[k];
            if m.kind != Kind::Mortar || m.hull <= 0.0 {
                continue;
            }
            let target = towers.iter().map(|&t| self.deployables[t].pos).filter(|t| (*t - m.pos).with_y(0.0).length() <= MORTAR_RANGE && (t.y - m.pos.y).abs() <= MORTAR_RISE).min_by(|a, b| a.distance(m.pos).total_cmp(&b.distance(m.pos)));
            self.deployables[k].pitch = if target.is_some() { 1.0 } else { 0.0 };
            let (Some(at), Some(d)) = (target, self.defense.as_mut()) else { continue };
            d.stun(&[m.owner], tick + 2);
            if tick >= m.ready {
                d.shells.push(defense::Shell { lands: tick + secs(MORTAR_FLIGHT), at, owner: m.owner });
                self.events.push(Event::Shell { from: m.pos + Vector::Y * m.kind.lane_body().1, to: at, flight: MORTAR_FLIGHT });
                self.deployables[k].ready = tick + secs(MORTAR_COOLDOWN);
            }
        }
        let landed: Vec<defense::Shell> = self.defense.as_ref().map_or_else(Vec::new, |d| d.shells.iter().filter(|s| s.lands <= tick).copied().collect());
        if let Some(d) = self.defense.as_mut() {
            d.shells.retain(|s| s.lands > tick);
        }
        let near = |a: Vector, b: Vector| (a - b).with_y(0.0).length() <= MORTAR_BLAST && (a.y - b.y).abs() < 4.0;
        for s in landed {
            let hit: Vec<usize> = towers.iter().copied().filter(|&t| t < self.deployables.len() && near(self.deployables[t].pos, s.at)).collect();
            for t in hit {
                self.wear(t, MORTAR_DAMAGE, s.owner);
            }
            let pilots: Vec<usize> = (0..self.players.len()).filter(|&j| self.players[j].team == 0 && near(self.players[j].mech.pos, s.at)).collect();
            for j in pilots {
                self.apply_damage_by(None, j, MORTAR_PILOT, Cause::Unknown);
            }
        }
    }

    /// Co-op's bosses. The Excavator grinds every tower within EXCAVATOR_REACH (EXCAVATOR_DRILL a
    /// second, EXCAVATOR_GRIND to pilots), and EXCAVATOR_EVERY (first EXCAVATOR_FIRST after it
    /// comes) burrows: UNDERGROUND under its lane for EXCAVATOR_UNDER (out of reach and sight),
    /// rushing on, then bursting up: QUAKE_DAMAGE to every tower within QUAKE_RADIUS, stunned
    /// QUAKE_STUN, and QUAKE_PILOT to pilots. (`burst` 1 while it's under.) The Hive walker breeds
    /// HIVE_BROOD crawlers every HIVE_EVERY, and as it falls past two thirds and a third of its hull
    /// HIVE_BURST more and an EMP stunning every tower within HIVE_EMP for QUAKE_STUN (`burst`'s
    /// bits mark those done).
    fn bosses_act(&mut self, towers: &[usize]) {
        let tick = self.tick;
        // Within reach across, and BOSS_BAND up or down: on a map in storeys, not the floors above.
        let near = |a: Vector, b: Vector, r: f32| (a - b).with_y(0.0).length() <= r && (a.y - b.y).abs() < BOSS_BAND;
        for k in 0..self.deployables.len() {
            let b = self.deployables[k];
            if !b.kind.boss() || b.hull <= 0.0 {
                continue;
            }
            let Some(d) = self.defense.as_mut() else { return };
            let full = d.hull_of(b.kind);
            // (Where, how far, what to every tower and pilot there, and whether it stuns the towers.)
            let mut quake = None;
            let mut brood = 0;
            if b.kind == Kind::Excavator {
                let under = b.burst == 1;
                if !under && tick >= b.placed + secs(EXCAVATOR_FIRST) && tick >= b.ready {
                    let until = tick + secs(EXCAVATOR_UNDER);
                    d.rush(b.owner, until);
                    (self.deployables[k].burst, self.deployables[k].ready) = (1, until);
                    self.events.push(Event::Stun { at: b.pos, radius: 6.0 });
                } else if under && tick >= b.ready {
                    (self.deployables[k].burst, self.deployables[k].ready) = (0, tick + secs(EXCAVATOR_EVERY));
                    let at = b.pos + Vector::Y * UNDERGROUND;
                    quake = Some((at, QUAKE_RADIUS, QUAKE_DAMAGE, QUAKE_PILOT, true));
                } else if !under {
                    quake = Some((b.pos, EXCAVATOR_REACH, EXCAVATOR_DRILL * DT, EXCAVATOR_GRIND * DT, false));
                }
            } else {
                let fell = [2.0 / 3.0, 1.0 / 3.0].iter().enumerate().find(|&(bit, f)| b.hull < f * full && b.burst & (1 << bit) == 0);
                if let Some((bit, _)) = fell {
                    self.deployables[k].burst |= 1 << bit;
                    brood = HIVE_BURST;
                    quake = Some((b.pos, HIVE_EMP, 0.0, 0.0, true));
                } else if tick >= b.ready && tick >= b.placed + secs(HIVE_EVERY) {
                    self.deployables[k].ready = tick + secs(HIVE_EVERY);
                    brood = HIVE_BROOD;
                }
            }
            if brood > 0 {
                let taken: Vec<u8> = self.deployables.iter().map(|e| e.owner).collect();
                let born = self.defense.as_mut().unwrap().brood(b.owner, Kind::Crawler, brood, &taken);
                for (owner, kind, at, hull) in born {
                    self.put_foe(owner, kind, at, hull);
                }
            }
            if let Some((at, reach, tower_damage, pilot_damage, stun)) = quake {
                let hit: Vec<usize> = towers.iter().copied().filter(|&t| t < self.deployables.len() && near(self.deployables[t].pos, at, reach)).collect();
                for t in hit {
                    if stun {
                        let e = &mut self.deployables[t];
                        (e.ready, e.burst) = (e.ready.max(tick + secs(QUAKE_STUN)), 0);
                    }
                    if tower_damage > 0.0 {
                        self.wear(t, tower_damage, b.owner);
                    }
                }
                if pilot_damage > 0.0 {
                    let pilots: Vec<usize> = (0..self.players.len()).filter(|&j| self.players[j].team == 0 && near(self.players[j].mech.pos, at, reach)).collect();
                    for j in pilots {
                        self.apply_damage_by(None, j, pilot_damage, Cause::Unknown);
                    }
                }
                if stun {
                    self.events.push(Event::Stun { at: at + Vector::Y, radius: reach });
                }
            }
        }
    }

    /// Puts down lane enemy `owner` of `kind` with `hull` on the ground under `at`, for the hive.
    fn put_foe(&mut self, owner: u8, kind: Kind, at: Vector, hull: f32) {
        let (pos, tick) = (self.ground(at), self.tick);
        self.deployables.push(Deployable { kind, team: 1, owner, pos, yaw: 0.0, pitch: 0.0, hull, placed: tick, expires: u32::MAX, ready: tick + secs(WALKER_WARMUP), burst: 0 });
    }

    /// Co-op's shield nodes: each throws a dome (the item's, on the hive's side, NODE_DOME hull and
    /// NODE_DOME_STEP more each wave) round itself as it walks, stopping shots crossing it either
    /// way; broken, it's back NODE_RECHARGE later. A node's dome goes with it. (Its owner is the
    /// node's; `burst` 1 marks a node whose dome is up.)
    fn shield_foes(&mut self) {
        let (tick, wave) = (self.tick, self.defense.as_ref().map_or(1, |d| d.wave));
        let nodes: Vec<Deployable> = self.deployables.iter().filter(|n| n.kind == Kind::Node && n.hull > 0.0).copied().collect();
        self.deployables.retain(|d| d.kind != Kind::Dome || d.team != 1 || nodes.iter().any(|n| n.owner == d.owner));
        for n in nodes {
            let dome = self.deployables.iter().position(|d| d.kind == Kind::Dome && d.owner == n.owner && d.hull > 0.0);
            let k = self.deployables.iter().position(|d| d.kind == Kind::Node && d.owner == n.owner).unwrap();
            match dome {
                Some(j) => self.deployables[j].pos = n.pos,
                // Just broken: back in a while.
                None if n.burst == 1 => (self.deployables[k].burst, self.deployables[k].ready) = (0, tick + secs(NODE_RECHARGE)),
                None if tick >= n.ready => {
                    self.deployables.retain(|d| !(d.kind == Kind::Dome && d.owner == n.owner));
                    let hull = NODE_DOME + NODE_DOME_STEP * f32::from(wave);
                    self.deployables.push(Deployable { kind: Kind::Dome, team: 1, owner: n.owner, pos: n.pos, yaw: 0.0, pitch: 0.0, hull, placed: tick, expires: u32::MAX, ready: 0, burst: 0 });
                    self.deployables[k].burst = 1;
                }
                None => {}
            }
        }
    }

    /// Co-op's pylons: each ready one with a walker in reach lets go (see ARC_RANGE, PULSE_RADIUS).
    fn power_pylons(&mut self) {
        let tick = self.tick;
        for k in 0..self.deployables.len() {
            let p = self.deployables[k];
            if !matches!(p.kind, Kind::Arc | Kind::Pulse) || p.hull <= 0.0 || tick < p.ready {
                continue;
            }
            let Some(df) = self.defense.as_ref() else { return };
            let (reach, rate) = (df.reach_of(p.owner), df.rate_of(p.owner));
            let perk = |perk| df.tower_perk(p.owner, perk);
            let (hops, storm, stasis) = (ARC_HOPS + 2 * perk(defense::Perk::Chain) as usize, perk(defense::Perk::Storm), perk(defense::Perk::Stasis));
            let top = p.pos + Vector::Y * PYLON_TOP;
            let arena = &self.arena;
            let walkers: Vec<(usize, Vector)> = (self.deployables.iter().enumerate())
                .filter(|(_, w)| w.kind.lane_enemy() && w.hull > 0.0)
                .map(|(j, w)| (j, w.pos + Vector::Y * (w.kind.lane_body().1 * 0.5)))
                .filter(|&(_, c)| arena.cast_ray(&Ray::new(top, (c - top).normalize_or_zero()), c.distance(top)).is_none())
                .collect();
            if p.kind == Kind::Arc {
                let Some(&first) = walkers.iter().filter(|w| w.1.distance(top) <= ARC_RANGE * reach * (1.0 + 0.3 * storm)).min_by(|a, b| a.1.distance(top).total_cmp(&b.1.distance(top))) else { continue };
                let (mut from, mut at, mut damage, mut struck) = (top, first, ARC_DAMAGE * (1.0 + storm), vec![first.0]);
                for hop in 0..=hops {
                    self.events.push(Event::Zap { from, to: at.1 });
                    self.wear(at.0, damage, p.owner);
                    let next = walkers.iter().filter(|w| !struck.contains(&w.0) && w.1.distance(at.1) <= ARC_HOP).min_by(|a, b| a.1.distance(at.1).total_cmp(&b.1.distance(at.1)));
                    match next {
                        Some(&w) if hop < hops => {
                            (from, at, damage) = (at.1, w, damage * ARC_FALLOFF);
                            struck.push(w.0);
                        }
                        _ => break,
                    }
                }
                self.deployables[k].ready = tick + secs(ARC_COOLDOWN / rate);
            } else {
                let radius = PULSE_RADIUS * reach;
                let hit: Vec<usize> = walkers.iter().filter(|w| (w.1 - p.pos).with_y(0.0).length() <= radius).map(|w| w.0).collect();
                if hit.is_empty() {
                    continue;
                }
                let until = tick + secs(PULSE_STUN * (1.0 + stasis));
                self.events.push(Event::Stun { at: top, radius });
                let owners: Vec<u8> = hit.iter().map(|&j| self.deployables[j].owner).collect();
                for &j in &hit {
                    let w = &mut self.deployables[j];
                    (w.ready, w.burst) = (w.ready.max(until), 0);
                    self.wear(j, PULSE_DAMAGE, p.owner);
                }
                if let Some(d) = self.defense.as_mut() {
                    d.stun(&owners, until);
                }
                // And it pops the hive's domes in reach.
                for e in self.deployables.iter_mut().filter(|e| e.kind == Kind::Dome && e.team == 1 && (e.pos - p.pos).with_y(0.0).length() <= radius) {
                    e.hull = 0.0;
                }
                self.deployables[k].ready = tick + secs(PULSE_COOLDOWN / rate / (1.0 + 0.3 * stasis));
            }
        }
    }

    /// The ground under `at`, from a little over it (so the hauler walks slopes and steps).
    fn ground(&self, at: Vector) -> Vector {
        self.arena.cast_ray(&Ray::new(at + Vector::Y * 4.0, Vector::NEG_Y), 8.0).map_or(at, |d| at + Vector::Y * (4.0 - d))
    }

    /// Whether feet at `feet` are somewhere a mech can get to: ground under them, and a waypoint near.
    fn reachable(&self, feet: Vector) -> bool {
        let ground = self.arena.cast_ray(&Ray::new(feet + Vector::Y * 0.5, Vector::NEG_Y), 60.0).is_some();
        ground && self.nav.points().iter().any(|w| w.distance(feet) <= FLAG_REACH)
    }
}

/// Whether player `q` is camouflaged: out of sight of bots, turrets and lock-on.
/// ponytail: snapshots still carry a hidden mech's position, so a hacked client can show it;
/// leave it out of others' snapshots if that's ever abused.
fn cloaked(q: &Player) -> bool {
    ability::on(&q.mech, Ability::Cloak)
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

/// Which of `spawns` is farthest from the nearest of `foes` (with none, the last).
fn farthest(spawns: impl Iterator<Item = Vector>, foes: &[Vector]) -> Vector {
    let threat = |spawn: Vector| foes.iter().map(|f| f.distance(spawn)).fold(f32::MAX, f32::min);
    spawns.max_by(|a, b| threat(*a).total_cmp(&threat(*b))).expect("maps have spawns")
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

/// What a shot by `team` stopping at `end` wears down: the `turret` it hit, or else, hitting no
/// mech, the other side's dome or barrier it landed on.
fn worn(list: &[Deployable], t: &Tuning, team: u8, turret: Option<(usize, f32)>, hit_mech: bool, end: Vector) -> Option<usize> {
    match turret {
        Some((k, _)) => Some(k),
        None if hit_mech => None,
        None => deploy::struck(list, t, team, end),
    }
}

/// The kind of deployable `owner` in `list`, if there is one.
fn attacker_kind(list: &[Deployable], owner: u8) -> Option<Kind> {
    list.iter().find(|d| d.owner == owner).map(|d| d.kind)
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
mod probe;

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

    /// The matches `deck` deals over `rounds` decks' worth from `seed`, without loading each map
    /// (only the order matters), checking no map comes twice in a row.
    fn deal(deck: &[(Mode, usize)], seed: u64, rounds: usize) -> Vec<(Mode, usize)> {
        let mut game = Game::new(Tuning::default(), deck[0].1);
        game.rotate(deck.to_vec(), seed);
        let mut played = vec![(game.mode, game.map)];
        for _ in 1..deck.len() * rounds {
            game.end_match();
            assert_ne!(game.next.1, game.map, "seed {seed}: the same map twice in a row: {played:?}");
            (game.mode, game.map) = game.next;
            played.push(game.next);
        }
        played
    }

    #[test]
    fn rotation_plays_every_map_before_any_repeats() {
        let maps: Vec<(Mode, usize)> = crate::map::ROTATION.iter().map(|name| (Mode::TeamDeathmatch, Map::index(name).unwrap())).collect();
        for seed in [1, 42, 0xdead_beef, 1_792_656_822_821_000_000] {
            let played = deal(&maps, seed, 4);
            for deck in played.chunks(maps.len()) {
                let mut seen = deck.to_vec();
                seen.sort_by_key(|&(_, m)| m);
                seen.dedup();
                assert_eq!(seen.len(), maps.len(), "seed {seed}: a deck missed a map: {played:?}");
            }
        }
        // Modes in turn too, some maps in two: each pair still comes round about once a deck.
        let small = ["isotope", "sump", "sinkhole"].map(|name| (Mode::Deathmatch, Map::index(name).unwrap()));
        let mixed: Vec<(Mode, usize)> = maps.iter().copied().chain(small).collect();
        for seed in [1, 42, 0xdead_beef] {
            let played = deal(&mixed, seed, 6);
            for pair in &mixed {
                let n = played.iter().filter(|p| *p == pair).count();
                assert!((5..=7).contains(&n), "seed {seed}: {pair:?} played {n} times in 6 decks");
            }
        }
    }

    #[test]
    fn team_matches_open_penned_in_the_spawns() {
        let mut game = Game::new(Tuning::default(), Map::index("isotope").unwrap());
        game.staging_seconds = STAGING_SECONDS;
        game.step(); // an empty room holds the opening till someone comes
        let id = game.join().unwrap();
        let out_of_pen = |game: &Game, p: &Player| {
            let (c, r) = game.arena.pens[usize::from(p.team)];
            (p.mech.pos - c).with_y(0.0).length() - r
        };
        // We hover and boost for the other side: the pen holds us at its wall, and the bots wait.
        let rush = Input { move_z: 1.0, boost: true, hover: true, ..Input::default() };
        for _ in 0..secs(STAGING_SECONDS) - 2 {
            send(&mut game, id, rush);
            game.step();
            let s = game.match_state();
            assert!(s.staging && !s.ended && s.seconds_left <= STAGING_SECONDS as u16);
            for p in &game.players {
                assert!(out_of_pen(&game, p) < -game.arsenal.of(&p.mech).mech_radius + 0.01, "{} left its pen", p.name);
                let last = p.bot.as_ref().map(|b| b.last);
                assert!(last.is_none_or(|i| i.move_x == 0.0 && i.move_z == 0.0 && !i.fire && !i.alt_fire), "{} didn't wait", p.name);
            }
        }
        let me = game.players.iter().find(|p| p.id == id).unwrap();
        assert!(out_of_pen(&game, me) > -2.0, "never reached the wall");
        let waited: std::collections::HashMap<u8, Vector> = game.players.iter().map(|p| (p.id, p.mech.pos)).collect();
        // Then the pens open, the clock starts, and everyone heads out.
        for _ in 0..secs(10.0) {
            send(&mut game, id, rush);
            game.step();
        }
        let s = game.match_state();
        assert!(!s.staging && !game.arena.penned && s.seconds_left > (game.match_seconds - 10.0) as u16);
        let me = game.players.iter().find(|p| p.id == id).unwrap();
        assert!(out_of_pen(&game, me) > 0.0, "still penned");
        for p in game.players.iter().filter(|p| p.bot.is_some()) {
            assert!(p.mech.pos.distance(waited[&p.id]) > 5.0, "{} stayed put", p.name);
        }
        // Deathmatch plays at once, and so does co-op (it has its own break to build in).
        for mode in [Mode::Deathmatch, Mode::Defense] {
            game.set_mode(mode);
            game.start_match();
            assert!(!game.match_state().staging && !game.arena.penned, "{mode:?}");
        }
    }

    #[test]
    fn matches_rotate_to_another_map() {
        let (foundry, isotope) = (Map::index("foundry").unwrap(), Map::index("isotope").unwrap());
        let mut game = Game::new(Tuning::default(), foundry);
        game.bots = false;
        let id = game.join().unwrap();
        // Without a rotation it stays put.
        game.end_match();
        (0..=secs(POST_MATCH_SECONDS)).for_each(|_| game.step());
        assert_eq!(game.map, foundry);

        game.rotate(vec![(Mode::TeamDeathmatch, foundry), (Mode::TeamDeathmatch, isotope)], 42);
        game.end_match();
        let s = game.snapshot(id).state;
        assert_eq!((s.map, s.next_map), (foundry as u8, isotope as u8), "the next map isn't announced");
        (0..=secs(POST_MATCH_SECONDS)).for_each(|_| game.step());
        assert_eq!((game.map, game.snapshot(id).state.map), (isotope, isotope as u8));
        let pos = mech(&game, id).pos;
        let spawns = Map::load(isotope).spawns;
        assert!(spawns.iter().flatten().any(|p| Vector::from_array(*p).distance(pos) < 1.0), "not on an Isotope spawn: {pos}");
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
        // Kill credit: the helper's 40%, the killer's 60% plus the bonus; the helper hears of it.
        assert!((k.kill_credit - 0.85).abs() < 1e-4, "killer's credit {}", k.kill_credit);
        let points = |id| game.players.iter().find(|p| p.id == id).unwrap().points;
        assert!((points(killer) - 85.0).abs() < 0.01 && (points(helper) - 40.0).abs() < 0.01, "points {} {}", points(killer), points(helper));
        assert!(game.events.iter().any(|e| matches!(e, Event::Kill { assists, .. } if *assists == 1 << helper)), "{:?}", game.events);
    }

    #[test]
    fn a_sliver_of_the_damage_earns_credit_but_no_assist() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let (killer, chip, victim) = (game.join().unwrap(), game.join().unwrap(), game.join().unwrap());
        let at = |game: &Game, id| game.players.iter().position(|p| p.id == id).unwrap();
        unshield(&mut game);
        let v = at(&game, victim);
        game.players[v].mech.health = 100.0;
        game.apply_damage(Some(at(&game, chip)), v, 10.0);
        game.apply_damage(Some(at(&game, killer)), v, 1e3);
        let c = &game.players[at(&game, chip)];
        assert_eq!((c.tally.stats.assists, c.points.round()), (0, 10.0));
        assert!(game.events.iter().any(|e| matches!(e, Event::Kill { assists: 0, .. })));
    }

    /// A Deathmatch on Sump (small enough for one), bots on, with one human in it.
    fn deathmatch() -> (Game, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("sump").unwrap());
        game.mode = Mode::Deathmatch;
        let id = game.join().unwrap();
        game.step();
        (game, id)
    }

    #[test]
    fn deathmatch_puts_everyone_on_their_own_team() {
        let (mut game, _) = deathmatch();
        assert_eq!(game.players.len(), MAX_PLAYERS);
        assert!(game.players.iter().all(|p| p.team == p.id), "teams aren't ids");
        // Everyone starts on a spawn of their own.
        for p in &game.players {
            assert!(game.players.iter().all(|q| q.id == p.id || q.mech.pos.distance(p.mech.pos) > 1.0), "two on one spawn");
        }
        // Humans take bots' places until there are none left.
        for _ in 1..MAX_PLAYERS {
            assert!(game.join().is_some());
        }
        assert_eq!((game.join(), game.headcount()), (None, (MAX_PLAYERS, 0)));
    }

    #[test]
    fn deathmatch_starts_everyone_apart() {
        let (mut game, _) = deathmatch();
        game.start_match();
        let pos: Vec<Vector> = game.players.iter().map(|p| p.mech.pos).collect();
        let closest = pos.iter().enumerate().flat_map(|(i, a)| pos[i + 1..].iter().map(|b| a.distance(*b))).fold(f32::MAX, f32::min);
        assert!(closest > 40.0, "two start {closest} m apart");
    }

    /// A Missile Assault on Foundry, with one human in it (and bots, if `bots`).
    fn assault(bots: bool) -> (Game, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("foundry").unwrap());
        (game.mode, game.bots) = (Mode::MissileAssault, bots);
        let id = game.join().unwrap();
        game.step();
        (game, id)
    }

    #[test]
    fn standing_on_a_silo_takes_it_and_credits_the_taker() {
        let (mut game, id) = assault(false);
        let a = game.assault.as_ref().expect("Foundry has silos").silos[0].rally[0];
        let me = game.players.iter().position(|p| p.id == id).unwrap();
        game.players[me].mech.pos = a;
        let mut captured = false;
        for _ in 0..secs(10.0) {
            game.players[me].mech.pos = a;
            game.step();
            captured |= game.events.iter().any(|e| matches!(e, Event::Captured { zone: 0, team: 0 }));
        }
        assert!(captured, "{:?}", game.snapshot(id).zones);
        let p = &game.players[me];
        assert_eq!((p.points, p.tally.stats.captures), (CAPTURE_POINTS, 1));
        assert_eq!(game.snapshot(id).zones[0].owner, Some(0));
        // A held silo fires on the other base; the missile lands after its flight.
        let mut fired = false;
        for _ in 0..secs(11.0) {
            game.step();
            fired |= game.events.iter().any(|e| matches!(e, Event::Missile { silo: 0, team: 0 }));
        }
        assert!(fired, "no missile");
        assert_eq!(game.match_state().scores, [objective::BASE_HULL as u16; 2]);
        (0..secs(objective::MISSILE_FLIGHT)).for_each(|_| game.step());
        assert!(game.match_state().scores[1] < objective::BASE_HULL as u16);
    }

    #[test]
    fn a_fallen_base_ends_missile_assault() {
        let (mut game, _) = assault(false);
        game.assault.as_mut().unwrap().hull[1] = 0.0;
        game.step();
        let state = game.match_state();
        assert!(state.ended && state.winner == Some(0), "{state:?}");
    }

    #[test]
    fn bots_take_silos_on_their_own() {
        let (mut game, _) = assault(true);
        let owned = |game: &Game| game.assault.as_ref().unwrap().silos.iter().filter(|z| z.state.owner.is_some()).count();
        for _ in 0..secs(60.0) {
            game.step();
            if owned(&game) >= 2 {
                return;
            }
        }
        panic!("bots took {} silos in a minute", owned(&game));
    }

    #[test]
    fn bots_contesting_a_silo_out_of_sight_go_after_each_other() {
        // Foundry's middle silo has a block in its middle. A bot of each side held a rally spot on
        // either side of it, each knowing the other was there, and both stood: contested for good.
        let (mut game, human) = assault(false);
        game.dock(human);
        let a = game.add_player(0, Some(Bot::with_skill(1, 0.9)), MechClass::B).unwrap();
        let b = game.add_player(1, Some(Bot::with_skill(2, 0.9)), MechClass::B).unwrap();
        unshield(&mut game);
        let (pa, pb, tick) = (Vector::new(0.0, 0.1, 13.0), Vector::new(0.0, 0.1, -13.0), game.tick);
        for (id, pos, other, at) in [(a, pa, b, pb), (b, pb, a, pa)] {
            let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
            p.mech.pos = pos;
            p.bot.as_mut().unwrap().told(other, at, tick);
        }
        let (ma, mb) = (mech(&game, a), mech(&game, b));
        assert!(!bot::sees(&game.arena, game.arsenal.of(&ma), &ma, &mb), "in sight across the silo");
        let fought = (0..secs(10.0)).any(|_| {
            game.step();
            game.players.iter().any(|p| p.tally.dealt > 0.0)
        });
        let zone = &game.assault.as_ref().unwrap().silos[1];
        assert!(fought, "no shot in 10 s, silo {:?}, at {} and {}", zone.state, mech(&game, a).pos, mech(&game, b).pos);
    }

    #[test]
    fn headless_bots_play_on_and_tally_the_damage() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        (game.headless, game.match_seconds) = (true, 40.0);
        for seat in 0..MAX_PLAYERS as u64 {
            game.add_bot((seat % 2) as u8, Bot::new(seat), MechClass::ALL[seat as usize % 3]).unwrap();
        }
        while !game.match_state().ended {
            game.step();
        }
        let tallies: Vec<&Tally> = game.players.iter().map(|p| &p.tally).collect();
        let (dealt, taken): (f32, f32) = (tallies.iter().map(|t| t.dealt).sum(), tallies.iter().map(|t| t.taken).sum());
        assert_eq!(game.players.len(), MAX_PLAYERS, "no one cleared out for want of a human");
        assert!(dealt > 0.0, "no one hit anyone");
        // Every hull point dealt was taken by someone; base guns' and turrets' with no owner here
        // are only taken.
        assert!(dealt <= taken + 1e-3, "dealt {dealt} > taken {taken}");
        // Every hull point dealt is put down to a slot; guns fired; and bots logged what they did.
        let by_slot: f32 = tallies.iter().flat_map(|t| t.dealt_by).sum();
        assert!((by_slot - dealt).abs() < 1e-2 * dealt, "by slot {by_slot}, dealt {dealt}");
        assert!(tallies.iter().all(|t| t.uses[0] > 0 && t.doing.iter().sum::<u32>() > 0), "a bot that never fired or did nothing");
        assert!(tallies.iter().any(|t| t.uses[4] > 0), "no ability used");
    }

    /// A Siege on Foundry, with one human in it (and bots, if `bots`).
    fn siege(bots: bool) -> (Game, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("foundry").unwrap());
        (game.mode, game.bots) = (Mode::Siege, bots);
        let id = game.join().unwrap();
        game.step();
        (game, id)
    }

    #[test]
    fn energy_carried_home_launches_a_ship_that_goes_down_when_shot() {
        let (mut game, id) = siege(false);
        let me = game.players.iter().position(|p| p.id == id).unwrap();
        let (station, base) = { let s = game.siege.as_ref().unwrap(); (s.stations[0].0.rally[0], s.bases[0]) };
        // Fill up at a station, then walk it home.
        for _ in 0..secs(6.0) {
            game.players[me].mech.pos = station;
            game.step();
        }
        assert_eq!(game.players[me].eu, siege::CARRY_MAX);
        assert_eq!(game.snapshot(id).players.iter().find(|p| p.id == id).unwrap().eu, 100);
        game.players[me].mech.pos = base;
        game.step();
        let s = game.siege.as_ref().unwrap();
        assert!(s.banks[0] >= siege::CARRY_MAX && game.players[me].eu == 0.0, "bank {}", s.banks[0]);
        assert!((game.players[me].points - EU_POINTS * siege::CARRY_MAX).abs() < 0.01);
        // A full bank launches the ship.
        game.siege.as_mut().unwrap().banks[0] = siege::LAUNCH_EU;
        game.step();
        assert!(game.events.iter().any(|e| matches!(e, Event::Ship { team: 0, up: true })));
        let k = game.deployables.iter().position(|d| d.kind == Kind::Ship).expect("a ship");
        assert_eq!((game.deployables[k].team, game.deployables[k].pos.y), (0, 55.0));
        let z = game.deployables[k].pos.z;
        game.step();
        assert!(game.deployables[k].pos.z < z, "it flies at the enemy base");
        // Shot down (by a player of the other team, for credit): it says so as it goes.
        let foe = game.add_player(1, None, MechClass::B).unwrap();
        game.wear(k, siege::SHIP_HULL, foe);
        let shooter = game.players.iter().find(|p| p.id == foe).unwrap();
        assert!((shooter.points - SHIP_POINTS * siege::SHIP_HULL).abs() < 0.01);
        game.step();
        assert!(game.deployables.iter().all(|d| d.kind != Kind::Ship));
        assert!(game.events.iter().any(|e| matches!(e, Event::Ship { team: 0, up: false })), "{:?}", game.events);
    }

    #[test]
    fn a_fallen_mech_drops_its_energy_and_a_fallen_base_ends_siege() {
        let (mut game, id) = siege(false);
        let foe = game.add_player(1, None, MechClass::B).unwrap();
        unshield(&mut game);
        let (me, them) = (game.players.iter().position(|p| p.id == id).unwrap(), game.players.iter().position(|p| p.id == foe).unwrap());
        game.players[me].eu = 60.0;
        game.apply_damage(Some(them), me, 1e3);
        let drops = &game.siege.as_ref().unwrap().drops;
        assert_eq!((drops.len(), drops[0].eu, game.players[me].eu), (1, 60.0, 0.0));
        game.siege.as_mut().unwrap().hull[0] = 0.0;
        game.step();
        let state = game.match_state();
        assert!(state.ended && state.winner == Some(1), "{state:?}");
    }

    /// A Capture the Flag match on Foundry, with its stands at the bases, and a human in it.
    fn capture_the_flag() -> (Game, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("foundry").unwrap());
        (game.mode, game.bots) = (Mode::CaptureTheFlag, false);
        let stand = |at: [f32; 3]| crate::map::ZoneSpot { at, radius: 5.0, band: 3.0, pad: None };
        game.spots.flags = Some(game.spots.bases.unwrap().map(stand));
        let id = game.join().unwrap();
        game.step();
        (game, id)
    }

    #[test]
    fn a_flag_taken_off_the_enemy_stand_and_carried_home_scores_and_three_win() {
        let (mut game, id) = capture_the_flag();
        unshield(&mut game);
        let me = game.players.iter().position(|p| p.id == id).unwrap();
        let (team, stands) = (game.players[me].team, game.spots.bases.unwrap().map(Vector::from_array));
        let (ours, theirs) = (stands[usize::from(team)], stands[usize::from(1 - team)]);
        // Standing there, whatever their base guns do.
        let hold = |game: &mut Game, at: Vector, seconds: f32| {
            for _ in 0..secs(seconds) {
                game.players[me].mech.pos = at;
                game.players[me].mech.health = 100.0;
                game.step();
            }
        };
        hold(&mut game, theirs, ctf::TAKE_SECONDS + 0.2);
        assert_eq!(game.ctf.as_ref().unwrap().carried_by(id), Some(1 - team));
        assert!(game.players[me].mech.laden, "a carrier isn't laden");
        let points = game.players[me].points;
        hold(&mut game, ours, 0.1);
        assert_eq!(game.ctf.as_ref().unwrap().captures[usize::from(team)], 1);
        assert!(!game.players[me].mech.laden);
        assert!((game.players[me].points - points - FLAG_CAPTURE_POINTS).abs() < 0.01);
        assert_eq!(game.match_state().scores[usize::from(team)], 1);
        game.ctf.as_mut().unwrap().captures[usize::from(team)] = ctf::CAPTURES_TO_WIN - 1;
        hold(&mut game, theirs, ctf::TAKE_SECONDS + 0.2);
        hold(&mut game, ours, 0.1);
        let state = game.match_state();
        assert!(state.ended && state.winner == Some(team), "{state:?}");
    }

    #[test]
    fn a_fallen_carrier_drops_the_flag_unless_it_fell_out_of_reach() {
        let (mut game, id) = capture_the_flag();
        let foe = game.add_player(1, None, MechClass::B).unwrap();
        unshield(&mut game);
        let (me, them) = (game.players.iter().position(|p| p.id == id).unwrap(), game.players.iter().position(|p| p.id == foe).unwrap());
        let flag = 1 - game.players[me].team;
        game.ctf.as_mut().unwrap().flags[usize::from(flag)] = ctf::Flag::Carried { by: id };
        game.apply_damage(Some(them), me, 1e3);
        assert!(matches!(game.ctf.as_ref().unwrap().flags[usize::from(flag)], ctf::Flag::Dropped { .. }));
        assert!(game.events.iter().any(|e| matches!(e, Event::Flag { team, what: Happened::Dropped, by } if *team == flag && *by == Some(id))));
        // The foe carries it; it falls with them into the void.
        game.ctf.as_mut().unwrap().flags[usize::from(flag)] = ctf::Flag::Carried { by: foe };
        game.players[them].mech.pos = Vector::new(0.0, -200.0, 0.0);
        game.apply_damage(Some(me), them, 1e3);
        assert_eq!(game.ctf.as_ref().unwrap().flags[usize::from(flag)], ctf::Flag::Home);
    }

    /// A Convoy match on Foundry along a straight route from base to base, and a human in it.
    fn convoy_match() -> (Game, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("foundry").unwrap());
        (game.mode, game.bots) = (Mode::Convoy, false);
        let points = vec![[0.0, 0.0, 100.0], [0.0, 0.0, 0.0], [0.0, 0.0, -100.0]];
        game.spots.convoy = Some(crate::map::Route { points, start: 1 });
        let id = game.join().unwrap();
        game.step();
        (game, id)
    }

    fn hauler(game: &Game) -> Deployable {
        *game.deployables.iter().find(|d| d.kind == Kind::Hauler).expect("no hauler")
    }

    #[test]
    fn escorts_walk_the_hauler_and_delivering_it_wins() {
        let (mut game, id) = convoy_match();
        unshield(&mut game);
        let me = game.players.iter().position(|p| p.id == id).unwrap();
        let team = game.players[me].team;
        let walk = |game: &mut Game, seconds: f32| {
            for _ in 0..secs(seconds) {
                game.players[me].mech.pos = hauler(game).pos + Vector::X * 6.0;
                game.players[me].mech.health = 100.0;
                game.step();
            }
        };
        let start = hauler(&game).pos;
        walk(&mut game, 2.0);
        // (Across: it rides the ground up and down on the way.)
        let moved = (hauler(&game).pos - start).with_y(0.0);
        // Toward the other team's base (team 0 pushes toward -z), at one escort's pace.
        assert!(moved.z * if team == 0 { -1.0 } else { 1.0 } > 0.0, "{moved}");
        assert!((moved.length() - 2.0 * 0.75 * convoy::SPEED).abs() < 0.3, "{}", moved.length());
        assert!(game.match_state().scores[usize::from(team)] > 0);
        assert!(game.players[me].points > 0.0);
        // Nearly there.
        let c = game.convoy.as_mut().unwrap();
        c.along = if team == 0 { c.length() - 1.0 } else { 1.0 };
        walk(&mut game, 1.0);
        let state = game.match_state();
        assert!(state.ended && state.winner == Some(team), "{state:?}");
    }

    #[test]
    fn a_hauler_shot_through_stalls_then_walks_on() {
        let (mut game, id) = convoy_match();
        unshield(&mut game);
        let me = game.players.iter().position(|p| p.id == id).unwrap();
        let k = game.deployables.iter().position(|d| d.kind == Kind::Hauler).unwrap();
        game.wear(k, convoy::SHIELD, id);
        let (at, shot) = (hauler(&game).pos, game.tick);
        let mut news = Vec::new();
        while game.tick < shot + secs(convoy::STALL_SECONDS + 1.0) {
            game.players[me].mech.pos = hauler(&game).pos + Vector::X * 6.0;
            game.step();
            news.extend(game.events.iter().filter_map(|e| if let Event::Convoy(n) = e { Some(*n) } else { None }));
            if game.tick < shot + secs(convoy::STALL_SECONDS) - 1 {
                assert_eq!(hauler(&game).pos, at, "walked while stalled");
            }
        }
        assert!(news.starts_with(&[News::Stalled, News::Rebooted]), "{news:?}");
        assert_eq!(hauler(&game).hull, convoy::SHIELD);
        assert_ne!(hauler(&game).pos, at, "didn't walk on");
    }

    #[test]
    fn mechs_bump_into_the_hauler() {
        let (mut game, id) = convoy_match();
        let me = game.players.iter().position(|p| p.id == id).unwrap();
        game.players[me].mech.pos = hauler(&game).pos + Vector::X;
        game.step();
        let (th, body) = deploy::hauler_body(items(&game.arsenal), &hauler(&game));
        let m = &game.players[me].mech;
        assert!(collide::contact(game.arsenal.of(m), m, &th, &body).is_none(), "inside it: {}", (m.pos - body.pos).with_y(0.0).length());
    }

    /// A co-op run on Foundry (its stand-in gates), a human in it; `bots` to fill the team.
    fn co_op(bots: bool) -> (Game, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("foundry").unwrap());
        (game.mode, game.bots) = (Mode::Defense, bots);
        let id = game.join().unwrap();
        game.step();
        (game, id)
    }

    /// Skips the break before the next wave.
    fn skip_break(game: &mut Game) {
        let tick = game.tick;
        game.defense.as_mut().unwrap().stage = defense::Stage::Break { until: tick };
    }

    fn walkers(game: &Game) -> Vec<Deployable> {
        game.deployables.iter().filter(|d| d.kind.lane_enemy() && d.hull > 0.0).copied().collect()
    }

    #[test]
    fn co_op_puts_everyone_on_one_team_with_no_base_guns() {
        let (mut game, id) = co_op(true);
        let me = game.players.iter().find(|p| p.id == id).unwrap();
        assert_eq!(me.team, 0);
        for _ in 0..5 {
            game.step();
        }
        assert_eq!((game.team_count(0), game.team_count(1)), (TEAM_SIZE, 0), "bots fill only the pilots' team");
        assert!(game.deployables.iter().all(|d| d.kind != Kind::Sentry));
        assert!(Mode::Defense.fits(&Map::load(Map::index("hivewall").unwrap())) && !Mode::Defense.versus());
        assert!(!Mode::Defense.fits(&Map::load(Map::index("foundry").unwrap())), "Foundry's stand-in co-op data is for tests");
    }

    #[test]
    fn walkers_come_through_the_gates_and_those_that_reach_the_reactor_hit_it() {
        let (mut game, _) = co_op(false);
        skip_break(&mut game);
        for _ in 0..secs(3.0) {
            game.step();
        }
        let first = walkers(&game);
        assert!(!first.is_empty() && first.iter().all(|w| w.team == 1 && w.hull > 0.0));
        let reactor = game.defense.as_ref().unwrap().reactor;
        let start = first[0].pos.distance(reactor);
        // Nobody stops them.
        let mut hit = false;
        for _ in 0..secs(120.0) {
            game.step();
            hit |= game.events.iter().any(|e| matches!(e, Event::Defense(defense::News::Hit)));
        }
        assert!(hit, "none reached the reactor from {start} m");
        assert!(game.defense.as_ref().unwrap().hull < defense::REACTOR_HULL);
    }

    #[test]
    fn shooting_down_a_wave_clears_it_and_the_reactor_falling_loses_the_run() {
        let (mut game, id) = co_op(false);
        skip_break(&mut game);
        for _ in 0..secs(12.0) {
            game.step();
            // Each walker shot down as it comes.
            let standing: Vec<usize> = (0..game.deployables.len()).filter(|&k| game.deployables[k].kind.lane_enemy()).collect();
            for k in standing {
                game.wear(k, 1e4, id);
            }
        }
        game.step();
        let d = game.defense.as_ref().unwrap();
        assert!(matches!(d.stage, defense::Stage::Break { .. }) && d.wave == 2, "{:?} wave {}", d.stage, d.wave);
        assert!(game.players.iter().find(|p| p.id == id).unwrap().points > 0.0);
        // Down to one hit: the next walker in loses it.
        game.defense.as_mut().unwrap().hull = defense::LEAK;
        skip_break(&mut game);
        for _ in 0..secs(150.0) {
            game.step();
            if game.match_state().ended {
                break;
            }
        }
        let state = game.match_state();
        assert!(state.ended && state.winner == Some(1), "{state:?}");
    }

    /// Stands player `id` somewhere looking down at ground they could build on, among spots
    /// `near` (nearest first) at least `from` m from it; where the tower would go.
    fn aim_to_build(game: &mut Game, id: u8, near: Vector, from: f32) -> Vector {
        let i = game.players.iter().position(|p| p.id == id).unwrap();
        for r in (0..40).map(|k| from + k as f32) {
            for a in (0..24).map(|k| k as f32 * std::f32::consts::TAU / 24.0) {
                let feet = game.ground(near + Vector::new(r * a.cos(), 4.0, r * a.sin()));
                let m = &mut game.players[i].mech;
                (m.pos, m.yaw, m.pitch) = (feet, 0.0, -1.2);
                let aim = aim_ray(game.arsenal.of(&game.players[i].mech), &game.players[i].mech);
                let towers = game.deployables.iter().filter(|e| game.defense.as_ref().unwrap().tower(e.owner).is_some()).map(|e| e.pos);
                if let Ok(at) = game.defense.as_ref().unwrap().spot(&game.arena, &aim, towers) {
                    return at;
                }
            }
        }
        panic!("nowhere to build near {near}");
    }

    fn towers(game: &Game) -> Vec<Deployable> {
        game.deployables.iter().filter(|d| game.defense.as_ref().unwrap().tower(d.owner).is_some()).copied().collect()
    }

    fn scrap(game: &Game, id: u8) -> f32 {
        game.defense.as_ref().unwrap().scrap[usize::from(id)]
    }

    fn refused(game: &Game) -> Option<defense::Refusal> {
        game.events.iter().find_map(|e| if let Event::Defense(defense::News::Refused { why, .. }) = e { Some(*why) } else { None })
    }

    #[test]
    fn pilots_build_towers_for_scrap_off_the_lanes_and_apart() {
        let (mut game, id) = co_op(false);
        let reactor = game.defense.as_ref().unwrap().reactor;
        let start = scrap(&game, id);
        let at = aim_to_build(&mut game, id, reactor, 14.0);
        game.build(id, defense::Build::Place(0));
        let built = towers(&game);
        assert_eq!(built.len(), 1, "{:?}", refused(&game));
        assert!(built[0].pos.distance(at) < 0.01 && built[0].kind == Kind::MgTurret && built[0].team == 0 && built[0].hull == defense::TOWER_HULL);
        assert_eq!(scrap(&game, id), start - defense::PRICES[0]);
        // Not on top of it, and not in a lane.
        game.events.clear();
        game.build(id, defense::Build::Place(0));
        assert_eq!(refused(&game), Some(defense::Refusal::Crowded));
        let gate = Vector::from_array(game.spots.defense.as_ref().unwrap().gates[0]);
        let i = game.players.iter().position(|p| p.id == id).unwrap();
        let m = &mut game.players[i].mech;
        (m.pos, m.yaw, m.pitch) = (gate, 0.0, -1.2);
        game.events.clear();
        game.build(id, defense::Build::Place(0));
        assert_eq!(refused(&game), Some(defense::Refusal::Lane));
        // Not without the scrap.
        game.defense.as_mut().unwrap().scrap[usize::from(id)] = 10.0;
        aim_to_build(&mut game, id, reactor, 14.0);
        game.events.clear();
        game.build(id, defense::Build::Place(1));
        assert_eq!((refused(&game), towers(&game).len()), (Some(defense::Refusal::Scrap), 1));
    }

    #[test]
    fn anyone_upgrades_a_tower_and_its_builder_sells_it() {
        let (mut game, id) = co_op(false);
        let other = game.join().unwrap();
        let reactor = game.defense.as_ref().unwrap().reactor;
        aim_to_build(&mut game, id, reactor, 14.0);
        game.build(id, defense::Build::Place(1));
        let tower = towers(&game)[0];
        // The other pilot, where the builder stood, raises it twice, then no more.
        let me = game.players.iter().find(|p| p.id == id).unwrap().mech;
        let j = game.players.iter().position(|p| p.id == other).unwrap();
        game.players[j].mech = Mech { pos: me.pos, yaw: me.yaw, pitch: me.pitch, health: 100.0, ..game.players[j].mech };
        let before = scrap(&game, other);
        game.defense.as_mut().unwrap().scrap[usize::from(other)] = 1000.0;
        game.build(other, defense::Build::Upgrade);
        game.build(other, defense::Build::Upgrade);
        let d = game.defense.as_ref().unwrap();
        let t = *d.tower(tower.owner).unwrap();
        assert_eq!(t.tier, 3);
        assert!((scrap(&game, other) - (1000.0 - 3.0 * defense::UPGRADE * defense::PRICES[1])).abs() < 1e-3, "{before}");
        assert_eq!(towers(&game)[0].hull, defense::tower_hull(3));
        game.events.clear();
        game.build(other, defense::Build::Upgrade);
        assert_eq!(refused(&game), Some(defense::Refusal::Full));
        // Only its builder sells it, for most of what went into it.
        game.events.clear();
        game.build(other, defense::Build::Sell);
        assert_eq!(refused(&game), Some(defense::Refusal::Tower));
        let had = scrap(&game, id);
        game.build(id, defense::Build::Sell);
        assert!(towers(&game).is_empty());
        // (Of what it cost them: the other pilot's upgrades are theirs to lose.)
        assert!((scrap(&game, id) - had - 0.7 * defense::PRICES[1]).abs() < 1e-3, "{}", scrap(&game, id) - had);
        assert!(t.spent > t.own);
    }

    #[test]
    fn towers_shoot_walkers_down_for_their_builders_scrap_and_walkers_shoot_back() {
        let (mut game, id) = co_op(false);
        // A rocket tower by the lane of the gate open first, the wave on.
        let first = game.defense.as_ref().unwrap().open_gates(1)[0];
        let gate = Vector::from_array(game.spots.defense.as_ref().unwrap().gates[first]);
        aim_to_build(&mut game, id, gate + Vector::new(0.0, 0.0, 20.0), 6.0);
        game.build(id, defense::Build::Place(1));
        assert_eq!(towers(&game).len(), 1, "{:?}", refused(&game));
        // Its builder out of it: back in the hangar.
        game.dock(id);
        skip_break(&mut game);
        let (start, mut shot, mut hit) = (scrap(&game, id), false, false);
        for _ in 0..secs(40.0) {
            game.step();
            shot |= game.events.iter().any(|e| matches!(e, Event::TurretHit { wrecked: true, .. }));
            hit |= towers(&game).first().is_none_or(|t| t.hull < defense::TOWER_HULL);
        }
        assert!(shot, "the tower shot none down");
        assert!(scrap(&game, id) > start, "no scrap for it");
        assert!(hit, "no walker fired on it");
    }

    #[test]
    fn arc_pylons_chain_between_walkers_and_pulse_pylons_stop_them() {
        for (k, kind) in [(2, Kind::Arc), (3, Kind::Pulse)] {
            let (mut game, id) = co_op(false);
            let first = game.defense.as_ref().unwrap().open_gates(1)[0];
            let gate = Vector::from_array(game.spots.defense.as_ref().unwrap().gates[first]);
            aim_to_build(&mut game, id, gate + Vector::new(0.0, 0.0, 12.0), 6.0);
            game.build(id, defense::Build::Place(k));
            assert_eq!(towers(&game)[0].kind, kind, "{:?}", refused(&game));
            game.dock(id);
            skip_break(&mut game);
            let (mut zaps, mut stuns) = (0, 0);
            for _ in 0..secs(20.0) {
                game.step();
                zaps += game.events.iter().filter(|e| matches!(e, Event::Zap { .. })).count();
                stuns += game.events.iter().filter(|e| matches!(e, Event::Stun { .. })).count();
                if stuns > 0 {
                    // A stunned walker stays put.
                    let before = walkers(&game);
                    game.step();
                    let after = walkers(&game);
                    let stood = before.iter().filter(|w| after.iter().any(|a| a.owner == w.owner && a.pos.distance(w.pos) < 1e-3)).count();
                    assert!(stood > 0);
                    break;
                }
            }
            if kind == Kind::Arc {
                assert!(zaps > 1, "{zaps} zaps");
            } else {
                assert!(stuns > 0);
            }
        }
    }

    #[test]
    fn a_torch_mends_towers_and_the_reactor() {
        let (mut game, id) = co_op(false);
        let reactor = game.defense.as_ref().unwrap().reactor;
        aim_to_build(&mut game, id, reactor, 14.0);
        game.build(id, defense::Build::Place(0));
        let k = game.deployables.iter().position(|d| d.kind == Kind::MgTurret).unwrap();
        game.deployables[k].hull = 100.0;
        let mender = (0u8..).map(|s| Loadout { secondary: s, ..Loadout::of(MechClass::B) }).find(|&l| game.arsenal.get(MechClass::B, l).alt_beam > 0.0).unwrap();
        let i = game.players.iter().position(|p| p.id == id).unwrap();
        let tower = game.deployables[k].pos + Vector::Y * 0.8;
        let m = &mut game.players[i].mech;
        m.loadout = mender;
        let eye = m.pos + Vector::Y * game.arsenal.of(m).eye_height;
        (m.yaw, m.pitch) = crate::bot::look_at(eye, tower);
        game.beam(i);
        assert!(game.deployables[k].hull > 100.0);
        // And the reactor.
        game.defense.as_mut().unwrap().hull = 1000.0;
        let m = &mut game.players[i].mech;
        m.pos = reactor + Vector::new(15.0, 0.0, 0.0);
        let eye = m.pos + Vector::Y * game.arsenal.of(m).eye_height;
        (m.yaw, m.pitch) = crate::bot::look_at(eye, reactor + Vector::Y * 6.0);
        game.beam(i);
        assert!(game.defense.as_ref().unwrap().hull > 1000.0);
    }

    /// Puts a lane enemy of `kind` down at `pos` (no lane: it stands there).
    fn lane_enemy(game: &mut Game, kind: Kind, pos: Vector) -> usize {
        let hull = defense::hull(kind, 1);
        game.deployables.push(Deployable { kind, team: 1, owner: 40, pos, yaw: 0.0, pitch: 0.0, hull, placed: 0, expires: u32::MAX, ready: 0, burst: 0 });
        game.deployables.len() - 1
    }

    #[test]
    fn a_crawler_blows_up_against_a_tower() {
        let (mut game, id) = co_op(false);
        let reactor = game.defense.as_ref().unwrap().reactor;
        aim_to_build(&mut game, id, reactor, 14.0);
        game.build(id, defense::Build::Place(0));
        game.dock(id);
        let tower = towers(&game)[0];
        lane_enemy(&mut game, Kind::Crawler, tower.pos + Vector::new(2.0, 0.0, 0.0));
        game.step();
        assert_eq!(towers(&game)[0].hull, defense::TOWER_HULL - CRAWLER_DAMAGE);
        assert!(walkers(&game).is_empty(), "it's gone");
        assert_eq!(scrap(&game, id), 250.0 - defense::PRICES[0], "no scrap for it");
    }

    #[test]
    fn a_brute_rears_up_then_smashes_towers_by_the_lane_and_plating_blunts_small_hits() {
        let (mut game, id) = co_op(false);
        let reactor = game.defense.as_ref().unwrap().reactor;
        aim_to_build(&mut game, id, reactor, 14.0);
        game.build(id, defense::Build::Place(0));
        game.dock(id);
        let tower = towers(&game)[0];
        let k = lane_enemy(&mut game, Kind::Brute, tower.pos + Vector::new(6.0, 0.0, 0.0));
        game.step();
        assert_eq!(game.deployables[k].pitch, 1.0, "rears up first");
        assert_eq!(towers(&game)[0].hull, defense::TOWER_HULL);
        for _ in 0..secs(BRUTE_WINDUP) {
            game.step();
        }
        assert_eq!(towers(&game)[0].hull, defense::TOWER_HULL - BRUTE_SMASH);
        assert_eq!(game.deployables[k].pitch, 0.0);
        // A rifle round barely scratches it; a rocket gets through.
        let hull = game.deployables[k].hull;
        game.wear(k, 6.0, id);
        assert!((hull - game.deployables[k].hull - 1.5).abs() < 1e-3);
        game.wear(k, 60.0, id);
        assert!((hull - game.deployables[k].hull - 1.5 - 55.0).abs() < 1e-3);
    }

    #[test]
    fn a_mortar_walker_digs_in_and_shells_towers_from_out_of_their_reach() {
        let (mut game, id) = co_op(false);
        let reactor = game.defense.as_ref().unwrap().reactor;
        aim_to_build(&mut game, id, reactor, 14.0);
        game.build(id, defense::Build::Place(0));
        game.dock(id);
        let tower = towers(&game)[0];
        let k = lane_enemy(&mut game, Kind::Mortar, tower.pos + Vector::new(50.0, 0.0, 0.0));
        game.step();
        assert_eq!(game.deployables[k].pitch, 1.0, "dug in");
        let shell = game.events.iter().find_map(|e| if let Event::Shell { to, flight, .. } = e { Some((*to, *flight)) } else { None });
        let (to, flight) = shell.expect("no shell");
        assert!(to.distance(tower.pos) < 0.01);
        for _ in 0..secs(flight) {
            game.step();
        }
        assert_eq!(towers(&game)[0].hull, defense::TOWER_HULL - MORTAR_DAMAGE);
        // Out of its reach, it walks on: too far across, or too far under (a cliff's foot).
        game.deployables[k].pos = tower.pos + Vector::new(80.0, 0.0, 0.0);
        game.step();
        assert_eq!(game.deployables[k].pitch, 0.0);
        game.deployables[k].pos = tower.pos + Vector::new(30.0, -MORTAR_RISE - 1.0, 0.0);
        game.step();
        assert_eq!(game.deployables[k].pitch, 0.0);
    }

    #[test]
    fn a_shield_node_carries_a_dome_that_stops_shots_and_comes_back_once_broken() {
        let (mut game, id) = co_op(false);
        game.dock(id);
        let reactor = game.defense.as_ref().unwrap().reactor;
        let k = lane_enemy(&mut game, Kind::Node, reactor + Vector::new(30.0, 0.0, 0.0));
        game.step();
        let dome = |game: &Game| game.deployables.iter().find(|d| d.kind == Kind::Dome && d.team == 1 && d.hull > 0.0).copied();
        let d = dome(&game).expect("no dome");
        assert_eq!(d.pos, game.deployables[k].pos);
        // It stops a shot from outside at what's inside.
        let from = d.pos + Vector::new(20.0, 2.0, 0.0);
        let t = items(&game.arsenal);
        assert!(deploy::stops(&game.deployables, t, &Ray::new(from, (d.pos + Vector::Y * 2.0 - from).normalize()), 20.0).is_some());
        // It goes where the node goes.
        game.deployables[k].pos += Vector::new(3.0, 0.0, 0.0);
        game.step();
        assert_eq!(dome(&game).unwrap().pos, game.deployables[k].pos);
        // Broken, it's gone a while, then back.
        let j = game.deployables.iter().position(|d| d.kind == Kind::Dome && d.team == 1).unwrap();
        game.wear(j, 1e4, id);
        game.step();
        game.step();
        assert!(dome(&game).is_none());
        for _ in 0..secs(NODE_RECHARGE) {
            game.step();
        }
        assert!(dome(&game).is_some());
        // And the node down, its dome goes too.
        let k = game.deployables.iter().position(|d| d.kind == Kind::Node).unwrap();
        game.deployables[k].hull = 0.0;
        game.step();
        game.step();
        assert!(dome(&game).is_none());
    }

    /// Runs wave `n` (its break skipped, pilot `id` docked) till its boss comes, every other lane
    /// enemy shot down as it comes; the boss's index.
    fn boss_of_wave(game: &mut Game, id: u8, n: u8) -> usize {
        game.dock(id);
        game.defense.as_mut().unwrap().wave = n;
        skip_break(game);
        for _ in 0..secs(90.0) {
            game.step();
            for k in (0..game.deployables.len()).filter(|&k| game.deployables[k].kind.lane_enemy() && !game.deployables[k].kind.boss()).collect::<Vec<_>>() {
                game.wear(k, 1e4, id);
            }
            if let Some(k) = game.deployables.iter().position(|d| d.kind.boss()) {
                assert!(game.events.iter().any(|e| matches!(e, Event::Defense(defense::News::Boss(_)))));
                return k;
            }
        }
        panic!("no boss on wave {n}");
    }

    #[test]
    fn the_excavator_grinds_towers_and_burrows_under_them_to_burst_up_further_on() {
        let (mut game, id) = co_op(false);
        let k = boss_of_wave(&mut game, id, 5);
        let boss = game.deployables[k];
        assert_eq!(boss.kind, Kind::Excavator);
        assert!((boss.hull - 0.6 * defense::hull(Kind::Excavator, 5)).abs() < 1.0, "a lone pilot's share: {}", boss.hull);
        // A tower by it is ground down.
        aim_to_build(&mut game, id, boss.pos, 4.0);
        game.players.iter_mut().find(|p| p.id == id).unwrap().mech.health = 100.0;
        game.build(id, defense::Build::Place(0));
        game.dock(id);
        let t = game.deployables.iter().position(|d| d.kind == Kind::MgTurret).unwrap();
        let before = game.deployables[t].hull;
        game.step();
        assert!(game.deployables[t].hull < before || (game.deployables[t].pos - game.deployables[k].pos).with_y(0.0).length() > EXCAVATOR_REACH);
        // Not one a storey over it.
        game.deployables[t].pos = game.deployables[k].pos + Vector::Y * (BOSS_BAND + 1.0);
        let before = game.deployables[t].hull;
        game.step();
        assert_eq!(game.deployables[t].hull, before);
        // It goes under, and comes up with a quake.
        let (mut deepest, mut quake) = (f32::MAX, false);
        for _ in 0..secs(EXCAVATOR_FIRST + EXCAVATOR_UNDER + 1.0) {
            game.step();
            let Some(b) = game.deployables.iter().find(|d| d.kind == Kind::Excavator) else { break };
            deepest = deepest.min(b.pos.y);
            quake |= game.events.iter().any(|e| matches!(e, Event::Stun { radius, .. } if *radius == QUAKE_RADIUS));
        }
        assert!(deepest < boss.pos.y - 20.0 && quake, "{deepest} {quake}");
    }

    #[test]
    fn the_hive_walker_breeds_crawlers_and_bursts_with_more_as_it_falls() {
        let (mut game, id) = co_op(false);
        let k = boss_of_wave(&mut game, id, 10);
        assert_eq!(game.deployables[k].kind, Kind::Hive);
        let crawlers = |game: &Game| game.deployables.iter().filter(|d| d.kind == Kind::Crawler && d.hull > 0.0).count();
        // Every so often, a few.
        let mut bred = 0;
        for _ in 0..secs(HIVE_EVERY + 1.0) {
            let had = crawlers(&game);
            game.step();
            bred += crawlers(&game).saturating_sub(had);
        }
        assert!(bred >= HIVE_BROOD, "{bred}");
        // Past two thirds of its hull, a burst more and an EMP.
        let had = crawlers(&game);
        let k = game.deployables.iter().position(|d| d.kind == Kind::Hive).unwrap();
        let full = game.defense.as_ref().unwrap().hull_of(Kind::Hive);
        game.deployables[k].hull = 0.6 * full;
        game.step();
        assert!(crawlers(&game) >= had + HIVE_BURST);
        assert!(game.events.iter().any(|e| matches!(e, Event::Stun { radius, .. } if *radius == HIVE_EMP)));
    }

    #[test]
    fn infested_mechs_come_through_the_gates_and_hold_the_wave_till_downed() {
        let (mut game, id) = co_op(false);
        game.dock(id);
        game.defense.as_mut().unwrap().wave = 6;
        skip_break(&mut game);
        let gates: Vec<Vector> = game.spots.defense.as_ref().unwrap().gates.iter().map(|g| Vector::from_array(*g)).collect();
        let mut elite = None;
        for _ in 0..secs(30.0) {
            game.step();
            // The lane enemies all go down as they come.
            for k in (0..game.deployables.len()).filter(|&k| game.deployables[k].kind.lane_enemy()).collect::<Vec<_>>() {
                game.wear(k, 1e4, id);
            }
            if let Some(p) = game.players.iter().find(|p| p.team == 1) {
                assert!(p.bot.is_some() && gates.iter().any(|g| g.with_y(0.0).distance(p.mech.pos.with_y(0.0)) < 3.0), "at a gate");
                elite = Some(p.id);
                break;
            }
        }
        let elite = elite.expect("no infested mech came");
        // The rest of the wave through.
        for _ in 0..secs(8.0) {
            game.step();
            for k in (0..game.deployables.len()).filter(|&k| game.deployables[k].kind.lane_enemy()).collect::<Vec<_>>() {
                game.wear(k, 1e4, id);
            }
        }
        let d = game.defense.as_ref().unwrap();
        assert!(matches!(d.stage, defense::Stage::Wave { .. }) && d.net(game.tick).left >= 1, "the wave waits on it");
        // Downed, it's paid for, then gone, and the wave's beaten.
        let j = game.players.iter().position(|p| p.id == elite).unwrap();
        let i = game.players.iter().position(|p| p.id == id).unwrap();
        let before = scrap(&game, id);
        game.apply_damage_by(Some(i), j, 1e4, Cause::Unknown);
        assert!(scrap(&game, id) > before);
        // (The rest of the wave shot down as it comes.)
        for _ in 0..secs(60.0) {
            game.step();
            for k in (0..game.deployables.len()).filter(|&k| game.deployables[k].kind.lane_enemy()).collect::<Vec<_>>() {
                game.wear(k, 1e4, id);
            }
            if game.defense.as_ref().unwrap().wave == 7 {
                break;
            }
        }
        assert!(game.players.iter().all(|p| p.team == 0), "still here");
        assert_eq!(game.defense.as_ref().unwrap().wave, 7);
    }

    #[test]
    fn an_infested_mech_that_reaches_the_reactor_hits_it_hard() {
        let (mut game, id) = co_op(false);
        game.dock(id);
        let reactor = game.defense.as_ref().unwrap().reactor;
        let elite = game.add_player(1, Some(Bot::new(3)), MechClass::B).unwrap();
        game.players.iter_mut().find(|p| p.id == elite).unwrap().mech.pos = reactor;
        game.step();
        assert!(game.players.iter().all(|p| p.id != elite));
        assert_eq!(game.defense.as_ref().unwrap().hull, defense::REACTOR_HULL - defense::ELITE_LEAK);
    }

    #[test]
    fn bots_build_towers_by_the_lanes_in_the_break() {
        let (mut game, id) = co_op(true);
        game.dock(id);
        for _ in 0..secs(55.0) {
            game.step();
        }
        let d = game.defense.as_ref().unwrap();
        let bots: Vec<u8> = game.players.iter().filter(|p| p.bot.is_some()).map(|p| p.id).collect();
        let built: Vec<u8> = d.towers.iter().map(|t| t.by).collect();
        assert!(bots.iter().all(|b| built.contains(b)), "bots {bots:?} built {built:?}");
        // Out of the lanes, by them.
        for t in towers(&game) {
            assert!(!d.in_lane(t.pos));
            assert!(d.segments().any(|(a, b)| (t.pos - a.lerp(b, 0.5)).length() < 40.0 || (t.pos - a).length() < 25.0));
        }
        assert!(bots.iter().all(|&b| scrap(&game, b) < 250.0));
    }

    #[test]
    fn a_beaten_wave_drafts_every_pilot_a_perk_and_bots_take_theirs() {
        let (mut game, id) = co_op(true);
        game.dock(id);
        skip_break(&mut game);
        for _ in 0..secs(12.0) {
            game.step();
            for k in (0..game.deployables.len()).filter(|&k| game.deployables[k].kind.lane_enemy()).collect::<Vec<_>>() {
                game.wear(k, 1e4, id);
            }
        }
        let d = game.defense.as_ref().unwrap();
        assert_eq!(d.wave, 2);
        let offer = d.offers.iter().find(|o| o.0 == id).expect("no draft").1.clone();
        assert_eq!(offer.len(), 3);
        assert!(offer.iter().all(|p| !p.rare()));
        // The bots have taken theirs.
        for p in game.players.iter().filter(|p| p.bot.is_some()) {
            assert!(!d.offers.iter().any(|o| o.0 == p.id));
            assert_eq!(defense::PERKS.iter().map(|&k| d.perk(p.id, k)).sum::<f32>(), 1.0);
        }
        game.draft(id, 1);
        assert_eq!(game.defense.as_ref().unwrap().perk(id, offer[1]), 1.0);
        assert!(game.defense.as_ref().unwrap().offers.iter().all(|o| o.0 != id));
    }

    #[test]
    fn downed_infested_mechs_and_bosses_leave_salvage_for_a_draft() {
        let (mut game, id) = co_op(false);
        let elite = game.add_player(1, Some(Bot::new(3)), MechClass::B).unwrap();
        let (i, j) = (game.players.iter().position(|p| p.id == id).unwrap(), game.players.iter().position(|p| p.id == elite).unwrap());
        let at = game.players[j].mech.pos;
        game.players[j].mech.shield = 0.0;
        game.apply_damage_by(Some(i), j, 1e4, Cause::Unknown);
        assert_eq!(game.defense.as_ref().unwrap().cores, vec![(at, false)]);
        // Walk over it: a draft.
        game.players[i].mech.pos = at;
        game.step();
        assert!(game.defense.as_ref().unwrap().cores.is_empty());
        assert!(game.events.iter().any(|e| matches!(e, Event::Defense(defense::News::Salvage { rare: false, .. }))));
        assert!(game.defense.as_ref().unwrap().offers.iter().any(|o| o.0 == id));
        // A boss's: blueprints.
        let k = lane_enemy(&mut game, Kind::Excavator, at + Vector::new(30.0, 0.0, 0.0));
        game.wear(k, 1e5, id);
        let core = game.defense.as_ref().unwrap().cores[0];
        assert!(core.1);
        game.defense.as_mut().unwrap().offers.clear();
        game.players[i].mech.pos = core.0;
        game.step();
        assert!(game.defense.as_ref().unwrap().offers.iter().find(|o| o.0 == id).unwrap().1.iter().all(|p| p.rare()));
    }

    #[test]
    fn perks_make_their_pilots_towers_and_guns_better() {
        let (mut game, id) = co_op(false);
        let perks = &mut game.defense.as_mut().unwrap().perks[usize::from(id)];
        for p in [defense::Perk::Plating, defense::Perk::Bulk, defense::Perk::Salvage, defense::Perk::Sabot, defense::Perk::Hunter] {
            perks[p as usize] = 1;
        }
        let reactor = game.defense.as_ref().unwrap().reactor;
        aim_to_build(&mut game, id, reactor, 14.0);
        game.build(id, defense::Build::Place(1));
        let tower = towers(&game)[0];
        assert_eq!(tower.hull, 1.25 * defense::TOWER_HULL, "plating");
        assert_eq!(scrap(&game, id), 250.0 - 0.85 * defense::PRICES[1], "bulk order");
        // Sabot rockets go through a brute's plating; a hunter's own hits land harder.
        let b = lane_enemy(&mut game, Kind::Brute, reactor + Vector::new(30.0, 0.0, 0.0));
        let hull = game.deployables[b].hull;
        game.wear(b, 20.0, tower.owner);
        assert_eq!(hull - game.deployables[b].hull, 20.0 * TOWER_ROCKET_POWER);
        let hull = game.deployables[b].hull;
        game.wear(b, 20.0, id);
        assert!((hull - game.deployables[b].hull - (24.0 - 5.0)).abs() < 1e-3);
        // Salvage rights: all it cost, back.
        let had = scrap(&game, id);
        game.build(id, defense::Build::Sell);
        assert!((scrap(&game, id) - had - 0.85 * defense::PRICES[1]).abs() < 1e-3);
    }

    #[test]
    fn a_beaten_wave_pays_every_pilot() {
        let (mut game, id) = co_op(false);
        let start = scrap(&game, id);
        skip_break(&mut game);
        for _ in 0..secs(12.0) {
            game.step();
            let standing: Vec<usize> = (0..game.deployables.len()).filter(|&k| game.deployables[k].kind.lane_enemy()).collect();
            for k in standing {
                game.wear(k, 1e4, 200);
            }
        }
        assert_eq!(scrap(&game, id), start + 100.0);
    }

    /// Co-op's balance, bot-only: runs on a co-op map (`COOP_MAP`, else Hivewall), four bot
    /// skills by `COOP_SEEDS` seeds (else 8), in parallel, one docked human and three bots fighting full-size waves
    /// (bots count as pilots). A line a run: won, the wave reached, the reactor's hull, minutes,
    /// towers standing and at most, the reactor's losses by wave, and what reached it (kind@wave).
    /// `cargo test --release -p sim --lib coop_balance_sweep -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn coop_balance_sweep() {
        let map = std::env::var("COOP_MAP").unwrap_or_else(|_| "hivewall".into());
        let seeds: u32 = std::env::var("COOP_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(8);
        let runs: Vec<(u32, f32)> = [0.3f32, 0.5, 0.7, 0.9].into_iter().flat_map(|skill| (1..=seeds).map(move |seed| (seed, skill))).collect();
        let out: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = runs
                .iter()
                .map(|&(seed, skill)| {
                    let map = &map;
                    scope.spawn(move || {
                        let mut game = Game::new(Tuning::default(), Map::index(map).unwrap());
                        (game.mode, game.bots, game.bot_skill) = (Mode::Defense, true, skill);
                        game.tick = seed * 977;
                        let id = game.join().unwrap();
                        game.dock(id);
                        let mut lost_by_wave = [0f32; 11];
                        let mut leaked: Vec<(u8, String)> = Vec::new();
                        let (mut last_hull, mut towers_peak) = (defense::REACTOR_HULL, 0);
                        for _ in 0..secs(2600.0) {
                            let near: Vec<(u8, Kind)> = game.deployables.iter().filter(|w| w.kind.lane_enemy() && w.hull > 0.0).filter(|w| game.defense.as_ref().is_some_and(|d| (w.pos - d.reactor).with_y(0.0).length() <= d.radius + 6.0)).map(|w| (w.owner, w.kind)).collect();
                            let elites_near: usize = game.players.iter().filter(|p| p.team == 1 && p.mech.health > 0.0 && game.defense.as_ref().is_some_and(|d| (p.mech.pos - d.reactor).with_y(0.0).length() <= d.radius + 6.0)).count();
                            game.step();
                            let Some(d) = game.defense.as_ref() else { continue };
                            let wave = usize::from(d.wave);
                            if d.hull < last_hull {
                                lost_by_wave[wave] += last_hull - d.hull;
                                for (owner, kind) in &near {
                                    if !game.deployables.iter().any(|w| w.owner == *owner && w.kind == *kind) {
                                        leaked.push((d.wave, format!("{kind:?}")));
                                    }
                                }
                                if elites_near > 0 && near.is_empty() {
                                    leaked.push((d.wave, "Elite".into()));
                                }
                            }
                            last_hull = d.hull;
                            towers_peak = towers_peak.max(d.towers.len());
                            if game.match_state().ended {
                                break;
                            }
                        }
                        let d = game.defense.as_ref().unwrap();
                        let won = game.match_state().winner == Some(0);
                        let mins = (game.tick - seed * 977) as f32 / TICK_HZ / 60.0;
                        let lost: Vec<String> = (1..=10).filter(|&w| lost_by_wave[w] > 0.0).map(|w| format!("w{w}:{:.0}", lost_by_wave[w])).collect();
                        let mut what: Vec<String> = leaked.iter().map(|(w, k)| format!("{k}@{w}")).collect();
                        what.dedup();
                        format!("RUN skill={skill} seed={seed} won={won} wave={} hull={:.0} mins={mins:.1} towers_end={} towers_peak={towers_peak} lost=[{}] leaked=[{}]", d.wave, d.hull, d.towers.len(), lost.join(" "), what.join(" "))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for line in out {
            println!("{line}");
        }
    }

    #[test]
    fn bots_bank_energy_on_their_own() {
        let (mut game, _) = siege(true);
        let trickle = 60.0; // a minute's worth: what a team gets for nothing
        for _ in 0..secs(60.0) {
            game.step();
        }
        let banks = game.siege.as_ref().unwrap().banks;
        let launched = game.deployables.iter().any(|d| d.kind == Kind::Ship);
        assert!(launched || banks.iter().any(|&b| b > trickle + 50.0), "banks {banks:?}");
    }

    #[test]
    fn base_guns_cut_down_a_spawn_camper_but_not_a_teammate() {
        let mut game = Game::new(Tuning::default(), Map::index("sump").unwrap());
        game.bots = false;
        let me = game.join().unwrap();
        game.step();
        let guns: Vec<Deployable> = game.deployables.iter().filter(|d| d.kind == Kind::Sentry).copied().collect();
        assert_eq!((guns.len(), guns.iter().filter(|d| d.team == 0).count()), (4, 2));
        // An enemy walks up to our base guns; we stand there too.
        let camper = game.add_player(1, None, MechClass::C).unwrap();
        unshield(&mut game);
        let gun = guns.iter().find(|d| d.team == 0).unwrap().pos;
        let at = |game: &Game, id| game.players.iter().position(|p| p.id == id).unwrap();
        let spot = gun + Vector::new(6.0, 0.0, 8.0);
        let mut fell = None;
        for tick in 0..secs(8.0) {
            let (c, m) = (at(&game, camper), at(&game, me));
            game.players[c].mech.pos = spot;
            game.players[m].mech.pos = spot + Vector::X * 4.0;
            game.step();
            if fell.is_none() && game.players[at(&game, camper)].mech.health <= 0.0 {
                fell = Some(tick);
            }
        }
        assert!(fell.is_some(), "the camper's still standing: {}", game.players[at(&game, camper)].mech.health);
        // Not at once, though: a Heavy under both guns lasts over three seconds.
        assert!(fell > Some(secs(3.0)), "cut down in {} ticks", fell.unwrap());
        assert!(game.players[at(&game, me)].mech.health > 0.0, "the base guns shot us");
    }

    #[test]
    fn a_base_gun_shot_through_goes_offline_then_comes_back_unhurt_a_while() {
        let mut game = Game::new(Tuning::default(), Map::index("sump").unwrap());
        game.bots = false;
        let raider = game.add_player(1, None, MechClass::C).unwrap();
        game.step();
        let k = game.deployables.iter().position(|d| d.kind == Kind::Sentry && d.team == 0).unwrap();
        game.wear(k, SENTRY_SHIELD - 1.0, raider);
        for _ in 0..secs(5.0) {
            game.step();
        }
        assert_eq!(game.deployables[k].hull, 1.0, "it healed");
        game.wear(k, SENTRY_SHIELD, raider);
        let shot_at = game.tick;
        game.step();
        assert!(game.deployables[k].kind == Kind::Sentry && game.deployables[k].hull <= 0.0, "not offline, or gone");
        // Offline, it holds its fire on a raider at its foot.
        let (r, owner) = (game.players.iter().position(|p| p.id == raider).unwrap(), game.deployables[k].owner);
        unshield(&mut game);
        while game.tick < shot_at + secs(SENTRY_OFFLINE) - 1 {
            game.players[r].mech.pos = game.deployables[k].pos + Vector::new(4.0, 0.0, 4.0);
            game.step();
            assert!(game.deployables[k].hull <= 0.0, "back too soon");
            assert!(!game.events.iter().any(|e| matches!(e, Event::TurretShot { owner: o, .. } if *o == owner)), "it fired while offline");
        }
        game.step();
        game.step();
        assert_eq!(game.deployables[k].hull, SENTRY_SHIELD, "it didn't come back");
        // Fresh back, it can't be hurt.
        game.wear(k, SENTRY_SHIELD, raider);
        assert_eq!(game.deployables[k].hull, SENTRY_SHIELD);
    }

    #[test]
    fn deathmatch_has_no_base_guns() {
        let (mut game, _) = deathmatch();
        game.step();
        assert!(game.deployables.iter().all(|d| d.kind != Kind::Sentry));
    }

    #[test]
    fn base_guns_fire_on_an_enemy_ship_overhead() {
        let (mut game, _) = siege(false);
        game.step();
        let gun = game.deployables.iter().find(|d| d.kind == Kind::Sentry && d.team == 0).unwrap().pos;
        let pos = gun + Vector::new(0.0, 55.0, -40.0);
        game.deployables.push(Deployable { kind: Kind::Ship, team: 1, owner: deploy::ship_owner(1), pos, yaw: 0.0, pitch: 0.0, hull: siege::SHIP_HULL, placed: 0, expires: u32::MAX, ready: 0, burst: 0 });
        // Hold it still: only the guns may hurt it.
        for _ in 0..secs(4.0) {
            if let Some(s) = game.deployables.iter_mut().find(|d| d.kind == Kind::Ship) {
                s.pos = pos;
            }
            game.step();
        }
        let hull = game.deployables.iter().find(|d| d.kind == Kind::Ship).map_or(0.0, |s| s.hull);
        assert!(hull < siege::SHIP_HULL, "the base guns let the ship be");
    }

    #[test]
    fn a_ship_holds_its_fire_on_mechs() {
        let (mut game, id) = siege(false);
        let me = game.players.iter().position(|p| p.id == id).unwrap();
        let (team, feet) = (game.players[me].team, game.players[me].mech.pos);
        let pos = feet + Vector::new(0.0, 30.0, 0.0);
        game.deployables.push(Deployable { kind: Kind::Ship, team: 1 - team, owner: deploy::ship_owner(1 - team), pos, yaw: 0.0, pitch: 0.0, hull: siege::SHIP_HULL, placed: 0, expires: u32::MAX, ready: 0, burst: 0 });
        for _ in 0..secs(4.0) {
            if let Some(s) = game.deployables.iter_mut().find(|d| d.kind == Kind::Ship) {
                s.pos = pos;
            }
            (game.players[me].mech.pos, game.players[me].mech.shield) = (feet, 0.0);
            game.step();
            assert!(!game.events.iter().any(|e| matches!(e, Event::TurretShot { owner, .. } if *owner == deploy::ship_owner(1 - team))), "the ship fired");
        }
        assert_eq!(game.players[me].mech.health, game.arsenal.of(&game.players[me].mech).health_max);
    }

    #[test]
    fn a_room_on_one_mode_stays_on_it() {
        let (mut game, _) = deathmatch();
        game.end_match();
        (0..=secs(POST_MATCH_SECONDS) + 1).for_each(|_| game.step());
        assert_eq!((game.mode, game.match_state().ended), (Mode::Deathmatch, false));
    }

    #[test]
    fn deathmatch_ends_on_points_and_crowns_the_leader() {
        let (mut game, id) = deathmatch();
        game.score_limit = 2;
        unshield(&mut game);
        let at = |game: &Game, id| game.players.iter().position(|p| p.id == id).unwrap();
        let me = at(&game, id);
        let (a, b) = ((0..game.players.len()).find(|&i| i != me).unwrap(), (0..game.players.len()).rfind(|&i| i != me).unwrap());
        game.apply_damage(Some(me), a, 1e3);
        assert!(!game.match_state().ended, "one solo kill (125) isn't 2 kills' worth");
        assert_eq!(game.match_state().scores, [125, 0]);
        game.apply_damage(Some(me), b, 1e3);
        let state = game.match_state();
        assert!(state.ended && state.winner == Some(id), "{state:?}");
    }

    #[test]
    fn a_new_mode_sorts_everyone_onto_teams_for_it() {
        let (foundry, sump) = (Map::index("foundry").unwrap(), Map::index("sump").unwrap());
        let mut game = Game::new(Tuning::default(), foundry);
        let humans: Vec<u8> = (0..3).map(|_| game.join().unwrap()).collect();
        game.step();
        game.rotate(vec![(Mode::TeamDeathmatch, foundry), (Mode::Deathmatch, sump)], 7);
        game.end_match();
        assert_eq!((game.match_state().next_mode, game.match_state().next_map), (Mode::Deathmatch, sump as u8));
        (0..=secs(POST_MATCH_SECONDS) + 1).for_each(|_| game.step());
        assert_eq!((game.mode, game.map, game.players.len()), (Mode::Deathmatch, sump, MAX_PLAYERS));
        assert!(game.players.iter().all(|p| p.team == p.id));
        // And back: humans spread over both teams, bots round them.
        game.end_match();
        (0..=secs(POST_MATCH_SECONDS) + 1).for_each(|_| game.step());
        assert_eq!(game.mode, Mode::TeamDeathmatch);
        let team_of = |id| game.players.iter().find(|p| p.id == id).unwrap().team;
        assert_eq!(humans.iter().map(|&id| team_of(id)).collect::<Vec<_>>(), [0, 1, 0]);
        assert_eq!([0, 1].map(|t| game.team_count(t)), [TEAM_SIZE, TEAM_SIZE]);
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
        for _ in 0..(4.5 * TICK_HZ) as u32 {
            game.step();
        }
        // The killer, beside it, takes all 37.5 over 3.75 s; the one 20 m off gets none.
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

        // Let go, and put the teammate in the way, hurt: it mends, capped at full.
        send(&mut game, user, Input { alt_fire: false, ..beam });
        game.step();
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
    fn power_shots_hit_harder_once() {
        let (mut game, owner, enemy) = standoff("emp");
        game.pick(owner, MechClass::B, Loadout { ability: arsenal::index(Slot::Ability, "power"), ..Loadout::of(MechClass::B) });
        unshield(&mut game);
        let t = game.arsenal.of(&mech(&game, owner)).clone();
        game.step(); // so shots have somewhere to rewind the enemy to
        // A plain shot, a powered one, then plain again.
        let aim = aim_at(&game, owner, enemy);
        let mut dealt = Vec::new();
        for ability in [false, true, false] {
            let before = mech(&game, enemy).health;
            send(&mut game, owner, Input { fire: true, ability, ..aim });
            game.step();
            dealt.push(before - mech(&game, enemy).health);
            for _ in 0..10 {
                send(&mut game, owner, aim);
                game.step();
            }
        }
        let want = [t.shot_damage, t.shot_damage * t.power_damage_mult, t.shot_damage];
        assert!(dealt.iter().zip(want).all(|(d, w)| (d - w).abs() < 1e-3), "dealt {dealt:?}, want {want:?}");
    }

    #[test]
    fn camouflage_ends_on_time_without_input() {
        let (mut game, owner, _) = standoff("emp");
        game.pick(owner, MechClass::A, Loadout { ability: arsenal::index(Slot::Ability, "cloak"), ..Loadout::of(MechClass::A) });
        send(&mut game, owner, Input { ability: true, ..Input::default() });
        game.step();
        let t = game.arsenal.of(&mech(&game, owner)).clone();
        // The client goes quiet: its mech stops stepping, but the spell runs out anyway.
        for _ in 0..secs(t.cloak_duration + ABILITY_SLACK) {
            game.step();
        }
        assert!(ability::on(&mech(&game, owner), Ability::Cloak), "cut short");
        game.step();
        assert!(!ability::on(&mech(&game, owner), Ability::Cloak), "stayed hidden with no input");
    }

    #[test]
    fn turrets_hold_fire_on_camouflage_until_it_drops() {
        let t = Tuning { mg_turret_spread_deg: 0.0, ..Tuning::default() };
        let (mut game, owner, foes) = turret_range(t.clone(), "mg_turret", &[Vector::new(0.0, 0.1, 22.0)]);
        let light = MechClass::A;
        game.pick(foes[0], light, Loadout { ability: arsenal::index(Slot::Ability, "cloak"), ..Loadout::of(light) });
        unshield(&mut game);
        send(&mut game, owner, Input { grenade: true, ..Input::default() });
        send(&mut game, foes[0], Input { ability: true, ..Input::default() });
        game.step();
        let fired = |game: &Game| game.events.iter().any(|e| matches!(e, Event::TurretShot { .. }));
        let mut ticks = 1;
        // The foe idles, as a client sends input every tick.
        loop {
            send(&mut game, foes[0], Input::default());
            game.step();
            ticks += 1;
            if !ability::on(&mech(&game, foes[0]), Ability::Cloak) {
                break;
            }
            assert!(!fired(&game), "fired on a hidden mech after {ticks} ticks");
        }
        assert!(ticks >= secs(t.cloak_duration), "the camouflage dropped early");
        let mut shot = false;
        for _ in 0..secs(2.0) {
            send(&mut game, foes[0], Input::default());
            game.step();
            shot |= fired(&game);
        }
        assert!(shot, "never fired once it showed");
    }

    #[test]
    fn domes_stop_every_shot_crossing_them_so_fights_go_inside() {
        let (mut game, owner, enemy) = standoff("dome");
        send(&mut game, owner, Input { emp: true, ..Input::default() });
        game.step();
        assert_eq!(game.deployables.iter().map(|d| (d.kind, d.owner)).collect::<Vec<_>>(), [(Kind::Dome, owner)]);
        let (dome, max) = (game.deployables[0].pos, game.arsenal.of(&mech(&game, owner)).health_max);
        let hp = |game: &Game, id| mech(game, id).health;
        let fire = |game: &mut Game, from, to, input: Input, secs_: f32| {
            for _ in 0..secs(secs_) {
                let aimed = Input { fire: input.fire, alt_fire: input.alt_fire, ..aim_at(game, from, to) };
                send(game, from, aimed);
                game.step();
            }
        };
        let (rifle, rocket) = (Input { fire: true, ..Input::default() }, Input { alt_fire: true, ..Input::default() });

        // In from outside: the enemy's rifle and rocket stop at it, splash and all.
        fire(&mut game, enemy, owner, rifle, 1.0);
        fire(&mut game, enemy, owner, rocket, 1.0);
        assert_eq!(hp(&game, owner), max, "hurt through the dome");
        // Out from inside: the owner's stop at it too.
        fire(&mut game, owner, enemy, rifle, 0.5);
        assert_eq!(hp(&game, enemy), max, "shot out through the dome");
        // The enemy walks in: inside, both are hit. Its side's own teammate outside can't reach in.
        let mate = game.join().unwrap();
        game.players.iter_mut().find(|p| p.id == enemy).unwrap().mech.pos = dome + Vector::new(5.0, 0.1, 0.0);
        game.players.iter_mut().find(|p| p.id == mate).unwrap().mech.pos = Vector::new(0.0, 0.1, 22.0);
        unshield(&mut game);
        game.step(); // so shots don't rewind them to where they were
        fire(&mut game, mate, enemy, rifle, 0.5);
        assert_eq!(hp(&game, enemy), max, "shot into the dome from outside by the owner's own side");
        fire(&mut game, enemy, owner, rifle, 0.5);
        fire(&mut game, owner, enemy, rifle, 0.5);
        assert!(hp(&game, owner) < max && hp(&game, enemy) < max, "no hits inside: {} and {}", hp(&game, owner), hp(&game, enemy));
        // Gone once its time's up.
        for _ in 0..secs(items(&game.arsenal).dome_seconds) {
            game.step();
        }
        assert!(game.deployables.is_empty(), "the dome outlived its time");
    }

    /// A Medium with the pile driver at `from` and an enemy of `class` at `to`, on blockout with
    /// no bots and their shields down.
    fn duel(class: MechClass, from: Vector, to: Vector) -> (Game, u8, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let [striker, victim] = [0, 1];
        for at in [from, to] {
            let id = game.join().unwrap();
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = at;
        }
        game.pick(striker, MechClass::B, Loadout::named("pike", "piston"));
        game.pick(victim, class, Loadout::of(class));
        unshield(&mut game);
        (game, striker, victim)
    }

    /// Winds `striker`'s pile driver fully facing `yaw`, lets go, and steps on `after` s, the
    /// victim stepping (idle) all along so it flies when thrown.
    fn wind_and_strike(game: &mut Game, striker: u8, victim: u8, yaw: f32, after: f32) {
        let aim = Input { yaw, ..Input::default() };
        let wind = game.arsenal.of(&mech(game, striker)).alt_charge_time;
        for k in 0..secs(wind) + 1 + secs(after) {
            send(game, striker, Input { alt_fire: k <= secs(wind), ..aim });
            send(game, victim, Input::default());
            game.step();
        }
    }

    #[test]
    fn pile_drivers_lunge_strike_and_throw_lights_farther_than_heavies() {
        let mut thrown = Vec::new();
        for class in [MechClass::A, MechClass::C] {
            // 14 m apart (about 11 m between hulls), the enemy dead ahead: the release lunges first.
            let (mut game, striker, victim) = duel(class, Vector::new(0.0, 0.1, 40.0), Vector::new(0.0, 0.1, 26.0));
            let (max, start) = (game.arsenal.of(&mech(&game, victim)).health_max, mech(&game, victim).pos);
            wind_and_strike(&mut game, striker, victim, 0.0, 2.0);
            let t = game.arsenal.of(&mech(&game, striker));
            assert!(mech(&game, striker).pos.z < 32.0, "didn't lunge: at z {}", mech(&game, striker).pos.z);
            let dealt = max - mech(&game, victim).health;
            assert!((dealt - t.alt_damage * t.alt_charge_damage).abs() < 0.01, "a {class:?} took {dealt}");
            thrown.push(start.z - mech(&game, victim).pos.z);
        }
        assert!(thrown[0] > 2.0 * thrown[1] && thrown[1] > 1.0, "a Light went {} m, a Heavy {} m", thrown[0], thrown[1]);
    }

    #[test]
    fn a_mech_thrown_into_a_wall_takes_the_slam_too() {
        // Facing +X, the enemy in reach between us and the east wall (its inner face at x = 50).
        let (mut game, striker, victim) = duel(MechClass::B, Vector::new(41.0, 0.1, 0.0), Vector::new(45.5, 0.1, 0.0));
        let max = game.arsenal.of(&mech(&game, victim)).health_max;
        wind_and_strike(&mut game, striker, victim, -std::f32::consts::FRAC_PI_2, 1.0);
        let t = game.arsenal.of(&mech(&game, striker));
        let dealt = max - mech(&game, victim).health;
        assert!(dealt > t.alt_damage * t.alt_charge_damage + 5.0, "took {dealt}, no more than the strike");
    }

    #[test]
    fn rail_slugs_punch_through_domes_and_barriers_wearing_them() {
        for support in ["dome", "barrier"] {
            let (mut game, owner, enemy) = standoff(support);
            game.pick(enemy, MechClass::B, Loadout::named("pike", "spindle"));
            unshield(&mut game);
            let aim = aim_at(&game, owner, enemy);
            send(&mut game, owner, Input { emp: true, ..aim });
            game.step();
            let (hull, max) = (game.deployables[0].hull, game.arsenal.of(&mech(&game, owner)).health_max);
            let slug = game.arsenal.of(&mech(&game, enemy)).alt_damage;
            // Pulled and let go: the slug fires on the release.
            let rail = |game: &mut Game| {
                for alt_fire in [true, false, false, false] {
                    let aim = aim_at(game, enemy, owner);
                    send(game, enemy, Input { alt_fire, ..aim });
                    game.step();
                }
            };
            rail(&mut game);
            assert!(mech(&game, owner).health < max, "the {support} stopped the slug");
            assert!((game.deployables[0].hull - (hull - slug)).abs() < 1e-3, "the {support} took {} of {slug}", hull - game.deployables[0].hull);
            // Through the whole dome, in one side and out the other, wears it once more.
            if support == "dome" {
                let (dome, hp) = (game.deployables[0].pos, mech(&game, owner).health);
                for (id, x) in [(owner, 16.0), (enemy, -20.0)] {
                    let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                    (p.mech.pos, p.mech.alt_wait) = (dome + Vector::new(x, 0.0, 0.0), 0.0);
                }
                game.step();
                rail(&mut game);
                assert!(mech(&game, owner).health < hp, "missed the owner behind the dome");
                assert!((game.deployables[0].hull - (hull - 2.0 * slug)).abs() < 1e-3, "the dome took {} of {slug} passing through", hull - slug - game.deployables[0].hull);
            }
        }
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
    fn domes_and_barriers_wear_down_under_the_other_sides_fire_and_break() {
        for item in ["dome", "barrier"] {
            let (mut game, owner, enemy) = standoff(item);
            send(&mut game, owner, Input { emp: true, ..Input::default() });
            game.step();
            let (full, expires) = (game.deployables[0].hull, game.deployables[0].expires);
            let fire = |game: &mut Game, from, to, input: Input| {
                for _ in 0..secs(0.5) {
                    send(game, from, Input { fire: input.fire, alt_fire: input.alt_fire, ..aim_at(game, from, to) });
                    game.step();
                }
                game.deployables.first().map_or(0.0, |d| d.hull)
            };
            let (rifle, rocket) = (Input { fire: true, ..Input::default() }, Input { alt_fire: true, ..Input::default() });
            assert_eq!(fire(&mut game, owner, enemy, rifle), full, "{item}: its own side wore it");
            let shot = fire(&mut game, enemy, owner, rifle);
            assert!(shot < full, "{item}: rifle rounds didn't wear it");
            assert!(fire(&mut game, enemy, owner, rocket) < shot, "{item}: the rocket didn't wear it");
            // Worn through, it's gone before its time, and shots get through.
            game.deployables[0].hull = 1.0;
            fire(&mut game, enemy, owner, rifle);
            assert!(game.deployables.is_empty() && game.tick < expires, "{item}: still up");
            let max = game.arsenal.of(&mech(&game, owner)).health_max;
            assert!(mech(&game, owner).health < max, "{item}: nothing got through once it broke");
        }
    }

    /// A game on blockout with no bots, tuned by `t`: player 0 (team 0) at (0, 40) facing south
    /// (-z) carrying offensive item `offensive`, enemies (team 1) at the `enemies` positions, and
    /// any teammates joining between them parked out west.
    fn turret_range(t: Tuning, offensive: &str, enemies: &[Vector]) -> (Game, u8, Vec<u8>) {
        let mut game = Game::new(t, Map::index("blockout").unwrap());
        game.bots = false;
        let mut foes = Vec::new();
        for k in 0..=2 * enemies.len() - 1 {
            let id = game.join().unwrap();
            let pos = match k {
                0 => Vector::new(0.0, 0.1, 40.0),
                k if k % 2 == 1 => enemies[k / 2],
                k => Vector::new(-40.0 + 4.0 * k as f32, 0.1, 45.0),
            };
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
            if k % 2 == 1 {
                foes.push(id);
            }
        }
        game.pick(0, MechClass::B, Loadout { offensive: arsenal::index(Slot::Offensive, offensive), ..Loadout::of(MechClass::B) });
        unshield(&mut game);
        (game, 0, foes)
    }

    #[test]
    fn mg_turrets_fire_on_the_nearest_enemy_in_range_and_credit_their_owner() {
        let t = Tuning { mg_turret_spread_deg: 0.0, ..Tuning::default() };
        // One enemy 15 m off the turret, one 23 m off, one past its range.
        let (near, far, out) = (Vector::new(0.0, 0.1, 22.0), Vector::new(8.0, 0.1, 16.0), Vector::new(0.0, 0.1, -10.0));
        let (mut game, owner, foes) = turret_range(t.clone(), "mg_turret", &[near, far, out]);
        send(&mut game, owner, Input { grenade: true, ..Input::default() });
        game.step();
        let turret = game.deployables.iter().find(|d| d.kind == Kind::MgTurret).copied().expect("no turret");
        assert!((turret.pos - Vector::new(0.0, 0.0, 40.0 - t.turret_distance)).length() < 0.2, "at {}", turret.pos);
        let max = t.health_max;
        let mut rounds = 0;
        for _ in 0..secs(3.0) {
            game.step();
            rounds += game.events.iter().filter(|e| matches!(e, Event::TurretShot { owner: o, .. } if *o == owner)).count();
        }
        let hp = |game: &Game, id| mech(game, id).health;
        assert!(rounds >= t.mg_turret_burst as usize, "fired {rounds} rounds");
        assert!(hp(&game, foes[0]) < max, "didn't hit the nearest enemy");
        assert_eq!((hp(&game, foes[1]), hp(&game, foes[2])), (max, max), "fired on one farther off");
        // A kill is its owner's, by the turret.
        game.players.iter_mut().find(|p| p.id == foes[0]).unwrap().mech.health = 1.0;
        for _ in 0..secs(2.0) {
            game.step();
        }
        assert_eq!(hp(&game, foes[0]), 0.0, "never finished it");
        let (tally, _) = game.tally(owner).unwrap();
        assert_eq!((tally.stats.kills, tally.stats.weapon_kills.get("mg_turret")), (1, Some(&1)));
        // Gone once its time's up.
        for _ in 0..secs(t.turret_seconds) {
            game.step();
        }
        assert!(game.deployables.is_empty(), "the turret outlived its time");
    }

    #[test]
    fn hellfires_lock_onto_turrets_and_home_on_them() {
        let t = Tuning { turret_warmup: 30.0, ..Tuning::default() };
        // From 40 m off: closer in, aiming down at something this low, the volley's wide fan puts
        // missiles into the floor before they start to home.
        let (mut game, owner, foes) = turret_range(t.clone(), "mg_turret", &[Vector::new(0.0, 0.1, -2.5)]);
        send(&mut game, owner, Input { grenade: true, ..Input::default() });
        game.step();
        let turret = game.deployables[0];
        let shooter = mech(&game, foes[0]);
        let ts = game.arsenal.of(&shooter).clone();
        assert!(ts.alt_lock_time > 0.0, "the foe's secondary doesn't lock on");
        let d = deploy::center(&t, &turret) - (shooter.pos + Vector::Y * ts.eye_height);
        let aim = Input { yaw: libm::atan2f(-d.x, -d.z), pitch: (d.y / d.length()).asin(), ..Input::default() };
        // Middle-click on it, hold until the lock's made, and fire: the volley homes on it (turning
        // harder than on a mech) and brings it down.
        let id = deploy::target_id(&turret) + 1;
        let (mut locked, mut homing) = (false, false);
        for tick in 0..secs(3.0) {
            let m = mech(&game, foes[0]);
            let made = m.lock == id && m.lock_time >= ts.alt_lock_time;
            send(&mut game, foes[0], Input { aux: tick > 0, alt_fire: made && !homing, ..aim });
            game.step();
            locked |= made;
            homing |= game.events.iter().any(|e| matches!(e, Event::Launch(p) if p.target == id));
        }
        assert!(locked, "never locked onto the turret");
        assert!(homing, "no volley was sent after it");
        assert!(game.deployables.is_empty(), "the volley left it at {:?}", game.deployables.first().map(|d| d.hull));
    }

    #[test]
    fn a_torch_carrying_lead_leads() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        // In the hangar, so two bots lead themselves: the lead (the lowest id) carrying a torch.
        let human = game.join().unwrap();
        game.dock(human);
        let torch = (0..game.arsenal.counts().1 as u8).find(|&s| game.arsenal.get(MechClass::B, Loadout { secondary: s, ..Loadout::of(MechClass::B) }).alt_beam > 0.0).unwrap();
        let (lead, mate) = (game.add_player(0, Some(Bot::new(1)), MechClass::B).unwrap(), game.add_player(0, Some(Bot::new(2)), MechClass::B).unwrap());
        game.pick(lead, MechClass::B, Loadout { secondary: torch, ..Loadout::of(MechClass::B) });
        game.pick(mate, MechClass::B, Loadout::of(MechClass::B));
        // With nothing to fight, it patrols and the other follows, rather than each holding on the other.
        let mut walked = [0.0; 2];
        for _ in 0..secs(20.0) {
            let was = [lead, mate].map(|id| mech(&game, id).pos);
            game.step();
            for (w, (id, at)) in walked.iter_mut().zip([lead, mate].into_iter().zip(was)) {
                *w += (mech(&game, id).pos - at).length();
            }
        }
        assert!(walked.iter().all(|&w| w > 60.0), "walked {walked:?} m in 20 s");
    }

    #[test]
    fn repair_torches_mend_teammates_near_full() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        // Two bots with no one to fight: one carrying a torch, and a teammate 15 m off a few hits
        // down. The torch mends it near full, not just to where it isn't badly hurt.
        let human = game.join().unwrap();
        game.dock(human);
        let torch = (0..game.arsenal.counts().1 as u8).find(|&s| game.arsenal.get(MechClass::B, Loadout { secondary: s, ..Loadout::of(MechClass::B) }).alt_beam > 0.0).unwrap();
        let (medic, mate) = (game.add_player(0, Some(Bot::new(1)), MechClass::B).unwrap(), game.add_player(0, Some(Bot::new(2)), MechClass::B).unwrap());
        game.pick(medic, MechClass::B, Loadout { secondary: torch, ..Loadout::of(MechClass::B) });
        game.pick(mate, MechClass::B, Loadout::of(MechClass::B));
        let max = game.arsenal.of(&mech(&game, mate)).health_max;
        for (id, pos) in [(medic, Vector::new(0.0, 0.1, 40.0)), (mate, Vector::new(8.0, 0.1, 27.0))] {
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
        }
        game.players.iter_mut().find(|p| p.id == mate).unwrap().mech.health = 0.85 * max;
        for _ in 0..secs(6.0) {
            game.step();
        }
        let hull = mech(&game, mate).health / max;
        assert!(hull > 0.95, "mended to {:.0}%", 100.0 * hull);
    }

    #[test]
    fn bots_go_after_enemy_turrets() {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        // A human far off on one side (so the game runs), and a bot of the other side with an
        // enemy turret 15 m ahead of it (one that holds its fire).
        let human = game.join().unwrap();
        let bot = game.add_player(1, Some(Bot::with_skill(3, 0.9)), MechClass::B).unwrap();
        for (id, pos) in [(human, Vector::new(45.0, 0.1, 45.0)), (bot, Vector::new(0.0, 0.1, 30.0))] {
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
        }
        // A rifle, which won't send it off to cool before it's done.
        game.pick(bot, MechClass::B, Loadout::named("pike", "rocket"));
        let team = game.players.iter().find(|p| p.id == human).unwrap().team;
        let tick = game.tick;
        game.deployables.push(Deployable {
            kind: Kind::MgTurret, team, owner: human, pos: Vector::new(0.0, 0.0, 15.0), yaw: 0.0, pitch: 0.0, hull: t.turret_hull,
            placed: tick, expires: tick + secs(60.0), ready: tick + secs(60.0), burst: 0,
        });
        for _ in 0..secs(10.0) {
            game.step();
            if game.deployables.is_empty() {
                break;
            }
        }
        assert!(game.deployables.is_empty(), "the bot left the turret standing");
    }

    /// A sharp bot with `gun` at z 30 and a human 25 m north of it, standing still, on blockout's
    /// open west side with their shields down; and a dome or barrier, the human's side's
    /// (`theirs`) or the bot's, up at `at` for a minute, whole or never to break.
    fn shielded(gun: &str, kind: Kind, theirs: bool, at: Vector, unbreakable: bool) -> (Game, u8, u8) {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let human = game.join().unwrap();
        let bot = game.add_player(1, Some(Bot::with_skill(3, 0.9)), MechClass::B).unwrap();
        for (id, pos) in [(human, Vector::new(-40.0, 0.1, 5.0)), (bot, Vector::new(-40.0, 0.1, 30.0))] {
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
        }
        game.pick(bot, MechClass::B, Loadout::named(gun, "rocket"));
        unshield(&mut game);
        let owner = if theirs { human } else { bot };
        let (team, tick) = (game.players.iter().find(|p| p.id == owner).unwrap().team, game.tick);
        let i = items(&game.arsenal);
        let hull = if unbreakable { f32::INFINITY } else if kind == Kind::Dome { i.dome_hull } else { i.barrier_hull };
        game.deployables.push(Deployable { kind, team, owner, pos: at, yaw: 0.0, pitch: 0.0, hull, placed: tick, expires: tick + secs(60.0), ready: 0, burst: 0 });
        game.arena.set_barriers(items(&game.arsenal), &game.deployables);
        (game, bot, human)
    }

    /// Steps `game` `secs_` s with `human` kept whole, counting the shots, launches and throws
    /// `bot` sent into its own side's dome or barrier.
    fn wasted(game: &mut Game, bot: u8, human: u8, secs_: f32, mut each: impl FnMut(&Game)) -> u32 {
        let mut wasted = 0;
        for _ in 0..secs(secs_) {
            let (b, h) = (mech(game, bot), mech(game, human));
            let t = game.arsenal.of(&b);
            let (eye, chest) = (b.pos + Vector::Y * t.eye_height, h.pos + Vector::Y * (game.arsenal.of(&h).mech_height * 0.5));
            let ray = Ray::new(eye, (chest - eye).normalize());
            let walled = deploy::shield(&game.deployables, items(&game.arsenal), &ray, chest.distance(eye)).is_some_and(|d| d.owner == bot);
            game.step();
            let b = mech(game, bot);
            wasted += u32::from(walled && (b.shot || b.launched || b.threw));
            let max = game.arsenal.of(&mech(game, human)).health_max;
            game.players.iter_mut().find(|p| p.id == human).unwrap().mech.health = max;
            each(game);
        }
        wasted
    }

    #[test]
    fn bots_shoot_into_enemy_domes_and_walk_in() {
        let dome = Vector::new(-40.0, 0.0, 5.0);
        // Its shots wear the dome...
        let (mut game, ..) = shielded("pike", Kind::Dome, true, dome, false);
        let full = game.deployables[0].hull;
        for _ in 0..secs(2.0) {
            game.step();
        }
        assert!(game.deployables.first().is_none_or(|d| d.hull < full), "never fired on the dome");
        // ...and with one that won't break, it walks in to get at the enemy under it.
        let (mut game, bot, _) = shielded("pike", Kind::Dome, true, dome, true);
        let r = items(&game.arsenal).dome_radius;
        let mut inside = false;
        for _ in 0..secs(8.0) {
            game.step();
            inside |= (mech(&game, bot).pos - dome).length() < r;
        }
        assert!(inside, "never went under it");
        assert!(game.tally(bot).unwrap().0.dealt > 0.0, "never hit the enemy under it");
    }

    #[test]
    fn bots_step_out_from_under_their_own_dome_to_fire_and_back_in_to_cool() {
        // A rifle, which runs hot enough to go back in and cool; and a charged gun (let go, it
        // fires: under the dome, it holds its charge), which doesn't.
        for (gun, cools) in [("pike", true), ("kiln", false)] {
            let dome = Vector::new(-40.0, 0.0, 30.0);
            let (mut game, bot, human) = shielded(gun, Kind::Dome, false, dome, true);
            let r = items(&game.arsenal).dome_radius;
            // Out from under it, by its feet, then deep back in.
            let (mut out, mut back) = (false, false);
            let wasted = wasted(&mut game, bot, human, 15.0, |game| {
                let off = (mech(game, bot).pos - dome).length();
                (out, back) = (out || off > r, back || out && off < 0.5 * r);
            });
            let dealt = game.tally(bot).unwrap().0.dealt;
            assert_eq!(wasted, 0, "{gun}: fired into its own dome");
            assert!(dealt > 50.0, "{gun}: dealt only {dealt}");
            assert!(out && (back || !cools), "{gun}: out {out}, back in {back}");
        }
    }

    #[test]
    fn bots_shoot_down_enemy_barriers_and_step_round_their_own() {
        // The enemy's, across the way between: fired on, and worn.
        let (mut game, ..) = shielded("pike", Kind::Barrier, true, Vector::new(-40.0, 0.0, 15.0), false);
        let full = game.deployables[0].hull;
        for _ in 0..secs(6.0) {
            game.step();
        }
        assert!(game.deployables.first().is_none_or(|d| d.hull < full), "never fired on the barrier");
        // Its own, just ahead: no fire into it, and round its end to hit.
        let (mut game, bot, human) = shielded("pike", Kind::Barrier, false, Vector::new(-40.0, 0.0, 26.0), true);
        let half = 0.5 * items(&game.arsenal).barrier_width;
        let mut round = false;
        assert_eq!(wasted(&mut game, bot, human, 8.0, |game| round |= (mech(game, bot).pos.x + 40.0).abs() > half), 0, "fired into its own barrier");
        assert!(round, "never went round it");
        assert!(game.tally(bot).unwrap().0.dealt > 50.0, "dealt only {}", game.tally(bot).unwrap().0.dealt);
        // With the enemy close behind it off past its far end: round that end, the way the line
        // of fire crosses, not the one it stands nearer.
        let (mut game, bot, human) = shielded("pike", Kind::Barrier, false, Vector::new(-40.0, 0.0, 26.0), true);
        for (id, pos) in [(bot, Vector::new(-41.0, 0.1, 29.0)), (human, Vector::new(-34.0, 0.1, 23.0))] {
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
        }
        assert_eq!(wasted(&mut game, bot, human, 3.0, |_| {}), 0, "fired into its own barrier");
        assert!(game.tally(bot).unwrap().0.dealt > 0.0, "never got a shot past it");
        // A charged gun mid-charge when its own barrier comes between holds the charge.
        let (mut game, bot, human) = shielded("kiln", Kind::Barrier, false, Vector::new(40.0, 0.0, -40.0), true);
        for _ in 0..secs(5.0) {
            if mech(&game, bot).charge >= 0.5 {
                break;
            }
            game.step();
        }
        assert!(mech(&game, bot).charge >= 0.5, "never charged");
        let (b, h) = (mech(&game, bot).pos, mech(&game, human).pos);
        let d = h - b;
        (game.deployables[0].pos, game.deployables[0].yaw) = (Vector::new(b.x + 0.3 * d.x, 0.0, b.z + 0.3 * d.z), libm::atan2f(-d.x, -d.z));
        game.arena.set_barriers(items(&game.arsenal), &[]);
        game.arena.set_barriers(items(&game.arsenal), &game.deployables);
        assert_eq!(wasted(&mut game, bot, human, 1.0, |_| {}), 0, "let its charge go into its own barrier");
    }

    #[test]
    fn turrets_fall_to_enemy_fire() {
        let t = Tuning { spread_deg: 0.0, bloom_per_shot: 0.0, falloff_start: 1000.0, falloff_end: 1000.0, turret_warmup: 30.0, ..Tuning::default() };
        assert_eq!(t.turret_hull, 37.5);
        let (mut game, owner, foes) = turret_range(t.clone(), "mg_turret", &[Vector::new(0.0, 0.1, 22.0)]);
        send(&mut game, owner, Input { grenade: true, ..Input::default() });
        game.step();
        let gun = deploy::gun(&t, &game.deployables[0]);
        let shooter = mech(&game, foes[0]);
        let d = gun - (shooter.pos + Vector::Y * t.eye_height);
        let aim = Input { fire: true, yaw: libm::atan2f(-d.x, -d.z), pitch: (d.y / d.length()).asin(), ..Input::default() };
        // Each hit is the shooter's to hear of (a hit marker), and the last one wrecks it.
        let mut hits = Vec::new();
        for _ in 0..secs(3.0) {
            send(&mut game, foes[0], aim);
            game.step();
            hits.extend(game.events.iter().filter_map(|e| match *e {
                Event::TurretHit { attacker, wrecked } => Some((attacker, wrecked)),
                _ => None,
            }));
            if game.deployables.is_empty() {
                break;
            }
        }
        assert!(game.deployables.is_empty(), "never shot it down");
        assert!(hits.len() >= 2 && hits.iter().all(|h| h.0 == foes[0]), "hits {hits:?}");
        assert_eq!(hits.iter().filter(|h| h.1).count(), 1, "wrecked once: {hits:?}");
        assert!(hits.last().unwrap().1, "the last hit didn't wreck it: {hits:?}");
        assert_eq!(mech(&game, owner).health, t.health_max, "shots went through it to its owner");
    }

    #[test]
    fn rocket_turrets_launch_at_enemies_in_their_range() {
        let t = Tuning::default();
        let (mut game, owner, foes) = turret_range(t.clone(), "rocket_turret", &[Vector::new(0.0, 0.1, 0.0)]);
        send(&mut game, owner, Input { grenade: true, ..Input::default() });
        game.step();
        assert_eq!(game.deployables[0].kind, Kind::RocketTurret);
        let (mut launched, mut burst) = (0, 0);
        for _ in 0..secs(4.0) {
            game.step();
            for e in &game.events {
                match *e {
                    Event::Launch(p) if p.n == projectile::TURRET && p.owner == owner => launched += 1,
                    Event::Blast { n: projectile::TURRET, hits, .. } if hits & 1 << foes[0] != 0 => burst += 1,
                    _ => {}
                }
            }
        }
        assert!(launched >= 2, "{launched} rockets in 4 s");
        assert!(burst >= 1 && mech(&game, foes[0]).health < t.health_max, "no rocket hit");
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
        let solid = |center, half| crate::map::Solid { center, half, yaw: 0.0, tilt: 0.0, shape: Default::default() };
        let map = Map {
            name: "cover".into(),
            solids: vec![solid([0.0, -0.5, 0.0], [50.0, 0.5, 50.0]), solid([0.0, 1.5, 0.0], [4.0, 1.5, 0.25]), solid([0.0, 2.0, 16.0], [2.0, 2.0, 2.0])],
            spawns: [vec![], vec![]],
            dm_spawns: vec![],
            nav: vec![],
            pads: vec![],
            size: [100.0, 100.0],
            terrain: None,
            objectives: Default::default(),
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
        let p = Projectile { owner: bot, seq: 1, n: 0, primary: false, class: MechClass::B, loadout: Loadout::named("pike", "rocket"), charge: 0.0, boosted: false, target: 0, pos: chest + Vector::Z * 2.0, vel: Vector::Z * t.alt_speed, age: 0.5 };
        game.projectiles.push(Flying { p, team: 1 });
        game.step();
        let hits = game.events.iter().find_map(|e| if let Event::Blast { owner, hits, .. } = *e { Some((owner, hits)) } else { None });
        assert_eq!(hits, Some((bot, 1 << human)));
    }

    /// A bot of `skill` carrying `primary`, its secondary, items and ability held back, `range` from a human
    /// strafing across its line in the open (turning every 1.2 s) for `seconds`: the game after,
    /// the bot's id, its rounds fired, and its seeking mark (0 for none) every tick from 1 s on.
    fn duel_strafer(primary: &str, skill: f32, range: f32, seconds: f32) -> (Game, u8, u32, Vec<u8>) {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        let human = game.join().unwrap();
        let mut brain = Bot::new(3);
        brain.skill = skill;
        let bot = game.add_player(1, Some(brain), MechClass::B).unwrap();
        let (from, spot) = (Vector::new(-36.0, 0.1, -42.0), Vector::new(-36.0, 0.1, -42.0 + range));
        for (id, pos) in [(human, from), (bot, spot)] {
            let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
            p.mech.pos = pos;
            if id == bot {
                p.mech.loadout = Loadout::named(primary, "rocket");
            }
        }
        unshield(&mut game);
        let (mut rounds, mut marks) = (0, Vec::new());
        for k in 0..secs(seconds) {
            let side = if (k / secs(1.2)) % 2 == 0 { -1.0 } else { 1.0 };
            send(&mut game, human, Input { move_x: side, yaw: std::f32::consts::PI, ..Input::default() });
            game.step();
            for p in &mut game.players {
                if p.id == bot {
                    // Held to its spot, its gun alone.
                    (p.mech.pos, p.mech.vel, p.mech.alt_wait, p.mech.grenades, p.mech.emps, p.mech.ability_cooldown) = (spot, Vector::ZERO, 99.0, 0, 0, 99.0);
                    rounds += u32::from(p.mech.shot);
                    if k >= secs(1.0) {
                        marks.push(p.mech.seek);
                    }
                } else {
                    p.mech.health = t.health_max; // so it never dies
                }
            }
        }
        (game, bot, rounds, marks)
    }

    #[test]
    fn bots_track_a_strafing_target() {
        // Up close a strafer crosses the sights fast: a bot that aimed where it saw it a reaction
        // ago (0.25 s, 3 m behind) landed a quarter of its SMG rounds.
        let (game, bot, rounds, _) = duel_strafer("stitcher", 0.5, 12.0, 12.0);
        let t = game.arsenal.of(&mech(&game, bot)).clone();
        let landed = game.tally(bot).unwrap().0.dealt_by[0] / (rounds as f32 * t.shot_damage);
        assert!(rounds > 50 && landed > 0.4, "landed {landed:.2} of {rounds} rounds");
    }

    #[test]
    fn bots_fight_from_cover_and_cool_in_it() {
        // A rifle bot north-west of the 6 m block at (-5, -30), in sight of a human 20 m south of the
        // block. The bot takes the block as its post: out from behind it to fire, back in to cool.
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        let human = game.join().unwrap();
        let bot = game.add_player(1, Some(Bot::new(4)), MechClass::B).unwrap();
        for (id, pos) in [(human, Vector::new(-5.0, 0.1, -48.0)), (bot, Vector::new(-12.0, 0.1, -22.0))] {
            let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
            p.mech.pos = pos;
            if id == bot {
                p.mech.loadout = Loadout::named("pike", "rocket");
            }
        }
        unshield(&mut game);
        let (mut covered, mut cooling, mut hidden, mut ticks) = (0, 0, 0, 0);
        for _ in 0..secs(20.0) {
            game.step();
            for p in &mut game.players {
                if p.id == bot {
                    // Its gun alone.
                    (p.mech.alt_wait, p.mech.grenades, p.mech.emps, p.mech.ability_cooldown) = (99.0, 0, 0, 99.0);
                } else {
                    p.mech.health = t.health_max;
                }
            }
            let (b, h) = (mech(&game, bot), mech(&game, human));
            let state = game.players.iter().find(|p| p.id == bot).unwrap().bot.as_ref().unwrap().post_state();
            ticks += 1;
            covered += u32::from(state.is_some_and(|(cover, _)| cover));
            if let Some((true, true)) = state {
                cooling += 1;
                hidden += u32::from(!crate::tactics::exposed(&game.arena, &t, b.pos, h.pos + Vector::Y * t.eye_height));
            }
        }
        let dealt = game.tally(bot).unwrap().0.dealt;
        assert!(covered * 2 > ticks, "a post with cover only {covered} of {ticks} ticks");
        assert!(cooling > 30 && hidden * 10 > cooling * 6, "hidden {hidden} of {cooling} ticks cooling");
        assert!(dealt > 100.0, "dealt only {dealt:.0}");
    }

    #[test]
    fn bots_back_up_a_teammates_fight() {
        // A human 10 m south of the 6 m block at (-5, -30), fought by a bot off to its side; a
        // second bot stands behind the block, out of its sight, within its trade reach (22 m).
        // Told of the fight, it goes to a spot it can fire on the human from.
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        let human = game.join().unwrap();
        let fighter = game.add_player(1, Some(Bot::new(4)), MechClass::B).unwrap();
        let backup = game.add_player(1, Some(Bot::new(5)), MechClass::B).unwrap();
        for (id, pos) in [(human, Vector::new(-5.0, 0.1, -42.0)), (fighter, Vector::new(15.0, 0.1, -40.0)), (backup, Vector::new(-5.0, 0.1, -20.0))] {
            game.players.iter_mut().find(|p| p.id == id).unwrap().mech.pos = pos;
        }
        unshield(&mut game);
        let in_sight = |g: &Game| bot::sees(&g.arena, &t, &mech(g, backup), &mech(g, human));
        assert!(!in_sight(&game), "in sight to start with");
        let (mut traded, mut sighted) = (false, false);
        for _ in 0..secs(8.0) {
            game.step();
            game.players.iter_mut().find(|p| p.id == human).unwrap().mech.health = t.health_max;
            traded |= game.players.iter().find(|p| p.id == backup).unwrap().bot.as_ref().unwrap().doing() == bot::Doing::Trade;
            sighted |= in_sight(&game);
        }
        assert!(traded && sighted, "traded {traded}, got the human in sight {sighted}");
    }

    #[test]
    fn bots_know_a_pilot_teammates_fight_from_whom_it_hit() {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let pilot = game.join().unwrap();
        let mate = game.add_player(0, Some(Bot::new(4)), MechClass::B).unwrap();
        let enemy = game.add_player(1, Some(Bot::new(5)), MechClass::B).unwrap();
        unshield(&mut game);
        let (p, e) = (game.players.iter().position(|q| q.id == pilot).unwrap(), game.players.iter().position(|q| q.id == enemy).unwrap());
        game.apply_damage(Some(p), e, 1.0);
        game.step();
        let fights = |g: &Game| g.players.iter().find(|q| q.id == mate).unwrap().bot.as_ref().unwrap().mates.iter().find_map(|m| m.1);
        assert_eq!(fights(&game), Some(enemy), "the pilot's fight isn't known");
        (0..secs(HUMAN_FOCUS + 0.5)).for_each(|_| game.step());
        assert_eq!(fights(&game), None, "an old hit still counts");
    }

    #[test]
    fn a_pilots_kills_sharpen_the_bots_only_as_they_respawn() {
        let t = Tuning::default();
        let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
        game.bots = false;
        let pilot = game.join().unwrap();
        let enemy = game.add_player(1, Some(Bot::new(5)), MechClass::B).unwrap();
        let other = game.add_player(1, Some(Bot::new(6)), MechClass::B).unwrap();
        unshield(&mut game);
        let skill = |g: &Game, id: u8| g.players.iter().find(|q| q.id == id).unwrap().bot.as_ref().unwrap().skill;
        let (p, e) = (game.players.iter().position(|q| q.id == pilot).unwrap(), game.players.iter().position(|q| q.id == enemy).unwrap());
        game.apply_damage(Some(p), e, 10.0 * t.health_max);
        assert!(game.adapt[1] > 0.0 && game.adapt[0] == 0.0, "adapt {:?}", game.adapt);
        game.step();
        assert_eq!(skill(&game, other), 0.5, "a bot alive changed its skill mid-fight");
        (0..secs(t.respawn_delay + 1.0)).for_each(|_| game.step());
        assert!(skill(&game, enemy) > 0.5, "the respawned bot didn't take the adjustment: {}", skill(&game, enemy));
    }

    #[test]
    fn bots_lead_long_lobs_no_further_than_a_strafer_goes() {
        // An Auto-GL's lob 35 m out flies about 0.8 s, and the bot leads its reaction time on top:
        // longer than a strafer keeps going one way. Led the whole way, its grenades all landed
        // past where the target turned back (none hit).
        let (game, bot, rounds, _) = duel_strafer("hail", 0.5, 35.0, 15.0);
        let dealt = game.tally(bot).unwrap().0.dealt_by[0];
        assert!(rounds > 15 && dealt > 20.0, "dealt {dealt:.0} from {rounds} grenades");
    }

    #[test]
    fn homing_bots_keep_the_target_marked() {
        // A homing rocket homes on what's in the crosshair as it flies: a bot leading the target
        // took it out of the 3° seek cone. (A sharp bot's: a raw one's aim wanders that far, and
        // even a sharp one's wanders off a strafer now and then, `Tuning::bot_track_s`: 0.65.)
        let (_, _, rounds, marks) = duel_strafer("talon", 1.0, 45.0, 12.0);
        let marked = marks.iter().filter(|&&m| m != 0).count() as f32 / marks.len() as f32;
        assert!(rounds > 8 && marked > 0.6, "marked {marked:.2} of the time, {rounds} rockets");
    }

    #[test]
    fn bots_use_salve_pall_and_limpet() {
        let t = Tuning::default();
        // A bot 20 m south of a human standing in the open, carrying `offensive` and `support`, at
        // `hull` of its health; the game after up to `seconds`, or as soon as `done` holds.
        let play = |offensive: &str, support: &str, hull: f32, seconds: f32, done: &dyn Fn(&Game, u8) -> bool| {
            let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
            game.bots = false;
            let human = game.join().unwrap();
            let bot = game.add_player(1, Some(Bot::new(5)), MechClass::B).unwrap();
            let loadout = Loadout::named("pike", "rocket").with(Slot::Offensive, arsenal::index(Slot::Offensive, offensive)).with(Slot::Support, arsenal::index(Slot::Support, support));
            for (id, pos) in [(human, Vector::new(0.0, 0.1, -5.0)), (bot, Vector::new(0.0, 0.1, 15.0))] {
                let m = &mut game.players.iter_mut().find(|p| p.id == id).unwrap().mech;
                (m.pos, m.loadout) = (pos, loadout);
                item::fill(&t, m);
            }
            unshield(&mut game);
            game.players.iter_mut().find(|p| p.id == bot).unwrap().mech.health = hull * t.health_max;
            for _ in 0..secs(seconds) {
                game.step();
                game.players.iter_mut().find(|p| p.id == human).unwrap().mech.health = t.health_max; // so it never dies
                if done(&game, bot) {
                    return true;
                }
            }
            false
        };
        // Hurt, with no orb about: it drops its Salve.
        assert!(play("grenade", "orb", 0.45, 5.0, &|g, bot| g.orbs.iter().any(|o| o.dropped.is_some_and(|(by, _)| by == bot))), "no Salve dropped");
        // Falling back in the human's sight: it smokes the way.
        assert!(play("smoke", "emp", 0.3, 6.0, &|g, _| !g.clouds.is_empty()), "no Pall thrown");
        // A limpet stuck by the human, then set off: it hurts.
        assert!(play("limpet", "emp", 1.0, 12.0, &|g, bot| g.tally(bot).unwrap().0.dealt_by[Slot::Offensive as usize] > 0.0), "no limpet damage");
    }

    #[test]
    fn bots_split_cluster_canisters_at_their_target() {
        let t = Tuning::default();
        let bomblet = |n: u8| (projectile::BOMBLET..projectile::TURRET).contains(&n);
        let (mut canisters, mut splits, mut bomblets, mut bomblet_hits) = (0, 0, 0, 0);
        for seed in 1..=6 {
            let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
            game.bots = false;
            let human = game.join().unwrap();
            let bot = game.add_player(1, Some(Bot::new(seed)), MechClass::B).unwrap();
            // A bot with the cluster launcher 30 m south of a human standing in the open.
            for (id, pos) in [(human, Vector::new(0.0, 0.1, -5.0)), (bot, Vector::new(0.0, 0.1, 25.0))] {
                let m = &mut game.players.iter_mut().find(|p| p.id == id).unwrap().mech;
                m.pos = pos;
                m.loadout = Loadout::named("pike", "splitter");
            }
            unshield(&mut game);
            for _ in 0..secs(30.0) {
                game.step();
                for e in &game.events {
                    match *e {
                        Event::Blast { owner, primary: false, n, .. } if owner == bot && n < projectile::BOMBLET => canisters += 1,
                        Event::Launch(p) if p.owner == bot && bomblet(p.n) => {
                            splits += u32::from(p.n == projectile::BOMBLET);
                            bomblets += 1;
                        }
                        Event::Blast { owner, primary: false, n, hits, .. } if owner == bot && bomblet(n) && hits & 1 << human != 0 => bomblet_hits += 1,
                        _ => {}
                    }
                }
                game.players.iter_mut().find(|p| p.id == human).unwrap().mech.health = t.health_max; // so it never dies
            }
        }
        assert!(splits * 3 >= canisters * 2, "only {splits} of {canisters} canisters split");
        assert!(bomblet_hits * 2 >= bomblets, "only {bomblet_hits} of {bomblets} bomblets hit");
    }

    #[test]
    fn bots_lob_shells_onto_shorter_mechs() {
        // A Heavy bot with Scatter 25 m from a Light standing in the open: the Light's head is below
        // the Heavy's eye. Lobbed level with that eye, the pellets flew over it.
        let t = Tuning::default();
        let (mut pellets, mut caught) = (0, 0);
        for seed in 1..=4 {
            let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
            game.bots = false;
            let human = game.join().unwrap();
            let bot = game.add_player(1, Some(Bot::new(seed)), MechClass::C).unwrap();
            for (id, class, pos) in [(human, MechClass::A, Vector::new(0.0, 0.1, -5.0)), (bot, MechClass::C, Vector::new(0.0, 0.1, 20.0))] {
                let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                p.class = class;
                // Its guns only: no grenades or EMPs.
                p.mech = Mech { grenades: 0, emps: 0, ..spawn(&game.arsenal, class, Loadout { ability: 2, ..Loadout::named("pike", "darts") }, pos) };
            }
            unshield(&mut game);
            for _ in 0..secs(15.0) {
                game.step();
                for e in &game.events {
                    if let Event::Blast { owner, primary: false, hits, .. } = *e
                        && owner == bot
                    {
                        pellets += 1;
                        caught += u32::from(hits & 1 << human != 0);
                    }
                }
                let p = game.players.iter_mut().find(|p| p.id == human).unwrap();
                p.mech.health = game.arsenal.of(&p.mech).health_max; // so it never dies
            }
        }
        // Lobbed level with the eye, 13 of 149 caught it.
        assert!(pellets >= 100 && caught * 3 >= pellets, "only {caught} of {pellets} pellets caught the Light");
    }

    #[test]
    fn bots_fire_shells_out_to_their_fuse() {
        // A bot held 45 m from a human standing in the open, with Scatter (pellets bursting 60 m
        // out) and the Cluster launcher (canisters splitting 70 m out): its shells that burst, and
        // how many caught the human.
        let t = Tuning::default();
        for secondary in ["darts", "splitter"] {
            let (mut bursts, mut caught) = (0, 0);
            for seed in 1..=3 {
                let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
                game.bots = false;
                let human = game.join().unwrap();
                let bot = game.add_player(1, Some(Bot::new(seed)), MechClass::B).unwrap();
                let at = Vector::new(0.0, 0.1, 40.0);
                for (id, pos) in [(human, Vector::new(0.0, 0.1, -5.0)), (bot, at)] {
                    let m = &mut game.players.iter_mut().find(|p| p.id == id).unwrap().mech;
                    // Its guns only: no grenades or EMPs.
                    (m.pos, m.loadout, m.grenades, m.emps) = (pos, Loadout { ability: 1, ..Loadout::named("pike", secondary) }, 0, 0);
                }
                unshield(&mut game);
                for _ in 0..secs(12.0) {
                    game.step();
                    for e in &game.events {
                        if let Event::Blast { owner, primary: false, n, hits, .. } = *e
                            && owner == bot
                            && n < projectile::BOMBLET
                        {
                            bursts += 1;
                            caught += u32::from(hits & 1 << human != 0);
                        }
                    }
                    game.players.iter_mut().find(|p| p.id == human).unwrap().mech.health = t.health_max; // so it never dies
                    let m = &mut game.players.iter_mut().find(|p| p.id == bot).unwrap().mech;
                    (m.pos, m.vel) = (at, Vector::ZERO);
                }
            }
            // Held to the grenade launcher's 40 m, neither fired at all.
            assert!(bursts >= 4 && caught * 3 >= bursts, "{secondary}: {caught} of {bursts} caught the human");
        }
    }

    #[test]
    fn furnace_bots_throw_fireballs_once_warm() {
        // A bot with the Furnace and a rifle held 30 m from a human standing in the open, who drops
        // out of its sight (camouflaged) every other 3 s, as fights come and go in a match: its gun
        // cools between sightings. Its fireballs, and how many caught the human.
        let t = Tuning::default();
        let (mut fireballs, mut caught) = (0, 0);
        for seed in 1..=4 {
            let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
            game.bots = false;
            let human = game.join().unwrap();
            let bot = game.add_player(1, Some(Bot::new(seed)), MechClass::B).unwrap();
            let at = Vector::new(0.0, 0.1, 25.0);
            for (id, pos) in [(human, Vector::new(0.0, 0.1, -5.0)), (bot, at)] {
                let m = &mut game.players.iter_mut().find(|p| p.id == id).unwrap().mech;
                // Its guns only: no grenades or EMPs, and no vent; the human camouflages.
                (m.pos, m.loadout, m.grenades, m.emps) = (pos, Loadout { ability: arsenal::index(Slot::Ability, if id == bot { "power" } else { "cloak" }), ..Loadout::named("pike", "furnace") }, 0, 0);
            }
            unshield(&mut game);
            for k in 0..secs(24.0) {
                game.players.iter_mut().find(|p| p.id == human).unwrap().mech.ability_time = if k / secs(3.0) % 2 == 0 { 0.0 } else { 1.0 };
                game.step();
                for e in &game.events {
                    if let Event::Blast { owner, primary: false, hits, .. } = *e
                        && owner == bot
                    {
                        fireballs += 1;
                        caught += u32::from(hits & 1 << human != 0);
                    }
                }
                game.players.iter_mut().find(|p| p.id == human).unwrap().mech.health = t.health_max; // so it never dies
                let m = &mut game.players.iter_mut().find(|p| p.id == bot).unwrap().mech;
                (m.pos, m.vel) = (at, Vector::ZERO);
            }
        }
        // At 60% heat it threw none.
        assert!(fireballs >= 8 && caught * 4 >= fireballs * 3, "{caught} of {fireballs} fireballs caught the human");
    }

    #[test]
    fn bots_close_in_and_land_the_pile_driver() {
        // A bot with an SMG and the pile driver 15 m from a human in the open, standing, then
        // strafing side to side: how many strikes it lets go, and how many land.
        let t = Tuning::default();
        let (mut released, mut landed) = (0, 0);
        for (seed, strafe) in (1..=4).flat_map(|seed| [(seed, false), (seed, true)]) {
            let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
            game.bots = false;
            let human = game.join().unwrap();
            let bot = game.add_player(1, Some(Bot::new(seed)), MechClass::B).unwrap();
            for (id, pos) in [(human, Vector::new(0.0, 0.1, -5.0)), (bot, Vector::new(0.0, 0.1, 10.0))] {
                let m = &mut game.players.iter_mut().find(|p| p.id == id).unwrap().mech;
                // Its guns only: no grenades or EMPs.
                (m.pos, m.loadout, m.grenades, m.emps) = (pos, Loadout { ability: 1, ..Loadout::named("stitcher", "piston") }, 0, 0);
            }
            unshield(&mut game);
            for k in 0..secs(20.0) {
                let side = if !strafe { 0.0 } else if k / secs(1.2) % 2 == 0 { 1.0 } else { -1.0 };
                send(&mut game, human, Input { move_x: side, ..Input::default() });
                game.step();
                released += u32::from(mech(&game, bot).launched);
                landed += game.events.iter().filter(|e| matches!(**e, Event::Strike { owner, hit, .. } if owner == bot && hit == human)).count() as u32;
                let p = game.players.iter_mut().find(|p| p.id == human).unwrap();
                // So it never dies, nor slams into anything for a second Strike.
                (p.mech.health, p.knock) = (t.health_max, None);
            }
        }
        // 160 s in all: a strike landed every 5 s or so, and nearly every one let go lands.
        assert!(landed >= 30, "only {landed} strikes landed (of {released})");
        assert!(landed * 10 >= released * 9, "only {landed} of {released} strikes landed");
    }

    #[test]
    fn bots_aim_at_the_middle_of_each_size_of_mech() {
        // A bot with the Rifle 40 m from a human standing in the open, each class against each:
        // its shots that hit, (hits, shots) by its class and the target's.
        let t = Tuning::default();
        let loadout = Loadout::named("pike", "rocket");
        let mut tally = [[(0u32, 0u32); 3]; 3];
        for (class, target) in MechClass::ALL.into_iter().flat_map(|a| MechClass::ALL.map(|b| (a, b))) {
            let (hits, shots) = &mut tally[class.index()][target.index()];
            for seed in 1..=4 {
                let mut game = Game::new(t.clone(), Map::index("blockout").unwrap());
                game.bots = false;
                let human = game.join().unwrap();
                let bot = game.add_player(1, Some(Bot::new(seed)), class).unwrap();
                let at = Vector::new(-36.0, 0.1, -2.0);
                for (id, pos, c) in [(human, Vector::new(-36.0, 0.1, -42.0), target), (bot, at, class)] {
                    let p = game.players.iter_mut().find(|p| p.id == id).unwrap();
                    let l = Loadout { ability: if c == MechClass::C { 2 } else { 1 }, ..loadout };
                    (p.class, p.loadout, p.next_loadout) = (c, l, l);
                    p.mech = Mech { class: c, ..spawn(&game.arsenal, c, l, pos) };
                }
                unshield(&mut game);
                for _ in 0..secs(10.0) {
                    send(&mut game, human, Input::default());
                    game.step();
                    for e in &game.events {
                        if let Event::Shot { shooter, hit, .. } = *e
                            && shooter == bot
                        {
                            (*hits, *shots) = (*hits + u32::from(hit == Some(human)), *shots + 1);
                        }
                    }
                    for p in &mut game.players {
                        // The bot holds its spot, with its gun alone; the human never dies.
                        if p.id == bot {
                            (p.mech.pos, p.mech.vel, p.mech.alt_wait, p.mech.grenades, p.mech.emps, p.mech.ability_cooldown) = (at, Vector::ZERO, 99.0, 0, 0, 99.0);
                        } else {
                            p.mech.health = 1.0e3;
                        }
                    }
                }
            }
        }
        // Its own size costs it nothing: on each target it hits about as often as one the
        // target's size does. Aimed at its own middle's height, a Light hit a Heavy 150 of 204
        // shots (a Heavy, 214 of 240).
        let rate = |c: MechClass, t: MechClass| {
            let (hits, shots) = tally[c.index()][t.index()];
            assert!(shots >= 100, "{c:?} fired {shots} shots at {t:?}");
            hits as f32 / shots as f32
        };
        for (class, target) in MechClass::ALL.into_iter().flat_map(|a| MechClass::ALL.map(|b| (a, b))) {
            assert!(rate(class, target) >= 0.9 * rate(target, target), "{class:?} on {target:?}: {:?}", tally);
        }
    }
}
