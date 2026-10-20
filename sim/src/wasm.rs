//! Browser bindings. Plain f32 arrays keep the JS boundary cheap at 30 Hz.

use crate::{ARENA, DT, Input, Sim, Tuning};
use wasm_bindgen::prelude::*;

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

    /// Layout matches `S` in web/main.js.
    pub fn state(&self) -> Vec<f32> {
        let m = &self.0.mech;
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        vec![
            m.pos.x, m.pos.y, m.pos.z,
            m.vel.x, m.vel.y, m.vel.z,
            m.fuel, m.heat, b(m.overheated),
            b(m.grounded), b(m.boosting), b(m.hovering),
            m.dodge_cooldown, b(m.shot),
            m.aim_point.x, m.aim_point.y, m.aim_point.z,
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
