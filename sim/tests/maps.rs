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
