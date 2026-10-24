//! Objective modes' rules: capture zones, and Missile Assault's silos, missiles and bases. `Game`
//! counts who stands where and applies the outcomes (events, credit, the match's end).

use serde::{Deserialize, Serialize};

use crate::map::{Objectives, ZoneSpot};
use crate::{DT, TICK_HZ, Vector};

/// A lone mech takes a neutral zone in this long (s); a held one takes twice as long, first
/// neutralized, then taken.
const CAPTURE_SECONDS: f32 = 8.0;
/// Each mech past the first in a zone adds this much speed, up to CAPTURE_CREW.
const CAPTURE_SPEEDUP: f32 = 0.5;
const CAPTURE_CREW: usize = 3;
/// A zone nobody's in drifts back to its holder's side (or to neutral) over this long (s).
const DRIFT_SECONDS: f32 = 16.0;
/// Bots sent to a zone stand at least this far inside its edge (m): more than they stop short of
/// a spot.
const RALLY_MARGIN: f32 = 3.0;
/// Missile Assault: a base's hull, and each held silo's missiles at the enemy base: one every
/// MISSILE_SECONDS for MISSILE_DAMAGE, landing MISSILE_FLIGHT after launch (the client flies its
/// rocket over as long: up out of the silo slowly, over, and down). Holding two of three takes a
/// base down in about four minutes.
pub const BASE_HULL: f32 = 1000.0;
const MISSILE_SECONDS: f32 = 10.0;
const MISSILE_DAMAGE: f32 = 20.0;
pub const MISSILE_FLIGHT: f32 = 10.0;

/// A capture zone as players see it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ZoneState {
    /// The team holding it.
    pub owner: Option<u8>,
    /// -1 (team 1's) to 1 (team 0's): how far a capture has got; a team holds it from its end
    /// until it's back past neutral.
    pub progress: f32,
    /// Both teams in it, so it's frozen.
    pub contested: bool,
}

impl ZoneState {
    /// Whether `team` holds it fully, with nobody taking it off them.
    pub fn secure(&self, team: u8) -> bool {
        self.owner == Some(team) && !self.contested && self.progress * if team == 0 { 1.0 } else { -1.0 } >= 1.0
    }
}

pub struct Zone {
    pub at: Vector,
    pub radius: f32,
    pub band: f32,
    pub state: ZoneState,
    /// Waypoints in it, for bots sent to take or hold it.
    pub rally: Vec<Vector>,
}

impl Zone {
    pub(crate) fn new(spot: &ZoneSpot, waypoints: &[Vector]) -> Zone {
        let mut zone = Zone { at: Vector::from_array(spot.at), radius: spot.radius, band: spot.band, state: ZoneState::default(), rally: Vec::new() };
        // Each waypoint in it, drawn in toward the middle (on the level) so a bot holding near
        // one stands well inside, not on the edge.
        let inner = (zone.radius - RALLY_MARGIN).max(0.0);
        zone.rally = waypoints
            .iter()
            .filter(|&&p| zone.holds(p))
            .map(|&p| {
                let off = (p - zone.at).with_y(0.0);
                p - off * (1.0 - inner / off.length().max(inner))
            })
            .collect();
        zone
    }

    /// Whether a mech with its feet at `feet` stands in it.
    pub fn holds(&self, feet: Vector) -> bool {
        let off = feet - self.at;
        off.x.hypot(off.z) <= self.radius && off.y.abs() <= self.band
    }

    /// One tick with `count` living mechs of each team in it: a team alone moves the capture its
    /// way, both freeze it, nobody lets it drift back. The team that took it this tick, if one did.
    pub fn step(&mut self, count: [usize; 2]) -> Option<u8> {
        let s = &mut self.state;
        let end = |team: u8| if team == 0 { 1.0 } else { -1.0 };
        s.contested = count[0] > 0 && count[1] > 0;
        let (goal, seconds) = match count {
            [0, 0] => (s.owner.map_or(0.0, end), DRIFT_SECONDS),
            [n, 0] | [0, n] => (end(u8::from(count[0] == 0)), CAPTURE_SECONDS / (1.0 + CAPTURE_SPEEDUP * (n.min(CAPTURE_CREW) - 1) as f32)),
            _ => return None,
        };
        s.progress += (goal - s.progress).clamp(-DT / seconds, DT / seconds);
        if s.owner.is_some_and(|o| s.progress * end(o) <= 0.0) {
            s.owner = None;
        }
        let took = [0, 1].into_iter().find(|&t| s.owner != Some(t) && s.progress * end(t) >= 1.0);
        s.owner = s.owner.or(took);
        took
    }
}

/// A Missile Assault match: three silos, each firing on the enemy base while held, and the bases.
pub struct Assault {
    pub silos: Vec<Zone>,
    pub bases: [Vector; 2],
    /// Each team's base hull left.
    pub hull: [f32; 2],
    /// Tick each silo fires next, while held.
    next_launch: Vec<u32>,
    /// Missiles in flight: the team whose base they're coming down on, and when.
    landing: Vec<(u8, u32)>,
}

/// What a tick of Missile Assault did: silos taken (silo, team), missiles fired (silo, firing team).
#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub captured: Vec<(usize, u8)>,
    pub fired: Vec<(usize, u8)>,
}

impl Assault {
    /// The match on a map with `spots`, its bots' waypoints `waypoints`; None without silos and bases.
    pub fn new(spots: &Objectives, waypoints: &[Vector]) -> Option<Assault> {
        let bases = spots.bases?.map(Vector::from_array);
        (spots.silos.len() == 3).then(|| Assault {
            silos: spots.silos.iter().map(|s| Zone::new(s, waypoints)).collect(),
            bases,
            hull: [BASE_HULL; 2],
            next_launch: vec![0; 3],
            landing: Vec::new(),
        })
    }

    /// One tick at `tick`, `counts[i]` each team's living mechs in silo `i`.
    pub fn step(&mut self, tick: u32, counts: &[[usize; 2]]) -> Outcome {
        let mut out = Outcome::default();
        let every = (MISSILE_SECONDS * TICK_HZ).round() as u32;
        for (i, (silo, &count)) in self.silos.iter_mut().zip(counts).enumerate() {
            if let Some(team) = silo.step(count) {
                out.captured.push((i, team));
                self.next_launch[i] = tick + every;
            }
            if let Some(team) = silo.state.owner
                && tick >= self.next_launch[i]
            {
                out.fired.push((i, team));
                self.landing.push((1 - team, tick + (MISSILE_FLIGHT * TICK_HZ).round() as u32));
                self.next_launch[i] = tick + every;
            }
        }
        for &(team, _) in self.landing.iter().filter(|(_, at)| *at <= tick) {
            let hull = &mut self.hull[usize::from(team)];
            *hull = (*hull - MISSILE_DAMAGE).max(0.0);
        }
        self.landing.retain(|(_, at)| *at > tick);
        out
    }

    /// The team whose base has fallen, if one has.
    pub fn fallen(&self) -> Option<u8> {
        (0..2).find(|&t| self.hull[usize::from(t)] <= 0.0)
    }

    /// Where each of `mechs` (team, feet, whether it's a bot, whether it's alive) should head: bots
    /// spread over the silos their team doesn't hold securely, nearest first and no more on one
    /// than a fair share, counting living humans already in them; with every silo secure, one
    /// guards each and the rest roam (None). Humans get None.
    pub fn orders(&self, mechs: &[(u8, Vector, bool, bool)]) -> Vec<Option<Vector>> {
        let mut out = vec![None; mechs.len()];
        for team in 0..2 {
            let mine = |i: &usize| mechs[*i].0 == team;
            let wanted: Vec<usize> = (0..self.silos.len()).filter(|&z| !self.silos[z].state.secure(team)).collect();
            let (targets, share) = if wanted.is_empty() {
                ((0..self.silos.len()).collect(), 1)
            } else {
                let crew = (0..mechs.len()).filter(mine).filter(|&i| mechs[i].3).count();
                (wanted.clone(), crew.div_ceil(wanted.len()))
            };
            let mut load: Vec<usize> = targets.iter().map(|&z| (0..mechs.len()).filter(mine).filter(|&i| !mechs[i].2 && mechs[i].3 && self.silos[z].holds(mechs[i].1)).count()).collect();
            for i in (0..mechs.len()).filter(mine).filter(|&i| mechs[i].2) {
                let feet = mechs[i].1;
                let pick = (0..targets.len()).filter(|&k| load[k] < share).min_by(|&a, &b| self.silos[targets[a]].at.distance(feet).total_cmp(&self.silos[targets[b]].at.distance(feet)));
                if let Some(k) = pick {
                    load[k] += 1;
                    let silo = &self.silos[targets[k]];
                    out[i] = silo.rally.iter().copied().min_by(|a, b| a.distance(feet).total_cmp(&b.distance(feet))).or(Some(silo.at));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone() -> Zone {
        Zone::new(&ZoneSpot { at: [0.0, 0.0, 0.0], radius: 10.0, band: 4.0, pad: None }, &[])
    }

    /// Ticks `zone` with `count` until it's taken, or for `max` seconds; the seconds it took.
    fn take(zone: &mut Zone, count: [usize; 2], max: f32) -> Option<f32> {
        (1..=(max * TICK_HZ) as u32).find(|_| zone.step(count).is_some()).map(|n| n as f32 * DT)
    }

    #[test]
    fn zones_hold_feet_within_their_radius_and_band() {
        let z = zone();
        assert!(z.holds(Vector::new(6.0, 3.0, 7.9)) && !z.holds(Vector::new(6.0, 0.0, 8.1)) && !z.holds(Vector::new(0.0, 4.5, 0.0)));
    }

    #[test]
    fn a_crew_takes_a_zone_faster_and_both_sides_freeze_it() {
        let mut z = zone();
        let alone = take(&mut z, [1, 0], 20.0).expect("one mech takes it");
        assert!((alone - CAPTURE_SECONDS).abs() < 0.1, "alone in {alone} s");
        assert_eq!(z.state.owner, Some(0));
        // Retaking from the holder: back to neutral (it's lost there), then on to the other side.
        let mut steps = 0;
        while z.state.owner == Some(0) {
            z.step([0, 3]);
            steps += 1;
        }
        let crew = take(&mut z, [0, 3], 20.0).unwrap() + steps as f32 * DT;
        assert!((crew - CAPTURE_SECONDS).abs() < 0.2, "three retook it in {crew} s, not 2 x {} s", CAPTURE_SECONDS / 2.0);
        assert_eq!(z.state.owner, Some(1));
        // Contested: frozen.
        z.state.progress = -0.5;
        z.step([2, 1]);
        assert!(z.state.contested && z.state.progress == -0.5);
        // Empty: back to the holder's side.
        (0..(DRIFT_SECONDS * TICK_HZ) as u32).for_each(|_| _ = z.step([0, 0]));
        assert_eq!((z.state.progress, z.state.contested), (-1.0, false));
    }

    fn assault() -> Assault {
        let spots = Objectives {
            bases: Some([[0.0, 0.0, 100.0], [0.0, 0.0, -100.0]]),
            silos: [-50.0, 0.0, 50.0].map(|x| ZoneSpot { at: [x, 0.0, 0.0], radius: 10.0, band: 4.0, pad: None }).to_vec(),
            ..Objectives::default()
        };
        Assault::new(&spots, &[Vector::new(-48.0, 0.0, 0.0)]).unwrap()
    }

    #[test]
    fn held_silos_fire_on_the_enemy_base_until_it_falls() {
        let mut a = assault();
        // Team 0 takes A and B.
        let mut tick = 0;
        let mut out = Outcome::default();
        while out.captured.len() < 2 {
            tick += 1;
            let o = a.step(tick, &[[1, 0], [1, 0], [0, 0]]);
            out.captured.extend(o.captured);
        }
        assert_eq!(out.captured, [(0, 0), (1, 0)]);
        let (mut fired, start) = (0, tick);
        while a.fallen().is_none() {
            tick += 1;
            fired += a.step(tick, &[[0, 0]; 3]).fired.len();
            assert!(tick - start < 400 * TICK_HZ as u32, "the base never fell");
        }
        assert_eq!((a.fallen(), a.hull[0]), (Some(1), BASE_HULL));
        // Fifty to bring it down, and at most the next pair still in the air as it falls.
        let needed = (BASE_HULL / MISSILE_DAMAGE) as usize;
        assert!((needed..=needed + 2).contains(&fired), "{fired} missiles fired");
        let minutes = (tick - start) as f32 * DT / 60.0;
        assert!((3.5..4.5).contains(&minutes), "two silos took {minutes} minutes");
    }

    #[test]
    fn bots_spread_over_the_silos_their_team_needs() {
        let mut a = assault();
        let at = |x: f32| Vector::new(x, 0.0, 0.0);
        // Two bots and a human of team 0 near A, two bots of team 1.
        let mechs = [(0, at(-60.0), true, true), (0, at(-60.0), true, true), (0, at(-50.0), false, true), (1, at(60.0), true, true), (1, at(40.0), true, true)];
        let orders = a.orders(&mechs);
        // The human has A, so the bots take B and C; the human gets no order.
        assert_eq!((orders[0], orders[1], orders[2]), (Some(a.silos[1].at), Some(a.silos[2].at), None));
        assert!(orders[3].is_some() && orders[4].is_some() && orders[3] != orders[4]);
        // A bot sent to a silo heads for a waypoint in it.
        assert_eq!(a.orders(&[(0, at(-70.0), true, true)])[0], Some(at(-48.0)));
        // One on its edge is drawn in.
        let edge = Assault::new(&Objectives { bases: Some([[0.0; 3]; 2]), silos: a.silos.iter().map(|z| ZoneSpot { at: z.at.to_array(), radius: 10.0, band: 4.0, pad: None }).collect(), ..Objectives::default() }, &[at(-59.5)]).unwrap();
        assert!((edge.silos[0].rally[0].x - -57.0).abs() < 1e-4, "{}", edge.silos[0].rally[0]);
        // A human lying dead in A doesn't count as holding it.
        let dead = [(0, at(-50.0), false, false), (0, at(-60.0), true, true)];
        assert_eq!(a.orders(&dead)[1], Some(at(-48.0)));
        // Holding everything, team 0 guards each silo with one (the human has A) and the rest roam.
        for s in &mut a.silos {
            s.state = ZoneState { owner: Some(0), progress: 1.0, contested: false };
        }
        let crowd = [mechs[0], mechs[0], mechs[0], mechs[2]];
        assert_eq!(a.orders(&crowd).iter().filter(|o| o.is_some()).count(), 2);
        // A held silo the enemy's draining alone is wanted back.
        a.silos[2].state.progress = 0.6;
        assert_eq!(a.orders(&crowd)[0], Some(a.silos[2].at));
    }
}
