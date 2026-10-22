//! Wire protocol: postcard in WebSocket binary frames. Both ends link this crate, so the
//! format can't drift between client and server.

use crate::projectile::Projectile;
use crate::{Input, Loadout, Mech, MechClass, Vector};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ClientMsg {
    Input(InputMsg),
    /// Mech class and weapons for the next spawn (or right away, before the player's first input).
    Pick(MechClass, Loadout),
    /// The player's callsign, as typed; the server sanitizes it (`game::sanitize_name`).
    Name(String),
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
    /// Every player's id and callsign; sent when anyone joins, leaves or renames.
    Roster(Vec<(u8, String)>),
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
    pub orbs: Vec<Orb>,
}

/// A health orb, dropped where a mech was destroyed: it heals every mech near it until it runs
/// dry or fades.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Orb {
    pub pos: Vector,
    /// Health left to give.
    pub health: f32,
    /// Tick it fades at.
    pub fades_at: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct PlayerNet {
    pub id: u8,
    pub team: u8,
    pub class: MechClass,
    pub loadout: Loadout,
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
    pub repairing: bool,
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
            repairing: m.repair_time > 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct MatchState {
    /// The map being played, and the one the next match will be on (indices into `map::MAPS`).
    pub map: u8,
    pub next_map: u8,
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
    /// A projectile (secondary, or a projectile primary) leaving its owner, before its first tick of flight; clients replay it.
    Launch(Projectile),
    /// A projectile burst at `pos`. `hits` has bit `id` set for each player its splash hurt.
    Blast { owner: u8, seq: u32, n: u8, primary: bool, class: MechClass, loadout: Loadout, pos: Vector, hits: u16 },
    /// An EMP went off at `pos`. `hits` has bit `id` set for each player it jammed.
    Pulse { owner: u8, pos: Vector, hits: u16 },
}

pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    postcard::to_allocvec(msg).expect("protocol types always serialize")
}

/// None for malformed bytes, so a bad client can't panic the server.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    postcard::from_bytes(bytes).ok()
}
