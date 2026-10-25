//! Co-op Defense's rules. The pilots (team 0) hold a reactor against waves of infested walkers
//! (team 1, `deploy::Kind::Walker`) that come through the map's gates and walk its lanes toward
//! it: a network of paths, branching by weight. A walker that reaches the reactor hits it and is
//! gone; the reactor falling loses the run, holding through the last wave wins it. Between waves
//! the team has a while to get ready. `Game` keeps the walkers among its deployables (shot, locked
//! onto and manned like turrets), says which are still standing, and applies what comes out.

use serde::{Deserialize, Serialize};

use crate::map::DefenseSpots;
use crate::{DT, TICK_HZ, Vector};

/// The reactor's hull, and what a walker that reaches it takes off.
pub const REACTOR_HULL: f32 = 2000.0;
pub const LEAK: f32 = 100.0;
/// Waves in a run, and the time to get ready before the first and between the rest (s).
pub const WAVES: u8 = 10;
const FIRST_BREAK: f32 = 60.0;
const BREAK: f32 = 30.0;
/// A wave's walkers: WAVE_BASE + WAVE_STEP a wave for a full team, SOLO_SHARE of that for one
/// pilot and evenly between; coming through the gates in turn SPAWN_GAP apart.
const WAVE_BASE: f32 = 4.0;
const WAVE_STEP: f32 = 2.0;
const SOLO_SHARE: f32 = 0.6;
const SPAWN_GAP: f32 = 1.2;
/// A walker's hull (WALKER_HULL, WALKER_HULL_STEP more each wave), its walk (m/s), and how far
/// off its lane's line it keeps (either side, so a wave doesn't walk in single file).
const WALKER_HULL: f32 = 100.0;
const WALKER_HULL_STEP: f32 = 12.0;
const WALKER_SPEED: f32 = 4.5;
const SPREAD: f32 = 2.0;
/// Walkers' owner ids (for lock-on: `deploy::target_id` must stay a u8): past every player's,
/// ship's, base gun's and the hauler's, up to the last that fits.
const FIRST_OWNER: u8 = 16;
const LAST_OWNER: u8 = 95;

/// What players see of a run: the wave (the one on, or next), whether it's a break (and the
/// seconds left of it), the reactor's hull, and the walkers still to come or standing this wave.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DefenseNet {
    pub wave: u8,
    pub waves: u8,
    pub break_left: Option<f32>,
    pub hull: f32,
    pub left: u16,
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

/// A walker on its lanes: the edge it's on and how far along (m), and its place across the lane.
#[derive(Clone, Copy, Debug)]
struct Walker {
    owner: u8,
    edge: usize,
    along: f32,
    offset: f32,
}

/// What a tick asks of `Game`: walkers to put down (owner, where, hull), walkers to move (owner,
/// where on the lane, facing), walkers that reached the reactor (gone), news, and the end.
#[derive(Debug, Default)]
pub struct Tick {
    pub spawn: Vec<(u8, Vector, f32)>,
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
    /// The wave on (or next), and how many of its walkers have come and are to come.
    pub wave: u8,
    pub stage: Stage,
    spawned: u16,
    total: u16,
    walkers: Vec<Walker>,
    /// Picks walkers' branches and places, run to run the same (xorshift).
    rng: u32,
}

impl Defense {
    /// The run on a map with `spots`, from tick `tick`; `route` is the bots' walk between two
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
            spawned: 0,
            total: 0,
            walkers: Vec::new(),
            rng: 0x9e37_79b9,
        })
    }

    pub fn net(&self, tick: u32) -> DefenseNet {
        let break_left = match self.stage {
            Stage::Break { until } => Some(until.saturating_sub(tick) as f32 * DT),
            _ => None,
        };
        let left = match self.stage {
            Stage::Wave { .. } => self.total - self.spawned + self.walkers.len() as u16,
            _ => 0,
        };
        DefenseNet { wave: self.wave, waves: WAVES, break_left, hull: self.hull, left }
    }

    /// Where each of the team's mechs (whether each is a living bot) should head with `walkers`
    /// standing: every bot to the walker nearest the reactor; with none, round the reactor, each
    /// to its own spot on a ring just out of the reactor's reach.
    pub fn orders(&self, bots: &[bool], walkers: &[Vector]) -> Vec<Option<Vector>> {
        let front = walkers.iter().copied().min_by(|a, b| a.distance(self.reactor).total_cmp(&b.distance(self.reactor)));
        let ring = |k: usize| {
            let a = k as f32 * std::f32::consts::TAU / bots.len().max(1) as f32;
            self.reactor + Vector::new(a.cos(), 0.0, a.sin()) * (self.radius + 8.0)
        };
        (0..bots.len()).map(|k| bots[k].then(|| front.unwrap_or_else(|| ring(k)))).collect()
    }

    /// Wave `n`'s walkers with `pilots` on the team.
    pub fn count(n: u8, pilots: usize) -> u16 {
        let full = crate::game::TEAM_SIZE;
        let share = SOLO_SHARE + (1.0 - SOLO_SHARE) * (pilots.clamp(1, full) - 1) as f32 / (full - 1) as f32;
        ((WAVE_BASE + WAVE_STEP * f32::from(n)) * share).round().max(1.0) as u16
    }

    /// A walker's hull in wave `n`.
    pub fn walker_hull(n: u8) -> f32 {
        WALKER_HULL + WALKER_HULL_STEP * f32::from(n)
    }

    /// One tick at `tick` with `pilots` on the team, and the walkers still standing (their owners;
    /// any not among them fell): breaks and waves, walkers coming through the gates, walking their
    /// lanes (the next edge picked by weight at each fork), and reaching the reactor.
    pub fn step(&mut self, tick: u32, pilots: usize, standing: &[u8]) -> Tick {
        let mut out = Tick::default();
        self.walkers.retain(|w| standing.contains(&w.owner));
        match self.stage {
            Stage::Break { until } if tick >= until => {
                self.total = Defense::count(self.wave, pilots);
                self.spawned = 0;
                self.stage = Stage::Wave { next_at: tick };
                out.news.push(News::Wave { n: self.wave, count: self.total });
            }
            Stage::Wave { next_at } if tick >= next_at && self.spawned < self.total => {
                if let Some(owner) = (FIRST_OWNER..=LAST_OWNER).find(|o| !standing.contains(o) && !self.walkers.iter().any(|w| w.owner == *o)) {
                    let gate = self.gates[usize::from(self.spawned) % self.gates.len()];
                    let offset = SPREAD * (2.0 * self.rand() - 1.0);
                    if let Some(edge) = self.fork(gate) {
                        self.walkers.push(Walker { owner, edge, along: 0.0, offset });
                        out.spawn.push((owner, self.points[gate], Defense::walker_hull(self.wave)));
                        self.spawned += 1;
                    }
                }
                self.stage = Stage::Wave { next_at: tick + (SPAWN_GAP * TICK_HZ) as u32 };
            }
            Stage::Wave { .. } if self.spawned >= self.total && self.walkers.is_empty() => {
                out.news.push(News::Cleared(self.wave));
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
            w.along += WALKER_SPEED * DT;
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
            let (a, b, _) = self.edges[w.edge];
            let dir = (self.points[b] - self.points[a]).normalize_or_zero();
            let across = Vector::new(-dir.z, 0.0, dir.x);
            let at = self.points[a] + dir * w.along + across * w.offset;
            self.walkers[i] = w;
            if (at - self.reactor).with_y(0.0).length() <= self.radius {
                gone.push(w.owner);
            } else {
                out.moves.push((w.owner, at, (-dir.x).atan2(-dir.z)));
            }
        }
        for owner in gone {
            self.walkers.retain(|w| w.owner != owner);
            self.hull = (self.hull - LEAK).max(0.0);
            out.leaked.push(owner);
            out.news.push(News::Hit);
        }
        out.lost = self.hull <= 0.0;
        out
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
            out.push(d.step(t, 4, &standing));
        }
        out
    }

    #[test]
    fn waves_grow_and_scale_with_the_team() {
        assert_eq!((Defense::count(1, 4), Defense::count(10, 4)), (6, 24));
        assert!(Defense::count(5, 1) < Defense::count(5, 4));
        assert!(Defense::walker_hull(10) > Defense::walker_hull(1));
    }

    #[test]
    fn after_the_break_a_wave_comes_through_the_gates_in_turn_and_walks_at_the_reactor() {
        let mut d = run();
        let t0 = (FIRST_BREAK * TICK_HZ) as u32;
        assert!(steps(&mut d, 0, FIRST_BREAK - 0.1).iter().all(|t| t.spawn.is_empty()));
        let ticks = steps(&mut d, t0 - 3, 3.0);
        assert!(ticks.iter().any(|t| t.news.contains(&News::Wave { n: 1, count: 6 })));
        let spawned: Vec<Vector> = ticks.iter().flat_map(|t| t.spawn.iter().map(|s| s.1)).collect();
        assert_eq!(spawned[..2], [Vector::new(0.0, 0.0, -100.0), Vector::new(100.0, 0.0, 0.0)], "the gates in turn");
        // They close on it at WALKER_SPEED.
        let ticks = steps(&mut d, t0 + 90, 1.0);
        let first = ticks.last().unwrap().moves.iter().find(|m| m.0 == FIRST_OWNER).unwrap().1;
        assert!(first.z > -100.0 + WALKER_SPEED * 3.0 && first.x.abs() <= SPREAD + 1e-3, "{first}");
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
        while t < ((FIRST_BREAK + 60.0) * TICK_HZ) as u32 && !won {
            // Every walker falls as soon as it comes.
            let out = d.step(t, 4, &[]);
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
