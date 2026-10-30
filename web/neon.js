// Neon signs: an atlas of sign faces drawn once on a canvas (gibberish glyphs built from brush strokes,
// like characters in no particular script, under tube outlines and bulb borders, on lightboxes and
// emblems), and the boards for a map's `neon` decor, cut from it: one texture and one material for all.
import * as THREE from 'three';

const [W, H] = [4096, 2048];
// Each shape's tiles: [w, h, across, rows, top], alternately warm and cool; half the squares are emblems.
const CLASSES = {
  long: [768, 128, 5, 3, 0],
  wide: [512, 128, 8, 3, 384],
  tall: [128, 384, 32, 2, 768],
  square: [256, 256, 16, 2, 1536],
};
const TONES = {
  warm: ['#ff2e2e', '#ff8a1a', '#ffc933', '#ff4fa3', '#36ff7a', '#fff0c8', '#ff5a1f', '#ffe14d'],
  cool: ['#3fe8ff', '#ff3fa0', '#b45cff', '#7dff4a', '#e8f8ff', '#4a7dff', '#2affc8', '#ff6ad5'],
};
const BOARDS = ['#0b0707', '#0b0707', '#2a0606', '#06102a', '#052010', '#1c0a24']; // dark, or dark and tinted

/** Seeded random in [0, 1). */
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
/** A stable [0, 1) for whatever stands at `p`. */
const hash = ([x, y, z]) => {
  const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * A glyph in the square (x, y) to (x + s, y + s): brush strokes on a 4 x 4 grid, in one block or
 * split left and right or top and bottom like a character with a radical, each part crossed by at
 * least one stroke each way.
 */
function glyph(g, x, y, s, rnd) {
  const q = () => [0, 0.25, 0.5, 0.75, 1][Math.floor(rnd() * 5)];
  const at = (gx, gy) => [x + s * (0.14 + (0.72 * gx) / 4), y + s * (0.14 + (0.72 * gy) / 4)];
  const line = (a, b, c, d) => (g.moveTo(...at(a, b)), g.lineTo(...at(c, d)));
  const split = rnd();
  const parts = split < 0.3 ? [[0, 0, 4, 4]] : split < 0.65 ? [[0, 0, 1.4, 4], [2, 0, 4, 4]] : [[0, 0, 4, 1.4], [0, 2, 4, 4]];
  g.beginPath();
  for (const [x0, y0, x1, y1] of parts) {
    const [w, h] = [x1 - x0, y1 - y0];
    for (let k = 0, n = 3 + Math.floor(rnd() * 3); k < n; k++) {
      const kind = k < 2 ? k : Math.floor(rnd() * 6);
      if (kind === 0) { const v = y0 + h * q(); line(x0 + w * 0.1, v, x1 - w * 0.1, v); } // across
      else if (kind === 1) { const u = x0 + w * q(); line(u, y0, u, y1); } // down
      else if (kind === 2) { // a box
        const [u, v] = [x0 + w * 0.15, y0 + h * (0.2 + 0.3 * rnd())];
        g.moveTo(...at(u, v)), g.lineTo(...at(x1 - w * 0.15, v)), g.lineTo(...at(x1 - w * 0.15, y1 - h * 0.1)), g.lineTo(...at(u, y1 - h * 0.1)), g.closePath();
      } else if (kind === 3) line(x0 + w * 0.5, y0 + h * 0.3, x0, y1); // falling left
      else if (kind === 4) line(x0 + w * 0.5, y0 + h * 0.5, x1, y1); // falling right
      else line(x0 + w * q(), y0, x0 + w * q() + w * 0.15, y0 + h * 0.2); // a dot
    }
  }
  g.stroke();
}

/** The outline of a sign `w` x `h` in its tile, `inset` in from its edge: 'rect', 'pill', 'arch' (round-topped), 'disc', 'diamond' or 'octagon'. */
function outline(g, shape, w, h, inset) {
  const [x0, y0, x1, y1] = [inset, inset, w - inset, h - inset], [cx, cy, r] = [w / 2, h / 2, Math.min(w, h) / 2 - inset];
  g.beginPath();
  if (shape === 'disc') g.arc(cx, cy, r, 0, 2 * Math.PI);
  else if (shape === 'diamond') g.moveTo(cx, cy - r), g.lineTo(cx + r, cy), g.lineTo(cx, cy + r), g.lineTo(cx - r, cy), g.closePath();
  else if (shape === 'octagon') {
    for (let k = 0; k < 8; k++) g.lineTo(cx + r * Math.cos(((k + 0.5) * Math.PI) / 4), cy + r * Math.sin(((k + 0.5) * Math.PI) / 4));
    g.closePath();
  } else if (shape === 'arch') {
    const a = (x1 - x0) / 2;
    g.moveTo(x0, y1), g.lineTo(x0, y0 + a), g.arc(cx, y0 + a, a, Math.PI, 0), g.lineTo(x1, y1), g.closePath();
  } else g.roundRect(x0, y0, x1 - x0, y1 - y0, shape === 'pill' ? Math.min(w, h) / 2 - inset : Math.min(w, h) * 0.08);
}

/** One sign's face in the tile [x, y, w, h]: a board under tube outlines or bulbs and glowing glyphs, or a lit box with dark ones. Returns its main color. */
function face(g, [x, y, w, h], tone, rnd, emblem) {
  const pal = TONES[tone], pick = () => pal[Math.floor(rnd() * pal.length)];
  const a = pick(), b = pal[(pal.indexOf(a) + 1 + Math.floor(rnd() * (pal.length - 1))) % pal.length];
  const m = Math.min(w, h), pad = m * 0.07, wide = w >= h;
  const shape = emblem ? ['disc', 'diamond', 'octagon'][Math.floor(rnd() * 3)] : rnd() < 0.6 ? 'rect' : wide ? 'pill' : rnd() < 0.5 ? 'arch' : 'pill';
  const box = !emblem && rnd() < 0.3, border = rnd() < 0.25 ? 'bulbs' : rnd() < 0.4 ? 'double' : 'tube';
  const glow = (c, blur) => ((g.strokeStyle = g.shadowColor = c), (g.shadowBlur = blur));
  g.save();
  g.translate(x, y);
  g.lineCap = g.lineJoin = 'round';
  outline(g, shape, w, h, pad);
  g.fillStyle = box ? a : BOARDS[Math.floor(rnd() * BOARDS.length)];
  g.fill();
  if (box && rnd() < 0.5) {
    // A band across a lightbox's head, in another color.
    g.save();
    g.clip();
    g.fillStyle = b;
    if (wide) g.fillRect(0, 0, w * 0.22, h);
    else g.fillRect(0, 0, w, h * 0.18);
    g.restore();
  }
  glow(box ? '#1c0c0c' : a, box ? 0 : m * 0.08);
  g.lineWidth = m * 0.045;
  if (border === 'bulbs' && !box) g.setLineDash([0.1, m * 0.09]), (g.lineWidth = m * 0.05); // a row of bulbs
  outline(g, shape, w, h, pad + m * 0.03);
  g.stroke();
  g.setLineDash([]);
  if (border === 'double' && !box) {
    glow(b, m * 0.06);
    g.lineWidth = m * 0.025;
    outline(g, shape, w, h, pad + m * 0.11);
    g.stroke();
  }
  // The glyphs: one big one on an emblem; along a board's length, in one color or taking turns, now and
  // then a line of small ones beside the big.
  const dark = '#1a0606', along = Math.max(w, h), turns = !box && rnd() < 0.35, sub = !emblem && rnd() < 0.3;
  const big = emblem ? m * 0.5 : sub ? m * 0.48 : m * 0.72;
  const n = emblem ? 1 : Math.max(1, Math.floor((along - 2 * pad) / (big * 1.1)));
  const s = emblem ? big : Math.min(big, (along - 2 * pad - m * 0.08) / n);
  const across = sub ? pad + m * 0.06 : (m - s) / 2;
  g.lineWidth = s * 0.09;
  for (let k = 0; k < n; k++) {
    glow(box ? dark : turns && k % 2 ? a : b, box ? 0 : s * 0.18);
    const c = emblem ? (m - s) / 2 : pad + m * 0.04 + (along - 2 * pad - m * 0.08) * ((k + 0.5) / n) - s / 2;
    if (wide) glyph(g, emblem ? (w - s) / 2 : c, across, s, rnd);
    else glyph(g, across, c, s, rnd);
  }
  if (sub) {
    const t = m * 0.26, k = Math.max(1, Math.floor((along - 2 * pad - m * 0.08) / (t * 1.05))), off = m - pad - m * 0.06 - t;
    glow(box ? dark : a, box ? 0 : t * 0.15);
    g.lineWidth = t * 0.1;
    for (let i = 0; i < k; i++) {
      const c = pad + m * 0.04 + (along - 2 * pad - m * 0.08) * ((i + 0.5) / k) - t / 2;
      if (wide) glyph(g, c, off, t, rnd);
      else glyph(g, off, c, t, rnd);
    }
  }
  g.restore();
  return a;
}

let atlas;
function build() {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = [W, H];
  const g = canvas.getContext('2d'), rnd = seeded(1913), tiles = {};
  for (const [name, [w, h, across, rows, top]] of Object.entries(CLASSES)) {
    tiles[name] = { warm: [], cool: [] };
    for (let k = 0; k < across * rows; k++) {
      const [x, y, tone, emblem] = [(k % across) * w, top + Math.floor(k / across) * h, k % 2 ? 'cool' : 'warm', name === 'square' && k % 4 < 2];
      const color = face(g, [x, y, w, h], tone, rnd, emblem);
      tiles[name][tone].push({ uv: [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H], color, emblem });
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return (atlas = { texture, tiles });
}

/**
 * A neon board for `d` ({ at, size: [w, h], yaw, emblem, tone }): a quad `w` across and `h` tall,
 * its middle at `at`, turned `yaw` degrees about the vertical (0: facing along Z), seen from both
 * sides, its face picked from the atlas by its proportions (an emblem: a disc, diamond or octagon),
 * `tone` ('warm' or 'cool') and where it stands; and that face's main color, for its light.
 */
export function neonBoard(d) {
  const { tiles } = atlas ?? build(), [w, h] = d.size, aspect = w / h;
  const name = d.emblem ? 'square' : aspect > 4.5 ? 'long' : aspect > 1.8 ? 'wide' : aspect < 0.55 ? 'tall' : 'square';
  const list = tiles[name][d.tone ?? 'warm'].filter((t) => t.emblem === !!d.emblem);
  const t = list[Math.floor(hash(d.at) * list.length)];
  const geometry = new THREE.PlaneGeometry(w, h), uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, t.uv[0] + uv.getX(i) * (t.uv[2] - t.uv[0]), t.uv[1] + uv.getY(i) * (t.uv[3] - t.uv[1]));
  geometry.rotateY(THREE.MathUtils.degToRad(d.yaw ?? 0)).translate(...d.at);
  return { geometry, color: t.color };
}

/** The boards' material: the atlas, cut out round its signs' edges, a little dimmed so bloom haloes the tubes without washing out the glyphs. */
export const neonMaterial = () => new THREE.MeshBasicMaterial({ map: (atlas ?? build()).texture, color: 0x9a9a9a, alphaTest: 0.5, side: THREE.DoubleSide });
