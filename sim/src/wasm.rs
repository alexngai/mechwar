//! Browser bindings. Plain f32 arrays keep the JS boundary cheap at 30 Hz.

use crate::client::NetClient;
use crate::net::Event;
use crate::{ARENA, DT, Input, Mech, Sim, Tuning};
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

#[wasm_bindgen]
pub struct WasmSim(Sim);

#[wasm_bindgen]
impl WasmSim {
    #[wasm_bindgen(constructor)]
    pub fn new(tuning_json: &str) -> Result<WasmSim, JsError> {
        Ok(WasmSim(Sim::new(Tuning::from_json(tuning_json)?)))
    }

    pub fn set_tuning(&mut self, tuning_json: &str) -> Result<(), JsError> {
        self.0.tuning = Tuning::from_json(tuning_json)?;
        Ok(())
    }

    pub fn reset(&mut self) {
        self.0.reset();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn step(&mut self, move_x: f32, move_z: f32, yaw: f32, pitch: f32, boost: bool, hover: bool, dodge: i8, fire: bool) {
        self.0.step(&Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire });
    }

    pub fn state(&self) -> Vec<f32> {
        mech_state(&self.0.mech)
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

    pub fn state(&self) -> Vec<f32> {
        mech_state(&self.0.mech)
    }

    /// Ten floats per remote mech: id, feet xyz, yaw, pitch, health, boosting, hovering, bot.
    pub fn remotes(&self, now: f64) -> Vec<f32> {
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        self.0
            .remotes(now)
            .iter()
            .flat_map(|p| {
                let m = &p.mech;
                [f32::from(p.id), m.pos.x, m.pos.y, m.pos.z, m.yaw, m.pitch, m.health, b(m.boosting), b(m.hovering), b(p.bot)]
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

    /// id (-1 until welcomed), kills, deaths, ping ms, last correction m, full (0/1).
    pub fn hud(&self) -> Vec<f32> {
        let c = &self.0;
        vec![
            c.id.map_or(-1.0, f32::from),
            f32::from(c.kills),
            f32::from(c.deaths),
            c.ping_ms as f32,
            c.correction,
            if c.full { 1.0 } else { 0.0 },
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
