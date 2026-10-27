//! Browser bindings. Plain f32 arrays keep the JS boundary cheap at 30 Hz.

use crate::client::{Drawn, NetClient};
use crate::deploy::Deployable;
use crate::game::Mode;
use crate::net::{Cloud, Event};
use crate::arsenal::{classes_json, weapons_json};
use crate::{Arena, Arsenal, DT, Input, Loadout, Mech, MechClass, Sim, Slot, Tuning, Vector, map};
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
        m.bloom, m.fire_wait,
        f32::from(m.lock), m.lock_time,
        b(m.beaming), m.beam_end.x, m.beam_end.y, m.beam_end.z,
        b(m.shield > 0.0), b(m.limpet), f32::from(m.seek), m.alt_charge, crate::melee::burn(m),
    ]
}

/// Ten floats per deployable: kind (0 dome, 1 barrier, 2 MG turret, 3 rocket turret, 4 battleship, 5 base gun, 6 Convoy's hauler), team (2 for none),
/// owner, base xyz, facing yaw and pitch, seconds left as of tick `now`, and hull left (infinite
/// for a dome or barrier).
fn deployable_floats(list: &[Deployable], now: u32) -> Vec<f32> {
    list.iter()
        .flat_map(|d| [d.kind as u8 as f32, f32::from(d.team), f32::from(d.owner), d.pos.x, d.pos.y, d.pos.z, d.yaw, d.pitch, d.expires.saturating_sub(now) as f32 * DT, d.hull])
        .collect()
}

/// Five floats per smoke cloud: xyz, radius and seconds left, as of tick `now`.
fn cloud_floats<'a>(clouds: impl IntoIterator<Item = &'a Cloud>, now: u32) -> Vec<f32> {
    clouds.into_iter().flat_map(|c| [c.pos.x, c.pos.y, c.pos.z, c.radius, c.fades_at.saturating_sub(now) as f32 * DT]).collect()
}

/// Sixteen floats per projectile: owner, seq, n, class, xyz, velocity xyz, age, predicted (0/1),
/// primary fire (0/1), the weapon (an index into weapons.json's primaries or secondaries), its
/// charge (0-1), and the player a homing shell is locked on (their id + 1; 0 for none).
fn projectile_floats(drawn: impl IntoIterator<Item = Drawn>) -> Vec<f32> {
    drawn
        .into_iter()
        .flat_map(|Drawn { p, predicted }| {
            [
                f32::from(p.owner), p.seq as f32, f32::from(p.n), p.class.index() as f32,
                p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.age, if predicted { 1.0 } else { 0.0 },
                if p.primary { 1.0 } else { 0.0 },
                f32::from(if p.primary { p.loadout.primary } else { p.loadout.secondary }),
                p.charge, f32::from(p.target),
            ]
        })
        .collect()
}

/// Blast event floats (kind 2): the shot's charge, blast radius, where.
fn blast_floats(out: &mut Vec<f32>, (radius, at, charge): (f32, Vector, f32)) {
    out.extend([2.0, charge, radius, at.x, at.y, at.z]);
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

    /// Class 0 = A, 1 = B, 2 = C, carrying weapons.json's `primary` and `secondary`, and its
    /// `offensive` and `support` items. Takes effect at once; call `reset` to respawn in it.
    pub fn set_class(&mut self, class: u8, primary: u8, secondary: u8, offensive: u8, support: u8, ability: u8) {
        self.sim.class = MechClass::from_index(class).unwrap_or_default();
        self.sim.loadout = Loadout { primary, secondary, offensive, support, ability };
        self.retune();
        (self.sim.mech.class, self.sim.mech.loadout) = (self.sim.class, self.sim.loadout);
    }

    pub fn reset(&mut self) {
        self.sim.reset();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self, move_x: f32, move_z: f32, yaw: f32, pitch: f32, boost: bool, hover: bool, dodge: i8, fire: bool, alt_fire: bool, ability: bool,
        repair: bool, grenade: bool, emp: bool, aux: bool,
    ) {
        self.sim.step(&Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire, alt_fire, ability, repair, grenade, emp, aux });
    }

    /// Same layout as `WasmNetClient::projectiles`; offline they're all own and predicted.
    pub fn projectiles(&self, _now: f64) -> Vec<f32> {
        projectile_floats(self.sim.projectiles.iter().map(|&p| Drawn { p, predicted: true }))
    }

    /// Same layout as `WasmNetClient::take_events`; offline only Blasts happen.
    pub fn take_events(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        for blast in std::mem::take(&mut self.sim.blasts) {
            blast_floats(&mut out, blast);
        }
        out
    }

    /// Where this tick's hitscan pellets stopped against the arena; see `shot_floats`.
    pub fn take_shots(&mut self) -> Vec<f32> {
        shot_floats(std::mem::take(&mut self.sim.shots))
    }

    /// Smoke hanging about; see `cloud_floats`.
    pub fn clouds(&self) -> Vec<f32> {
        cloud_floats(&self.sim.clouds, self.sim.ticks())
    }

    /// What's been put down; see `deployable_floats`.
    pub fn deployables(&self) -> Vec<f32> {
        deployable_floats(&self.sim.deployables, self.sim.ticks())
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
        repair: bool, grenade: bool, emp: bool, aux: bool, now: f64,
    ) -> Vec<u8> {
        self.0.tick(Input { move_x, move_z, yaw, pitch, boost, hover, dodge, fire, alt_fire, ability, repair, grenade, emp, aux }, now)
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

    /// Level of player `id` (0 for bots, or before the server has said).
    pub fn level(&self, id: u8) -> u8 {
        self.0.levels.get(&id).copied().unwrap_or(0)
    }

    /// Bytes spending unlock points on entry `index` of slot 0 = primaries, 1 = secondaries,
    /// 2 = offensive items, 3 = support items, 4 = abilities, for class 0 = A, 1 = B, 2 = C.
    pub fn unlock(&self, class: u8, slot: u8, index: u8) -> Vec<u8> {
        self.0.unlock_msg(MechClass::from_index(class).unwrap_or_default(), Slot::from_index(slot).unwrap_or(Slot::Primary), index)
    }

    /// Bytes handing the server our signed progression record ("" for none yet).
    pub fn send_progress(&self, record: &str) -> Vec<u8> {
        self.0.progress_msg(record)
    }

    /// The newest progression record from the server since last asked, as JSON `{ record, end }`
    /// (`end` is the match's XP by source, or null mid-match); "" if none.
    pub fn take_progress(&mut self) -> String {
        self.0.progress.take().map_or_else(String::new, |(record, end)| serde_json::json!({ "record": record, "end": end }).to_string())
    }

    /// Seven floats per player, us included, for the scoreboard: id, team, class, bot (0/1), kills,
    /// deaths, points.
    pub fn board(&self) -> Vec<f32> {
        self.0
            .board()
            .iter()
            .flat_map(|p| [f32::from(p.id), f32::from(p.team), p.class.index() as f32, if p.bot { 1.0 } else { 0.0 }, f32::from(p.kills), f32::from(p.deaths), f32::from(p.points)])
            .collect()
    }

    /// Five floats per health orb: xyz, the health it has left, and the team it heals (a
    /// Salve's) or -1 for anyone (a wreck's).
    pub fn orbs(&self) -> Vec<f32> {
        self.0.orbs().iter().flat_map(|o| [o.pos.x, o.pos.y, o.pos.z, o.health, o.dropped.map_or(-1.0, |(_, team)| f32::from(team))]).collect()
    }

    /// Smoke hanging about; see `cloud_floats`.
    pub fn clouds(&self) -> Vec<f32> {
        let (clouds, tick) = self.0.clouds();
        cloud_floats(clouds, tick)
    }

    /// What's been put down; see `deployable_floats`.
    pub fn deployables(&self) -> Vec<f32> {
        deployable_floats(self.0.deployables(), self.0.clouds().1)
    }

    /// Three floats per Missile Assault silo, A to C: the team holding it (-1: none), the capture's
    /// progress (-1 team 1's to 1 team 0's), contested (0/1).
    pub fn zones(&self) -> Vec<f32> {
        self.0.zones().iter().flat_map(|z| [z.owner.map_or(-1.0, f32::from), z.progress, if z.contested { 1.0 } else { 0.0 }]).collect()
    }

    /// Siege as of the latest snapshot: each station's EU (as many as the map has), each team's
    /// bank, then four floats per drop (xyz, EU). Empty outside Siege.
    pub fn siege(&self) -> Vec<f32> {
        self.0.siege().map_or_else(Vec::new, |s| s.stations.iter().copied().chain(s.banks).chain(s.drops.iter().flat_map(|d| [d.at.x, d.at.y, d.at.z, d.eu])).collect())
    }

    /// Capture the Flag as of the latest snapshot: for each team's flag (team 0's first) seven
    /// floats: where it is (0 home, 1 carried, 2 dropped), its carrier's id (or -1), where it lies
    /// (xyz, while dropped), how far a raid on its stand has got (0-1), and whether defenders hold
    /// the raid off (0/1); then each team's captures. Empty outside Capture the Flag.
    pub fn ctf(&self) -> Vec<f32> {
        use crate::ctf::Flag;
        let Some(c) = self.0.ctf() else { return Vec::new() };
        let flag = |t: usize| {
            let (state, by, at) = match c.flags.get(t).copied().unwrap_or(Flag::Home) {
                Flag::Home => (0.0, -1.0, Vector::ZERO),
                Flag::Carried { by } => (1.0, f32::from(by), Vector::ZERO),
                Flag::Dropped { at } => (2.0, -1.0, at),
            };
            [state, by, at.x, at.y, at.z, c.taking[t], if c.contested[t] { 1.0 } else { 0.0 }]
        };
        flag(0).into_iter().chain(flag(1)).chain(c.captures.map(f32::from)).collect()
    }

    /// Convoy as of the latest snapshot: where the hauler is along its route and where it started
    /// (0 at team 0's base, 1 at team 1's), the team pushing it (-1 for none), its escorts,
    /// whether both teams are at it (0/1), and the seconds its stall has left. Empty outside Convoy.
    pub fn convoy(&self) -> Vec<f32> {
        self.0.convoy().map_or_else(Vec::new, |c| {
            vec![c.along, c.start, c.pusher.map_or(-1.0, f32::from), f32::from(c.escorts), if c.contested { 1.0 } else { 0.0 }, c.stall]
        })
    }

    /// Index of the server's map, or -1 before the Welcome.
    pub fn map(&self) -> i32 {
        self.0.map.map_or(-1, |m| m as i32)
    }

    /// Bytes asking for class 0 = A, 1 = B, 2 = C carrying weapons.json's `primary` and
    /// `secondary`, its `offensive` and `support` items, and its `ability`, at the next spawn.
    pub fn pick(&self, class: u8, primary: u8, secondary: u8, offensive: u8, support: u8, ability: u8) -> Vec<u8> {
        self.0.pick(MechClass::from_index(class).unwrap_or_default(), Loadout { primary, secondary, offensive, support, ability })
    }

    /// `mech_state` plus the render offset (3 floats) that smooths corrections.
    pub fn state(&mut self) -> Vec<f32> {
        self.0.settle();
        let mut state = mech_state(&self.0.mech);
        state.extend(self.0.render_offset.to_array());
        state
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cast_ray(&self, ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32, max: f32) -> f32 {
        ray_distance(self.0.arena(), [ox, oy, oz], [dx, dy, dz], max)
    }

    /// Twenty-three floats per remote mech: id, team, class, feet xyz, yaw, pitch, health, boosting, hovering, bot,
    /// ability on, repairing, primary, secondary, docked (in the hangar: not drawn), shielded, ability (an
    /// index into weapons.json's abilities), offensive and support item, and a rocket punch's wind-up
    /// and booster burn (0-1).
    pub fn remotes(&self, now: f64) -> Vec<f32> {
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        self.0
            .remotes(now)
            .iter()
            .flat_map(|p| {
                let v = &p.view;
                [f32::from(p.id), f32::from(p.team), p.class.index() as f32, v.pos.x, v.pos.y, v.pos.z, v.yaw, v.pitch, v.health, b(v.boosting), b(v.hovering), b(p.bot), b(v.ability), b(v.repairing), f32::from(p.loadout.primary), f32::from(p.loadout.secondary), b(p.docked), b(v.shielded), f32::from(p.loadout.ability), f32::from(p.loadout.offensive), f32::from(p.loadout.support), v.wind, v.burn]
            })
            .collect()
    }

    /// Six floats per event since the last call: kind, a, b, x, y, z.
    /// Shot (kind 0): a = shooter, b = hit id or -1, xyz = where it stopped. Kill (kind 1): a = killer,
    /// b = victim, x = bitmask of the ids credited with an assist. Blast (kind 2): a = the shot's
    /// charge (0-1), b = blast radius, xyz = where. Splash hit (kind 3): a = attacker, b = victim.
    /// EMP (kind 4): a = owner, b = bitmask of the ids it jammed, xyz = where. Beam (kind 5): a =
    /// owner, b = id it's on or -1, xyz = where it stops. Captured (kind 8): a = zone, b = team.
    /// Missile (kind 9): a = silo, b = the team that fired it. Ship (kind 10): a = team, b = 1
    /// launched, 0 down. Turret round (kind 6): a = the MG turret's owner, b = hit id or -1, xyz =
    /// where it stopped. Turret hit (kind 7): a = who hit it, b = 1 if that wrecked it. Strike
    /// (kind 11): a = striker, b = who it hit (or slammed), xyz = where. Flag (kind 12): a = the
    /// flag's team, b = what happened to it (0 taken, 1 dropped, 2 picked up, 3 returned, 4
    /// captured), x = by whom (an id, or -1). Convoy (kind 13): a = what (0 a team took it over,
    /// 1 stalled, 2 back up, 3 delivered), b = the team (that took it over, or delivered it; else -1).
    pub fn take_events(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        for e in std::mem::take(&mut self.0.events) {
            match e {
                Event::Shot { shooter, end, hit } => {
                    out.extend([0.0, f32::from(shooter), hit.map_or(-1.0, f32::from), end.x, end.y, end.z]);
                }
                Event::Kill { killer, victim, assists } => out.extend([1.0, f32::from(killer), f32::from(victim), f32::from(assists), 0.0, 0.0]),
                Event::Pulse { owner, pos, hits } => out.extend([4.0, f32::from(owner), f32::from(hits), pos.x, pos.y, pos.z]),
                Event::Beam { owner, end, hit } => out.extend([5.0, f32::from(owner), hit.map_or(-1.0, f32::from), end.x, end.y, end.z]),
                Event::TurretShot { owner, end, hit } => out.extend([6.0, f32::from(owner), hit.map_or(-1.0, f32::from), end.x, end.y, end.z]),
                Event::TurretHit { attacker, wrecked } => out.extend([7.0, f32::from(attacker), if wrecked { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0]),
                Event::Captured { zone, team } => out.extend([8.0, f32::from(zone), f32::from(team), 0.0, 0.0, 0.0]),
                Event::Missile { silo, team } => out.extend([9.0, f32::from(silo), f32::from(team), 0.0, 0.0, 0.0]),
                Event::Ship { team, up } => out.extend([10.0, f32::from(team), if up { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0]),
                Event::Strike { owner, hit, pos } => out.extend([11.0, f32::from(owner), f32::from(hit), pos.x, pos.y, pos.z]),
                Event::Flag { team, what, by } => out.extend([12.0, f32::from(team), f32::from(what as u8), by.map_or(-1.0, f32::from), 0.0, 0.0]),
                Event::Convoy(news) => {
                    use crate::convoy::News;
                    let (what, team) = match news {
                        News::Pushing(t) => (0.0, f32::from(t)),
                        News::Stalled => (1.0, -1.0),
                        News::Rebooted => (2.0, -1.0),
                        News::Delivered(t) => (3.0, f32::from(t)),
                    };
                    out.extend([13.0, what, team, 0.0, 0.0, 0.0]);
                }
                // The client turns these into the blasts and hits below.
                Event::Launch(_) | Event::Blast { .. } => {}
            }
        }
        for (_, radius, at, charge) in std::mem::take(&mut self.0.blasts) {
            blast_floats(&mut out, (radius, at, charge));
        }
        for (attacker, victim) in std::mem::take(&mut self.0.hits) {
            out.extend([3.0, f32::from(attacker), f32::from(victim), 0.0, 0.0, 0.0]);
        }
        out
    }

    /// id (-1 until welcomed), kills, deaths, ping ms, last correction m, full (0/1), team,
    /// team 0 score, team 1 score (in Deathmatch: the top two's points), seconds left, ended (0/1),
    /// winner (-1 for none or a draw; in Deathmatch a player id), class, next match's map, primary,
    /// secondary, seconds until we can launch from the hangar (-1 when out in the arena), offensive
    /// item, support item, ability, mode, next match's mode (modes index `Mode::ALL`), Siege energy
    /// carried, the score limit (team kills; in Deathmatch, solo kills' worth of points), staging
    /// (0/1: penned in the spawns, `seconds left` till the pens open).
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
            c.hangar.unwrap_or(-1.0),
            f32::from(c.loadout.offensive),
            f32::from(c.loadout.support),
            f32::from(c.loadout.ability),
            mode_index(s.mode),
            mode_index(s.next_mode),
            c.board().iter().find(|p| Some(p.id) == c.id).map_or(0.0, |p| f32::from(p.eu)),
            f32::from(s.limit),
            if s.staging { 1.0 } else { 0.0 },
        ]
    }

    /// Each team's staging pen, team 0's first: its center (xyz) and radius.
    pub fn pens(&self) -> Vec<f32> {
        self.0.arena().pens.iter().flat_map(|(c, r)| [c.x, c.y, c.z, *r]).collect()
    }
}

fn mode_index(mode: Mode) -> f32 {
    Mode::ALL.iter().position(|&m| m == mode).unwrap_or(0) as f32
}

/// Name of mode `i` (`Mode::ALL`'s order), as players see it, or "" past the end.
#[wasm_bindgen]
pub fn mode_name(i: u8) -> String {
    Mode::ALL.get(usize::from(i)).map_or(String::new(), |m| m.name().into())
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
