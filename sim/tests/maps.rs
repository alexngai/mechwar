//! Every compiled-in map: spawns are standable, the generated nav graph is connected, the twinned
//! maps are fair (180-degree symmetric), and bots can navigate Isotope, climb Foundry and spread
//! over all of it.

use sim::bot::{Bot, Nav, sees};
use sim::game::{Game, Mode, TEAM_SIZE};
use sim::map::{MAPS, ROTATION};
use sim::{Arena, Input, Loadout, Map, MechClass, TICK_HZ, Tuning, Vector, spawn_mech, step_mech};

#[test]
fn spawns_are_standable_for_every_class() {
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let arena = Arena::new(&map);
        if ROTATION.contains(name) && Mode::Deathmatch.fits(&map) {
            assert!(!map.dm_spawns.is_empty(), "{name}: plays Deathmatch with no spawns of its own");
        }
        for (team, spawns) in map.spawns.iter().chain([&map.dm_spawns]).enumerate() {
            assert!(team == 2 || spawns.len() >= TEAM_SIZE, "{name}: team {team} has {} spawns", spawns.len());
            for class in MechClass::ALL {
                let t = Tuning::default().for_class(class);
                for p in spawns {
                    let mut m = spawn_mech(&t, Vector::from_array(*p));
                    for _ in 0..TICK_HZ as u32 {
                        step_mech(&arena, &t, &mut m, &Input::default());
                    }
                    let drift = (m.pos - Vector::from_array(*p)).length();
                    assert!(m.grounded && drift < 0.5, "{name}: {class:?} at spawn {p:?} ended at {} (grounded {})", m.pos, m.grounded);
                }
            }
        }
    }
}

#[test]
fn nav_graph_connects_every_waypoint() {
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let nav = Nav::for_map(index);
        let reachable = nav.reachable(0);
        let stranded: Vec<_> = map.nav.iter().zip(&reachable).filter(|(_, r)| !**r).map(|(p, _)| *p).collect();
        assert!(stranded.is_empty(), "{name}: waypoints unreachable from {:?}: {stranded:?}", map.nav[0]);
        // Edges are one-way, so also check the way back.
        let stuck: Vec<_> = (0..map.nav.len()).filter(|&i| !nav.reachable(i)[0]).map(|i| map.nav[i]).collect();
        assert!(stuck.is_empty(), "{name}: waypoints with no way to {:?}: {stuck:?}", map.nav[0]);
    }
}

#[test]
fn objectives_stand_where_bots_can_reach_them() {
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let arena = Arena::new(&map);
        for base in map.objectives.bases.iter().flatten() {
            let ground = arena.cast_ray(&rapier3d::prelude::Ray::new(Vector::from_array(*base) + Vector::Y * 2.0, Vector::NEG_Y), 10.0);
            assert!(ground.is_some_and(|d| (d - 2.0).abs() < 1.0), "{name}: base {base:?} isn't on the ground");
        }
        let waypoints = Nav::for_map(index).points();
        if let Some(assault) = sim::objective::Assault::new(&map.objectives, waypoints) {
            for (silo, zone) in ["A", "B", "C"].iter().zip(&assault.silos) {
                assert!(!zone.rally.is_empty(), "{name}: silo {silo} at {} has no waypoint in it", zone.at);
            }
            for (silo, spot) in ["A", "B", "C"].iter().zip(&map.objectives.silos) {
                open_to_the_sky(name, &format!("silo {silo}'s launch pad"), &arena, spot);
            }
        }
        if let Some(siege) = sim::siege::Siege::new(&map.objectives, waypoints) {
            assert!(!siege.aa.rally.is_empty(), "{name}: the AA gun at {} has no waypoint in it", siege.aa.at);
            open_to_the_sky(name, "the AA gun", &arena, map.objectives.aa.as_ref().unwrap());
            for (zone, _) in &siege.stations {
                assert!(!zone.rally.is_empty(), "{name}: the station at {} has no waypoint in it", zone.at);
            }
        }
    }
}

#[test]
fn base_guns_stand_over_their_spawns() {
    for name in sim::map::ROTATION {
        let index = MAPS.iter().position(|(n, _)| *n == name).unwrap();
        let map = Map::load(index);
        let arena = Arena::new(&map);
        for (team, guns) in map.objectives.sentries.iter().enumerate() {
            assert_eq!(guns.len(), 2, "{name}: team {team} has {} base guns", guns.len());
            for at in guns.iter().map(|p| Vector::from_array(*p)) {
                // Off its base, where the map has them: clear of the base itself and the middle of its drop zone.
                if let Some(base) = map.objectives.bases.map(|b| b[team]) {
                    let off = Vector::new(at.x - base[0], 0.0, at.z - base[2]).length();
                    assert!(off >= 10.0, "{name}: base gun at {at} stands on its base ({off:.1} m from it)");
                }
                let ground = arena.cast_ray(&rapier3d::prelude::Ray::new(at + Vector::Y, Vector::NEG_Y), 2.0);
                assert!(ground.is_some_and(|d| (d - 1.0).abs() < 0.6), "{name}: base gun at {at} isn't on anything");
                assert!(arena.cast_ray(&rapier3d::prelude::Ray::new(at + Vector::Y * 0.2, Vector::Y), 7.0).is_none(), "{name}: base gun at {at} has no room for its tower");
                // Not in a doorway: walls either side closer than a mech can pass beside it.
                let room = |d: Vector| arena.cast_ray(&rapier3d::prelude::Ray::new(at + Vector::Y, d), 12.0).unwrap_or(12.0);
                assert!(room(Vector::X) + room(Vector::NEG_X) >= 12.0 && room(Vector::Z) + room(Vector::NEG_Z) >= 12.0, "{name}: base gun at {at} stands in a doorway");
                let gun = at + Vector::Y * sim::deploy::SENTRY_HEIGHT;
                let sees = map.spawns[team].iter().map(|p| Vector::from_array(*p) + Vector::Y * 2.0).filter(|s| arena.cast_ray(&rapier3d::prelude::Ray::new(gun, (*s - gun).normalize()), s.distance(gun) - 0.3).is_none()).count();
                assert!(sees >= 3, "{name}: base gun at {at} sees {sees} of its team's spawns");
            }
        }
    }
}

/// Capture the Flag: each team's flag stand is on something, with room for a Heavy under its roof,
/// hidden from its own base guns but open through its doorways, a waypoint in its zone, off its base.
#[test]
fn flag_stands_shelter_their_flags() {
    use rapier3d::prelude::Ray;
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let Some(flags) = map.objectives.flags else {
            assert!(!["foundry", "riftline", "canopy", "crashsite", "verdigris", "sinkhole"].contains(name), "{name}: no flag stands");
            continue;
        };
        let arena = Arena::new(&map);
        for (team, spot) in flags.iter().enumerate() {
            let at = Vector::from_array(spot.at);
            let what = format!("{name}: team {team}'s flag at {at}");
            assert!(arena.cast_ray(&Ray::new(at + Vector::Y, Vector::NEG_Y), 2.0).is_some(), "{what} isn't on anything");
            assert!(arena.cast_ray(&Ray::new(at + Vector::Y * 0.05, Vector::Y), 6.5).is_none(), "{what} has under 6.5 m of headroom");
            for gun in map.objectives.sentries[team].iter().map(|p| Vector::from_array(*p) + Vector::Y * sim::deploy::SENTRY_HEIGHT) {
                for p in [Vector::ZERO, Vector::X, Vector::NEG_X, Vector::Z, Vector::NEG_Z].map(|d| at + d * 3.0 + Vector::Y * 2.5) {
                    let d = p - gun;
                    assert!(arena.cast_ray(&Ray::new(gun, d / d.length()), d.length()).is_some(), "{what}: its base gun at {gun} sees {p}");
                }
            }
            let inside = |w: &[f32; 3]| Vector::new(w[0] - at.x, 0.0, w[2] - at.z).length() <= spot.radius && (w[1] - at.y).abs() <= spot.band;
            assert!(map.nav.iter().any(inside), "{what} has no waypoint in its zone");
            if let Some(base) = map.objectives.bases.map(|b| b[team]) {
                let off = Vector::new(at.x - base[0], 0.0, at.z - base[2]).length();
                assert!(off >= 14.0, "{what} is {off:.1} m from its base");
            }
            let open = (0..16)
                .map(|i| i as f32 * std::f32::consts::TAU / 16.0)
                .filter(|a| arena.cast_ray(&Ray::new(at + Vector::Y * 1.5, Vector::new(a.cos(), 0.0, a.sin())), 10.0).is_none())
                .count();
            assert!(open >= 2, "{what}: only {open} of 16 ways out past 10 m");
        }
    }
}

/// Convoy: exactly these maps have a route for the hauler (3.5 m round, 6.5 m tall), and it fits it all
/// the way, checked every meter along the line: ground under it (no more than half a meter over the
/// line, or 4 m under), no step over 0.6 m from the last meter's, nothing within 4 m either side at 1,
/// 3.5 and 6 m up nor overhead under 7 m, its side 2 m off each base gun's foot and well off the pads.
/// It runs from team 0's base to team 1's, and starts between its ends, as far to walk to either base
/// (within 10%), since the start is the middle of a tug of war.
#[test]
fn convoy_routes_fit_the_hauler() {
    use rapier3d::prelude::Ray;
    const CONVOY: [&str; 6] = ["span", "crashsite", "foundry", "riftline", "canopy", "walled"];
    let flat = |v: Vector| Vector::new(v.x, 0.0, v.z);
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let Some(route) = &map.objectives.convoy else {
            assert!(!CONVOY.contains(name), "{name}: no convoy route");
            continue;
        };
        assert!(CONVOY.contains(name), "{name}: a convoy route on a map not in the mode");
        let (points, start): (Vec<_>, _) = (route.points.iter().map(|p| Vector::from_array(*p)).collect(), route.start);
        assert!(start > 0 && start + 1 < points.len(), "{name}: the hauler starts at {start} of {} points, not between the ends", points.len());
        let bases = map.objectives.bases.expect("convoy maps have bases").map(Vector::from_array);
        for (end, base) in [points[0], points[points.len() - 1]].into_iter().zip(bases) {
            assert!(flat(end - base).length() <= 6.0, "{name}: the route ends at {end}, {:.1} m from the base at {base}", flat(end - base).length());
        }
        let walked = |p: &[Vector]| p.windows(2).map(|w| w[0].distance(w[1])).sum::<f32>();
        let [d0, d1] = [walked(&points[..=start]), walked(&points[start..])];
        assert!((d0 - d1).abs() <= 0.1 * d0.max(d1), "{name}: the hauler starts {d0:.0} m along its route from team 0's base and {d1:.0} m from team 1's");

        let arena = Arena::new(&map);
        let guns: Vec<_> = map.objectives.sentries.iter().flatten().map(|p| Vector::from_array(*p)).collect();
        let o = &map.objectives;
        let pads: Vec<_> = o.silos.iter().chain(&o.aa).map(|z| z.pad.unwrap_or(z.at)).chain(map.pads.iter().map(|p| p.at)).map(Vector::from_array).collect();
        let mut last: Option<f32> = None;
        for w in points.windows(2) {
            let dir = flat(w[1] - w[0]).normalize();
            let side = Vector::new(-dir.z, 0.0, dir.x);
            let n = flat(w[1] - w[0]).length().ceil() as usize;
            for k in 0..=n {
                let p = w[0] + (w[1] - w[0]) * (k as f32 / n as f32);
                // Down from a meter over the line. (A ray straight down a terrain cell's edge can miss it:
                // keep points, and runs along the grid, off the cell lines.)
                let ground = arena.cast_ray(&Ray::new(p + Vector::Y, Vector::NEG_Y), 5.0).map(|d| p.y + 1.0 - d);
                let g = ground.unwrap_or_else(|| panic!("{name}: no ground within 4 m under the route at {p}"));
                assert!(g <= p.y + 0.5, "{name}: the ground at {p} is {:.2} m over the route", g - p.y);
                if let Some(h) = last {
                    assert!((g - h).abs() <= 0.6, "{name}: a {:.2} m step under the route at {p}", (g - h).abs());
                }
                last = Some(g);
                let feet = Vector::new(p.x, g, p.z);
                for up in [1.0, 3.5, 6.0] {
                    for s in [side, -side] {
                        let hit = arena.cast_ray(&Ray::new(feet + Vector::Y * up, s), 4.0);
                        assert!(hit.is_none(), "{name}: something {:.1} m beside the hauler at {feet}, {up} m up", hit.unwrap_or(0.0));
                    }
                }
                let roof = arena.cast_ray(&Ray::new(feet + Vector::Y * 0.05, Vector::Y), 6.95);
                assert!(roof.is_none(), "{name}: a roof {:.1} m over the hauler at {feet}", roof.unwrap_or(0.0) + 0.05);
                for gun in &guns {
                    let off = flat(feet - *gun).length();
                    assert!(off >= 5.5, "{name}: the hauler at {feet} passes {off:.1} m from the base gun at {gun}");
                }
                // A silo's pad is a 7.2 m slab; jump pads and the AA gun are smaller.
                for pad in pads.iter().filter(|q| (q.y - g).abs() < 3.0) {
                    let off = flat(feet - *pad).length();
                    assert!(off >= 9.0, "{name}: the hauler at {feet} passes {off:.1} m from the pad at {pad}");
                }
            }
        }
    }
}

/// A silo's launch pad, or the AA gun, at `spot`'s `pad` (else its middle): on something, under
/// open sky for its rockets or its fire.
fn open_to_the_sky(name: &str, what: &str, arena: &Arena, spot: &sim::map::ZoneSpot) {
    let pad = Vector::from_array(spot.pad.unwrap_or(spot.at));
    let ground = arena.cast_ray(&rapier3d::prelude::Ray::new(pad + Vector::Y, Vector::NEG_Y), 2.0);
    assert!(ground.is_some_and(|d| (d - 1.0).abs() < 0.6), "{name}: {what} at {pad} isn't on anything");
    assert!(arena.cast_ray(&rapier3d::prelude::Ray::new(pad + Vector::Y * 0.5, Vector::Y), 80.0).is_none(), "{name}: {what} at {pad} is roofed");
}

/// Asymmetric by design: blockout (a test map), canopy and crashsite.
const ASYMMETRIC: [&str; 3] = ["blockout", "canopy", "crashsite"];

#[test]
fn maps_are_rotationally_symmetric() {
    for (index, (name, _)) in MAPS.iter().enumerate().filter(|(_, (name, _))| !ASYMMETRIC.contains(name)) {
        rotationally_symmetric(name, &Map::load(index));
    }
}

fn rotationally_symmetric(name: &str, map: &Map) {
    for s in &map.solids {
        let [x, y, z] = s.center;
        let twin = map.solids.iter().any(|t| {
            let same_place = (t.center[0] + x).abs() < 0.01 && (t.center[1] - y).abs() < 0.01 && (t.center[2] + z).abs() < 0.01;
            // An untilted box looks the same turned 180 degrees; a ramp must face the other way.
            let facing = s.tilt == 0.0 || ((t.yaw - s.yaw).rem_euclid(360.0) - 180.0).abs() < 0.01;
            same_place && t.half == s.half && t.tilt == s.tilt && facing
        });
        assert!(twin, "{name}: solid at {:?} has no 180-degree twin", s.center);
    }
    let [a, b] = &map.spawns;
    assert!(a.iter().zip(b).all(|(p, q)| p[0] == -q[0] && p[1] == q[1] && p[2] == -q[2]), "{name}: spawns aren't mirrored");
    let turned = |p: [f32; 3], q: [f32; 3]| (p[0] + q[0]).abs() < 0.01 && (p[1] - q[1]).abs() < 0.01 && (p[2] + q[2]).abs() < 0.01;
    for p in &map.dm_spawns {
        assert!(map.dm_spawns.iter().any(|q| turned(*p, *q)), "{name}: Deathmatch spawn {p:?} has no 180-degree twin");
    }
    for p in &map.pads {
        let twin = map.pads.iter().any(|q| turned(p.at, q.at) && turned(p.to, q.to) && p.apex == q.apex);
        assert!(twin, "{name}: pad at {:?} has no 180-degree twin", p.at);
    }
}

/// No mech gets off a map: thrown out over each edge above every wall, hovering and boosting
/// outward, it stays inside the map's size.
#[test]
fn mechs_stay_inside_the_map() {
    use std::f32::consts::{FRAC_PI_2, PI};
    let t = Tuning::default();
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let arena = Arena::new(&map);
        let [hx, hz] = map.size.map(|s| s / 2.0);
        for (out, yaw) in [(Vector::X, -FRAC_PI_2), (Vector::NEG_X, FRAC_PI_2), (Vector::Z, PI), (Vector::NEG_Z, 0.0)] {
            let mut m = spawn_mech(&t, Vector::new(out.x * (hx - 10.0), 40.0, out.z * (hz - 10.0)));
            m.vel = out * 40.0;
            let push = Input { move_z: 1.0, boost: true, hover: true, yaw, ..Input::default() };
            for _ in 0..(5.0 * TICK_HZ) as u32 {
                step_mech(&arena, &t, &mut m, &push);
                assert!(m.pos.x.abs() <= hx && m.pos.z.abs() <= hz, "{name}: a mech got off the map at {}", m.pos);
            }
        }
    }
}

/// Every jump pad, taken by a Heavy (the widest) with no input, lands where it's aimed and
/// stays there: nothing in the way of the arc, and the landing holds the slide after it.
#[test]
fn pads_land_where_aimed() {
    let t = Tuning::default().for_class(MechClass::C);
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let arena = Arena::new(&map);
        for pad in &map.pads {
            let (at, to) = (Vector::from_array(pad.at), Vector::from_array(pad.to));
            let mut m = spawn_mech(&t, at + Vector::Y * 0.1);
            let mut flew = false;
            for _ in 0..(6.0 * TICK_HZ) as u32 {
                step_mech(&arena, &t, &mut m, &Input::default());
                flew |= m.pad_arc;
                if flew && m.grounded {
                    break;
                }
            }
            let off = Vector::new(m.pos.x - to.x, 0.0, m.pos.z - to.z).length();
            assert!(flew && m.grounded && off < 2.0 && (m.pos.y - to.y).abs() < 0.5, "{name}: pad at {at} landed at {} (aimed at {to})", m.pos);
            for _ in 0..TICK_HZ as u32 {
                step_mech(&arena, &t, &mut m, &Input::default());
            }
            assert!((m.pos.y - to.y).abs() < 0.5, "{name}: from the pad at {at}, the landing at {to} slid off to {}", m.pos);
        }
    }
}

/// On a pad's arc steering and boost do nothing; a hover breaks the arc, and landing ends it.
#[test]
fn pad_arc_is_ballistic() {
    let map = Map::load(Map::index("riftline").unwrap());
    let (arena, t) = (Arena::new(&map), Tuning::default());
    let mut m = spawn_mech(&t, Vector::from_array(map.pads[0].at) + Vector::Y * 0.1);
    while !m.pad_arc {
        step_mech(&arena, &t, &mut m, &Input::default());
    }
    let flat = |m: &sim::Mech| Vector::new(m.vel.x, 0.0, m.vel.z);
    let (launch, push) = (flat(&m), Input { move_z: 1.0, move_x: 1.0, boost: true, ..Input::default() });
    for _ in 0..10 {
        step_mech(&arena, &t, &mut m, &push);
        assert!(m.pad_arc && !m.boosting && flat(&m) == launch, "steering or boost moved the arc: {} vs {launch}", flat(&m));
    }
    step_mech(&arena, &t, &mut m, &Input { hover: true, ..push });
    assert!(!m.pad_arc && m.hovering, "a hover should break the arc");

    let mut m = spawn_mech(&t, Vector::from_array(map.pads[0].at) + Vector::Y * 0.1);
    let mut flew = false;
    for _ in 0..(10.0 * TICK_HZ) as u32 {
        step_mech(&arena, &t, &mut m, &Input::default());
        flew |= m.pad_arc;
        if flew && m.grounded {
            break;
        }
    }
    assert!(flew && m.grounded && !m.pad_arc, "landing should end the arc");
}

#[test]
fn bot_reaches_the_far_catwalk_on_isotope() {
    let index = Map::index("isotope").unwrap();
    let (arena, nav, t) = (Arena::new(&Map::load(index)), Nav::for_map(index), Tuning::default());
    let mut me = spawn_mech(&t, Vector::new(-5.0, 0.1, 53.0));
    // Standing on the south team's catwalk deck, across the map.
    let target = spawn_mech(&t, Vector::new(47.0, 7.1, -22.0));
    assert!(!sees(&arena, &t, &me, &target), "target should start hidden");
    let mut bot = Bot::new(7);
    for tick in 0..(30.0 * TICK_HZ) as u32 {
        if sees(&arena, &t, &me, &target) {
            return;
        }
        let input = bot.think(&arena, nav, &t, &me, Some(&target), tick);
        step_mech(&arena, &t, &mut me, &input);
    }
    panic!("bot never got line of sight; ended at {}", me.pos);
}

/// At least four connected waypoints at each of `levels` (m).
fn has_levels(name: &str, levels: &[f32]) {
    let index = Map::index(name).unwrap();
    let map = Map::load(index);
    let reachable = Nav::for_map(index).reachable(0);
    for &level in levels {
        let count = map.nav.iter().zip(&reachable).filter(|(p, r)| **r && (p[1] - level).abs() < 0.5).count();
        assert!(count >= 4, "{name}: only {count} connected waypoints at {level} m");
    }
}

#[test]
fn foundry_has_four_levels() {
    has_levels("foundry", &[-5.0, 0.0, 7.0, 14.0]);
}

#[test]
fn verdigris_has_four_levels() {
    has_levels("verdigris", &[-7.0, 0.0, 7.0, 14.0]);
}

#[test]
fn riftline_has_five_levels() {
    has_levels("riftline", &[-24.0, -16.0, -8.0, 0.0, 10.0]);
}

/// A short-sighted bot (so it must get close to see) starting at `from` gets line of sight to a
/// target standing at `at` within `seconds`; returns where it ended up.
fn bot_reaches(map: &str, from: Vector, at: Vector, seconds: f32) -> Result<(), Vector> {
    let index = Map::index(map).unwrap();
    let t = Tuning { weapon_range: 12.0, ..Tuning::default() };
    let (arena, nav) = (Arena::new(&Map::load(index)), Nav::for_map(index));
    let (mut me, target) = (spawn_mech(&t, from), spawn_mech(&t, at));
    let mut bot = Bot::new(7);
    for tick in 0..(seconds * TICK_HZ) as u32 {
        if sees(&arena, &t, &me, &target) {
            return Ok(());
        }
        let input = bot.think(&arena, nav, &t, &me, Some(&target), tick);
        step_mech(&arena, &t, &mut me, &input);
    }
    Err(me.pos)
}

#[test]
fn bot_crosses_the_rift() {
    let map = Map::load(Map::index("riftline").unwrap());
    let ended = bot_reaches("riftline", Vector::from_array(map.spawns[0][0]), Vector::new(-15.0, 0.1, -50.0), 45.0);
    assert!(ended.is_ok(), "bot never got across the chasm; ended at {}", ended.unwrap_err());
}

#[test]
fn bot_takes_the_riftline_pad() {
    // A short-sighted bot on the chasm floor, after a target on the rim above the pad's landing.
    let index = Map::index("riftline").unwrap();
    let t = Tuning { weapon_range: 12.0, ..Tuning::default() };
    let (arena, nav) = (Arena::new(&Map::load(index)), Nav::for_map(index));
    let (mut me, target) = (spawn_mech(&t, Vector::new(-80.0, -23.9, 2.0)), spawn_mech(&t, Vector::new(-92.0, 0.1, 52.0)));
    let (mut bot, mut rode) = (Bot::new(7), false);
    for tick in 0..(8.0 * TICK_HZ) as u32 {
        if sees(&arena, &t, &me, &target) {
            assert!(rode, "bot got up without the pad");
            return;
        }
        let input = bot.think(&arena, nav, &t, &me, Some(&target), tick);
        step_mech(&arena, &t, &mut me, &input);
        rode |= me.pad_arc;
    }
    panic!("bot never rode the pad out of the chasm; ended at {}", me.pos);
}

#[test]
fn bot_climbs_out_of_the_rift() {
    let ended = bot_reaches("riftline", Vector::new(80.0, -23.9, 0.0), Vector::new(60.0, 0.1, 60.0), 40.0);
    assert!(ended.is_ok(), "bot never climbed out of the chasm; ended at {}", ended.unwrap_err());
}

#[test]
fn sump_has_three_levels() {
    has_levels("sump", &[-8.0, 0.0, 7.0]);
}

#[test]
fn bot_crosses_sump() {
    let map = Map::load(Map::index("sump").unwrap());
    let ended = bot_reaches("sump", Vector::from_array(map.spawns[0][0]), Vector::new(15.0, 0.1, -58.0), 45.0);
    assert!(ended.is_ok(), "bot never got across the deck; ended at {}", ended.unwrap_err());
}

#[test]
fn bot_climbs_out_of_the_sump() {
    // From the west end of the undercity's z = 28 street to the east roof, by a ramp well.
    let ended = bot_reaches("sump", Vector::new(-70.0, -7.9, 28.0), Vector::new(55.0, 7.1, 41.0), 40.0);
    assert!(ended.is_ok(), "bot never climbed out of the undercity; ended at {}", ended.unwrap_err());
}

#[test]
fn sinkhole_has_six_levels() {
    has_levels("sinkhole", &[-28.0, -21.0, -14.0, -7.0, 0.0, 8.0]);
}

/// Canopy can be crossed without touching the floor: from the crown over each base, its crowns
/// across the map and up to the mother tree's, over waypoints 20 m+ up only.
#[test]
fn canopy_crosses_by_its_crowns() {
    let nav = Nav::for_map(Map::index("canopy").unwrap());
    let crown = |x: f32, y: f32, z: f32| nav.points().iter().position(|p| p.distance(Vector::new(x, y, z)) < 0.5).expect("no waypoint on that crown");
    let (west, east) = (crown(-78.0, 27.0, -76.0), crown(78.0, 27.0, -76.0));
    for (from, to) in [(west, east), (east, west)] {
        let reached = nav.reachable_over(from, |p| p.y > 20.0);
        for goal in [to, crown(0.0, 36.0, 112.0), crown(-56.0, 30.0, 52.0), crown(92.0, 30.0, 16.0)] {
            assert!(reached[goal], "canopy: the crown at {} can't be reached over the canopy from {}", nav.points()[goal], nav.points()[from]);
        }
    }
}

#[test]
fn bot_crosses_sinkhole() {
    let map = Map::load(Map::index("sinkhole").unwrap());
    let ended = bot_reaches("sinkhole", Vector::from_array(map.spawns[0][0]), Vector::new(15.0, 0.1, -78.0), 45.0);
    assert!(ended.is_ok(), "bot never got across the pit; ended at {}", ended.unwrap_err());
}

#[test]
fn bot_climbs_out_of_the_sinkhole() {
    // From the pit floor up the spiral to the north rim.
    let ended = bot_reaches("sinkhole", Vector::new(8.5, -27.9, 8.5), Vector::new(-60.0, 0.1, 60.0), 50.0);
    assert!(ended.is_ok(), "bot never climbed out of the pit; ended at {}", ended.unwrap_err());
}

#[test]
fn bot_climbs_to_the_viaduct_on_verdigris() {
    let index = Map::index("verdigris").unwrap();
    let map = Map::load(index);
    // Short-sighted, so it has to get up there to see: the target stands on the far side of the ring.
    let t = Tuning { weapon_range: 10.0, ..Tuning::default() };
    let (arena, nav) = (Arena::new(&map), Nav::for_map(index));
    let mut me = spawn_mech(&t, Vector::from_array(map.spawns[0][0]));
    let target = spawn_mech(&t, Vector::new(0.0, 14.1, -32.0));
    let mut bot = Bot::new(7);
    for tick in 0..(40.0 * TICK_HZ) as u32 {
        if me.grounded && me.pos.y > 13.5 {
            return;
        }
        let input = bot.think(&arena, nav, &t, &me, Some(&target), tick);
        step_mech(&arena, &t, &mut me, &input);
    }
    panic!("bot never reached the viaduct; ended at {}", me.pos);
}

#[test]
fn bot_climbs_to_the_skybridge_on_foundry() {
    let index = Map::index("foundry").unwrap();
    let map = Map::load(index);
    // Short-sighted, so it can't spot the target from below and fight from there: it has to climb.
    let t = Tuning { weapon_range: 10.0, ..Tuning::default() };
    let (arena, nav) = (Arena::new(&map), Nav::for_map(index));
    let mut me = spawn_mech(&t, Vector::from_array(map.spawns[0][0]));
    // In the middle of the smelter roof, up with the skybridges.
    let target = spawn_mech(&t, Vector::new(0.0, 14.1, 0.0));
    assert!(!sees(&arena, &t, &me, &target), "target should start hidden");
    let mut bot = Bot::new(7);
    for tick in 0..(50.0 * TICK_HZ) as u32 {
        if me.grounded && me.pos.y > 13.5 {
            return;
        }
        let input = bot.think(&arena, nav, &t, &me, Some(&target), tick);
        step_mech(&arena, &t, &mut me, &input);
    }
    panic!("bot never reached the gantry level; ended at {}", me.pos);
}

#[test]
fn skybridge_drops_to_the_courtyard() {
    let arena = Arena::new(&Map::load(Map::index("foundry").unwrap()));
    // On the north skybridge, and on the courtyard floor beside it.
    let nav = Nav::generate(&arena, &[[-5.0, 14.0, 40.0], [-20.0, 0.0, 40.0]], &Tuning::default().for_class(MechClass::C));
    assert!(nav.reachable(0)[1], "no drop off the skybridge");
    assert!(!nav.reachable(1)[0], "climbed 14 m without a ramp");
}

#[test]
fn bots_spread_over_foundry() {
    // Bot samples in the channel, on the ground, decks and gantries; in the west and east lanes.
    // Three six-minute matches at once, pooled: any one match swings too much as bots group up
    // (in one, twelve minutes went by without a bot in the east lane).
    let matches: Vec<([usize; 4], [usize; 2], usize)> = std::thread::scope(|s| {
        let runs: Vec<_> = (0..3u32)
            .map(|seed| {
                s.spawn(move || {
                    let mut game = Game::new(Tuning::default(), Map::index("foundry").unwrap());
                    game.tick = seed * 7919;
                    let me = game.join().unwrap();
                    let (mut levels, mut lanes, mut n) = ([0; 4], [0; 2], 0);
                    for _ in 0..(360.0 * TICK_HZ) as u32 {
                        game.step();
                        // Relaunch from the hangar once destroyed, as a pilot would.
                        game.pick(me, MechClass::B, Loadout::of(MechClass::B));
                        for p in game.snapshot(me).players.iter().filter(|p| p.bot && p.view.health > 0.0) {
                            let pos = p.view.pos;
                            if let Some(level) = [-5.0, 0.0, 7.0, 14.0].iter().position(|y| (pos.y - y).abs() < 1.0) {
                                levels[level] += 1;
                            }
                            if pos.x.abs() > 60.0 {
                                lanes[usize::from(pos.x > 0.0)] += 1;
                            }
                            n += 1;
                        }
                    }
                    (levels, lanes, n)
                })
            })
            .collect();
        runs.into_iter().map(|r| r.join().unwrap()).collect()
    });
    let (mut levels, mut lanes, mut n) = ([0; 4], [0; 2], 0);
    for (l, w, k) in matches {
        (levels, lanes, n) = (std::array::from_fn(|i| levels[i] + l[i]), [lanes[0] + w[0], lanes[1] + w[1]], n + k);
    }
    let share = |count: usize| count as f32 / n as f32;
    let (levels, lanes) = (levels.map(share), lanes.map(share));
    let enough = levels.iter().zip([0.001, 0.0, 0.02, 0.005]).all(|(s, min)| *s > min) && lanes.iter().all(|s| *s > 0.003) && lanes[0] + lanes[1] > 0.02;
    assert!(enough, "too little time off the courtyard floor: levels {levels:?}, lanes {lanes:?}");
}
