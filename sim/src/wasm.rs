//! Browser bindings. Plain f32 arrays keep the JS boundary cheap at 30 Hz.

use crate::client::{Drawn, NetClient};
use crate::net::Event;
use crate::arsenal::{classes_json, weapons_json};
use crate::{Arena, Arsenal, DT, Input, Loadout, Mech, MechClass, Sim, Tuning, Vector, map};
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
        m.repair_time, m.stand_up,
        f32::from(m.grenades), m.grenade_wait, f32::from(m.emps), m.emp_wait, m.jammed, b(m.threw), b(m.pulsed),
        m.spin, m.charge,
    ]
}

/// Fourteen floats per projectile: owner, seq, n, class, xyz, velocity xyz, age, predicted (0/1),
/// primary fire (0/1), and the weapon (an index into weapons.json's primaries or secondaries).
fn projectile_floats(drawn: impl IntoIterator<Item = Drawn>) -> Vec<f32> {
    drawn
        .into_iter()
        .flat_map(|Drawn { p, predicted }| {
            [
                f32::from(p.owner), p.seq as f32, f32::from(p.n), p.class.index() as f32,
                p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.age, if predicted { 1.0 } else { 0.0 },
                if p.primary { 1.0 } else { 0.0 },
                f32::from(if p.primary { p.loadout.primary } else { p.loadout.secondary }),
            ]
        })
        .collect()
}

/// Blast event floats (kind 2): owner, blast radius, where.
fn blast_floats(out: &mut Vec<f32>, (owner, radius, at): (u8, f32, Vector)) {
    out.extend([2.0, f32::from(owner), radius, at.x, at.y, at.z]);
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

/// Offline sandbox. The sliders edit the base (B) tuning, the other classes' overrides and the
/// weapons' values.
#[wasm_bindgen]
pub struct WasmSim {
    sim: Sim,
    base: Tuning,
    /// classes.json and weapons.json as the sliders left them; None until they touch them.
    classes: Option<serde_json::Value>,
    weapons: Option<serde_json::Value>,
}

#[wasm_bindgen]
impl WasmSim {
    /// `map` indexes `map_name`'s list.
    #[wasm_bindgen(constructor)]
    pub fn new(tuning_json: &str, map: u8) -> Result<WasmSim, JsError> {
        let base = Tuning::from_json(tuning_json)?;
        let map = usize::from(map).min(map::MAPS.len() - 1);
        Ok(WasmSim { sim: Sim::with_map(base.clone(), map), base, classes: None, weapons: None })
    }

    pub fn set_tuning(&mut self, tuning_json: &str) -> Result<(), JsError> {
        self.base = Tuning::from_json(tuning_json)?;
        self.retune();
        Ok(())
    }

    /// Replaces the compiled-in classes.json.
    pub fn set_classes(&mut self, classes_json: &str) -> Result<(), JsError> {
        self.classes = Some(serde_json::from_str(classes_json)?);
        self.retune();
        Ok(())
    }

    /// Replaces the compiled-in weapons.json.
    pub fn set_weapons(&mut self, weapons_json: &str) -> Result<(), JsError> {
        self.weapons = Some(serde_json::from_str(weapons_json)?);
        self.retune();
        Ok(())
    }

    /// Class 0 = A, 1 = B, 2 = C, carrying weapons.json's `primary` and `secondary`. Takes
    /// effect at once; call `reset` to respawn in it.
    pub fn set_class(&mut self, class: u8, primary: u8, secondary: u8) {
        self.sim.class = MechClass::from_index(class).unwrap_or_default();
        self.sim.loadout = Loadout { primary, secondary };
        self.retune();
        (self.sim.mech.class, self.sim.mech.loadout) = (self.sim.class, self.sim.loadout);
    }

    pub fn reset(&mut self) {
        self.sim.reset();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self, move_x: f32, move_z: f32, yaw: f32, pitch: f32, boost: bool, hover: bool, dodge: i8, fire: bool, alt_fire: bool, ability: bool,
        repair: bool, grenade: bool, emp: bool,
    ) {
        self.sim.step(&Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire, alt_fire, ability, repair, grenade, emp });
    }

    /// Same layout as `WasmNetClient::projectiles`; offline they're all own and predicted.
    pub fn projectiles(&self, _now: f64) -> Vec<f32> {
        projectile_floats(self.sim.projectiles.iter().map(|&p| Drawn { p, predicted: true }))
    }

    /// Same layout as `WasmNetClient::take_events`; offline only Blasts happen.
    pub fn take_events(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        for (radius, at) in std::mem::take(&mut self.sim.blasts) {
            blast_floats(&mut out, (0, radius, at));
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

impl WasmSim {
    /// Rebuilds the sim's tuning for its class and loadout from the sliders' files.
    fn retune(&mut self) {
        let arsenal = Arsenal::with(&self.base, self.classes.as_ref().unwrap_or(classes_json()), self.weapons.as_ref().unwrap_or(weapons_json()));
        self.sim.loadout = arsenal.clamp(self.sim.loadout);
        self.sim.tuning = arsenal.get(self.sim.class, self.sim.loadout).clone();
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
        repair: bool, grenade: bool, emp: bool, now: f64,
    ) -> Vec<u8> {
        self.0.tick(Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire, alt_fire, ability, repair, grenade, emp }, now)
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

    /// Callsign of player `id`, or "" before the server has said.
    pub fn name(&self, id: u8) -> String {
        self.0.names.get(&id).cloned().unwrap_or_default()
    }

    /// Bytes setting our callsign to `raw` (the server sanitizes it).
    pub fn set_name(&self, raw: &str) -> Vec<u8> {
        self.0.name_msg(raw)
    }

    /// Six floats per player, us included, for the scoreboard: id, team, class, bot (0/1), kills, deaths.
    pub fn board(&self) -> Vec<f32> {
        self.0
            .board()
            .iter()
            .flat_map(|p| [f32::from(p.id), f32::from(p.team), p.class.index() as f32, if p.bot { 1.0 } else { 0.0 }, f32::from(p.kills), f32::from(p.deaths)])
            .collect()
    }

    /// Four floats per health orb: xyz and the health it has left.
    pub fn orbs(&self) -> Vec<f32> {
        self.0.orbs().iter().flat_map(|o| [o.pos.x, o.pos.y, o.pos.z, o.health]).collect()
    }

    /// Index of the server's map, or -1 before the Welcome.
    pub fn map(&self) -> i32 {
        self.0.map.map_or(-1, |m| m as i32)
    }

    /// Bytes asking for class 0 = A, 1 = B, 2 = C carrying weapons.json's `primary` and
    /// `secondary` at the next spawn.
    pub fn pick(&self, class: u8, primary: u8, secondary: u8) -> Vec<u8> {
        self.0.pick(MechClass::from_index(class).unwrap_or_default(), Loadout { primary, secondary })
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

    /// Sixteen floats per remote mech: id, team, class, feet xyz, yaw, pitch, health, boosting, hovering, bot,
    /// ability active, repairing, primary, secondary.
    pub fn remotes(&self, now: f64) -> Vec<f32> {
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        self.0
            .remotes(now)
            .iter()
            .flat_map(|p| {
                let v = &p.view;
                [f32::from(p.id), f32::from(p.team), p.class.index() as f32, v.pos.x, v.pos.y, v.pos.z, v.yaw, v.pitch, v.health, b(v.boosting), b(v.hovering), b(p.bot), b(v.ability), b(v.repairing), f32::from(p.loadout.primary), f32::from(p.loadout.secondary)]
            })
            .collect()
    }

    /// Six floats per event since the last call: kind, a, b, x, y, z.
    /// Shot (kind 0): a = shooter, b = hit id or -1, xyz = where it stopped. Kill (kind 1): a = killer,
    /// b = victim. Blast (kind 2): a = owner, b = blast radius, xyz = where. Splash hit (kind 3): a = attacker,
    /// b = victim. EMP (kind 4): a = owner, b = bitmask of the ids it jammed, xyz = where.
    pub fn take_events(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        for e in std::mem::take(&mut self.0.events) {
            match e {
                Event::Shot { shooter, end, hit } => {
                    out.extend([0.0, f32::from(shooter), hit.map_or(-1.0, f32::from), end.x, end.y, end.z]);
                }
                Event::Kill { killer, victim } => out.extend([1.0, f32::from(killer), f32::from(victim), 0.0, 0.0, 0.0]),
                Event::Pulse { owner, pos, hits } => out.extend([4.0, f32::from(owner), f32::from(hits), pos.x, pos.y, pos.z]),
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
    /// team 0 score, team 1 score, seconds left, ended (0/1), winner (-1 for none or a draw), class,
    /// next match's map, primary, secondary.
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
            f32::from(s.next_map),
            f32::from(c.loadout.primary),
            f32::from(c.loadout.secondary),
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
