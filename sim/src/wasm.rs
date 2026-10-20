//! Browser bindings. Plain f32 arrays keep the JS boundary cheap at 30 Hz.

use crate::client::NetClient;
use crate::net::Event;
use crate::{ARENA, DT, Input, Mech, MechClass, Sim, Tuning};
use wasm_bindgen::prelude::*;

/// Layout matches `S` in web/main.js.
fn mech_state(m: &Mech) -> Vec<f32> {
    let b = |v: bool| if v { 1.0 } else { 0.0 };
    vec![
        m.pos.x, m.pos.y, m.pos.z,
        m.vel.x, m.vel.y, m.vel.z,
        m.fuel, m.heat, b(m.overheated),
        b(m.grounded), b(m.boosting), b(m.hovering),
        m.dodge_cooldown, b(m.shot),
        m.aim_point.x, m.aim_point.y, m.aim_point.z,
        m.health,
    ]
}

/// Offline sandbox. The sliders edit the base (B) tuning; the chosen class's overrides sit on top.
#[wasm_bindgen]
pub struct WasmSim {
    sim: Sim,
    base: Tuning,
    class: MechClass,
}

#[wasm_bindgen]
impl WasmSim {
    #[wasm_bindgen(constructor)]
    pub fn new(tuning_json: &str) -> Result<WasmSim, JsError> {
        let base = Tuning::from_json(tuning_json)?;
        Ok(WasmSim { sim: Sim::new(base.clone()), base, class: MechClass::B })
    }

    pub fn set_tuning(&mut self, tuning_json: &str) -> Result<(), JsError> {
        self.base = Tuning::from_json(tuning_json)?;
        self.sim.tuning = self.base.for_class(self.class);
        Ok(())
    }

    /// 0 = A, 1 = B, 2 = C. Takes effect for movement at once; call `reset` to respawn in it.
    pub fn set_class(&mut self, class: u8) {
        self.class = MechClass::from_index(class).unwrap_or_default();
        self.sim.tuning = self.base.for_class(self.class);
    }

    pub fn reset(&mut self) {
        self.sim.reset();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn step(&mut self, move_x: f32, move_z: f32, yaw: f32, pitch: f32, boost: bool, hover: bool, dodge: i8, fire: bool) {
        self.sim.step(&Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire });
    }

    pub fn state(&self) -> Vec<f32> {
        mech_state(&self.sim.mech)
    }
}

/// Online counterpart of `WasmSim`: same `state()` layout, but `tick` returns bytes to send.
/// Uses the compiled-in tuning.json so prediction matches the server.
#[wasm_bindgen]
pub struct WasmNetClient(NetClient);

#[wasm_bindgen]
impl WasmNetClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmNetClient {
        WasmNetClient(NetClient::default())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn tick(&mut self, move_x: f32, move_z: f32, yaw: f32, pitch: f32, boost: bool, hover: bool, dodge: i8, fire: bool, now: f64) -> Vec<u8> {
        self.0.tick(Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire }, now)
    }

    pub fn receive(&mut self, bytes: &[u8], now: f64) {
        self.0.receive(bytes, now);
    }

    /// Bytes asking for class 0 = A, 1 = B, 2 = C at the next spawn.
    pub fn pick_class(&self, class: u8) -> Vec<u8> {
        self.0.pick_class(MechClass::from_index(class).unwrap_or_default())
    }

    pub fn state(&self) -> Vec<f32> {
        mech_state(&self.0.mech)
    }

    /// Twelve floats per remote mech: id, team, class, feet xyz, yaw, pitch, health, boosting, hovering, bot.
    pub fn remotes(&self, now: f64) -> Vec<f32> {
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        self.0
            .remotes(now)
            .iter()
            .flat_map(|p| {
                let v = &p.view;
                [f32::from(p.id), f32::from(p.team), p.class.index() as f32, v.pos.x, v.pos.y, v.pos.z, v.yaw, v.pitch, v.health, b(v.boosting), b(v.hovering), b(p.bot)]
            })
            .collect()
    }

    /// Six floats per event since the last call: kind, a, b, x, y, z.
    /// Shot (kind 0): a = shooter, b = hit id or -1, xyz = where it stopped. Kill (kind 1): a = killer, b = victim.
    pub fn take_events(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.0.events)
            .iter()
            .flat_map(|e| match *e {
                Event::Shot { shooter, end, hit } => {
                    [0.0, f32::from(shooter), hit.map_or(-1.0, f32::from), end.x, end.y, end.z]
                }
                Event::Kill { killer, victim } => [1.0, f32::from(killer), f32::from(victim), 0.0, 0.0, 0.0],
            })
            .collect()
    }

    /// id (-1 until welcomed), kills, deaths, ping ms, last correction m, full (0/1), team,
    /// team 0 score, team 1 score, seconds left, ended (0/1), winner (-1 for none or a draw), class.
    pub fn hud(&self) -> Vec<f32> {
        let (c, s) = (&self.0, &self.0.state);
        vec![
            c.id.map_or(-1.0, f32::from),
            f32::from(c.kills),
            f32::from(c.deaths),
            c.ping_ms as f32,
            c.correction,
            if c.full { 1.0 } else { 0.0 },
            f32::from(c.team),
            f32::from(s.scores[0]),
            f32::from(s.scores[1]),
            f32::from(s.seconds_left),
            if s.ended { 1.0 } else { 0.0 },
            s.winner.map_or(-1.0, f32::from),
            c.class.index() as f32,
        ]
    }
}

/// Seven floats per block: center xyz, half extents xyz, tilt about X in radians.
#[wasm_bindgen]
pub fn arena() -> Vec<f32> {
    ARENA
        .iter()
        .flat_map(|b| [b.center[0], b.center[1], b.center[2], b.half[0], b.half[1], b.half[2], b.tilt_x_deg.to_radians()])
        .collect()
}

#[wasm_bindgen]
pub fn tick_dt() -> f32 {
    DT
}
