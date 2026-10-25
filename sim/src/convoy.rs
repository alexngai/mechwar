//! Convoy's rules. A neutral hauler (`deploy::Kind::Hauler`) starts in the middle of a route that
//! runs from team 0's base to team 1's. It's a tug of war: the team with more mechs near it walks
//! it toward the other's base, faster the bigger its lead in numbers. Level, it stops; nobody near,
//! it stays put. Shot through its shield, it stalls a while. Into a base's zone, it's delivered:
//! the team that walked it there wins. At the time limit, whoever pushed it further wins. `Game`
//! keeps the hauler among its deployables, says who stands where, and applies what comes out.

use serde::{Deserialize, Serialize};

use crate::map::Objectives;
use crate::{DT, Vector};

/// Its walk (m/s) with a lead of two escorts. A lead of one walks it at ESCORT_SPEEDS[0] of that,
/// each more at the next, the full team unopposed at the last. (Tuned in bot-only matches: at
/// 6.5 m/s and ESCORT_RANGE 30 m about 2 in 5 end in a delivery.)
pub const SPEED: f32 = 6.5;
const ESCORT_SPEEDS: [f32; 4] = [0.75, 1.0, 1.25, 1.5];
/// Mechs this near (across, and up or down within ESCORT_BAND) escort it, or hold it back.
pub const ESCORT_RANGE: f32 = 30.0;
const ESCORT_BAND: f32 = 6.0;
/// Its shield; shot through, it stalls this long, then comes back full.
pub const SHIELD: f32 = 1500.0;
pub const STALL_SECONDS: f32 = 8.0;
/// It's in a base, delivered, this far from its route's end there: the base's zone (as Siege's).
const BASE_REACH: f32 = 14.0;
/// Bots at it take cover this far back along the route from its middle, toward their own base, in
/// lanes this far across the route (inside the clearance it walks in), so it stands between the
/// two sides. A side with SPARE more mechs at it than the other sends a bot SCOUT ahead of it,
/// toward the other base.
const COVER: f32 = 8.0;
const LANES: [f32; 4] = [0.0, 3.0, -3.0, 1.5];
const SPARE: usize = 2;
const SCOUT: f32 = 35.0;

/// What players see of the convoy: where the hauler is along its route and where it started
/// (0 at team 0's base, 1 at team 1's), who's pushing it and by how many more mechs, whether both
/// teams are at it in even numbers (so it's stopped), and the seconds its stall has left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ConvoyNet {
    pub along: f32,
    pub start: f32,
    pub pusher: Option<u8>,
    pub escorts: u8,
    pub contested: bool,
    pub stall: f32,
}

/// What happened to the convoy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum News {
    /// `team` took it over and has it moving.
    Pushing(u8),
    Stalled,
    Rebooted,
    /// Into the base of the team that isn't `team`: `team` wins.
    Delivered(u8),
}

pub struct Convoy {
    /// The route, and how far along it each point is.
    pub points: Vec<Vector>,
    marks: Vec<f32>,
    /// Where it started, and where it is (m along the route).
    pub start: f32,
    pub along: f32,
    /// This tick: the team pushing it and its lead in escorts, and whether both teams are at it
    /// in even numbers.
    pub pusher: Option<u8>,
    pub escorts: usize,
    pub contested: bool,
    /// The last team that had it moving (for news when another takes over), and whether it was
    /// stalled as of the last tick (for news when it stalls).
    last: Option<u8>,
    pub stalled: bool,
}

impl Convoy {
    /// The convoy on a map with `spots`; None without a route.
    pub fn new(spots: &Objectives) -> Option<Convoy> {
        let route = spots.convoy.as_ref()?;
        let points: Vec<Vector> = route.points.iter().map(|p| Vector::from_array(*p)).collect();
        (points.len() >= 3 && route.start > 0 && route.start < points.len() - 1).then_some(())?;
        let mut marks = vec![0.0];
        for w in points.windows(2) {
            marks.push(marks.last().unwrap() + w[0].distance(w[1]));
        }
        let start = marks[route.start];
        Some(Convoy { points, marks, start, along: start, pusher: None, escorts: 0, contested: false, last: None, stalled: false })
    }

    /// The route's length.
    pub fn length(&self) -> f32 {
        *self.marks.last().unwrap()
    }

    /// The point `along` the route, and the heading (yaw, as a mech's) toward team 1's end there.
    pub fn at(&self, along: f32) -> (Vector, f32) {
        let i = self.marks.partition_point(|&m| m <= along).clamp(1, self.points.len() - 1);
        let (a, b) = (self.points[i - 1], self.points[i]);
        let f = ((along - self.marks[i - 1]) / (self.marks[i] - self.marks[i - 1]).max(1e-4)).clamp(0.0, 1.0);
        let dir = b - a;
        (a + dir * f, (-dir.x).atan2(-dir.z))
    }

    /// One tick with the living `mechs` (team, feet), the hauler at `hauler` and `stalled` or
    /// not: who's ahead at it, and where it walks. News of a team taking it over, and of delivery.
    pub fn step(&mut self, mechs: &[(u8, Vector)], hauler: Vector, stalled: bool) -> Option<News> {
        let near = |p: Vector| (p - hauler).with_y(0.0).length() <= ESCORT_RANGE && (p.y - hauler.y).abs() <= ESCORT_BAND;
        // Tug of war: the side with more mechs at it walks it, as fast as its lead in numbers.
        let count = [0, 1].map(|t| mechs.iter().filter(|m| m.0 == t && near(m.1)).count());
        self.contested = count[0] > 0 && count[0] == count[1];
        self.pusher = (count[0] != count[1]).then_some(u8::from(count[1] > count[0]));
        self.escorts = count[0].abs_diff(count[1]);
        let Some(team) = self.pusher.filter(|_| !stalled) else { return None };
        // Team 0 walks it toward team 1's base, the far end, and team 1 back.
        let speed = SPEED * ESCORT_SPEEDS[self.escorts.clamp(1, ESCORT_SPEEDS.len()) - 1];
        let step = if team == 0 { speed * DT } else { -speed * DT };
        self.along = (self.along + step).clamp(0.0, self.length());
        if self.along >= self.length() - BASE_REACH || self.along <= BASE_REACH {
            return Some(News::Delivered(team));
        }
        let took = self.last != Some(team);
        self.last = Some(team);
        took.then_some(News::Pushing(team))
    }

    /// How far each team has pushed it from the start toward the other's base, 0-1.
    pub fn pushed(&self) -> [f32; 2] {
        let len = self.length();
        [((self.along - self.start) / (len - self.start)).max(0.0), ((self.start - self.along) / self.start).max(0.0)]
    }

    /// The team that's pushed it further, if one has.
    pub fn leader(&self) -> Option<u8> {
        let [a, b] = self.pushed();
        (a != b).then_some(u8::from(b > a))
    }

    pub fn net(&self, stall: f32) -> ConvoyNet {
        let len = self.length();
        ConvoyNet { along: self.along / len, start: self.start / len, pusher: self.pusher, escorts: self.escorts as u8, contested: self.contested, stall }
    }

    /// Where each of `mechs` (team, feet, whether it's a bot, whether it's alive) should head
    /// with the hauler at `hauler`: each living bot to a spot in cover behind it, on its own
    /// base's side, nearest first into the middle lane; but while its side has SPARE more mechs
    /// at the hauler than the other, the one furthest from it scouts ahead. Humans get None.
    pub fn orders(&self, mechs: &[(u8, Vector, bool, bool)], hauler: Vector) -> Vec<Option<Vector>> {
        let near = |m: &&(u8, Vector, bool, bool)| m.3 && (m.1 - hauler).with_y(0.0).length() <= ESCORT_RANGE && (m.1.y - hauler.y).abs() <= ESCORT_BAND;
        let count = [0, 1].map(|t| mechs.iter().filter(|m| m.0 == t).filter(near).count());
        // Across the route here, for the lanes.
        let (a, b) = (self.at(self.along - 1.0).0, self.at(self.along + 1.0).0);
        let ahead = (b - a).with_y(0.0).normalize_or(Vector::NEG_Z);
        let across = Vector::new(-ahead.z, 0.0, ahead.x);
        let mut out = vec![None; mechs.len()];
        for team in 0..2u8 {
            // Our base is back down the route (team 0's at its start), theirs on up it.
            let home = if team == 0 { -1.0 } else { 1.0 };
            let mut bots: Vec<usize> = (0..mechs.len()).filter(|&i| mechs[i].0 == team && mechs[i].2 && mechs[i].3).collect();
            bots.sort_by(|&x, &y| mechs[x].1.distance(hauler).total_cmp(&mechs[y].1.distance(hauler)));
            if count[usize::from(team)] >= count[usize::from(1 - team)] + SPARE && bots.len() > 1 {
                let scout = bots.pop().expect("more than one");
                out[scout] = Some(self.at(self.along - home * SCOUT).0);
            }
            let behind = self.at(self.along + home * COVER).0;
            for (k, &i) in bots.iter().enumerate() {
                out[i] = Some(behind + across * LANES[k % LANES.len()]);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TICK_HZ;
    use crate::map::Route;

    /// A straight route from z 100 (team 0's base) through the middle to z -100 (team 1's).
    fn convoy() -> Convoy {
        let route = Route { points: vec![[0.0, 0.0, 100.0], [0.0, 0.0, 40.0], [0.0, 0.0, 0.0], [0.0, 0.0, -50.0], [0.0, 0.0, -100.0]], start: 2 };
        Convoy::new(&Objectives { convoy: Some(route), ..Objectives::default() }).unwrap()
    }

    /// `seconds` of `mechs` standing around the hauler (team, how far off), each tick.
    fn walk(c: &mut Convoy, mechs: &[(u8, f32)], seconds: f32) -> Vec<News> {
        (0..(seconds * TICK_HZ).round() as u32)
            .filter_map(|_| {
                let hauler = c.at(c.along).0;
                let at: Vec<(u8, Vector)> = mechs.iter().map(|&(t, off)| (t, hauler + Vector::X * off)).collect();
                c.step(&at, hauler, false)
            })
            .collect()
    }

    #[test]
    fn escorts_walk_it_toward_the_other_base_faster_the_more_they_are() {
        let mut c = convoy();
        assert_eq!(c.length(), 200.0);
        assert_eq!(walk(&mut c, &[(0, 5.0)], 1.0), [News::Pushing(0)]);
        assert!((c.along - c.start - 0.75 * SPEED).abs() < 0.05, "one escort: {}", c.along - c.start);
        let before = c.along;
        walk(&mut c, &[(0, 5.0), (0, 6.0), (0, 7.0), (0, 8.0)], 1.0);
        assert!((c.along - before - 1.5 * SPEED).abs() < 0.05, "the full team: {}", c.along - before);
        // Team 1 takes it over three to one: back the other way, at a lead of two's pace.
        let before = c.along;
        assert_eq!(walk(&mut c, &[(1, 5.0), (1, 6.0), (1, 7.0), (0, 8.0)], 1.0), [News::Pushing(1)]);
        assert!((before - c.along - SPEED).abs() < 0.05);
        assert!(c.pushed()[0] > 0.0 && c.leader() == Some(0));
    }

    #[test]
    fn contested_or_alone_or_stalled_it_stays_put() {
        let mut c = convoy();
        walk(&mut c, &[(0, 5.0), (1, 6.0)], 2.0);
        assert!(c.contested && c.along == c.start);
        walk(&mut c, &[(0, ESCORT_RANGE + 1.0)], 2.0);
        assert_eq!(c.along, c.start, "nobody near");
        let hauler = c.at(c.along).0;
        assert_eq!(c.step(&[(0, hauler)], hauler, true), None);
        assert_eq!((c.along, c.pusher), (c.start, Some(0)), "stalled");
        assert_eq!(c.leader(), None);
    }

    #[test]
    fn into_a_base_its_delivered() {
        let mut c = convoy();
        c.along = BASE_REACH + 1.0;
        assert_eq!(walk(&mut c, &[(1, 5.0)], 1.0).last(), Some(&News::Delivered(1)));
        assert!(c.along <= BASE_REACH && c.leader() == Some(1));
        let (_, yaw) = c.at(c.along);
        // Heading toward team 1's end: -z, a yaw of 0.
        assert!(yaw.abs() < 1e-4, "{yaw}");
    }

    #[test]
    fn bots_take_cover_behind_it_on_their_own_side_and_spare_ones_scout_ahead() {
        let c = convoy();
        let hauler = c.at(c.along).0;
        let mech = |team: u8, z: f32, bot: bool| (team, Vector::new(0.0, 0.0, z), bot, true);
        // One a side at it: each behind it toward its own base (team 0's at +z), none spare.
        let mechs = [mech(0, 5.0, true), mech(0, 60.0, true), mech(1, -5.0, true), (1, Vector::new(0.0, 0.0, -9.0), true, false), mech(1, -4.0, false)];
        let orders = c.orders(&mechs, hauler);
        assert_eq!(orders[0], Some(Vector::new(0.0, 0.0, COVER)));
        assert_eq!(orders[1], Some(Vector::new(LANES[1], 0.0, COVER)), "the next in the next lane");
        assert_eq!(orders[2], Some(Vector::new(0.0, 0.0, -COVER)));
        assert_eq!((orders[3], orders[4]), (None, None), "the dead and humans get none");
        // Three of team 0 at it to one of team 1: its furthest bot scouts on toward team 1's base.
        let mechs = [mech(0, 5.0, true), mech(0, 6.0, false), mech(0, 7.0, true), mech(0, 80.0, true), mech(1, -5.0, true)];
        let orders = c.orders(&mechs, hauler);
        assert_eq!(orders[3], Some(Vector::new(0.0, 0.0, -SCOUT)));
        assert!(orders[0].is_some_and(|o| o.z > 0.0) && orders[2].is_some_and(|o| o.z > 0.0));
    }
}
