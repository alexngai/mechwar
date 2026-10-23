//! Items: an offensive and a support slot per mech, each holding charges that come back one at a
//! time. `step` runs inside `step_mech`, so the client predicts charges like fuel. A thrown
//! grenade is a projectile (`projectile::grenade`); an EMP's effect on others is the server's,
//! through `emp_reaches` and `jam`.

use crate::projectile;
use crate::{Arena, DT, Input, Mech, Tuning, Vector};

impl Tuning {
    /// This tuning with the grenade's ballistics in the secondary's `alt_*` fields, so a grenade
    /// launches, flies and bursts through the same projectile code as a one-shell volley.
    pub fn grenade(&self) -> Tuning {
        Tuning {
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
            ..self.clone()
        }
    }
}

/// One tick of `m`'s items: a jam wears off, charges come back, and a press spends one.
pub(crate) fn step(t: &Tuning, m: &mut Mech, input: &Input) {
    // Half a tick of slack, like `slot`, so the jam ends on a whole tick.
    m.jammed = if m.jammed - DT < DT * 0.5 { 0.0 } else { m.jammed - DT };
    m.threw = slot(&mut m.grenades, &mut m.grenade_wait, t.grenade_charges, t.grenade_recharge, input.grenade);
    m.pulsed = slot(&mut m.emps, &mut m.emp_wait, t.emp_charges, t.emp_recharge, input.emp);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projectile::GRENADE;
    use crate::{Map, Sim, TICK_HZ};

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
