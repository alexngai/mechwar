//! Wire protocol: postcard in WebSocket binary frames. Both ends link this crate, so the
//! format can't drift between client and server.

use crate::{Input, Mech, MechClass, Vector};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum ClientMsg {
    Input(InputMsg),
    /// Mech class for the next spawn (or right away, before the player's first input).
    Class(MechClass),
}

/// One per client tick. `view_tick` is the fractional server tick the client was rendering
/// remote mechs at when it sampled this input; the server rewinds targets to it for hits.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct InputMsg {
    pub seq: u32,
    pub input: Input,
    pub view_tick: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ServerMsg {
    /// `map` indexes `map::MAPS`; the client builds its arena from it.
    Welcome { id: u8, map: u8 },
    Full,
    Snapshot(Snapshot),
}

/// Sent every server tick. `ack_seq` is the last input the server applied for the recipient,
/// and `me` its full mech state at that point, for reconciliation. Everyone else is a `MechView`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub tick: u32,
    pub ack_seq: u32,
    pub me: Mech,
    pub players: Vec<PlayerNet>,
    pub events: Vec<Event>,
    pub state: MatchState,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct PlayerNet {
    pub id: u8,
    pub team: u8,
    pub class: MechClass,
    pub bot: bool,
    pub kills: u16,
    pub deaths: u16,
    pub view: MechView,
}

/// What other players need to draw a mech.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct MechView {
    pub pos: Vector,
    pub yaw: f32,
    pub pitch: f32,
    pub health: f32,
    pub boosting: bool,
    pub hovering: bool,
    /// Class ability active (Slipstream or Brace; Vent is instant).
    pub ability: bool,
}

impl From<&Mech> for MechView {
    fn from(m: &Mech) -> Self {
        Self {
            pos: m.pos,
            yaw: m.yaw,
            pitch: m.pitch,
            health: m.health,
            boosting: m.boosting,
            hovering: m.hovering,
            ability: m.ability_time > 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct MatchState {
    pub scores: [u16; 2],
    /// Until the match ends, or after it ends, until the next one starts.
    pub seconds_left: u16,
    pub ended: bool,
    /// Set once ended; None for a draw.
    pub winner: Option<u8>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum Event {
    Shot { shooter: u8, end: Vector, hit: Option<u8> },
    Kill { killer: u8, victim: u8 },
}

pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    postcard::to_allocvec(msg).expect("protocol types always serialize")
}

/// None for malformed bytes, so a bad client can't panic the server.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    postcard::from_bytes(bytes).ok()
}
