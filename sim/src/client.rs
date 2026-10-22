//! Client netcode: predicts the local mech with `step_mech`, reconciles against server
//! snapshots, and interpolates remote mechs. Pure logic; the page moves the bytes.

use std::collections::{HashMap, VecDeque};

use crate::net::{self, ClientMsg, Event, InputMsg, MatchState, Orb, PlayerNet, ServerMsg, Snapshot};
use crate::projectile::{self, Id, Projectile};
use crate::{Arena, Arsenal, DT, Input, Loadout, Map, Mech, MechClass, Tuning, Vector, collide, map, step_mech, weapon};

/// Remote mechs are drawn this many ticks behind the newest snapshot, to ride out jitter.
pub const INTERP_TICKS: f32 = 3.0;
const SNAPSHOT_BUFFER: usize = 30;
/// Own bursts remembered so the server's Blast for them doesn't explode twice.
const BURSTS_KEPT: usize = 32;
/// A server Blast this far from where an own projectile burst locally gets its own explosion.
const BURST_MISMATCH: f32 = 2.0;

/// Someone else's projectile, replayed from its Launch on the render timeline.
struct Replay {
    /// Server tick it launched (and flew its first tick) on.
    launched: u32,
    p: Projectile,
    /// Ticks flown so far; the state is as of tick `launched - 1 + flown`.
    flown: u32,
    /// Burst against the arena locally; hidden until the server's Blast arrives in render time.
    done: bool,
}

/// A projectile to draw this frame.
pub struct Drawn {
    pub p: Projectile,
    /// Own projectiles are at the predicted tick, so the page extrapolates them like the own mech.
    pub predicted: bool,
}

pub struct NetClient {
    /// Compiled-in tuning per class and loadout, the same as the server's: prediction needs
    /// identical values.
    arsenal: Arsenal,
    /// Own class and weapons as the server last reported them.
    pub class: MechClass,
    pub loadout: Loadout,
    arena: Arena,
    /// Map the server runs, from the Welcome; None before it.
    pub map: Option<usize>,
    pub id: Option<u8>,
    pub full: bool,
    /// Predicted local mech.
    pub mech: Mech,
    pub kills: u16,
    pub deaths: u16,
    pub team: u8,
    pub state: MatchState,
    /// Last reconciliation's change to the predicted position. Zero when prediction is exact.
    pub correction: f32,
    /// Drawn on top of the predicted position so a correction slides in instead of snapping;
    /// decays each tick.
    pub render_offset: Vector,
    /// Other mechs and their teams at their latest server positions, treated as fixed when
    /// predicting contact.
    obstacles: Vec<(u8, Mech)>,
    /// Own projectiles (secondary and projectile primary fire), predicted from launch.
    pub projectiles: Vec<Projectile>,
    /// Where own hitscan pellets stopped against the arena, since the page last took them.
    pub shots: Vec<Vector>,
    /// Own projectiles that burst locally, and where.
    burst: VecDeque<(Id, Vector)>,
    replays: Vec<Replay>,
    /// Blasts of others' projectiles (tick, id, radius, where), held until render time reaches
    /// their tick.
    held: Vec<(u32, Id, f32, Vector)>,
    /// Explosions to show (owner, blast radius, where) and splash hits (attacker, victim) since
    /// the page last took them.
    pub blasts: Vec<(u8, f32, Vector)>,
    pub hits: Vec<(u8, u8)>,
    /// Callsigns by player id, from the server's latest Roster.
    pub names: HashMap<u8, String>,
    pub ping_ms: f64,
    /// Server events not yet taken by the page.
    pub events: Vec<Event>,
    seq: u32,
    /// Inputs the server hasn't acked yet: (seq, input, sent at ms).
    pending: VecDeque<(u32, Input, f64)>,
    snapshots: VecDeque<Snapshot>,
    /// Server time minus local time in ms, as seen by snapshot arrivals.
    clock_offset: Option<f64>,
    synced: bool,
}

impl Default for NetClient {
    fn default() -> Self {
        Self {
            arsenal: Arsenal::new(&Tuning::default()),
            class: MechClass::B,
            loadout: Loadout::of(MechClass::B),
            arena: Arena::new(&Map::load(map::DEFAULT)),
            map: None,
            id: None,
            full: false,
            mech: Mech::default(),
            kills: 0,
            deaths: 0,
            team: 0,
            state: MatchState::default(),
            correction: 0.0,
            render_offset: Vector::ZERO,
            obstacles: Vec::new(),
            projectiles: Vec::new(),
            shots: Vec::new(),
            burst: VecDeque::new(),
            replays: Vec::new(),
            held: Vec::new(),
            blasts: Vec::new(),
            hits: Vec::new(),
            names: HashMap::new(),
            ping_ms: 0.0,
            events: Vec::new(),
            seq: 0,
            pending: VecDeque::new(),
            snapshots: VecDeque::new(),
            clock_offset: None,
            synced: false,
        }
    }
}

impl NetClient {
    /// Predicts one tick and returns the message to send. Until the first snapshot the mech
    /// is a dead default, so prediction is a no-op and the server's state takes over.
    pub fn tick(&mut self, input: Input, now_ms: f64) -> Vec<u8> {
        self.seq += 1;
        self.predict(&input);
        // Only the first prediction of an input fires; reconciliation replays never do.
        let (t, m) = (self.arsenal.of(&self.mech), &self.mech);
        if let (true, Some(id)) = (m.launched, self.id) {
            self.projectiles.extend(projectile::volley(t, m, id, self.seq));
        }
        if let (true, Some(id)) = (m.shot, self.id) {
            if t.shot_speed > 0.0 {
                self.projectiles.extend(weapon::volley(t, m, id, self.seq));
            } else {
                let arena = &self.arena;
                self.shots.extend(weapon::pellets(t, m, self.seq).iter().map(|r| r.point_at(arena.cast_ray(r, t.weapon_range).unwrap_or(t.weapon_range))));
            }
        }
        if let (true, Some(id)) = (self.mech.threw, self.id) {
            self.projectiles.push(projectile::grenade(self.arsenal.of(&self.mech), &self.mech, id, self.seq));
        }
        if let (true, Some(id)) = (self.mech.alt_pressed, self.id) {
            projectile::detonate(id, &mut self.projectiles);
        }
        self.fly_own();
        self.render_offset *= 0.7;
        self.pending.push_back((self.seq, input, now_ms));
        net::encode(&ClientMsg::Input(InputMsg { seq: self.seq, input, view_tick: self.render_tick(now_ms) }))
    }

    /// One predicted step: move, then get blocked by other mechs where we last saw them.
    fn predict(&mut self, input: &Input) {
        let t = self.arsenal.of(&self.mech);
        step_mech(&self.arena, t, &mut self.mech, input);
        for (_, other) in &self.obstacles {
            let mut other = *other;
            collide::separate(&self.arena, t, &mut self.mech, self.arsenal.of(&other), &mut other, 1.0);
        }
    }

    /// Flies own projectiles one tick against the arena and enemies where they were last seen.
    fn fly_own(&mut self) {
        let (arsenal, arena, obstacles, team) = (&self.arsenal, &self.arena, &self.obstacles, self.team);
        let (burst, blasts) = (&mut self.burst, &mut self.blasts);
        self.projectiles.retain_mut(|p| {
            let enemies = || obstacles.iter().filter(|(t, m)| *t != team && m.health > 0.0).map(|(_, m)| (arsenal.of(m), m));
            let t = projectile::tuning_for(arsenal.get(p.class, p.loadout), p);
            let Some(at) = projectile::fly(arena, &t, p, |ray, max| projectile::first_mech(ray, max, enemies())) else {
                return true;
            };
            blasts.push((p.owner, projectile::radius(arsenal.get(p.class, p.loadout), p), at));
            burst.push_back((p.id(), at));
            if burst.len() > BURSTS_KEPT {
                burst.pop_front();
            }
            false
        });
    }

    /// Message setting our callsign to `raw`; the server sanitizes it.
    pub fn name_msg(&self, raw: &str) -> Vec<u8> {
        net::encode(&ClientMsg::Name(raw.into()))
    }

    /// Everyone (us included) as of the newest snapshot, for the scoreboard.
    pub fn board(&self) -> Vec<PlayerNet> {
        self.snapshots.back().map_or_else(Vec::new, |s| s.players.clone())
    }

    /// Health orbs as of the latest snapshot (they don't move, so no interpolation).
    pub fn orbs(&self) -> Vec<Orb> {
        self.snapshots.back().map_or_else(Vec::new, |s| s.orbs.clone())
    }

    /// Message asking for `class` carrying `loadout` at the next spawn (or now, before the first input).
    pub fn pick(&self, class: MechClass, loadout: Loadout) -> Vec<u8> {
        net::encode(&ClientMsg::Pick(class, loadout))
    }

    pub fn receive(&mut self, bytes: &[u8], now_ms: f64) {
        match net::decode::<ServerMsg>(bytes) {
            Some(ServerMsg::Welcome { id, map }) => {
                self.load_map(map);
                self.id = Some(id);
            }
            Some(ServerMsg::Full) => self.full = true,
            Some(ServerMsg::Roster(roster)) => self.names = roster.into_iter().collect(),
            Some(ServerMsg::Snapshot(s)) => self.apply(s, now_ms),
            None => {}
        }
    }

    /// The server's map `index`, if it isn't the one loaded already.
    fn load_map(&mut self, index: u8) {
        let map = usize::from(index).min(map::MAPS.len() - 1);
        if self.map != Some(map) && (self.map.is_some() || map != map::DEFAULT) {
            self.arena = Arena::new(&Map::load(map));
            self.projectiles.clear();
        }
        self.map = Some(map);
    }

    fn apply(&mut self, s: Snapshot, now_ms: f64) {
        // A new match may be on a new map.
        self.load_map(s.state.map);
        // Smooth arrival jitter; snap when far off (first snapshot, or after a stalled tab).
        let sample = f64::from(s.tick) * f64::from(DT) * 1000.0 - now_ms;
        self.clock_offset = Some(match self.clock_offset {
            Some(o) if (sample - o).abs() < 250.0 => o + (sample - o) * 0.05,
            _ => sample,
        });

        if let Some(me) = self.id.and_then(|id| s.players.iter().find(|p| p.id == id)) {
            if let Some(&(_, _, sent)) = self.pending.iter().find(|p| p.0 == s.ack_seq) {
                let rtt = now_ms - sent;
                self.ping_ms = if self.ping_ms == 0.0 { rtt } else { self.ping_ms + (rtt - self.ping_ms) * 0.1 };
            }
            while self.pending.front().is_some_and(|p| p.0 <= s.ack_seq) {
                self.pending.pop_front();
            }
            let own = me.id;
            self.obstacles = s
                .players
                .iter()
                .filter(|p| p.id != own)
                // Repairing ones crouch (`hit_shape`); any repair time will do.
                .map(|p| (p.team, Mech { class: p.class, loadout: p.loadout, pos: p.view.pos, health: p.view.health, repair_time: if p.view.repairing { DT } else { 0.0 }, ..Mech::default() }))
                .collect();
            // Reconcile: take the server's state at ack_seq and replay what it hasn't seen yet.
            let predicted = self.mech.pos;
            self.mech = s.me;
            (self.class, self.loadout) = (me.class, me.loadout);
            for (_, input, _) in self.pending.clone() {
                self.predict(&input);
            }
            let jump = predicted - self.mech.pos;
            self.correction = if self.synced { jump.length() } else { 0.0 };
            // Smooth small corrections (bumps); jump straight across teleports like respawns.
            self.render_offset = if self.synced && jump.length() < 3.0 { self.render_offset + jump } else { Vector::ZERO };
            self.synced = true;
            self.kills = me.kills;
            self.deaths = me.deaths;
            self.team = me.team;
        }
        self.state = s.state;

        for e in &s.events {
            match *e {
                Event::Launch(p) if Some(p.owner) != self.id => self.replays.push(Replay { launched: s.tick, p, flown: 0, done: false }),
                Event::Launch(_) => {}
                Event::Blast { owner, seq, n, primary, class, loadout, charge, pos, hits } => {
                    let id = (owner, seq, n, primary);
                    let shape = Projectile { owner, seq, n, primary, class, loadout, charge, pos, vel: Vector::ZERO, age: 0.0 };
                    let radius = projectile::radius(self.arsenal.get(class, loadout), &shape);
                    self.hits.extend((0..16).filter(|v| hits & 1 << v != 0).map(|v| (owner, v)));
                    if Some(owner) != self.id {
                        self.held.push((s.tick, id, radius, pos));
                    } else if let Some(&(_, local)) = self.burst.iter().find(|b| b.0 == id) {
                        // Already exploded where we predicted; only a real miss gets a second one.
                        if local.distance(pos) > BURST_MISMATCH {
                            self.blasts.push((owner, radius, pos));
                        }
                    } else {
                        // It met a mech we didn't predict: end it where the server says.
                        self.projectiles.retain(|p| p.id() != id);
                        self.blasts.push((owner, radius, pos));
                    }
                }
                Event::Shot { .. } | Event::Kill { .. } | Event::Pulse { .. } => self.events.push(*e),
            }
        }
        self.snapshots.push_back(s);
        if self.snapshots.len() > SNAPSHOT_BUFFER {
            self.snapshots.pop_front();
        }
    }

    pub fn arena(&self) -> &Arena {
        &self.arena
    }

    /// Fractional server tick remote mechs are drawn at; also sent as each input's `view_tick`.
    pub fn render_tick(&self, now_ms: f64) -> f32 {
        self.clock_offset.map_or(0.0, |o| ((now_ms + o) / 1000.0 / f64::from(DT)) as f32 - INTERP_TICKS)
    }

    /// Projectiles to draw now: own ones as predicted, everyone else's replayed at `render_tick`.
    /// Also releases held Blasts whose tick render time has reached.
    pub fn projectiles(&mut self, now_ms: f64) -> Vec<Drawn> {
        let at = self.render_tick(now_ms);
        let (blasts, replays) = (&mut self.blasts, &mut self.replays);
        self.held.retain(|&(tick, id, radius, pos)| {
            if tick as f32 > at {
                return true;
            }
            blasts.push((id.0, radius, pos));
            replays.retain(|r| r.p.id() != id);
            false
        });
        let mut drawn: Vec<Drawn> = self.projectiles.iter().map(|&p| Drawn { p, predicted: true }).collect();
        for r in &mut self.replays {
            let t = projectile::tuning_for(self.arsenal.get(r.p.class, r.p.loadout), &r.p);
            // State after `flown` ticks is as of tick `launched - 1 + flown`.
            let due = (at - r.launched as f32 + 1.0).floor().max(0.0) as u32;
            while r.flown < due && !r.done {
                r.done = projectile::fly(&self.arena, &t, &mut r.p, |_, _| None).is_some();
                r.flown += 1;
            }
            if r.flown > 0 && !r.done {
                let f = at - (r.launched as f32 - 1.0 + r.flown as f32);
                let mut p = r.p;
                p.pos += p.vel * (f.clamp(0.0, 1.0) * DT);
                drawn.push(Drawn { p, predicted: false });
            }
        }
        // A replay whose Blast never comes (it can't over TCP, but be safe) goes after a while.
        self.replays.retain(|r| r.flown < 30 * 30);
        drawn
    }

    /// Other players interpolated at `render_tick`, holding the newest snapshot when nothing is newer.
    pub fn remotes(&self, now_ms: f64) -> Vec<PlayerNet> {
        let at = self.render_tick(now_ms);
        let Some(newest) = self.snapshots.back() else { return Vec::new() };
        let (a, b, f) = match self.snapshots.iter().position(|s| s.tick as f32 > at) {
            None => (newest, newest, 0.0),
            Some(0) => (&self.snapshots[0], &self.snapshots[0], 0.0),
            Some(i) => {
                let (a, b) = (&self.snapshots[i - 1], &self.snapshots[i]);
                (a, b, (at - a.tick as f32) / (b.tick - a.tick) as f32)
            }
        };
        b.players
            .iter()
            .filter(|p| Some(p.id) != self.id)
            .map(|pb| {
                let Some(pa) = a.players.iter().find(|p| p.id == pb.id) else { return *pb };
                // Don't slide a mech across a death or respawn teleport.
                if pa.view.health <= 0.0 || pb.view.health <= 0.0 {
                    return if f < 0.5 { *pa } else { *pb };
                }
                let (va, mut p) = (pa.view, *pb);
                p.view.pos = va.pos.lerp(pb.view.pos, f);
                p.view.yaw = va.yaw + (pb.view.yaw - va.yaw) * f;
                p.view.pitch = va.pitch + (pb.view.pitch - va.pitch) * f;
                p
            })
            .collect()
    }
}
