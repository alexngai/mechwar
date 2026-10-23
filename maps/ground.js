// Terrain heights, for the map generators (kit.mjs) and the renderer (web/arena.js) alike.

/** The height of `terrain` ({ cell, heights }) on a `w` x `d` map at (x, z), on the triangles the sim collides with (sim/src/map.rs `Terrain`). */
export function heightAt({ cell, heights: h }, [w, d], x, z) {
  const u = Math.min(Math.max((x + w / 2) / cell, 0), w / cell - 1e-6), v = Math.min(Math.max((z + d / 2) / cell, 0), d / cell - 1e-6);
  const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r;
  // Each cell splits along its (x0, z1)-(x1, z0) diagonal.
  return fu + fv <= 1
    ? h[r][c] + fu * (h[r][c + 1] - h[r][c]) + fv * (h[r + 1][c] - h[r][c])
    : h[r + 1][c + 1] + (1 - fu) * (h[r + 1][c] - h[r + 1][c + 1]) + (1 - fv) * (h[r][c + 1] - h[r + 1][c + 1]);
}
