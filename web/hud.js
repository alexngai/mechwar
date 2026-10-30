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
    // one under the crosshair also gets a card with its class and weapons (scouting it out tells
    // you what it carries) and status.
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
      // Lock-on: a diamond closing in as the lock builds, white and labeled once it holds. A
      // seeking primary's mark, what its rockets turn toward, is the diamond closed, in amber.
      const locking = f.lock?.unit === t.unit;
      if (locking || f.seek === t.unit) {
        const progress = locking ? f.lock.progress : 1, locked = locking && progress >= 1, d = s * (1.3 + 1.6 * (1 - progress));
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
        const lines = [[name, 13, 'bold'], [t.label.toUpperCase(), 11, ''], ...(t.weapons ?? []).map((w) => [w.toUpperCase(), 11, '']), [`${Math.round(t.dist)} m`, 11, '']];
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

    // --- Pings and bots' marks: a diamond on the spot (a ping's opening out of a ring), its label
    // over it and distance under it. A bot's mark on an enemy it sees is a small solid one -----
    g.textAlign = 'center';
    for (const p of f.pings) {
      g.globalAlpha = p.alpha;
      g.strokeStyle = g.fillStyle = p.foe ? f.enemyColor : f.friendColor;
      g.lineWidth = 1.5 * u;
      if (p.kind === 'mark') {
        diamond(g, p.x, p.y, 4 * u);
        continue;
      }
      const s = 8 * u;
      g.beginPath();
      g.moveTo(p.x, p.y - s);
      g.lineTo(p.x + s, p.y);
      g.lineTo(p.x, p.y + s);
      g.lineTo(p.x - s, p.y);
      g.closePath();
      g.stroke();
      g.fillRect(p.x - 1.5 * u, p.y - 1.5 * u, 3 * u, 3 * u);
      if (p.age < 600) {
        g.globalAlpha = p.alpha * (1 - p.age / 600);
        arc(g, p.x, p.y, s + (p.age / 600) * 30 * u, 0, TAU);
        g.globalAlpha = p.alpha;
      }
      g.font = font(11, 'bold');
      g.textBaseline = 'bottom';
      g.fillText(p.label, p.x, p.y - s - 3 * u);
      g.font = font(10);
      g.textBaseline = 'top';
      g.fillText(`${Math.round(p.dist)} m`, p.x, p.y + s + 3 * u);
    }
    g.globalAlpha = 1;

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
    // Bots' callouts on the team radio, under it.
    f.radio.forEach((r, i) => {
      const age = (f.now - r.at) / 1000, y = 32 * u + (f.feed.length + i) * 20 * u, x = W - 24 * u;
      g.globalAlpha = Math.min(1, 6 - age);
      g.fillStyle = AMBER;
      g.fillText(r.text, x, y);
      g.fillStyle = f.friendColor;
      g.fillText(`${r.name}: `, x - g.measureText(r.text).width, y);
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
    // Objectives: each one's letter over it in its holder's color, flashing while contested.
    g.save();
    for (const o of f.objectives ?? []) {
      g.globalAlpha = o.contested && Math.floor(f.now / 250) % 2 ? 0.3 : 0.9;
      g.strokeStyle = g.fillStyle = o.color;
      g.lineWidth = 1.5 * u;
      g.strokeRect(o.x - 11 * u, o.y - 11 * u, 22 * u, 22 * u);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = font(14, 'bold');
      g.fillText(o.label, o.x, o.y + u);
      g.textBaseline = 'top';
      g.font = font(10);
      g.fillText(`${Math.round(o.dist)} m`, o.x, o.y + 14 * u);
      g.globalAlpha = 1;
    }
    // An objective we're taking: what's happening, and a bar from theirs through neutral (the mark
    // in the middle) to ours, flashing while contested.
    if (f.capture) {
      const c = f.capture, w = 220 * u, x0 = cx - w / 2, y0 = 186 * u, flash = c.contested && Math.floor(f.now / 250) % 2;
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.font = font(13, 'bold');
      g.fillStyle = c.contested ? '#ffffff' : f.friendColor;
      g.fillText(c.contested ? `${c.name} CONTESTED` : `TAKING ${c.name}`, cx, y0 - 4 * u);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x0, y0, w, 6 * u);
      g.fillStyle = flash ? '#ffffff' : f.friendColor;
      g.fillRect(x0, y0, w * c.share, 6 * u);
      g.fillStyle = '#ffffff';
      g.fillRect(cx - u, y0 - 2 * u, 2 * u, 10 * u);
    }
    // An objective changing hands, high up, fading out.
    const said = f.callout ? f.now - f.callout.at : Infinity;
    if (said < 3000) {
      g.globalAlpha = Math.min(1, (3000 - said) / 500);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = f.callout.color;
      g.font = font(18, 'bold');
      g.fillText(f.callout.text, cx, 150 * u);
      g.globalAlpha = 1;
    }
    g.restore();
    // Our latest kill or assist, over the frame where a missile warning goes (above one if both), fading out.
    const since = f.eliminated ? f.now - f.eliminated.at : Infinity;
    if (since < 2500) {
      g.globalAlpha = Math.min(1, (2500 - since) / 500);
      g.textAlign = 'center';
      g.fillStyle = '#fff';
      g.font = font(14, 'bold');
      g.fillText(`ELIMINATED ${f.eliminated.name}${f.eliminated.assist ? ' (ASSIST)' : ''}`, cx, cy - R * Math.sin(span) - (f.incoming !== null ? 68 : 30) * u);
      g.globalAlpha = 1;
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
      // A lock-on press that found nothing: two arcs spin round it a moment, outside a windup's ring.
      if (f.seeking) {
        const a = f.now / 120, rs = Math.max(25 * u, r + 20 * u);
        g.lineWidth = 2 * u;
        g.strokeStyle = AMBER;
        arc(g, x, y, rs, a, a + 1);
        arc(g, x, y, rs, a + Math.PI, a + Math.PI + 1);
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

    if (f.coop) coopLayer(g, f, W, H, u, font);

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
    g.fillStyle = g.strokeStyle = c.color ?? (c.orb ? REPAIR : c.enemy ? f.enemyColor : f.friendColor);
    if (c.objective) {
      // An objective: its letter.
      g.font = `bold ${Math.round(11 * u)}px ui-monospace, Menlo, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(c.objective, px, py);
    } else if (c.orb) g.fillRect(px - 2.5 * u, py - 2.5 * u, 5 * u, 5 * u); // health orb
    else if (c.ping) {
      // A ping, an enemy sighted, or a bot's call for help: a ring.
      g.lineWidth = 1.5 * u;
      arc(g, px, py, 4.5 * u, 0, TAU);
    }
    else if (c.turret) {
      // A turret: an open square.
      g.lineWidth = 1.5 * u;
      g.strokeRect(px - 3 * u, py - 3 * u, 6 * u, 6 * u);
    } else if (c.enemy) diamond(g, px, py, 5 * u);
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

// --- Co-op: building and towers on the glass ------------------------------------------------
const PANEL = 'rgba(8,12,10,0.66)', GOOD = '#6dff9a';

/**
 * Co-op's layer (`f.coop`, from main.js `drawBuild`): under the aim frame, the command chips (B to
 * build, N to call the wave) beside the break's countdown ring; while building, the bar of towers
 * to pick from under them and the ghost's verdict under the ghost; and by the tower aimed at, its
 * panel: hull, tier, builder and what U, H and X would do and cost, unfolding as it's found.
 */
function coopLayer(g, f, W, H, u, font) {
  const c = f.coop, cx = W / 2, row = H * 0.64;
  g.save();
  g.textBaseline = 'middle';
  // The chips, centered, the countdown ring left of them.
  g.font = font(12, 'bold');
  const chipW = (ch) => (ch.key ? 26 * u : 10 * u) + g.measureText(ch.label + (ch.note ? `  ${ch.note}` : '')).width + 12 * u;
  const ring = c.wave ? 46 * u : 0;
  let x = cx - (c.chips.reduce((w, ch) => w + chipW(ch) + 8 * u, 0) - 8 * u + ring) / 2;
  if (c.wave) {
    const r = 17 * u, rx = x + r, share = Math.max(0, Math.min(1, c.wave.left / c.wave.of));
    g.fillStyle = PANEL;
    g.beginPath();
    g.arc(rx, row, r + 3 * u, 0, TAU);
    g.fill();
    g.lineWidth = 3 * u;
    g.strokeStyle = FAINT;
    arc(g, rx, row, r, 0, TAU);
    g.strokeStyle = c.wave.left < 5 ? WARN : AMBER;
    arc(g, rx, row, r, -Math.PI / 2, -Math.PI / 2 + TAU * share);
    g.fillStyle = AMBER;
    g.textAlign = 'center';
    g.font = font(13, 'bold');
    g.fillText(String(Math.ceil(c.wave.left)), rx, row);
    g.font = font(9);
    g.fillStyle = DIM;
    g.fillText(`WAVE ${c.wave.n}`, rx, row + r + 10 * u);
    x += ring;
  }
  g.font = font(12, 'bold');
  for (const ch of c.chips) {
    const w = chipW(ch), h = 24 * u;
    g.fillStyle = PANEL;
    g.fillRect(x, row - h / 2, w, h);
    g.strokeStyle = ch.hot ? GOOD : FAINT;
    g.lineWidth = u;
    g.strokeRect(x, row - h / 2, w, h);
    let tx = x + 8 * u;
    if (ch.key) {
      keycap(g, tx, row, ch.key, u, font, ch.hot ? GOOD : AMBER);
      tx += 22 * u;
    }
    g.textAlign = 'left';
    g.font = font(12, 'bold');
    g.fillStyle = ch.dim ? DIM : AMBER;
    g.fillText(ch.label, tx, row);
    if (ch.note) {
      g.fillStyle = GOOD;
      g.fillText(ch.note, tx + g.measureText(`${ch.label}  `).width, row);
    }
    x += w + 8 * u;
  }
  // Building: the towers to pick from, under the chips; the ghost's verdict under the ghost.
  if (c.build) {
    const n = c.build.items.length, cw = 112 * u, ch = 70 * u, gap = 8 * u, top = row + 22 * u;
    let bx = cx - (n * cw + (n - 1) * gap) / 2;
    c.build.items.forEach((it, k) => {
      const on = k === c.build.selected;
      g.fillStyle = on ? 'rgba(255,196,106,0.16)' : PANEL;
      g.fillRect(bx, top, cw, ch);
      g.strokeStyle = on ? AMBER : FAINT;
      g.lineWidth = (on ? 2 : 1) * u;
      g.strokeRect(bx, top, cw, ch);
      g.globalAlpha = it.can ? 1 : 0.55;
      keycap(g, bx + 6 * u, top + 13 * u, String(k + 1), u, font, on ? AMBER : DIM);
      glyph(g, k, bx + cw / 2, top + 24 * u, 11 * u, on ? AMBER : DIM);
      g.textAlign = 'center';
      g.fillStyle = on ? AMBER : DIM;
      g.font = font(10, on ? 'bold' : '');
      g.fillText(it.name.toUpperCase(), bx + cw / 2, top + 46 * u);
      g.font = font(12, 'bold');
      g.fillStyle = it.can ? AMBER : WARN;
      g.fillText(String(it.price), bx + cw / 2, top + 60 * u);
      g.globalAlpha = 1;
      bx += cw + gap;
    });
    g.textAlign = 'center';
    g.font = font(10);
    g.fillStyle = DIM;
    g.fillText(`SCRAP ${Math.floor(c.build.scrap)} · LEFT CLICK BUILDS · 1–4 PICKS`, cx, top + ch + 11 * u);
  }
  if (c.ghost?.x !== undefined) {
    g.font = font(12, 'bold');
    const w = g.measureText(c.ghost.text).width + 16 * u, y = c.ghost.y + 30 * u;
    g.fillStyle = PANEL;
    g.fillRect(c.ghost.x - w / 2, y - 11 * u, w, 22 * u);
    g.fillStyle = c.ghost.ok ? GOOD : WARN;
    g.textAlign = 'center';
    g.fillText(c.ghost.text, c.ghost.x, y);
  }
  if (c.panel?.x !== undefined) towerPanel(g, c.panel, W, H, u, font);
  if (c.towers) towerGrid(g, c.towers, H, u, font, f.now);
  g.restore();
}

/**
 * The team's towers, left of the view: a cell for each the grid takes, built ones holding the
 * tower's mark and a hull bar (green, amber, red as it falls), ours outlined, flashing while hit;
 * then the worst hurt, with which way and how far.
 */
function towerGrid(g, t, H, u, font, now) {
  const x0 = 16 * u, y0 = H * 0.3, cols = 4, cw = 56 * u, ch = 16 * u, gap = 4 * u;
  const rows = Math.ceil(t.cap / cols), w = cols * cw + (cols - 1) * gap;
  g.fillStyle = PANEL;
  g.fillRect(x0 - 6 * u, y0 - 22 * u, w + 12 * u, rows * (ch + gap) + 28 * u + t.hurt.length * 16 * u);
  g.textAlign = 'left';
  g.font = font(11, 'bold');
  g.fillStyle = AMBER;
  g.fillText(`TOWERS ${t.cells.length}/${t.cap}`, x0, y0 - 11 * u);
  if (t.hurtCount) {
    g.textAlign = 'right';
    g.fillStyle = WARN;
    g.fillText(`${t.hurtCount} HURT · H MENDS`, x0 + w, y0 - 11 * u);
  }
  const blink = Math.floor(now / 150) % 2 === 0;
  for (let k = 0; k < t.cap; k++) {
    const x = x0 + (k % cols) * (cw + gap), y = y0 + Math.floor(k / cols) * (ch + gap), cell = t.cells[k];
    if (!cell) {
      g.strokeStyle = FAINT;
      g.lineWidth = u;
      g.strokeRect(x, y, cw, ch);
      continue;
    }
    const color = cell.share > 0.6 ? GOOD : cell.share > 0.3 ? AMBER : WARN;
    g.fillStyle = cell.hit && blink ? 'rgba(255,74,58,0.45)' : 'rgba(255,196,106,0.08)';
    g.fillRect(x, y, cw, ch);
    if (cell.mine) {
      g.strokeStyle = DIM;
      g.lineWidth = u;
      g.strokeRect(x, y, cw, ch);
    }
    glyph(g, cell.kind, x + 8 * u, y + ch / 2, 5 * u, AMBER);
    bar(g, x + 17 * u, y + ch / 2 - 2 * u, cw - 22 * u, 4 * u, cell.share, color);
  }
  let y = y0 + rows * (ch + gap) + 8 * u;
  g.font = font(11);
  for (const h of t.hurt) {
    g.fillStyle = h.hit && blink ? WARN : AMBER;
    g.textAlign = 'left';
    glyph(g, h.kind, x0 + 6 * u, y, 5 * u, g.fillStyle);
    g.fillText(`${'I'.repeat(h.tier)}  ${Math.round(100 * h.share)}%`, x0 + 16 * u, y);
    g.textAlign = 'right';
    g.fillText(`${h.arrow} ${Math.round(h.dist)} m`, x0 + w, y);
    y += 16 * u;
  }
}

/** The aimed tower's panel, off to its upper right with a line back to it, unfolding (`open`). */
function towerPanel(g, p, W, H, u, font) {
  const w = 236 * u, rowH = 22 * u, h = 64 * u + p.actions.length * rowH + 6 * u;
  const px = Math.min(p.x + 56 * u, W - w - 12 * u), py = Math.max(Math.min(p.y - h - 24 * u, H - h - 12 * u), 12 * u);
  const open = p.open, shown = h * open;
  g.globalAlpha = 0.4 + 0.6 * open;
  g.strokeStyle = AMBER;
  g.lineWidth = u;
  g.beginPath();
  g.moveTo(p.x, p.y);
  g.lineTo(px, py + shown);
  g.stroke();
  g.fillStyle = AMBER;
  g.beginPath();
  g.arc(p.x, p.y, 3 * u, 0, TAU);
  g.fill();
  g.fillStyle = PANEL;
  g.fillRect(px, py, w, shown);
  g.fillStyle = AMBER;
  g.fillRect(px, py, 3 * u, shown);
  if (open < 1) {
    g.globalAlpha = 1;
    return;
  }
  const lx = px + 14 * u;
  // Its kind, tier pips, hull and builder.
  glyph(g, p.kind, lx + 7 * u, py + 16 * u, 8 * u, AMBER);
  g.textAlign = 'left';
  g.font = font(13, 'bold');
  g.fillStyle = AMBER;
  g.fillText(p.name.toUpperCase(), lx + 20 * u, py + 16 * u);
  for (let t = 0; t < p.tiers; t++) {
    g.beginPath();
    g.arc(px + w - 16 * u - (p.tiers - 1 - t) * 12 * u, py + 16 * u, 4 * u, 0, TAU);
    if (t < p.tier) g.fill();
    else {
      g.strokeStyle = DIM;
      g.stroke();
    }
  }
  const color = p.share > 0.6 ? GOOD : p.share > 0.3 ? AMBER : WARN;
  bar(g, lx, py + 32 * u, w - 28 * u, 6 * u, p.share, color);
  g.font = font(10);
  g.fillStyle = DIM;
  g.fillText(p.line, lx, py + 48 * u);
  // What the keys would do, and for how much.
  let y = py + 70 * u;
  for (const a of p.actions) {
    g.globalAlpha = a.can === false || a.dim ? 0.55 : 1;
    if (a.key) keycap(g, lx, y, a.key, u, font, a.mend ? GOOD : AMBER);
    g.textAlign = 'left';
    g.font = font(12, 'bold');
    g.fillStyle = a.dim ? DIM : a.mend ? GOOD : AMBER;
    g.fillText(a.label, lx + (a.key ? 24 * u : 0), y);
    if (a.cost !== undefined) {
      g.textAlign = 'right';
      g.fillStyle = a.can ? (a.refund ? GOOD : AMBER) : WARN;
      g.fillText(a.refund ? `+${a.cost}` : String(a.cost), px + w - 14 * u, y);
    }
    y += rowH;
  }
  g.globalAlpha = 1;
}

/** A key's cap: its letter in a small box, left edge at x, centered on y. */
function keycap(g, x, y, key, u, font, color) {
  const s = 16 * u;
  g.strokeStyle = color;
  g.lineWidth = u;
  g.strokeRect(x, y - s / 2, s, s);
  g.fillStyle = color;
  g.textAlign = 'center';
  g.font = font(11, 'bold');
  g.fillText(key, x + s / 2, y + u);
}

/** Tower `kind`'s mark (defense.rs TOWERS order; -1 the reactor), centered at (x, y), about `s` in radius. */
function glyph(g, kind, x, y, s, color) {
  g.strokeStyle = g.fillStyle = color;
  g.lineWidth = Math.max(1, s / 6);
  g.beginPath();
  if (kind === -1) {
    // The reactor: a core in a hexagon.
    for (let k = 0; k <= 6; k++) g[k ? 'lineTo' : 'moveTo'](x + s * Math.cos((k * TAU) / 6), y + s * Math.sin((k * TAU) / 6));
    g.stroke();
    g.beginPath();
    g.arc(x, y, s * 0.4, 0, TAU);
    g.fill();
  } else if (kind === 0) {
    // MG tower: a squat base, a turret and a long barrel.
    g.rect(x - s, y + s * 0.3, 2 * s, s * 0.6);
    g.rect(x - s * 0.5, y - s * 0.3, s, s * 0.6);
    g.moveTo(x + s * 0.5, y);
    g.lineTo(x + s * 1.3, y - s * 0.4);
    g.stroke();
  } else if (kind === 1) {
    // Rocket tower: a pod of two tubes on a base.
    g.rect(x - s, y + s * 0.4, 2 * s, s * 0.5);
    g.rect(x - s * 0.8, y - s * 0.7, s * 1.6, s * 0.9);
    g.stroke();
    g.beginPath();
    g.arc(x - s * 0.4, y - s * 0.25, s * 0.25, 0, TAU);
    g.arc(x + s * 0.4, y - s * 0.25, s * 0.25, 0, TAU);
    g.fill();
  } else if (kind === 2) {
    // Arc pylon: a bolt.
    g.moveTo(x + s * 0.3, y - s);
    g.lineTo(x - s * 0.4, y + s * 0.1);
    g.lineTo(x + s * 0.2, y + s * 0.1);
    g.lineTo(x - s * 0.3, y + s);
    g.stroke();
  } else {
    // Pulse pylon: a core in rings.
    g.arc(x, y, s * 0.3, 0, TAU);
    g.fill();
    g.beginPath();
    g.arc(x, y, s * 0.65, 0, TAU);
    g.stroke();
    g.beginPath();
    g.arc(x, y, s, 0, TAU);
    g.stroke();
  }
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
