// The world past the arena walls: a gradient sky dome with a soft sun, matching fog, and one merged
// skyline mesh: desert mesas, a refinery and salt storage domes on the flats, a city's tower
// blocks with lit windows, forested hills under giant trees, or a mire of dead trees. All procedural and purely visual: nothing here collides or casts shadows.
// A map's `palette` overrides any of the day or night look.
import * as THREE from 'three';

// `haze` is low-lying mist: color, density at the map's lowest floor (1/m) and the height (m) over
// which it thins by e.
const SKY = {
  day: { horizon: 0xd9cdb4, zenith: 0x8fb0c8, sun: 0xfff1d6, stars: 0, haze: [0xd9cdb4, 0.004, 3] },
  // Moonlit: a deep blue zenith over a horizon warmed by the works' own glow; the sun becomes the moon.
  night: { horizon: 0x2e2520, zenith: 0x050912, sun: 0x8492b4, stars: 1, haze: [0x7a6656, 0.05, 3] },
};
const COLORS = {
  flat: 0xd3ccbb, talus: 0xb5a58e, scree: 0xab9882, cliff: 0x9f8774, cap: 0xbcae96,
  concrete: 0xa49d8f, steel: 0x8a8984, dark: 0x6e6b66, rust: 0x8c6550, tank: 0xc4bcaa, salt: 0xcbc3b0,
  street: 0x2a302d, block: 0x3a423e, blockDark: 0x2c3330,
  moss: 0x5d6b45, hill: 0x55663f, hillTop: 0x62744a, trunk: 0x4a3d30, crown: 0x4c6e36, crownDark: 0x3c5a2c,
  mire: 0x4c5440, snag: 0x5c564a, scrub: 0x56603e,
};
// The desert's flats, mesas and domes under snow, for the 'snow' skyline.
const SNOWFIELD = { ...COLORS, flat: 0xe4eaef, talus: 0xd2dae1, scree: 0xa9b3bd, cliff: 0x86909a, cap: 0xf1f4f7, salt: 0xe9eef2 };
// Lit windows on a city skyline, unless the palette names its own.
const WINDOWS = ['#ffd890', '#9dffc0', '#7fe8ff'];
const FOG = [70, 230]; // near and far, meters
// Scales the skyline's fog depth. At full strength fog 70–230 m would erase the 150–260 m ring;
// this keeps the far mesas as pale silhouettes while the arena itself gets the real fog.
const SKYLINE_FOG = 0.85;
// The skyline is laid out around a 120 m square arena; bigger maps push all of it outward.
const LAID_OUT_FOR = Math.hypot(120, 120);

// The haze rides three's fog chunks, so every fogged material gets it (the dome and particles don't
// fog). Its density falls off exponentially with height; the fragment integrates it along the
// view ray. Typed-array uniform values are shared, not copied, when materials clone their
// uniforms, so `fit` reaches every material by writing these.
const HAZE = new Float32Array([0, 1, 0, 0]); // density at `base`, falloff height, base height, most it hides
const HAZE_COLOR = new Float32Array(3);
for (const lib of Object.values(THREE.ShaderLib)) {
  if (lib.uniforms.fogColor) Object.assign(lib.uniforms, { haze: { value: HAZE }, hazeColor: { value: HAZE_COLOR } });
}
THREE.ShaderChunk.fog_pars_vertex += '\n#ifdef USE_FOG\n  varying vec3 vFogView;\n#endif\n';
THREE.ShaderChunk.fog_vertex += '\n#ifdef USE_FOG\n  vFogView = mvPosition.xyz;\n#endif\n';
THREE.ShaderChunk.fog_pars_fragment += '\n#ifdef USE_FOG\n  uniform vec4 haze;\n  uniform vec3 hazeColor;\n  varying vec3 vFogView;\n#endif\n';
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  {
    // Heights in falloffs: the eye's above the base, and the surface's above the eye (the view
    // matrix's Y row turns view space back into world rise). Density is relative to the base.
    float above = (cameraPosition.y - haze.z) / haze.y, rise = dot(viewMatrix[1].xyz, vFogView) / haze.y;
    float atEye = exp(-max(above, -4.0)), atSurface = exp(-max(above + rise, -4.0));
    float depth = haze.x * length(vFogView) * (abs(rise) > 1e-3 ? (atEye - atSurface) / rise : atEye);
    // A display color, like the fog's: on screen fog mixes in after tone mapping, while into High's
    // HDR target it goes in linear, before OutputPass tone maps it.
    #ifdef TONE_MAPPING
      vec3 hazeTint = hazeColor;
    #else
      vec3 hazeTint = sRGBTransferEOTF(vec4(hazeColor, 1.0)).rgb;
    #endif
    gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeTint, min(1.0 - exp(-depth), haze.w));
  }
#endif
${THREE.ShaderChunk.fog_fragment}`;

/** Small seeded PRNG (mulberry32) so the skyline is the same on every load. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function skyMaterial(sunDir) {
  return new THREE.ShaderMaterial({
    uniforms: {
      horizon: { value: new THREE.Color(SKY.day.horizon) },
      zenith: { value: new THREE.Color(SKY.day.zenith) },
      sunColor: { value: new THREE.Color(SKY.day.sun) },
      sunDir: { value: sunDir }, // shared: a map can turn the sun, and the dome follows
      stars: { value: 0 },
      time: { value: 0 },
      aurora: { value: 0 },
      auroraLow: { value: new THREE.Color() },
      auroraHigh: { value: new THREE.Color() },
      flash: { value: 0 },
      flashDir: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 horizon, zenith, sunColor, sunDir, auroraLow, auroraHigh, flashDir;
      uniform float stars, time, aurora, flash;
      varying vec3 vWorld;
      #include <common>
      #include <dithering_pars_fragment>
      void main() {
        vec3 dir = normalize(vWorld - cameraPosition);
        float up = max(dir.y, 0.0); // below the horizon stays horizon-colored, like the fog
        vec3 col = mix(horizon, zenith, (1.0 - exp(-3.0 * up)) / (1.0 - exp(-3.0)));
        float c = max(dot(dir, sunDir), 0.0);
        // Wide haze glow plus a tight halo; the disc alone is bright enough to clip under ACES.
        col += sunColor * (0.25 * pow(c, 8.0) + 0.5 * pow(c, 400.0));
        col += sunColor * 3.0 * smoothstep(0.99985, 0.99993, c);
        // Stars: a sparse hash over direction cells, fading into the haze near the horizon.
        float star = step(0.9985, fract(sin(dot(floor(dir * 300.0), vec3(12.9898, 78.233, 45.164))) * 43758.5453));
        col += stars * star * smoothstep(0.03, 0.3, up) * vec3(0.85, 0.9, 1.0);
        if (aurora > 0.0) {
          // Curtains: a narrow band about 33 degrees up, waving slowly round the sky, in fine
          // vertical rays; one color low, another high. Whole multiples of the azimuth, so no seam.
          float az = atan(dir.x, dir.z), wave = 0.05 * sin(az * 3.0 + time * 0.018) + 0.025 * sin(az * 7.0 - time * 0.028);
          float band = exp(-pow((up - 0.55 - wave) * 9.0, 2.0)) * smoothstep(0.04, 0.2, up);
          float rays = 0.55 + 0.45 * sin(az * 36.0 + 2.0 * sin(az * 5.0 + time * 0.075)); // broad rays, 36 round the sky
          col += aurora * band * rays * mix(auroraLow, auroraHigh, smoothstep(0.45, 0.8, up + wave));
        }
        // Lightning: the whole sky lit, brightest toward the strike.
        col += flash * (vec3(0.55, 0.6, 0.75) + vec3(1.6, 1.7, 2.0) * pow(max(dot(dir, flashDir), 0.0), 6.0));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <dithering_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    dithering: true,
  });
}

/**
 * All skyline triangles, written straight into one non-indexed geometry, `push` meters farther out:
 * the desert (`kind` 'snow': the same under snow), or for 'city' tower blocks, whose lit windows
 * come back as `windows` (unlit specks in `windowColors`, so they read through fog at night).
 * Every surface is tinted `tint`.
 */
function skylineGeometry(push, kind = 'desert', windowColors = WINDOWS, tint = 0xffffff) {
  const rand = mulberry32(0x5a175a17);
  const positions = [], colors = [], color = new THREE.Color(), tinted = new THREE.Color(tint);
  const tri = (a, b, c, hex) => {
    positions.push(...a, ...b, ...c);
    color.setHex(hex).multiply(tinted).multiplyScalar(0.93 + rand() * 0.14); // per-facet shade for the faceted look
    for (let i = 0; i < 3; i++) colors.push(color.r, color.g, color.b);
  };

  /**
   * A faceted solid of revolution at (x, z): `rings` are [radius, height] pairs from the bottom up, `colors`
   * one per band plus one for the top cap (no cap if the top radius is 0). `sx`/`sz` stretch it, `yaw` turns
   * it, `spin` turns the facets, `wobble` jitters each facet's radius.
   */
  function lathe(x, z, rings, colors, { sides = 8, yaw = 0, spin = 0, sx = 1, sz = 1, wobble = 0 } = {}) {
    const m = Array.from({ length: sides }, () => 1 + (rand() * 2 - 1) * wobble);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const p = (k, j) => {
      const a = spin + ((j % sides) / sides) * Math.PI * 2, r = rings[k][0] * m[j % sides];
      const lx = Math.cos(a) * r * sx, lz = Math.sin(a) * r * sz;
      return [x + lx * cy - lz * sy, rings[k][1], z + lx * sy + lz * cy];
    };
    for (let k = 0; k + 1 < rings.length; k++)
      for (let j = 0; j < sides; j++) {
        const a = p(k, j), b = p(k, j + 1), c = p(k + 1, j + 1), d = p(k + 1, j);
        if (rings[k + 1][0] > 1e-3) tri(a, d, c, colors[k]); // skip slivers where a ring closes to a point
        if (rings[k][0] > 1e-3) tri(a, c, b, colors[k]);
      }
    const last = rings.length - 1, [r, y] = rings[last];
    if (r > 1e-3 && colors[last] !== undefined) for (let j = 0; j < sides; j++) tri([x, y, z], p(last, j + 1), p(last, j), colors[last]);
  }
  const at = (angle, dist) => [Math.cos(angle) * (dist + push), Math.sin(angle) * (dist + push)];
  const box = ([x, z], w, d, h, hex, yaw) =>
    lathe(x, z, [[Math.SQRT1_2, 0], [Math.SQRT1_2, h]], [hex, hex], { sides: 4, spin: Math.PI / 4, sx: w, sz: d, yaw });
  const cylinder = ([x, z], r, h, hex, roof = hex) => lathe(x, z, [[r, 0], [r, h], [r * 0.2, h + r * 0.3]], [hex, roof, roof], { sides: 10 });
  // Latitude rings from `t0` up to the pole: -PI/2 for a whole sphere, 0 for a dome.
  const sphere = ([x, z], r, cy, hex, t0 = -Math.PI / 2) => {
    const rings = [];
    for (let i = 0; i <= 5; i++) {
      const t = t0 + (i / 5) * (Math.PI / 2 - t0);
      rings.push([r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    lathe(x, z, rings, rings.map(() => hex), { sides: 10 });
  };

  const build = (positions, colors) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  };

  if (kind === 'city') {
    lathe(0, 0, [[400 + push, -0.1], [58 + push, -0.1]], [COLORS.street], { sides: 32 });
    // Tower blocks, taller farther out, each turned to face the arena with its lit windows.
    const lit = { positions: [], colors: [] }, glow = new THREE.Color();
    for (let i = 0; i < 110; i++) {
      const angle = rand() * Math.PI * 2, dist = 135 + rand() * 190;
      const w = 14 + rand() * 26, d = 14 + rand() * 26, h = 35 + rand() * (dist - 90);
      const [x, z] = at(angle, dist), yaw = angle + Math.PI;
      box([x, z], w, d, h, rand() < 0.5 ? COLORS.block : COLORS.blockDark, yaw);
      // The local +x face looks at the arena: a grid of window slots on it, a quarter of them lit.
      const cy = Math.cos(yaw), sy = Math.sin(yaw), world = (lx, lz) => [x + lx * cy - lz * sy, z + lx * sy + lz * cy];
      for (let ly = 3; ly < h - 2; ly += 4) {
        for (let lz = -d / 2 + 2; lz < d / 2 - 1; lz += 3) {
          if (rand() > 0.25) continue;
          glow.set(windowColors[Math.floor(rand() * windowColors.length)]).multiplyScalar(0.5 + rand() * 0.5);
          const [ax, az] = world(w / 2 + 0.3, lz - 0.7), [bx, bz] = world(w / 2 + 0.3, lz + 0.7);
          lit.positions.push(ax, ly, az, bx, ly, bz, bx, ly + 1.2, bz, ax, ly, az, bx, ly + 1.2, bz, ax, ly + 1.2, az);
          for (let k = 0; k < 6; k++) lit.colors.push(glow.r, glow.g, glow.b);
        }
      }
    }
    const geometry = build(positions, colors);
    geometry.computeVertexNormals();
    return { geometry, windows: build(lit.positions, lit.colors) };
  }

  if (kind === 'forest') {
    lathe(0, 0, [[400 + push, -0.1], [58 + push, -0.1]], [COLORS.moss], { sides: 32 });
    // Wooded hills all round, and giant trees standing over them.
    for (let i = 0; i < 30; i++) {
      const angle = ((i + rand() * 0.7) / 30) * Math.PI * 2, h = 18 + rand() * 30, r = 40 + rand() * 40;
      lathe(...at(angle, 170 + rand() * 90), [[r, 0], [r * 0.7, h * 0.5], [r * 0.35, h * 0.9], [0, h]], [COLORS.hill, COLORS.hill, COLORS.hillTop], { sides: 9, wobble: 0.2, yaw: rand() * Math.PI });
    }
    for (let i = 0; i < 70; i++) {
      const [x, z] = at(rand() * Math.PI * 2, 150 + rand() * 120), h = 50 + rand() * 50;
      lathe(x, z, [[2 + rand() * 3, 0], [1.5, h]], [COLORS.trunk], { sides: 6 });
      sphere([x, z], 12 + rand() * 14, h, rand() < 0.5 ? COLORS.crown : COLORS.crownDark);
    }
    const geometry = build(positions, colors);
    geometry.computeVertexNormals();
    return { geometry, windows: null };
  }

  if (kind === 'swamp') {
    lathe(0, 0, [[400 + push, -0.1], [58 + push, -0.1]], [COLORS.mire], { sides: 32 });
    // Low scrubby islands, and dead trees standing out of the water, bare or with a scrap of crown.
    for (let i = 0; i < 40; i++) {
      const angle = ((i + rand() * 0.7) / 40) * Math.PI * 2, h = 4 + rand() * 10, r = 25 + rand() * 35;
      lathe(...at(angle, 160 + rand() * 100), [[r, 0], [r * 0.6, h * 0.6], [0, h]], [COLORS.scrub, COLORS.scrub], { sides: 8, wobble: 0.25, yaw: rand() * Math.PI });
    }
    for (let i = 0; i < 90; i++) {
      const [x, z] = at(rand() * Math.PI * 2, 140 + rand() * 130), h = 20 + rand() * 30, r = 0.8 + rand() * 1.5;
      lathe(x, z, [[r, 0], [r * 0.4, h]], [COLORS.snag], { sides: 5 });
      if (rand() < 0.4) sphere([x, z], 4 + rand() * 5, h - 2, COLORS.scrub);
    }
    const geometry = build(positions, colors);
    geometry.computeVertexNormals();
    return { geometry, windows: null };
  }

  // Salt flat from the arena wall out to the haze, just under the arena floor. Rings run outer to inner so it faces up.
  const land = kind === 'snow' ? SNOWFIELD : COLORS;
  lathe(0, 0, [[400 + push, -0.1], [58 + push, -0.1]], [land.flat], { sides: 32 });

  // Mesas: flat caprock over a cliff band and a sloping talus apron. The refinery sector gets low, far ones as a backdrop.
  const REFINERY = [3.45, 4.45]; // radians around the arena
  const MESAS = 26;
  for (let i = 0; i < MESAS; i++) {
    const angle = ((i + rand() * 0.6) / MESAS) * Math.PI * 2;
    const behind = angle > REFINERY[0] && angle < REFINERY[1];
    const dist = behind ? 235 + rand() * 25 : 150 + rand() * 110;
    const h = behind ? 10 + rand() * 10 : 10 + rand() * 30;
    const sx = 1 + rand() * 1.3;
    const r = Math.min(h * (0.9 + rand() * 1.6), 45, (dist - 105) / sx);
    const cliff = 0.5 + rand() * 0.25; // height where the cliff band starts, as a fraction
    lathe(...at(angle, dist), [[r, 0], [r * 0.85, h * cliff * 0.5], [r * 0.7, h * cliff], [r * 0.64, h]],
      [land.talus, land.scree, land.cliff, land.cap], { sides: 9, yaw: rand() * Math.PI, sx, wobble: 0.18 });
  }

  // Refinery on the horizon: cooling towers, stacks, columns, tank farm, spheres and process halls.
  for (const [angle, dist, h] of [[3.55, 212, 46], [3.68, 224, 40]]) {
    const rings = [];
    for (let i = 0; i <= 5; i++) {
      const y = (i / 5) * h, waist = h * 0.75; // hyperboloid: 0.45h radius at the base, 0.22h at the waist
      rings.push([h * 0.22 * Math.sqrt(1 + ((y - waist) / (h * 0.42)) ** 2), y]);
    }
    lathe(...at(angle, dist), rings, rings.slice(1).map((_, i) => (i === 4 ? COLORS.dark : COLORS.concrete)), { sides: 12 }); // open top
  }
  for (const [angle, dist, h, r] of [[3.86, 196, 42, 1.8], [3.95, 186, 55, 2], [4.0, 190, 48, 1.7], [4.18, 201, 38, 1.6], [4.36, 206, 60, 0.9]])
    lathe(...at(angle, dist), [[r, 0], [r * 0.85, h * 0.86], [r * 0.85, h]], [COLORS.steel, COLORS.rust, COLORS.dark], { sides: 6 });
  for (const [angle, dist, h, r] of [[4.07, 178, 32, 2.6], [4.11, 181, 26, 2], [4.04, 183, 22, 3]])
    lathe(...at(angle, dist), [[r, 0], [r, h], [0, h + r]], [COLORS.steel, COLORS.steel], { sides: 8 });
  for (let i = 0; i < 6; i++) cylinder(at(3.82 + i * 0.045 + rand() * 0.02, 168 + (i % 2) * 12), 5 + rand() * 3, 8 + rand() * 4, COLORS.tank, COLORS.steel);
  for (let i = 0; i < 3; i++) {
    const r = 5.5 + rand();
    sphere(at(4.22 + i * 0.04, 175 + rand() * 3), r, 3 + r, COLORS.tank); // on short legs
  }
  for (const [angle, dist, w, d, h] of [[3.78, 190, 24, 14, 9], [3.98, 205, 30, 12, 7], [4.15, 188, 16, 16, 12], [4.28, 192, 22, 10, 6]])
    box(at(angle, dist), w, d, h, COLORS.concrete, angle + Math.PI / 2);

  // Salt storage domes and silos off to one side: the plant's own stockpile.
  for (let i = 0; i < 3; i++) {
    const r = 10 + rand() * 4;
    sphere(at(1.02 + i * 0.09, 168 + rand() * 8), r, -0.15 * r, land.salt, 0);
  }
  for (let i = 0; i < 3; i++) cylinder(at(1.32 + i * 0.03, 182), 4, 18 + rand() * 4, COLORS.tank, COLORS.dark);
  // A pair of lonely stacks across the flats.
  for (const [angle, dist, h] of [[5.6, 240, 34], [5.63, 244, 28]]) lathe(...at(angle, dist), [[1.4, 0], [1.2, h]], [COLORS.dark, COLORS.dark], { sides: 6 });

  const geometry = build(positions, colors);
  geometry.computeVertexNormals(); // non-indexed, so these are flat facet normals
  return { geometry, windows: null };
}

/** `push` is a uniform: pushed-out pieces fog as if they were still where they were laid out. */
function skylineMaterial(push) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.push = push;
    shader.vertexShader = `uniform float push;\n${shader.vertexShader}`.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>\n#ifdef USE_FOG\n  vFogDepth = max(vFogDepth - push, 0.0) * ${SKYLINE_FOG.toFixed(2)};\n  vFogView *= vFogDepth / max(-mvPosition.z, 1e-3);\n#endif`,
    );
  };
  return material;
}

/**
 * Adds the sky dome and distant skyline to `scene`, and sets its fog and background to the horizon color.
 * `sunDir` points toward the sun (normalized), or the moon at night. Returns `{ fit(map), setHaze(on) }`:
 * `fit` moves the skyline clear of the map's `size`, sets the sky for its `night` (and `palette`:
 * `sky`, `fog`, `haze`, `skyline`, `windows`, `aurora`, `lightning`) and lays the haze on its lowest
 * floor. A storm's thunder goes out as a window `thunder` event ({ delay, close }) for the sound.
 */
export function createSky(scene, sunDir) {
  scene.background = new THREE.Color(SKY.day.horizon);
  scene.fog = new THREE.Fog(SKY.day.horizon, ...FOG);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMaterial(sunDir));
  dome.renderOrder = -1; // drawn first; without depth writes everything else draws over it
  dome.frustumCulled = false;
  const push = { value: 0 };
  const skyline = new THREE.Mesh(skylineGeometry(0).geometry, skylineMaterial(push));
  skyline.matrixAutoUpdate = false;
  // A city skyline's lit windows: unlit, unfogged specks.
  const windows = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  windows.matrixAutoUpdate = false;
  windows.frustumCulled = false;
  // A storm's lightning lights the world through this, as well as the sky and the fog.
  const flashLight = new THREE.HemisphereLight(0xc8d4ff, 0x404858, 0);
  scene.add(dome, skyline, windows, flashLight);
  const color = new THREE.Color(), fogBase = new THREE.Color(), WHITE = new THREE.Color(1, 1, 1);
  let storm = null;
  // Animated from the dome's own render, every frame: the aurora's drift and the lightning.
  dome.onBeforeRender = () => {
    const t = performance.now() / 1000, u = dome.material.uniforms;
    u.time.value = t % 10000;
    if (!storm) return;
    const { every: [lo, hi], strength = 1 } = storm.spec;
    if (t >= storm.next) {
      // A strike: two or three flickers over half a second, out of a random quarter of the sky,
      // its thunder a second or few behind (the nearer, the sharper).
      storm.at = t;
      storm.flickers = [0, 0.08 + 0.06 * Math.random(), 0.22 + 0.2 * Math.random()].slice(0, Math.random() < 0.5 ? 2 : 3);
      storm.next = t + lo + Math.random() * (hi - lo);
      const az = Math.random() * Math.PI * 2, el = 0.15 + Math.random() * 0.35;
      u.flashDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      const delay = 0.6 + Math.random() * 3;
      dispatchEvent(new CustomEvent('thunder', { detail: { delay, close: delay < 1.4 } }));
    }
    const k = Math.min(storm.flickers.reduce((sum, f) => sum + (t >= storm.at + f ? Math.exp(-(t - storm.at - f) * 14) : 0), 0), 1.2) * strength;
    u.flash.value = k;
    flashLight.intensity = 2.5 * k;
    scene.fog.color.copy(fogBase).lerp(WHITE, 0.4 * Math.min(k, 1));
    scene.background.copy(scene.fog.color);
  };
  let density = 0, hazy = true, built = '';
  const fit = (map) => {
    const { size: [w, d], night, palette = {} } = map;
    const look = { ...(night ? SKY.night : SKY.day), ...palette.sky }, u = dome.material.uniforms;
    u.horizon.value.set(look.horizon);
    u.zenith.value.set(look.zenith);
    u.sunColor.value.set(look.sun);
    u.stars.value = look.stars;
    scene.fog.color.set(look.horizon);
    fogBase.copy(scene.fog.color);
    u.aurora.value = palette.aurora?.strength ?? 0;
    if (palette.aurora) palette.aurora.colors.forEach((c, i) => u[i ? 'auroraHigh' : 'auroraLow'].value.set(c));
    storm = palette.lightning ? { spec: palette.lightning, next: performance.now() / 1000 + 3, at: -1e9, flickers: [] } : null;
    u.flash.value = flashLight.intensity = 0;
    [scene.fog.near, scene.fog.far] = palette.fog ?? FOG;
    scene.background.set(look.horizon);
    const [haze, , falloff] = palette.haze ?? look.haze;
    density = (palette.haze ?? look.haze)[1];
    const floor = Math.min(...map.solids.filter((s) => s.mat === 'ground').map((s) => s.box[1] + s.half[1]), ...(map.terrain?.heights.flat() ?? []));
    HAZE.set([hazy ? density : 0, falloff, floor, 0.85]);
    color.set(haze).convertLinearToSRGB().toArray(HAZE_COLOR);
    const value = Math.max(0, (Math.hypot(w, d) - LAID_OUT_FOR) / 2), kind = palette.skyline ?? 'desert';
    const key = `${value} ${kind} ${palette.windows} ${palette.tint}`;
    if (key === built) return;
    built = key;
    push.value = value;
    const next = skylineGeometry(value, kind, palette.windows, palette.tint);
    skyline.geometry.dispose();
    skyline.geometry = next.geometry;
    windows.geometry.dispose();
    windows.geometry = next.windows ?? new THREE.BufferGeometry();
  };
  const setHaze = (on) => { hazy = on; HAZE[0] = on ? density : 0; };
  return { fit, setHaze };
}
