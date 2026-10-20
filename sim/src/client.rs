//! Client netcode: predicts the local mech with `step_mech`, reconciles against server
//! snapshots, and interpolates remote mechs. Pure logic; the page moves the bytes.

use std::collections::VecDeque;

use crate::net::{self, ClientMsg, Event, InputMsg, MatchState, PlayerNet, ServerMsg, Snapshot};
use crate::{Arena, DT, Input, Mech, MechClass, Tuning, step_mech};

/// Remote mechs are drawn this many ticks behind the newest snapshot, to ride out jitter.
pub const INTERP_TICKS: f32 = 3.0;
const SNAPSHOT_BUFFER: usize = 30;

pub struct NetClient {
    /// Compiled-in tuning.json per class, the same as the server's: prediction needs identical values.
    classes: [Tuning; 3],
    /// Own class as the server last reported it; prediction uses its tuning.
    pub class: MechClass,
    arena: Arena,
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
            classes: MechClass::ALL.map(|c| Tuning::default().for_class(c)),
            class: MechClass::B,
            arena: Arena::default(),
            id: None,
            full: false,
            mech: Mech::default(),
            kills: 0,
            deaths: 0,
            team: 0,
            state: MatchState::default(),
            correction: 0.0,
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
        step_mech(&self.arena, &self.classes[self.class.index()], &mut self.mech, &input);
        self.pending.push_back((self.seq, input, now_ms));
        net::encode(&ClientMsg::Input(InputMsg { seq: self.seq, input, view_tick: self.render_tick(now_ms) }))
    }

    /// Message asking for `class` at the next spawn (or now, before the first input).
    pub fn pick_class(&self, class: MechClass) -> Vec<u8> {
        net::encode(&ClientMsg::Class(class))
    }

    pub fn receive(&mut self, bytes: &[u8], now_ms: f64) {
        match net::decode::<ServerMsg>(bytes) {
            Some(ServerMsg::Welcome { id }) => self.id = Some(id),
            Some(ServerMsg::Full) => self.full = true,
            Some(ServerMsg::Snapshot(s)) => self.apply(s, now_ms),
            None => {}
        }
    }

    fn apply(&mut self, s: Snapshot, now_ms: f64) {
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
            // Reconcile: take the server's state at ack_seq and replay what it hasn't seen yet.
            let predicted = self.mech.pos;
            self.mech = s.me;
            self.class = me.class;
            for (_, input, _) in &self.pending {
                step_mech(&self.arena, &self.classes[self.class.index()], &mut self.mech, input);
            }
            self.correction = if self.synced { (self.mech.pos - predicted).length() } else { 0.0 };
            self.synced = true;
            self.kills = me.kills;
            self.deaths = me.deaths;
            self.team = me.team;
        }
        self.state = s.state;

        self.events.extend_from_slice(&s.events);
        self.snapshots.push_back(s);
        if self.snapshots.len() > SNAPSHOT_BUFFER {
            self.snapshots.pop_front();
        }
    }

    /// Fractional server tick remote mechs are drawn at; also sent as each input's `view_tick`.
    pub fn render_tick(&self, now_ms: f64) -> f32 {
        self.clock_offset.map_or(0.0, |o| ((now_ms + o) / 1000.0 / f64::from(DT)) as f32 - INTERP_TICKS)
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
