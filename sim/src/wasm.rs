//! Browser bindings. Plain f32 arrays keep the JS boundary cheap at 30 Hz.

use crate::client::{Drawn, NetClient};
use crate::net::Event;
use crate::{Arena, DT, Input, Mech, MechClass, Sim, Tuning, Vector, map};
use rapier3d::prelude::Ray;
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
        m.health, m.ability_time, m.ability_cooldown,
        m.alt_wait, b(m.launched),
        m.repair_time, m.repair_cooldown,
    ]
}

/// Thirteen floats per projectile: owner, seq, n, class, xyz, velocity xyz, age, predicted (0/1),
/// primary fire (0/1).
fn projectile_floats(drawn: impl IntoIterator<Item = Drawn>) -> Vec<f32> {
    drawn
        .into_iter()
        .flat_map(|Drawn { p, predicted }| {
            [
                f32::from(p.owner), p.seq as f32, f32::from(p.n), p.class.index() as f32,
                p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.age, if predicted { 1.0 } else { 0.0 },
                if p.primary { 1.0 } else { 0.0 },
            ]
        })
        .collect()
}

/// Blast event floats (kind 2, or 4 for primary fire): owner, class, where.
fn blast_floats(out: &mut Vec<f32>, (owner, class, primary, at): (u8, MechClass, bool, Vector)) {
    out.extend([if primary { 4.0 } else { 2.0 }, f32::from(owner), class.index() as f32, at.x, at.y, at.z]);
}

/// xyz per own hitscan pellet end.
fn shot_floats(shots: Vec<Vector>) -> Vec<f32> {
    shots.iter().flat_map(|v| v.to_array()).collect()
}

/// Distance along a ray to the first arena surface, capped at `max` (for the chase camera).
fn ray_distance(arena: &Arena, origin: [f32; 3], dir: [f32; 3], max: f32) -> f32 {
    let dir = Vector::from_array(dir).normalize_or_zero();
    arena.cast_ray(&Ray::new(Vector::from_array(origin), dir), max).unwrap_or(max)
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
    /// `map` indexes `map_name`'s list.
    #[wasm_bindgen(constructor)]
    pub fn new(tuning_json: &str, map: u8) -> Result<WasmSim, JsError> {
        let base = Tuning::from_json(tuning_json)?;
        let map = usize::from(map).min(map::MAPS.len() - 1);
        Ok(WasmSim { sim: Sim::with_map(base.clone(), map), base, class: MechClass::B })
    }

    pub fn set_tuning(&mut self, tuning_json: &str) -> Result<(), JsError> {
        self.base = Tuning::from_json(tuning_json)?;
        self.sim.tuning = self.base.for_class(self.class);
        Ok(())
    }

    /// 0 = A, 1 = B, 2 = C. Takes effect for movement at once; call `reset` to respawn in it.
    pub fn set_class(&mut self, class: u8) {
        self.class = MechClass::from_index(class).unwrap_or_default();
        self.sim.class = self.class;
        self.sim.tuning = self.base.for_class(self.class);
    }

    pub fn reset(&mut self) {
        self.sim.reset();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn step(&mut self, move_x: f32, move_z: f32, yaw: f32, pitch: f32, boost: bool, hover: bool, dodge: i8, fire: bool, alt_fire: bool, ability: bool, repair: bool) {
        self.sim.step(&Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire, alt_fire, ability, repair });
    }

    /// Same layout as `WasmNetClient::projectiles`; offline they're all own and predicted.
    pub fn projectiles(&self, _now: f64) -> Vec<f32> {
        projectile_floats(self.sim.projectiles.iter().map(|&p| Drawn { p, predicted: true }))
    }

    /// Same layout as `WasmNetClient::take_events`; offline only Blasts happen.
    pub fn take_events(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        let class = self.class;
        for (primary, at) in std::mem::take(&mut self.sim.blasts) {
            blast_floats(&mut out, (0, class, primary, at));
        }
        out
    }

    /// Where this tick's hitscan pellets stopped against the arena; see `shot_floats`.
    pub fn take_shots(&mut self) -> Vec<f32> {
        shot_floats(std::mem::take(&mut self.sim.shots))
    }

    pub fn state(&self) -> Vec<f32> {
        let mut state = mech_state(&self.sim.mech);
        state.extend([0.0; 3]); // no render offset offline
        state
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cast_ray(&self, ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32, max: f32) -> f32 {
        ray_distance(self.sim.arena(), [ox, oy, oz], [dx, dy, dz], max)
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
    pub fn tick(
        &mut self, move_x: f32, move_z: f32, yaw: f32, pitch: f32, boost: bool, hover: bool, dodge: i8, fire: bool, alt_fire: bool, ability: bool,
        repair: bool, now: f64,
    ) -> Vec<u8> {
        self.0.tick(Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire, alt_fire, ability, repair }, now)
    }

    /// Projectiles to draw now; see `projectile_floats`. Predicted ones are extrapolated by the
    /// page like the own mech; the rest are already at render time.
    pub fn projectiles(&mut self, now: f64) -> Vec<f32> {
        projectile_floats(self.0.projectiles(now))
    }

    pub fn receive(&mut self, bytes: &[u8], now: f64) {
        self.0.receive(bytes, now);
    }

    /// Where own predicted hitscan pellets stopped against the arena; see `shot_floats`.
    pub fn take_shots(&mut self) -> Vec<f32> {
        shot_floats(std::mem::take(&mut self.0.shots))
    }

    /// Index of the server's map, or -1 before the Welcome.
    pub fn map(&self) -> i32 {
        self.0.map.map_or(-1, |m| m as i32)
    }

    /// Bytes asking for class 0 = A, 1 = B, 2 = C at the next spawn.
    pub fn pick_class(&self, class: u8) -> Vec<u8> {
        self.0.pick_class(MechClass::from_index(class).unwrap_or_default())
    }

    /// `mech_state` plus the render offset (3 floats) that smooths corrections.
    pub fn state(&self) -> Vec<f32> {
        let mut state = mech_state(&self.0.mech);
        state.extend(self.0.render_offset.to_array());
        state
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cast_ray(&self, ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32, max: f32) -> f32 {
        ray_distance(self.0.arena(), [ox, oy, oz], [dx, dy, dz], max)
    }

    /// Fourteen floats per remote mech: id, team, class, feet xyz, yaw, pitch, health, boosting, hovering, bot,
    /// ability active, repairing.
    pub fn remotes(&self, now: f64) -> Vec<f32> {
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        self.0
            .remotes(now)
            .iter()
            .flat_map(|p| {
                let v = &p.view;
                [f32::from(p.id), f32::from(p.team), p.class.index() as f32, v.pos.x, v.pos.y, v.pos.z, v.yaw, v.pitch, v.health, b(v.boosting), b(v.hovering), b(p.bot), b(v.ability), b(v.repairing)]
            })
            .collect()
    }

    /// Six floats per event since the last call: kind, a, b, x, y, z.
    /// Shot (kind 0): a = shooter, b = hit id or -1, xyz = where it stopped. Kill (kind 1): a = killer,
    /// b = victim. Blast (kind 2, or 4 for primary fire): a = owner, b = class, xyz = where. Splash hit
    /// (kind 3): a = attacker, b = victim.
    pub fn take_events(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        for e in std::mem::take(&mut self.0.events) {
            match e {
                Event::Shot { shooter, end, hit } => {
                    out.extend([0.0, f32::from(shooter), hit.map_or(-1.0, f32::from), end.x, end.y, end.z]);
                }
                Event::Kill { killer, victim } => out.extend([1.0, f32::from(killer), f32::from(victim), 0.0, 0.0, 0.0]),
                // The client turns these into the blasts and hits below.
                Event::Launch(_) | Event::Blast { .. } => {}
            }
        }
        for blast in std::mem::take(&mut self.0.blasts) {
            blast_floats(&mut out, blast);
        }
        for (attacker, victim) in std::mem::take(&mut self.0.hits) {
            out.extend([3.0, f32::from(attacker), f32::from(victim), 0.0, 0.0, 0.0]);
        }
        out
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

/// Name of compiled-in map `i` (matching a file in maps/), or "" past the end.
#[wasm_bindgen]
pub fn map_name(i: u8) -> String {
    map::MAPS.get(usize::from(i)).map_or(String::new(), |(name, _)| (*name).into())
}

#[wasm_bindgen]
pub fn tick_dt() -> f32 {
    DT
}
