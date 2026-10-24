import * as THREE from 'three';
import GUI from 'lil-gui';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import init, { WasmNetClient, WasmSim, map_name, mode_name, tick_dt } from '../sim/pkg/sim.js';
import tuning from '../tuning.json';
import classes from '../classes.json';
import weapons from '../weapons.json';
import tuningText from '../tuning.json?raw';
import classesText from '../classes.json?raw';
import weaponsText from '../weapons.json?raw';
import { buildArena, HIGH_ONLY, LOW_ONLY } from './arena.js';
import { Effects, HOT, halo, hot } from './fx.js';
import { Objectives, SENTRY, SHIP, SHIP_HULL } from './objectives.js';
import { Preview } from './hangar.js';
import saltworks from '../maps/saltworks.json';
import foundry from '../maps/foundry.json';
import verdigris from '../maps/verdigris.json';
import riftline from '../maps/riftline.json';
import sump from '../maps/sump.json';
import sinkhole from '../maps/sinkhole.json';
import blockout from '../maps/blockout.json';
import canopy from '../maps/canopy.json';
import crashsite from '../maps/crashsite.json';
import { CROUCH, LISTS, Mech, TEAMS, armament, ownLoadout, showRound, stoke, windUp } from './mech.js';
import { Debug } from './debug.js';
import { Cockpit } from './cockpit.js';
import { Sound } from './audio.js';
import { Hud, hex } from './hud.js';
import { createSky } from './sky.js';
import { STORE, fits, levelAt, levelXp, owns, pointsLeft, readRecord } from './progress.js';

await init();
const DT = tick_dt();
// Mech classes A, B, C by index. tuning.json is B with its own weapons; classes.json overrides
// values per class and weapons.json per weapon. A loadout indexes weapons.json's primaries and
// secondaries.
const CLASS_KEYS = ['A', 'B', 'C'];
let classIdx = 1; // offline: the picked class; online: what the server says we are
let loadout = ownLoadout('B'); // likewise, the weapons carried
const classValue = (cls, name) => classes[CLASS_KEYS[cls]].overrides[name] ?? tuning[name].value;
/** Value `name` for class `cls` carrying `l`: its weapons' if they set it, else its class's. */
const valueOf = (cls, l, name) => {
  const { primary, secondary } = armament(l);
  return secondary.stats[name] ?? primary.stats[name] ?? classValue(cls, name);
};
const T = (name) => valueOf(classIdx, loadout, name);

// Dev (Vite): ?server=ws://host:port/ws plays online, otherwise the offline sandbox. A production
// build plays online against the server that served it, unless ?offline.
const params = new URLSearchParams(location.search);
// In a room (`?room=CODE`, from the lobby) it joins that one; without, quick play picks one.
const room = params.get('room');
const sameOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${room ? `?room=${encodeURIComponent(room)}` : ''}`;
const server = params.get('server') ?? (import.meta.env.PROD && !params.has('offline') ? sameOrigin : null);
const net = server ? new WasmNetClient() : null;
// Maps by name; the sim's compiled-in list gives the index. Offline, ?map=<name> picks one.
const MAPS = { saltworks, blockout, foundry, verdigris, riftline, sump, sinkhole, canopy, crashsite };
const mapIndex = (name) => {
  for (let i = 0; map_name(i); i++) if (map_name(i) === name) return i;
  return 0;
};
const sim = net ? null : new WasmSim(JSON.stringify(tuning), mapIndex(params.get('map') ?? 'foundry'));
const game = net ?? sim;
// Each class's loadout as last picked on its card (saved locally by weapon, item and ability id),
// else its own.
const picks = CLASS_KEYS.map((key) => {
  const own = ownLoadout(key);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(`mechwar.loadout.${key}`)); } catch { /* private mode, or not JSON */ }
  const at = (slot) => {
    const k = weapons[LISTS[slot]].findIndex((w) => w.id === saved?.[slot] && fits(key, w));
    return k < 0 ? own[slot] : k;
  };
  return Object.fromEntries(Object.keys(LISTS).map((slot) => [slot, at(slot)]));
});
/** The loadout picking class `i` spawns with. */
const loadoutFor = (i) => picks[i];
/** Bytes asking the server for class `i` carrying its picked loadout. */
const pickMsg = (i) => {
  const l = loadoutFor(i);
  return net.pick(i, l.primary, l.secondary, l.offensive, l.support, l.ability);
};
/** How far the carried secondary's scope zooms (1 for none). */
const zoomOf = () => armament(loadout).secondary.zoom ?? 1;
let ws = null, connection = server ? 'connecting' : '', picked = null;
if (net) {
  ws = new WebSocket(server);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    connection = '';
    if (callsign()) ws.send(net.set_name(callsign()));
    // Our progression record, or "" for the server to start a guest one; before any pick, as the
    // server launches only the weapons it unlocks.
    ws.send(net.send_progress(stored(STORE) ?? ''));
    if (picked !== null) ws.send(pickMsg(picked));
  };
  ws.onmessage = (e) => net.receive(new Uint8Array(e.data), performance.now());
  ws.onclose = () => { connection = 'disconnected'; };
}

// Index layout of state(); keep in sync with mech_state in sim/src/wasm.rs.
const S = { POS: 0, VEL: 3, FUEL: 6, HEAT: 7, OVERHEATED: 8, GROUNDED: 9, BOOSTING: 10, HOVERING: 11, DODGE_CD: 12, SHOT: 13, AIM: 14, HEALTH: 17, ABILITY_T: 18, ABILITY_CD: 19, ALT_WAIT: 20, LAUNCHED: 21, REPAIR_T: 22, STAND: 23, GRENADES: 24, GRENADE_WAIT: 25, EMPS: 26, EMP_WAIT: 27, JAMMED: 28, THREW: 29, PULSED: 30, SPIN: 31, CHARGE: 32, BLOOM: 33, FIRE_WAIT: 34, LOCK: 35, LOCK_T: 36, BEAM: 37, BEAM_END: 38, SHIELD: 41, LIMPET: 42, OFFSET: 43 };
// The HUD marks our side in blue and the other side in red, whichever team we're on.
const FRIEND = TEAMS[0], FOE = TEAMS[1];
const DEATHMATCH = 1, MISSILE_ASSAULT = 2, SIEGE = 3; // their indices in the sim's Mode::ALL
/** Battleships' owner ids start here, past every player's (deploy::ship_owner). */
const SHIP_OWNERS = 8;
/** Base guns' owner ids start here, past the ships' (deploy::sentry_owner). */
const SENTRY_OWNERS = 10;
/** A solo kill's points in Deathmatch (Game's POINTS_PER_KILL with the killer's bonus); a Siege
 * launch's EU (siege::LAUNCH_EU). */
const DM_POINTS_PER_KILL = 125, LAUNCH_EU = 500;
// Volley indices of thrown items, from ITEM_N up; match projectile::GRENADE, LIMPET and SMOKE in
// sim/src/projectile.rs. THROWN gives each one's weapons.json id.
const GRENADE_N = 255, LIMPET_N = 254, ITEM_N = 253;
// A rocket turret's rockets' volley index (projectile::TURRET).
const TURRET_N = 252;
const THROWN = { 255: 'grenade', 254: 'limpet', 253: 'smoke' };
const BOMBLET_N = 100; // a splitting shell's bomblets carry volley indices from here up (projectile::BOMBLET)
// A shell whose velocity jumps more than this (m/s) between frames has bounced: gravity alone moves
// it under 1 m/s a frame, and a bounce at least halves its speed, glancing off a floor or square off a wall.
const BOUNCE_JUMP = 4;
// Seconds before a second RMB can burst an own shell; matches projectile::ARM.
const ARM = 0.2;

// --- Scene ---------------------------------------------------------------
const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
// Graphics are set on the picker and remembered; ?quality=low|high overrides the stored quality.
// High drops to Low if it can't hold 45 fps.
const gfx = { quality: 'high', bloom: true, shafts: true, haze: true, aa: true };
try { Object.assign(gfx, JSON.parse(stored('mechwar.graphics'))); } catch { /* corrupt: defaults */ }
let quality = (params.get('quality') ?? gfx.quality) === 'low' ? 'low' : 'high';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.info.autoReset = false; // the world and cockpit passes both count toward the stats
const glass = new Hud(document.getElementById('glass'));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const hemi = new THREE.HemisphereLight(0xdfe8f0, 0x4a4238, 1.4);
scene.add(hemi);
// Night maps swap the sun for a dim blue moon in the same spot; lamps and furnaces are baked in.
const LIGHTS = {
  day: { sky: 0xdfe8f0, ground: 0x4a4238, ambient: 1.4, sun: 0xfff0d8, direct: 2.6 },
  night: { sky: 0x6a7aa0, ground: 0x3a2a1e, ambient: 1.8, sun: 0x9fb4e8, direct: 1.6 },
};

// The sun's shadow map follows the player, covering the fight around them. A map's palette can
// put the sun (or the moon) elsewhere, `sunDir` pointing at it; the sky, shadows and cockpit follow.
const SUN_AT = [0.45, 0.8, 0.35];
const SUN_DIR = new THREE.Vector3(...SUN_AT).normalize();
const sky = createSky(scene, SUN_DIR); // dome, horizon fog and distant skyline, lit from the same sun
const SHADOW_HALF = 40;
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 1, far: 220 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const sunRight = new THREE.Vector3(), sunUp = new THREE.Vector3();
/** Points the sun along `at` and lines the shadow map's axes up with it. */
function aimSun(at) {
  SUN_DIR.set(...at).normalize();
  sunRight.crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  sunUp.crossVectors(SUN_DIR, sunRight);
}
aimSun(SUN_AT);
/** Centers the shadow map on `p`, snapped to whole shadow texels so edges don't shimmer. */
function placeSun(p) {
  const texel = (2 * SHADOW_HALF) / sun.shadow.mapSize.x;
  const snap = (v) => Math.round(v / texel) * texel;
  sun.target.position
    .copy(sunRight).multiplyScalar(snap(p.dot(sunRight)))
    .addScaledVector(sunUp, snap(p.dot(sunUp)))
    .addScaledVector(SUN_DIR, p.dot(SUN_DIR));
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 100);
}
const camera = new THREE.PerspectiveCamera(T('fov'), 1, 0.1, 500);
camera.rotation.order = 'YXZ';
// High quality draws the world into an HDR target for bloom, and OutputPass tone maps it to the
// screen. Only hot emissives (HOT), particle cores and the sun are bright enough to bloom: lit
// concrete stays under about 0.7 by day. The threshold is on the brightest channel, so red accents
// bloom like blue ones, and the widest blurs stay faint so a furnace mouth doesn't wash the view.
const composer = new EffectComposer(renderer);
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0, 1.1);
bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace('luminance( texel.xyz )', 'max( texel.r, max( texel.g, texel.b ) )');
[1, 1, 0.6, 0.2, 0].forEach((k, i) => bloom.bloomTintColors[i].setScalar(k));
composer.addPass(new RenderPass(scene, camera));
composer.addPass(bloom);
const output = new OutputPass();
output.needsSwap = false; // so every frame renders into the same target
composer.addPass(output);


const fx = new Effects(scene);
// Sound starts on the first click or key press, as browsers require.
const sound = new Sound();
const objectives = new Objectives(scene, fx, sound, (...ray) => game.cast_ray(...ray));
/** What an objective's called in callouts and on the glass. */
const objectiveName = (label) => (label === 'AA' ? 'THE AA GUN' : `SILO ${label}`);
Mech.audio = sound;
addEventListener('pointerdown', () => sound.unlock());
addEventListener('keydown', () => sound.unlock());
let me = new Mech(scene, fx, 'B'), meKit = '1:' + JSON.stringify(ownLoadout('B'));
me.own = true;
const cockpit = new Cockpit();
cockpit.setWeapons('B', me, T('eye_height'), T('mech_height') / me.height);

// The arena is built once its map is known: right away offline, after the Welcome online, and
// again whenever a new match is on another map.
let arenaMap = -1, arena = Object.assign([], { vents: [], furnaces: [], sparkers: [], lights: [] });
const ensureArena = (index) => {
  if (index < 0 || index === arenaMap) return;
  arenaMap = index;
  const map = MAPS[map_name(index)], light = { ...(map.night ? LIGHTS.night : LIGHTS.day), ...map.palette?.light };
  for (const m of arena) {
    scene.remove(m);
    m.geometry?.dispose();
    m.material?.dispose();
  }
  fx.clear();
  arena = buildArena(scene, map);
  aimSun(map.palette?.sunDir ?? SUN_AT);
  sky.fit(map);
  glass.setMap(map);
  objectives.setMap(map);
  hemi.color.set(light.sky);
  hemi.groundColor.set(light.ground);
  hemi.intensity = light.ambient;
  sun.color.set(light.sun);
  sun.intensity = light.direct;
  cockpit.light(hemi, sun);
  fx.setNight(!!map.night);
};
ensureArena(sim ? mapIndex(params.get('map') ?? 'foundry') : -1);

function applyQuality() {
  const high = quality === 'high', bloomed = high && gfx.bloom;
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1));
  renderer.shadowMap.enabled = sun.castShadow = high;
  fx.setQuality(high);
  bloom.enabled = bloomed;
  HOT.value = bloomed ? 2 : 1;
  sky.setHaze(gfx.haze);
  // The target's MSAA is most of High's cost: 11-11-10 float (no alpha) halves it against 16-bit
  // RGBA, and on a 2x screen two samples look as smooth as four.
  composer.reset(new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedInt101111Type, format: THREE.RGBFormat, samples: !gfx.aa ? 0 : renderer.getPixelRatio() > 1 ? 2 : 4 }));
  camera.layers.set(0);
  if (high && gfx.shafts) camera.layers.enable(HIGH_ONLY);
  if (!bloomed) camera.layers.enable(LOW_ONLY);
  document.getElementById('glass').classList.toggle('glow', high);
  $('quality').value = quality;
  $('high-fx').disabled = !high;
  // Shadow support is compiled into materials, so they need rebuilding.
  scene.traverse((o) => {
    if (o.material) o.material.needsUpdate = true;
  });
  resize();
}
// Other players by id: their mech, team, class, and a velocity estimated from interpolated motion.
const remotes = new Map();
const shots = []; // own predicted shots, drawn once this frame's pose is set
// Projectiles seen so far by id, with the launcher position each is drawn leaving from.
const launches = new Map(), blastAt = new THREE.Vector3();
const LAUNCH_BLEND = 0.15; // s
let hurt = 0, shake = 0, boostKick = 0, zoomKick = 0, message = '', messageUntil = 0;
let burstable = false; // an own shell is armed in flight
let incoming = null; // m to the nearest missile locked on us, or null
const BOOST_FOV = 6; // degrees
// HUD feedback: own hits and kills, where hits on us came from, and when each player last fired.
const hits = [], damageFrom = [], lastFired = new Map();

// --- Input ---------------------------------------------------------------
const keys = new Set();
let yaw = 0, pitch = 0, dodge = 0, ability = false, grenade = false, emp = false, firing = false, altFiring = false;
// The middle button: held (and latched until the next tick, so a quick click still reaches the
// sim), and a scoped secondary's zoom it toggles.
let auxHeld = false, aux = false, scoped = false;
// Always the cockpit, except while repairing: the camera pulls back to watch the mech shut down
// and returns once it has stood back up. `chase` eases from 0 (cockpit) to 1 (full chase distance).
let firstPerson = true, chase = 0;
const locked = () => document.pointerLockElement === renderer.domElement;
// Chrome rejects a re-lock right after Esc; the next click simply tries again.
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock()?.catch?.(() => {}));
document.addEventListener('pointerlockchange', () => {
  document.body.classList.toggle('locked', locked());
  if (!locked()) firing = altFiring = auxHeld = false;
  // Esc out in the arena opens the menu; taking the mouse back closes it.
  if (locked()) setMenu(false);
  else if (picked !== null && !pickerOpen) {
    unlockedAt = performance.now();
    setMenu(true);
  }
});
// Recoil, weapons.json `recoil`: each shot lifts the aim by up to this many degrees, less per shot
// the faster the weapon fires. The lift rises smoothly (at RECOIL_RISE/s) toward a kick that eases
// back down (at RECOIL_SETTLE/s), so a lone shot peaks at about two thirds of it. The lifted aim is
// what's sent, so a shot lands where the reticle was thrown.
const RECOIL = { none: 0, low: 0.6, medium: 1.5, high: 3 };
const RECOIL_RISE = 30, RECOIL_SETTLE = 6;
let recoilKick = 0, recoilLift = 0;
/** Kicks the aim for a shot from `weapon` (a weapons.json entry) firing `rate` times a second. */
function recoil(weapon, rate) {
  recoilKick += THREE.MathUtils.degToRad(RECOIL[weapon.recoil] ?? 0) / Math.sqrt(Math.max(rate, 1));
}
addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const limit = THREE.MathUtils.degToRad(T('pitch_limit_deg'));
  // Zoomed in, the view turns slower to match.
  const sens = T('mouse_sensitivity') / (1 + (zoomOf() - 1) * zoomKick);
  yaw -= e.movementX * sens;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * sens, -limit, limit);
});
addEventListener('mousedown', (e) => {
  if (!locked()) return;
  if (e.button === 0) firing = true;
  if (e.button === 2) altFiring = true;
  if (e.button === 1) {
    e.preventDefault();
    auxHeld = aux = true;
    if (zoomOf() > 1) scoped = !scoped;
  }
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) altFiring = false;
  if (e.button === 1) auxHeld = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  // Shift gestures: Shift+A/D dashes, Shift+S turns about; whichever key lands second triggers.
  const isShift = e.code === 'ShiftLeft' || e.code === 'ShiftRight';
  if (shift() && (e.code === 'KeyA' || e.code === 'KeyD')) dodge = e.code === 'KeyA' ? -1 : 1;
  else if (isShift && !keys.has('KeyW') && keys.has('KeyA') !== keys.has('KeyD')) dodge = keys.has('KeyA') ? -1 : 1;
  if ((shift() && e.code === 'KeyS') || (isShift && keys.has('KeyS') && !keys.has('KeyW'))) turnAbout();
  if (e.code === 'KeyF') ability = true;
  if (e.code === 'KeyG') grenade = true;
  if (e.code === 'KeyT') emp = true;
  if (e.code === 'KeyK' && sim) { sim.reset(); prev = curr = sim.state(); }
  if (e.code === 'KeyI') $('stats').hidden = !$('stats').hidden;
  if (e.code === 'KeyM') setMuted(!sound.muted);
  if (e.code === 'Tab') { e.preventDefault(); boardOpen = true; }
  if (e.code === 'KeyC' && picked !== null) pickerOpen = !pickerOpen;
  // Esc with the mouse free toggles the menu (not the Esc that just freed it, where a browser passes that on).
  if (e.code === 'Escape' && !locked() && performance.now() - unlockedAt > 200) setMenu(!menuOpen);
  const digit = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (digit >= 0 && !$('picker').hidden) showBay(digit);
  if (e.code === 'Enter' && !$('picker').hidden) launch(bay);
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') boardOpen = false;
});
addEventListener('blur', () => { keys.clear(); firing = altFiring = auxHeld = false; });
const axis = (pos, neg) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
const shift = () => keys.has('ShiftLeft') || keys.has('ShiftRight');
// Quick 180°: the view sweeps half a turn over TURN_TIME, eased, on top of the mouse.
const TURN_TIME = 0.22; // s
let turnT = -1;
const turnAbout = () => { if (turnT < 0) turnT = 0; };
const ease = (x) => x * x * (3 - 2 * x);

// --- Tuning panel ----------------------------------------------------------
// The sliders show and edit what's being played: the primary and secondary groups its weapons'
// weapons.json entries, the rest its class's classes.json overrides. The Medium's own weapons and
// body are tuning.json itself (• marks an override; moving any slider adds one).
const gui = new GUI({ title: 'Tuning' });
const folders = {}, sliders = [], values = {};
const push = () => {
  sim?.set_tuning(JSON.stringify(tuning));
  sim?.set_classes(JSON.stringify(classes));
  sim?.set_weapons(JSON.stringify(weapons));
};
/** The weapons.json entry slider group `group` edits, if it's a weapon's. */
const weaponFor = (group) => (group === 'primary' || group === 'secondary' ? armament(loadout)[group] : null);
const lancers = (w) => Object.values(classes.B.weapons).includes(w.id);
for (const [name, p] of Object.entries(tuning)) {
  // Online the sim runs on compiled-in tuning.json on both ends, so only camera values are live.
  // Bot values only matter to the server.
  if ((net && p.group !== 'camera') || p.group === 'bot') continue;
  Object.defineProperty(values, name, {
    get: () => T(name),
    set: (v) => {
      v = +v.toFixed(6); // no float dust from step snapping
      const w = weaponFor(p.group);
      if (w && !lancers(w)) w.stats[name] = v;
      else if (w || classIdx === 1) p.value = v;
      else classes[CLASS_KEYS[classIdx]].overrides[name] = v;
    },
  });
  folders[p.group] ??= gui.addFolder(p.group).close();
  sliders.push([name, p, folders[p.group].add(values, name, p.min, p.max, p.step).onChange(() => (push(), retune()))]);
}
(folders.move ?? folders.camera).open();
if (net) gui.close(); // online only camera values are live; keep the corner for the kill feed
/** Points the panel at the class and weapons being played: their values, override marks, names. */
function retune() {
  const c = classes[CLASS_KEYS[classIdx]], { primary, secondary } = armament(loadout);
  gui.title(`Tuning · ${c.name} · ${primary.name} · ${secondary.name}`);
  for (const [name, p, slider] of sliders) {
    const w = weaponFor(p.group), marked = w ? name in w.stats : classIdx !== 1 && name in c.overrides;
    slider.name(`${name} (${p.unit})${marked ? ' •' : ''}`).updateDisplay();
  }
}
// The copies are the repo's files with the panel's numbers swapped in, so a paste diffs only
// what changed. A value that's still equal keeps its original spelling (3.0 stays 3.0).
const swap = (old, now) => (Number(old) === now ? old : String(now));
const tuningFile = () =>
  tuningText.replace(/^( {2}"(\w+)":\s*\{ "value": )([^,]+),( *)/gm, (_, head, name, old, gap) => {
    const now = swap(old, tuning[name].value);
    return `${head}${now},${' '.repeat(Math.max(1, old.length + gap.length - now.length))}`;
  });
/** A JSON object's body `list` with `values`' numbers swapped in and new ones added on a line at `indent`. */
const swapBody = (list, values, indent) => {
  const body = list.replace(/"(\w+)": ([-\d.e]+)/g, (_, name, old) => `"${name}": ${swap(old, values[name])}`);
  const added = Object.keys(values).filter((name) => !list.includes(`"${name}":`)).map((name) => `"${name}": ${values[name]}`);
  if (!added.length) return body;
  return list.trim() ? body.replace(/\s*$/, (end) => `,\n${indent}${added.join(', ')}${end}`) : ` ${added.join(', ')} `;
};
const classesFile = () =>
  classesText.replace(/("(\w)": \{[^]*?"overrides": \{)([^}]*)\}/g, (_, head, key, list) => `${head}${swapBody(list, classes[key].overrides, '      ')}}`);
const weaponsFile = () =>
  weaponsText.replace(/("id": "(\w+)"[^]*?"stats": \{)([^}]*)\}/g, (_, head, id, list) => {
    const stats = [...weapons.primaries, ...weapons.secondaries].find((w) => w.id === id).stats;
    return `${head}${swapBody(list, stats, '        ')}}`;
  });
gui.add({ copy: () => navigator.clipboard.writeText(tuningFile()) }, 'copy').name('Copy tuning.json');
gui.add({ copy: () => navigator.clipboard.writeText(classesFile()) }, 'copy').name('Copy classes.json');
gui.add({ copy: () => navigator.clipboard.writeText(weaponsFile()) }, 'copy').name('Copy weapons.json');

// --- HUD -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
// Debug overlay: blast reach, shell paths with flight time and range, hit capsules (?debug, or
// the checkbox; remembered).
const debug = new Debug(scene, $('debug-log'));
const debugOn = { on: params.has('debug') || stored('mechwar.debug') === '1' };
debug.setOn(debugOn.on);
gui.add(debugOn, 'on').name('Debug overlay').onChange((on) => {
  debug.setOn(on);
  try { localStorage.setItem('mechwar.debug', on ? '1' : ''); } catch { /* private mode */ }
});
retune();
const hud = { net: $('net'), score: $('score'), banner: $('banner'), summary: $('summary'), damage: $('damage') };
// The top panel's side colors: ours and theirs, as everywhere on the glass.
document.documentElement.style.setProperty('--us', hex(FRIEND.accent));
document.documentElement.style.setProperty('--them', hex(FOE.accent));
let scoreHtml = '';

// --- Class picker ----------------------------------------------------------
// Shown before the first deploy and on death; C reopens it. Online the pick applies on the next
// spawn (or right away before the first input), so inputs are held until a class is chosen.
let pickerOpen = true, boardOpen = false, boardAt = 0;

// --- Menu ----------------------------------------------------------------------
// Esc: resume, the hangar, back to the lobby, with the scoreboard and the hangar's settings
// borrowed while it's open.
let menuOpen = false, unlockedAt = 0;
function setMenu(open) {
  menuOpen = open;
  $('menu').hidden = !open;
  $('to-hangar').hidden = picked === null || pickerOpen;
  if (open) $('menu-body').append($('board'), $('prefs'));
  else {
    $('score').after($('board'));
    $('callsign-row').after($('prefs'));
  }
}
$('resume').addEventListener('click', () => {
  setMenu(false);
  if (!pickerOpen) renderer.domElement.requestPointerLock()?.catch?.(() => {});
});
$('to-hangar').addEventListener('click', () => {
  setMenu(false);
  pickerOpen = true;
});
// A click beside the panel resumes too.
$('menu').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('resume').click(); });

// --- Callsign ----------------------------------------------------------------
// Typed on the picker, remembered locally, and sent (after a pause in typing) for the server to
// sanitize and share. Others' names come from the server's roster.
// Volume (picker slider) and mute (M), remembered between visits.
const volumeInput = $('volume');
volumeInput.value = stored('mechwar.volume') ?? '0.8';
sound.setVolume(Number(volumeInput.value));
volumeInput.addEventListener('input', () => {
  sound.setVolume(Number(volumeInput.value));
  try { localStorage.setItem('mechwar.volume', volumeInput.value); } catch { /* private mode */ }
});
function setMuted(muted) {
  sound.setMuted(muted);
  $('muted').hidden = !muted;
  try { localStorage.setItem('mechwar.muted', muted ? '1' : ''); } catch { /* private mode */ }
}
setMuted(stored('mechwar.muted') === '1');
// Graphics (picker): applied and remembered on every change.
for (const id of ['bloom', 'shafts', 'haze', 'aa']) $(id).checked = gfx[id];
$('graphics-row').addEventListener('change', ({ target }) => {
  if (target.id === 'quality') quality = gfx.quality = target.value;
  else gfx[target.id] = target.checked;
  try { localStorage.setItem('mechwar.graphics', JSON.stringify(gfx)); } catch { /* private mode */ }
  applyQuality();
});
applyQuality();
const callsignInput = $('callsign');
callsignInput.value = stored('mechwar.name') ?? '';
const callsign = () => callsignInput.value.trim();
let renameTimer = 0;
callsignInput.addEventListener('input', () => {
  clearTimeout(renameTimer);
  renameTimer = setTimeout(() => {
    try { localStorage.setItem('mechwar.name', callsign()); } catch { /* private mode */ }
    if (ws?.readyState === WebSocket.OPEN) ws.send(net.set_name(callsign()));
  }, 600);
});
/** Display name of player `id` (offline, only we exist). */
const nameOf = (id) => (net ? net.name(id) || `Pilot-${String(id).padStart(2, '0')}` : callsign() || 'You');
/** Player `id`'s level (0 for bots and offline). */
const levelOf = (id) => (net ? net.level(id) : 0);
// The last match's XP, shown with the banner until the next match starts.
let summary = null, wasEnded = false;
const esc = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Recent kills for the feed: names and team colors when they happened.
const feed = [];
// Our latest kill, named over the aim frame for a moment.
let eliminated = null, callout = null, capture = null, blipAt = 0;
/** Siege energy we carried as of the last frame; CARRY_MAX matches siege::CARRY_MAX. */
let heldBefore = 0, bankBefore = 0;
const ENERGY_COLOR = 0x5dff9a;
const CARRY_MAX = 100;
// Destroyed online by someone else: the camera follows them, their loadout showing, until we can
// launch again (or C opens the hangar sooner). `killcam` is their id, `killYaw` the camera's heading.
let killcam = null, killYaw = 0, killcamHtml = '';
const killEye = new THREE.Vector3();
/** Damage a second from value lookup `v`'s primary, sustained at full spin or charge, before falloff and heat. */
const dps = (v) => {
  const hit = v('shot_damage') * v('pellets') * (v('charge_time') > 0 ? v('charge_damage') : 1);
  return Math.round((hit * v('burst')) / (1 / v('fire_rate') + v('charge_time')));
};
// --- Hangar ----------------------------------------------------------------
// One bay per class, each holding the loadout last picked in it (saved locally by weapon id). The
// hangar shows before the first launch, on death and with C; Launch (or Enter) sends the shown
// bay's build. Online the mech waits in the hangar until launched, and changes made out in the
// arena apply at the next launch.
let bay = 1, launching = false;
// Our progression record as last stored: online, a mech carries its own weapons and those the
// record unlocks for it (the server holds to that); offline, everything.
let pilot = readRecord(stored(STORE) ?? '');
/** Whether class `i` may carry entry `k` of weapons.json's `list`. */
const ownsWeapon = (i, list, k) => !net || owns(pilot, CLASS_KEYS[i], weapons[list][k].id);
/** Whether class `i`'s picked loadout is all unlocked. */
const launchable = (i) => Object.entries(LISTS).every(([slot, list]) => ownsWeapon(i, list, picks[i][slot]));
/** For class `i`'s pick `k` of `list`, if locked: its price, and an UNLOCK button if we can afford it. */
const unlockRow = (i, list, k) => {
  if (ownsWeapon(i, list, k)) return '';
  const w = weapons[list][k], left = pilot ? pointsLeft(pilot) : 0;
  return `<div class="unlock">LOCKED · ${w.unlock} ${w.unlock === 1 ? 'POINT' : 'POINTS'} (${left} to spend)${left >= w.unlock ? `<button data-list="${list}" data-k="${k}">UNLOCK</button>` : ''}</div>`;
};
const preview = new Preview($('preview'), Math.max(...CLASS_KEYS.map((_, i) => classValue(i, 'mech_height'))));
/** Stat bars per slot: label, value from a lookup like `valueOf`'s, unit. */
const STATS = {
  primaries: [
    ['Damage/s', (v) => dps(v), ''],
    ['Range', (v) => Math.min(v('weapon_range'), v('falloff_end')), ' m'],
    ['Heat/s', (v) => (v('heat_per_shot') * v('burst')) / (1 / v('fire_rate') + v('charge_time')), ''],
  ],
  secondaries: [
    ['Damage', (v) => (v('alt_beam') > 0 ? v('alt_damage') : v('alt_damage') * Math.max(v('alt_count'), 1) + v('alt_split') * v('alt_split_damage')), ''],
    ['Blast', (v) => (v('alt_beam') > 0 ? 0 : v('alt_radius')), ' m'],
    ['Cooldown', (v) => v('alt_cooldown'), ' s'],
  ],
};
const shown = (x) => (x < 10 ? x.toFixed(1).replace(/\.0$/, '') : Math.round(x));
/** Bars for class `cls` carrying `l`, its `slot` weapon against the rest of `list`. */
const statBars = (cls, l, slot, list) => STATS[list].map(([label, f, unit]) => {
  const at = (k) => f((name) => valueOf(cls, { ...l, [slot]: k }, name));
  const x = at(l[slot]), max = Math.max(...weapons[list].map((_, k) => at(k)), 1e-6);
  return `<span>${label}</span><span class="bar"><i style="width: ${Math.round((100 * x) / max)}%"></i></span><span>${shown(x)}${unit}</span>`;
}).join('');
const bays = CLASS_KEYS.map((key, i) => {
  const b = document.createElement('button');
  b.className = 'bay';
  b.addEventListener('click', () => showBay(i));
  $('bays').append(b);
  return b;
});
function showBay(i) {
  bay = i;
  const key = CLASS_KEYS[i], c = classes[key], l = picks[i], { primary, secondary, offensive, support, ability } = armament(l);
  bays.forEach((b, k) => {
    const w = armament(picks[k]);
    b.classList.toggle('on', k === i);
    b.innerHTML = `${k + 1} · ${classes[CLASS_KEYS[k]].name}<small>${w.primary.name} · ${w.secondary.name}</small>`;
  });
  const chips = (slot, list) => weapons[list].map((w, k) => {
    if (!fits(key, w)) return '';
    const lock = ownsWeapon(i, list, k) ? '' : `<i>${w.unlock}</i>`;
    return `<label class="chip${lock && ' locked'}"><input type="radio" name="${slot}" value="${k}"${k === l[slot] ? ' checked' : ''}>${w.name}${lock}</label>`;
  }).join('');
  const points = net && pilot ? ` · ${pointsLeft(pilot)} unlock points` : '';
  $('slots').innerHTML = `
    <div class="slot"><b>${c.name.toUpperCase()}<span>${c.role}</span></b>HP ${classValue(i, 'health_max')} · ${classValue(i, 'walk_speed')} m/s${points}</div>
    <div class="slot"><b>PRIMARY<span>LMB</span></b><div class="chips">${chips('primary', 'primaries')}</div><div class="bars">${statBars(i, l, 'primary', 'primaries')}</div><p>${primary.desc}</p>${unlockRow(i, 'primaries', l.primary)}</div>
    <div class="slot"><b>SECONDARY<span>RMB · MMB</span></b><div class="chips">${chips('secondary', 'secondaries')}</div><div class="bars">${statBars(i, l, 'secondary', 'secondaries')}</div><p>${secondary.desc}</p>${unlockRow(i, 'secondaries', l.secondary)}</div>
    <div class="slot"><b>ITEM<span>G</span></b><div class="chips">${chips('offensive', 'offensive')}</div><p>${offensive.desc}</p>${unlockRow(i, 'offensive', l.offensive)}</div>
    <div class="slot"><b>SUPPORT ITEM<span>T</span></b><div class="chips">${chips('support', 'support')}</div><p>${support.desc}</p>${unlockRow(i, 'support', l.support)}</div>
    <div class="slot"><b>ABILITY<span>F</span></b><div class="chips">${chips('ability', 'abilities')}</div><p>${ability.desc}</p>${unlockRow(i, 'abilities', l.ability)}</div>`;
  preview.show(key, l, classValue(i, 'mech_height'));
}
$('slots').addEventListener('change', () => {
  const at = (slot) => +$('slots').querySelector(`[name="${slot}"]:checked`).value;
  picks[bay] = Object.fromEntries(Object.keys(LISTS).map((slot) => [slot, at(slot)]));
  const ids = Object.fromEntries(Object.entries(armament(picks[bay])).map(([slot, w]) => [slot, w.id]));
  try { localStorage.setItem(`mechwar.loadout.${CLASS_KEYS[bay]}`, JSON.stringify(ids)); } catch { /* private mode */ }
  showBay(bay);
});
$('slots').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-list]');
  if (!b || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(net.unlock(bay, Object.values(LISTS).indexOf(b.dataset.list), +b.dataset.k));
  b.disabled = true;
  b.textContent = 'UNLOCKING…';
});
$('launch').addEventListener('click', () => {
  launch(bay);
  renderer.domElement.requestPointerLock()?.catch?.(() => {});
});
showBay(bay);
/** Turns the view toward the middle of the map, where a fresh launch is headed. */
const faceCenter = () => (yaw = Math.atan2(curr[S.POS], curr[S.POS + 2]));

/** Launches bay `i`'s build: online from the hangar once the respawn delay is up (out in the arena it waits), offline at once. */
function launch(i) {
  if (net && ((picked !== null && curr[S.HEALTH] > 0) || !launchable(i))) return;
  scoped = false;
  picked = i;
  const l = loadoutFor(i);
  if (net) {
    launching = true;
    if (ws.readyState === WebSocket.OPEN) ws.send(pickMsg(i));
  } else {
    pickerOpen = false;
    classIdx = i;
    loadout = l;
    sim.set_class(i, l.primary, l.secondary, l.offensive, l.support, l.ability);
    sim.reset();
    prev = curr = sim.state();
    faceCenter();
  }
}

/** Seconds into a repair as Mech.update's `repair`: 0 none, wind-up fraction, then 1 healing. */
const repairPhase = (t, cls = classIdx) => (t > 0 ? Math.min(t / Math.max(classValue(cls, 'repair_windup'), 1e-6), 1) : 0);

// --- Fixed-step sim, interpolated render ----------------------------------
let prev = game.state(), curr = prev, acc = 0, last = performance.now();
const eye = new THREE.Vector3(), offset = new THREE.Vector3(), aim = new THREE.Vector3();
const pos = new THREE.Vector3(), vel = new THREE.Vector3(), seen = new THREE.Vector3(), step = new THREE.Vector3();
const beamFrom = new THREE.Vector3(), beamTo = new THREE.Vector3();
const BEAM_HOLD = 120; // ms a remote's beam stays drawn after the server last said it was on
// How faint camouflage draws a mech: our own or a teammate's (a ghost), and an enemy's (a veil
// that dims what's behind it by about 6%, on any map: faint, but there to see).
const CLOAK_SEEN = 0.25, CLOAK_HIDDEN = 0.05;
// Our own guns from the cockpit show it more strongly: the pilot's cue that they're hidden.
const CLOAK_GUNS = 0.5;
const ray = new THREE.Ray(), sphere = new THREE.Sphere(), crossing = new THREE.Vector3();
const heading = new THREE.Vector3(), chest = new THREE.Vector3(), to = new THREE.Vector3(), look = new THREE.Vector3(), ndc = new THREE.Vector3(), muzzle = new THREE.Vector3();
const spark = new THREE.Vector3();
/** Moves feet position `p` up to the chest of a class `cls` mech. */
const toChest = (p, cls) => { p.y += classValue(cls, 'mech_height') * 0.5; return p; };

/** The jump pad each mech stood on last frame, by remote id ('me' for us). */
const padStands = new Map(), padAt = new THREE.Vector3();

function frame(now) {
  renderer.info.reset();
  const dt = Math.min((now - last) / 1000, 0.25);
  acc += dt;
  last = now;
  if (turnT >= 0) {
    const before = ease(turnT / TURN_TIME);
    turnT = Math.min(turnT + dt, TURN_TIME);
    yaw += Math.PI * (ease(turnT / TURN_TIME) - before);
    if (turnT >= TURN_TIME) turnT = -1;
  }
  recoilKick *= Math.exp(-RECOIL_SETTLE * dt);
  const lift = recoilLift + (recoilKick - recoilLift) * (1 - Math.exp(-RECOIL_RISE * dt)), limit = THREE.MathUtils.degToRad(T('pitch_limit_deg'));
  pitch = THREE.MathUtils.clamp(pitch + lift - recoilLift, -limit, limit);
  recoilLift = lift;
  while (acc >= DT) {
    if (net && picked === null) {
      prev = curr = net.state();
      acc -= DT;
      continue;
    }
    // Shift+W boosts (the sim only boosts forward); with Shift held, S is the turn, not a step back.
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') && !shift() ? 1 : 0);
    const input = [axis('KeyD', 'KeyA'), forward, yaw, pitch,
      shift(), keys.has('Space'), dodge, firing, altFiring, ability, keys.has('KeyR'), grenade, emp, aux];
    if (net) {
      const bytes = net.tick(...input, now);
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    } else {
      sim.step(...input);
    }
    prev = curr;
    curr = game.state();
    // Dying online opens the hangar (checked every tick: a slow frame can run several), after the killcam if there is one.
    if (net && picked !== null && curr[S.HEALTH] <= 0 && prev[S.HEALTH] > 0 && killcam === null) pickerOpen = true;
    if (dodge && curr[S.DODGE_CD] > prev[S.DODGE_CD]) me.dodge(dodge);
    if (ability && curr[S.ABILITY_CD] > prev[S.ABILITY_CD]) me.ability();
    dodge = 0;
    ability = grenade = emp = false;
    aux = auxHeld;
    acc -= DT;
    // Hitscan pellets, where each stopped against the arena; a tick's are one shot, from one barrel.
    const ends = game.take_shots();
    for (let k = 0; k < ends.length; k += 3) shots.push(Object.assign(new THREE.Vector3(ends[k], ends[k + 1], ends[k + 2]), { first: k === 0 }));
    if (curr[S.SHOT]) recoil(armament(loadout).primary, T('fire_rate'));
    if (curr[S.LAUNCHED]) recoil(armament(loadout).secondary, 1 / T('alt_cooldown'));
    // Own EMPs show as predicted; the server's Pulse for them only marks hits. A Salve's orb
    // comes with the snapshots.
    if (curr[S.PULSED] && armament(loadout).support.id === 'emp') {
      sound.emp(null);
      fx.pulse(toChest(new THREE.Vector3(curr[S.POS], curr[S.POS + 1], curr[S.POS + 2]), classIdx), T('emp_radius'));
    } else if (curr[S.PULSED] && armament(loadout).support.id === 'orb') sound.salve(null);
  }
  const a = acc / DT;
  const lerp = (i) => prev[i] + (curr[i] - prev[i]) * a;
  if (net) ensureArena(net.map());
  const hudState = net ? net.hud() : null;
  const [myId, myTeam] = hudState ? [hudState[0], hudState[6]] : [-1, -1];
  // In Deathmatch everyone's their own team: paint us blue and the rest red, as by side.
  const dm = hudState?.[20] === DEATHMATCH, assault = hudState?.[20] === MISSILE_ASSAULT, sieging = hudState?.[20] === SIEGE;
  const zones = net ? net.zones() : new Float32Array(0), siege = net ? net.siege() : new Float32Array(0);
  // Objectives changing hands: a sound, and a callout.
  for (const { kind, label } of objectives.update(zones, myTeam, FRIEND.accent, FOE.accent, now)) {
    sound.zone(kind);
    callout = { text: `${kind === 'took' ? 'WE TOOK' : kind === 'lost' ? 'WE LOST' : 'ENEMY TOOK'} ${objectiveName(label)}`, color: hex(kind === 'took' ? FRIEND.accent : FOE.accent), at: now };
  }
  objectives.siege(siege, now);
  objectives.step(now, dt);
  const paint = (team) => (dm ? (team === myTeam ? 0 : 1) : team);
  if (hudState) [classIdx, loadout] = [hudState[12], { primary: hudState[14], secondary: hudState[15], offensive: hudState[17], support: hudState[18], ability: hudState[19] }];
  if (meKit !== `${classIdx}:${JSON.stringify(loadout)}`) {
    me.dispose();
    me = new Mech(scene, fx, CLASS_KEYS[classIdx], loadout);
    me.own = true;
    meKit = `${classIdx}:${JSON.stringify(loadout)}`;
    cockpit.setWeapons(CLASS_KEYS[classIdx], me, T('eye_height'), T('mech_height') / me.height);
    retune();
  }
  // Launching closes the hangar once the mech is out, facing into the map.
  const alive = curr[S.HEALTH] > 0;
  if (launching && alive) {
    launching = pickerOpen = false;
    faceCenter();
  }

  // The render offset slides server corrections (bumps) in instead of snapping.
  pos.set(lerp(S.POS) + lerp(S.OFFSET), lerp(S.POS + 1) + lerp(S.OFFSET + 1), lerp(S.POS + 2) + lerp(S.OFFSET + 2));
  me.setTeam(paint(myTeam));
  me.setUnit(myId);
  // Standing in an objective we're taking: a blip that climbs as it comes our way (quicker near the
  // end), a buzz while it's contested, and the bar on the glass.
  const here = alive && (assault || sieging) ? objectives.standing(pos, zones, myTeam) : null;
  capture = here && !here.secure ? { ...here, name: objectiveName(here.label) } : null;
  if (capture && now >= blipAt) {
    sound.capturing(capture.share, capture.contested);
    blipAt = now + (capture.contested ? 600 : 420 - 240 * capture.share);
  }
  // Drawing energy at a station with something in it: a hum that climbs as the hold fills, and
  // stops when it's full (with a soft tone as it fills, there or from a drop).
  const carried = hudState?.[22] ?? 0, station = alive && sieging ? objectives.stationAt(pos) : -1;
  sound.gathering(station >= 0 && carried < CARRY_MAX && siege[station] > 0.5 ? carried / CARRY_MAX : null);
  if (sieging && carried >= CARRY_MAX && heldBefore < CARRY_MAX) sound.full();
  // Our drop zone, pulsing while we carry; banking there (the only way a living mech's load goes
  // to nothing): a sound, a burst and a callout. A teammate's: the bank jumping, softer.
  objectives.showDropZones(sieging, myTeam, FRIEND.accent, FOE.accent, carried > 0, now);
  const bank = sieging && myTeam >= 0 ? siege[objectives.stations.length + myTeam] ?? 0 : 0;
  if (sieging && alive && heldBefore > 0 && carried === 0 && objectives.inDropZone(pos, myTeam)) {
    sound.deposit(true);
    objectives.banked(myTeam);
    callout = { text: `+${heldBefore} EU BANKED`, color: hex(ENERGY_COLOR), at: now };
  } else if (sieging && bank - bankBefore >= 5 && bankBefore > 0) {
    sound.deposit(false);
    objectives.banked(myTeam);
  }
  [heldBefore, bankBefore] = [carried, bank];
  // The server's respawn wait times it: our own predicted death can land a tick before or after the kill.
  if (killcam !== null && (pickerOpen || !remotes.has(killcam) || !(hudState?.[16] > 0))) {
    killcam = null;
    if (hudState?.[16] >= 0) pickerOpen = true;
  }
  chase += ((curr[S.REPAIR_T] > 0 || curr[S.STAND] > 0 ? 1 : 0) - chase) * (1 - Math.exp(-5 * dt));
  firstPerson = chase < 0.02 && killcam === null;
  me.root.visible = !firstPerson;
  // Camouflage shows us as a ghost: our mech in the chase view, our guns from the cockpit.
  const myCloak = curr[S.ABILITY_T] > 0 && armament(loadout).ability.id === 'cloak' ? CLOAK_SEEN : 0;
  sound.stealth(myCloak > 0);
  me.update(dt, {
    pos, yaw, pitch, scale: T('mech_height') / me.height,
    vel: vel.set(lerp(S.VEL), lerp(S.VEL + 1), lerp(S.VEL + 2)),
    grounded: !!curr[S.GROUNDED], boosting: !!curr[S.BOOSTING], hovering: !!curr[S.HOVERING],
    health: curr[S.HEALTH], heat: curr[S.HEAT] / T('heat_max'), overheated: !!curr[S.OVERHEATED],
    ability: curr[S.ABILITY_T] > 0, damage: 1 - curr[S.HEALTH] / T('health_max'), shielded: !!curr[S.SHIELD],
    repair: repairPhase(curr[S.REPAIR_T]), cloak: myCloak,
  });
  if (curr[S.JAMMED] > 0) fx.jam(toChest(spark.copy(pos), classIdx), dt);

  if (net) {
    const r = net.remotes(now), live = new Set();
    for (let i = 0; i < r.length; i += 21) {
      const [id, team, cls, x, y, z, ryaw, rpitch, health, boosting, hovering, bot, abilityOn, repairing, primary, secondary, docked, shielded, ability, offensive, support] = r.subarray(i, i + 21);
      if (docked) continue; // in the hangar: nothing to draw
      let e = remotes.get(id);
      if (e && (e.cls !== cls || e.mech.loadout.primary !== primary || e.mech.loadout.secondary !== secondary || e.mech.loadout.ability !== ability)) {
        e.mech.dispose();
        e = null;
      }
      if (!e) remotes.set(id, (e = { mech: new Mech(scene, fx, CLASS_KEYS[cls], { primary, secondary, ability }), cls, team, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3() }));
      live.add(id);
      // Gait speed comes from interpolated motion; a jump (respawn, slot reuse) resets it.
      seen.set(x, y, z);
      if (dt === 0 || seen.distanceTo(e.pos) > 8) e.vel.set(0, 0, 0);
      else e.vel.lerp(step.subVectors(seen, e.pos).divideScalar(dt), 0.3);
      e.pos.copy(seen);
      e.team = team;
      e.health = health;
      e.yaw = ryaw;
      e.loadout = { primary, secondary, offensive, support, ability };
      // Remotes only say whether they're repairing; time the wind-up from when it started.
      e.repairAt = repairing ? e.repairAt ?? now : null;
      Object.assign(e, { bot: !!bot, ability: !!abilityOn, repairing: !!repairing, boosting: !!boosting, hovering: !!hovering });
      // Camouflage hides an enemy all but completely (`hidden`: no tag, radar contact or effects
      // around it either); a teammate shows as a ghost.
      e.cloaked = !!abilityOn && e.mech.weapons.ability.id === 'cloak';
      e.hidden = e.cloaked && team !== myTeam;
      e.mech.setTeam(paint(team));
      e.mech.setUnit(id);
      e.mech.update(dt, {
        pos: e.pos, yaw: ryaw, pitch: rpitch, scale: classValue(cls, 'mech_height') / e.mech.height, vel: e.vel,
        grounded: !hovering && Math.abs(e.vel.y) < 1.5, boosting: !!boosting, hovering: !!hovering, health,
        ability: !!abilityOn, damage: 1 - health / classValue(cls, 'health_max'), shielded: !!shielded,
        repair: repairPhase(e.repairAt === null ? 0 : (now - e.repairAt) / 1000 + 1e-3, cls),
        cloak: e.hidden ? CLOAK_HIDDEN : e.cloaked ? CLOAK_SEEN : 0, hidden: e.hidden,
      });
      if (now - (e.beamAt ?? -Infinity) < BEAM_HOLD) fx.mend(id + 1, e.mech.launcher.getWorldPosition(beamFrom), e.beamTo, dt);
      if (now < (e.jammedUntil ?? 0) && !e.hidden) fx.jam(toChest(spark.copy(e.pos), cls), dt);
      if (health > 0) debug.hitbox(e.pos, classValue(cls, 'mech_radius'), classValue(cls, 'mech_height') * (repairing ? CROUCH : 1));
    }
    for (const [id, e] of remotes) if (!live.has(id)) { e.mech.dispose(); remotes.delete(id); }
  }

  // Shots and kills come from the server; blasts and splash hits also happen offline.
  const ev = game.take_events();
  for (let i = 0; i < ev.length; i += 6) {
    const [kind, a, b, x, y, z] = ev.subarray(i, i + 6);
    if (kind === 0) {
      // Own shots were drawn when predicted; everyone else's come from the server.
      if (a !== myId) {
        remotes.get(a)?.mech.fire(new THREE.Vector3(x, y, z));
        lastFired.set(a, now);
      }
    }
    if ((kind === 0 && b >= 0) || kind === 3) {
      if (a === myId) {
        hits.push({ at: now, kill: false });
        sound.hitConfirm();
      }
      if (b === myId) tookHit(a, now);
      else remotes.get(b)?.mech.hit();
    }
    if (kind === 1 && a === myId) {
      hits.push({ at: now, kill: true });
      sound.kill();
    }
    if (kind === 1 && b === myId) sound.died();
    if (kind === 1) {
      const teamOf = (id) => (id === myId ? myTeam : remotes.get(id)?.team ?? -1);
      const color = (id) => hex((teamOf(id) < 0 ? TEAMS[-1] : teamOf(id) === myTeam ? FRIEND : FOE).accent);
      feed.push({ at: now, killer: nameOf(a), victim: nameOf(b), killerColor: color(a), victimColor: color(b), mine: a === myId || b === myId });
      if (feed.length > 5) feed.shift();
      if (a === myId && b !== myId) eliminated = { name: nameOf(b), at: now };
      else if (myId >= 0 && b !== myId && x & (1 << myId)) eliminated = { name: nameOf(b), at: now, assist: true };
      // Watch the killer first (if dying already opened the hangar this frame, close it).
      if (b === myId && a !== myId && remotes.has(a)) {
        killcam = a;
        killYaw = remotes.get(a).yaw;
        pickerOpen = false;
      }
    }
    if (kind === 1 && (a === myId || b === myId)) { message = a === myId ? 'ENEMY DESTROYED' : 'DESTROYED'; messageUntil = now + 2500; }
    if (kind === 10) {
      callout = { text: `${a === myTeam ? 'OUR' : 'ENEMY'} BATTLESHIP ${b ? 'LAUNCHED' : 'DOWN'}`, color: hex(a === myTeam ? FRIEND.accent : FOE.accent), at: now };
      if (b) objectives.shipLaunched(a);
      else objectives.shipDown(a);
    }
    if (kind === 9) objectives.launch(a, b, now, b === myTeam ? FRIEND.accent : FOE.accent);
    if (kind === 2) {
      blastAt.set(x, y, z);
      debug.blast(blastAt, b);
      fx.explosion(blastAt, b / 5);
      sound.blast(b, blastAt, a);
      fx.muzzleLight(blastAt);
    }
    if (kind === 4) {
      // EMP: b is a bitmask of who it jammed. Our own jam shows from our predicted state.
      const cls = a === myId ? classIdx : remotes.get(a)?.cls ?? 1;
      if (a !== myId) {
        fx.pulse(blastAt.set(x, y, z), classValue(cls, 'emp_radius'));
        sound.emp(blastAt);
      }
      if (a === myId && b) hits.push({ at: now, kill: false });
      for (const [id, e] of remotes) if (b & (1 << id)) e.jammedUntil = now + 1000 * classValue(cls, 'emp_jam');
    }
    if (kind === 6) {
      // A round from player a's MG turret, from its gun.
      const from = turretGuns.get(`${a}:2`);
      if (from) {
        const end = new THREE.Vector3(x, y, z);
        fx.muzzleLight(from);
        fx.muzzle(from, heading.subVectors(end, from).normalize());
        fx.beam(from, end);
        fx.impact(end);
        // A battleship's guns (owners past every player's) boom; a turret rattles.
        if (a >= SENTRY_OWNERS) sound.shot('rotary', from);
        else if (a >= SHIP_OWNERS) sound.shipGun(from);
        else sound.shot('vulcan', from);
      }
      if (b >= 0 && a === myId) hits.push({ at: now, kill: false });
      if (b === myId) tookHit(a, now, from);
      else if (b >= 0) remotes.get(b)?.mech.hit();
    }
    if (kind === 7 && a === myId) {
      // We hit a turret: a hit marker, and a kill's once it's wrecked.
      hits.push({ at: now, kill: b > 0 });
      sound.hitConfirm();
    }
    if (kind === 5 && a !== myId) {
      // A remote's held beam; our own is drawn from our prediction.
      const e = remotes.get(a);
      if (e) (e.beamTo ??= new THREE.Vector3()).set(x, y, z), (e.beamAt = now);
    }
  }

  // Projectiles: own ones extrapolated like the own mech, others already at render time. Each is
  // drawn leaving its launcher (primary fire: a gun) and eases onto its sim path (which starts at
  // the eye). A primary shot's pellets all leave the barrel its first pellet picked.
  const pr = game.projectiles(now), drawn = [], live = new Set(), jets = [];
  let gunAt = null;
  burstable = false;
  incoming = null;
  for (let i = 0; i < pr.length; i += 16) {
    const [owner, seq, n, , x, y, z, vx, vy, vz, age, predicted, primary, weapon, charge, target] = pr.subarray(i, i + 16);
    if (alive && myId >= 0 && target - 1 === myId) incoming = Math.min(incoming ?? Infinity, Math.hypot(x - pos.x, y - pos.y, z - pos.z));
    const secondary = primary ? null : weapons.secondaries[weapon];
    const key = `${owner}:${seq}:${n}:${primary}`, ahead = predicted ? a * DT : 0;
    const mech = predicted ? me : remotes.get(owner)?.mech;
    const bomblet = !primary && n >= BOMBLET_N && n < TURRET_N; // born in the air, where its shell split
    const item = !primary && n >= ITEM_N, turret = !primary && n === TURRET_N;
    let shot = launches.get(key);
    if (!shot) {
      let from = null;
      if (primary) {
        if (n === 0) gunAt = mech?.muzzle(heading.set(vx, vy, vz).normalize(), predicted && firstPerson ? cockpit.fire(camera, new THREE.Vector3()) : null, charge) ?? null;
        from = gunAt;
      } else if (turret) {
        // From the owner's rocket turret, which gives nobody away.
        from = turretGuns.get(`${owner}:3`)?.clone() ?? null;
        if (from) fx.burst(from, heading.set(vx, vy, vz).normalize());
        sound.launch(weapons.secondaries[weapon].sound, from ?? { x, y, z });
      } else if (!bomblet) {
        from = predicted && firstPerson && n === 0 ? cockpit.fire(camera, new THREE.Vector3(), true) : mech?.launcher.getWorldPosition(new THREE.Vector3());
        if (n === 0) mech?.launch(from);
        if (item) sound.grenade(predicted ? null : { x, y, z });
      }
      launches.set(key, (shot = { from: from ?? new THREE.Vector3(x, y, z) }));
      if (!predicted && !turret) lastFired.set(owner, now);
    }
    live.add(key);
    if (predicted && !primary && !item && !bomblet && age >= ARM - DT / 2) burstable = true;
    const p = new THREE.Vector3(x + vx * ahead, y + vy * ahead, z + vz * ahead);
    const blend = Math.min((age + ahead) / LAUNCH_BLEND, 1);
    if (blend < 1) p.lerp(shot.from, 1 - blend);
    const look = item ? (n === LIMPET_N ? 'mine' : 'grenade') : bomblet ? 'bomblet' : (primary ? weapons.primaries[weapon] : secondary)?.projectile, vel = new THREE.Vector3(vx, vy, vz);
    // A rail slug outruns the eye, gone a frame or two after it leaves: trace its path from the
    // launcher, like a hitscan round's.
    if (look === 'rail') fx.beam(shot.from, new THREE.Vector3(x + vx * ahead, y + vy * ahead, z + vz * ahead));
    // A shell or grenade whose velocity jumps between frames has bounced: it clanks, as hard as the
    // jump (one that stops dead, a mine sticking, doesn't).
    if (!primary && shot.vel) {
      const jump = shot.vel.distanceTo(vel);
      if (jump > BOUNCE_JUMP && vel.length() > 1) sound.clank(p, jump, item);
    }
    shot.vel = vel;
    if (look === 'rocket' || look === 'dart') jets.push({ x: p.x, y: p.y, z: p.z, dart: look === 'dart' });
    drawn.push({ pos: p, vel, look, charge, age: age + ahead, primary: !!primary, grenade: item && n !== LIMPET_N });
    if (!primary) debug.shell(key, item ? weapons.offensive.find((w) => w.id === THROWN[n])?.name : secondary.name, p, age + ahead);
  }
  for (const key of launches.keys()) if (!live.has(key)) launches.delete(key);
  debug.endShells(live);
  fx.projectiles(drawn, dt);
  jets.push(...objectives.exhausts());
  sound.exhausts(jets);
  drawOrbs(now, dt, alive, myTeam);
  drawSmoke(dt);
  drawDeployables(now, myTeam);
  objectives.drawShips(game.deployables(), zones, myTeam, FRIEND.accent, FOE.accent, now, dt, turretGuns);
  objectives.drawSentries(game.deployables(), myTeam, FRIEND.accent, FOE.accent, dt, turretGuns);

  // Look is applied at render rate for responsiveness; position is interpolated. In the cockpit
  // the view bobs with the gait and shakes when hit, but stays level (no roll).
  eye.copy(pos).y += T('eye_height');
  camera.position.copy(eye);
  const killer = remotes.get(killcam);
  if (killer) {
    // Behind and above the killer, easing round as they turn; backed against a wall, from high
    // over them instead. Either way pulled in front of what's in the way.
    const turn = killer.yaw - killYaw;
    killYaw += Math.atan2(Math.sin(turn), Math.cos(turn)) * (1 - Math.exp(-4 * dt));
    killEye.copy(killer.pos).y += classValue(killer.cls, 'mech_height') * 0.8;
    for (const [tilt, up, back] of [[-0.22, 2.5, 10], [-0.9, 7, 4]]) {
      camera.rotation.set(tilt, killYaw, 0);
      offset.set(0, up, back).applyQuaternion(camera.quaternion);
      const want = offset.length();
      const room = game.cast_ray(killEye.x, killEye.y, killEye.z, offset.x, offset.y, offset.z, want + 0.5) - 0.5;
      camera.position.copy(killEye).addScaledVector(offset, Math.max(room, 0.5) / want);
      if (room > want * 0.6) break;
    }
  } else if (firstPerson) {
    camera.rotation.set(pitch, yaw, 0);
    camera.position.y += (me.body.position.y - me.spec.hipY) * 0.6;
    if (shake > 0.01) camera.translateX((Math.random() - 0.5) * 0.14 * shake).translateY((Math.random() - 0.5) * 0.14 * shake);
  } else {
    camera.rotation.set(pitch, yaw, 0);
    // Pull the chase camera in front of any wall behind the mech.
    offset.set(0, T('chase_height'), T('chase_distance')).applyQuaternion(camera.quaternion);
    const want = offset.length();
    const room = game.cast_ray(eye.x, eye.y, eye.z, offset.x, offset.y, offset.z, want + 0.5) - 0.5;
    camera.position.addScaledVector(offset, (Math.max(room, 0.5) / want) * chase);
  }
  shake *= Math.exp(-6 * dt);
  // A small FOV kick while boosting sells the speed.
  boostKick += ((curr[S.BOOSTING] ? 1 : 0) - boostKick) * (1 - Math.exp(-6 * dt));
  // A scoped secondary (weapons.json `zoom`) narrows the view while toggled on with the middle button.
  zoomKick += ((firstPerson && scoped && zoomOf() > 1 ? 1 : 0) - zoomKick) * (1 - Math.exp(-10 * dt));
  const fov = (T('fov') + BOOST_FOV * boostKick) / (1 + (zoomOf() - 1) * zoomKick);
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
  cockpit.setTeam(paint(myTeam));
  // Shade the cockpit when anything stands between the eye and the sun.
  const shaded = firstPerson && game.cast_ray(eye.x, eye.y, eye.z, SUN_DIR.x, SUN_DIR.y, SUN_DIR.z, 150) < 150;
  cockpit.update(dt, camera, SUN_DIR, T('fov'), shaded);
  cockpit.windUp(curr[S.SPIN], curr[S.CHARGE], curr[S.ALT_WAIT] <= 0, dt);
  cockpit.cloak(myCloak && CLOAK_GUNS, now);
  windUp(me.guns[0].pod, curr[S.SPIN], curr[S.CHARGE], dt);
  showRound(me.arms[1], curr[S.ALT_WAIT] <= 0);
  for (const pod of [me.arms[1], cockpit.weapons?.launcher.pod]) if (pod) stoke(pod, curr[S.HEAT] / T('heat_max'));
  // A held beam, from the launcher (the cockpit's, in first person) to where the sim says it stops.
  if (curr[S.BEAM]) {
    const from = firstPerson && cockpit.weapons ? cockpit.launcherTip(camera, beamFrom) : me.launcher.getWorldPosition(beamFrom);
    fx.mend(0, from, beamTo.set(curr[S.BEAM_END], curr[S.BEAM_END + 1], curr[S.BEAM_END + 2]), dt);
  }
  // ...and light it from the night lamps and flashes nearby (not our own guns': the cockpit flashes those).
  if (firstPerson) {
    const flashes = fx.lights
      .filter(({ light, life, own }) => light.visible && life > 0 && !own)
      .map(({ light }) => ({ at: light.position, rgb: light.color, radius: light.distance, power: light.intensity / 20 }));
    cockpit.local(camera, [...arena.lights, ...flashes], (at) => {
      const d = to.subVectors(at, eye).length();
      to.divideScalar(d);
      return game.cast_ray(eye.x, eye.y, eye.z, to.x, to.y, to.z, d) >= d - 0.5;
    });
  }

  // The predicted aim point only knows the arena, so stop own tracers at the first enemy mech
  // they cross (visual only; the server decides hits).
  for (const end of shots) {
    ray.origin.copy(pos).y += T('eye_height');
    ray.direction.subVectors(end, ray.origin);
    let reach = ray.direction.length();
    ray.direction.normalize();
    for (const e of remotes.values()) {
      if (!e.mech.alive || e.team === myTeam) continue;
      for (const h of [0.32, 0.68]) {
        sphere.center.copy(e.pos).y += h * classValue(e.cls, 'mech_height');
        sphere.radius = classValue(e.cls, 'mech_radius');
        if (ray.intersectSphere(sphere, crossing)) reach = Math.min(reach, crossing.distanceTo(ray.origin));
      }
    }
    me.fire(ray.at(reach, end), firstPerson ? (end.first ? cockpit.fire(camera, muzzle) : muzzle) : null);
  }
  shots.length = 0;

  placeSun(pos);
  // Sound follows the camera; thrusters for us and the nearest others, and the cockpit loops.
  sound.listen(camera);
  const others = [];
  for (const e of remotes.values()) {
    if (e.mech.alive) others.push({ x: e.pos.x, y: e.pos.y + 1, z: e.pos.z, level: e.boosting ? 2 : e.hovering ? 1 : 0 });
  }
  sound.thrusters(alive ? (curr[S.BOOSTING] ? 2 : curr[S.HOVERING] ? 1 : 0) : 0, others);
  sound.cockpit({
    alive, heat: curr[S.HEAT] / T('heat_max'), overheated: !!curr[S.OVERHEATED],
    hull: curr[S.HEALTH] / T('health_max'), repairing: repairPhase(curr[S.REPAIR_T]), jammed: curr[S.JAMMED] > 0, beaming: !!curr[S.BEAM],
    spin: curr[S.SPIN], charge: curr[S.CHARGE], incoming,
    lock: curr[S.LOCK] > 0 ? Math.min(curr[S.LOCK_T] / Math.max(T('alt_lock_time'), 1e-6), 1) : 0,
  }, dt);
  // A jump pad fires as a mech leaves it upward: a pulse on the pad and a thump.
  const onPad = (p) => arena.pads?.find((d) => Math.abs(p.y - d.at[1]) < 1 && Math.hypot(p.x - d.at[0], p.z - d.at[2]) < 2.5);
  for (const [key, p] of [['me', { x: curr[S.POS], y: curr[S.POS + 1], z: curr[S.POS + 2] }], ...[...remotes].map(([id, e]) => [id, e.pos])]) {
    const was = padStands.get(key), now = onPad(p);
    if (was && !now && p.y > was.at[1] + 1 && !remotes.get(key)?.hidden) {
      fx.pulse(padAt.set(...was.at), 3);
      sound.pad(key === 'me' ? null : padAt);
    }
    padStands.set(key, now);
  }
  // Stacks smoke and spark, furnaces spit sparks, and an industrial map's air carries cinders.
  for (const p of arena.vents) {
    fx.plume(p, dt);
    fx.sparks(p, dt, 10);
  }
  for (const p of arena.furnaces) fx.sparks(p, dt, 5);
  for (const p of arena.sparkers) if (Math.random() < dt * 0.6) fx.sparks(p, 0.25, 40); // fitful bursts of ten
  if (arena.vents.length) fx.cinders(camera.position, dt);
  if (arena.motes) fx.motes(camera.position, dt, arena.motes);
  fx.update(dt, camera, renderer.domElement.height);
  hurt = Math.max(0, hurt - dt * 2.5);
  hud.damage.style.opacity = hurt;

  $('picker').hidden = !pickerOpen;
  if (pickerOpen) {
    // Out in the arena, the hangar only edits the next launch.
    const out = net && picked !== null && alive, wait = net ? Math.max(hudState[16], 0) : 0;
    const locked = !launchable(bay);
    $('launch').hidden = out;
    $('launch').disabled = locked;
    $('launch').textContent = launching ? (wait > 0 ? `LAUNCHING IN ${wait.toFixed(1)} S` : 'LAUNCHING…') : locked ? 'LOCKED' : wait > 0 ? `LAUNCH · READY IN ${wait.toFixed(1)} S` : 'LAUNCH';
    $('picker-note').textContent = locked ? 'Unlock what’s locked, or pick another' : out ? 'Changes apply at your next launch · C to close' : 'Enter or Launch when ready';
    preview.render(dt, paint(myTeam));
  }
  drawGlass(now, myTeam);
  $('killcam').hidden = !killer;
  $('glass').hidden = !!killer; // the reticle and our own hull have nothing to say about their view
  if (killer) {
    const { primary, secondary, offensive, support, ability } = armament(killer.loadout);
    const level = levelOf(killcam), wait = Math.max(hudState[16], 0);
    const html = `<small>ELIMINATED BY</small><b>${esc(nameOf(killcam))}</b>${killer.bot ? ' <i>BOT</i>' : level ? ` <i>LV${level}</i>` : ''}`
      + `<div>${classes[CLASS_KEYS[killer.cls]].name} · ${Math.max(0, Math.round((100 * killer.health) / classValue(killer.cls, 'health_max')))}% armor</div>`
      + `<dl>${[['PRIMARY', primary], ['SECONDARY', secondary], ['ITEM', offensive], ['SUPPORT', support], ['ABILITY', ability]].map(([slot, w]) => `<div><dt>${slot}</dt><dd>${esc(w.name)}</dd></div>`).join('')}</dl>`
      + `<small>HANGAR IN ${wait.toFixed(1)} S · C TO OPEN NOW</small>`;
    if (html !== killcamHtml) $('killcam').innerHTML = killcamHtml = html;
  }
  $('board').hidden = !boardOpen && !menuOpen;
  if ((boardOpen || menuOpen) && now - boardAt > 250) {
    boardAt = now;
    renderBoard(myId, hudState);
  }
  if (net) {
    const [, kills, deaths, ping, correction, full, team, blue, red, secondsLeft, ended, winner, , nextMap] = hudState;
    const nextMode = hudState[21];
    const state = full ? 'server full' : connection || (curr[S.HEALTH] <= 0 ? (picked === null ? 'in the hangar' : 'DESTROYED · launch when ready') : '');
    hud.net.textContent = `K ${kills}  D ${deaths}  ping ${Math.round(ping)} ms  corr ${correction.toFixed(3)} m  ${now < messageUntil ? message : state}`;
    const clock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
    const html = topPanel(hudState, myId, zones, siege, clock);
    if (html !== scoreHtml) hud.score.innerHTML = scoreHtml = html;
    const next = `${mode_name(nextMode)} on ${MAPS[map_name(nextMap)]?.name ?? ''}`;
    const result = winner < 0 ? 'DRAW' : winner === team ? 'VICTORY' : dm ? `${nameOf(winner)} WINS` : 'DEFEAT';
    hud.banner.textContent = ended ? `${result} · next: ${next} in ${secondsLeft}s` : '';
    // Progression: keep each record the server sends; a match's end brings its XP.
    const got = net.take_progress();
    if (got) {
      const { record, end } = JSON.parse(got);
      try { localStorage.setItem(STORE, record); } catch { /* private mode: this visit only */ }
      const after = readRecord(record);
      if (end && after) summary = { end, after };
      // A level or an unlock changes what the hangar offers.
      const changed = JSON.stringify([after?.level, after?.unlocks]) !== JSON.stringify([pilot?.level, pilot?.unlocks]);
      pilot = after ?? pilot;
      if (changed) showBay(bay);
    }
    if (wasEnded && !ended) summary = null;
    wasEnded = ended;
    hud.summary.innerHTML = ended && summary ? summaryHtml(summary) : '';
  }

  if (!firstPerson && alive) debug.hitbox(pos, T('mech_radius'), T('mech_height') * (curr[S.REPAIR_T] > 0 || curr[S.STAND] > 0 ? CROUCH : 1));
  debug.update(dt);
  if (quality === 'high') composer.render(dt);
  else renderer.render(scene, camera);
  if (firstPerson) {
    renderer.autoClear = false;
    renderer.clearDepth();
    cockpit.render(renderer);
    renderer.autoClear = true;
  }
  watchPerformance(now, dt);
  requestAnimationFrame(frame);
}

/** We were hit by `attacker`: shake, flash, and a damage arc toward where they stood. */
/** Hit by player `attacker`, or by something of theirs at `from` (a camouflaged attacker's own spot stays unknown). */
function tookHit(attacker, now, from = remotes.get(attacker)?.hidden ? null : remotes.get(attacker)?.pos) {
  me.hit();
  sound.hurt();
  hurt = 1;
  shake = Math.min(shake + 0.5, 1);
  if (from) damageFrom.push({ x: from.x, z: from.z, at: now });
  if (damageFrom.length > 4) damageFrom.shift();
}

/** What a remote mech is doing that's worth a word on its tag. */
function statusOf(e, now) {
  if (e.repairing) return 'REPAIRING';
  if (now < (e.jammedUntil ?? 0)) return 'JAMMED';
  return e.ability ? e.mech.weapons.ability.name.toUpperCase() : '';
}

/** The Tab scoreboard: both teams sorted by kills, our row marked. */
/** The end-of-match XP lines: the total and level, where it came from, and the way to the next level. */
function summaryHtml({ end, after }) {
  const total = end.kills + end.assists + end.healing + (end.objectives ?? 0) + end.completion + end.win;
  const up = levelAt(after.xp - total) < after.level;
  const parts = [['KILLS', end.kills], ['ASSISTS', end.assists], ['HEALING', end.healing], ['OBJECTIVES', end.objectives ?? 0], ['MATCH', end.completion], ['WIN', end.win]]
    .filter(([, xp]) => xp > 0).map(([what, xp]) => `${what} ${xp}`);
  const [from, to] = [levelXp(after.level), levelXp(after.level + 1)];
  const toNext = after.level < 99 ? `<div>${after.xp - from} / ${to - from} XP to level ${after.level + 1}</div>` : '';
  return `<b>+${total} XP</b> · ${up ? 'LEVEL UP: ' : 'LEVEL '}${after.level}<div>${parts.join(' · ')}</div>${toNext}`;
}

/**
 * The top panel: the mode, map and clock; the score from our side (ours left in our color, theirs
 * right in theirs), as each mode keeps it; and a line under it where there's more to say: the
 * Deathmatch race, the Siege stage, who won.
 */
function topPanel(hudState, myId, zones, siege, clock) {
  const [, , , , , , team, blue, red, secondsLeft, ended, winner] = hudState;
  const mode = hudState[20], limit = hudState[23], carried = hudState[22];
  const map = MAPS[map_name(net.map())]?.name ?? '';
  const top = `<div class="top">${mode_name(mode).toUpperCase()} · ${map.toUpperCase()}<b>${ended ? `NEXT MATCH IN ${secondsLeft}s` : clock}</b></div>`;
  if (team < 0) return top;
  const [ours, theirs] = team === 0 ? [blue, red] : [red, blue];
  const color = (owner) => (owner < 0 ? 'dim' : owner === team ? 'us' : 'them');
  const bar = (hull) => `<span class="bar"><i style="width:${Math.max(0, Math.min(100, hull / 10))}%"></i></span>`;
  let main = '', state = '';
  if (mode === DEATHMATCH) {
    // Our place (ties share one), and the best of the rest: the leader, or whoever's next.
    const rows = boardRows(), mine = rows.find((r) => r.id === myId), other = standings(rows.filter((r) => r.id !== myId))[0];
    const place = 1 + rows.filter((r) => r.points > (mine?.points ?? 0)).length;
    main = `<span class="us">${ordinal(place)}</span><small>OF ${rows.length}</small><span>${mine?.points ?? 0}</span><small>POINTS</small>`;
    const name = other && esc(nameOf(other.id));
    const rival = !other ? '' : place > 1 ? `LEADER ${name} ${other.points}` : other.points === mine?.points ? `TIED WITH ${name}` : `YOU LEAD ${name} BY ${(mine?.points ?? 0) - other.points}`;
    state = `FIRST TO ${limit * DM_POINTS_PER_KILL} POINTS${rival ? ` · ${rival}` : ''}`;
  } else if (mode === MISSILE_ASSAULT) {
    // The bases either side of the silos, each silo's pip in its holder's color.
    const owners = [0, 1, 2].map((i) => (zones.length ? zones[3 * i] : -1)), contested = [0, 1, 2].filter((i) => zones[3 * i + 2]);
    const pips = owners.map((o, i) => `<span class="pip ${color(o)}${contested.includes(i) ? ' contested' : ''}">${'ABC'[i]}</span>`).join(' ');
    main = `<span class="us"><small>OUR BASE</small>${bar(ours)}${ours}</span>${pips}<span class="them">${theirs}${bar(theirs)}<small>ENEMY BASE</small></span>`;
  } else if (mode === SIEGE) {
    // Each side's base, then its bank (or its ship, while it's up), the AA gun between.
    const ships = new Map(), list = game.deployables();
    for (let i = 0; i < list.length; i += 10) if (list[i] === SHIP) ships.set(list[i + 1], list[i + 9]);
    const side = (t) => (ships.has(t) ? `SHIP ${Math.max(0, Math.ceil(ships.get(t)))}` : `${Math.floor(siege[objectives.stations.length + t] ?? 0)}/${LAUNCH_EU} EU`);
    const aa = `<span class="pip ${color(zones.length ? zones[0] : -1)}${zones[2] ? ' contested' : ''}">AA</span>`;
    main = `<span class="us"><small>OUR BASE</small>${bar(ours)}${ours} <small>${side(team)}</small></span>${aa}<span class="them"><small>${side(1 - team)}</small> ${theirs}${bar(theirs)}<small>ENEMY BASE</small></span>`;
    state = objectives.stage(team, siege, [blue, red], carried);
  } else {
    main = `<span class="us"><small>OUR TEAM</small> ${ours}</span><span class="dim">–</span><span class="them">${theirs} <small>ENEMY</small></span>`;
  }
  if (ended) {
    const won = mode === DEATHMATCH ? winner === myId : winner === team;
    state = winner < 0 ? 'DRAW' : `<span class="${won ? 'us' : 'them'}">${mode === DEATHMATCH ? (won ? 'YOU WIN' : `${esc(nameOf(winner))} WINS`) : won ? 'OUR TEAM WINS' : 'ENEMY TEAM WINS'}</span>`;
  }
  return `${top}<div class="main">${main}</div>${state ? `<div class="state">${state}</div>` : ''}`;
}

/** The scoreboard's rows from the server: id, team, class, bot, kills, deaths, points. */
function boardRows() {
  const rows = [];
  const b = net ? net.board() : [];
  for (let i = 0; i < b.length; i += 7) {
    const [id, team, cls, bot, kills, deaths, points] = b.subarray(i, i + 7);
    rows.push({ id, team, cls, bot, kills, deaths, points });
  }
  return rows;
}

/** `rows` best first: by points (kill credit), then kills, then fewest deaths. */
const standings = (rows) => rows.sort((x, y) => y.points - x.points || y.kills - x.kills || x.deaths - y.deaths);
const ordinal = (n) => `${n}${['TH', 'ST', 'ND', 'RD'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'TH'}`;

/** The Tab scoreboard: each team (in Deathmatch, everyone) by points, our row marked. */
function renderBoard(myId, hudState) {
  const rows = boardRows();
  if (!net) rows.push({ id: -1, team: 0, cls: classIdx, bot: 0, kills: 0, deaths: 0, points: 0 });
  const [blue, red, secondsLeft] = hudState ? [hudState[7], hudState[8], hudState[9]] : [0, 0, 0];
  const clock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const table = (label, cls, which) => {
    const body = standings(rows.filter(which))
      .map((r) => `<tr class="${r.id === myId ? 'me' : ''}"><td>${esc(nameOf(r.id))}${r.bot ? ' <i>BOT</i>' : levelOf(r.id) ? ` <i>LV${levelOf(r.id)}</i>` : ''}</td>`
        + `<td>${classes[CLASS_KEYS[r.cls]].name}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.points}</td></tr>`)
      .join('');
    return `<table class="team ${cls}"><tr><th>${label}</th><th>MECH</th><th>K</th><th>D</th><th>PTS</th></tr>${body}</table>`;
  };
  $('board').innerHTML = hudState?.[20] === DEATHMATCH
    ? `<div class="head">DEATHMATCH · ${clock}</div><div class="teams">${table('PILOT', '', () => true)}</div>`
    : `<div class="head">${hudState?.[20] === MISSILE_ASSAULT ? 'MISSILE ASSAULT · BASES ' : hudState?.[20] === SIEGE ? 'SIEGE · BASES ' : ''}BLUE ${blue} – ${red} RED · ${net ? clock : 'OFFLINE'}</div><div class="teams">${table('BLUE', 't0', (r) => r.team === 0)}${table('RED', 't1', (r) => r.team === 1)}</div>`;
}

/**
 * Fills and draws the glass HUD: tags for teammates always and for enemies in sight, radar
 * contacts (enemies only while seen or just after firing), the reticle at the aim point.
 */
// Health orbs (online only: nothing dies offline, and the Salve's orb is the server's). Radius and
// full health match ORB_RADIUS and ORB_HEALTH in sim/src/game.rs. The other side's Salve orbs,
// which won't heal us, glow red.
const ORB_RADIUS = 6, ORB_HEALTH = 25, ORB_COLOR = 0x6dff9a, FOE_ORB_COLOR = 0xff5a4a;
const orbGeometry = new THREE.IcosahedronGeometry(0.7, 1);
const orbMaterials = { [ORB_COLOR]: hot(new THREE.MeshBasicMaterial({ color: ORB_COLOR })), [FOE_ORB_COLOR]: hot(new THREE.MeshBasicMaterial({ color: FOE_ORB_COLOR })) };
const orbMeshes = [];
let orbs = new Float32Array(0); // xyz, health left and the team it heals (-1: anyone), per orb
/** Whether orb `k` heals team `team`. */
const orbHeals = (k, team) => orbs[5 * k + 4] < 0 || orbs[5 * k + 4] === team;
/** Bobbing cores that shrink as they give out, and repair motes on every hurt mech in reach they heal. */
function drawOrbs(now, dt, alive, myTeam) {
  orbs = net ? net.orbs() : orbs;
  const n = orbs.length / 5;
  for (let k = 0; k < Math.max(n, orbMeshes.length); k++) {
    let o = orbMeshes[k];
    if (!o && k < n) {
      o = new THREE.Mesh(orbGeometry, orbMaterials[ORB_COLOR]);
      const h = o.add(halo(ORB_COLOR, 3)).children[0];
      h.layers.set(LOW_ONLY); // bloom does this in High
      scene.add(o);
      orbMeshes.push(o);
    }
    o.visible = k < n;
    if (!o.visible) continue;
    const [x, y, z, left] = orbs.subarray(5 * k, 5 * k + 4), color = orbHeals(k, myTeam) ? ORB_COLOR : FOE_ORB_COLOR;
    o.material = orbMaterials[color];
    o.children[0].material.color.setHex(color);
    o.position.set(x, y + 0.15 * Math.sin(now / 400 + k), z);
    o.scale.setScalar((0.4 + 0.6 * Math.sqrt(left / ORB_HEALTH)) * (1 + 0.1 * Math.sin(now / 130)));
    const heals = (p, h, health, max, team) => orbHeals(k, team) && health > 0 && health < max && chest.copy(p).setY(p.y + h * 0.5).distanceTo(o.position) <= ORB_RADIUS && fx.repair(chest, dt);
    if (alive) heals(pos, T('mech_height'), curr[S.HEALTH], T('health_max'), myTeam);
    for (const e of remotes.values()) if (!e.hidden) heals(e.pos, classValue(e.cls, 'mech_height'), e.health, classValue(e.cls, 'health_max'), e.team);
  }
}

// Smoke from Palls: grey puffs filling each cloud while it lasts, a hiss as one bursts, and no
// enemy tags or radar contacts through it (as item::hidden keeps bots from seeing through it).
let clouds = new Float32Array(0); // xyz, radius and seconds left, per cloud
const cloudAt = new THREE.Vector3(), sightLine = new THREE.Line3(), nearest = new THREE.Vector3(), heard = new Set();
function drawSmoke(dt) {
  clouds = game.clouds();
  const live = new Set();
  for (let i = 0; i < clouds.length; i += 5) {
    cloudAt.set(clouds[i], clouds[i + 1], clouds[i + 2]);
    const key = `${clouds[i]},${clouds[i + 2]}`;
    if (!heard.has(key)) sound.smoke(cloudAt);
    live.add(key);
    fx.cloud(cloudAt, clouds[i + 3], clouds[i + 4], dt);
  }
  heard.clear();
  for (const key of live) heard.add(key);
}
// Deployables (sim/src/deploy.rs) in their side's color, fading over their last second: shield
// domes, translucent half-spheres; barriers, glowing walls; and turrets, tripod guns trained as the
// server has them. Each hums up as it goes down, and a turret shot down bursts.
const deployMeshes = { 0: [], 1: [], 2: [], 3: [] }; // by kind: dome, barrier, MG turret, rocket turret
const deployed = new Map(); // key: [kind, where, seconds left, hull left]
/** Where each turret's gun is, by `${owner}:${kind}`: rounds and rockets leave from it. */
const turretGuns = new Map();
/** A tripod with a head that turns (yaw) holding a gun that tilts (pitch): `head.children[0]`. */
function turretMesh(kind, material) {
  const h = classValue(1, 'turret_height'), group = new THREE.Group(), dark = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.7 });
  for (let k = 0; k < 3; k++) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, h * 1.05, 0.1), dark);
    leg.position.set(Math.sin((k * Math.PI * 2) / 3) * 0.35, h * 0.47, Math.cos((k * Math.PI * 2) / 3) * 0.35);
    leg.rotation.set(Math.cos((k * Math.PI * 2) / 3) * -0.35, 0, Math.sin((k * Math.PI * 2) / 3) * 0.35);
    group.add(leg);
  }
  const head = new THREE.Group(), gun = new THREE.Group();
  head.position.y = h;
  gun.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.7), dark));
  const barrel = kind === 2 ? new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8).rotateX(Math.PI / 2) : new THREE.BoxGeometry(0.34, 0.34, 1.0);
  gun.add(new THREE.Mesh(barrel, dark).translateZ(-0.6));
  gun.add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.72), material).translateY(0.2)); // side stripe
  head.add(gun);
  group.add(head);
  group.userData.head = head;
  return group;
}
function drawDeployables(now, myTeam) {
  const list = game.deployables(), used = { 0: 0, 1: 0, 2: 0, 3: 0 }, live = new Map();
  turretGuns.clear();
  for (let i = 0; i < list.length; i += 10) {
    const [kind, team, owner, x, y, z, yaw, pitch, left, hull] = list.subarray(i, i + 10);
    if (kind === SHIP || kind === SENTRY) continue; // objectives.js draws ships and base guns
    const key = `${owner}:${kind}:${x},${z}`;
    if (!deployed.has(key)) sound.deploy({ x, y, z });
    let mesh = deployMeshes[kind][used[kind]++];
    if (!mesh) {
      const color = new THREE.Color(), material = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      if (kind === 0) {
        const r = classValue(1, 'dome_radius');
        mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), material);
        // A coarse lattice over the shell: the quads of a low-poly half-sphere.
        mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(r, 16, 5, 0, Math.PI * 2, 0, Math.PI / 2)), new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false })));
      } else if (kind === 1) {
        const geo = new THREE.BoxGeometry(classValue(1, 'barrier_width'), classValue(1, 'barrier_height'), classValue(1, 'barrier_thickness'));
        mesh = new THREE.Mesh(geo, material);
        mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false })));
      } else {
        mesh = turretMesh(kind, new THREE.MeshBasicMaterial({ color }));
      }
      scene.add(mesh);
      deployMeshes[kind].push(mesh);
    }
    const accent = (team === myTeam || myTeam < 0 ? FRIEND : FOE).accent, fade = Math.min(left, 1);
    mesh.visible = true;
    mesh.position.set(x, y + (kind === 1 ? classValue(1, 'barrier_height') / 2 : 0), z);
    if (kind >= 2) {
      const head = mesh.userData.head, gun = head.children[0];
      head.rotation.y = yaw;
      gun.rotation.x = pitch;
      gun.children[2].material.color.setHex(accent);
      const at = head.getWorldPosition(new THREE.Vector3());
      turretGuns.set(`${owner}:${kind}`, at.add(heading.set(0, Math.sin(pitch), -Math.cos(pitch)).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw).multiplyScalar(1.1)));
    } else {
      mesh.rotation.y = yaw;
      mesh.material.color.setHex(accent);
      mesh.material.opacity = (kind === 0 ? 0.16 : 0.3) * fade * (0.9 + 0.1 * Math.sin(now / 90));
      mesh.children[0].material.color.setHex(accent);
      mesh.children[0].material.opacity = 0.6 * fade;
    }
    live.set(key, [kind, mesh.position.clone().setY(y + 1), left, hull]);
  }
  // A damaged turret gone before its time was shot down.
  for (const [key, [kind, at, left, hull]] of deployed) {
    if (kind >= 2 && left > 0.5 && hull < classValue(1, 'turret_hull') && !live.has(key)) {
      fx.explosion(at, 0.6);
      sound.blast(3, at);
    }
  }
  for (const kind of [0, 1, 2, 3]) for (let k = used[kind]; k < deployMeshes[kind].length; k++) deployMeshes[kind][k].visible = false;
  deployed.clear();
  for (const [key, value] of live) deployed.set(key, value);
}

/** Whether smoke lies across the sight line from `a` to `b`. */
const smoked = (a, b) => {
  sightLine.set(a, b);
  for (let i = 0; i < clouds.length; i += 5) {
    cloudAt.set(clouds[i], clouds[i + 1], clouds[i + 2]);
    if (sightLine.closestPointToPoint(cloudAt, true, nearest).distanceTo(cloudAt) < clouds[i + 3]) return true;
  }
  return false;
};

/** Guns that take at least this long (s) between shots, or bursts, show their refire on the glass. */
const SLOW_REFIRE = 0.25;
/** The wait after a shot, or after a burst's last shot (its gaps come out of the cycle). */
const refireTime = () => {
  const burst = Math.max(T('burst'), 1), gap = T('burst_gap');
  return burst > 1 ? Math.max(gap, 1 / T('fire_rate') - gap * (burst - 1)) : 1 / T('fire_rate');
};

function drawGlass(now, myTeam) {
  const W = glass.canvas.width, H = glass.canvas.height;
  const toScreen = (p) => ({ x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H });
  const tags = [], contacts = [];
  for (let k = 0; k < orbs.length / 5; k++) if (orbHeals(k, myTeam)) contacts.push({ x: orbs[5 * k], z: orbs[5 * k + 2], orb: true });
  let focus = null, focusAngle = THREE.MathUtils.degToRad(4);
  camera.getWorldDirection(look);
  for (const [id, e] of remotes) {
    if (!e.mech.alive) continue;
    const enemy = e.team !== myTeam, h = classValue(e.cls, 'mech_height');
    chest.copy(e.pos).y += h * 0.5;
    const dist = chest.distanceTo(eye);
    let visible = !enemy;
    if (e.hidden) continue;
    if (enemy && dist <= T('weapon_range')) {
      to.subVectors(chest, eye).normalize();
      visible = game.cast_ray(eye.x, eye.y, eye.z, to.x, to.y, to.z, dist) >= dist - 0.5 && !smoked(eye, chest);
    }
    if (!enemy || visible || now - (lastFired.get(id) ?? -Infinity) < 2000) contacts.push({ x: e.pos.x, z: e.pos.z, enemy });
    if (!visible || (!enemy && dist > 150)) continue;
    ndc.copy(e.pos).y += enemy ? h * 0.5 : h + 0.8;
    ndc.project(camera);
    if (ndc.z > 1 || Math.abs(ndc.x) > 1.1 || Math.abs(ndc.y) > 1.1) continue;
    const healthMax = classValue(e.cls, 'health_max');
    const tag = {
      ...toScreen(ndc), dist, enemy, unit: id, name: levelOf(id) ? `${nameOf(id)} ·LV${levelOf(id)}` : nameOf(id), bot: e.bot, status: statusOf(e, now), focus: false,
      health: e.health / healthMax, hp: Math.ceil(e.health), hpMax: healthMax, label: classes[CLASS_KEYS[e.cls]].name,
    };
    const angle = enemy ? look.angleTo(to.subVectors(chest, camera.position)) : Infinity;
    if (angle < focusAngle) [focusAngle, focus] = [angle, tag];
    tags.push(tag);
  }
  // Turrets: the other side's in sight get tags (hull, and the card under the crosshair) and radar
  // marks, as enemy mechs do; our side's are marked on the radar.
  const turrets = game.deployables();
  for (let i = 0; i < turrets.length; i += 10) {
    const [kind, team, owner, x, y, z, , , , hull] = turrets.subarray(i, i + 10);
    if (kind < 2 || kind === SENTRY) continue;
    const enemy = myTeam >= 0 && team !== myTeam; // offline, all ours
    const ship = kind === SHIP;
    chest.set(x, y + (ship ? 0 : classValue(1, 'turret_height') * 0.6), z);
    const dist = chest.distanceTo(eye);
    let visible = false;
    if (enemy && dist <= T('weapon_range')) {
      to.subVectors(chest, eye).normalize();
      visible = game.cast_ray(eye.x, eye.y, eye.z, to.x, to.y, to.z, dist) >= dist - 0.5 && !smoked(eye, chest);
    }
    if (!enemy || visible) contacts.push({ x, z, enemy, turret: true });
    if (!visible) continue;
    ndc.copy(chest).project(camera);
    if (ndc.z > 1 || Math.abs(ndc.x) > 1.1 || Math.abs(ndc.y) > 1.1) continue;
    const hullMax = ship ? SHIP_HULL : classValue(1, 'turret_hull'), label = ship ? 'Battleship' : kind === 2 ? 'MG turret' : 'Rocket turret';
    const tag = {
      // `unit` is its lock-on id (deploy::target_id), so the lock diamond finds it.
      ...toScreen(ndc), dist, enemy, unit: 64 + 2 * owner + (kind === 3 ? 1 : 0), name: ship ? `Enemy ${label.toLowerCase()}` : `${nameOf(owner)}'s ${label}`, bot: false, status: '', focus: false,
      health: Math.max(hull, 0) / hullMax, hp: Math.max(Math.ceil(hull), 0), hpMax: hullMax, label,
    };
    const angle = look.angleTo(to.subVectors(chest, camera.position));
    if (angle < focusAngle) [focusAngle, focus] = [angle, tag];
    tags.push(tag);
  }
  if (focus) focus.focus = true;
  while (hits.length && now - hits[0].at > 1000) hits.shift();
  // Objectives: each silo's letter over it on the glass, and on the radar, in its holder's color.
  const marks = [];
  for (const o of objectives.markers(net ? net.zones() : [], net ? net.siege() : [])) {
    const color = hex(o.color ?? (o.owner < 0 ? 0xd8dde6 : o.owner === myTeam ? FRIEND.accent : FOE.accent));
    contacts.push({ x: o.at.x, z: o.at.z, objective: o.label, color });
    ndc.copy(o.at).y += 12;
    ndc.project(camera);
    if (ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
    marks.push({ ...toScreen(ndc), label: o.label, color, contested: o.contested, dist: o.at.distanceTo(eye) });
  }

  aim.set(curr[S.AIM], curr[S.AIM + 1], curr[S.AIM + 2]).project(camera);
  const c = classes[CLASS_KEYS[classIdx]];
  glass.resize(renderer.getPixelRatio());
  // One frame for both the glass and the cockpit's dash screens.
  const f = {
    now, yaw, me: { x: pos.x, z: pos.z }, altitude: pos.y, speed: Math.hypot(curr[S.VEL], curr[S.VEL + 2]), firstPerson,
    aim: aim.z < 1 ? toScreen(aim) : null,
    heat: curr[S.HEAT] / T('heat_max'), overheated: !!curr[S.OVERHEATED],
    alt: 1 - curr[S.ALT_WAIT] / Math.max(T('alt_cooldown'), 1e-6), altReady: curr[S.ALT_WAIT] <= 0,
    altBurst: burstable,
    shielded: !!curr[S.SHIELD],
    incoming, eliminated, callout, capture, objectives: marks,
    lock: curr[S.LOCK] > 0 ? {
      unit: curr[S.LOCK] - 1, progress: Math.min(curr[S.LOCK_T] / Math.max(T('alt_lock_time'), 1e-6), 1),
      left: T('alt_lock_time') + T('alt_lock_hold') - curr[S.LOCK_T], // s the lock holds once made
    } : null,
    windup: T('charge_time') > 0 ? curr[S.CHARGE] : T('spin_up') > 0 ? curr[S.SPIN] : 0,
    // The cone the next shot lands in (base spread plus bloom) as a fraction of the half-height,
    // and a slow primary's refire, 0 to 1 (null for fast guns and spinning ones).
    spread: Math.tan(THREE.MathUtils.degToRad(T('spread_deg') + curr[S.BLOOM])) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
    cycle: T('spin_up') > 0 || refireTime() < SLOW_REFIRE ? null : 1 - Math.max(curr[S.FIRE_WAIT], 0) / refireTime(),
    ability: 1 - curr[S.ABILITY_CD] / Math.max(T(`${armament(loadout).ability.id}_cooldown`), 1e-6), abilityActive: curr[S.ABILITY_T] > 0,
    // For the ability's dial: its icon, the seconds until it's back, and how much of its spell is left.
    abilityId: armament(loadout).ability.id, abilityLeft: curr[S.ABILITY_CD],
    abilityOn: curr[S.ABILITY_T] > 0 ? curr[S.ABILITY_T] / Math.max(T(`${armament(loadout).ability.id}_duration`), 1e-6) : 0,
    health: curr[S.HEALTH], healthMax: T('health_max'), fuel: curr[S.FUEL] / T('fuel_max'), className: c.name, hurt,
    boostMin: T('boost_min_fuel') / T('fuel_max'), boosting: !!curr[S.BOOSTING], hovering: !!curr[S.HOVERING],
    friendColor: hex(FRIEND.accent), enemyColor: hex(FOE.accent),
    repair: repairPhase(curr[S.REPAIR_T]), standing: curr[S.STAND] > 0,
    // A Limpet down turns G into its detonator.
    items: [['G', 'offensive', S.GRENADES, S.GRENADE_WAIT], ['T', 'support', S.EMPS, S.EMP_WAIT]].map(([key, slot, charges, wait]) => {
      const it = armament(loadout)[slot];
      const armed = slot === 'offensive' && !!curr[S.LIMPET];
      return { key, id: it.id, armed, charges: curr[charges], max: T(`${it.id}_charges`), recharge: 1 - curr[wait] / Math.max(T(`${it.id}_recharge`), 1e-6), wait: curr[wait] };
    }),
    jammed: curr[S.JAMMED] > 0,
    feed: feed.filter((k) => now - k.at < 6000),
    contacts, tags, hits, damage: damageFrom, radarMap: glass.radarMap,
  };
  glass.draw(f);
  if (firstPerson) cockpit.instruments(f);
}

// Stats overlay (I) and the one-time fallback from High to Low.
let fps = 60, slowFor = 0, statsAt = 0;
function watchPerformance(now, dt) {
  if (dt <= 0 || dt >= 0.25) return; // paused or backgrounded: not a real frame time
  fps += (1 / dt - fps) * 0.05;
  if (quality === 'high') {
    slowFor = fps < 45 ? slowFor + dt : 0;
    if (slowFor > 5) {
      quality = 'low';
      slowFor = 0;
      applyQuality();
      console.info('quality: dropped to low (under 45 fps)');
    }
  }
  if (!$('stats').hidden && now - statsAt > 500) {
    statsAt = now;
    const { calls, triangles } = renderer.info.render;
    $('stats').textContent = `${quality}  ${Math.round(fps)} fps  ${calls} draw calls  ${Math.round(triangles / 1000)}k tris`;
  }
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
