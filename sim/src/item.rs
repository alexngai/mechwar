//! Items: an offensive slot (G) and a support slot (T) per mech, each holding charges that come
//! back one at a time. A mech starts with the Tumbler and the Brownout (classes.json) and may
//! carry what it has unlocked instead (weapons.json's `offensive` and `support`). `step` runs
//! inside `step_mech`, so the client predicts charges like fuel.
//!
//! Offensive items are thrown, as projectiles (`projectile::thrown`): the Tumbler grenade, the
//! Limpet (a remote mine: sticks where it lands, and G again sets it off) and the Pall (smoke: a
//! cloud that hides what's in or behind it, `hidden`); or set down: the turrets (`deploy.rs`). Support items act around the mech, and
//! their effects are the server's: the Brownout EMP (`emp_reaches`, `jam`), the Salve, a repair
//! orb dropped for the mech's side, and the deployables (`deploy.rs`): the shield dome and the
//! barrier.

use std::sync::OnceLock;

use crate::arsenal::Slot;
use crate::net::Cloud;
use crate::projectile;
use crate::{Arena, DT, Input, Loadout, Mech, Tuning, Vector};

/// What an item does, by its weapons.json id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    Grenade,
    Limpet,
    Smoke,
    Emp,
    Orb,
    Dome,
    Barrier,
    MgTurret,
    RocketTurret,
}

impl Item {
    /// The offensive (or support) item `loadout` carries.
    pub fn of(loadout: Loadout, offensive: bool) -> Item {
        let (list, index) = if offensive { (&lists()[0], loadout.offensive) } else { (&lists()[1], loadout.support) };
        list[usize::from(index).min(list.len() - 1)]
    }

    /// Its index in its slot's list.
    pub fn index(self) -> u8 {
        lists().iter().find_map(|list| list.iter().position(|&i| i == self)).expect("every item is listed") as u8
    }

    /// Its charges, and the seconds each takes to come back.
    fn charges(self, t: &Tuning) -> (f32, f32) {
        match self {
            Item::Grenade => (t.grenade_charges, t.grenade_recharge),
            Item::Limpet => (t.limpet_charges, t.limpet_recharge),
            Item::Smoke => (t.smoke_charges, t.smoke_recharge),
            Item::Emp => (t.emp_charges, t.emp_recharge),
            Item::Orb => (t.orb_charges, t.orb_recharge),
            Item::Dome => (t.dome_charges, t.dome_recharge),
            Item::Barrier => (t.barrier_charges, t.barrier_recharge),
            Item::MgTurret => (t.mg_turret_charges, t.mg_turret_recharge),
            Item::RocketTurret => (t.rocket_turret_charges, t.rocket_turret_recharge),
        }
    }

    /// Whether it's thrown (`projectile::thrown`), rather than set down.
    pub fn thrown(self) -> bool {
        matches!(self, Item::Grenade | Item::Limpet | Item::Smoke)
    }
}

/// The offensive and support items weapons.json lists, in order.
fn lists() -> &'static [Vec<Item>; 2] {
    static ITEMS: OnceLock<[Vec<Item>; 2]> = OnceLock::new();
    ITEMS.get_or_init(|| {
        [Slot::Offensive, Slot::Support].map(|slot| {
            let ids = (0..).map_while(|i| crate::arsenal::weapon(slot, i)).map(|(id, _)| id);
            ids.map(|id| match id {
                "grenade" => Item::Grenade,
                "limpet" => Item::Limpet,
                "smoke" => Item::Smoke,
                "emp" => Item::Emp,
                "orb" => Item::Orb,
                "dome" => Item::Dome,
                "barrier" => Item::Barrier,
                "mg_turret" => Item::MgTurret,
                "rocket_turret" => Item::RocketTurret,
                _ => panic!("weapons.json lists item `{id}`, which does nothing"),
            })
            .collect()
        })
    })
}

impl Tuning {
    /// This tuning with thrown `item`'s ballistics in the secondary's `alt_*` fields, so it
    /// launches, flies and bursts through the same projectile code as a one-shell volley. All fly
    /// like the grenade; the Limpet sticks where it lands, and the Pall bursts harmlessly.
    pub fn thrown(&self, item: Item) -> Tuning {
        let grenade = Tuning {
            alt_count: 1.0,
            alt_spread_deg: 0.0,
            alt_cone: 0.0,
            alt_speed: self.grenade_speed,
            alt_speed_jitter: 0.0,
            alt_home_delay: 0.0,
            alt_loft_deg: self.grenade_loft_deg,
            alt_gravity: self.grenade_gravity,
            alt_bounce: self.grenade_bounce,
            alt_fuse: self.grenade_fuse,
            alt_damage: self.grenade_damage,
            alt_radius: self.grenade_radius,
            alt_stick: 0.0,
            alt_trigger: 0.0,
            alt_split: 0.0,
            alt_turn: 0.0,
            ..self.clone()
        };
        match item {
            Item::Limpet => Tuning { alt_bounce: 0.0, alt_stick: 1.0, alt_fuse: self.limpet_fuse, alt_damage: self.limpet_damage, alt_radius: self.limpet_radius, ..grenade },
            Item::Smoke => Tuning { alt_fuse: self.smoke_fuse, alt_damage: 0.0, ..grenade },
            _ => grenade,
        }
    }
}

/// `m` with both item slots full, for what it carries.
pub fn fill(t: &Tuning, m: &mut Mech) {
    m.grenades = Item::of(m.loadout, true).charges(t).0 as u8;
    m.emps = Item::of(m.loadout, false).charges(t).0 as u8;
}

/// One tick of `m`'s items: a jam wears off, charges come back, and a press spends one; with a
/// Limpet down, G sets it off instead.
pub(crate) fn step(t: &Tuning, m: &mut Mech, input: &Input) {
    // Half a tick of slack, like `slot`, so the jam ends on a whole tick.
    m.jammed = if m.jammed - DT < DT * 0.5 { 0.0 } else { m.jammed - DT };
    let (offensive, support) = (Item::of(m.loadout, true), Item::of(m.loadout, false));
    m.sprung = input.grenade && m.limpet;
    m.limpet &= !m.sprung;
    let (max, recharge) = offensive.charges(t);
    m.threw = slot(&mut m.grenades, &mut m.grenade_wait, max, recharge, input.grenade && !m.sprung);
    m.limpet |= m.threw && offensive == Item::Limpet;
    let (max, recharge) = support.charges(t);
    m.pulsed = slot(&mut m.emps, &mut m.emp_wait, max, recharge, input.emp);
}

/// A slot of up to `max` charges: below it, one comes back every `recharge` seconds, counted from
/// when it was first spent from full. Returns whether `press` spent one.
fn slot(charges: &mut u8, wait: &mut f32, max: f32, recharge: f32, press: bool) -> bool {
    let max = max as u8;
    if *charges < max {
        *wait -= DT;
        // Half a tick of slack so the charge lands on a whole tick despite float sums.
        if *wait < DT * 0.5 {
            *charges += 1;
            *wait = if *charges < max { *wait + recharge } else { 0.0 };
        }
    }
    let spent = press && *charges > 0;
    if spent {
        if *charges == max {
            *wait = recharge;
        }
        *charges -= 1;
    }
    spent
}

/// Where an EMP from `m` goes off: its chest.
pub fn emp_center(t: &Tuning, m: &Mech) -> Vector {
    m.pos + Vector::Y * (t.mech_height * 0.5)
}

/// Whether an EMP from `user` (tuned by `t`) reaches mech `m` (tuned by `tm`): its capsule
/// within `emp_radius`, with no arena in between. The same reach test as a secondary's splash.
pub fn emp_reaches(arena: &Arena, t: &Tuning, user: &Mech, tm: &Tuning, m: &Mech) -> bool {
    let reach = Tuning { alt_radius: t.emp_radius, alt_damage: 1.0, ..t.clone() };
    projectile::splash(arena, &reach, false, emp_center(t, user), tm, m) > 0.0
}

/// An EMP from a mech tuned by `t` reaches `m`: its fuel drains and its boost jams.
pub fn jam(t: &Tuning, m: &mut Mech) {
    m.fuel = (m.fuel - t.emp_drain).max(0.0);
    m.jammed = t.emp_jam;
}

/// Whether smoke in `clouds` lies across the sight line from `from` to `to`.
pub fn hidden<'a>(clouds: impl IntoIterator<Item = &'a Cloud>, from: Vector, to: Vector) -> bool {
    let d = to - from;
    clouds.into_iter().any(|c| {
        let along = (c.pos - from).dot(d) / d.length_squared().max(1e-6);
        (from + d * along.clamp(0.0, 1.0)).distance(c.pos) < c.radius
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arsenal::index;
    use crate::projectile::GRENADE;
    use crate::{Map, MechClass, Sim, TICK_HZ};

    /// An offline sim of a Medium carrying `offensive` and its own support item, aimed at the floor.
    fn armed(offensive: &str) -> Sim {
        let mut sim = Sim::with_map(Tuning::default(), Map::index("blockout").unwrap());
        sim.loadout = Loadout { offensive: index(Slot::Offensive, offensive), ..Loadout::of(MechClass::B) };
        sim.reset();
        sim
    }

    #[test]
    fn limpets_stick_until_g_sets_them_off() {
        let t = Tuning::default();
        let mut sim = armed("limpet");
        assert_eq!(sim.mech.grenades, t.limpet_charges as u8);
        let (aim, throw) = (Input { pitch: -0.5, ..Input::default() }, Input { pitch: -0.5, grenade: true, ..Input::default() });
        sim.step(&throw);
        assert!(sim.mech.threw && sim.mech.limpet);
        // It lands and sits there, well past the grenade's fuse, without bursting.
        for _ in 0..secs(5.0) {
            sim.step(&aim);
        }
        let stuck = sim.projectiles.iter().find(|p| projectile::item(p) == Some(Item::Limpet)).expect("no limpet down");
        assert_eq!(stuck.vel, Vector::ZERO, "never stuck");
        assert!(sim.blasts.is_empty(), "burst by itself");
        // G sets it off (spending nothing), and frees G to throw the next.
        let charges = sim.mech.grenades;
        sim.step(&throw);
        assert!(sim.mech.sprung && !sim.mech.threw && !sim.mech.limpet);
        sim.step(&aim);
        assert_eq!((sim.blasts.len(), sim.projectiles.len(), sim.mech.grenades), (1, 0, charges));
        assert!((sim.blasts[0].0 - t.limpet_radius).abs() < 1e-4);
    }

    #[test]
    fn smoke_bursts_into_a_cloud_that_fades() {
        let t = Tuning::default();
        let mut sim = armed("smoke");
        sim.step(&Input { pitch: -0.5, grenade: true, ..Input::default() });
        let mut ticks = 1;
        while sim.clouds.is_empty() {
            sim.step(&Input::default());
            ticks += 1;
            assert!(ticks < secs(t.smoke_fuse) + 2, "no cloud");
        }
        assert!(sim.blasts.is_empty(), "smoke exploded");
        let cloud = sim.clouds[0];
        assert!(hidden(&sim.clouds, cloud.pos - Vector::X * 20.0, cloud.pos + Vector::X * 20.0) && !hidden(&sim.clouds, cloud.pos + Vector::Z * 20.0, cloud.pos + Vector::new(20.0, 0.0, 20.0)));
        for _ in 0..secs(t.smoke_seconds) {
            sim.step(&Input::default());
        }
        assert!(sim.clouds.is_empty(), "the smoke never cleared");
    }

    #[test]
    fn grenades_fly_their_own_way_whatever_the_secondary() {
        // A mine layer's sticking and trigger are its shells', not the grenade's.
        let t = crate::Arsenal::new(&Tuning::default()).get(MechClass::B, Loadout::named("pike", "warren")).clone();
        let g = t.thrown(Item::Grenade);
        assert_eq!((g.alt_stick, g.alt_trigger, g.alt_bounce), (0.0, 0.0, t.grenade_bounce));
    }

    fn secs(s: f32) -> u32 {
        (s * TICK_HZ).round() as u32
    }

    #[test]
    fn charges_spend_and_recharge() {
        let t = Tuning::default();
        let mut sim = Sim::with_map(t.clone(), Map::index("blockout").unwrap());
        let (max, emps) = (t.grenade_charges as u8, t.emp_charges as u8);
        assert!(max >= 2 && emps >= 1, "test needs a few charges");
        assert_eq!((sim.mech.grenades, sim.mech.emps), (max, emps), "spawned without full charges");

        // Each press throws one until none are left; then a press does nothing.
        let throw = Input { grenade: true, ..Input::default() };
        for left in (0..max).rev() {
            sim.step(&throw);
            assert!(sim.mech.threw);
            assert_eq!(sim.mech.grenades, left);
        }
        sim.step(&throw);
        assert!(!sim.mech.threw, "threw with no charges");
        assert_eq!(sim.projectiles.iter().filter(|p| p.n == GRENADE).count(), usize::from(max));
        assert_eq!(sim.mech.emps, emps, "throwing spent an EMP");

        // One charge back per recharge, counted from the first throw, until full.
        let idle = Input::default();
        let mut ticks = u32::from(max); // the later throws and the dry press
        for want in 1..=max {
            while sim.mech.grenades < want {
                sim.step(&idle);
                ticks += 1;
            }
            let secs = ticks as f32 / TICK_HZ;
            assert!((secs - f32::from(want) * t.grenade_recharge).abs() <= DT, "charge {want} back after {secs} s");
        }
        for _ in 0..60 {
            sim.step(&idle);
        }
        assert_eq!((sim.mech.grenades, sim.mech.grenade_wait), (max, 0.0), "full slot kept counting");

        // The EMP slot spends on its own key.
        sim.step(&Input { emp: true, ..idle });
        assert!(sim.mech.pulsed && !sim.mech.threw);
        assert_eq!((sim.mech.grenades, sim.mech.emps), (max, emps - 1));
    }
}
