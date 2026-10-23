// Glass HUD: one canvas over the game, redrawn each frame from the `frame` object main.js fills.
// Our own layout: an aim frame (heat on both arcs, the secondary's recharge and a slow gun's
// refire inside them) around spread ticks at the aim point, target tags and damage arcs. The
// mech's state (hull, fuel, systems), radar, speed and altitude are on the cockpit's dash
// (cockpit.js, which draws the radar with `radar` below); only in the chase view, where the dash
// isn't seen, does the glass show the radar and hull. Everything is drawn in device pixels scaled
// by `u` (1/1000 of the height).

const AMBER = '#ffc46a', DIM = 'rgba(255,196,106,0.35)', FAINT = 'rgba(255,196,106,0.14)', WARN = '#ff4a3a', FUEL = '#7fd8ff', REPAIR = '#6dff9a';
const TAU = Math.PI * 2;
const RADAR_RANGE = 90; // m
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * Where world point (x, z) sits relative to a viewer at (mx, mz) facing `yaw`: `right` and
 * `ahead` in meters, and the clockwise bearing from straight ahead in radians.
 */
export function relative(mx, mz, yaw, x, z) {
  const dx = x - mx, dz = z - mz, c = Math.cos(yaw), s = Math.sin(yaw);
  const right = dx * c - dz * s, ahead = -dx * s - dz * c;
  return { right, ahead, bearing: Math.atan2(right, ahead) };
}

/** Heading in degrees, 0 facing -Z (north on the radar), rising as the view turns right. */
export const headingDeg = (yaw) => ((((-yaw * 180) / Math.PI) % 360) + 360) % 360;

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.radarMap = null;
  }

  /**
   * Pre-draws the map top-down for the radar: the terrain (lighter for higher, cliffs too steep
   * to climb bright as walls) under the solids (brighter for taller).
   */
  setMap(map) {
    const solids = map.solids.filter((s) => s.box[1] + s.half[1] > 0.3);
    const ext = (s) => Math.hypot(s.half[0], s.half[2]);
    const t = map.terrain, [w, d] = t ? map.size : [-Infinity, -Infinity];
    const minX = Math.min(-w / 2, ...solids.map((s) => s.box[0] - ext(s))), maxX = Math.max(w / 2, ...solids.map((s) => s.box[0] + ext(s)));
    const minZ = Math.min(-d / 2, ...solids.map((s) => s.box[2] - ext(s))), maxZ = Math.max(d / 2, ...solids.map((s) => s.box[2] + ext(s)));
    const scale = 4; // px per m
    const c = document.createElement('canvas');
    c.width = Math.ceil((maxX - minX) * scale);
    c.height = Math.ceil((maxZ - minZ) * scale);
    const g = c.getContext('2d');
    if (t) {
      const h = t.heights, all = h.flat(), lo = Math.min(...all), span = Math.max(...all) - lo || 1;
      const steep = Math.tan((40 * Math.PI) / 180) * t.cell, px = t.cell * scale;
      for (let r = 0; r < h.length - 1; r++) {
        for (let k = 0; k < h[r].length - 1; k++) {
          const a = h[r][k], b = h[r][k + 1], e = h[r + 1][k], f = h[r + 1][k + 1];
          // Either triangle of the cell (split as sim/src/map.rs `Terrain`) past the climb limit is a wall.
          const wall = Math.hypot(b - a, e - a) > steep || Math.hypot(f - e, f - b) > steep;
          g.fillStyle = `rgba(255,196,106,${wall ? 0.55 : 0.02 + (((a + b + e + f) / 4 - lo) / span) * 0.24})`;
          g.fillRect((k * t.cell - w / 2 - minX) * scale, (r * t.cell - d / 2 - minZ) * scale, px, px);
        }
      }
    }
    for (const s of solids) {
      const top = s.box[1] + s.half[1];
      const tilt = ((s.tilt ?? 0) * Math.PI) / 180;
      const hz = s.half[2] * Math.abs(Math.cos(tilt)) + s.half[1] * Math.abs(Math.sin(tilt));
      g.save();
      g.translate((s.box[0] - minX) * scale, (s.box[2] - minZ) * scale);
      // Three's yaw turns +X toward -Z; with canvas y down along +Z that's a counterclockwise turn.
      g.rotate(-((s.yaw ?? 0) * Math.PI) / 180);
      g.fillStyle = `rgba(255,196,106,${Math.min(0.15 + top / 14, 0.55)})`;
      g.fillRect(-s.half[0] * scale, -hz * scale, 2 * s.half[0] * scale, 2 * hz * scale);
      g.restore();
    }
    this.radarMap = { canvas: c, minX, minZ, scale };
  }

  /** Matches the canvas to the window at `ratio` device pixels per CSS pixel. */
  resize(ratio) {
    const w = Math.round(innerWidth * ratio), h = Math.round(innerHeight * ratio);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(f) {
    const { g, canvas } = this;
    const W = canvas.width, H = canvas.height, u = H / 1000, cx = W / 2, cy = H / 2;
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round';
    const font = (px, weight = '') => `${weight} ${Math.round(px * u)}px ui-monospace, Menlo, monospace`;

    // --- Target tags --------------------------------------------------------------------
    // Teammates: chevron, name, health. Enemies: brackets, health, name, distance and status; the
    // one under the crosshair also gets a card with class, hull and status.
    g.textAlign = 'center';
    for (const t of f.tags) {
      const name = t.bot ? `${t.name} ·BOT` : t.name;
      if (!t.enemy) {
        g.fillStyle = g.strokeStyle = f.friendColor;
        g.globalAlpha = 0.85;
        tri(g, t.x, t.y, 5 * u, 1);
        g.font = font(12);
        g.textBaseline = 'bottom';
        g.fillText(name, t.x, t.y - 14 * u);
        bar(g, t.x - 22 * u, t.y - 11.5 * u, 44 * u, 1.5 * u, t.health, f.friendColor);
        if (t.status) {
          g.font = font(10);
          g.fillText(t.status, t.x, t.y - 28 * u);
        }
        g.globalAlpha = 1;
        continue;
      }
      const s = Math.min(Math.max((1400 * u) / t.dist, 14 * u), 70 * u);
      g.strokeStyle = g.fillStyle = f.enemyColor;
      g.lineWidth = (t.focus ? 1.5 : 1) * u;
      brackets(g, t.x, t.y, s, s * 0.35);
      bar(g, t.x - s, t.y - s - 6 * u, 2 * s, 2 * u, t.health, f.enemyColor);
      g.fillStyle = f.enemyColor;
      g.font = font(12);
      g.textBaseline = 'bottom';
      g.fillText(name, t.x, t.y - s - 10 * u);
      g.textBaseline = 'top';
      g.fillText(`${Math.round(t.dist)} m${t.status ? ` · ${t.status}` : ''}`, t.x, t.y + s + 4 * u);
      // Lock-on: a diamond closing in as the lock builds, white and labeled once it holds.
      if (f.lock?.unit === t.unit) {
        const locked = f.lock.progress >= 1, d = s * (1.3 + 1.6 * (1 - f.lock.progress));
        g.strokeStyle = g.fillStyle = locked ? '#ffffff' : AMBER;
        g.lineWidth = 1.5 * u;
        g.beginPath();
        g.moveTo(t.x, t.y - d);
        g.lineTo(t.x + d, t.y);
        g.lineTo(t.x, t.y + d);
        g.lineTo(t.x - d, t.y);
        g.closePath();
        g.stroke();
        if (locked) {
          g.font = font(11, 'bold');
          g.fillText('LOCKED', t.x, t.y + d + 4 * u);
        }
      }
      if (t.focus) {
        const x = t.x + s + 12 * u, y = t.y - s;
        const lines = [[name, 13, 'bold'], [t.label.toUpperCase(), 11, ''], [`HULL ${t.hp}/${t.hpMax}`, 11, ''], [`${Math.round(t.dist)} m`, 11, '']];
        if (t.status) lines.push([t.status, 11, 'bold']);
        g.fillStyle = 'rgba(8,12,10,0.6)';
        g.fillRect(x - 6 * u, y - 4 * u, 130 * u, lines.length * 16 * u + 8 * u);
        g.textAlign = 'left';
        lines.forEach(([text, px, weight], i) => {
          g.fillStyle = i === 0 ? f.enemyColor : AMBER;
          g.font = font(px, weight);
          g.fillText(text, x, y + i * 16 * u);
        });
        g.textAlign = 'center';
      }
    }

    // --- Kill feed, top right -------------------------------------------------------------
    g.textAlign = 'right';
    g.textBaseline = 'top';
    g.font = font(13);
    f.feed.forEach((k, i) => {
      const age = (f.now - k.at) / 1000, y = 24 * u + i * 20 * u, x = W - 24 * u;
      g.globalAlpha = Math.min(1, 6 - age) * (k.mine ? 1 : 0.75);
      g.fillStyle = k.victimColor;
      g.fillText(k.victim, x, y);
      const vw = g.measureText(k.victim).width;
      g.fillStyle = AMBER;
      g.fillText(' ▸ ', x - vw, y);
      g.fillStyle = k.killerColor;
      g.fillText(k.killer, x - vw - g.measureText(' ▸ ').width, y);
    });
    g.globalAlpha = 1;

    // --- Aim frame: heat (red) fills both big arcs from the bottom, blinking when overheated.
    // Inside them, short arcs: the secondary's recharge on the right (lit when ready, or while a
    // burst is armed), and a slow primary's refire on the left (lit when it can fire) ---------
    const R = 210 * u, span = 0.55, bottom = cy + R * Math.sin(span);
    const blink = f.overheated && Math.floor(f.now / 150) % 2 === 0;
    // An arc from `from` (its bottom end) sweeping `sweep` radians up the side (negative: the
    // right side): a faint track, then `fill` of it in `color`.
    const gauge = (r, from, sweep, fill, color, width) => {
      g.lineWidth = width;
      g.strokeStyle = FAINT;
      arc(g, cx, cy, r, Math.min(from, from + sweep), Math.max(from, from + sweep));
      g.strokeStyle = color;
      const to = from + sweep * Math.min(Math.max(fill, 0), 1);
      if (fill > 0.01) arc(g, cx, cy, r, Math.min(from, to), Math.max(from, to));
    };
    const heat = f.overheated && !blink ? FAINT : WARN;
    gauge(R, Math.PI - span, 2 * span, f.heat, heat, 7 * u);
    gauge(R, span, -2 * span, f.heat, heat, 7 * u);
    const inner = R - 20 * u, short = 0.6;
    gauge(inner, span, -short, f.alt, f.altReady || f.altBurst ? AMBER : DIM, 4 * u);
    if (f.cycle !== null) gauge(inner, Math.PI - span, short, f.cycle, f.cycle >= 1 ? AMBER : DIM, 4 * u);
    if (f.jammed && Math.floor(f.now / 200) % 2 === 0) {
      g.textAlign = 'center';
      g.fillStyle = WARN;
      g.font = font(16, 'bold');
      g.fillText('BOOST JAMMED', cx, bottom + 34 * u);
    }
    // Missiles locked on us: a flashing warning over the frame, with how far off the nearest is.
    if (f.incoming !== null && Math.floor(f.now / 150) % 2 === 0) {
      const top = cy - R * Math.sin(span);
      g.textAlign = 'center';
      g.fillStyle = WARN;
      g.font = font(20, 'bold');
      g.fillText('MISSILE INCOMING', cx, top - 40 * u);
      g.font = font(13, 'bold');
      g.fillText(`${Math.round(f.incoming)} m`, cx, top - 20 * u);
    }
    // A fresh launch is shielded until we act: say so under the frame.
    if (f.shielded) {
      g.textAlign = 'center';
      g.fillStyle = '#7fe0ff';
      g.font = font(13, 'bold');
      g.fillText('SPAWN SHIELD · ENDS WHEN YOU MOVE OR FIRE', cx, bottom + 78 * u);
    }
    // A made lock holds a while wherever we look: say so, and for how long, under the frame.
    if (f.lock?.progress >= 1) {
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = font(13, 'bold');
      g.fillText(`LOCKED ${Math.max(f.lock.left, 0).toFixed(1)} s`, cx, bottom + 56 * u);
    }

    // --- Reticle at the aim point, with hit markers -----------------------------------------
    if (f.aim) {
      const { x, y } = f.aim;
      // Spread: four ticks at the edge of the cone the next shot lands in, opening as the gun
      // blooms and closing as it settles.
      const r = Math.max(7 * u, f.spread * cy);
      g.lineWidth = 2 * u;
      g.strokeStyle = AMBER;
      g.beginPath();
      for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        g.moveTo(x + sx * r, y + sy * r);
        g.lineTo(x + sx * (r + 9 * u), y + sy * (r + 9 * u));
      }
      g.stroke();
      // A charge, or a rotary's spin, fills a ring round it, outside the ticks; white when full.
      if (f.windup > 0) {
        g.lineWidth = 2.5 * u;
        g.strokeStyle = f.windup >= 1 ? '#ffffff' : AMBER;
        arc(g, x, y, Math.max(19 * u, r + 14 * u), -Math.PI / 2, -Math.PI / 2 + TAU * f.windup);
      }
      g.fillStyle = AMBER;
      g.beginPath();
      g.arc(x, y, 2.2 * u, 0, TAU);
      g.fill();
      // Hit markers: four ticks per hit, red and wider on a kill.
      for (const h of f.hits) {
        const age = (f.now - h.at) / 1000, life = h.kill ? 0.5 : 0.15;
        if (age > life) continue;
        g.globalAlpha = 1 - age / life;
        g.strokeStyle = h.kill ? WARN : '#ffffff';
        g.lineWidth = (h.kill ? 3 : 2) * u;
        const [a, b] = h.kill ? [12 * u, 30 * u] : [9 * u, 17 * u];
        g.beginPath();
        for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          g.moveTo(x + sx * a * Math.SQRT1_2, y + sy * a * Math.SQRT1_2);
          g.lineTo(x + sx * b * Math.SQRT1_2, y + sy * b * Math.SQRT1_2);
        }
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    // --- Damage direction -----------------------------------------------------------------
    g.strokeStyle = WARN;
    g.lineWidth = 7 * u;
    for (const d of f.damage) {
      const age = (f.now - d.at) / 1000;
      if (age > 1.2) continue;
      g.globalAlpha = 1 - age / 1.2;
      const a = relative(f.me.x, f.me.z, f.yaw, d.x, d.z).bearing - Math.PI / 2;
      arc(g, cx, cy, 150 * u, a - 0.35, a + 0.35);
    }
    g.globalAlpha = 1;

    // --- Radar and hull, in the chase view only (the cockpit's dash carries them otherwise) ----
    if (f.firstPerson) return;
    radar(g, 145 * u, 145 * u, 105 * u, u, f, this.radarMap);

    const dy = H - 120 * u, low = f.health / f.healthMax < 0.3;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = low ? WARN : AMBER;
    g.font = font(46, 'bold');
    g.fillText(String(Math.ceil(f.health)), cx, dy);
    g.font = font(11);
    g.fillStyle = DIM;
    g.fillText(`HULL · ${f.className.toUpperCase()}`, cx, dy + 16 * u);
    bar(g, cx - 120 * u, dy + 24 * u, 240 * u, 7 * u, f.health / f.healthMax, low ? WARN : AMBER);
    // The repair cycle over the hull numeral.
    g.textAlign = 'center';
    g.font = font(16, 'bold');
    if (f.repair > 0 || f.standing) {
      g.fillStyle = REPAIR;
      g.fillText(f.standing ? 'SYSTEMS RESTARTING' : f.repair >= 1 ? 'REPAIRING · SYSTEMS OFFLINE' : 'SHUTTING DOWN', cx, dy - 52 * u);
    }
  }
}

/**
 * The radar, centered at (rx, ry) with radius `rr`, drawn at scale `u`: the map's pre-drawn top-down
 * plan (`map`, from Hud.setMap) turning about the viewer, heading up, with `f`'s contacts. Drawn on
 * the glass in the chase view and on the cockpit's dash scope (cockpit.js) otherwise.
 */
export function radar(g, rx, ry, rr, u, f, map) {
  const k = rr / RADAR_RANGE;
  g.save();
  g.beginPath();
  g.arc(rx, ry, rr, 0, TAU);
  g.fillStyle = 'rgba(8,12,10,0.55)';
  g.fill();
  g.clip();
  if (map) {
    // World (x, z) to radar: rotate by heading about the viewer, heading up.
    const { canvas: m, minX, minZ, scale } = map, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    const ox = minX - f.me.x, oz = minZ - f.me.z;
    g.setTransform((k * c) / scale, (k * s) / scale, (-k * s) / scale, (k * c) / scale, rx + k * (c * ox - s * oz), ry + k * (s * ox + c * oz));
    g.drawImage(m, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  g.strokeStyle = FAINT;
  g.lineWidth = 1 * u;
  for (const ring of [30, 60]) arc(g, rx, ry, ring * k, 0, TAU);
  const sweep = (f.now / 1000) * 2.5;
  g.strokeStyle = DIM;
  g.beginPath();
  g.moveTo(rx, ry);
  g.lineTo(rx + Math.cos(sweep) * rr, ry + Math.sin(sweep) * rr);
  g.stroke();
  for (const c of f.contacts) {
    const p = relative(f.me.x, f.me.z, f.yaw, c.x, c.z);
    const px = rx + p.right * k, py = ry - p.ahead * k;
    g.fillStyle = c.orb ? REPAIR : c.enemy ? f.enemyColor : f.friendColor;
    if (c.orb) g.fillRect(px - 2.5 * u, py - 2.5 * u, 5 * u, 5 * u); // health orb
    else if (c.enemy) diamond(g, px, py, 5 * u);
    else {
      g.beginPath();
      g.arc(px, py, 3.5 * u, 0, TAU);
      g.fill();
    }
  }
  g.restore();
  g.strokeStyle = DIM;
  g.lineWidth = 1.5 * u;
  arc(g, rx, ry, rr, 0, TAU);
  g.fillStyle = AMBER;
  tri(g, rx, ry - 3 * u, 6 * u, -1);
  const north = relative(0, 0, f.yaw, 0, -1).bearing - Math.PI / 2;
  g.font = `${Math.round(12 * u)}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('N', rx + Math.cos(north) * (rr + 10 * u), ry + Math.sin(north) * (rr + 10 * u));
}

function arc(g, x, y, r, a, b) {
  g.beginPath();
  g.arc(x, y, r, a, b);
  g.stroke();
}

/** A small triangle pointing up (dir -1) or down (dir 1) with its tip at (x, y). */
function tri(g, x, y, s, dir) {
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x - s, y - dir * s * 1.4);
  g.lineTo(x + s, y - dir * s * 1.4);
  g.fill();
}

function diamond(g, x, y, s) {
  g.beginPath();
  g.moveTo(x, y - s);
  g.lineTo(x + s, y);
  g.lineTo(x, y + s);
  g.lineTo(x - s, y);
  g.fill();
}

/** Corner brackets of half-size `s` around (x, y), each arm `arm` long. */
function brackets(g, x, y, s, arm) {
  g.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    g.moveTo(x + sx * s, y + sy * (s - arm));
    g.lineTo(x + sx * s, y + sy * s);
    g.lineTo(x + sx * (s - arm), y + sy * s);
  }
  g.stroke();
}

function bar(g, x, y, w, h, fill, color) {
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(x, y, w, h);
  g.fillStyle = color;
  g.fillRect(x, y, w * Math.min(Math.max(fill, 0), 1), h);
}

export { hex };
