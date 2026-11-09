//! Co-op Defense's rules. The pilots (team 0) hold a reactor against waves of infested walkers
//! (team 1, `deploy::Kind::Walker`) that come through the map's gates and walk its lanes toward
//! it: a network of paths, branching by weight. A walker that reaches the reactor hits it and is
//! gone; the reactor falling loses the run, holding through the last wave wins it. Between waves
//! the team has a while to get ready. `Game` keeps the walkers among its deployables (shot, locked
//! onto and manned like turrets), says which are still standing, and applies what comes out.
//!
//! Pilots build towers (`Build`) anywhere they can stand one (`spot`), out of the lanes, paying in
//! their own scrap: earned by the hull they and their towers shoot off walkers, and for each wave
//! beaten. Anyone raises any tower a tier (to TIERS); its builder can sell it back.

use rapier3d::prelude::Ray;
use serde::{Deserialize, Serialize};

use crate::deploy::Kind;
use crate::game::MAX_PLAYERS;
use crate::map::DefenseSpots;
use crate::{Arena, DT, TICK_HZ, Vector};

/// The reactor's hull, and what a walker that reaches it takes off.
pub const REACTOR_HULL: f32 = 2000.0;
pub const LEAK: f32 = 100.0;
/// Waves in a run, and the time to get ready before the first and between the rest (s).
pub const WAVES: u8 = 10;
const FIRST_BREAK: f32 = 60.0;
const BREAK: f32 = 30.0;
/// A break called short (every human pilot calling the wave): each pilot's scrap, and the run's
/// score, for each second it had left.
pub const CALL_SCRAP: f32 = 2.0;
pub const CALL_SCORE: f32 = 10.0;
/// The run's score: for each hull point shot off a foe, each wave beaten, and (won) each point
/// of the reactor's hull left; and CALL_SCORE for each second of break called short.
const SCORE_PER_HULL: f32 = 0.1;
const WAVE_SCORE: f32 = 200.0;
/// The wave director: each wave's threat budget for a full team (SOLO_SHARE of it for one pilot
/// and evenly between), spent on `CARDS`, a theme leaning it one way from wave 3 (`Theme`). Foes
/// come through the gates in packs of PACK, PACK_GAP apart (a pack of crawlers CRAWLER_GAP),
/// PACK_PAUSE between packs. A map can harden its bosses and hurry its stragglers
/// (`DefenseSpots::bosses`, `hurry`).
const BUDGETS: [f32; WAVES as usize] = [6.0, 10.0, 14.0, 21.0, 30.0, 48.0, 60.0, 72.0, 82.0, 80.0];

/// What the director buys: a foe (crawlers by the pack), what it costs of the budget, the wave
/// it first comes on (where one's bought first, before the rest), how likely it is (by weight)
/// against the others, and at most how many a wave.
struct Card {
    foe: Foe,
    pack: u16,
    cost: f32,
    from: u8,
    weight: f32,
    most: u16,
}

const CARDS: [Card; 6] = [
    Card { foe: Foe::Lane(Kind::Walker), pack: 1, cost: 1.0, from: 1, weight: 3.0, most: 40 },
    Card { foe: Foe::Lane(Kind::Crawler), pack: 4, cost: 2.0, from: 3, weight: 2.0, most: 32 },
    Card { foe: Foe::Lane(Kind::Brute), pack: 1, cost: 4.0, from: 4, weight: 1.0, most: 4 },
    Card { foe: Foe::Lane(Kind::Mortar), pack: 1, cost: 3.0, from: 5, weight: 1.0, most: 4 },
    Card { foe: Foe::Elite, pack: 1, cost: 5.0, from: 6, weight: 0.6, most: 3 },
    Card { foe: Foe::Lane(Kind::Node), pack: 1, cost: 3.0, from: 7, weight: 0.7, most: 3 },
];
/// A themed wave's foe is THEME_LEAN times as likely; a flanking wave sends FLANK of its foes
/// through one gate.
const THEME_LEAN: f32 = 3.0;
const FLANK: f32 = 0.8;

/// A wave's theme: the foe it leans on, or its gate (Flank).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Theme {
    #[default]
    Mixed,
    Swarm,
    Armor,
    Siege,
    Shielded,
    Flank,
}

impl Theme {
    /// The foe it leans on, and the wave it can first come on.
    fn leans(self) -> (Option<Foe>, u8) {
        match self {
            Theme::Mixed => (None, 1),
            Theme::Swarm => (Some(Foe::Lane(Kind::Crawler)), 3),
            Theme::Armor => (Some(Foe::Lane(Kind::Brute)), 4),
            Theme::Siege => (Some(Foe::Lane(Kind::Mortar)), 5),
            Theme::Shielded => (Some(Foe::Lane(Kind::Node)), 7),
            Theme::Flank => (None, 3),
        }
    }
}
const SOLO_SHARE: f32 = 0.6;
/// The bosses, and the waves they come on.
const BOSS_WAVES: [(u8, Kind); 2] = [(5, Kind::Excavator), (10, Kind::Hive)];
/// Seeded variations: the gates open over the run (one for waves up to GATES_ONE, two up to
/// GATES_TWO, then all), in a seeded order; each fork's weights each times 0.5-1.5 for the run;
/// the Bloom seals SEALS_AT_START of the routes it can at the start, and after each wave beaten,
/// BLOOM_CHANGE of the time, seals another or bursts one open (never cutting a gate off); and each
/// break CACHES supply caches lie out at spots away from the reactor, CACHE_SCRAP each to whoever
/// picks one up.
const GATES_ONE: u8 = 2;
const GATES_TWO: u8 = 5;
const SEALS_AT_START: usize = 1;
const BLOOM_CHANGE: f32 = 0.7;
const CACHES: usize = 2;
pub const CACHE_SCRAP: f32 = 60.0;
/// Lane enemies this wide (radius) or more keep off narrow lanes (`Lanes::narrow`).
pub const BIG: f32 = 2.5;
/// A lane enemy rushing (`rush`: a boss burrowing) walks this many times its pace.
const RUSH: f32 = 3.5;
const PACK: u8 = 6;
const PACK_GAP: f32 = 0.4;
const PACK_PAUSE: f32 = 5.0;
const CRAWLER_GAP: f32 = 0.35;
/// An infested mech that reaches the reactor takes this off it (and is gone).
pub const ELITE_LEAK: f32 = 200.0;
/// A plated foe's hits each lose its `armor`, but at least ARMOR_FLOOR of each gets through.
const ARMOR_FLOOR: f32 = 0.25;

/// Who comes in a wave: a lane enemy, or an infested mech (a bot on team 1, `Game`'s to make).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Foe {
    Lane(Kind),
    Elite,
}

/// A lane enemy's make: its hull in wave 0 and more each wave, its walk (m/s), how far off its
/// lane's line it keeps (either side, so a wave doesn't walk in single file), what it takes off
/// the reactor reaching it, and its plating (see ARMOR_FLOOR).
pub struct Species {
    hull: f32,
    hull_step: f32,
    speed: f32,
    spread: f32,
    pub leak: f32,
    pub armor: f32,
}

pub fn species(kind: Kind) -> Species {
    match kind {
        Kind::Crawler => Species { hull: 30.0, hull_step: 5.0, speed: 8.5, spread: 3.5, leak: 25.0, armor: 0.0 },
        Kind::Brute => Species { hull: 600.0, hull_step: 80.0, speed: 2.8, spread: 0.5, leak: 300.0, armor: 5.0 },
        Kind::Mortar => Species { hull: 140.0, hull_step: 22.0, speed: 3.5, spread: 1.5, leak: LEAK, armor: 0.0 },
        Kind::Node => Species { hull: 150.0, hull_step: 18.0, speed: 4.0, spread: 1.0, leak: 50.0, armor: 0.0 },
        // Bosses: their hull for a full team (a lone pilot meets SOLO_SHARE of it).
        Kind::Excavator => Species { hull: 1800.0, hull_step: 0.0, speed: 2.0, spread: 0.0, leak: 600.0, armor: 6.0 },
        Kind::Hive => Species { hull: 3200.0, hull_step: 0.0, speed: 2.2, spread: 0.0, leak: 1000.0, armor: 4.0 },
        _ => Species { hull: 100.0, hull_step: 20.0, speed: 4.5, spread: 2.0, leak: LEAK, armor: 0.0 },
    }
}

/// A lane enemy's hull in wave `n`.
pub fn hull(kind: Kind, n: u8) -> f32 {
    let s = species(kind);
    s.hull + s.hull_step * f32::from(n)
}

/// What `amount` of damage does to a `kind` (its plating taken off).
pub fn armored(kind: Kind, amount: f32) -> f32 {
    let armor = species(kind).armor;
    if armor > 0.0 { (amount - armor).max(ARMOR_FLOOR * amount) } else { amount }
}
/// Walkers' owner ids, then towers' (for lock-on: `deploy::target_id` must stay a u8): past every
/// player's, ship's, base gun's and the hauler's, up to the last that fits.
const FIRST_OWNER: u8 = 16;
const LAST_OWNER: u8 = 63;
const FIRST_TOWER: u8 = 64;
const LAST_TOWER: u8 = 95;

/// What pilots build, in the order of `Build::Place`'s index, and each one's price in scrap.
pub const TOWERS: [Kind; 4] = [Kind::MgTurret, Kind::RocketTurret, Kind::Arc, Kind::Pulse];
pub const PRICES: [f32; 4] = [100.0, 150.0, 175.0, 200.0];
/// A tower's hull at tier 1; its tiers; what raising it a tier costs (UPGRADE of its price for
/// each tier it has), and what selling it refunds (REFUND of all that went into it).
pub const TOWER_HULL: f32 = 300.0;
pub const TIERS: u8 = 3;
pub const UPGRADE: f32 = 1.0;
const REFUND: f32 = 0.7;
/// The team's towers at most, by the reactor's grid level (GRID's last is every tower id there is,
/// LAST_TOWER - FIRST_TOWER + 1), and what raising the grid each level costs whoever does it.
pub const GRID: [usize; 3] = [24, 28, 32];
pub const GRID_COST: [f32; 2] = [250.0, 400.0];
/// Mending a tower all the way costs REPAIR of what's gone into it (less for less).
pub const REPAIR: f32 = 0.5;
/// Each pilot's scrap to start, for each hull point they (or their towers) shoot off a walker, and
/// for each wave beaten.
const START_SCRAP: f32 = 250.0;
const SCRAP_PER_HULL: f32 = 0.35;
const WAVE_BONUS: f32 = 100.0;
/// Where a tower goes: on ground within REACH of the eye, no steeper than FLAT (its normal's
/// rise), with ROOM over it; not within LANE_CLEAR of a lane's line, GAP of another tower, or
/// REACTOR_CLEAR of the reactor's reach.
pub const REACH: f32 = 30.0;
const FLAT: f32 = 0.85;
const ROOM: f32 = 3.0;
const LANE_CLEAR: f32 = 5.0;
const GAP: f32 = 4.0;
const REACTOR_CLEAR: f32 = 4.0;

/// A pilot's build order: put down `TOWERS[i]` where they aim, raise the tower they aim at a tier,
/// sell it or mend it; or call the next wave.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Build {
    Place(u8),
    Upgrade,
    Sell,
    /// Mend the tower aimed at, for scrap.
    Repair,
    /// Call the next wave now (in a break; it comes once every human pilot has).
    Call,
}

/// Why a build order didn't go through.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Refusal {
    /// No ground in reach where they aim.
    Reach,
    /// Too steep, or no room over it.
    Ground,
    /// In a lane.
    Lane,
    /// Too near another tower.
    Crowded,
    /// Too near the reactor.
    Reactor,
    /// Not enough scrap.
    Scrap,
    /// No tower aimed at, or (to sell) not theirs.
    Tower,
    /// The tower's at its top tier.
    Full,
    /// The team has as many towers as its grid takes (`GRID`).
    Towers,
    /// Nothing to repair: the tower's whole.
    Whole,
}

/// A pilot's perks for the run, drafted one in three after each wave beaten and from salvage
/// (`Defense::offer`): each makes what they build, or their own mech, better, stacking to its
/// `cap`. Blueprints (`rare`) come only from a boss's salvage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Perk {
    Plating,
    Overclock,
    Barrels,
    Chain,
    Bulk,
    Scavenger,
    Salvage,
    Frame,
    Hunter,
    Medic,
    Return,
    Flak,
    Sabot,
    Storm,
    Stasis,
}

pub const PERKS: [Perk; 15] = [
    Perk::Plating,
    Perk::Overclock,
    Perk::Barrels,
    Perk::Chain,
    Perk::Bulk,
    Perk::Scavenger,
    Perk::Salvage,
    Perk::Frame,
    Perk::Hunter,
    Perk::Medic,
    Perk::Return,
    Perk::Flak,
    Perk::Sabot,
    Perk::Storm,
    Perk::Stasis,
];

impl Perk {
    /// Its name, and what it does (each stack, for those that stack).
    pub fn describe(self) -> (&'static str, &'static str) {
        match self {
            Perk::Plating => ("Hardened plating", "Your towers have 25% more hull"),
            Perk::Overclock => ("Overclock", "Your towers fire 20% faster"),
            Perk::Barrels => ("Long barrels", "Your towers reach 15% further"),
            Perk::Chain => ("Chain reaction", "Your arc pylons' lightning jumps to 2 more"),
            Perk::Bulk => ("Bulk order", "What you build costs 15% less"),
            Perk::Scavenger => ("Scavenger", "25% more scrap from what you shoot down"),
            Perk::Salvage => ("Salvage rights", "Selling a tower refunds all it cost"),
            Perk::Frame => ("Reinforced frame", "Your mech takes 15% less damage"),
            Perk::Hunter => ("Hive hunter", "Your guns do 20% more to the hive"),
            Perk::Medic => ("Field medic", "Your torch mends 50% faster"),
            Perk::Return => ("Quick return", "You relaunch 30% sooner"),
            Perk::Flak => ("Blueprint: flak rounds", "Your MG towers' rounds burst, half again on each foe within 3 m"),
            Perk::Sabot => ("Blueprint: sabot rockets", "Your rocket towers punch through plating"),
            Perk::Storm => ("Blueprint: storm coil", "Your arc pylons reach 30% further, their first strike twice as hard"),
            Perk::Stasis => ("Blueprint: stasis field", "Your pulse pylons stun twice as long and recharge 30% faster"),
        }
    }

    pub fn rare(self) -> bool {
        matches!(self, Perk::Flak | Perk::Sabot | Perk::Storm | Perk::Stasis)
    }

    /// How many of it one pilot can hold.
    pub fn cap(self) -> u8 {
        if self.rare() || self == Perk::Salvage { 1 } else { 2 }
    }
}

/// A mortar walker's shell in the air: the tick it lands, where, and whose.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shell {
    pub lands: u32,
    pub at: Vector,
    pub owner: u8,
}

/// A tower: its owner id among the deployables, who built it, its tier, and the scrap gone into
/// it, and of that its builder's own (what selling it refunds them from: others' upgrades are
/// theirs to lose, not the builder's to cash in).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tower {
    pub owner: u8,
    pub by: u8,
    pub tier: u8,
    pub spent: f32,
    pub own: f32,
}

impl Tower {
    /// What raising it a tier costs (`kind` is its kind).
    pub fn upgrade(&self, kind: Kind) -> f32 {
        price(kind) * UPGRADE * f32::from(self.tier)
    }

    /// What selling it refunds its builder.
    pub fn refund(&self) -> f32 {
        REFUND * self.own
    }
}

/// `kind`'s price as a tower.
pub fn price(kind: Kind) -> f32 {
    TOWERS.iter().position(|&k| k == kind).map_or(0.0, |i| PRICES[i])
}

/// A tower's full hull at `tier`, its builder holding `plating` Hardened plating.
pub fn hull_whole(tier: u8, plating: f32) -> f32 {
    tower_hull(tier) * (1.0 + 0.25 * plating)
}

/// A tower at `tier`: its hull, its reach (times tier 1's), and its rate of fire (times tier 1's).
pub fn tower_hull(tier: u8) -> f32 {
    TOWER_HULL * (1.0 + 0.5 * f32::from(tier.max(1) - 1))
}
pub fn reach(tier: u8) -> f32 {
    1.0 + 0.15 * f32::from(tier.max(1) - 1)
}
pub fn rate(tier: u8) -> f32 {
    1.0 + 0.4 * f32::from(tier.max(1) - 1)
}

/// What players see of a run: the wave (the one on, or next), whether it's a break (and the
/// seconds left of it), the reactor's hull, and the walkers still to come or standing this wave.
/// Every pilot's scrap (by id), the towers, every pilot's draft on offer (the first, if more
/// wait), the perks pilots hold (who, which, how many), and salvage lying about (rare: a boss's).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DefenseNet {
    pub wave: u8,
    pub waves: u8,
    pub break_left: Option<f32>,
    pub hull: f32,
    pub left: u16,
    pub scrap: Vec<u16>,
    pub towers: Vec<Tower>,
    pub offers: Vec<(u8, Vec<Perk>)>,
    /// How many more drafts wait behind each pilot's on offer.
    pub waiting: Vec<(u8, u8)>,
    pub perks: Vec<(u8, Perk, u8)>,
    pub cores: Vec<(Vector, bool)>,
    /// In a break, the wave to come: its theme, and how many of each foe.
    pub theme: Theme,
    pub next: Vec<(Foe, u16)>,
    /// The gates open this wave (or the next, in a break), by index; the routes the Bloom has
    /// sealed (by index among the map's seals); the supply caches lying out.
    pub open: Vec<u8>,
    pub sealed: Vec<u8>,
    pub caches: Vec<Vector>,
    /// The run's score so far; the human pilots who've called the next wave this break; the
    /// towers the grid takes, and what raising it costs (0 at the top).
    pub score: u32,
    pub ready: Vec<u8>,
    pub capacity: u8,
    pub grid_cost: f32,
}

/// What happened in a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum News {
    /// Wave `n` is coming, `count` strong.
    Wave { n: u8, count: u16 },
    /// Wave `n` is beaten.
    Cleared(u8),
    /// A walker reached the reactor.
    Hit,
    /// A boss came through a gate.
    Boss(Kind),
    /// The Bloom sealed (or burst open) route `seal` (by index among the map's seals).
    Bloom { seal: u8, sealed: bool },
    /// Player `id` picked up a supply cache.
    Cache { id: u8 },
    /// Player `id` picked up salvage (`rare`: a boss's): a draft to pick from.
    Salvage { id: u8, rare: bool },
    /// Player `id`'s build order didn't go through.
    Refused { id: u8, why: Refusal },
    /// The break was called short, with `seconds` left.
    Called { seconds: u16 },
    /// The wave's stragglers hurry on (`DefenseSpots::hurry`).
    Hurry,
    /// The reactor's grid raised to `level` (0 the first), taking more towers.
    Grid { level: u8 },
}

/// Where a run stands.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stage {
    /// Getting ready for the next wave, till this tick.
    Break { until: u32 },
    /// A wave on: its next walker comes at this tick.
    Wave { next_at: u32 },
    Won,
}

/// A lane enemy on its lanes: its kind, the edge it's on and how far along (m), its place across
/// the lane, and the tick it's stunned till.
#[derive(Clone, Copy, Debug)]
struct Walker {
    owner: u8,
    kind: Kind,
    edge: usize,
    along: f32,
    offset: f32,
    stunned: u32,
    rush: u32,
}

/// What a tick asks of `Game`: lane enemies to put down (owner, kind, where, hull), infested mechs
/// to put down (where), lane enemies to move (owner, where on the lane, facing), lane enemies that
/// reached the reactor (gone), news, and the end.
#[derive(Debug, Default)]
pub struct Tick {
    pub spawn: Vec<(u8, Kind, Vector, f32)>,
    pub elites: Vec<Vector>,
    pub moves: Vec<(u8, Vector, f32)>,
    pub leaked: Vec<u8>,
    pub news: Vec<News>,
    pub lost: bool,
    pub won: bool,
}

pub struct Defense {
    /// The lanes: points, and edges (from, to, weight) toward the reactor; the points each gate
    /// starts at.
    points: Vec<Vector>,
    edges: Vec<(usize, usize, f32)>,
    narrow: Vec<usize>,
    gates: Vec<usize>,
    /// The routes the Bloom can seal (edges, by index, and names), those it has (by index among
    /// them), and the order the gates open in (by index).
    seals: Vec<(usize, String)>,
    sealed: Vec<usize>,
    gate_order: Vec<usize>,
    /// Supply caches lying out, and where they can (`cache_spots`).
    pub caches: Vec<Vector>,
    cache_spots: Vec<Vector>,
    pub reactor: Vector,
    pub radius: f32,
    pub hull: f32,
    /// The wave on (or next), its theme, its foes still to come (the next last; each with the gate
    /// it comes through, by index; drawn up at the break's start), its lane enemies standing, and
    /// its infested mechs alive (`Game`'s count).
    pub wave: u8,
    pub stage: Stage,
    theme: Theme,
    drawn: u8,
    queue: Vec<(Foe, usize)>,
    walkers: Vec<Walker>,
    elites: usize,
    /// The share of a full team's foes this wave (for bosses' hull); the map's pace (`DefenseSpots`).
    share: f32,
    bosses: f32,
    hurry: Option<(f32, f32)>,
    /// The tick last stepped.
    now: u32,
    /// Picks walkers' branches and places, run to run the same (xorshift).
    rng: u32,
    /// The foes come so far in the pack coming, and the tick the wave's last came (0: still to).
    pack: u8,
    last_came: u32,
    /// The run's score; the human pilots who've called the next wave this break.
    pub score: f32,
    pub ready: Vec<u8>,
    /// The reactor's grid level (`GRID`).
    pub grid: u8,
    /// Each player's scrap, by id; the towers standing.
    pub scrap: [f32; MAX_PLAYERS],
    pub towers: Vec<Tower>,
    /// Mortar shells in the air.
    pub shells: Vec<Shell>,
    /// Bots' builds in mind: whose, where (to stand, and aim down at), and the order.
    pub plans: Vec<(u8, Vector, Build)>,
    /// Drafts on offer (whose, the perks to pick from; several may wait for one pilot), the
    /// perks each pilot holds (by id, how many of each), and salvage lying about.
    pub offers: Vec<(u8, Vec<Perk>)>,
    pub perks: [[u8; PERKS.len()]; MAX_PLAYERS],
    pub cores: Vec<(Vector, bool)>,
}

impl Defense {
    /// The run on a map with `spots`, from tick `tick` (which seeds it); `route` is the bots' walk between two
    /// spots (for a map without lanes of its own: each gate's lane is then its route to the
    /// reactor). None without gates.
    pub fn new(spots: &DefenseSpots, tick: u32, route: impl Fn(Vector, Vector) -> Vec<Vector>) -> Option<Defense> {
        let reactor = Vector::from_array(spots.reactor);
        let gates: Vec<Vector> = spots.gates.iter().map(|g| Vector::from_array(*g)).collect();
        (!gates.is_empty()).then_some(())?;
        let (mut points, mut edges, mut starts) = (Vec::new(), Vec::new(), Vec::new());
        let narrow = spots.lanes.narrow.clone();
        if spots.lanes.points.is_empty() {
            for gate in gates {
                let walk: Vec<Vector> = std::iter::once(gate).chain(route(gate, reactor)).chain(std::iter::once(reactor)).collect();
                starts.push(points.len());
                for (k, p) in walk.iter().enumerate() {
                    if k > 0 {
                        edges.push((points.len() - 1, points.len(), 1.0));
                    }
                    points.push(*p);
                }
            }
        } else {
            points = spots.lanes.points.iter().map(|p| Vector::from_array(*p)).collect();
            edges.clone_from(&spots.lanes.edges);
            // Each gate starts at the lanes' point nearest it.
            let nearest = |g: Vector| (0..points.len()).min_by(|&a, &b| points[a].distance(g).total_cmp(&points[b].distance(g))).unwrap_or(0);
            starts = gates.into_iter().map(nearest).collect();
        }
        let seals = spots.lanes.seals.clone();
        let gate_order = (0..starts.len()).collect();
        let mut d = Defense {
            points,
            edges,
            narrow,
            gates: starts,
            seals,
            sealed: Vec::new(),
            gate_order,
            caches: Vec::new(),
            cache_spots: Vec::new(),
            reactor,
            radius: spots.radius,
            hull: REACTOR_HULL,
            wave: 1,
            stage: Stage::Break { until: tick + (FIRST_BREAK * TICK_HZ) as u32 },
            theme: Theme::Mixed,
            drawn: 0,
            queue: Vec::new(),
            walkers: Vec::new(),
            elites: 0,
            share: 1.0,
            bosses: spots.bosses.unwrap_or(1.0),
            hurry: spots.hurry,
            now: tick,
            rng: (0x9e37_79b9 ^ tick.wrapping_mul(0x85eb_ca6b)) | 1,
            pack: 0,
            last_came: 0,
            score: 0.0,
            ready: Vec::new(),
            grid: 0,
            scrap: [START_SCRAP; MAX_PLAYERS],
            towers: Vec::new(),
            shells: Vec::new(),
            plans: Vec::new(),
            offers: Vec::new(),
            perks: [[0; PERKS.len()]; MAX_PLAYERS],
            cores: Vec::new(),
        };
        d.vary();
        // Late gates (a burrow inside, say) open last, whatever the run's order.
        d.gate_order.sort_by_key(|g| spots.late.contains(g));
        Some(d)
    }

    /// The run's variations, from its seed: the order the gates open in, each fork's weights, and
    /// the routes sealed to start with.
    fn vary(&mut self) {
        for k in (1..self.gate_order.len()).rev() {
            let j = (self.rand() * (k + 1) as f32) as usize % (k + 1);
            self.gate_order.swap(k, j);
        }
        for p in 0..self.points.len() {
            let out: Vec<usize> = (0..self.edges.len()).filter(|&e| self.edges[e].0 == p).collect();
            if out.len() > 1 {
                for e in out {
                    self.edges[e].2 *= 0.5 + self.rand();
                }
            }
        }
        for _ in 0..SEALS_AT_START {
            self.bloom(true);
        }
    }

    /// Where supply caches can lie out (`Game`'s pick of waypoints, away from the reactor).
    pub fn set_cache_spots(&mut self, spots: Vec<Vector>) {
        self.cache_spots = spots;
    }

    /// The Bloom seals a route it can (`seal`, keeping every gate's way to the reactor) or bursts
    /// a sealed one open; which, if any.
    fn bloom(&mut self, seal: bool) -> Option<News> {
        let choices: Vec<usize> = if seal {
            (0..self.seals.len()).filter(|k| !self.sealed.contains(k)).filter(|&k| self.passable(&[self.sealed_edges(), vec![self.seals[k].0]].concat())).collect()
        } else {
            self.sealed.clone()
        };
        if choices.is_empty() {
            return None;
        }
        let pick = choices[(self.rand() * choices.len() as f32) as usize % choices.len()];
        if seal {
            self.sealed.push(pick);
        } else {
            self.sealed.retain(|&k| k != pick);
        }
        Some(News::Bloom { seal: pick as u8, sealed: seal })
    }

    /// The edges sealed.
    fn sealed_edges(&self) -> Vec<usize> {
        self.sealed.iter().map(|&k| self.seals[k].0).collect()
    }

    /// Whether, with `sealed` edges shut, every gate still has a way to the reactor, and (if the
    /// lanes give them one at all) one for big foes, off the narrow edges: a seal mustn't force a
    /// brute or boss through the Warren.
    fn passable(&self, sealed: &[usize]) -> bool {
        self.reaches(sealed) && (!self.reaches(&self.narrow) || self.reaches(&[sealed, &self.narrow[..]].concat()))
    }

    /// Whether every gate still has a way to the reactor with `sealed` edges shut.
    fn reaches(&self, sealed: &[usize]) -> bool {
        self.gates.iter().all(|&start| {
            let mut seen = vec![false; self.points.len()];
            let mut todo = vec![start];
            while let Some(p) = todo.pop() {
                if std::mem::replace(&mut seen[p], true) {
                    continue;
                }
                if (self.points[p] - self.reactor).with_y(0.0).length() <= self.radius {
                    return true;
                }
                todo.extend((0..self.edges.len()).filter(|e| self.edges[*e].0 == p && !sealed.contains(e)).map(|e| self.edges[e].1));
            }
            false
        })
    }

    /// The gates open on wave `n` (by index): the first of the run's order, more as it goes.
    pub fn open_gates(&self, n: u8) -> Vec<usize> {
        let k = if n <= GATES_ONE { 1 } else if n <= GATES_TWO { 2 } else { self.gate_order.len() };
        self.gate_order.iter().copied().take(k.max(1)).collect()
    }

    /// A route the Bloom can seal: its edge's ends, whether it's narrow, and its name.
    pub fn seal(&self, k: usize) -> Option<(Vector, Vector, bool, &str)> {
        let (e, name) = self.seals.get(k)?;
        let (a, b, _) = self.edges.get(*e)?;
        Some((self.points[*a], self.points[*b], self.narrow.contains(e), name))
    }

    /// Where a tower would go for a pilot aiming along `aim` (from the eye) with towers at `towers`
    /// already: the ground there, or why not.
    pub fn spot(&self, arena: &Arena, aim: &Ray, mut towers: impl Iterator<Item = Vector>) -> Result<Vector, Refusal> {
        let (toi, normal) = arena.cast_ray_normal(aim, REACH).ok_or(Refusal::Reach)?;
        let at = aim.point_at(toi);
        if normal.y < FLAT || arena.cast_ray(&Ray::new(at + Vector::Y * 0.1, Vector::Y), ROOM).is_some() {
            return Err(Refusal::Ground);
        }
        if self.in_lane(at) {
            return Err(Refusal::Lane);
        }
        if towers.any(|t| (t - at).with_y(0.0).length() < GAP && (t.y - at.y).abs() < ROOM) {
            return Err(Refusal::Crowded);
        }
        if (at - self.reactor).with_y(0.0).length() < self.radius + REACTOR_CLEAR {
            return Err(Refusal::Reactor);
        }
        Ok(at)
    }

    /// Whether `p` is within LANE_CLEAR of a lane's line (across, near its height).
    pub fn in_lane(&self, p: Vector) -> bool {
        self.edges.iter().any(|&(a, b, _)| {
            let (a, b) = (self.points[a], self.points[b]);
            let ab = (b - a).with_y(0.0);
            let s = ((p - a).with_y(0.0).dot(ab) / ab.length_squared().max(1e-6)).clamp(0.0, 1.0);
            let on = a.lerp(b, s);
            (p - on).with_y(0.0).length() < LANE_CLEAR && (p.y - on.y).abs() < ROOM + 2.0
        })
    }

    /// The lanes' lines, as segments (for drawing them).
    pub fn segments(&self) -> impl Iterator<Item = (Vector, Vector)> + '_ {
        self.edges.iter().map(|&(a, b, _)| (self.points[a], self.points[b]))
    }

    /// An owner id for a new tower, if the grid has room for one.
    pub fn free_tower(&self) -> Option<u8> {
        (self.towers.len() < self.capacity()).then_some(())?;
        (FIRST_TOWER..=LAST_TOWER).find(|o| !self.towers.iter().any(|t| t.owner == *o))
    }

    /// How many towers the grid takes, and what raising it costs (none at the top).
    pub fn capacity(&self) -> usize {
        GRID[usize::from(self.grid)]
    }
    pub fn grid_cost(&self) -> Option<f32> {
        GRID_COST.get(usize::from(self.grid)).copied()
    }

    /// Player `id` raises the grid a level, for its cost.
    pub fn raise_grid(&mut self, id: u8) -> Result<News, Refusal> {
        let cost = self.grid_cost().ok_or(Refusal::Full)?;
        let scrap = self.scrap.get_mut(usize::from(id)).ok_or(Refusal::Scrap)?;
        if *scrap < cost {
            return Err(Refusal::Scrap);
        }
        *scrap -= cost;
        self.grid += 1;
        Ok(News::Grid { level: self.grid })
    }

    pub fn tower(&self, owner: u8) -> Option<&Tower> {
        self.towers.iter().find(|t| t.owner == owner)
    }

    /// Who gets the credit for `attacker`'s damage: a tower's builder, else `attacker`.
    pub fn credit(&self, attacker: u8) -> u8 {
        self.tower(attacker).map_or(attacker, |t| t.by)
    }

    /// Scrap for player `id` for shooting `hull` off a walker.
    pub fn earn(&mut self, id: u8, hull: f32) {
        let more = 1.0 + 0.25 * self.perk(id, Perk::Scavenger);
        if let Some(s) = self.scrap.get_mut(usize::from(id)) {
            *s += SCRAP_PER_HULL * hull * more;
        }
        self.score += SCORE_PER_HULL * hull;
    }

    /// How many of `perk` player `id` holds.
    pub fn perk(&self, id: u8, perk: Perk) -> f32 {
        self.perks.get(usize::from(id)).map_or(0.0, |p| f32::from(p[perk as usize]))
    }

    /// How many of `perk` the builder of tower `owner` holds (0 for anything not a tower).
    pub fn tower_perk(&self, owner: u8, perk: Perk) -> f32 {
        self.tower(owner).map_or(0.0, |t| self.perk(t.by, perk))
    }

    /// Tower `owner`'s full hull, its reach and its rate of fire (times tier 1's), by its tier and
    /// its builder's perks (1s for anything not a tower).
    pub fn hull_max(&self, owner: u8) -> f32 {
        self.tower(owner).map_or(TOWER_HULL, |t| hull_whole(t.tier, self.perk(t.by, Perk::Plating)))
    }
    pub fn reach_of(&self, owner: u8) -> f32 {
        self.tower(owner).map_or(1.0, |t| reach(t.tier) * (1.0 + 0.15 * self.perk(t.by, Perk::Barrels)))
    }
    pub fn rate_of(&self, owner: u8) -> f32 {
        self.tower(owner).map_or(1.0, |t| rate(t.tier) * (1.0 + 0.2 * self.perk(t.by, Perk::Overclock)))
    }

    /// What `kind` costs player `id` to build.
    pub fn price_for(&self, id: u8, kind: Kind) -> f32 {
        price(kind) * (1.0 - 0.15 * self.perk(id, Perk::Bulk))
    }

    /// What selling `tower` refunds its builder.
    pub fn refund_of(&self, tower: &Tower) -> f32 {
        if self.perk(tower.by, Perk::Salvage) > 0.0 { tower.own } else { tower.refund() }
    }

    /// A draft for player `id`: three perks they can still take (blueprints if `rare`, made up
    /// with others if they hold most of those already), none twice.
    pub fn offer(&mut self, id: u8, rare: bool) {
        let open = |d: &Defense, p: &Perk| d.perk(id, *p) < f32::from(p.cap());
        let mut pool: Vec<Perk> = PERKS.iter().copied().filter(|p| p.rare() == rare && open(self, p)).collect();
        let mut picks = Vec::new();
        while picks.len() < 3 {
            if pool.is_empty() {
                pool = PERKS.iter().copied().filter(|p| !p.rare() && open(self, p) && !picks.contains(p)).collect();
                if pool.is_empty() {
                    break;
                }
            }
            let k = (self.rand() * pool.len() as f32) as usize % pool.len();
            picks.push(pool.swap_remove(k));
        }
        if !picks.is_empty() {
            self.offers.push((id, picks));
        }
    }

    /// Player `id` takes perk `choice` (0-2) of their draft on offer.
    pub fn draft(&mut self, id: u8, choice: u8) {
        let Some(k) = self.offers.iter().position(|o| o.0 == id) else { return };
        let Some(&perk) = self.offers[k].1.get(usize::from(choice)) else { return };
        self.offers.remove(k);
        if let Some(p) = self.perks.get_mut(usize::from(id)) {
            p[perk as usize] += 1;
        }
    }

    /// Stops the walkers `owners` in their tracks till tick `until`.
    pub fn stun(&mut self, owners: &[u8], until: u32) {
        for w in self.walkers.iter_mut().filter(|w| owners.contains(&w.owner)) {
            w.stunned = w.stunned.max(until);
        }
    }

    pub fn net(&self, tick: u32) -> DefenseNet {
        let break_left = match self.stage {
            Stage::Break { until } => Some(until.saturating_sub(tick) as f32 * DT),
            _ => None,
        };
        let left = match self.stage {
            Stage::Wave { .. } => (self.queue.len() + self.walkers.len() + self.elites) as u16,
            _ => 0,
        };
        let scrap = self.scrap.iter().map(|s| s.round() as u16).collect();
        let (mut offers, mut waiting): (Vec<(u8, Vec<Perk>)>, Vec<(u8, u8)>) = (Vec::new(), Vec::new());
        for (id, o) in &self.offers {
            if !offers.iter().any(|(i, _)| i == id) {
                offers.push((*id, o.clone()));
            } else if let Some(w) = waiting.iter_mut().find(|w| w.0 == *id) {
                w.1 += 1;
            } else {
                waiting.push((*id, 1));
            }
        }
        let perks = (0..MAX_PLAYERS as u8).flat_map(|id| PERKS.iter().filter(move |&&p| self.perk(id, p) > 0.0).map(move |&p| (id, p, self.perk(id, p) as u8))).collect();
        let mut next: Vec<(Foe, u16)> = Vec::new();
        if matches!(self.stage, Stage::Break { .. }) {
            for (foe, _) in &self.queue {
                match next.iter_mut().find(|(f, _)| f == foe) {
                    Some((_, n)) => *n += 1,
                    None => next.push((*foe, 1)),
                }
            }
        }
        let open = self.open_gates(self.wave).into_iter().map(|g| g as u8).collect();
        let sealed = self.sealed.iter().map(|&k| k as u8).collect();
        DefenseNet { wave: self.wave, waves: WAVES, break_left, hull: self.hull, left, scrap, towers: self.towers.clone(), offers, waiting, perks, cores: self.cores.clone(), theme: self.theme, next, open, sealed, caches: self.caches.clone(), score: self.score.round() as u32, ready: self.ready.clone(), capacity: self.capacity() as u8, grid_cost: self.grid_cost().unwrap_or(0.0) }
    }

    /// Where each mech (its id, its team, whether it's a living bot) should head with lane enemies standing
    /// at `walkers`: every pilots' bot to the one nearest the reactor; with none, round the
    /// reactor, each to its own spot on a ring just out of the reactor's reach.
    pub fn orders(&self, mechs: &[(u8, u8, bool)], walkers: &[Vector]) -> Vec<Option<Vector>> {
        let front = walkers.iter().copied().min_by(|a, b| a.distance(self.reactor).total_cmp(&b.distance(self.reactor)));
        let ring = |k: usize| {
            let a = k as f32 * std::f32::consts::TAU / mechs.len().max(1) as f32;
            self.reactor + Vector::new(a.cos(), 0.0, a.sin()) * (self.radius + 8.0)
        };
        // Infested mechs make for the reactor, fighting whoever they meet; a bot with a build in
        // mind heads for its spot.
        let plan = |id| self.plans.iter().find(|q| q.0 == id).map(|q| q.1);
        (0..mechs.len())
            .map(|k| {
                let (id, team, bot) = mechs[k];
                bot.then(|| if team == 1 { self.reactor } else { plan(id).or(front).unwrap_or_else(|| ring(k)) })
            })
            .collect()
    }

    /// Draws up wave `n` for `pilots` on the team: its theme (from wave 3; one whose foe has come
    /// by then), and its foes in the order they come, each with its gate (by index). On the wave
    /// a foe first comes on, one comes first; then the budget is spent a card at a time, by
    /// weight (the theme's foe THEME_LEAN times as likely), till none it can afford is left; a
    /// boss wave's boss comes a third of the way through. They come a shield node, a couple of
    /// walkers, a pack of crawlers, a brute, an infested mech, a mortar walker, and again.
    pub fn compose(&mut self, n: u8, pilots: usize) -> (Theme, Vec<(Foe, usize)>) {
        let n = n.clamp(1, WAVES);
        let themes: Vec<Theme> = [Theme::Mixed, Theme::Swarm, Theme::Armor, Theme::Siege, Theme::Shielded, Theme::Flank].into_iter().filter(|t| n >= 3 && t.leans().1 <= n).collect();
        let theme = if themes.is_empty() { Theme::Mixed } else { themes[(self.rand() * themes.len() as f32) as usize % themes.len()] };
        let mut budget = BUDGETS[usize::from(n) - 1] * Defense::share(pilots);
        let mut counts = [0u16; CARDS.len()];
        let buy = |k: usize, counts: &mut [u16; CARDS.len()], budget: &mut f32| {
            counts[k] += CARDS[k].pack;
            *budget -= CARDS[k].cost;
        };
        for k in (0..CARDS.len()).filter(|&k| CARDS[k].from == n) {
            buy(k, &mut counts, &mut budget);
        }
        loop {
            let open: Vec<(usize, f32)> = (0..CARDS.len())
                .filter(|&k| CARDS[k].from <= n && CARDS[k].cost <= budget + 1e-3 && counts[k] + CARDS[k].pack <= CARDS[k].most)
                .map(|k| (k, CARDS[k].weight * if theme.leans().0 == Some(CARDS[k].foe) { THEME_LEAN } else { 1.0 }))
                .collect();
            if open.is_empty() {
                break;
            }
            let mut pick = self.rand() * open.iter().map(|o| o.1).sum::<f32>();
            let k = open.iter().find(|o| {
                pick -= o.1;
                pick <= 0.0
            });
            buy(k.unwrap_or(open.last().unwrap()).0, &mut counts, &mut budget);
        }
        // In order: a shield node, two walkers, a pack, a brute, an infested mech, a mortar.
        let order = [(5, 1), (0, 2), (1, 4), (2, 1), (4, 1), (3, 1)];
        let mut foes = Vec::new();
        while counts.iter().any(|&c| c > 0) {
            for (k, take) in order {
                let m = counts[k].min(take);
                foes.extend(std::iter::repeat_n(CARDS[k].foe, usize::from(m)));
                counts[k] -= m;
            }
        }
        if let Some(&(_, boss)) = BOSS_WAVES.iter().find(|(w, _)| *w == n) {
            foes.insert(foes.len() / 3, Foe::Lane(boss));
        }
        let open = self.open_gates(n);
        let gates = open.len().max(1);
        let main = (self.rand() * gates as f32) as usize % gates;
        let out = foes
            .into_iter()
            .enumerate()
            .map(|(k, foe)| {
                let gate = if theme == Theme::Flank { if self.rand() < FLANK { main } else { (self.rand() * gates as f32) as usize % gates } } else { k % gates };
                (foe, open.get(gate).copied().unwrap_or(0))
            })
            .collect();
        (theme, out)
    }

    /// The share of a full team's foes `pilots` meet.
    fn share(pilots: usize) -> f32 {
        let full = crate::game::TEAM_SIZE;
        SOLO_SHARE + (1.0 - SOLO_SHARE) * (pilots.clamp(1, full) - 1) as f32 / (full - 1) as f32
    }

    /// One tick at `tick` with `pilots` (their ids) on the team, the lane enemies and towers still
    /// standing (their owners; any not among them fell), and the infested mechs alive: breaks and
    /// waves (and scrap for each pilot for each beaten), foes coming through the gates in turn,
    /// lane enemies walking their lanes (the next edge picked by weight at each fork) unless
    /// stunned, and reaching the reactor.
    pub fn step(&mut self, tick: u32, pilots: &[u8], standing: &[u8], elites: usize) -> Tick {
        let mut out = Tick::default();
        self.now = tick;
        self.walkers.retain(|w| standing.contains(&w.owner));
        self.towers.retain(|t| standing.contains(&t.owner));
        self.elites = elites;
        // A break begun: the next wave drawn up, to see coming, and supply caches put out.
        if matches!(self.stage, Stage::Break { .. }) && self.drawn != self.wave {
            let (theme, mut queue) = self.compose(self.wave, pilots.len());
            queue.reverse();
            (self.theme, self.queue, self.drawn, self.share) = (theme, queue, self.wave, Defense::share(pilots.len()));
            self.caches.clear();
            for _ in 0..CACHES.min(self.cache_spots.len()) {
                let k = (self.rand() * self.cache_spots.len() as f32) as usize % self.cache_spots.len();
                let at = self.cache_spots[k];
                if !self.caches.contains(&at) {
                    self.caches.push(at);
                }
            }
        }
        match self.stage {
            Stage::Break { until } if tick >= until => {
                self.stage = Stage::Wave { next_at: tick };
                (self.pack, self.last_came) = (0, 0);
                self.ready.clear();
                out.news.push(News::Wave { n: self.wave, count: self.queue.len() as u16 });
            }
            Stage::Wave { next_at } if tick >= next_at && !self.queue.is_empty() => {
                let (foe, gate) = *self.queue.last().unwrap();
                let gate = self.gates[gate % self.gates.len()];
                let came = match foe {
                    Foe::Elite => {
                        out.elites.push(self.points[gate]);
                        true
                    }
                    Foe::Lane(kind) => {
                        let owner = (FIRST_OWNER..=LAST_OWNER).find(|o| !standing.contains(o) && !self.walkers.iter().any(|w| w.owner == *o));
                        let offset = species(kind).spread * (2.0 * self.rand() - 1.0);
                        match (owner, self.fork(gate, kind)) {
                            (Some(owner), Some(edge)) => {
                                self.walkers.push(Walker { owner, kind, edge, along: 0.0, offset, stunned: 0, rush: 0 });
                                out.spawn.push((owner, kind, self.points[gate], self.hull_of(kind)));
                                if kind.boss() {
                                    out.news.push(News::Boss(kind));
                                }
                                true
                            }
                            // No room for another: next tick.
                            _ => false,
                        }
                    }
                };
                if came {
                    let foe = self.queue.pop().map(|q| q.0);
                    let crawlers = foe == Some(Foe::Lane(Kind::Crawler)) && self.queue.last().map(|q| q.0) == foe;
                    // A crawler pack counts as one of its pack.
                    if !crawlers {
                        self.pack += 1;
                    }
                    let gap = if crawlers {
                        CRAWLER_GAP
                    } else if self.pack >= PACK {
                        self.pack = 0;
                        PACK_PAUSE
                    } else {
                        PACK_GAP
                    };
                    self.stage = Stage::Wave { next_at: tick + (gap * TICK_HZ) as u32 };
                    if self.queue.is_empty() {
                        self.last_came = tick;
                    }
                }
            }
            Stage::Wave { .. } if self.queue.is_empty() && self.walkers.is_empty() && elites == 0 => {
                out.news.push(News::Cleared(self.wave));
                self.score += WAVE_SCORE;
                for &id in pilots {
                    if let Some(s) = self.scrap.get_mut(usize::from(id)) {
                        *s += WAVE_BONUS;
                    }
                    self.offer(id, false);
                }
                if self.wave >= WAVES {
                    self.stage = Stage::Won;
                    self.score += self.hull;
                    out.won = true;
                } else {
                    self.wave += 1;
                    self.stage = Stage::Break { until: tick + (BREAK * TICK_HZ) as u32 };
                    // The Bloom shifts: a route sealed, or one burst open.
                    if self.rand() < BLOOM_CHANGE {
                        let seal = self.sealed.is_empty() || self.rand() < 0.5;
                        out.news.extend(self.bloom(seal).or_else(|| self.bloom(!seal)));
                    }
                }
            }
            _ => {}
        }
        if self.hurry.is_some_and(|(after, _)| self.last_came > 0 && tick == self.last_came + (after * TICK_HZ) as u32) && self.walkers.iter().any(|w| !w.kind.boss()) {
            out.news.push(News::Hurry);
        }
        // Each walker on along its lanes, at its place across them.
        let mut gone = Vec::new();
        for i in 0..self.walkers.len() {
            let mut w = self.walkers[i];
            if tick >= w.stunned {
                w.along += self.pace(&w) * DT;
            }
            loop {
                let (a, b, _) = self.edges[w.edge];
                let len = self.points[a].distance(self.points[b]);
                if w.along < len {
                    break;
                }
                match self.fork(b, w.kind) {
                    Some(next) => (w.edge, w.along) = (next, w.along - len),
                    None => {
                        w.along = len;
                        break;
                    }
                }
            }
            let (at, dir) = self.place(&w);
            self.walkers[i] = w;
            if (at - self.reactor).with_y(0.0).length() <= self.radius {
                gone.push((w.owner, w.kind));
            } else {
                out.moves.push((w.owner, at, (-dir.x).atan2(-dir.z)));
            }
        }
        for (owner, kind) in gone {
            self.walkers.retain(|w| w.owner != owner);
            self.leak(species(kind).leak);
            out.leaked.push(owner);
            out.news.push(News::Hit);
        }
        out.lost = self.hull <= 0.0;
        out
    }

    /// Where walker `w` is, and the way its lane runs there.
    fn place(&self, w: &Walker) -> (Vector, Vector) {
        let (a, b, _) = self.edges[w.edge];
        let dir = (self.points[b] - self.points[a]).normalize_or_zero();
        let across = Vector::new(-dir.z, 0.0, dir.x);
        (self.points[a] + dir * w.along + across * w.offset, dir)
    }

    /// A lane enemy of `kind`'s full hull this wave (a boss's, as many pilots meet it).
    pub fn hull_of(&self, kind: Kind) -> f32 {
        hull(kind, self.wave) * if kind.boss() { self.share * self.bosses } else { 1.0 }
    }

    /// Lane enemy `owner`'s velocity as of the last tick (zero stunned, or for anything else): for
    /// towers to lead it.
    pub fn velocity(&self, owner: u8) -> Vector {
        let Some(w) = self.walkers.iter().find(|w| w.owner == owner) else { return Vector::ZERO };
        if self.now < w.stunned {
            return Vector::ZERO;
        }
        self.place(w).1 * self.pace(w)
    }

    /// How fast walker `w` walks (m/s): its kind's pace, RUSH times it burrowing, the map's hurry
    /// times it straggling (not a boss).
    fn pace(&self, w: &Walker) -> f32 {
        let hurry = self.hurry.filter(|&(after, _)| self.last_came > 0 && self.now >= self.last_came + (after * TICK_HZ) as u32 && !w.kind.boss());
        species(w.kind).speed * if self.now < w.rush { RUSH } else { hurry.map_or(1.0, |(_, how)| how) }
    }

    /// Human pilot `id` calls the next wave (in a break): once every one of `humans` has, it
    /// comes now, and each of `pilots` gets CALL_SCRAP, and the run CALL_SCORE, for each second
    /// the break had left. What came of it, if it came.
    pub fn call(&mut self, id: u8, humans: &[u8], pilots: &[u8], tick: u32) -> Option<News> {
        let Stage::Break { until } = self.stage else { return None };
        if !self.ready.contains(&id) {
            self.ready.push(id);
        }
        if !humans.iter().all(|h| self.ready.contains(h)) {
            return None;
        }
        let left = until.saturating_sub(tick) as f32 * DT;
        for &p in pilots {
            if let Some(s) = self.scrap.get_mut(usize::from(p)) {
                *s += CALL_SCRAP * left;
            }
        }
        self.score += CALL_SCORE * left;
        self.stage = Stage::Break { until: tick };
        Some(News::Called { seconds: left.round() as u16 })
    }

    /// What mending `tower` from `hull` to `max` costs.
    pub fn repair_cost(tower: &Tower, hull: f32, max: f32) -> f32 {
        REPAIR * tower.spent * ((max - hull) / max).clamp(0.0, 1.0)
    }

    /// Lane enemy `owner` walks RUSH times its pace till tick `until`.
    pub fn rush(&mut self, owner: u8, until: u32) {
        for w in self.walkers.iter_mut().filter(|w| w.owner == owner) {
            w.rush = until;
        }
    }

    /// `n` lane enemies of `kind` (this wave's hull) born where lane enemy `parent` is, on its
    /// lane, owners not among `taken` (as many as there are free); what `Game` puts down.
    pub fn brood(&mut self, parent: u8, kind: Kind, n: usize, taken: &[u8]) -> Vec<(u8, Kind, Vector, f32)> {
        let Some(&p) = self.walkers.iter().find(|w| w.owner == parent) else { return Vec::new() };
        let mut out = Vec::new();
        for _ in 0..n {
            let Some(owner) = (FIRST_OWNER..=LAST_OWNER).find(|o| !taken.contains(o) && !self.walkers.iter().any(|w| w.owner == *o)) else { break };
            let offset = species(kind).spread * (2.0 * self.rand() - 1.0);
            let w = Walker { owner, kind, offset, stunned: 0, rush: 0, ..p };
            self.walkers.push(w);
            out.push((owner, kind, self.place(&w).0, hull(kind, self.wave)));
        }
        out
    }

    /// The reactor hit for `amount`.
    pub fn leak(&mut self, amount: f32) {
        self.hull = (self.hull - amount).max(0.0);
    }

    /// The edge out of point `p` a walker of `kind` takes, by weight (None at a lane's end): a big
    /// one (a brute or boss) not a narrow one, where there's another.
    fn fork(&mut self, p: usize, kind: Kind) -> Option<usize> {
        let mut out: Vec<usize> = (0..self.edges.len()).filter(|&e| self.edges[e].0 == p).collect();
        let sealed = self.sealed_edges();
        if out.iter().any(|e| !sealed.contains(e)) {
            out.retain(|e| !sealed.contains(e));
        }
        if kind.lane_body().0 >= BIG && out.iter().any(|e| !self.narrow.contains(e)) {
            out.retain(|e| !self.narrow.contains(e));
        }
        let total: f32 = out.iter().map(|&e| self.edges[e].2.max(0.0)).sum();
        let mut pick = self.rand() * total;
        for &e in &out {
            pick -= self.edges[e].2.max(0.0);
            if pick <= 0.0 {
                return Some(e);
            }
        }
        out.last().copied()
    }

    /// Uniform in [0, 1).
    fn rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng >> 8) as f32 / (1u32 << 24) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Lanes;

    /// Two gates 100 m out, a straight lane each, to a reactor at the origin (radius 6).
    fn run() -> Defense {
        let spots = DefenseSpots { reactor: [0.0; 3], radius: 6.0, gates: vec![[0.0, 0.0, -100.0], [100.0, 0.0, 0.0]], lanes: Lanes::default(), ..Default::default() };
        Defense::new(&spots, 0, |_, _| Vec::new()).unwrap()
    }

    /// Steps `d` from `from` for `seconds`, its walkers all standing; the ticks' outcomes.
    fn steps(d: &mut Defense, from: u32, seconds: f32) -> Vec<Tick> {
        let mut out = Vec::new();
        for t in from..from + (seconds * TICK_HZ) as u32 {
            let standing: Vec<u8> = d.walkers.iter().map(|w| w.owner).collect();
            out.push(d.step(t, &[0, 1, 2, 3], &standing, 0));
        }
        out
    }

    #[test]
    fn the_grid_takes_more_towers_raised_a_level_at_a_time() {
        let mut d = run();
        assert_eq!(*GRID.last().unwrap(), usize::from(LAST_TOWER - FIRST_TOWER + 1), "the top level takes every tower id");
        d.towers = (FIRST_TOWER..FIRST_TOWER + GRID[0] as u8).map(|owner| Tower { owner, by: 0, tier: 1, spent: 100.0, own: 100.0 }).collect();
        assert_eq!(d.free_tower(), None);
        d.scrap[0] = GRID_COST[0] - 1.0;
        assert_eq!(d.raise_grid(0), Err(Refusal::Scrap));
        d.scrap[0] = 1000.0;
        assert_eq!(d.raise_grid(0), Ok(News::Grid { level: 1 }));
        assert_eq!((d.capacity(), d.scrap[0]), (GRID[1], 1000.0 - GRID_COST[0]));
        assert!(d.free_tower().is_some());
        assert_eq!(d.raise_grid(0), Ok(News::Grid { level: 2 }));
        assert_eq!(d.raise_grid(0), Err(Refusal::Full));
    }

    #[test]
    fn foes_come_in_packs_and_a_map_can_harden_bosses_and_hurry_stragglers() {
        // A gate 200 m out, so the brutes are still walking when they'd hurry.
        let (after, how) = (30.0, 1.25);
        let plain = DefenseSpots { reactor: [0.0; 3], radius: 6.0, gates: vec![[0.0, 0.0, -200.0]], ..Default::default() };
        let paced = DefenseSpots { bosses: Some(1.5), hurry: Some((after, how)), ..plain.clone() };
        for spots in [plain, paced] {
            let mut d = Defense::new(&spots, 0, |_, _| Vec::new()).unwrap();
            steps(&mut d, 0, 0.1);
            // Seven brutes and the Hive through gate 0 (the queue comes from its end).
            d.queue = std::iter::once((Foe::Lane(Kind::Hive), 0)).chain(std::iter::repeat_n((Foe::Lane(Kind::Brute), 0), 7)).collect();
            d.stage = Stage::Break { until: 10 };
            // (Long enough to hurry, not for the first to reach the reactor.)
            let out = steps(&mut d, 10, after + 9.0);
            let came: Vec<u32> = out.iter().enumerate().filter(|(_, o)| !o.spawn.is_empty()).map(|(t, _)| t as u32).collect();
            let gaps: Vec<u32> = came.windows(2).map(|w| w[1] - w[0]).collect();
            let (gap, pause) = ((PACK_GAP * TICK_HZ) as u32, (PACK_PAUSE * TICK_HZ) as u32);
            assert_eq!(gaps, [gap, gap, gap, gap, gap, pause, gap]);
            // Paced, the Hive comes half again as tough, and `after` s on from it the
            // stragglers hurry, called out, but the Hive keeps its pace.
            let (bosses, hurry) = if spots.hurry.is_some() { (1.5, how) } else { (1.0, 1.0) };
            let hive = out[came[7] as usize].spawn[0].3;
            assert!((hive - hull(Kind::Hive, d.wave) * d.share * bosses).abs() < 1e-3, "{hive}");
            let hurried = spots.hurry.map(|_| (came[7] as f32 + after * TICK_HZ) as usize);
            assert_eq!(out.iter().position(|o| o.news.contains(&News::Hurry)), hurried);
            let pace = |d: &Defense, k: Kind| d.walkers.iter().find(|w| w.kind == k).map(|w| d.velocity(w.owner).length()).unwrap();
            assert!((pace(&d, Kind::Brute) - species(Kind::Brute).speed * hurry).abs() < 1e-3);
            assert!((pace(&d, Kind::Hive) - species(Kind::Hive).speed).abs() < 1e-3);
        }
    }

    #[test]
    fn a_break_called_short_by_every_human_pays_each_pilot_and_the_score() {
        let mut d = run();
        steps(&mut d, 0, 0.1);
        let t = 100;
        let Stage::Break { until } = d.stage else { panic!("not a break") };
        let left = (until - t) as f32 * DT;
        let bot = d.scrap[2];
        // One of two humans isn't enough.
        assert_eq!(d.call(0, &[0, 1], &[0, 1, 2], t), None);
        assert_eq!((d.stage, d.ready.clone()), (Stage::Break { until }, vec![0]));
        assert_eq!(d.call(1, &[0, 1], &[0, 1, 2], t), Some(News::Called { seconds: left.round() as u16 }));
        assert!((d.scrap[2] - bot - CALL_SCRAP * left).abs() < 1e-3 && (d.score - CALL_SCORE * left).abs() < 1e-3);
        // The wave comes at once; out of a break, a call does nothing.
        steps(&mut d, t, 0.1);
        assert!(matches!(d.stage, Stage::Wave { .. }) && d.ready.is_empty());
        assert_eq!(d.call(0, &[0], &[0], t + 5), None);
    }

    /// What `foes` cost the director (a boss nothing).
    fn spent(foes: &[(Foe, usize)]) -> f32 {
        foes.iter().filter_map(|(f, _)| CARDS.iter().find(|c| c.foe == *f)).map(|c| c.cost / f32::from(c.pack)).sum()
    }

    #[test]
    fn the_director_spends_each_waves_budget_bringing_each_foe_in_on_its_wave() {
        let mut d = run();
        for n in 1..=WAVES {
            let (theme, foes) = d.compose(n, 4);
            assert!(spent(&foes) <= BUDGETS[usize::from(n) - 1] + 1e-3, "wave {n} over budget");
            assert!(spent(&foes) >= BUDGETS[usize::from(n) - 1] - 1.0, "wave {n} left budget unspent");
            for c in &CARDS {
                let has = foes.iter().any(|(f, _)| *f == c.foe);
                assert!(n >= c.from || !has, "{:?} before wave {}", c.foe, c.from);
                assert!(n != c.from || has, "{:?} not on its wave {n}", c.foe);
            }
            let bosses = foes.iter().filter(|(f, _)| matches!(f, Foe::Lane(k) if k.boss())).count();
            assert_eq!(bosses, usize::from(n == 5 || n == 10));
            assert!(n >= 3 || theme == Theme::Mixed);
            assert!(foes.iter().all(|(_, g)| *g < 2));
        }
        // A lone pilot's waves are smaller; crawlers come in packs of four.
        let (_, solo) = run().compose(8, 1);
        let (_, full) = run().compose(8, 4);
        assert!(spent(&solo) < spent(&full));
        let (_, foes) = run().compose(3, 4);
        let at = foes.iter().position(|(f, _)| *f == Foe::Lane(Kind::Crawler)).unwrap();
        assert!(foes[at..at + 4].iter().all(|(f, _)| *f == Foe::Lane(Kind::Crawler)));
    }

    #[test]
    fn gates_open_over_the_run_and_the_bloom_seals_routes_without_cutting_a_gate_off() {
        // Gates: one, then two, then all three, in the run's order.
        let lanes = Lanes {
            // Three gates' lanes into a hub, then two ways on to the reactor: a seal on either alone
            // is fine, but never both.
            points: vec![[0.0, 0.0, -100.0], [50.0, 0.0, -100.0], [-50.0, 0.0, -100.0], [0.0, 0.0, -50.0], [20.0, 0.0, -20.0], [-20.0, 0.0, -20.0], [0.0, 0.0, 0.0]],
            edges: vec![(0, 3, 1.0), (1, 3, 1.0), (2, 3, 1.0), (3, 4, 1.0), (3, 5, 1.0), (4, 6, 1.0), (5, 6, 1.0)],
            narrow: vec![],
            seals: vec![(3, "the east way".into()), (4, "the west way".into())],
        };
        let spots = DefenseSpots { reactor: [0.0; 3], radius: 6.0, gates: vec![[0.0, 0.0, -100.0], [50.0, 0.0, -100.0], [-50.0, 0.0, -100.0]], lanes, ..Default::default() };
        for seed in 0..20 {
            let mut d = Defense::new(&spots, seed, |_, _| Vec::new()).unwrap();
            assert_eq!([1, 3, 6, 10].map(|n| d.open_gates(n).len()), [1, 2, 3, 3]);
            assert!(d.open_gates(3).starts_with(&d.open_gates(1)));
            for n in 1..=WAVES {
                let open = d.open_gates(n);
                assert!(d.compose(n, 4).1.iter().all(|(_, g)| open.contains(g)));
            }
            assert_eq!(d.sealed.len(), SEALS_AT_START, "seed {seed}");
            // Sealing all it can leaves a way through.
            for _ in 0..5 {
                d.bloom(true);
            }
            assert_eq!(d.sealed.len(), 1);
            assert!(d.reaches(&d.sealed_edges()));
        }
        // A late gate (a burrow) opens last in every run.
        let late = DefenseSpots { late: vec![0], ..spots.clone() };
        for seed in 0..20 {
            let d = Defense::new(&late, seed, |_, _| Vec::new()).unwrap();
            assert!(!d.open_gates(5).contains(&0) && d.open_gates(6).contains(&0), "seed {seed}");
        }
        // A seal never forces big foes onto a narrow lane: with the hub's east way narrow, the
        // west way is never sealed.
        let mut spots = spots.clone();
        spots.lanes.narrow = vec![3, 5];
        for seed in 0..20 {
            let mut d = Defense::new(&spots, seed, |_, _| Vec::new()).unwrap();
            for _ in 0..5 {
                d.bloom(true);
            }
            assert!(!d.sealed.contains(&1), "seed {seed}: the wide way sealed");
            // A walker at the hub takes the open way.
            let open_edge = if d.sealed == [0] { 4 } else { 3 };
            assert!((0..20).all(|_| d.fork(3, Kind::Walker) == Some(open_edge)));
        }
    }

    #[test]
    fn runs_differ_by_their_seed_and_a_flanking_wave_comes_mostly_through_one_gate() {
        let spots = DefenseSpots { reactor: [0.0; 3], radius: 6.0, gates: vec![[0.0, 0.0, -100.0], [100.0, 0.0, 0.0]], lanes: Lanes::default(), ..Default::default() };
        let waves = |seed: u32| {
            let mut d = Defense::new(&spots, seed, |_, _| Vec::new()).unwrap();
            (1..=WAVES).map(|n| d.compose(n, 4)).collect::<Vec<_>>()
        };
        assert_eq!(waves(7), waves(7));
        assert_ne!(waves(7), waves(8));
        let flank = (0..40).flat_map(waves).find(|(t, _)| *t == Theme::Flank).expect("no flanking wave in 40 runs").1;
        let main = (0..2).max_by_key(|g| flank.iter().filter(|(_, x)| x == g).count()).unwrap();
        assert!(flank.iter().filter(|(_, g)| *g == main).count() as f32 >= 0.65 * flank.len() as f32);
    }

    #[test]
    fn plating_takes_a_bite_out_of_each_hit_but_not_all_of_it() {
        let armor = species(Kind::Brute).armor;
        assert_eq!(armored(Kind::Walker, 3.0), 3.0);
        assert_eq!(armored(Kind::Brute, 40.0), 40.0 - armor);
        assert_eq!(armored(Kind::Brute, 2.0), ARMOR_FLOOR * 2.0);
    }

    #[test]
    fn after_the_break_a_wave_comes_through_the_gates_in_turn_and_walks_at_the_reactor() {
        let mut d = run();
        let t0 = (FIRST_BREAK * TICK_HZ) as u32;
        assert!(steps(&mut d, 0, FIRST_BREAK - 0.1).iter().all(|t| t.spawn.is_empty()));
        let ticks = steps(&mut d, t0 - 3, 3.0);
        assert!(ticks.iter().any(|t| t.news.contains(&News::Wave { n: 1, count: 6 })));
        // Wave 1 through the one gate open first (the run's pick).
        let spawned: Vec<Vector> = ticks.iter().flat_map(|t| t.spawn.iter().map(|s| s.2)).collect();
        let gate = [Vector::new(0.0, 0.0, -100.0), Vector::new(100.0, 0.0, 0.0)][d.open_gates(1)[0]];
        assert_eq!(spawned[..2], [gate, gate], "the open gate");
        // They close on it at a walker's walk.
        let (speed, spread) = (species(Kind::Walker).speed, species(Kind::Walker).spread);
        let ticks = steps(&mut d, t0 + 90, 1.0);
        let first = ticks.last().unwrap().moves.iter().find(|m| m.0 == FIRST_OWNER).unwrap().1;
        // (Straight at the reactor at the origin, within its place across the lane.)
        assert!(gate.length() - first.length() > speed * 3.0, "{first}");
        assert!((first - gate.normalize() * first.dot(gate.normalize())).length() <= spread + 1e-3, "{first}");
    }

    #[test]
    fn walkers_reaching_it_hit_the_reactor_and_enough_lose_the_run() {
        let mut d = run();
        let ticks = steps(&mut d, 0, FIRST_BREAK + 30.0);
        let hits = ticks.iter().flat_map(|t| &t.leaked).count();
        assert_eq!(hits, 6, "the whole first wave walked in");
        assert!((d.hull - (REACTOR_HULL - 6.0 * LEAK)).abs() < 1e-3);
        assert!(ticks.iter().any(|t| t.news.contains(&News::Cleared(1))) && d.wave == 2);
        d.hull = LEAK;
        let ticks = steps(&mut d, (FIRST_BREAK + 30.0) as u32 * TICK_HZ as u32, BREAK + 40.0);
        assert!(ticks.iter().any(|t| t.lost));
    }

    #[test]
    fn walkers_shot_down_clear_the_wave_and_the_last_wave_wins() {
        let mut d = run();
        d.wave = WAVES;
        let mut t = 0;
        let mut won = false;
        while t < ((FIRST_BREAK + 180.0) * TICK_HZ) as u32 && !won {
            // Every walker falls as soon as it comes.
            let out = d.step(t, &[0, 1, 2, 3], &[], 0);
            won = out.won;
            t += 1;
        }
        assert!(won && d.stage == Stage::Won && d.hull == REACTOR_HULL);
    }

    #[test]
    fn at_a_fork_walkers_take_each_branch_by_weight() {
        // A gate at the origin forking to two points, 3 to 1, each a dead end away from the reactor.
        let lanes = Lanes { points: vec![[0.0, 0.0, 0.0], [0.0, 0.0, 10.0], [10.0, 0.0, 0.0]], edges: vec![(0, 1, 3.0), (0, 2, 1.0)], narrow: vec![0], seals: vec![] };
        let spots = DefenseSpots { reactor: [500.0, 0.0, 500.0], radius: 6.0, gates: vec![[0.0; 3]], lanes, ..Default::default() };
        let mut d = Defense::new(&spots, 0, |_, _| Vec::new()).unwrap();
        let picks: Vec<usize> = (0..400).filter_map(|_| d.fork(0, Kind::Walker)).collect();
        let first = picks.iter().filter(|&&e| e == 0).count() as f32 / picks.len() as f32;
        // (Each fork's weights are the run's own: 3 to 1, each times 0.5-1.5.)
        let (a, b) = (d.edges[0].2, d.edges[1].2);
        assert!((a / 3.0 - 1.0).abs() <= 0.5 && (b - 1.0).abs() <= 0.5);
        assert!((first - a / (a + b)).abs() < 0.07, "{first} against {}", a / (a + b));
        // A brute keeps off the narrow one.
        assert!((0..50).all(|_| d.fork(0, Kind::Brute) == Some(1)));
    }
}
