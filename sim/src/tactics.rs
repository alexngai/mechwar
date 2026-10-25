//! Tactical spots: where on a map a mech can stand to fight or to hide, far denser than the bots'
//! waypoints (up to 35 m apart), each knowing which ways it has cover. Spots lie 2.5 m apart
//! wherever there's cover close by, and 7.5 m apart in the open, on every floor walked out to
//! from a waypoint, a 2.5 m step at a time. For each class, a spot's `cover` bits say from
//! which of 16 directions something close by hides a mech's middle, and `over` which of those
//! it can see over (low cover: shoot over it, hidden). The bits sort spots cheaply; whether one
//! hides from, or sees, a given enemy is a ray (`exposed`, `sees_from`), and `peek` finds the
//! step out from cover that sees one.

use std::collections::HashMap;
use std::f32::consts::TAU;
use std::sync::OnceLock;

use rapier3d::prelude::Ray;

use crate::bot::Nav;
use crate::map::{MAPS, Map};
use crate::threat::Curve;
use crate::{Arena, MechClass, Tuning, Vector};

/// Spot spacing where there's cover close by, and in the open (a multiple of it).
const STEP: f32 = 2.5;
const OPEN_EVERY: i32 = 3;
/// Farthest a spot lies from the waypoints: a little over half their link range.
const SPOT_REACH: f32 = 22.0;
/// How close something must stand to a spot to count as its cover, past the mech's own radius.
const COVER_REACH: f32 = 2.5;
/// Directions a spot's cover is read in.
pub const DIRS: usize = 16;
/// How far a step out from cover may go (`peek`): two spots over and one along.
pub const PEEK_STEP: f32 = 5.6;
/// Highest a floor may lie above or below a spot's waypoint, and a walk's ground below its line.
const FLOOR_RISE: f32 = 2.5;
const LEDGE: f32 = 1.2;

#[derive(Clone, Copy, Debug)]
pub struct Spot {
    /// Feet.
    pub pos: Vector,
    /// The waypoint it was walked out to from, a spot at a time.
    pub waypoint: u16,
    /// Per class (`MechClass::index`): bit k set if something within COVER_REACH toward
    /// direction k (`dir`) hides the class's middle; `over`, if its eye sees over that.
    pub cover: [u16; 3],
    pub over: [u16; 3],
}

impl Spot {
    /// Whether this spot has cover, for `class`, from a threat off toward `toward` (flat).
    pub fn covered(&self, class: MechClass, toward: Vector) -> bool {
        self.cover[class.index()] & (1 << dir_of(toward)) != 0
    }

    /// Whether that cover is low enough for `class` to fight over it.
    pub fn over(&self, class: MechClass, toward: Vector) -> bool {
        self.over[class.index()] & (1 << dir_of(toward)) != 0
    }
}

pub struct Spots {
    pub spots: Vec<Spot>,
    /// Spot indices by STEP-sized cell (x, z).
    cells: HashMap<(i32, i32), Vec<u32>>,
    /// Each spot's neighbours within PEEK_STEP on its own floor, with nothing between.
    pub steps: Vec<Vec<u32>>,
}

/// Direction k of DIRS, flat and unit, k = 0 toward -Z, turning toward +X.
pub fn dir(k: usize) -> Vector {
    let a = k as f32 * TAU / DIRS as f32;
    Vector::new(libm::sinf(a), 0.0, -libm::cosf(a))
}

/// The direction (of DIRS) nearest `v`, flat.
pub fn dir_of(v: Vector) -> usize {
    let a = libm::atan2f(v.x, -v.z).rem_euclid(TAU);
    (libm::roundf(a / TAU * DIRS as f32) as usize) % DIRS
}

fn cell(p: Vector) -> (i32, i32) {
    (libm::floorf(p.x / STEP) as i32, libm::floorf(p.z / STEP) as i32)
}

/// Whether a mech of `t` standing at `at` has its middle seen from `eye`.
pub fn exposed(arena: &Arena, t: &Tuning, at: Vector, eye: Vector) -> bool {
    clear(arena, eye, at + Vector::Y * (t.mech_height * 0.5))
}

/// Whether a mech of `t` standing at `at` sees `chest` (its eye to it).
pub fn sees_from(arena: &Arena, t: &Tuning, at: Vector, chest: Vector) -> bool {
    clear(arena, at + Vector::Y * t.eye_height, chest)
}

fn clear(arena: &Arena, from: Vector, to: Vector) -> bool {
    let d = to - from;
    let len = d.length();
    len < 1e-3 || arena.cast_ray(&Ray::new(from, d / len), len).is_none()
}

impl Spots {
    /// Generated for each compiled-in map on first use, and kept.
    pub fn for_map(index: usize) -> &'static Spots {
        static CACHE: [OnceLock<Spots>; MAPS.len()] = [const { OnceLock::new() }; MAPS.len()];
        CACHE[index].get_or_init(|| {
            let map = Map::load(index);
            Spots::generate(&Arena::new(&map), Nav::for_map(index), &Tuning::default())
        })
    }

    pub fn generate(arena: &Arena, nav: &Nav, t: &Tuning) -> Spots {
        let classes = MechClass::ALL.map(|c| t.for_class(c));
        let medium = &classes[MechClass::B.index()];
        // Every grid point near a waypoint with room to stand, by (x, z) and floor (2 m bands).
        let mut room: HashMap<(i32, i32, i32), Vector> = HashMap::new();
        let mut tried = std::collections::HashSet::new();
        let reach = (SPOT_REACH / STEP) as i32;
        let grid = |v: f32| libm::roundf(v / STEP) as i32;
        let band = |y: f32| libm::roundf(y / 2.0) as i32;
        for wp in nav.points() {
            for ix in grid(wp.x) - reach..=grid(wp.x) + reach {
                for iz in grid(wp.z) - reach..=grid(wp.z) + reach {
                    let (x, z) = (ix as f32 * STEP, iz as f32 * STEP);
                    if (x - wp.x).hypot(z - wp.z) > SPOT_REACH || !tried.insert((ix, iz, band(wp.y))) {
                        continue;
                    }
                    if let Some(floor) = floor_at(arena, t, Vector::new(x, wp.y, z)).filter(|&f| stands(arena, medium, f)) {
                        room.insert((ix, iz, band(floor.y)), floor);
                    }
                }
            }
        }
        // Walked out from each waypoint's own grid point, a step at a time.
        let mut from: HashMap<(i32, i32, i32), u16> = HashMap::new();
        let mut queue = std::collections::VecDeque::new();
        for (w, wp) in nav.points().iter().enumerate() {
            let key = (grid(wp.x), grid(wp.z), band(wp.y));
            if room.get(&key).is_some_and(|&f| walk(arena, medium, *wp, f)) && from.insert(key, w as u16).is_none() {
                queue.push_back(key);
            }
        }
        while let Some(key @ (ix, iz, b)) = queue.pop_front() {
            let (here, w) = (room[&key], from[&key]);
            for (dx, dz, db) in (-1..=1).flat_map(|dx| (-1..=1).flat_map(move |dz| (-1..=1).map(move |db| (dx, dz, db)))) {
                let next = (ix + dx, iz + dz, b + db);
                if (dx, dz) == (0, 0) || from.contains_key(&next) {
                    continue;
                }
                if let Some(&there) = room.get(&next)
                    && (there.y - here.y).abs() <= LEDGE
                    && walk(arena, medium, here, there)
                {
                    from.insert(next, w);
                    queue.push_back(next);
                }
            }
        }
        let mut reached: Vec<_> = from.into_iter().collect();
        reached.sort_unstable();
        let mut spots: Vec<Spot> = Vec::new();
        for ((ix, iz, b), w) in reached {
            let floor = room[&(ix, iz, b)];
            let (mut cover, mut over) = ([0u16; 3], [0u16; 3]);
            for (c, ct) in classes.iter().enumerate() {
                (cover[c], over[c]) = cover_bits(arena, ct, floor);
            }
            // In the open, only every third grid point along each axis.
            if cover.iter().all(|&b| b == 0) && (ix.rem_euclid(OPEN_EVERY) != 0 || iz.rem_euclid(OPEN_EVERY) != 0) {
                continue;
            }
            spots.push(Spot { pos: floor, waypoint: w, cover, over });
        }
        let mut cells: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, s) in spots.iter().enumerate() {
            cells.entry(cell(s.pos)).or_default().push(i as u32);
        }
        let mut found = Spots { spots, cells, steps: Vec::new() };
        let steps = (0..found.spots.len())
            .map(|i| {
                let p = found.spots[i].pos;
                found.near(p, PEEK_STEP).filter(|&j| j != i && (found.spots[j].pos.y - p.y).abs() < 1.0 && walk(arena, medium, p, found.spots[j].pos)).map(|j| j as u32).collect()
            })
            .collect();
        found.steps = steps;
        found
    }

    /// Spots within `radius` of `p` (flat).
    pub fn near(&self, p: Vector, radius: f32) -> impl Iterator<Item = usize> + '_ {
        let (cx, cz) = cell(p);
        let r = libm::ceilf(radius / STEP) as i32;
        (cx - r..=cx + r)
            .flat_map(move |x| (cz - r..=cz + r).map(move |z| (x, z)))
            .filter_map(|k| self.cells.get(&k))
            .flatten()
            .map(|&i| i as usize)
            .filter(move |&i| {
                let d = self.spots[i].pos - p;
                d.x.hypot(d.z) <= radius
            })
    }

    /// From spot `i` (hidden from the threat, say), the nearest step out (`steps`) where a mech
    /// of `t` sees `chest`: a peek.
    pub fn peek(&self, arena: &Arena, t: &Tuning, i: usize, chest: Vector) -> Option<usize> {
        let p = self.spots[i].pos;
        self.steps[i].iter().map(|&j| j as usize).filter(|&j| sees_from(arena, t, self.spots[j].pos, chest)).min_by(|&a, &b| {
            self.spots[a].pos.distance(p).total_cmp(&self.spots[b].pos.distance(p))
        })
    }
}

/// The floor a mech could stand on at `p`'s x and z, within FLOOR_RISE of its height, walkable.
fn floor_at(arena: &Arena, t: &Tuning, p: Vector) -> Option<Vector> {
    let from = p + Vector::Y * FLOOR_RISE;
    let (toi, normal) = arena.cast_ray_normal(&Ray::new(from, -Vector::Y), 2.0 * FLOOR_RISE)?;
    (normal.y >= libm::cosf(t.max_slope_deg.to_radians())).then(|| from - Vector::Y * toi)
}

/// Room for a mech of `t` to stand at `feet`: nothing overhead, nothing within its radius around
/// its knees or its middle.
fn stands(arena: &Arena, t: &Tuning, feet: Vector) -> bool {
    let low = feet + Vector::Y * 0.3;
    if arena.cast_ray(&Ray::new(low, Vector::Y), t.mech_height).is_some() {
        return false;
    }
    let room = t.mech_radius + 0.1;
    [1.0, t.mech_height * 0.5].iter().all(|&h| (0..8).all(|k| arena.cast_ray(&Ray::new(feet + Vector::Y * h, dir(2 * k)), room).is_none()))
}

/// A straight walk from `from` to `to` (feet): nothing in the way at the knees, and ground under
/// it all the way, never a ledge's drop below the line.
pub(crate) fn walk(arena: &Arena, t: &Tuning, from: Vector, to: Vector) -> bool {
    let knee = Vector::Y * 1.0;
    if !clear(arena, from + knee, to + knee) {
        return false;
    }
    let steps = (from.distance(to) / 2.0).ceil().max(1.0) as usize;
    (1..steps).all(|k| {
        let p = from.lerp(to, k as f32 / steps as f32);
        floor_at(arena, t, p).is_some_and(|f| (f.y - p.y).abs() <= LEDGE)
    })
}

/// A spot's cover for a mech of `t` standing at `feet`, in each direction: hidden at the middle
/// within COVER_REACH, and seeing over it at the eye.
fn cover_bits(arena: &Arena, t: &Tuning, feet: Vector) -> (u16, u16) {
    let (mid, eye, reach) = (feet + Vector::Y * (t.mech_height * 0.5), feet + Vector::Y * t.eye_height, t.mech_radius + COVER_REACH);
    let (mut cover, mut over) = (0, 0);
    for k in 0..DIRS {
        if arena.cast_ray(&Ray::new(mid, dir(k)), reach).is_some() {
            cover |= 1 << k;
            if arena.cast_ray(&Ray::new(eye, dir(k)), reach + 2.0).is_none() {
                over |= 1 << k;
            }
        }
    }
    (cover, over)
}

/// An enemy as a bot weighs where to fight it from.
pub struct Foe<'a> {
    /// Its feet, eye and middle.
    pub pos: Vector,
    pub eye: Vector,
    pub chest: Vector,
    /// Its damage a second on the bot, and the bot's on it, by range; its hull, full.
    pub on_me: &'a Curve,
    pub mine: &'a Curve,
    pub hull: f32,
}

/// Where a bot fights from: a spot, and the step out of it to fire from if it hides there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Post {
    pub spot: usize,
    pub peek: Option<usize>,
    /// What it's worth (`choose`).
    pub score: f32,
}

/// How a bot weighs where to fight from (`Policy`'s post_ numbers).
#[derive(Clone, Copy, Debug)]
pub struct Weighing {
    /// A share of its own hull lost, against a share of the target's dealt.
    pub take: f32,
    /// How far ahead it looks (s): a spot's worth is what it deals and takes there over this
    /// long, less the walk there.
    pub horizon: f32,
    /// Share of its damage it deals on the move.
    pub moving: f32,
    /// What staying put is worth over moving to as good a spot.
    pub stay: f32,
    /// Farthest it looks for a spot.
    pub reach: f32,
}

/// Most spots weighed at a time, nearest first, covered or not.
const WEIGHED: usize = 48;
/// Of the best few, the first it can walk straight to is the one.
const WALKS: usize = 6;

/// The best post near `me` (feet) for a mech of `t` fighting `foes[target]`, the rest in sight
/// too: at each spot what it deals the target and takes from every foe that sees it, a second,
/// as shares of hull, over the horizon less the walk there. A spot hidden from the target that
/// it can step out of to fire (`peek`) is out only while firing (`duty`), hidden while it cools.
#[allow(clippy::too_many_arguments)]
pub fn choose(spots: &Spots, arena: &Arena, t: &Tuning, me: Vector, foes: &[Foe], target: usize, duty: f32, current: Option<usize>, w: &Weighing) -> Option<Post> {
    let foe = foes.get(target)?;
    let taken_at = |at: Vector| -> f32 { foes.iter().filter(|f| exposed(arena, t, at, f.eye)).map(|f| f.on_me.at(f.pos.distance(at))).sum::<f32>() / t.health_max };
    let dealt_at = |at: Vector| foe.mine.at(foe.pos.distance(at)) / foe.hull;
    let (here_dealt, here_taken) = (if sees_from(arena, t, me, foe.chest) { dealt_at(me) } else { 0.0 }, taken_at(me));
    // Nearest first; spots with cover from the target's side, and the current post, always.
    let mut near: Vec<usize> = spots.near(me, w.reach).filter(|&i| (spots.spots[i].pos.y - me.y).abs() < 4.0).collect();
    near.sort_by(|&a, &b| spots.spots[a].pos.distance(me).total_cmp(&spots.spots[b].pos.distance(me)));
    let class = class_of(t);
    let mut picked: Vec<usize> = near.iter().copied().filter(|&i| spots.spots[i].covered(class, foe.pos - spots.spots[i].pos)).take(WEIGHED / 2).collect();
    let open: Vec<usize> = near.iter().copied().filter(|i| !picked.contains(i)).take(WEIGHED - picked.len()).collect();
    picked.extend(open);
    if let Some(c) = current.filter(|c| !picked.contains(c)) {
        picked.push(c);
    }
    let mut scored: Vec<Post> = picked
        .into_iter()
        .map(|i| {
            let at = spots.spots[i].pos;
            let (peek, dealt, taken) = if sees_from(arena, t, at, foe.chest) {
                (None, dealt_at(at), taken_at(at))
            } else if let Some(p) = spots.peek(arena, t, i, foe.chest) {
                let out = spots.spots[p].pos;
                (Some(p), dealt_at(out), duty * taken_at(out) + (1.0 - duty) * taken_at(at))
            } else {
                (None, 0.0, taken_at(at))
            };
            let walk = at.distance(me) / t.walk_speed;
            let stay = if current == Some(i) { w.stay } else { 0.0 };
            let score = (dealt - w.take * taken) * (w.horizon - walk).max(0.0) + walk * (w.moving * here_dealt - w.take * here_taken) + stay;
            Post { spot: i, peek, score }
        })
        .collect();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    scored.into_iter().take(WALKS).find(|p| current == Some(p.spot) || walk(arena, t, me, spots.spots[p.spot].pos))
}

/// The class whose cover bits fit `t`'s size.
fn class_of(t: &Tuning) -> MechClass {
    if t.mech_height < 4.0 {
        MechClass::A
    } else if t.mech_height > 5.5 {
        MechClass::C
    } else {
        MechClass::B
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "probe"]
    /// SPOTS_DUMP=<dir> writes each map's spots there as JSON ([x, y, z, cover, over], Medium).
    fn spots_probe() {
        for (index, (name, _)) in MAPS.iter().enumerate() {
            let at = std::time::Instant::now();
            let map = Map::load(index);
            let spots = Spots::generate(&Arena::new(&map), Nav::for_map(index), &Tuning::default());
            let covered = spots.spots.iter().filter(|s| s.cover[1] != 0).count();
            let over = spots.spots.iter().filter(|s| s.over[1] != 0).count();
            let steps: usize = spots.steps.iter().map(Vec::len).sum();
            if let Ok(dir) = std::env::var("SPOTS_DUMP") {
                let rows: Vec<String> = spots.spots.iter().map(|s| format!("[{:.1},{:.1},{:.1},{},{}]", s.pos.x, s.pos.y, s.pos.z, s.cover[1], s.over[1])).collect();
                std::fs::write(format!("{dir}/{name}.json"), format!("[{}]", rows.join(","))).unwrap();
            }
            println!("{name:10} {:5} spots, {covered:5} covered, {over:4} with low cover, {:.1} steps each, {:.0} ms", spots.spots.len(), steps as f32 / spots.spots.len() as f32, at.elapsed().as_secs_f32() * 1e3);
        }
    }

    #[test]
    fn directions_round_trip() {
        for k in 0..DIRS {
            assert_eq!(dir_of(dir(k) * 7.0), k);
        }
        assert_eq!(dir_of(Vector::NEG_Z), 0);
        assert_eq!(dir_of(Vector::X), DIRS / 4);
    }

    #[test]
    fn spots_find_cover_and_peeks_on_the_test_map() {
        let index = Map::index("blockout").unwrap();
        let (map, t) = (Map::load(index), Tuning::default());
        let arena = Arena::new(&map);
        let spots = Spots::for_map(index);
        assert!(spots.spots.len() > 50, "only {} spots", spots.spots.len());
        // The 6 m block at (-5, -30): a spot on its north face is covered from the south, can't
        // see over it, and is hidden from an enemy 20 m south.
        let enemy = Vector::new(-5.0, 0.1, -70.0).clamp(Vector::splat(-49.0), Vector::splat(49.0));
        let eye = Vector::new(-5.0, t.eye_height + 0.1, -48.0);
        let north = spots.near(Vector::new(-5.0, 0.0, -26.5), 2.0).find(|&i| spots.spots[i].covered(MechClass::B, eye - spots.spots[i].pos));
        let i = north.expect("no covered spot north of the block");
        assert!(!spots.spots[i].over(MechClass::B, eye - spots.spots[i].pos), "saw over a 6 m block");
        assert!(!exposed(&arena, &t, spots.spots[i].pos, eye), "seen through the block");
        // A step out to its side sees that enemy's middle.
        let chest = enemy.with_y(0.1 + t.mech_height * 0.5);
        let peek = spots.peek(&arena, &t, i, chest).expect("no peek round the block");
        assert!(spots.spots[peek].pos.distance(spots.spots[i].pos) <= PEEK_STEP);
        // Out in the open, nothing covers.
        let open = spots.near(Vector::new(0.0, 0.0, 0.0), 6.0).find(|&i| spots.spots[i].cover[1] == 0);
        assert!(open.is_some(), "no open spot mid-map");
    }
}
