import * as THREE from 'three';
import GUI from 'lil-gui';
import init, { WasmNetClient, WasmSim, map_name, tick_dt } from '../sim/pkg/sim.js';
import tuning from '../tuning.json';
import classes from '../classes.json';
import { buildArena } from './arena.js';
import { Effects } from './fx.js';
import saltworks from '../maps/saltworks.json';
import blockout from '../maps/blockout.json';
import { Mech } from './mech.js';
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
const MAPS = { saltworks, blockout };
const mapIndex = (name) => {
  for (let i = 0; map_name(i); i++) if (map_name(i) === name) return i;
  return 0;
};
const sim = net ? null : new WasmSim(JSON.stringify(tuning), mapIndex(params.get('map') ?? 'saltworks'));
const game = net ?? sim;
let ws = null, connection = server ? 'connecting' : '', picked = null;
if (net) {
  ws = new WebSocket(server);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    connection = '';
    if (picked !== null) ws.send(net.pick_class(picked));
  };
  ws.onmessage = (e) => net.receive(new Uint8Array(e.data), performance.now());
  ws.onclose = () => { connection = 'disconnected'; };
}

// Index layout of state(); keep in sync with mech_state in sim/src/wasm.rs.
const S = { POS: 0, VEL: 3, FUEL: 6, HEAT: 7, OVERHEATED: 8, GROUNDED: 9, BOOSTING: 10, HOVERING: 11, DODGE_CD: 12, SHOT: 13, AIM: 14, HEALTH: 17, ABILITY_T: 18, ABILITY_CD: 19 };

// --- Scene ---------------------------------------------------------------
// ?quality=low|high (default high). High drops to Low once if it can't hold 45 fps.
let quality = params.get('quality') === 'low' ? 'low' : 'high';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x4a4238, 1.4));

// The sun's shadow map follows the player, covering the fight around them.
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
createSky(scene, SUN_DIR); // dome, horizon fog and distant skyline, lit from the same sun
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


// The arena is built once its map is known: right away offline, after the Welcome online.
let arenaMap = -1;
const ensureArena = (index) => {
  if (index < 0 || index === arenaMap) return;
  arenaMap = index;
  buildArena(scene, MAPS[map_name(index)]);
};
ensureArena(sim ? mapIndex(params.get('map') ?? 'saltworks') : -1);

const fx = new Effects(scene);
let me = new Mech(scene, fx, 'B'), meClass = 1;

function applyQuality() {
  const high = quality === 'high';
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1));
  renderer.shadowMap.enabled = sun.castShadow = high;
  fx.setQuality(high);
  Mech.halos = high;
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
let hitUntil = 0, hurt = 0, message = '', messageUntil = 0;

// --- Input ---------------------------------------------------------------
const keys = new Set();
let yaw = 0, pitch = 0, dodge = 0, ability = false, firing = false, cockpit = false;
const locked = () => document.pointerLockElement === renderer.domElement;
// Chrome rejects a re-lock right after Esc; the next click simply tries again.
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock()?.catch?.(() => {}));
document.addEventListener('pointerlockchange', () => {
  document.body.classList.toggle('locked', locked());
  if (!locked()) firing = false;
});
addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const limit = THREE.MathUtils.degToRad(T('pitch_limit_deg'));
  yaw -= e.movementX * T('mouse_sensitivity');
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * T('mouse_sensitivity'), -limit, limit);
});
addEventListener('mousedown', (e) => { if (locked() && e.button === 0) firing = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyQ') dodge = -1;
  if (e.code === 'KeyE') dodge = 1;
  if (e.code === 'KeyF') ability = true;
  if (e.code === 'KeyR' && sim) { sim.reset(); prev = curr = sim.state(); }
  if (e.code === 'KeyV') cockpit = !cockpit;
  if (e.code === 'KeyI') $('stats').hidden = !$('stats').hidden;
  if (e.code === 'KeyC' && picked !== null) pickerOpen = !pickerOpen;
  const digit = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (digit >= 0 && !$('picker').hidden) pick(digit);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });
const axis = (pos, neg) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);

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
gui.add({ copy: () => navigator.clipboard.writeText(JSON.stringify(tuning, null, 2) + '\n') }, 'copy').name('Copy tuning.json');

// --- HUD -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const hud = { ability: $('ability'), abilityName: $('ability-name'), status: $('status'), net: $('net'), score: $('score'), banner: $('banner'), damage: $('damage'), fuel: $('fuel'), heat: $('heat'), dodge: $('dodge'), hp: $('hp'), crosshair: $('crosshair') };

// --- Class picker ----------------------------------------------------------
// Shown before the first deploy and on death; C reopens it. Online the pick applies on the next
// spawn (or right away before the first input), so inputs are held until a class is chosen.
let pickerOpen = true;
CLASS_KEYS.forEach((key, i) => {
  const c = classes[key], v = (name) => classValue(i, name);
  const card = document.createElement('button');
  card.className = 'card';
  card.innerHTML = `<span class="key">${i + 1}</span><b>${c.name}</b>${c.role}<dl>
    <dt>HP</dt><dd>${v('health_max')}</dd><dt>Speed</dt><dd>${v('walk_speed')} m/s</dd>
    <dt>DPS</dt><dd>${Math.round(v('fire_rate') * v('shot_damage'))}</dd></dl>
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

// --- Fixed-step sim, interpolated render ----------------------------------
let prev = game.state(), curr = prev, acc = 0, last = performance.now();
const eye = new THREE.Vector3(), offset = new THREE.Vector3(), aim = new THREE.Vector3();
const pos = new THREE.Vector3(), vel = new THREE.Vector3(), seen = new THREE.Vector3(), step = new THREE.Vector3();
const ray = new THREE.Ray(), sphere = new THREE.Sphere(), crossing = new THREE.Vector3();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  acc += dt;
  last = now;
  while (acc >= DT) {
    if (net && picked === null) {
      prev = curr = net.state();
      acc -= DT;
      continue;
    }
    const input = [axis('KeyD', 'KeyA'), axis('KeyW', 'KeyS'), yaw, pitch,
      keys.has('ShiftLeft') || keys.has('ShiftRight'), keys.has('Space'), dodge, firing, ability];
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
    ability = false;
    acc -= DT;
    if (curr[S.SHOT]) shots.push(new THREE.Vector3(curr[S.AIM], curr[S.AIM + 1], curr[S.AIM + 2]));
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
    meClass = classIdx;
  }
  // Dying online opens the picker once; the pick applies on respawn.
  const alive = curr[S.HEALTH] > 0;
  if (net && picked !== null && !alive && prev[S.HEALTH] > 0) pickerOpen = true;

  pos.set(lerp(S.POS), lerp(S.POS + 1), lerp(S.POS + 2));
  me.setTeam(myTeam);
  me.root.visible = !cockpit;
  me.update(dt, {
    pos, yaw, pitch, scale: T('mech_height') / me.height,
    vel: vel.set(lerp(S.VEL), lerp(S.VEL + 1), lerp(S.VEL + 2)),
    grounded: !!curr[S.GROUNDED], boosting: !!curr[S.BOOSTING], hovering: !!curr[S.HOVERING],
    health: curr[S.HEALTH], heat: curr[S.HEAT] / T('heat_max'), overheated: !!curr[S.OVERHEATED],
    ability: curr[S.ABILITY_T] > 0,
  });

  if (net) {
    const r = net.remotes(now), live = new Set();
    for (let i = 0; i < r.length; i += 13) {
      const [id, team, cls, x, y, z, ryaw, rpitch, health, boosting, hovering, , abilityOn] = r.subarray(i, i + 13);
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
      e.mech.setTeam(team);
      e.mech.update(dt, {
        pos: e.pos, yaw: ryaw, pitch: rpitch, scale: classValue(cls, 'mech_height') / e.mech.height, vel: e.vel,
        grounded: !hovering && Math.abs(e.vel.y) < 1.5, boosting: !!boosting, hovering: !!hovering, health,
        ability: !!abilityOn,
      });
    }
    for (const [id, e] of remotes) if (!live.has(id)) { e.mech.dispose(); remotes.delete(id); }

    const ev = net.take_events();
    for (let i = 0; i < ev.length; i += 6) {
      const [kind, a, b, x, y, z] = ev.subarray(i, i + 6);
      if (kind === 0) {
        // Own shots were drawn when predicted; everyone else's come from the server.
        if (a !== myId) remotes.get(a)?.mech.fire(new THREE.Vector3(x, y, z));
        if (a === myId && b >= 0) hitUntil = now + 150;
        if (b === myId) { me.hit(); hurt = 1; } else if (b >= 0) remotes.get(b)?.mech.hit();
      }
      if (kind === 1 && (a === myId || b === myId)) { message = a === myId ? 'ENEMY DESTROYED' : 'DESTROYED'; messageUntil = now + 2500; }
    }
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
    me.fire(ray.at(reach, end));
  }
  shots.length = 0;

  // Look is applied at render rate for responsiveness; position is interpolated.
  eye.copy(pos).y += T('eye_height');
  camera.rotation.set(pitch, yaw, 0);
  camera.position.copy(eye);
  if (!cockpit) {
    // Pull the chase camera in front of any wall behind the mech.
    offset.set(0, T('chase_height'), T('chase_distance')).applyQuaternion(camera.quaternion);
    const want = offset.length();
    const room = game.cast_ray(eye.x, eye.y, eye.z, offset.x, offset.y, offset.z, want + 0.5) - 0.5;
    camera.position.addScaledVector(offset, Math.max(room, 0.5) / want);
  }
  if (camera.fov !== T('fov')) { camera.fov = T('fov'); camera.updateProjectionMatrix(); }
  placeSun(pos);
  fx.update(dt, camera, renderer.domElement.height);
  hurt = Math.max(0, hurt - dt * 2.5);
  hud.damage.style.opacity = hurt;

  // Crosshair marks where the eye ray lands, so chase-cam parallax stays honest.
  aim.set(curr[S.AIM], curr[S.AIM + 1], curr[S.AIM + 2]).project(camera);
  hud.crosshair.style.left = `${(aim.x + 1) * 50}%`;
  hud.crosshair.style.top = `${(1 - aim.y) * 50}%`;

  const speed = Math.hypot(curr[S.VEL], curr[S.VEL + 2]);
  const flags = [curr[S.BOOSTING] && 'BOOST', curr[S.HOVERING] && 'HOVER', !curr[S.GROUNDED] && 'AIR', curr[S.OVERHEATED] && 'OVERHEAT'].filter(Boolean);
  $('picker').hidden = !pickerOpen;
  $('picker-note').textContent = picked === null ? '' : alive ? 'Applies on your next respawn · C to close' : 'Applies on respawn';
  hud.status.textContent = `${classes[CLASS_KEYS[classIdx]].name}  ${speed.toFixed(1)} m/s  y ${curr[S.POS + 1].toFixed(1)}  ${flags.join(' ')}`;
  hud.fuel.style.width = `${(100 * curr[S.FUEL]) / T('fuel_max')}%`;
  hud.heat.style.width = `${(100 * curr[S.HEAT]) / T('heat_max')}%`;
  hud.heat.classList.toggle('over', !!curr[S.OVERHEATED]);
  hud.dodge.style.width = `${100 * (1 - curr[S.DODGE_CD] / Math.max(T('dodge_cooldown'), 1e-6))}%`;
  hud.hp.style.width = `${(100 * curr[S.HEALTH]) / T('health_max')}%`;
  const abilityActive = curr[S.ABILITY_T] > 0;
  hud.ability.style.width = `${100 * (1 - curr[S.ABILITY_CD] / Math.max(T('ability_cooldown'), 1e-6))}%`;
  hud.ability.classList.toggle('active', abilityActive);
  hud.abilityName.textContent = `${classes[CLASS_KEYS[classIdx]].ability.name}${abilityActive ? ' ON' : curr[S.ABILITY_CD] <= 0 ? ' F' : ''}`;
  hud.crosshair.classList.toggle('hit', now < hitUntil);
  if (net) {
    const [, kills, deaths, ping, correction, full, team, blue, red, secondsLeft, ended, winner] = hudState;
    const state = full ? 'server full' : connection || (curr[S.HEALTH] <= 0 ? 'DESTROYED, respawning' : '');
    hud.net.textContent = `K ${kills}  D ${deaths}  ping ${Math.round(ping)} ms  corr ${correction.toFixed(3)} m  ${now < messageUntil ? message : state}`;
    const clock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
    hud.score.textContent = `${team === 0 ? '▸ ' : ''}BLUE ${blue} – ${red} RED${team === 1 ? ' ◂' : ''}   ${ended ? '' : clock}`;
    hud.banner.textContent = ended ? `${winner < 0 ? 'DRAW' : winner === team ? 'VICTORY' : 'DEFEAT'} · next match in ${secondsLeft}s` : '';
  }

  renderer.render(scene, camera);
  watchPerformance(now, dt);
  requestAnimationFrame(frame);
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
