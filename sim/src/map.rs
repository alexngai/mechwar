//! Maps are JSON files in `maps/`, compiled in, so the server, the client's sim and the renderer
//! all read the same geometry. Only `solids` collide; `decor` is for the renderer.

use serde::Deserialize;

/// Compiled-in maps. The index is what goes over the wire.
pub const MAPS: [(&str, &str); 4] = [
    ("saltworks", include_str!("../../maps/saltworks.json")),
    ("blockout", include_str!("../../maps/blockout.json")),
    ("foundry", include_str!("../../maps/foundry.json")),
    ("verdigris", include_str!("../../maps/verdigris.json")),
];
/// Foundry.
pub const DEFAULT: usize = 2;
/// Maps the server rotates through between matches (blockout is a test map).
pub const ROTATION: [&str; 3] = ["foundry", "saltworks", "verdigris"];

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
}

#[derive(Deserialize, Clone, Debug)]
pub struct Map {
    pub name: String,
    pub solids: Vec<Solid>,
    /// Feet positions per team, one per slot.
    pub spawns: [Vec<[f32; 3]>; 2],
    /// Bot waypoints; `bot::Nav` generates the edges by walking between them.
    pub nav: Vec<[f32; 3]>,
}

impl Map {
    pub fn load(index: usize) -> Map {
        serde_json::from_str(MAPS[index].1).expect("compiled-in map is valid")
    }

    pub fn index(name: &str) -> Option<usize> {
        MAPS.iter().position(|(n, _)| *n == name)
    }
}
