//! Siege's rules. Teams draw energy (EU) from a station (one, mid-map, so they fight over it),
//! carry it home to their base's bank,
//! and at LAUNCH_EU their battleship lifts off and flies at the enemy base (holding its fire on
//! mechs; it's a `deploy::Kind::Ship`), and bombards the base once over it. Mechs shoot ships
//! down, as does the anti-air gun for whichever team holds its zone; two ships in range stop and
//! fight it out. The last base standing wins. `Game` keeps the ships among its deployables, counts
//! who stands where, and applies what comes out (events, credit, the end).

use serde::{Deserialize, Serialize};

use crate::map::Objectives;
use crate::objective::Zone;
use crate::{DT, TICK_HZ, Vector};

/// A station holds up to STATION_CAP, refilling at STATION_REFILL a second, and gives at most
/// STATION_RATE a second, shared between everyone drawing on it (standing in its zone). One
/// station feeds both teams, so it's as rich as two used to be.
const STATION_CAP: f32 = 400.0;
const STATION_REFILL: f32 = 10.0;
const STATION_RATE: f32 = 30.0;
/// Most EU a mech carries.
pub const CARRY_MAX: f32 = 100.0;
/// A mech this close to its own base (across) banks what it carries.
const BASE_RADIUS: f32 = 14.0;
/// Each bank gains this a second while no ship is up.
const TRICKLE: f32 = 1.0;
/// A bank this full launches its team's ship (and empties).
pub const LAUNCH_EU: f32 = 500.0;
/// A destroyed mech's EU lies where it fell for DROP_SECONDS, for anyone within DROP_RADIUS.
const DROP_RADIUS: f32 = 4.0;
const DROP_SECONDS: f32 = 30.0;
/// A ship's hull; its speed toward the enemy base (m/s); how close ships fight, and how hard;
/// how close over the base (across) it bombards, and how hard.
pub const SHIP_HULL: f32 = 3000.0;
const SHIP_SPEED: f32 = 4.0;
pub const DUEL_RANGE: f32 = 120.0;
const DUEL_DPS: f32 = 30.0;
pub const BOMBARD_RANGE: f32 = 6.0;
const BOMBARD_DPS: f32 = 15.0;
/// The anti-air gun's reach, and its damage a second to the enemy ship within it.
pub const AA_RANGE: f32 = 150.0;
const AA_DPS: f32 = 25.0;
/// A base's hull: only ships hurt it.
pub const BASE_HULL: f32 = 1000.0;

/// EU lying where a mech fell.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Drop {
    pub at: Vector,
    pub eu: f32,
    pub fades: u32,
}

/// What players see of a siege besides the AA zone and the bases' hull: the stations' EU, the
/// banks', and the drops.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SiegeNet {
    pub stations: Vec<f32>,
    pub banks: [f32; 2],
    pub drops: Vec<Drop>,
}

/// A ship in flight: its team, where it is, its hull.
pub type Ship = (u8, Vector, f32);

pub struct Siege {
    pub aa: Zone,
    /// Each station: its zone, and the EU it holds.
    pub stations: Vec<(Zone, f32)>,
    pub bases: [Vector; 2],
    pub hull: [f32; 2],
    pub banks: [f32; 2],
    /// Ships cruise this high.
    pub sky: f32,
    pub drops: Vec<Drop>,
    /// Which teams had a ship up as of the last tick, to tell when one goes down.
    pub up: [bool; 2],
}

impl Siege {
    /// The siege on a map with `spots`, its bots' waypoints `waypoints`; None without bases, a
    /// station, the AA zone and a cruising height.
    pub fn new(spots: &Objectives, waypoints: &[Vector]) -> Option<Siege> {
        let (bases, aa, sky) = (spots.bases?, spots.aa.as_ref()?, spots.sky?);
        (!spots.stations.is_empty()).then_some(())?;
        Some(Siege {
            aa: Zone::new(aa, waypoints),
            stations: spots.stations.iter().map(|s| (Zone::new(s, waypoints), STATION_CAP)).collect(),
            bases: bases.map(Vector::from_array),
            hull: [BASE_HULL; 2],
            banks: [0.0; 2],
            sky,
            drops: Vec::new(),
            up: [false; 2],
        })
    }

    pub fn net(&self) -> SiegeNet {
        SiegeNet { stations: self.stations.iter().map(|s| s.1).collect(), banks: self.banks, drops: self.drops.clone() }
    }

    /// A tick of energy at `tick` for the living `mechs` (team, feet, EU carried, which this
    /// updates): drawing on stations, picking up drops, banking at home, and the trickle while no
    /// ship is up. What each mech banked this tick.
    pub fn energy(&mut self, tick: u32, mechs: &mut [(u8, Vector, f32)], ships_up: bool) -> Vec<f32> {
        let near = |a: Vector, b: Vector, r: f32| (a - b).with_y(0.0).length() <= r && (a.y - b.y).abs() <= r;
        for (zone, stored) in &mut self.stations {
            let drawing: Vec<usize> = (0..mechs.len()).filter(|&i| mechs[i].2 < CARRY_MAX && zone.holds(mechs[i].1)).collect();
            let share = (STATION_RATE * DT).min(*stored) / drawing.len().max(1) as f32;
            for i in drawing {
                let took = share.min(CARRY_MAX - mechs[i].2);
                mechs[i].2 += took;
                *stored -= took;
            }
            *stored = (*stored + STATION_REFILL * DT).min(STATION_CAP);
        }
        for drop in &mut self.drops {
            for m in mechs.iter_mut().filter(|m| near(m.1, drop.at, DROP_RADIUS)) {
                let took = drop.eu.min(CARRY_MAX - m.2);
                (m.2, drop.eu) = (m.2 + took, drop.eu - took);
            }
        }
        self.drops.retain(|d| d.eu > 0.0 && tick < d.fades);
        let banked: Vec<f32> = mechs
            .iter_mut()
            .map(|m| {
                let home = self.bases[usize::from(m.0)];
                if m.2 > 0.0 && (m.1 - home).with_y(0.0).length() <= BASE_RADIUS {
                    self.banks[usize::from(m.0)] += m.2;
                    std::mem::take(&mut m.2)
                } else {
                    0.0
                }
            })
            .collect();
        if !ships_up {
            self.banks = self.banks.map(|b| b + TRICKLE * DT);
        }
        banked
    }

    /// The team whose bank has filled while it has no ship up (`up`), if any: its bank empties,
    /// and its ship launches from over its base, at `ship_start`.
    pub fn launch(&mut self, up: [bool; 2]) -> Option<u8> {
        let team = (0..2).find(|&t| !up[usize::from(t)] && self.banks[usize::from(t)] >= LAUNCH_EU)?;
        self.banks[usize::from(team)] = 0.0;
        Some(team)
    }

    /// Where `team`'s ship starts: over its base at cruising height.
    pub fn ship_start(&self, team: u8) -> Vector {
        self.bases[usize::from(team)].with_y(self.sky)
    }

    /// A tick of the `ships` in flight (this moves and damages them): two in range fight, else
    /// each flies at the enemy base and, over it, bombards it; the AA gun's holder fires on the
    /// enemy ship in reach.
    pub fn fly(&mut self, ships: &mut [Ship]) {
        let dueling = ships.len() == 2 && ships[0].1.distance(ships[1].1) <= DUEL_RANGE;
        for i in 0..ships.len() {
            let (team, pos, _) = ships[i];
            if dueling {
                ships[1 - i].2 -= DUEL_DPS * DT;
                continue;
            }
            let target = self.bases[usize::from(1 - team)].with_y(self.sky);
            let off = (target - pos).with_y(0.0);
            if off.length() <= BOMBARD_RANGE {
                let hull = &mut self.hull[usize::from(1 - team)];
                *hull = (*hull - BOMBARD_DPS * DT).max(0.0);
            } else {
                ships[i].1 += off.normalize() * (SHIP_SPEED * DT).min(off.length() - BOMBARD_RANGE * 0.5);
            }
        }
        if let Some(holder) = self.aa.state.owner {
            for ship in ships.iter_mut().filter(|s| s.0 != holder && s.1.distance(self.aa.at) <= AA_RANGE) {
                ship.2 -= AA_DPS * DT;
            }
        }
    }

    /// `eu` falls with a mech at `at`.
    pub fn drop(&mut self, at: Vector, eu: f32, tick: u32) {
        self.drops.push(Drop { at, eu, fades: tick + (DROP_SECONDS * TICK_HZ).round() as u32 });
    }

    /// The team whose base has fallen, if one has.
    pub fn fallen(&self) -> Option<u8> {
        (0..2).find(|&t| self.hull[usize::from(t)] <= 0.0)
    }

    /// Where each of `mechs` (team, feet, whether it's a bot, EU carried) should head, with
    /// `ships` each team's ship up: a bot carrying a load home; else to the AA gun, two of a team
    /// whose base the enemy ship is coming for and one otherwise, while its team doesn't hold it;
    /// the rest, while their own ship's down, to the drop or the station with the most EU (by
    /// distance); else they roam (None). Humans get None.
    pub fn orders(&self, mechs: &[(u8, Vector, bool, f32)], ships: [bool; 2]) -> Vec<Option<Vector>> {
        let mut out = vec![None; mechs.len()];
        for team in 0..2u8 {
            let bots: Vec<usize> = (0..mechs.len()).filter(|&i| mechs[i].0 == team && mechs[i].2).collect();
            let bank = self.banks[usize::from(team)];
            let mut gunners = if self.aa.state.secure(team) { 0 } else if ships[usize::from(1 - team)] { 2 } else { 1 };
            let aa = self.aa.rally.first().copied().unwrap_or(self.aa.at);
            for i in bots {
                let (_, feet, _, eu) = mechs[i];
                if eu >= 0.8 * CARRY_MAX || (eu > 0.0 && bank + eu >= LAUNCH_EU && !ships[usize::from(team)]) {
                    out[i] = Some(self.bases[usize::from(team)]);
                } else if gunners > 0 {
                    gunners -= 1;
                    out[i] = Some(aa);
                } else if !ships[usize::from(team)] {
                    // Worth: EU on offer over the walk there (a station's, at the waypoint in it nearest).
                    let station = |(zone, eu): &(Zone, f32)| (zone.rally.iter().copied().min_by(|a, b| a.distance(feet).total_cmp(&b.distance(feet))).unwrap_or(zone.at), *eu);
                    let offers = self.drops.iter().map(|d| (d.at, d.eu)).chain(self.stations.iter().filter(|s| s.1 >= 20.0).map(station));
                    out[i] = offers.max_by(|a, b| (a.1 / (10.0 + a.0.distance(feet))).total_cmp(&(b.1 / (10.0 + b.0.distance(feet))))).map(|(at, _)| at);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::ZoneSpot;

    fn siege() -> Siege {
        let spots = Objectives {
            bases: Some([[0.0, 0.0, 100.0], [0.0, 0.0, -100.0]]),
            stations: vec![ZoneSpot { at: [0.0, 0.0, 0.0], radius: 8.0, band: 3.0, pad: None }],
            aa: Some(ZoneSpot { at: [0.0, 10.0, 0.0], radius: 8.0, band: 3.0, pad: None }),
            sky: Some(50.0),
            ..Objectives::default()
        };
        Siege::new(&spots, &[]).unwrap()
    }

    #[test]
    fn stations_share_their_flow_and_mechs_bank_what_they_carry() {
        let mut s = siege();
        let station = Vector::ZERO;
        let mut mechs = vec![(0, station, 0.0), (1, station + Vector::X, 0.0)];
        for t in 0..(3.0 * TICK_HZ) as u32 {
            s.energy(t, &mut mechs, true);
        }
        // Two drawing share its 30 EU/s: 45 each in 3 s.
        assert!((mechs[0].2 - 45.0).abs() < 0.5 && (mechs[1].2 - 45.0).abs() < 0.5, "{mechs:?}");
        // Home: banked.
        mechs[0].1 = Vector::new(5.0, 0.0, 95.0);
        let banked = s.energy(200, &mut mechs, true);
        assert!((banked[0] - s.banks[0]).abs() < 1e-3 && mechs[0].2 == 0.0 && banked[1] == 0.0);
        // At someone else's base it stays carried.
        mechs[1].1 = Vector::new(0.0, 0.0, 100.0);
        assert_eq!(s.energy(201, &mut mechs, true)[1], 0.0);
        // The trickle runs only with no ship up.
        let before = s.banks[1];
        s.energy(202, &mut [], false);
        assert!((s.banks[1] - before - TRICKLE * DT).abs() < 1e-4);
    }

    #[test]
    fn a_fallen_mechs_eu_waits_for_whoever_comes() {
        let mut s = siege();
        s.drop(Vector::new(20.0, 0.0, 20.0), 70.0, 0);
        let mut mechs = vec![(1, Vector::new(21.0, 0.0, 20.0), 50.0)];
        s.energy(1, &mut mechs, true);
        assert_eq!((mechs[0].2, s.drops[0].eu), (CARRY_MAX, 20.0));
        s.energy((DROP_SECONDS * TICK_HZ) as u32 + 1, &mut [], true);
        assert!(s.drops.is_empty(), "drops fade");
    }

    #[test]
    fn a_full_bank_launches_a_ship_that_flies_over_the_enemy_base_and_bombards_it() {
        let mut s = siege();
        s.banks[0] = LAUNCH_EU;
        assert_eq!((s.launch([true, false]), s.launch([false, false])), (None, Some(0)));
        assert_eq!(s.banks[0], 0.0);
        let mut ships = vec![(0, s.ship_start(0), SHIP_HULL)];
        let mut secs = 0.0;
        while s.fallen().is_none() {
            s.fly(&mut ships);
            secs += DT;
            assert!(secs < 300.0, "never got there: {ships:?}");
        }
        assert_eq!(s.fallen(), Some(1));
        assert!((ships[0].1 - Vector::new(0.0, 50.0, -100.0)).length() < BOMBARD_RANGE);
        // 200 m at SHIP_SPEED, then the hull at BOMBARD_DPS.
        let expected = (200.0 - BOMBARD_RANGE * 0.5) / SHIP_SPEED + BASE_HULL / BOMBARD_DPS;
        assert!((secs - expected).abs() < 3.0, "{secs} s, not {expected}");
    }

    #[test]
    fn ships_in_range_stop_and_fight_and_the_aa_gun_fires_on_the_enemy_one() {
        let mut s = siege();
        let mut ships = vec![(0, Vector::new(0.0, 50.0, 50.0), SHIP_HULL), (1, Vector::new(0.0, 50.0, -50.0), SHIP_HULL)];
        s.fly(&mut ships);
        assert_eq!((ships[0].1.z, ships[1].1.z), (50.0, -50.0), "they moved");
        assert!(ships[0].2 < SHIP_HULL && ships[1].2 < SHIP_HULL);
        s.aa.state.owner = Some(0);
        let before = ships.clone();
        s.fly(&mut ships);
        assert!(before[1].2 - ships[1].2 > before[0].2 - ships[0].2, "the AA gun didn't fire on team 1's ship");
    }

    #[test]
    fn bots_carry_home_man_the_aa_gun_and_go_for_energy() {
        let mut s = siege();
        let at = |x: f32, z: f32| Vector::new(x, 0.0, z);
        let mechs = [(0, at(0.0, 50.0), true, 90.0), (0, at(0.0, 50.0), true, 0.0), (0, at(-50.0, 10.0), true, 0.0), (0, at(0.0, 60.0), false, 0.0)];
        let orders = s.orders(&mechs, [false, false]);
        assert_eq!(orders[0], Some(s.bases[0]), "a full load goes home");
        assert_eq!(orders[1], Some(s.aa.at), "one to the AA gun");
        assert_eq!(orders[2], Some(s.stations[0].0.at), "the rest to the station");
        assert_eq!(orders[3], None, "humans get none");
        // The enemy ship's up: two to the AA gun.
        let orders = s.orders(&mechs, [false, true]);
        assert_eq!(orders[2], Some(s.aa.at));
        // Holding the AA gun with our ship up: the rest roam.
        s.aa.state = crate::objective::ZoneState { owner: Some(0), progress: 1.0, contested: false };
        assert_eq!(s.orders(&mechs, [true, false])[1..3], [None, None]);
    }
}
