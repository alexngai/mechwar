//! Capture the Flag's rules. Each team's flag stands in a zone at its base, under a shelter. A
//! raider standing in the enemy's zone with no defender in it takes their flag in TAKE_SECONDS;
//! carried into its own team's zone, it scores. A carrier who falls drops the flag where they fell:
//! the enemy can pick it up again, and its own team has to carry it home. A carrier walks slower
//! and can't boost (`Mech::laden`). `Game` says who stands where and who fell, and applies what
//! comes out (events, credit, the match's end).

use serde::{Deserialize, Serialize};

use crate::map::Objectives;
use crate::objective::Zone;
use crate::{DT, Vector};

/// A raid takes a flag off its stand in this long (s), and the progress ebbs as fast once the
/// raiders are gone.
pub const TAKE_SECONDS: f32 = 3.0;
/// Captures that win the match.
pub const CAPTURES_TO_WIN: u16 = 3;
/// A dropped flag is picked up by feet this close (across, and up or down).
const PICKUP_RADIUS: f32 = 3.0;

/// How many of a team's bots go to each job (a dropped flag, either side's, takes one):
/// raiding the enemy's stand, escorting its own carrier, chasing the enemy's and guarding its
/// own stand. Bots left over fight where they like.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Squads {
    pub raid: usize,
    pub escort: usize,
    pub chase: usize,
    pub guard: usize,
}

impl Default for Squads {
    fn default() -> Self {
        Squads { raid: 2, escort: 1, chase: 2, guard: 1 }
    }
}

/// Where a flag is.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Flag {
    Home,
    /// By player `by`.
    Carried { by: u8 },
    /// Lying where its carrier fell.
    Dropped { at: Vector },
}

/// What happened to a team's flag (the team is the flag's), and by whom.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Happened {
    /// Off its stand, by a raider.
    Taken,
    /// Its carrier fell.
    Dropped,
    /// Off the ground, by either side.
    PickedUp,
    /// Home: carried back by its own side (or put back, by nobody, from where nobody can reach it).
    Returned,
    /// Carried into the other side's zone: a point for them.
    Captured,
}

/// What players see of a match: each flag, how far a raid on each stand has got (0-1) and
/// whether its defenders are holding it off, and the captures.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CtfNet {
    pub flags: Vec<Flag>,
    pub taking: [f32; 2],
    pub contested: [bool; 2],
    pub captures: [u16; 2],
}

pub struct Ctf {
    /// Each team's stand, its zone.
    pub stands: [Zone; 2],
    pub flags: [Flag; 2],
    /// How far a raid on each stand has got, 0-1, and whether defenders stand in it too.
    pub taking: [f32; 2],
    pub contested: [bool; 2],
    pub captures: [u16; 2],
}

impl Ctf {
    /// The match on a map with `spots`, its bots' waypoints `waypoints`; None without flag stands.
    pub fn new(spots: &Objectives, waypoints: &[Vector]) -> Option<Ctf> {
        let stands = spots.flags.as_ref()?.map(|s| Zone::new(&s, waypoints));
        Some(Ctf { stands, flags: [Flag::Home; 2], taking: [0.0; 2], contested: [false; 2], captures: [0; 2] })
    }

    pub fn net(&self) -> CtfNet {
        CtfNet { flags: self.flags.to_vec(), taking: self.taking, contested: self.contested, captures: self.captures }
    }

    /// The flag player `id` carries (its team), if any.
    pub fn carried_by(&self, id: u8) -> Option<u8> {
        (0..2).find(|&t| self.flags[usize::from(t)] == Flag::Carried { by: id })
    }

    /// Player `id` fell (or left): the flag they carried lies at `at`, or, with None (where nobody
    /// can reach it), goes home.
    pub fn fell(&mut self, id: u8, at: Option<Vector>) -> Option<(u8, Happened)> {
        let team = self.carried_by(id)?;
        let (flag, happened) = match at {
            Some(at) => (Flag::Dropped { at }, Happened::Dropped),
            None => (Flag::Home, Happened::Returned),
        };
        self.flags[usize::from(team)] = flag;
        Some((team, happened))
    }

    /// One tick with the living `mechs` (id, team, feet): raids on the stands, pickups, returns
    /// and captures. What happened to which flag (its team), and by whom.
    pub fn step(&mut self, mechs: &[(u8, u8, Vector)]) -> Vec<(u8, Happened, Option<u8>)> {
        let mut out = Vec::new();
        for team in 0..2u8 {
            let t = usize::from(team);
            let carriers = self.flags.map(|f| match f {
                Flag::Carried { by } => Some(by),
                _ => None,
            });
            let free = |m: &&(u8, u8, Vector)| !carriers.contains(&Some(m.0));
            match self.flags[t] {
                Flag::Home => {
                    let stand = &self.stands[t];
                    let raiders: Vec<&(u8, u8, Vector)> = mechs.iter().filter(|m| m.1 != team && stand.holds(m.2)).filter(free).collect();
                    let defended = mechs.iter().any(|m| m.1 == team && stand.holds(m.2));
                    self.contested[t] = !raiders.is_empty() && defended;
                    if raiders.is_empty() {
                        self.taking[t] = (self.taking[t] - DT / TAKE_SECONDS).max(0.0);
                    } else if !defended {
                        self.taking[t] += DT / TAKE_SECONDS;
                    }
                    // Taken by the raider nearest the flag.
                    if self.taking[t] >= 1.0 {
                        let by = raiders.iter().min_by(|a, b| a.2.distance(stand.at).total_cmp(&b.2.distance(stand.at))).map(|m| m.0);
                        if let Some(by) = by {
                            (self.flags[t], self.taking[t]) = (Flag::Carried { by }, 0.0);
                            out.push((team, Happened::Taken, Some(by)));
                        }
                    }
                }
                Flag::Carried { by } => {
                    self.contested[t] = false;
                    // Gone (it left without falling): home.
                    let Some(&(_, side, feet)) = mechs.iter().find(|m| m.0 == by) else {
                        self.flags[t] = Flag::Home;
                        out.push((team, Happened::Returned, None));
                        continue;
                    };
                    if self.stands[usize::from(side)].holds(feet) {
                        self.flags[t] = Flag::Home;
                        if side == team {
                            out.push((team, Happened::Returned, Some(by)));
                        } else {
                            self.captures[usize::from(side)] += 1;
                            out.push((team, Happened::Captured, Some(by)));
                        }
                    }
                }
                Flag::Dropped { at } => {
                    self.contested[t] = false;
                    let near = |m: &&(u8, u8, Vector)| (m.2 - at).with_y(0.0).length() <= PICKUP_RADIUS && (m.2.y - at.y).abs() <= PICKUP_RADIUS;
                    let by = mechs.iter().filter(near).filter(free).min_by(|a, b| a.2.distance(at).total_cmp(&b.2.distance(at))).map(|m| m.0);
                    if let Some(by) = by {
                        self.flags[t] = Flag::Carried { by };
                        out.push((team, Happened::PickedUp, Some(by)));
                    }
                }
            }
        }
        out
    }

    /// The team with CAPTURES_TO_WIN, if one has.
    pub fn won(&self) -> Option<u8> {
        (0..2).find(|&t| self.captures[usize::from(t)] >= CAPTURES_TO_WIN)
    }

    /// Where each of `mechs` (id, team, feet, whether it's a bot) should head: a bot carrying a
    /// flag, home; then, nearest first, one to fetch our dropped flag, two after an enemy carrying
    /// ours, one to grab theirs off the ground, two to raid their stand while it's home (else one
    /// to escort our carrier), and one to hold our stand while our flag's on it. The rest roam
    /// (None), as do humans.
    pub fn orders(&self, mechs: &[(u8, u8, Vector, bool)]) -> Vec<Option<Vector>> {
        self.orders_by(mechs, [Squads::default(); 2])
    }

    /// `orders`, with each team's own `squads`.
    pub fn orders_by(&self, mechs: &[(u8, u8, Vector, bool)], squads: [Squads; 2]) -> Vec<Option<Vector>> {
        let mut out = vec![None; mechs.len()];
        let rally = |zone: &Zone| zone.rally.first().copied().unwrap_or(zone.at);
        let feet = |id: u8| mechs.iter().find(|m| m.0 == id).map(|m| m.2);
        for team in 0..2u8 {
            let (ours, theirs, sq) = (self.flags[usize::from(team)], self.flags[usize::from(1 - team)], squads[usize::from(team)]);
            let mut free: Vec<usize> = Vec::new();
            for i in (0..mechs.len()).filter(|&i| mechs[i].1 == team && mechs[i].3) {
                if self.carried_by(mechs[i].0).is_some() {
                    out[i] = Some(rally(&self.stands[usize::from(team)]));
                } else {
                    free.push(i);
                }
            }
            let mut jobs: Vec<(Vector, usize)> = Vec::new();
            match ours {
                Flag::Dropped { at } => jobs.push((at, 1)),
                Flag::Carried { by } if mechs.iter().any(|m| m.0 == by && m.1 != team) => jobs.extend(feet(by).map(|at| (at, sq.chase))),
                _ => {}
            }
            match theirs {
                Flag::Dropped { at } => jobs.push((at, 1)),
                Flag::Home => jobs.push((rally(&self.stands[usize::from(1 - team)]), sq.raid)),
                Flag::Carried { by } => jobs.extend(feet(by).filter(|_| mechs.iter().any(|m| m.0 == by && m.1 == team)).map(|at| (at, sq.escort))),
            }
            if ours == Flag::Home {
                jobs.push((rally(&self.stands[usize::from(team)]), sq.guard));
            }
            for (at, n) in jobs {
                for _ in 0..n {
                    let Some(k) = (0..free.len()).min_by(|&a, &b| mechs[free[a]].2.distance(at).total_cmp(&mechs[free[b]].2.distance(at))) else { break };
                    out[free.swap_remove(k)] = Some(at);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TICK_HZ;
    use crate::map::ZoneSpot;

    fn ctf() -> Ctf {
        let stand = |z: f32| ZoneSpot { at: [0.0, 0.0, z], radius: 5.0, band: 3.0, pad: None };
        Ctf::new(&Objectives { flags: Some([stand(100.0), stand(-100.0)]), ..Objectives::default() }, &[]).unwrap()
    }

    const HOME: [Vector; 2] = [Vector::new(0.0, 0.0, 100.0), Vector::new(0.0, 0.0, -100.0)];

    /// Ticks of `mechs` standing still.
    fn run(c: &mut Ctf, mechs: &[(u8, u8, Vector)], seconds: f32) -> Vec<(u8, Happened, Option<u8>)> {
        (0..(seconds * TICK_HZ).round() as u32).flat_map(|_| c.step(mechs)).collect()
    }

    #[test]
    fn a_raider_takes_the_flag_in_three_seconds_unless_a_defender_holds_it_off() {
        let mut c = ctf();
        let raider = (5, 1, HOME[0] + Vector::X);
        assert!(run(&mut c, &[raider], TAKE_SECONDS - 0.2).is_empty());
        // A defender walks in: frozen.
        let defender = (1, 0, HOME[0] - Vector::X);
        let before = c.taking[0];
        assert!(run(&mut c, &[raider, defender], 2.0).is_empty());
        assert!(c.contested[0] && c.taking[0] == before);
        assert_eq!(run(&mut c, &[raider], 0.3), [(0, Happened::Taken, Some(5))]);
        assert_eq!((c.flags[0], c.carried_by(5)), (Flag::Carried { by: 5 }, Some(0)));
        // A raid that leaves ebbs away.
        let mut c = ctf();
        run(&mut c, &[raider], 1.5);
        run(&mut c, &[], 1.0);
        assert!((c.taking[0] - 0.5 / TAKE_SECONDS).abs() < 0.02, "{}", c.taking[0]);
    }

    #[test]
    fn a_carried_flag_scores_at_the_carriers_stand_whether_or_not_theirs_is_home() {
        let mut c = ctf();
        c.flags = [Flag::Carried { by: 5 }, Flag::Carried { by: 1 }];
        assert_eq!(c.step(&[(5, 1, HOME[1]), (1, 0, Vector::ZERO)]), [(0, Happened::Captured, Some(5))]);
        assert_eq!((c.flags[0], c.captures), (Flag::Home, [0, 1]));
        c.captures[1] = CAPTURES_TO_WIN;
        assert_eq!(c.won(), Some(1));
    }

    #[test]
    fn a_dropped_flag_goes_to_whoever_comes_and_home_only_when_its_side_carries_it_there() {
        let mut c = ctf();
        c.flags[0] = Flag::Carried { by: 5 };
        let spot = Vector::new(10.0, 0.0, 0.0);
        assert_eq!(c.fell(5, Some(spot)), Some((0, Happened::Dropped)));
        assert_eq!(c.fell(5, Some(spot)), None, "dropped twice");
        // Nobody near: it lies there.
        assert!(run(&mut c, &[(1, 0, spot + Vector::X * 10.0)], 30.0).is_empty());
        // Its own side picks it up, and has to walk it home.
        assert_eq!(c.step(&[(1, 0, spot + Vector::X)]), [(0, Happened::PickedUp, Some(1))]);
        assert!(run(&mut c, &[(1, 0, Vector::new(0.0, 0.0, 50.0))], 1.0).is_empty());
        assert_eq!(c.step(&[(1, 0, HOME[0])]), [(0, Happened::Returned, Some(1))]);
        // Dropped where nobody can reach: home at once.
        c.flags[0] = Flag::Carried { by: 5 };
        assert_eq!((c.fell(5, None), c.flags[0]), (Some((0, Happened::Returned)), Flag::Home));
    }

    #[test]
    fn one_flag_to_a_mech() {
        let mut c = ctf();
        // Carrying our own flag home, through their stand: no raid on it.
        c.flags[1] = Flag::Carried { by: 5 };
        assert!(run(&mut c, &[(5, 1, HOME[0])], TAKE_SECONDS + 0.5).iter().all(|e| e.1 != Happened::Taken));
        assert_eq!(c.flags[0], Flag::Home);
    }

    #[test]
    fn bots_carry_home_raid_defend_and_chase() {
        let mut c = ctf();
        let bot = |id: u8, at: Vector| (id, 0, at, true);
        let mechs = [bot(0, Vector::new(0.0, 0.0, 90.0)), bot(1, Vector::new(0.0, 0.0, 20.0)), bot(2, Vector::new(5.0, 0.0, 10.0)), bot(3, Vector::new(0.0, 0.0, 60.0)), (4, 0, Vector::ZERO, false)];
        let orders = c.orders(&mechs);
        let (theirs, ours) = (c.stands[1].at, c.stands[0].at);
        assert_eq!(orders[1..3], [Some(theirs), Some(theirs)], "the two nearest raid");
        assert_eq!(orders[0], Some(ours), "one holds our stand");
        assert_eq!((orders[3], orders[4]), (None, None), "the rest roam; humans get none");
        // Bot 1 has their flag: home. An enemy has ours: the two nearest go after it.
        c.flags = [Flag::Carried { by: 9 }, Flag::Carried { by: 1 }];
        let mut mechs = mechs.to_vec();
        mechs.push((9, 1, Vector::new(0.0, 0.0, 70.0), false));
        let orders = c.orders(&mechs);
        assert_eq!(orders[1], Some(ours));
        assert_eq!((orders[0], orders[3]), (Some(mechs[5].2), Some(mechs[5].2)));
        assert_eq!(orders[2], Some(mechs[1].2), "one escorts our carrier");
    }

    #[test]
    fn a_teams_squads_set_how_many_go_to_each_job() {
        let c = ctf();
        let mechs: Vec<(u8, u8, Vector, bool)> = (0..4).map(|id| (id, 0, Vector::new(0.0, 0.0, 10.0 * f32::from(id)), true)).collect();
        let (theirs, ours) = (c.stands[1].at, c.stands[0].at);
        let all_in = Squads { raid: 4, escort: 0, chase: 0, guard: 1 };
        let orders = c.orders_by(&mechs, [all_in, Squads::default()]);
        assert!(orders.iter().all(|o| *o == Some(theirs)), "the raid takes all four before the guard: {orders:?}");
        let home = Squads { raid: 0, escort: 0, chase: 0, guard: 2 };
        let orders = c.orders_by(&mechs, [home, Squads::default()]);
        assert_eq!(orders.iter().filter(|o| **o == Some(ours)).count(), 2);
        assert_eq!(orders.iter().filter(|o| o.is_none()).count(), 2, "the rest roam");
    }
}
