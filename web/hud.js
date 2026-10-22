// Glass HUD: one canvas over the game, redrawn each frame from the `frame` object main.js fills.
// Our own layout: compass tape up top, altitude and speed ladders framing the glass, an aim frame
// (heat on both arcs, the secondary's recharge and a slow gun's refire inside them) around
// spread ticks at the aim point, target tags and damage arcs. The mech's state (hull, fuel, systems) and the radar are on
// the cockpit's dash (cockpit.js, which draws the radar with `radar` below); only in the chase view,
// where the dash isn't seen, does the glass show the radar and hull. Everything is drawn in device pixels scaled by `u` (1/1000 of the height).

const AMBER = '#ffc46a', DIM = 'rgba(255,196,106,0.35)', FAINT = 'rgba(255,196,106,0.14)', WARN = '#ff4a3a', FUEL = '#7fd8ff', REPAIR = '#6dff9a';
const TAU = Math.PI * 2;
const RADAR_RANGE = 90; // m
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
/** Angle wrapped to [-180, 180) degrees. */
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

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

  /** Pre-draws the map's solids top-down (brighter for taller) for the radar. */
  setMap(map) {
    const solids = map.solids.filter((s) => s.box[1] + s.half[1] > 0.3);
    const ext = (s) => Math.hypot(s.half[0], s.half[2]);
    const minX = Math.min(...solids.map((s) => s.box[0] - ext(s))), maxX = Math.max(...solids.map((s) => s.box[0] + ext(s)));
    const minZ = Math.min(...solids.map((s) => s.box[2] - ext(s))), maxZ = Math.max(...solids.map((s) => s.box[2] + ext(s)));
    const scale = 4; // px per m
    const c = document.createElement('canvas');
    c.width = Math.ceil((maxX - minX) * scale);
    c.height = Math.ceil((maxZ - minZ) * scale);
    const g = c.getContext('2d');
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
    const heading = headingDeg(f.yaw);

    // --- Compass tape ---------------------------------------------------------------
    const tapeY = 92 * u, tapeHalf = 260 * u, perDeg = tapeHalf / 60;
    g.strokeStyle = AMBER;
    g.fillStyle = AMBER;
    g.lineWidth = 1.5 * u;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.font = font(15);
    for (let d = Math.ceil((heading - 60) / 15) * 15; d <= heading + 60; d += 15) {
      const x = cx + wrapDeg(d - heading) * perDeg;
      const major = ((d % 360) + 360) % 360;
      g.globalAlpha = 1 - Math.abs(x - cx) / (tapeHalf * 1.1);
      g.beginPath();
      g.moveTo(x, tapeY);
      g.lineTo(x, tapeY - (major % 45 === 0 ? 12 : 6) * u);
      g.stroke();
      if (major % 45 === 0) g.fillText(POINTS[major / 45], x, tapeY - 14 * u);
    }
    g.globalAlpha = 1;
    for (const c of f.contacts) {
      if (!c.enemy) continue;
      const rel = (relative(f.me.x, f.me.z, f.yaw, c.x, c.z).bearing * 180) / Math.PI;
      if (Math.abs(rel) > 60) continue;
      g.fillStyle = f.enemyColor;
      tri(g, cx + rel * perDeg, tapeY + 4 * u, 5 * u, 1);
    }
    g.fillStyle = AMBER;
    tri(g, cx, tapeY + 4 * u, 6 * u, -1);
    g.textBaseline = 'top';
    g.font = font(14);
    g.fillText(String(Math.round(heading) % 360).padStart(3, '0'), cx, tapeY + 12 * u);

    // --- Ladders ----------------------------------------------------------------------
    ladder(g, u, cx - 340 * u, cy, f.altitude, 12 * u, 1, 5, -1); // altitude, m
    ladder(g, u, cx + 340 * u, cy, f.speed * 3.6, 3 * u, 5, 10, 1); // speed, km/h

    // --- Target tags --------------------------------------------------------------------
    // Teammates: chevron, name, health. Enemies: brackets, health, name, distance and status; the
    // one under the crosshair also gets a card with class, hull and status.
    g.textAlign = 'center';
    for (const t of f.tags) {
      const name = t.bot ? `${t.name} ·BOT` : t.name;
      if (!t.enemy) {
        g.fillStyle = g.strokeStyle = f.friendColor;
        g.globalAlpha = 0.85;
        tri(g, t.x, t.y, 6 * u, 1);
        g.font = font(12);
        g.textBaseline = 'bottom';
        g.fillText(name, t.x, t.y - 14 * u);
        bar(g, t.x - 22 * u, t.y - 12 * u, 44 * u, 2.5 * u, t.health, f.friendColor);
        if (t.status) {
          g.font = font(10);
          g.fillText(t.status, t.x, t.y - 28 * u);
        }
        g.globalAlpha = 1;
        continue;
      }
      const s = Math.min(Math.max((1400 * u) / t.dist, 14 * u), 70 * u);
      g.strokeStyle = g.fillStyle = f.enemyColor;
      g.lineWidth = (t.focus ? 2.5 : 1.5) * u;
      brackets(g, t.x, t.y, s, s * 0.35);
      bar(g, t.x - s, t.y - s - 7 * u, 2 * s, 3 * u, t.health, f.enemyColor);
      g.fillStyle = f.enemyColor;
      g.font = font(12);
      g.textBaseline = 'bottom';
      g.fillText(name, t.x, t.y - s - 10 * u);
      g.textBaseline = 'top';
      g.fillText(`${Math.round(t.dist)} m${t.status ? ` · ${t.status}` : ''}`, t.x, t.y + s + 4 * u);
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

/**
 * A vertical tape centered on `value` at (x, cy): ticks every `step`, labels every `label`,
 * `per` px per unit, and a boxed readout on the side facing the center (`side` -1 left, 1 right).
 */
function ladder(g, u, x, cy, value, per, step, label, side) {
  const half = 150 * u, font = (px) => `${Math.round(px * u)}px ui-monospace, Menlo, monospace`;
  g.strokeStyle = g.fillStyle = AMBER;
  g.lineWidth = 1.5 * u;
  g.font = font(12);
  g.textBaseline = 'middle';
  g.textAlign = side < 0 ? 'right' : 'left';
  for (let v = Math.ceil((value - half / per) / step) * step; v <= value + half / per; v += step) {
    const y = cy - (v - value) * per;
    const major = Math.abs(v % label) < 1e-6;
    g.globalAlpha = 1 - Math.abs(y - cy) / (half * 1.15);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - side * (major ? 14 : 7) * u, y);
    g.stroke();
    if (major) g.fillText(String(Math.round(v)), x + side * 6 * u, y);
  }
  g.globalAlpha = 1;
  const bw = 58 * u, bh = 22 * u, bx = side < 0 ? x - 18 * u - bw : x + 18 * u;
  g.fillStyle = 'rgba(8,12,10,0.6)';
  g.fillRect(bx, cy - bh / 2, bw, bh);
  g.strokeRect(bx, cy - bh / 2, bw, bh);
  g.fillStyle = AMBER;
  g.textAlign = 'center';
  g.font = font(15);
  g.fillText(value.toFixed(value < 100 ? 1 : 0), bx + bw / 2, cy);
}

export { hex };
