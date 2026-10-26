//! Maps are JSON files in `maps/`, compiled in, so the server, the client's sim and the renderer
//! all read the same geometry. Only `solids` and `terrain` collide; `decor` is for the renderer.

use rapier3d::parry::utils::Array2;
use rapier3d::prelude::{ColliderBuilder, Rotation, Vector};
use serde::Deserialize;

/// Compiled-in maps. The index is what goes over the wire.
pub const MAPS: [(&str, &str); 12] = [
    ("isotope", include_str!("../../maps/isotope.json")),
    ("blockout", include_str!("../../maps/blockout.json")),
    ("foundry", include_str!("../../maps/foundry.json")),
    ("verdigris", include_str!("../../maps/verdigris.json")),
    ("riftline", include_str!("../../maps/riftline.json")),
    ("sump", include_str!("../../maps/sump.json")),
    ("sinkhole", include_str!("../../maps/sinkhole.json")),
    ("canopy", include_str!("../../maps/canopy.json")),
    ("crashsite", include_str!("../../maps/crashsite.json")),
    ("ziggurat", include_str!("../../maps/ziggurat.json")),
    ("span", include_str!("../../maps/span.json")),
    ("walled", include_str!("../../maps/walled.json")),
];
/// Foundry.
pub const DEFAULT: usize = 2;
/// Maps the server rotates through between matches (blockout is a test map).
pub const ROTATION: [&str; 11] = ["foundry", "isotope", "verdigris", "riftline", "sump", "sinkhole", "canopy", "crashsite", "ziggurat", "span", "walled"];

#[derive(Deserialize, Clone, Debug)]
pub struct Solid {
    #[serde(rename = "box")]
    pub center: [f32; 3],
    pub half: [f32; 3],
    /// Degrees about Y, applied after `tilt`.
    #[serde(default)]
    pub yaw: f32,
    /// Degrees about X; positive raises the -Z end (ramps).
    #[serde(default)]
    pub tilt: f32,
    #[serde(default)]
    pub shape: Shape,
}

/// A solid's shape. A cylinder's radius is `half[0]` and its axis local Y, `half[1]` each way.
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    #[default]
    Box,
    Cylinder,
}

/// Ground heights on a grid over the whole map: `heights[row][col]` stands at
/// x = col * cell - width / 2, z = row * cell - depth / 2. Each cell is two triangles split along
/// its (x0, z1)-(x1, z0) diagonal, as Rapier's heightfield splits them; the renderer draws the same.
#[derive(Deserialize, Clone, Debug)]
pub struct Terrain {
    pub cell: f32,
    pub heights: Vec<Vec<f32>>,
}

/// A jump pad: a mech standing on `at` is thrown over an arc topping out at height `apex` that
/// lands on `to`.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Pad {
    pub at: [f32; 3],
    pub to: [f32; 3],
    pub apex: f32,
}

/// A capture zone: mechs with their feet within `radius` of `at` across, and `band` up or down,
/// stand in it. A silo's `pad` is where its launch pad lies (on a surface, under open sky): in the
/// zone, or over it where the zone is roofed.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct ZoneSpot {
    pub at: [f32; 3],
    pub radius: f32,
    pub band: f32,
    #[serde(default)]
    pub pad: Option<[f32; 3]>,
}

/// A Convoy route: points on walkable ground from team 0's base through the middle to team 1's,
/// and the index of the one the hauler starts at (the middle).
#[derive(Deserialize, Clone, Debug)]
pub struct Route {
    pub points: Vec<[f32; 3]>,
    pub start: usize,
}

/// Where a map's objective modes play.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Objectives {
    /// Each team's base, team 0's first: where missiles land.
    #[serde(default)]
    pub bases: Option<[[f32; 3]; 2]>,
    /// Missile Assault's silos: A (team 0's side), B, C.
    #[serde(default)]
    pub silos: Vec<ZoneSpot>,
    /// Siege's energy station (one, mid-map, for the teams to fight over), its anti-air gun's
    /// zone, and how high its ships cruise.
    #[serde(default)]
    pub stations: Vec<ZoneSpot>,
    #[serde(default)]
    pub aa: Option<ZoneSpot>,
    #[serde(default)]
    pub sky: Option<f32>,
    /// Each team's base guns (team 0's first), in every team mode: where each stands.
    #[serde(default)]
    pub sentries: [Vec<[f32; 3]>; 2],
    /// Capture the Flag: each team's flag stand (team 0's first), its zone inside the shelter.
    #[serde(default)]
    pub flags: Option<[ZoneSpot; 2]>,
    /// Convoy: the hauler's route.
    #[serde(default)]
    pub convoy: Option<Route>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Map {
    pub name: String,
    pub solids: Vec<Solid>,
    /// Feet positions per team, one per slot.
    pub spawns: [Vec<[f32; 3]>; 2],
    /// Deathmatch's spawns beyond the teams' (it uses both); the team modes never spawn here.
    #[serde(default)]
    pub dm_spawns: Vec<[f32; 3]>,
    /// Bot waypoints; `bot::Nav` generates the edges by walking between them.
    pub nav: Vec<[f32; 3]>,
    #[serde(default)]
    pub pads: Vec<Pad>,
    /// Width (x) and depth (z), centered on the origin: the perimeter walls stand on its edge.
    pub size: [f32; 2],
    #[serde(default)]
    pub terrain: Option<Terrain>,
    #[serde(default)]
    pub objectives: Objectives,
}

impl Map {
    pub fn load(index: usize) -> Map {
        serde_json::from_str(MAPS[index].1).expect("compiled-in map is valid")
    }

    pub fn index(name: &str) -> Option<usize> {
        MAPS.iter().position(|(n, _)| *n == name)
    }

    /// The arena's static colliders: every solid, then the terrain if there is one.
    pub fn colliders(&self) -> impl Iterator<Item = ColliderBuilder> + '_ {
        let solids = self.solids.iter().map(|b| {
            let [hx, hy, hz] = b.half;
            let rotation = Rotation::from_rotation_y(b.yaw.to_radians()) * Rotation::from_rotation_x(b.tilt.to_radians());
            let shape = match b.shape {
                Shape::Box => ColliderBuilder::cuboid(hx, hy, hz),
                Shape::Cylinder => ColliderBuilder::cylinder(hy, hx),
            };
            shape.translation(Vector::from_array(b.center)).rotation(rotation.to_scaled_axis())
        });
        let terrain = self.terrain.as_ref().map(|t| {
            let (rows, cols) = (t.heights.len(), t.heights[0].len());
            let fits = |n: usize, size: f32| (n - 1) as f32 * t.cell == size;
            assert!(fits(cols, self.size[0]) && fits(rows, self.size[1]), "{}: terrain grid doesn't span the map", self.name);
            // Rapier wants rows along Z and columns along X, stored column by column.
            let heights = (0..cols).flat_map(|c| t.heights.iter().map(move |row| row[c])).collect();
            ColliderBuilder::heightfield(Array2::new(rows, cols, heights), Vector::new(self.size[0], 1.0, self.size[1]))
        });
        solids.chain(terrain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Arena, Input, MechClass, TICK_HZ, Tuning, spawn_mech, step_mech};
    use rapier3d::prelude::Ray;

    /// A `size` m square map with nothing in it but terrain on `cell` m cells at `height(x, z)`.
    fn hills(size: f32, cell: f32, height: impl Fn(f32, f32) -> f32) -> Map {
        let n = (size / cell) as usize + 1;
        let at = |i: usize| i as f32 * cell - size / 2.0;
        let heights = (0..n).map(|r| (0..n).map(|c| height(at(c), at(r))).collect()).collect();
        Map { name: "hills".into(), solids: vec![], spawns: [vec![], vec![]], dm_spawns: vec![], nav: vec![], pads: vec![], size: [size, size], terrain: Some(Terrain { cell, heights }), objectives: Objectives::default() }
    }

    /// The ground at (x, z) on the triangles `Terrain` documents (maps/kit.mjs's `heightAt`).
    fn ground(map: &Map, x: f32, z: f32) -> f32 {
        let t = map.terrain.as_ref().unwrap();
        let (u, v) = ((x + map.size[0] / 2.0) / t.cell, (z + map.size[1] / 2.0) / t.cell);
        let (c, r) = (u.floor() as usize, v.floor() as usize);
        let (fu, fv, h) = (u - c as f32, v - r as f32, |r: usize, c: usize| t.heights[r][c]);
        if fu + fv <= 1.0 {
            h(r, c) + fu * (h(r, c + 1) - h(r, c)) + fv * (h(r + 1, c) - h(r, c))
        } else {
            h(r + 1, c + 1) + (1.0 - fu) * (h(r + 1, c) - h(r + 1, c + 1)) + (1.0 - fv) * (h(r, c + 1) - h(r + 1, c + 1))
        }
    }

    #[test]
    fn terrain_collides_where_its_grid_says() {
        let map = hills(40.0, 4.0, |x, z| (x * 0.37).sin() * 3.0 + (z * 0.23).cos() * 2.0 + (x * z * 0.05).sin());
        let arena = Arena::new(&map);
        for i in 0..200 {
            let (x, z) = ((i % 20) as f32 * 1.93 - 18.7, (i / 20) as f32 * 3.71 - 18.1);
            let down = arena.cast_ray(&Ray::new(Vector::new(x, 50.0, z), Vector::NEG_Y), 100.0).expect("terrain under every point");
            assert!((50.0 - down - ground(&map, x, z)).abs() < 1e-3, "at ({x}, {z}): hit {} m, grid says {}", 50.0 - down, ground(&map, x, z));
        }
    }

    /// Where a Medium ends up after walking +X for 3 s from x = -10 toward a hill rising from x = 0.
    fn climb(degrees: f32) -> Vector {
        let rise = degrees.to_radians().tan();
        let arena = Arena::new(&hills(80.0, 4.0, |x, _| x.max(0.0) * rise));
        let t = Tuning::default().for_class(MechClass::B);
        let mut m = spawn_mech(&t, Vector::new(-10.0, 0.1, 0.0));
        let walk = Input { move_z: 1.0, yaw: -std::f32::consts::FRAC_PI_2, ..Input::default() };
        for _ in 0..(3.0 * TICK_HZ) as usize {
            step_mech(&arena, &t, &mut m, &walk);
        }
        m.pos
    }

    #[test]
    fn walks_up_slopes_not_cliffs() {
        let gentle = climb(25.0);
        assert!(gentle.x > 12.0 && gentle.y > 5.0, "stalled on a 25 degree hill at {gentle}");
        let steep = climb(55.0);
        assert!(steep.x < 2.0, "climbed a 55 degree slope to {steep}");
    }

    #[test]
    fn crosses_rolling_hills_without_snagging() {
        // Gentle bumps (under 20 degrees) on 4 m cells, walked across the grain of the triangles.
        let map = hills(160.0, 4.0, |x, z| (x * 0.13).sin() * 2.5 + (z * 0.11).cos() * 2.5 + (x * 0.31 + z * 0.27).sin() * 0.6);
        let arena = Arena::new(&map);
        let t = Tuning::default().for_class(MechClass::C);
        for yaw in [0.3f32, 1.1, 2.0, 2.9, 4.0, 5.3] {
            let mut m = spawn_mech(&t, Vector::new(0.0, ground(&map, 0.0, 0.0) + 0.1, 0.0));
            let walk = Input { move_z: 1.0, yaw, ..Input::default() };
            for _ in 0..(4.0 * TICK_HZ) as usize {
                step_mech(&arena, &t, &mut m, &walk);
            }
            let went = Vector::new(m.pos.x, 0.0, m.pos.z).length();
            assert!(went > 0.8 * 4.0 * t.walk_speed, "yaw {yaw}: only {went} m in 4 s");
            assert!((m.pos.y - ground(&map, m.pos.x, m.pos.z)).abs() < 0.5, "yaw {yaw}: feet {} over ground {}", m.pos.y, ground(&map, m.pos.x, m.pos.z));
        }
    }

    #[test]
    fn cylinders_are_round() {
        let post = Solid { center: [0.0, 5.0, 0.0], half: [2.0, 5.0, 2.0], yaw: 0.0, tilt: 0.0, shape: Shape::Cylinder };
        let arena = Arena::new(&Map { solids: vec![post], terrain: None, ..hills(40.0, 40.0, |_, _| 0.0) });
        // Along the diagonal a box's corner would stand 2.83 m out; the cylinder's side is 2 m out.
        let toward = Vector::new(-1.0, 0.0, -1.0).normalize();
        let hit = arena.cast_ray(&Ray::new(Vector::new(10.0, 5.0, 10.0), toward), 30.0).unwrap();
        assert!((hit - (200.0f32.sqrt() - 2.0)).abs() < 0.01, "hit at {hit}");
    }
}
