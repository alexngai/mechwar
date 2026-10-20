//! Wire protocol: postcard in WebSocket binary frames. Both ends link this crate, so the
//! format can't drift between client and server.

use crate::{Input, Mech, Vector};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// One per client tick. `view_tick` is the fractional server tick the client was rendering
/// remote mechs at when it sampled this input; the server rewinds targets to it for hits.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct ClientMsg {
    pub seq: u32,
    pub input: Input,
    pub view_tick: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ServerMsg {
    Welcome { id: u8 },
    Full,
    Snapshot(Snapshot),
}

/// Sent every server tick. `ack_seq` is the last input the server applied for the recipient.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub tick: u32,
    pub ack_seq: u32,
    pub players: Vec<PlayerNet>,
    pub events: Vec<Event>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct PlayerNet {
    pub id: u8,
    pub mech: Mech,
    pub kills: u16,
    pub deaths: u16,
    pub bot: bool,
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
