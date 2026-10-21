import * as THREE from 'three';
import GUI from 'lil-gui';
import init, { WasmNetClient, WasmSim, map_name, tick_dt } from '../sim/pkg/sim.js';
import tuning from '../tuning.json';
import classes from '../classes.json';
import { buildArena } from './arena.js';
import { Effects } from './fx.js';
import saltworks from '../maps/saltworks.json';
import foundry from '../maps/foundry.json';
import blockout from '../maps/blockout.json';
import { Mech, TEAMS } from './mech.js';
import { Cockpit } from './cockpit.js';
import { Sound } from './audio.js';
import { Hud, hex } from './hud.js';
import { createSky } from './sky.js';

await init();
const DT = tick_dt();
// Mech classes A, B, C by index. tuning.json is B; classes.json overrides values per class.
const CLASS_KEYS = ['A', 'B', 'C'];
let classIdx = 1; // offline: the picked class; online: what the server says we are
const classValue = (cls, name) => classes[CLASS_KEYS[cls]].overrides[name] ?? tuning[name].value;
const T = (name) => classValue(classIdx, name);

// Dev (Vite): ?server=ws://host:port/ws plays online, otherwise the offline sandbox. A production
// build plays online against the server that served it, unless ?offline.
const params = new URLSearchParams(location.search);
const sameOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const server = params.get('server') ?? (import.meta.env.PROD && !params.has('offline') ? sameOrigin : null);
const net = server ? new WasmNetClient() : null;
// Maps by name; the sim's compiled-in list gives the index. Offline, ?map=<name> picks one.
const MAPS = { saltworks, blockout, foundry };
const mapIndex = (name) => {
  for (let i = 0; map_name(i); i++) if (map_name(i) === name) return i;
  return 0;
};
const sim = net ? null : new WasmSim(JSON.stringify(tuning), mapIndex(params.get('map') ?? 'foundry'));
const game = net ?? sim;
let ws = null, connection = server ? 'connecting' : '', picked = null;
if (net) {
  ws = new WebSocket(server);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    connection = '';
    if (picked !== null) ws.send(net.pick_class(picked));
    if (callsign()) ws.send(net.set_name(callsign()));
  };
  ws.onmessage = (e) => net.receive(new Uint8Array(e.data), performance.now());
  ws.onclose = () => { connection = 'disconnected'; };
}

// Index layout of state(); keep in sync with mech_state in sim/src/wasm.rs.
const S = { POS: 0, VEL: 3, FUEL: 6, HEAT: 7, OVERHEATED: 8, GROUNDED: 9, BOOSTING: 10, HOVERING: 11, DODGE_CD: 12, SHOT: 13, AIM: 14, HEALTH: 17, ABILITY_T: 18, ABILITY_CD: 19, ALT_WAIT: 20, LAUNCHED: 21, REPAIR_T: 22, REPAIR_CD: 23, GRENADES: 24, GRENADE_WAIT: 25, EMPS: 26, EMP_WAIT: 27, JAMMED: 28, THREW: 29, PULSED: 30, OFFSET: 31 };
// Volley index of thrown grenades; matches projectile::GRENADE in sim/src/projectile.rs.
const GRENADE_N = 255;

// --- Scene ---------------------------------------------------------------
// ?quality=low|high (default high). High drops to Low once if it can't hold 45 fps.
let quality = params.get('quality') === 'low' ? 'low' : 'high';
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

// The sun's shadow map follows the player, covering the fight around them.
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
const sky = createSky(scene, SUN_DIR); // dome, horizon fog and distant skyline, lit from the same sun
const SHADOW_HALF = 40;
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 1, far: 220 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const sunRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
const sunUp = new THREE.Vector3().crossVectors(SUN_DIR, sunRight);
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


const fx = new Effects(scene);
// Sound starts on the first click or key press, as browsers require.
const sound = new Sound();
Mech.audio = sound;
addEventListener('pointerdown', () => sound.unlock());
addEventListener('keydown', () => sound.unlock());
let me = new Mech(scene, fx, 'B'), meClass = 1;
me.own = true;
const cockpit = new Cockpit();
cockpit.setWeapons('B', me, T('eye_height'), T('mech_height') / me.height);

// The arena is built once its map is known: right away offline, after the Welcome online.
let arenaMap = -1, arena = { vents: [], furnaces: [] };
const ensureArena = (index) => {
  if (index < 0 || index === arenaMap) return;
  arenaMap = index;
  const map = MAPS[map_name(index)], light = map.night ? LIGHTS.night : LIGHTS.day;
  arena = buildArena(scene, map);
  sky.fit(map);
  glass.setMap(map);
  hemi.color.setHex(light.sky);
  hemi.groundColor.setHex(light.ground);
  hemi.intensity = light.ambient;
  sun.color.setHex(light.sun);
  sun.intensity = light.direct;
  cockpit.light(hemi, sun);
  fx.setNight(!!map.night);
};
ensureArena(sim ? mapIndex(params.get('map') ?? 'foundry') : -1);

function applyQuality() {
  const high = quality === 'high';
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1));
  renderer.shadowMap.enabled = sun.castShadow = high;
  fx.setQuality(high);
  Mech.halos = high;
  document.getElementById('glass').classList.toggle('glow', high);
  // Shadow support is compiled into materials, so they need rebuilding.
  scene.traverse((o) => {
    if (o.material) o.material.needsUpdate = true;
  });
  resize();
}
applyQuality();
// Other players by id: their mech, team, class, and a velocity estimated from interpolated motion.
const remotes = new Map();
const shots = []; // own predicted shots, drawn once this frame's pose is set
// Projectiles seen so far by id, with the launcher position each is drawn leaving from.
const launches = new Map(), blastAt = new THREE.Vector3();
const LAUNCH_BLEND = 0.15; // s
let hurt = 0, shake = 0, boostKick = 0, message = '', messageUntil = 0;
const BOOST_FOV = 6; // degrees
// HUD feedback: own hits and kills, where hits on us came from, and when each player last fired.
const hits = [], damageFrom = [], lastFired = new Map();

// --- Input ---------------------------------------------------------------
const keys = new Set();
let yaw = 0, pitch = 0, dodge = 0, ability = false, grenade = false, emp = false, firing = false, altFiring = false;
// First-person cockpit unless the player last chose the chase camera (V).
const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
let firstPerson = stored('webhawk.view') !== 'chase';
const locked = () => document.pointerLockElement === renderer.domElement;
// Chrome rejects a re-lock right after Esc; the next click simply tries again.
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock()?.catch?.(() => {}));
document.addEventListener('pointerlockchange', () => {
  document.body.classList.toggle('locked', locked());
  if (!locked()) firing = altFiring = false;
});
addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const limit = THREE.MathUtils.degToRad(T('pitch_limit_deg'));
  yaw -= e.movementX * T('mouse_sensitivity');
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * T('mouse_sensitivity'), -limit, limit);
});
addEventListener('mousedown', (e) => {
  if (!locked()) return;
  if (e.button === 0) firing = true;
  if (e.button === 2) altFiring = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) altFiring = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
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
  if (e.code === 'KeyV') {
    firstPerson = !firstPerson;
    try { localStorage.setItem('webhawk.view', firstPerson ? 'cockpit' : 'chase'); } catch { /* private mode */ }
  }
  if (e.code === 'KeyI') $('stats').hidden = !$('stats').hidden;
  if (e.code === 'KeyM') setMuted(!sound.muted);
  if (e.code === 'Tab') { e.preventDefault(); boardOpen = true; }
  if (e.code === 'KeyC' && picked !== null) pickerOpen = !pickerOpen;
  const digit = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (digit >= 0 && !$('picker').hidden) pick(digit);
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') boardOpen = false;
});
addEventListener('blur', () => { keys.clear(); firing = altFiring = false; });
const axis = (pos, neg) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
const shift = () => keys.has('ShiftLeft') || keys.has('ShiftRight');
// Quick 180°: the view sweeps half a turn over TURN_TIME, eased, on top of the mouse.
const TURN_TIME = 0.22; // s
let turnT = -1;
const turnAbout = () => { if (turnT < 0) turnT = 0; };
const ease = (x) => x * x * (3 - 2 * x);

// --- Tuning panel ----------------------------------------------------------
const gui = new GUI({ title: 'Tuning (tuning.json)' });
const folders = {};
const push = () => sim?.set_tuning(JSON.stringify(tuning));
for (const [name, p] of Object.entries(tuning)) {
  // Online the sim runs on compiled-in tuning.json on both ends, so only camera values are live.
  // Bot values only matter to the server.
  if ((net && p.group !== 'camera') || p.group === 'bot') continue;
  folders[p.group] ??= gui.addFolder(p.group).close();
  folders[p.group].add(p, 'value', p.min, p.max, p.step).name(`${name} (${p.unit})`).onChange(push);
}
(folders.move ?? folders.camera).open();
if (net) gui.close(); // online only camera values are live; keep the corner for the kill feed
gui.add({ copy: () => navigator.clipboard.writeText(JSON.stringify(tuning, null, 2) + '\n') }, 'copy').name('Copy tuning.json');

// --- HUD -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const hud = { net: $('net'), score: $('score'), banner: $('banner'), damage: $('damage') };

// --- Class picker ----------------------------------------------------------
// Shown before the first deploy and on death; C reopens it. Online the pick applies on the next
// spawn (or right away before the first input), so inputs are held until a class is chosen.
let pickerOpen = true, boardOpen = false, boardAt = 0;

// --- Callsign ----------------------------------------------------------------
// Typed on the picker, remembered locally, and sent (after a pause in typing) for the server to
// sanitize and share. Others' names come from the server's roster.
// Volume (picker slider) and mute (M), remembered between visits.
const volumeInput = $('volume');
volumeInput.value = stored('webhawk.volume') ?? '0.8';
sound.setVolume(Number(volumeInput.value));
volumeInput.addEventListener('input', () => {
  sound.setVolume(Number(volumeInput.value));
  try { localStorage.setItem('webhawk.volume', volumeInput.value); } catch { /* private mode */ }
});
function setMuted(muted) {
  sound.setMuted(muted);
  $('muted').hidden = !muted;
  try { localStorage.setItem('webhawk.muted', muted ? '1' : ''); } catch { /* private mode */ }
}
setMuted(stored('webhawk.muted') === '1');
const callsignInput = $('callsign');
callsignInput.value = stored('webhawk.name') ?? '';
const callsign = () => callsignInput.value.trim();
let renameTimer = 0;
callsignInput.addEventListener('input', () => {
  clearTimeout(renameTimer);
  renameTimer = setTimeout(() => {
    try { localStorage.setItem('webhawk.name', callsign()); } catch { /* private mode */ }
    if (ws?.readyState === WebSocket.OPEN) ws.send(net.set_name(callsign()));
  }, 600);
});
/** Display name of player `id` (offline, only we exist). */
const nameOf = (id) => (net ? net.name(id) || `Pilot-${String(id).padStart(2, '0')}` : callsign() || 'You');
const esc = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Recent kills for the feed: names and team colors when they happened.
const feed = [];
CLASS_KEYS.forEach((key, i) => {
  const c = classes[key], v = (name) => classValue(i, name);
  const card = document.createElement('button');
  card.className = 'card';
  card.innerHTML = `<span class="key">${i + 1}</span><b>${c.name}</b>${c.role}<dl>
    <dt>HP</dt><dd>${v('health_max')}</dd><dt>Speed</dt><dd>${v('walk_speed')} m/s</dd>
    <dt>DPS</dt><dd>${Math.round(v('fire_rate') * v('shot_damage') * v('pellets'))}</dd></dl>
    <p><b>LMB · ${c.primary.name}</b>${c.primary.desc}</p>
    <p><b>RMB · ${c.secondary.name}</b>${c.secondary.desc}</p>
    <p><b>F · ${c.ability.name}</b>${c.ability.desc}</p>`;
  card.addEventListener('click', () => pick(i));
  $('cards').append(card);
});
function pick(i) {
  pickerOpen = false;
  picked = i;
  if (net) {
    if (ws.readyState === WebSocket.OPEN) ws.send(net.pick_class(i));
  } else {
    classIdx = i;
    sim.set_class(i);
    sim.reset();
    prev = curr = sim.state();
  }
}

/** Seconds into a repair as Mech.update's `repair`: 0 none, wind-up fraction, then 1 healing. */
const repairPhase = (t, cls = classIdx) => (t > 0 ? Math.min(t / Math.max(classValue(cls, 'repair_windup'), 1e-6), 1) : 0);

// --- Fixed-step sim, interpolated render ----------------------------------
let prev = game.state(), curr = prev, acc = 0, last = performance.now();
const eye = new THREE.Vector3(), offset = new THREE.Vector3(), aim = new THREE.Vector3();
const pos = new THREE.Vector3(), vel = new THREE.Vector3(), seen = new THREE.Vector3(), step = new THREE.Vector3();
const ray = new THREE.Ray(), sphere = new THREE.Sphere(), crossing = new THREE.Vector3();
const heading = new THREE.Vector3(), chest = new THREE.Vector3(), to = new THREE.Vector3(), look = new THREE.Vector3(), ndc = new THREE.Vector3(), muzzle = new THREE.Vector3();
const spark = new THREE.Vector3();
/** Moves feet position `p` up to the chest of a class `cls` mech. */
const toChest = (p, cls) => { p.y += classValue(cls, 'mech_height') * 0.5; return p; };

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
  while (acc >= DT) {
    if (net && picked === null) {
      prev = curr = net.state();
      acc -= DT;
      continue;
    }
    // Shift+W boosts (the sim only boosts forward); with Shift held, S is the turn, not a step back.
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') && !shift() ? 1 : 0);
    const input = [axis('KeyD', 'KeyA'), forward, yaw, pitch,
      shift(), keys.has('Space'), dodge, firing, altFiring, ability, keys.has('KeyR'), grenade, emp];
    if (net) {
      const bytes = net.tick(...input, now);
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    } else {
      sim.step(...input);
    }
    prev = curr;
    curr = game.state();
    if (dodge && curr[S.DODGE_CD] > prev[S.DODGE_CD]) me.dodge(dodge);
    if (ability && curr[S.ABILITY_CD] > prev[S.ABILITY_CD]) me.ability();
    dodge = 0;
    ability = grenade = emp = false;
    acc -= DT;
    // Hitscan pellets, where each stopped against the arena.
    const ends = game.take_shots();
    for (let k = 0; k < ends.length; k += 3) shots.push(new THREE.Vector3(ends[k], ends[k + 1], ends[k + 2]));
    // Own EMPs show as predicted; the server's Pulse for them only marks hits.
    if (curr[S.PULSED]) sound.emp(null);
    if (curr[S.PULSED]) fx.pulse(toChest(new THREE.Vector3(curr[S.POS], curr[S.POS + 1], curr[S.POS + 2]), classIdx), T('emp_radius'));
  }
  const a = acc / DT;
  const lerp = (i) => prev[i] + (curr[i] - prev[i]) * a;
  if (net) ensureArena(net.map());
  const hudState = net ? net.hud() : null;
  const [myId, myTeam] = hudState ? [hudState[0], hudState[6]] : [-1, -1];
  if (hudState) classIdx = hudState[12];
  if (meClass !== classIdx) {
    me.dispose();
    me = new Mech(scene, fx, CLASS_KEYS[classIdx]);
    me.own = true;
    meClass = classIdx;
    cockpit.setWeapons(CLASS_KEYS[classIdx], me, T('eye_height'), T('mech_height') / me.height);
  }
  // Dying online opens the picker once; the pick applies on respawn.
  const alive = curr[S.HEALTH] > 0;
  if (net && picked !== null && !alive && prev[S.HEALTH] > 0) pickerOpen = true;

  // The render offset slides server corrections (bumps) in instead of snapping.
  pos.set(lerp(S.POS) + lerp(S.OFFSET), lerp(S.POS + 1) + lerp(S.OFFSET + 1), lerp(S.POS + 2) + lerp(S.OFFSET + 2));
  me.setTeam(myTeam);
  me.setUnit(myId);
  me.root.visible = !firstPerson;
  me.update(dt, {
    pos, yaw, pitch, scale: T('mech_height') / me.height,
    vel: vel.set(lerp(S.VEL), lerp(S.VEL + 1), lerp(S.VEL + 2)),
    grounded: !!curr[S.GROUNDED], boosting: !!curr[S.BOOSTING], hovering: !!curr[S.HOVERING],
    health: curr[S.HEALTH], heat: curr[S.HEAT] / T('heat_max'), overheated: !!curr[S.OVERHEATED],
    ability: curr[S.ABILITY_T] > 0, damage: 1 - curr[S.HEALTH] / T('health_max'),
    repair: repairPhase(curr[S.REPAIR_T]),
  });
  if (curr[S.JAMMED] > 0) fx.jam(toChest(spark.copy(pos), classIdx), dt);

  if (net) {
    const r = net.remotes(now), live = new Set();
    for (let i = 0; i < r.length; i += 14) {
      const [id, team, cls, x, y, z, ryaw, rpitch, health, boosting, hovering, bot, abilityOn, repairing] = r.subarray(i, i + 14);
      let e = remotes.get(id);
      if (e && e.cls !== cls) {
        e.mech.dispose();
        e = null;
      }
      if (!e) remotes.set(id, (e = { mech: new Mech(scene, fx, CLASS_KEYS[cls]), cls, team, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3() }));
      live.add(id);
      // Gait speed comes from interpolated motion; a jump (respawn, slot reuse) resets it.
      seen.set(x, y, z);
      if (dt === 0 || seen.distanceTo(e.pos) > 8) e.vel.set(0, 0, 0);
      else e.vel.lerp(step.subVectors(seen, e.pos).divideScalar(dt), 0.3);
      e.pos.copy(seen);
      e.team = team;
      e.health = health;
      // Remotes only say whether they're repairing; time the wind-up from when it started.
      e.repairAt = repairing ? e.repairAt ?? now : null;
      Object.assign(e, { bot: !!bot, ability: !!abilityOn, repairing: !!repairing, boosting: !!boosting, hovering: !!hovering });
      e.mech.setTeam(team);
      e.mech.setUnit(id);
      e.mech.update(dt, {
        pos: e.pos, yaw: ryaw, pitch: rpitch, scale: classValue(cls, 'mech_height') / e.mech.height, vel: e.vel,
        grounded: !hovering && Math.abs(e.vel.y) < 1.5, boosting: !!boosting, hovering: !!hovering, health,
        ability: !!abilityOn, damage: 1 - health / classValue(cls, 'health_max'),
        repair: repairPhase(e.repairAt === null ? 0 : (now - e.repairAt) / 1000 + 1e-3, cls),
      });
      if (now < (e.jammedUntil ?? 0)) fx.jam(toChest(spark.copy(e.pos), cls), dt);
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
      const color = (id) => hex((TEAMS[teamOf(id)] ?? TEAMS[-1]).accent);
      feed.push({ at: now, killer: nameOf(a), victim: nameOf(b), killerColor: color(a), victimColor: color(b), mine: a === myId || b === myId });
      if (feed.length > 5) feed.shift();
    }
    if (kind === 1 && (a === myId || b === myId)) { message = a === myId ? 'ENEMY DESTROYED' : 'DESTROYED'; messageUntil = now + 2500; }
    if (kind === 2) {
      blastAt.set(x, y, z);
      fx.explosion(blastAt, b / 5);
      sound.blast(b, blastAt);
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
  }

  // Projectiles: own ones extrapolated like the own mech, others already at render time. Each is
  // drawn leaving its launcher (primary fire: a gun) and eases onto its sim path (which starts at
  // the eye). A primary shot's pellets all leave the barrel its first pellet picked.
  const pr = game.projectiles(now), drawn = [], live = new Set();
  let gunAt = null;
  for (let i = 0; i < pr.length; i += 13) {
    const [owner, seq, n, cls, x, y, z, vx, vy, vz, age, predicted, primary] = pr.subarray(i, i + 13);
    const key = `${owner}:${seq}:${n}:${primary}`, ahead = predicted ? a * DT : 0;
    const mech = predicted ? me : remotes.get(owner)?.mech;
    let shot = launches.get(key);
    if (!shot) {
      let from = null;
      if (primary) {
        if (n === 0) gunAt = mech?.muzzle(heading.set(vx, vy, vz).normalize(), predicted && firstPerson ? cockpit.fire(camera, new THREE.Vector3()) : null) ?? null;
        from = gunAt;
      } else {
        from = mech?.launcher.getWorldPosition(new THREE.Vector3());
        if (n === 0) mech?.launch();
        if (n === GRENADE_N) sound.grenade(predicted ? null : { x, y, z });
      }
      launches.set(key, (shot = { from: from ?? new THREE.Vector3(x, y, z) }));
      if (!predicted) lastFired.set(owner, now);
    }
    live.add(key);
    const p = new THREE.Vector3(x + vx * ahead, y + vy * ahead, z + vz * ahead);
    const blend = Math.min((age + ahead) / LAUNCH_BLEND, 1);
    if (blend < 1) p.lerp(shot.from, 1 - blend);
    drawn.push({ pos: p, vel: new THREE.Vector3(vx, vy, vz), cls: CLASS_KEYS[cls], age: age + ahead, primary: !!primary, grenade: n === GRENADE_N });
  }
  for (const key of launches.keys()) if (!live.has(key)) launches.delete(key);
  fx.projectiles(drawn, dt);

  // Look is applied at render rate for responsiveness; position is interpolated. In the cockpit
  // the view bobs with the gait and shakes when hit, but stays level (no roll).
  eye.copy(pos).y += T('eye_height');
  camera.position.copy(eye);
  if (firstPerson) {
    camera.rotation.set(pitch, yaw, 0);
    camera.position.y += (me.body.position.y - me.spec.hipY) * 0.6;
    if (shake > 0.01) camera.translateX((Math.random() - 0.5) * 0.14 * shake).translateY((Math.random() - 0.5) * 0.14 * shake);
  } else {
    camera.rotation.set(pitch, yaw, 0);
    // Pull the chase camera in front of any wall behind the mech.
    offset.set(0, T('chase_height'), T('chase_distance')).applyQuaternion(camera.quaternion);
    const want = offset.length();
    const room = game.cast_ray(eye.x, eye.y, eye.z, offset.x, offset.y, offset.z, want + 0.5) - 0.5;
    camera.position.addScaledVector(offset, Math.max(room, 0.5) / want);
  }
  shake *= Math.exp(-6 * dt);
  // A small FOV kick while boosting sells the speed.
  boostKick += ((curr[S.BOOSTING] ? 1 : 0) - boostKick) * (1 - Math.exp(-6 * dt));
  const fov = T('fov') + BOOST_FOV * boostKick;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
  cockpit.setTeam(myTeam);
  cockpit.update(dt, camera, SUN_DIR, T('fov'));

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
    me.fire(ray.at(reach, end), firstPerson ? cockpit.fire(camera, muzzle) : null);
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
    hull: curr[S.HEALTH] / T('health_max'), repairing: repairPhase(curr[S.REPAIR_T]), jammed: curr[S.JAMMED] > 0,
  }, dt);
  // Stacks smoke and spark, furnaces spit sparks, and an industrial map's air carries cinders.
  for (const p of arena.vents) {
    fx.plume(p, dt);
    fx.sparks(p, dt, 10);
  }
  for (const p of arena.furnaces) fx.sparks(p, dt, 5);
  if (arena.vents.length) fx.cinders(camera.position, dt);
  fx.update(dt, camera, renderer.domElement.height);
  hurt = Math.max(0, hurt - dt * 2.5);
  hud.damage.style.opacity = hurt;

  $('picker').hidden = !pickerOpen;
  $('picker-note').textContent = picked === null ? '' : alive ? 'Applies on your next respawn · C to close' : 'Applies on respawn';
  drawGlass(now, myTeam);
  $('board').hidden = !boardOpen;
  if (boardOpen && now - boardAt > 250) {
    boardAt = now;
    renderBoard(myId, hudState);
  }
  if (net) {
    const [, kills, deaths, ping, correction, full, team, blue, red, secondsLeft, ended, winner] = hudState;
    const state = full ? 'server full' : connection || (curr[S.HEALTH] <= 0 ? 'DESTROYED, respawning' : '');
    hud.net.textContent = `K ${kills}  D ${deaths}  ping ${Math.round(ping)} ms  corr ${correction.toFixed(3)} m  ${now < messageUntil ? message : state}`;
    const clock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
    hud.score.textContent = `${team === 0 ? '▸ ' : ''}BLUE ${blue} – ${red} RED${team === 1 ? ' ◂' : ''}   ${ended ? '' : clock}`;
    hud.banner.textContent = ended ? `${winner < 0 ? 'DRAW' : winner === team ? 'VICTORY' : 'DEFEAT'} · next match in ${secondsLeft}s` : '';
  }

  renderer.render(scene, camera);
  if (firstPerson) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(cockpit.scene, cockpit.camera);
    renderer.autoClear = true;
  }
  watchPerformance(now, dt);
  requestAnimationFrame(frame);
}

/** We were hit by `attacker`: shake, flash, and a damage arc toward where they stood. */
function tookHit(attacker, now) {
  me.hit();
  sound.hurt();
  hurt = 1;
  shake = Math.min(shake + 0.5, 1);
  const from = remotes.get(attacker);
  if (from) damageFrom.push({ x: from.pos.x, z: from.pos.z, at: now });
  if (damageFrom.length > 4) damageFrom.shift();
}

/** What a remote mech is doing that's worth a word on its tag. */
function statusOf(e, now) {
  if (e.repairing) return 'REPAIRING';
  if (now < (e.jammedUntil ?? 0)) return 'JAMMED';
  if (e.ability && e.cls === 2) return 'BRACED';
  if (e.ability && e.cls === 0) return 'SLIPSTREAM';
  return '';
}

/** The Tab scoreboard: both teams sorted by kills, our row marked. */
function renderBoard(myId, hudState) {
  const rows = [];
  const b = net ? net.board() : [];
  for (let i = 0; i < b.length; i += 6) {
    const [id, team, cls, bot, kills, deaths] = b.subarray(i, i + 6);
    rows.push({ id, team, cls, bot, kills, deaths });
  }
  if (!net) rows.push({ id: -1, team: 0, cls: classIdx, bot: 0, kills: 0, deaths: 0 });
  const [blue, red, secondsLeft] = hudState ? [hudState[7], hudState[8], hudState[9]] : [0, 0, 0];
  const clock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const table = (team) => {
    const body = rows
      .filter((r) => r.team === team)
      .sort((x, y) => y.kills - x.kills || x.deaths - y.deaths)
      .map((r) => `<tr class="${r.id === myId ? 'me' : ''}"><td>${esc(nameOf(r.id))}${r.bot ? ' <i>BOT</i>' : ''}</td>`
        + `<td>${classes[CLASS_KEYS[r.cls]].name}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`)
      .join('');
    return `<table class="team t${team}"><tr><th>${team ? 'RED' : 'BLUE'}</th><th>MECH</th><th>K</th><th>D</th></tr>${body}</table>`;
  };
  $('board').innerHTML = `<div class="head">BLUE ${blue} – ${red} RED · ${net ? clock : 'OFFLINE'}</div><div class="teams">${table(0)}${table(1)}</div>`;
}

/**
 * Fills and draws the glass HUD: tags for teammates always and for enemies in sight, radar
 * contacts (enemies only while seen or just after firing), the reticle at the aim point.
 */
function drawGlass(now, myTeam) {
  const W = glass.canvas.width, H = glass.canvas.height;
  const toScreen = (p) => ({ x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H });
  const tags = [], contacts = [];
  let focus = null, focusAngle = THREE.MathUtils.degToRad(4);
  camera.getWorldDirection(look);
  for (const [id, e] of remotes) {
    if (!e.mech.alive) continue;
    const enemy = e.team !== myTeam, h = classValue(e.cls, 'mech_height');
    chest.copy(e.pos).y += h * 0.5;
    const dist = chest.distanceTo(eye);
    let visible = !enemy;
    if (enemy && dist <= T('weapon_range')) {
      to.subVectors(chest, eye).normalize();
      visible = game.cast_ray(eye.x, eye.y, eye.z, to.x, to.y, to.z, dist) >= dist - 0.5;
    }
    if (!enemy || visible || now - (lastFired.get(id) ?? -Infinity) < 2000) contacts.push({ x: e.pos.x, z: e.pos.z, enemy });
    if (!visible || (!enemy && dist > 150)) continue;
    ndc.copy(e.pos).y += enemy ? h * 0.5 : h + 0.8;
    ndc.project(camera);
    if (ndc.z > 1 || Math.abs(ndc.x) > 1.1 || Math.abs(ndc.y) > 1.1) continue;
    const healthMax = classValue(e.cls, 'health_max');
    const tag = {
      ...toScreen(ndc), dist, enemy, unit: id, name: nameOf(id), bot: e.bot, status: statusOf(e, now), focus: false,
      health: e.health / healthMax, hp: Math.ceil(e.health), hpMax: healthMax, label: classes[CLASS_KEYS[e.cls]].name,
    };
    const angle = enemy ? look.angleTo(to.subVectors(chest, camera.position)) : Infinity;
    if (angle < focusAngle) [focusAngle, focus] = [angle, tag];
    tags.push(tag);
  }
  if (focus) focus.focus = true;
  while (hits.length && now - hits[0].at > 1000) hits.shift();

  aim.set(curr[S.AIM], curr[S.AIM + 1], curr[S.AIM + 2]).project(camera);
  const c = classes[CLASS_KEYS[classIdx]];
  glass.resize(renderer.getPixelRatio());
  glass.draw({
    now, yaw, me: { x: pos.x, z: pos.z }, altitude: pos.y, speed: Math.hypot(curr[S.VEL], curr[S.VEL + 2]),
    aim: aim.z < 1 ? toScreen(aim) : null,
    heat: curr[S.HEAT] / T('heat_max'), overheated: !!curr[S.OVERHEATED],
    alt: 1 - curr[S.ALT_WAIT] / Math.max(T('alt_cooldown'), 1e-6), altReady: curr[S.ALT_WAIT] <= 0, altName: c.secondary.name,
    ability: 1 - curr[S.ABILITY_CD] / Math.max(T('ability_cooldown'), 1e-6), abilityActive: curr[S.ABILITY_T] > 0, abilityName: c.ability.name,
    dodge: 1 - curr[S.DODGE_CD] / Math.max(T('dodge_cooldown'), 1e-6),
    health: curr[S.HEALTH], healthMax: T('health_max'), fuel: curr[S.FUEL] / T('fuel_max'), className: c.name,
    friendColor: hex((TEAMS[myTeam] ?? TEAMS[-1]).accent), enemyColor: hex((TEAMS[1 - myTeam] ?? TEAMS[1]).accent),
    repair: { phase: repairPhase(curr[S.REPAIR_T]), ready: 1 - curr[S.REPAIR_CD] / Math.max(T('repair_cooldown'), 1e-6) },
    items: [
      { key: 'G', name: 'Tumbler', charges: curr[S.GRENADES], max: T('grenade_charges'), recharge: 1 - curr[S.GRENADE_WAIT] / Math.max(T('grenade_recharge'), 1e-6) },
      { key: 'T', name: 'Brownout', charges: curr[S.EMPS], max: T('emp_charges'), recharge: 1 - curr[S.EMP_WAIT] / Math.max(T('emp_recharge'), 1e-6) },
    ],
    jammed: curr[S.JAMMED] > 0,
    feed: feed.filter((k) => now - k.at < 6000),
    contacts, tags, hits, damage: damageFrom,
  });
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
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
