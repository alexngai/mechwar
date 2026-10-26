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
/// The wave director: each wave's threat budget for a full team (SOLO_SHARE of it for one pilot
/// and evenly between), spent on `CARDS`, a theme leaning it one way from wave 3 (`Theme`). Foes
/// come through the gates SPAWN_GAP apart, a pack of crawlers CRAWLER_GAP apart.
const BUDGETS: [f32; WAVES as usize] = [6.0, 10.0, 14.0, 21.0, 30.0, 36.0, 46.0, 64.0, 80.0, 100.0];

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
/// A lane enemy rushing (`rush`: a boss burrowing) walks this many times its pace.
const RUSH: f32 = 5.0;
const SPAWN_GAP: f32 = 1.2;
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
        Kind::Crawler => Species { hull: 30.0, hull_step: 3.0, speed: 8.5, spread: 3.5, leak: 25.0, armor: 0.0 },
        Kind::Brute => Species { hull: 600.0, hull_step: 50.0, speed: 2.8, spread: 0.5, leak: 300.0, armor: 5.0 },
        Kind::Mortar => Species { hull: 140.0, hull_step: 14.0, speed: 3.5, spread: 1.5, leak: LEAK, armor: 0.0 },
        Kind::Node => Species { hull: 150.0, hull_step: 12.0, speed: 4.0, spread: 1.0, leak: 50.0, armor: 0.0 },
        // Bosses: their hull for a full team (a lone pilot meets SOLO_SHARE of it).
        Kind::Excavator => Species { hull: 3000.0, hull_step: 0.0, speed: 2.0, spread: 0.0, leak: 1000.0, armor: 8.0 },
        Kind::Hive => Species { hull: 5000.0, hull_step: 0.0, speed: 2.2, spread: 0.0, leak: REACTOR_HULL, armor: 4.0 },
        _ => Species { hull: 100.0, hull_step: 12.0, speed: 4.5, spread: 2.0, leak: LEAK, armor: 0.0 },
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
const UPGRADE: f32 = 0.75;
const REFUND: f32 = 0.7;
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
/// or sell it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Build {
    Place(u8),
    Upgrade,
    Sell,
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
    /// The tower's at its top tier, or there's no room for another.
    Full,
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

/// A tower: its owner id among the deployables, who built it, its tier, and the scrap gone into it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tower {
    pub owner: u8,
    pub by: u8,
    pub tier: u8,
    pub spent: f32,
}

impl Tower {
    /// What raising it a tier costs (`kind` is its kind).
    pub fn upgrade(&self, kind: Kind) -> f32 {
        price(kind) * UPGRADE * f32::from(self.tier)
    }

    /// What selling it refunds.
    pub fn refund(&self) -> f32 {
        REFUND * self.spent
    }
}

/// `kind`'s price as a tower.
pub fn price(kind: Kind) -> f32 {
    TOWERS.iter().position(|&k| k == kind).map_or(0.0, |i| PRICES[i])
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
    pub perks: Vec<(u8, Perk, u8)>,
    pub cores: Vec<(Vector, bool)>,
    /// In a break, the wave to come: its theme, and how many of each foe.
    pub theme: Theme,
    pub next: Vec<(Foe, u16)>,
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
    /// Player `id` picked up salvage (`rare`: a boss's): a draft to pick from.
    Salvage { id: u8, rare: bool },
    /// Player `id`'s build order didn't go through.
    Refused { id: u8, why: Refusal },
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
    gates: Vec<usize>,
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
    /// The share of a full team's foes this wave (for bosses' hull).
    share: f32,
    /// The tick last stepped.
    now: u32,
    /// Picks walkers' branches and places, run to run the same (xorshift).
    rng: u32,
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
        Some(Defense {
            points,
            edges,
            gates: starts,
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
            now: tick,
            rng: (0x9e37_79b9 ^ tick.wrapping_mul(0x85eb_ca6b)) | 1,
            scrap: [START_SCRAP; MAX_PLAYERS],
            towers: Vec::new(),
            shells: Vec::new(),
            plans: Vec::new(),
            offers: Vec::new(),
            perks: [[0; PERKS.len()]; MAX_PLAYERS],
            cores: Vec::new(),
        })
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

    /// An owner id for a new tower, if there's room for one.
    pub fn free_tower(&self) -> Option<u8> {
        (FIRST_TOWER..=LAST_TOWER).find(|o| !self.towers.iter().any(|t| t.owner == *o))
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
        self.tower(owner).map_or(TOWER_HULL, |t| tower_hull(t.tier) * (1.0 + 0.25 * self.perk(t.by, Perk::Plating)))
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
        if self.perk(tower.by, Perk::Salvage) > 0.0 { tower.spent } else { tower.refund() }
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
        let mut offers: Vec<(u8, Vec<Perk>)> = Vec::new();
        for (id, o) in &self.offers {
            if !offers.iter().any(|(i, _)| i == id) {
                offers.push((*id, o.clone()));
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
        DefenseNet { wave: self.wave, waves: WAVES, break_left, hull: self.hull, left, scrap, towers: self.towers.clone(), offers, perks, cores: self.cores.clone(), theme: self.theme, next }
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
        let gates = self.gates.len().max(1);
        let main = (self.rand() * gates as f32) as usize % gates;
        let out = foes
            .into_iter()
            .enumerate()
            .map(|(k, foe)| {
                let gate = if theme == Theme::Flank { if self.rand() < FLANK { main } else { (self.rand() * gates as f32) as usize % gates } } else { k % gates };
                (foe, gate)
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
        // A break begun: the next wave drawn up, to see coming.
        if matches!(self.stage, Stage::Break { .. }) && self.drawn != self.wave {
            let (theme, mut queue) = self.compose(self.wave, pilots.len());
            queue.reverse();
            (self.theme, self.queue, self.drawn, self.share) = (theme, queue, self.wave, Defense::share(pilots.len()));
        }
        match self.stage {
            Stage::Break { until } if tick >= until => {
                self.stage = Stage::Wave { next_at: tick };
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
                        match (owner, self.fork(gate)) {
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
                    let pack = foe == Some(Foe::Lane(Kind::Crawler)) && self.queue.last().map(|q| q.0) == foe;
                    self.stage = Stage::Wave { next_at: tick + (if pack { CRAWLER_GAP } else { SPAWN_GAP } * TICK_HZ) as u32 };
                }
            }
            Stage::Wave { .. } if self.queue.is_empty() && self.walkers.is_empty() && elites == 0 => {
                out.news.push(News::Cleared(self.wave));
                for &id in pilots {
                    if let Some(s) = self.scrap.get_mut(usize::from(id)) {
                        *s += WAVE_BONUS;
                    }
                    self.offer(id, false);
                }
                if self.wave >= WAVES {
                    self.stage = Stage::Won;
                    out.won = true;
                } else {
                    self.wave += 1;
                    self.stage = Stage::Break { until: tick + (BREAK * TICK_HZ) as u32 };
                }
            }
            _ => {}
        }
        // Each walker on along its lanes, at its place across them.
        let mut gone = Vec::new();
        for i in 0..self.walkers.len() {
            let mut w = self.walkers[i];
            if tick >= w.stunned {
                w.along += species(w.kind).speed * if tick < w.rush { RUSH } else { 1.0 } * DT;
            }
            loop {
                let (a, b, _) = self.edges[w.edge];
                let len = self.points[a].distance(self.points[b]);
                if w.along < len {
                    break;
                }
                match self.fork(b) {
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
        hull(kind, self.wave) * if kind.boss() { self.share } else { 1.0 }
    }

    /// Lane enemy `owner`'s velocity as of the last tick (zero stunned, or for anything else): for
    /// towers to lead it.
    pub fn velocity(&self, owner: u8) -> Vector {
        let Some(w) = self.walkers.iter().find(|w| w.owner == owner) else { return Vector::ZERO };
        if self.now < w.stunned {
            return Vector::ZERO;
        }
        self.place(w).1 * species(w.kind).speed * if self.now < w.rush { RUSH } else { 1.0 }
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

    /// The edge out of point `p` a walker takes, by weight (None at a lane's end).
    fn fork(&mut self, p: usize) -> Option<usize> {
        let out: Vec<usize> = (0..self.edges.len()).filter(|&e| self.edges[e].0 == p).collect();
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
        let spots = DefenseSpots { reactor: [0.0; 3], radius: 6.0, gates: vec![[0.0, 0.0, -100.0], [100.0, 0.0, 0.0]], lanes: Lanes::default() };
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
    fn runs_differ_by_their_seed_and_a_flanking_wave_comes_mostly_through_one_gate() {
        let spots = DefenseSpots { reactor: [0.0; 3], radius: 6.0, gates: vec![[0.0, 0.0, -100.0], [100.0, 0.0, 0.0]], lanes: Lanes::default() };
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
        let spawned: Vec<Vector> = ticks.iter().flat_map(|t| t.spawn.iter().map(|s| s.2)).collect();
        assert_eq!(spawned[..2], [Vector::new(0.0, 0.0, -100.0), Vector::new(100.0, 0.0, 0.0)], "the gates in turn");
        // They close on it at a walker's walk.
        let (speed, spread) = (species(Kind::Walker).speed, species(Kind::Walker).spread);
        let ticks = steps(&mut d, t0 + 90, 1.0);
        let first = ticks.last().unwrap().moves.iter().find(|m| m.0 == FIRST_OWNER).unwrap().1;
        assert!(first.z > -100.0 + speed * 3.0 && first.x.abs() <= spread + 1e-3, "{first}");
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
        let lanes = Lanes { points: vec![[0.0, 0.0, 0.0], [0.0, 0.0, 10.0], [10.0, 0.0, 0.0]], edges: vec![(0, 1, 3.0), (0, 2, 1.0)] };
        let spots = DefenseSpots { reactor: [500.0, 0.0, 500.0], radius: 6.0, gates: vec![[0.0; 3]], lanes };
        let mut d = Defense::new(&spots, 0, |_, _| Vec::new()).unwrap();
        let picks: Vec<usize> = (0..400).filter_map(|_| d.fork(0)).collect();
        let first = picks.iter().filter(|&&e| e == 0).count() as f32 / picks.len() as f32;
        assert!((first - 0.75).abs() < 0.07, "{first}");
    }
}
