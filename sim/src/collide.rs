//! Mech-vs-mech contact. Mechs are vertical capsules: after movement, touching pairs are pushed
//! apart along the ground plane and lose the velocity that carried them into each other. The
//! server runs this for every pair each tick; the client runs it against other mechs' last known
//! positions to predict being blocked.

use rapier3d::control::{CharacterLength, KinematicCharacterController};
use rapier3d::prelude::Pose;

use crate::{Arena, DT, Mech, Tuning, Vector, mech_capsule};

/// Ground-plane normal from `b` toward `a` and how deep they overlap, if they touch.
/// Dead mechs don't collide, and a mech hovering above another passes over it.
pub fn contact(ta: &Tuning, a: &Mech, tb: &Tuning, b: &Mech) -> Option<(Vector, f32)> {
    if a.health <= 0.0 || b.health <= 0.0 {
        return None;
    }
    let d = Vector::new(a.pos.x - b.pos.x, 0.0, a.pos.z - b.pos.z);
    let dist = d.length();
    let overlap = mech_capsule(ta).radius + mech_capsule(tb).radius - dist;
    let level = a.pos.y < b.pos.y + tb.mech_height && b.pos.y < a.pos.y + ta.mech_height;
    // Exactly stacked: part along +X so the result stays deterministic.
    (overlap > 0.0 && level).then(|| (if dist > 1e-4 { d / dist } else { Vector::X }, overlap))
}

/// Moves `m` by `push` through the arena, so walls stop it; returns how far it actually went.
fn shove(arena: &Arena, t: &Tuning, m: &mut Mech, push: Vector) -> Vector {
    let controller = KinematicCharacterController { offset: CharacterLength::Absolute(t.skin), ..Default::default() };
    let pose = Pose::from_translation(m.pos + Vector::Y * (t.mech_height * 0.5));
    let moved = controller.move_shape(DT, &arena.world.query_pipeline(), &mech_capsule(t), &pose, push, |_| {}).translation;
    m.pos += moved;
    moved
}

/// Separates `a` and `b` if they touch. `share` is `a`'s part of the push: `b`'s mass over the
/// total, or 1.0 when `b` is a fixed obstacle (client prediction). Whatever a wall stops one
/// from taking goes to the other. Along the contact the pair ends with one shared, mass-weighted
/// velocity, so a heavy mech keeps most of its speed and carries a light one with it.
pub fn separate(arena: &Arena, ta: &Tuning, a: &mut Mech, tb: &Tuning, b: &mut Mech, share: f32) {
    let Some((n, overlap)) = contact(ta, a, tb, b) else { return };
    let moved_a = shove(arena, ta, a, n * (overlap * share)).dot(n);
    let moved_b = -shove(arena, tb, b, -n * (overlap - moved_a)).dot(n);
    let left = overlap - moved_a - moved_b;
    if left > 1e-4 {
        shove(arena, ta, a, n * left);
    }

    let (va, vb) = (a.vel.dot(n), b.vel.dot(n));
    if va < vb {
        // Closing: n points from b to a, so a moving toward b has the smaller component.
        let common = (1.0 - share) * va + share * vb;
        a.vel += n * (common - va);
        b.vel += n * (common - vb);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Input, Map, MechClass, TICK_HZ, spawn_mech, step_mech};

    fn setup(class: MechClass, pos: [f32; 3]) -> (Tuning, Mech) {
        let t = Tuning::default().for_class(class);
        let m = Mech { class, ..spawn_mech(&t, Vector::from_array(pos)) };
        (t, m)
    }

    fn mass_share(ta: &Tuning, tb: &Tuning) -> f32 {
        tb.mech_mass / (ta.mech_mass + tb.mech_mass)
    }

    /// A Heavy at `bulwark_x` walks +X along z = 0 into a standing Light; returns both after `secs`.
    fn bulwark_into_wisp(bulwark_x: f32, wisp_x: f32, secs: f32, mut each_tick: impl FnMut(&Tuning, &Mech, &Tuning, &Mech)) -> (Mech, Mech) {
        let arena = Arena::new(&Map::load(Map::index("blockout").unwrap()));
        let (tc, mut c) = setup(MechClass::C, [bulwark_x, 0.1, 0.0]);
        let (ta, mut a) = setup(MechClass::A, [wisp_x, 0.1, 0.0]);
        let walk = Input { move_z: 1.0, yaw: -std::f32::consts::FRAC_PI_2, ..Input::default() }; // facing +X
        for _ in 0..(secs * TICK_HZ) as u32 {
            step_mech(&arena, &tc, &mut c, &walk);
            step_mech(&arena, &ta, &mut a, &Input::default());
            separate(&arena, &tc, &mut c, &ta, &mut a, mass_share(&tc, &ta));
            each_tick(&tc, &c, &ta, &a);
        }
        (c, a)
    }

    #[test]
    fn heavy_shoves_light() {
        // Open ground: nothing between x = -10 and the east wall at 50.
        let start = -6.0;
        let (c, a) = bulwark_into_wisp(-10.0, start, 2.5, |_, _, _, _| {});
        let tc = Tuning::default().for_class(MechClass::C);
        assert!(a.pos.x - start >= 2.0, "wisp only moved {} m", a.pos.x - start);
        assert!(c.vel.x >= 0.6 * tc.walk_speed, "bulwark slowed to {} m/s", c.vel.x);
    }

    #[test]
    fn shove_respects_walls() {
        // The east wall's inner face is at x = 50; start the Light just off it.
        let ta = Tuning::default().for_class(MechClass::A);
        let wall = 50.0 - mech_capsule(&ta).radius;
        bulwark_into_wisp(40.0, wall - 0.2, 4.0, |tc, c, ta, a| {
            assert!(a.pos.x <= wall + 0.02, "wisp pushed into the wall: x = {}", a.pos.x);
            let gap = Vector::new(c.pos.x - a.pos.x, 0.0, c.pos.z - a.pos.z).length();
            let touching = mech_capsule(tc).radius + mech_capsule(ta).radius;
            assert!(gap >= touching - 0.02, "bulwark pushed through the pinned wisp: gap {gap}");
        });
    }
}
