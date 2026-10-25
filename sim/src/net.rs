//! Wire protocol: postcard in WebSocket binary frames. Both ends link this crate, so the
//! format can't drift between client and server.

use crate::deploy::Deployable;
use crate::game::Mode;
use crate::objective::ZoneState;
use crate::siege::SiegeNet;
use crate::progress::MatchXp;
use crate::projectile::Projectile;
use crate::{Input, Loadout, Mech, MechClass, Slot, Vector};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ClientMsg {
    Input(InputMsg),
    /// Mech class and weapons for the next spawn (or right away, before the player's first input).
    Pick(MechClass, Loadout),
    /// The player's callsign, as typed; the server sanitizes it (`game::sanitize_name`).
    Name(String),
    /// The player's progression record as the server last signed it ("" for none yet), sent on
    /// joining; the server checks the signature, else starts a fresh guest.
    Progress(String),
    /// Spend unlock points on the weapon or item at `index` in `slot`'s list for `class`; the
    /// server answers with the record (`ServerMsg::Progress`) if it could.
    Unlock { class: MechClass, slot: Slot, index: u8 },
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
    /// Every player's id, callsign and level (0 for bots); sent when anyone joins, leaves,
    /// renames or levels up.
    Roster(Vec<(u8, String, u8)>),
    /// The player's progression record, signed, to keep and send back on the next join; sent
    /// on joining and every few seconds while it changes, and with the match's XP at its end.
    Progress { record: String, end: Option<MatchXp> },
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
    pub clouds: Vec<Cloud>,
    pub deployables: Vec<Deployable>,
    /// Missile Assault's silos, A to C, or Siege's AA gun (empty in other modes).
    pub zones: Vec<ZoneState>,
    /// Siege's stations, banks and drops.
    pub siege: Option<SiegeNet>,
    /// Capture the Flag's flags, raids and captures.
    pub ctf: Option<crate::ctf::CtfNet>,
    /// Convoy's hauler: where along its route, who's pushing, its stall.
    pub convoy: Option<crate::convoy::ConvoyNet>,
    /// In the hangar (destroyed, or not launched yet): seconds until it can launch (0: now).
    /// None while out in the arena.
    pub hangar: Option<f32>,
}

/// A health orb, dropped where a mech was destroyed: it heals every mech near it until it runs
/// dry or fades. One dropped as an item (the Salve) heals only its dropper's side.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Orb {
    pub pos: Vector,
    /// Health left to give.
    pub health: f32,
    /// Tick it fades at.
    pub fades_at: u32,
    /// The Salve's: who dropped it and their team.
    pub dropped: Option<(u8, u8)>,
}

/// Smoke from a Pall: a sphere sight doesn't pass through, until it fades.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Cloud {
    pub pos: Vector,
    pub radius: f32,
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
    /// Kill credit this match (`Game`'s POINTS_PER_KILL a kill), and objective points.
    pub points: u16,
    /// Siege energy carried.
    pub eu: u8,
    /// In the hangar with its wreck cleared: not drawn.
    pub docked: bool,
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
    /// Its ability on (all but Vent, which is instant, stay on a while).
    pub ability: bool,
    pub repairing: bool,
    pub shielded: bool,
    /// A melee secondary's wind-up (0-1), and how hard its booster burns (`melee::burn`).
    pub wind: f32,
    pub burn: f32,
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
            shielded: m.shield > 0.0,
            wind: m.alt_charge,
            burn: crate::melee::burn(m),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct MatchState {
    /// The mode and map being played, and the next match's (maps index `map::MAPS`).
    pub mode: Mode,
    pub map: u8,
    pub next_mode: Mode,
    pub next_map: u8,
    /// Team kills; in Deathmatch, the leader's and the runner-up's points; in Missile Assault and
    /// Siege, the bases' hull.
    pub scores: [u16; 2],
    /// Team kills that win it; in Deathmatch, as many solo kills' worth of points.
    pub limit: u16,
    /// Until the match ends, or after it ends, until the next one starts.
    pub seconds_left: u16,
    pub ended: bool,
    /// Set once ended; None for a draw.
    pub winner: Option<u8>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum Event {
    Shot { shooter: u8, end: Vector, hit: Option<u8> },
    /// `assists` has bit `id` set for each other player who dealt enough of the victim's damage
    /// to count an assist (`progress::ASSIST_SHARE`).
    Kill { killer: u8, victim: u8, assists: u16 },
    /// A projectile (secondary, or a projectile primary) leaving its owner, before its first tick of flight; clients replay it.
    Launch(Projectile),
    /// A projectile burst at `pos`. `hits` has bit `id` set for each player its splash hurt.
    Blast { owner: u8, seq: u32, n: u8, primary: bool, class: MechClass, loadout: Loadout, charge: f32, boosted: bool, pos: Vector, hits: u16 },
    /// An EMP went off at `pos`. `hits` has bit `id` set for each player it jammed.
    Pulse { owner: u8, pos: Vector, hits: u16 },
    /// A held beam this tick, from `owner`'s launcher to `end`, on mech `hit` if any.
    Beam { owner: u8, end: Vector, hit: Option<u8> },
    /// A round from `owner`'s MG turret, stopping at `end`, on mech `hit` if any.
    TurretShot { owner: u8, end: Vector, hit: Option<u8> },
    /// Player `attacker` hit a turret (and `wrecked` it).
    TurretHit { attacker: u8, wrecked: bool },
    /// Player `owner`'s melee strike landed on `hit` at `pos`, or `hit` was slammed into a wall
    /// by the throw (`melee.rs`).
    Strike { owner: u8, hit: u8, pos: Vector },
    /// `team` took zone `zone` (a silo, by its index).
    Captured { zone: u8, team: u8 },
    /// Silo `silo`, held by `team`, fired at the other team's base; it lands after `objective::MISSILE_FLIGHT`.
    Missile { silo: u8, team: u8 },
    /// `team`'s battleship launched (`up`) or went down.
    Ship { team: u8, up: bool },
    /// `what` happened to `team`'s flag, by player `by`.
    Flag { team: u8, what: crate::ctf::Happened, by: Option<u8> },
    /// News of Convoy's hauler.
    Convoy(crate::convoy::News),
}

pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    postcard::to_allocvec(msg).expect("protocol types always serialize")
}

/// None for malformed bytes, so a bad client can't panic the server.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    postcard::from_bytes(bytes).ok()
}
