//! Every compiled-in map: spawns are standable, the generated nav graph is connected, and
//! Saltworks is fair (180-degree symmetric) and navigable by bots.

use sim::bot::{Bot, Nav, sees};
use sim::game::TEAM_SIZE;
use sim::map::MAPS;
use sim::{Arena, Input, Map, MechClass, TICK_HZ, Tuning, Vector, spawn_mech, step_mech};

#[test]
fn spawns_are_standable_for_every_class() {
    for (index, (name, _)) in MAPS.iter().enumerate() {
        let map = Map::load(index);
        let arena = Arena::new(&map);
        for (team, spawns) in map.spawns.iter().enumerate() {
            assert!(spawns.len() >= TEAM_SIZE, "{name}: team {team} has {} spawns", spawns.len());
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
        let reachable = Nav::for_map(index).reachable(0);
        let stranded: Vec<_> = map.nav.iter().zip(&reachable).filter(|(_, r)| !**r).map(|(p, _)| *p).collect();
        assert!(stranded.is_empty(), "{name}: waypoints unreachable from {:?}: {stranded:?}", map.nav[0]);
    }
}

#[test]
fn saltworks_is_rotationally_symmetric() {
    let map = Map::load(Map::index("saltworks").unwrap());
    for s in &map.solids {
        let [x, y, z] = s.center;
        let twin = map.solids.iter().any(|t| {
            let same_place = (t.center[0] + x).abs() < 0.01 && (t.center[1] - y).abs() < 0.01 && (t.center[2] + z).abs() < 0.01;
            // An untilted box looks the same turned 180 degrees; a ramp must face the other way.
            let facing = s.tilt == 0.0 || ((t.yaw - s.yaw).rem_euclid(360.0) - 180.0).abs() < 0.01;
            same_place && t.half == s.half && t.tilt == s.tilt && facing
        });
        assert!(twin, "solid at {:?} has no 180-degree twin", s.center);
    }
    let [a, b] = &map.spawns;
    assert!(a.iter().zip(b).all(|(p, q)| p[0] == -q[0] && p[1] == q[1] && p[2] == -q[2]), "spawns aren't mirrored");
}

#[test]
fn bot_reaches_the_far_catwalk_on_saltworks() {
    let index = Map::index("saltworks").unwrap();
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
