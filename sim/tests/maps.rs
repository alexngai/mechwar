//! Every compiled-in map: spawns are standable, the generated nav graph is connected, the real
//! maps are fair (180-degree symmetric), and bots can navigate Saltworks, climb Foundry and spread
//! over all of it.

use sim::bot::{Bot, Nav, sees};
use sim::game::{Game, TEAM_SIZE};
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
fn maps_are_rotationally_symmetric() {
    for (index, (name, _)) in MAPS.iter().enumerate().filter(|(_, (name, _))| *name != "blockout") {
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

#[test]
fn foundry_has_four_levels() {
    let index = Map::index("foundry").unwrap();
    let map = Map::load(index);
    let reachable = Nav::for_map(index).reachable(0);
    for level in [-5.0, 0.0, 7.0, 14.0] {
        let count = map.nav.iter().zip(&reachable).filter(|(p, r)| **r && (p[1] - level).abs() < 0.5).count();
        assert!(count >= 4, "only {count} connected waypoints at {level} m");
    }
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
    let mut game = Game::new(Tuning::default(), Map::index("foundry").unwrap());
    let me = game.join().unwrap();
    // Bot samples in the channel, on the ground, decks and gantries; in the west and east lanes.
    let (mut levels, mut lanes, mut n) = ([0; 4], [0; 2], 0);
    // Six minutes: shorter runs swing too much as bots group up early on.
    for _ in 0..(360.0 * TICK_HZ) as u32 {
        game.step();
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
    let share = |count: usize| count as f32 / n as f32;
    let (levels, lanes) = (levels.map(share), lanes.map(share));
    let enough = levels.iter().zip([0.005, 0.0, 0.02, 0.005]).all(|(s, min)| *s > min) && lanes.iter().all(|s| *s > 0.005) && lanes[0] + lanes[1] > 0.03;
    assert!(enough, "too little time off the courtyard floor: levels {levels:?}, lanes {lanes:?}");
}
