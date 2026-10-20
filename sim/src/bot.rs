//! Server-side bot brain. A bot only produces an `Input` each tick; `Game` applies it through
//! `step_mech` and the normal hitscan, so bots follow the same rules as players.

use std::collections::VecDeque;
use std::f32::consts::{PI, TAU};

use rapier3d::prelude::{Ray, Rotation};

use crate::{Arena, DT, Input, Mech, TICK_HZ, Tuning, Vector};

/// Hand-placed waypoints for the blockout arena (feet positions).
/// ponytail: one hand-made graph; generate edges by simulated walks, or use a navmesh, once
/// there's more than one map.
const NAV_NODES: &[[f32; 3]] = &[
    [-40.0, 0.0, 40.0], // 0 corners and edge midpoints
    [0.0, 0.0, 40.0],   // 1 spawn 0
    [40.0, 0.0, 40.0],  // 2
    [-40.0, 0.0, 0.0],  // 3
    [0.0, 0.0, 0.0],    // 4 center
    [40.0, 0.0, 0.0],   // 5
    [-40.0, 0.0, -40.0], // 6
    [0.0, 0.0, -40.0],  // 7 spawn 1
    [40.0, 0.0, -40.0], // 8
    [20.0, 0.0, 5.0],   // 9 ramp bottom
    [20.0, 5.0, -15.0], // 10 ramp top, on the platform
    [20.0, 5.0, -22.0], // 11 platform center
    [-15.0, 0.0, 16.0], // 12 north of cover (-15, 10)
    [-15.0, 0.0, 3.0],  // 13 south of cover (-15, 10)
    [-31.0, 0.0, -15.0], // 14 west of cover (-25, -15)
    [10.0, 0.0, 30.0],  // 15 north of cover (10, 22)
];

/// Walkable both ways; `nav_edges_are_walkable` checks every one.
const NAV_EDGES: &[(usize, usize)] = &[
    (0, 1), (1, 2), (0, 3), (3, 6), (2, 5), (5, 8), (6, 7), (7, 8),
    (1, 4), (4, 7), (3, 4), (4, 9), (9, 5), (9, 10), (10, 11),
    (1, 15), (15, 2), (12, 0), (12, 1), (13, 3), (13, 4), (14, 3), (14, 6),
];

/// Waypoint counts as reached within this horizontal distance.
const ARRIVE: f32 = 2.5;
/// Engagement range band: close in beyond FAR, back off inside NEAR.
const FAR: f32 = 45.0;
const NEAR: f32 = 20.0;
/// Fire only when aim is this close to where the bot wants it.
const AIM_TOLERANCE: f32 = 2.0 * PI / 180.0;

pub struct Bot {
    pub seq: u32,
    rng: u64,
    /// Remaining waypoints, next first, toward `path_goal`.
    path: Vec<usize>,
    path_goal: Option<usize>,
    /// Closest the bot has come to the next waypoint, and when it last got closer.
    best: f32,
    progress_at: u32,
    hover_until: u32,
    strafe: f32,
    strafe_until: u32,
    /// Slowly wandering aim error (yaw, pitch) in radians.
    wobble: (f32, f32),
    /// Target chest positions, oldest first, so aim lags by the reaction time.
    seen: VecDeque<Vector>,
    last_health: f32,
}

impl Bot {
    pub fn new(seed: u64) -> Self {
        Self {
            seq: 0,
            rng: seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1,
            path: Vec::new(),
            path_goal: None,
            best: f32::MAX,
            progress_at: 0,
            hover_until: 0,
            strafe: 1.0,
            strafe_until: 0,
            wobble: (0.0, 0.0),
            seen: VecDeque::new(),
            last_health: 0.0,
        }
    }

    /// xorshift64, uniform in [0, 1).
    fn rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 40) as f32 / (1u64 << 24) as f32
    }

    /// This tick's input for a bot driving `me` against `target`.
    pub fn think(&mut self, arena: &Arena, t: &Tuning, me: &Mech, target: Option<&Mech>, tick: u32) -> Input {
        let idle = Input { yaw: me.yaw, pitch: me.pitch, ..Input::default() };
        let took_damage = me.health < self.last_health;
        self.last_health = me.health;
        let Some(target) = target.filter(|m| m.health > 0.0) else {
            self.seen.clear();
            return idle;
        };
        if me.health <= 0.0 {
            return idle;
        }

        self.seen.push_back(target.pos + Vector::Y * (t.mech_height * 0.5));
        let reaction_ticks = (t.bot_reaction_s * TICK_HZ).round() as usize;
        while self.seen.len() > reaction_ticks + 1 {
            self.seen.pop_front();
        }
        let max_turn = t.bot_turn_rate_deg.to_radians() * DT;
        let range = flat(target.pos - me.pos).length();

        if sees(arena, t, me, target) {
            self.path_goal = None;
            let err = t.bot_aim_error_deg.to_radians();
            self.wobble.0 = (self.wobble.0 + (self.rand() - 0.5) * err * 0.3).clamp(-err, err);
            self.wobble.1 = (self.wobble.1 + (self.rand() - 0.5) * err * 0.3).clamp(-err, err);
            let (yaw, pitch) = look_at(me.pos + Vector::Y * t.eye_height, self.seen[0]);
            let (want_yaw, want_pitch) = (yaw + self.wobble.0, pitch + self.wobble.1);
            let new_yaw = me.yaw + wrap(want_yaw - me.yaw).clamp(-max_turn, max_turn);
            let new_pitch = me.pitch + (want_pitch - me.pitch).clamp(-max_turn, max_turn);
            let on_target = wrap(want_yaw - new_yaw).abs() < AIM_TOLERANCE && (want_pitch - new_pitch).abs() < AIM_TOLERANCE;

            if tick >= self.strafe_until {
                self.strafe = if self.rand() < 0.5 { -1.0 } else { 1.0 };
                self.strafe_until = tick + secs(0.8 + 1.2 * self.rand());
            }
            let dodge = took_damage && me.dodge_cooldown <= 0.0 && self.rand() < 0.3;
            return Input {
                move_x: self.strafe,
                move_z: if range > FAR { 1.0 } else if range < NEAR { -1.0 } else { 0.0 },
                yaw: new_yaw,
                pitch: new_pitch,
                dodge: if dodge { self.strafe as i8 } else { 0 },
                // Stay under the overheat lockout rather than spraying into it.
                fire: on_target && !me.overheated && me.heat < 0.85 * t.heat_max,
                ..Input::default()
            };
        }

        // No line of sight: walk the waypoint graph toward the target.
        let goal = nearest_node(target.pos);
        if self.path_goal != Some(goal) {
            self.path = path(nearest_node(me.pos), goal);
            // Already past the first waypoint toward the second? Skip it rather than walk back.
            if let [a, b, ..] = self.path[..]
                && me.pos.distance(node(b)) < node(a).distance(node(b))
            {
                self.path.remove(0);
            }
            self.path_goal = Some(goal);
            self.best = f32::MAX;
            self.progress_at = tick;
        }
        while let Some(&n) = self.path.first()
            && flat(node(n) - me.pos).length() < ARRIVE
        {
            self.path.remove(0);
            self.best = f32::MAX;
            self.progress_at = tick;
        }
        let toward = flat(self.path.first().map_or(target.pos, |&n| node(n)) - me.pos);
        // Stuck on something for 1.5 s: hover over it and skip the waypoint.
        if toward.length() < self.best - 0.5 {
            self.best = toward.length();
            self.progress_at = tick;
        } else if tick - self.progress_at > secs(1.5) {
            self.hover_until = tick + secs(1.0);
            if !self.path.is_empty() {
                self.path.remove(0);
            }
            self.best = f32::MAX;
            self.progress_at = tick;
        }

        let dir = toward.normalize_or_zero();
        let want_yaw = (-dir.x).atan2(-dir.z);
        let new_yaw = me.yaw + wrap(want_yaw - me.yaw).clamp(-max_turn, max_turn);
        let rot = Rotation::from_rotation_y(new_yaw);
        Input {
            move_x: dir.dot(rot * Vector::X),
            move_z: dir.dot(rot * Vector::NEG_Z),
            yaw: new_yaw,
            pitch: me.pitch * 0.9,
            boost: range > FAR && me.fuel > 0.5 * t.fuel_max,
            hover: tick < self.hover_until,
            ..Input::default()
        }
    }
}

/// Clear line from `me`'s eye to `target`'s chest, within weapon range.
pub fn sees(arena: &Arena, t: &Tuning, me: &Mech, target: &Mech) -> bool {
    let eye = me.pos + Vector::Y * t.eye_height;
    let d = target.pos + Vector::Y * (t.mech_height * 0.5) - eye;
    let len = d.length();
    len <= t.weapon_range && arena.cast_ray(&Ray::new(eye, d / len), len).is_none()
}

fn node(i: usize) -> Vector {
    Vector::from_array(NAV_NODES[i])
}

fn nearest_node(p: Vector) -> usize {
    (0..NAV_NODES.len()).min_by(|&a, &b| node(a).distance(p).total_cmp(&node(b).distance(p))).unwrap()
}

/// Shortest waypoint route from `from` to `to`, both included (Dijkstra; the graph is tiny).
fn path(from: usize, to: usize) -> Vec<usize> {
    let n = NAV_NODES.len();
    let (mut dist, mut prev, mut done) = (vec![f32::MAX; n], vec![usize::MAX; n], vec![false; n]);
    dist[from] = 0.0;
    while let Some(u) = (0..n).filter(|&i| !done[i] && dist[i] < f32::MAX).min_by(|&a, &b| dist[a].total_cmp(&dist[b])) {
        done[u] = true;
        for &(a, b) in NAV_EDGES {
            let v = if a == u { b } else if b == u { a } else { continue };
            let d = dist[u] + node(u).distance(node(v));
            if d < dist[v] {
                dist[v] = d;
                prev[v] = u;
            }
        }
    }
    let mut route = vec![to];
    while let Some(&last) = route.last()
        && prev[last] != usize::MAX
    {
        route.push(prev[last]);
    }
    route.reverse();
    route
}

fn flat(v: Vector) -> Vector {
    Vector::new(v.x, 0.0, v.z)
}

/// Yaw and pitch that point from `from` at `to`, matching `aim_ray`.
fn look_at(from: Vector, to: Vector) -> (f32, f32) {
    let d = to - from;
    ((-d.x).atan2(-d.z), d.y.atan2(d.x.hypot(d.z)))
}

fn wrap(angle: f32) -> f32 {
    (angle + PI).rem_euclid(TAU) - PI
}

fn secs(s: f32) -> u32 {
    (s * TICK_HZ).round() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{spawn_mech, step_mech};

    #[test]
    fn nav_edges_are_walkable() {
        let arena = Arena::default();
        for class in crate::MechClass::ALL {
            let t = Tuning::default().for_class(class);
            walk_every_edge(&arena, &t, class);
        }
    }

    fn walk_every_edge(arena: &Arena, t: &Tuning, class: crate::MechClass) {
        for &(a, b) in NAV_EDGES {
            for (from, to) in [(a, b), (b, a)] {
                let mut m = spawn_mech(t, node(from) + Vector::Y * 0.1);
                let goal = node(to);
                let ticks = ((goal.distance(m.pos) / t.walk_speed + 2.0) * TICK_HZ) as usize;
                let arrived = (0..ticks).any(|_| {
                    let d = goal - m.pos;
                    if flat(d).length() < ARRIVE && d.y.abs() < 1.0 {
                        return true;
                    }
                    let yaw = (-d.x).atan2(-d.z);
                    step_mech(arena, t, &mut m, &Input { move_z: 1.0, yaw, ..Input::default() });
                    false
                });
                assert!(arrived, "{class:?}: edge {from} -> {to} isn't walkable: stopped at {}", m.pos);
            }
        }
    }

    #[test]
    fn bot_paths_to_hidden_target() {
        let (arena, t) = (Arena::default(), Tuning::default());
        let mut me = spawn_mech(&t, node(1) + Vector::Y * 0.1);
        // Tucked behind the tall cover at (-5, -30), out of sight of the north spawn.
        let target = spawn_mech(&t, Vector::new(-5.0, 0.1, -36.0));
        assert!(!sees(&arena, &t, &me, &target), "target should start hidden");
        let mut bot = Bot::new(1);
        for tick in 0..secs(20.0) {
            if sees(&arena, &t, &me, &target) {
                return;
            }
            let input = bot.think(&arena, &t, &me, Some(&target), tick);
            step_mech(&arena, &t, &mut me, &input);
        }
        panic!("bot never got line of sight; ended at {}", me.pos);
    }
}
