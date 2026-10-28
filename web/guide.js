// The guide at /guide/: one page for all its sections (/guide/mechs, /guide/weapons, ...), drawn
// from the data the game itself runs on (tuning.json, classes.json, weapons.json, maps/*.json), so
// its numbers follow every change. The pictures come from the game's own models: the hangar's
// turntable and weapon profiles (hangar.js), loaded once a section needs them, and the maps' pictures,
// rendered ahead of time by tools/shoot.html.
import tuning from '../tuning.json';
import classes from '../classes.json';
import weapons from '../weapons.json';
import { GLYPHS, STATS, facts, shown } from './cards.js';
import { controlsHtml } from './controls.js';
import { POINTS_PER_LEVEL, fits, levelXp } from './progress.js';
import GUIDE_MAPS from '../guide/maps.json'; // each map's blurb and points of interest

// The sim's Rust constants the guide quotes, by their names there (sim/src/game.rs, objective.rs,
// siege.rs, projectile.rs, progress.rs), and the server's match defaults (MATCH_SECONDS,
// SCORE_LIMIT: game.rs's, which server/src/main.rs's env vars can change): keep these in step.
const SIM = {
  TEAM_SIZE: 4, MAX_PLAYERS: 8, POST_MATCH_SECONDS: 10, STAGING_SECONDS: 10, MATCH_SECONDS: 600, SCORE_LIMIT: 20, DM_MAX_SIZE: 200,
  POINTS_PER_KILL: 100, KILLER_BONUS: 0.25, ASSIST_WINDOW: 15, CAPTURE_POINTS: 50, EU_POINTS: 0.5, SHIP_POINTS: 0.05,
  ORB_HEALTH: 37.5, ORB_RADIUS: 6, ORB_RATE: 10, ORB_SECONDS: 30, EDGE_DAMAGE: 0.3,
  SENTRY_RANGE: 35, SENTRY_SHIP_RANGE: 90, SENTRY_BURST: 8, SENTRY_ROUND: 4, SENTRY_ACQUIRE: 0.6, SENTRY_SHIELD: 400, SENTRY_OFFLINE: 25, SENTRY_IMMUNE: 15,
  CAPTURE_SECONDS: 8, CAPTURE_SPEEDUP: 0.5, CAPTURE_CREW: 3, DRIFT_SECONDS: 16,
  BASE_HULL: 1000, MISSILE_SECONDS: 10, MISSILE_FLIGHT: 10, MISSILE_DAMAGE: 20,
  STATION_CAP: 400, STATION_REFILL: 10, STATION_RATE: 30, CARRY_MAX: 100, BASE_RADIUS: 14, TRICKLE: 1, LAUNCH_EU: 500,
  DROP_RADIUS: 4, DROP_SECONDS: 30, SHIP_HULL: 3000, SHIP_SPEED: 4, DUEL_RANGE: 120, DUEL_DPS: 30, BOMBARD_DPS: 15,
  AA_RANGE: 150, AA_DPS: 25,
  TAKE_SECONDS: 3, CAPTURES_TO_WIN: 3, PICKUP_RADIUS: 3, FLAG_CAPTURE_POINTS: 200, FLAG_RETURN_POINTS: 50, LADEN_SPEED: 0.8, // ctf.rs, lib.rs
  SPEED: 10, ESCORT_SPEEDS: [0.75, 1, 1.25, 1.5], ESCORT_RANGE: 30, SHIELD: 1500, STALL_SECONDS: 8, ESCORT_POINTS: 2, // convoy.rs
  KILL_XP: 100, BOT_KILL_XP: 25, HEAL_XP: 0.5, MATCH_XP: 100, WIN_XP: 150, CAPTURE_XP: 50, EU_XP: 0.5, SHIP_XP: 0.05, ESCORT_XP: 1, MAX_LEVEL: 99,
};
// Co-op Defense's constants, by their names in sim/src/defense.rs and game.rs, kept in step the same way (the foes'
// hulls and plating are `defense::species`', the gates' and flanking's are `GATES_ONE`, `GATES_TWO` and `FLANK`).
const COOP = {
  REACTOR_HULL: 2000, LEAK: 100, WAVES: 10, FIRST_BREAK: 60, BREAK: 30, START_SCRAP: 250, SCRAP_PER_HULL: 0.35, WAVE_BONUS: 100, CACHES: 2, CACHE_SCRAP: 60,
  PRICES: [100, 150, 175, 200], TIERS: 3, UPGRADE: 1, REFUND: 0.7, REACH: 30, LANE_CLEAR: 5,
  TOWER_MG_POWER: 2.2, TOWER_ROCKET_POWER: 1.6, ARC_RANGE: 20, ARC_DAMAGE: 40, ARC_HOPS: 3, ARC_FALLOFF: 0.7, ARC_COOLDOWN: 1.5, PULSE_RADIUS: 14, PULSE_STUN: 2.5, PULSE_DAMAGE: 15, PULSE_COOLDOWN: 7,
  WALKER_RANGE: 30, CRAWLER_PACK: 4, CRAWLER_BLAST: 5, CRAWLER_DAMAGE: 60, BRUTE_ARMOR: 5, BRUTE_REACH: 8, BRUTE_SMASH: 150,
  MORTAR_RANGE: 60, MORTAR_FLIGHT: 2.5, MORTAR_BLAST: 4, MORTAR_DAMAGE: 80, NODE_DOME: 250, NODE_RECHARGE: 8,
  EXCAVATOR_HULL: 2600, EXCAVATOR_ARMOR: 6, EXCAVATOR_LEAK: 600, EXCAVATOR_REACH: 10, EXCAVATOR_EVERY: 20, EXCAVATOR_UNDER: 4, QUAKE_RADIUS: 12, QUAKE_DAMAGE: 120, QUAKE_STUN: 3,
  HIVE_HULL: 4500, HIVE_ARMOR: 4, HIVE_LEAK: 1000, HIVE_EVERY: 10, HIVE_BROOD: 3, HIVE_BURST: 8, HIVE_EMP: 25,
  GATES_ONE: 2, GATES_TWO: 5, FLANK: 0.8,
};

const $ = (id) => document.getElementById(id);
const KEYS = ['A', 'B', 'C'];
const T = (name) => tuning[name].value;
/** Class `key`'s value of tuning constant `name`. */
const cv = (key, name) => classes[key].overrides[name] ?? T(name);
/** A lookup of entry `w`'s values, as `facts` and STATS read them: its own stats over tuning.json. */
const stat = (w) => (name) => w.stats?.[name] ?? tuning[name]?.value;
const byId = Object.fromEntries(Object.values(weapons).flat().map((w) => [w.id, w]));
const slug = (key) => classes[key].name.toLowerCase();
// The loadout slots: key, weapons.json list, label, button, and the section listing them.
const SLOTS = [
  ['primary', 'primaries', 'PRIMARY', 'LMB', 'weapons'],
  ['secondary', 'secondaries', 'SECONDARY', 'RMB', 'weapons'],
  ['offensive', 'offensive', 'ITEM', 'Q', 'items'],
  ['support', 'support', 'SUPPORT', 'E', 'items'],
  ['ability', 'abilities', 'ABILITY', 'F', 'items'],
];
const link = (id) => `<a href="/guide/${SLOTS.find(([, list]) => weapons[list].includes(byId[id]))[4]}#${id}">${byId[id].name}</a>`;
const num = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;

// Maps load only for the sections that show them: those guide/maps.json covers (not the sim's
// test map, or one still being made).
const MAP_FILES = import.meta.glob(['../maps/*.json', '!../maps/nav.json'], { import: 'default' });
const loadMaps = async () => (await Promise.all(Object.keys(GUIDE_MAPS).map(async (id) => ({ id, ...(await MAP_FILES[`../maps/${id}.json`]()) }))))
  .sort((a, b) => a.size[0] - b.size[0] || a.name.localeCompare(b.name));
// The modes, and which maps play them (Mode::fits in sim/src/game.rs). A map marked co-op plays Co-op Defense
// alone; Foundry's stand-in co-op data (for testing) isn't marked, so the guide leaves it out of that mode.
const coop = (m) => !!m.objectives?.coop;
const MODES = [
  ['tdm', 'Team Deathmatch', (m) => !coop(m)],
  ['dm', 'Deathmatch', (m) => !coop(m) && Math.max(...m.size) <= SIM.DM_MAX_SIZE],
  ['ma', 'Missile Assault', (m) => !coop(m) && !!m.objectives?.bases && m.objectives.silos?.length === 3],
  ['siege', 'Siege', (m) => !coop(m) && !!(m.objectives?.bases && m.objectives.aa && m.objectives.sky) && m.objectives.stations?.length > 0],
  ['ctf', 'Capture the Flag', (m) => !coop(m) && !!m.objectives?.flags],
  ['convoy', 'Convoy', (m) => { const c = m.objectives?.convoy; return !coop(m) && !!c && c.points.length >= 3 && c.start > 0 && c.start < c.points.length - 1; }],
  ['defense', 'Co-op Defense', (m) => coop(m) && m.objectives.defense?.gates?.length > 0],
];
const TEAM = ['#4fb4ff', '#ff5a36'];
// The maps' pictures, as tools/shoot.html made them from guide/maps.json's viewpoints: <map>-plan, <map>-hero and <map>-<spot id>.
const SHOTS = import.meta.glob('../guide/shots/*.webp', { eager: true, query: '?url', import: 'default' });

// --- Sections --------------------------------------------------------------

function overview() {
  const own = Object.fromEntries(SLOTS.map(([slot]) => [slot, byId[classes.B.weapons[slot]]]));
  const count = (list) => weapons[list].length;
  return `
    <h1>FIELD GUIDE</h1>
    <p class="lede">How MECHWAR plays: the three mechs, everything they carry, the modes and the maps. Every number here is read from the game's own data, so it's always the current one.</p>
    <h2>GETTING STARTED</h2>
    <ol class="steps">
      <li>On the <a href="/">home page</a>, pick a callsign and press QUICK PLAY. It finds a game with room or opens one, and bots fill the empty seats, so there's always a match.</li>
      <li>The hangar opens. Choose a mech, Light, Medium or Heavy, and what fills its five slots: a primary, a secondary, an item, a support item and an ability. Then LAUNCH.</li>
      <li>A team match opens with ${SIM.STAGING_SECONDS} s behind a shield round each team's spawns, to launch and get ready; no shot does damage. It beeps down the last three seconds, and then the shields drop.</li>
      <li>Click into the game to take the mouse. Esc gives it back and opens the menu, which lists every control for what you're carrying.</li>
      <li>Downed, you can launch again after ${T('respawn_delay')} s, and change your build in the hangar first. A fresh launch is shielded for ${T('spawn_shield')} s, until you move or fire.</li>
      <li>Every match earns XP. Each level brings ${POINTS_PER_LEVEL} unlock points to spend in the hangar on more weapons, items and abilities, one mech at a time.</li>
    </ol>
    ${figure('start-hangar', "The hangar: a bay for each mech, its five slots in tabs, and every pick's numbers and controls.")}
    <h2>CONTROLS <small>MOUSE SHOWN FOR THE MEDIUM'S STOCK LOADOUT</small></h2>
    <section id="controls">${controlsHtml(own, false)}</section>
    <h2>IN THIS GUIDE</h2>
    <div class="links">
      <a href="/guide/mechs"><b>MECHS</b><small>The three classes: speed, armor, heat and stock loadouts</small></a>
      <a href="/guide/weapons"><b>WEAPONS</b><small>${count('primaries')} primaries and ${count('secondaries')} secondaries, with their numbers</small></a>
      <a href="/guide/items"><b>ITEMS</b><small>${count('offensive')} items, ${count('support')} support items and ${count('abilities')} abilities</small></a>
      <a href="/guide/modes"><b>MODES</b><small>${MODES.map(([, name]) => name).join(', ')}</small></a>
      <a href="/guide/maps"><b>MAPS</b><small>${Object.keys(GUIDE_MAPS).length} arenas: layouts and places worth knowing</small></a>
      <a href="/guide/mechanics"><b>MECHANICS</b><small>Movement, heat, damage, repair, lock-ons and progression</small></a>
    </div>`;
}

// Mechs: each class on its own turntable, its numbers as bars against the other two.
const MECH_STATS = [
  ['Health', 'health_max', ' hp'], ['Walk', 'walk_speed', ' m/s'], ['Boost', 'boost_speed', ' m/s'], ['Dash', 'dodge_speed', ' m/s'],
  ['Dash recharge', 'dodge_cooldown', ' s'], ['Heat capacity', 'heat_max', ''], ['Mass', 'mech_mass', ''], ['Height', 'mech_height', ' m'],
];
function mechs() {
  return `
    <h1>MECHS</h1>
    <p class="lede">Three classes, from quick and fragile to slow and tough. Each carries a primary, a secondary, an item, a support item and an ability, starting with its own stock set; the rest unlock as you level. Drag a mech to turn it.</p>
    ${KEYS.map((key) => {
      const c = classes[key];
      const bars = MECH_STATS.map(([label, name, unit]) => {
        const x = cv(key, name), max = Math.max(...KEYS.map((k) => cv(k, name)));
        return `<span>${label}</span><span class="bar"><i style="width: ${Math.round((100 * x) / max)}%"></i></span><span>${x}${unit}</span>`;
      }).join('');
      const stock = SLOTS.map(([slot, , label]) => `<dt>${label}</dt><dd>${link(c.weapons[slot])}</dd>`).join('');
      const abilities = weapons.abilities.filter((w) => fits(key, w));
      const more = Object.values(weapons).flat().filter((w) => fits(key, w)).length - SLOTS.length - (c.unlocked?.length ?? 0);
      return `<section class="mech card" id="${slug(key)}">
        <canvas id="turn-${key}" aria-label="The ${c.name} mech, turning"></canvas>
        <div>
          <h2>${c.name.toUpperCase()}<small>${c.role.toUpperCase()}</small></h2>
          <div class="bars">${bars}</div>
          <h4>STOCK LOADOUT</h4><dl class="kit">${stock}</dl>
          ${c.unlocked?.length ? `<h4>UNLOCKED FROM THE START</h4><div class="chips">${c.unlocked.map(link).join('')}</div>` : ''}
          <h4>ABILITIES IT CAN CARRY</h4><div class="chips">${abilities.map((w) => link(w.id)).join('')}</div>
          <p>${more} more weapons, items and abilities to unlock.</p>
        </div></section>`;
    }).join('')}`;
}
async function turnMechs() {
  const [{ Preview }, { ownLoadout }] = await Promise.all([import('./hangar.js'), import('./mech.js')]);
  const tallest = Math.max(...KEYS.map((k) => cv(k, 'mech_height')));
  const previews = KEYS.map((key) => {
    const p = new Preview($(`turn-${key}`), tallest);
    p.show(key, ownLoadout(key), cv(key, 'mech_height'));
    return p;
  });
  // Only those on screen draw; with reduced motion they hold still, but still turn by dragging.
  const shown = new Set(), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) shown[e.isIntersecting ? 'add' : 'delete'](previews[KEYS.indexOf(e.target.id.slice(5))]);
  });
  for (const key of KEYS) seen.observe($(`turn-${key}`));
  let last = performance.now();
  const frame = (now) => {
    const dt = still ? 0 : Math.min((now - last) / 1000, 0.1);
    last = now;
    for (const p of shown) p.render(dt, -1);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Whether, and how, each class gets entry `w`: stock, unlocked from the start, its price, or not at all. */
const fitRow = (w) => `<div class="fit">${KEYS.map((key) => {
  const c = classes[key];
  const [cls, text] = !fits(key, w) ? ['no', '—']
    : Object.values(c.weapons).includes(w.id) ? ['own', 'STOCK']
    : c.unlocked?.includes(w.id) ? ['own', 'UNLOCKED']
    : ['', `${w.unlock} POINT${w.unlock === 1 ? '' : 'S'}`];
  return `<span class="${cls}">${c.name.toUpperCase()}<b>${text}</b></span>`;
}).join('')}</div>`;
const card = (w, pic, nums) => `<article class="card" id="${w.id}">
  <div class="head"><span class="pic">${pic}</span><div><h3>${w.name}</h3><small>${w.desc}</small></div></div>
  ${w.use ? `<ul class="use">${w.use.map(([key, text]) => `<li><kbd${key ? '' : ' class="blank"'}>${key}</kbd>${text}</li>`).join('')}</ul>` : ''}
  ${nums ? `<dl class="nums">${nums}</dl>` : ''}
  ${fitRow(w)}</article>`;
const FIT_KEY = '<p>Under each, what it takes to carry it on each mech: STOCK (its own), UNLOCKED (from the start), or the unlock points it costs.</p>';

/** One full hit of entry `w` of `list` (every pellet, full charge), or null where it has no single hit (beams, wind-ups, heat-fed shots). */
function hitOf(list, w) {
  const v = stat(w);
  if (list === 'primaries') return v('shot_damage') * v('pellets') * (v('charge_time') > 0 ? v('charge_damage') : 1);
  if (v('alt_beam') > 0 || v('alt_charge_time') > 0 || v('alt_heat_fed') > 0) return null;
  return STATS.secondaries[0][1](v);
}
function weaponNums(list, w) {
  const v = stat(w), hit = hitOf(list, w);
  const rows = STATS[list].map(([label, f, unit]) => [label, f(v), unit]).filter(([, x]) => x > 0).map(([label, x, unit]) => num(label.toUpperCase(), `${shown(x)}${unit}`));
  // Hitscan rounds fade with range (weapon::falloff); projectiles don't.
  if (list === 'primaries' && !w.projectile) rows.push(num('FALLOFF', `full to ${v('falloff_start')} m, ${Math.round(v('falloff_floor') * 100)}% by ${v('falloff_end')} m`));
  if (hit) rows.push(num('HITS TO DOWN L · M · H', KEYS.map((k) => Math.ceil(cv(k, 'health_max') / hit)).join(' · ')));
  return rows.join('');
}
function weaponsSection() {
  const list = (name) => weapons[name].map((w) => card(w, '', weaponNums(name, w))).join('');
  return `
    <h1>WEAPONS</h1>
    <p class="lede">Any mech can carry any of these: a primary on the left mouse button and a secondary on the right, some using the middle button too. Both run on one heat meter (see <a href="/guide/mechanics#heat">heat</a>).</p>
    ${FIT_KEY}
    <p>Hits to down count full hits on a Light, a Medium and a Heavy: every pellet, inside the weapon's falloff, at full charge.</p>
    <h2>PRIMARIES <small>LMB</small></h2><div class="grid">${list('primaries')}</div>
    <h2>SECONDARIES <small>RMB · MMB</small></h2><div class="grid">${list('secondaries')}</div>`;
}
async function drawWeapons() {
  const { weaponThumbs } = await import('./hangar.js');
  const thumbs = weaponThumbs([...weapons.primaries, ...weapons.secondaries].map((w) => w.id), 224, 112);
  for (const [id, url] of thumbs) $(id).querySelector('.pic').innerHTML = `<img src="${url}" alt="">`;
}

function itemsSection() {
  const list = (name) => weapons[name].map((w) => card(w, GLYPHS[w.id] ?? '', num(name === 'abilities' ? 'TIMING' : 'CHARGES', facts(name, w.id, stat(w))))).join('');
  return `
    <h1>ITEMS</h1>
    <p class="lede">Beside its weapons, every mech carries an item (Q), a support item (E) and an ability (F). Items and support items come in charges that recharge one at a time; an ability runs for a while, then cools down. Some abilities belong to only one or two classes.</p>
    ${FIT_KEY}
    <h2>ITEMS <small>Q</small></h2><div class="grid">${list('offensive')}</div>
    <h2>SUPPORT <small>E</small></h2><div class="grid">${list('support')}</div>
    <h2>ABILITIES <small>F</small></h2><div class="grid">${list('abilities')}</div>`;
}

async function modes() {
  const maps = await loadMaps();
  const where = (fit) => `<div class="chips">${maps.filter(fit).map((m) => `<a href="/guide/maps/${m.id}">${m.name}</a>`).join('')}</div>`;
  const kill = SIM.POINTS_PER_KILL, solo = kill * (1 + SIM.KILLER_BONUS), C = COOP, pct = (x) => `${Math.round(x * 100)}%`;
  const RULES = {
    tdm: [
      `Two teams of ${SIM.TEAM_SIZE}. Every enemy a pilot on your team downs is a point for it (base guns' kills don't count).`,
      `First to the score limit wins (${SIM.SCORE_LIMIT} unless the game was opened with another); at time, the higher score, or a draw.`,
    ],
    dm: [
      `${SIM.MAX_PLAYERS} pilots, each on their own, on the smaller maps (up to ${SIM.DM_MAX_SIZE} m across).`,
      `A kill is worth ${kill} points, shared by the damage each pilot did in the last ${SIM.ASSIST_WINDOW} s, and the pilot who lands the kill gets ${kill * SIM.KILLER_BONUS} more: a kill all your own is ${solo}.`,
      `First to ${solo} × the score limit wins (${(solo * SIM.SCORE_LIMIT).toLocaleString('en')} for ${SIM.SCORE_LIMIT}); at time, most points, then most kills.`,
    ],
    ma: [
      `Each team has a base with ${SIM.BASE_HULL.toLocaleString('en')} hull. Three missile silos, A, B and C, stand between them.`,
      `Stand in a silo's zone to take it: ${SIM.CAPTURE_SECONDS} s alone from neutral, faster with teammates in it (${SIM.CAPTURE_CREW} or more take it in ${SIM.CAPTURE_SECONDS / (1 + SIM.CAPTURE_SPEEDUP * (SIM.CAPTURE_CREW - 1))} s). An enemy silo must be brought back to neutral first, so twice as long. With both sides in the zone it holds still; left empty, it drifts back to whoever held it, or to neutral.`,
      `A held silo launches a missile at the enemy base every ${SIM.MISSILE_SECONDS} s; each lands ${SIM.MISSILE_FLIGHT} s later for ${SIM.MISSILE_DAMAGE} damage.`,
      `Knock the enemy base down to win; at time, the base with more hull left wins. Each pilot in a zone when it's taken scores ${SIM.CAPTURE_POINTS}.`,
    ],
    siege: [
      `Each team has a base with ${SIM.BASE_HULL.toLocaleString('en')} hull, and only battleships can hurt it. Fill your bank with ${SIM.LAUNCH_EU} energy (EU) to launch yours.`,
      `Draw EU at the energy station mid-map: it gives ${SIM.STATION_RATE} EU/s in all, shared by everyone in its zone, either side, and holds ${SIM.STATION_CAP}, refilling ${SIM.STATION_REFILL}/s. Carry up to ${SIM.CARRY_MAX} home and bank it within ${SIM.BASE_RADIUS} m of your base. While no ship is up, each bank also trickles in ${SIM.TRICKLE} EU/s.`,
      `A downed mech drops what it carried, for anyone within ${SIM.DROP_RADIUS} m to pick up for ${SIM.DROP_SECONDS} s.`,
      `A battleship has ${SIM.SHIP_HULL.toLocaleString('en')} hull. It flies at ${SIM.SHIP_SPEED} m/s for the enemy base, holding its fire on mechs, and bombards the base at ${SIM.BOMBARD_DPS}/s once over it. Two ships within ${SIM.DUEL_RANGE} m stop to duel, ${SIM.DUEL_DPS}/s each.`,
      `Whoever holds the anti-air (AA) zone, taken like a silo, hits the enemy ship within ${SIM.AA_RANGE} m for ${SIM.AA_DPS}/s; base guns fire on it within ${SIM.SENTRY_SHIP_RANGE} m.`,
      `Destroy the enemy base to win; at time, more hull left wins. Pilots score ${SIM.CAPTURE_POINTS} for taking the AA, ${SIM.EU_POINTS} per EU banked and ${SIM.SHIP_POINTS} per point of hull shot off the enemy ship.`,
    ],
    ctf: [
      `Each team's flag stands by its base. Stand in the enemy stand's zone ${SIM.TAKE_SECONDS} s to take their flag; a defender in the zone holds the raid off, and it ebbs once the raiders leave.`,
      `Carry it into your own stand's zone to capture it; your own flag needn't be home. First to ${SIM.CAPTURES_TO_WIN} captures wins; at time, more captures, or a draw.`,
      `The carrier walks at ${SIM.LADEN_SPEED * 100}% speed and can't boost or dash (hover and jump pads still work), drops out of Camouflage, and can still shoot; the flag rides over them for all to see.`,
      `A downed carrier drops the flag where they fell, and anyone walking over it picks it up: the raiders to carry on, the owners to carry it home. One that falls where nobody can reach goes home.`,
      `Pilots score ${SIM.CAPTURE_POINTS} for taking a flag off its stand, ${SIM.FLAG_CAPTURE_POINTS} for a capture and ${SIM.FLAG_RETURN_POINTS} for carrying their own home.`,
    ],
    convoy: [
      `A hauler waits in the middle of a route that runs between the two bases. Walk it into the enemy base to win; at time, the side that pushed it further from the start wins.`,
      `The side with more mechs within ${SIM.ESCORT_RANGE} m of it walks it toward the other's base, faster the bigger its lead: ${SIM.SPEED * SIM.ESCORT_SPEEDS[0]} m/s with one more, ${SIM.SPEED * SIM.ESCORT_SPEEDS[1]} with two, up to ${SIM.SPEED * SIM.ESCORT_SPEEDS.at(-1)} with all ${SIM.ESCORT_SPEEDS.length} unopposed. Even numbers stop it, and with nobody near it stays put.`,
      `Anyone can shoot it: knock its ${SIM.SHIELD.toLocaleString('en')} shield through and it stalls ${SIM.STALL_SECONDS} s, then comes back full.`,
      `Escorts score ${SIM.ESCORT_POINTS} points a second while it walks for them.`,
    ],
    defense: [
      `Up to ${SIM.TEAM_SIZE} pilots, bots filling the team, hold a reactor of ${C.REACTOR_HULL.toLocaleString('en')} hull against ${C.WAVES} waves of infested machines, with ${C.FIRST_BREAK} s to get ready and ${C.BREAK} s between waves. There's no clock: the run ends when the reactor falls or the last wave is beaten.`,
      `Foes come out of the map's gates and walk its lanes, forking by chance, to the reactor. One that reaches it is gone and takes hull off by its kind (${C.LEAK} for a walker).`,
    ],
  };
  // What a mode's card adds below its rules: Co-op Defense has a build menu, scrap, drafts and a roster of foes.
  const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const MORE = {
    defense: `
      <h4>BUILDING</h4>
      <ul class="rules">
        <li>B opens the build menu, 1–4 pick a tower and the left button puts it down where you aim; a ghost shows green where it fits, or red with the reason. It needs flat ground with headroom, within ${C.REACH} m of you, ${C.LANE_CLEAR} m off any lane, and clear of other towers and the reactor.</li>
        <li>U raises the tower you aim at a tier, anyone's, up to tier ${C.TIERS}: more hull, reach and fire rate, for ${pct(C.UPGRADE)} of its price at tier 1 and ${pct(2 * C.UPGRADE)} at tier 2. X sells your own for ${pct(C.REFUND)} of what you put into it. The ${link('mender')} mends towers and the reactor.</li>
        <li>High ground matters: a tower 5 m or more above a lane is out of crawlers' and brutes' reach.</li>
      </ul>
      ${table(['TOWER', 'PRICE', 'WHAT IT DOES'], [
        ['MG tower', C.PRICES[0], `Fast fire at single targets, ${C.TOWER_MG_POWER} times the ${link('mg_turret')}'s damage to the hive`],
        ['Rocket tower', C.PRICES[1], `Heavy hits with splash, ${C.TOWER_ROCKET_POWER} times the ${link('rocket_turret')}'s`],
        ['Arc pylon', C.PRICES[2], `Lightning at the nearest foe within ${C.ARC_RANGE} m for ${C.ARC_DAMAGE}, jumping on to ${C.ARC_HOPS} more, each for ${pct(C.ARC_FALLOFF)} of the last, every ${C.ARC_COOLDOWN} s`],
        ['Pulse pylon', C.PRICES[3], `Every ${C.PULSE_COOLDOWN} s an EMP stops every foe within ${C.PULSE_RADIUS} m for ${C.PULSE_STUN} s, shakes ${C.PULSE_DAMAGE} off each and pops shield domes`],
      ])}
      <h4>SCRAP AND DRAFTS</h4>
      <ul class="rules">
        <li>Scrap is each pilot's own: ${C.START_SCRAP} to start, ${C.SCRAP_PER_HULL} per point of hull that you or your towers shoot off a foe, ${C.WAVE_BONUS} for each wave beaten, and ${C.CACHE_SCRAP} for a supply cache (${C.CACHES} lie out each break, far from the reactor).</li>
        <li>After each wave every pilot drafts 1 of 3 perks (1–3) that improve only their own towers or mech, most stacking twice: tower hull, fire rate and reach, cheaper builds, more scrap, and for your mech less damage taken and more dealt to the hive. A downed infested mech leaves a glowing core worth another draft, and a boss's offers blueprints, each held once: flak rounds for MG towers, sabot rockets, storm arc pylons, stasis pulse pylons.</li>
      </ul>
      <h4>ENEMIES</h4>
      ${table(['ENEMY', 'WAVE', 'WHAT IT DOES', 'WHAT ANSWERS IT'], [
        ['Infested walker', 1, `Walks the lane, shooting towers and pilots from ${C.WALKER_RANGE} m`, 'Any tower'],
        ['Crawler', 3, `A fast pack of ${C.CRAWLER_PACK} that blows up on a tower or pilot: ${C.CRAWLER_DAMAGE} to every tower within ${C.CRAWLER_BLAST} m`, 'Arc pylons and flak, which hit a pack at once; a pulse pylon stops it short'],
        ['Ore brute', 4, `Slow and plated (each hit loses ${C.BRUTE_ARMOR}); smashes ${C.BRUTE_SMASH} off every tower within ${C.BRUTE_REACH} m. Keeps off narrow lanes where it can`, 'Heavy hits: rocket towers, and sabot rockets'],
        ['Mortar walker', 5, `Digs in once a tower is within ${C.MORTAR_RANGE} m and shells it, a red ring showing the landing ${C.MORTAR_FLIGHT} s ahead: ${C.MORTAR_DAMAGE} to every tower within ${C.MORTAR_BLAST} m`, 'A pilot sent after it, as towers mostly can\'t reach'],
        ['Infested mech', 6, 'A mech bot on the hive\'s side that heads for the reactor, fighting whoever it meets', 'Pilots, with the towers'],
        ['Shield node', 7, `Carries a dome (${C.NODE_DOME} hull, more each wave) over the foes round it, back ${C.NODE_RECHARGE} s after it breaks`, 'A pulse pylon pops it, or down the node'],
      ])}
      <h4>BOSSES</h4>
      <ul class="rules">
        <li><b>The Excavator</b> (wave 5), ${C.EXCAVATOR_HULL.toLocaleString('en')} hull for a full team, plated ${C.EXCAVATOR_ARMOR}: grinds every tower within ${C.EXCAVATOR_REACH} m, and every ${C.EXCAVATOR_EVERY} s burrows for ${C.EXCAVATOR_UNDER} s, out of reach, then bursts up in a quake (${C.QUAKE_DAMAGE} to every tower within ${C.QUAKE_RADIUS} m, and a ${C.QUAKE_STUN} s stun); reaching the reactor, it takes ${C.EXCAVATOR_LEAK} off it. Heavy hits, and towers spread out.</li>
        <li><b>The Hive walker</b> (wave 10), ${C.HIVE_HULL.toLocaleString('en')} hull, plated ${C.HIVE_ARMOR}: breeds ${C.HIVE_BROOD} crawlers every ${C.HIVE_EVERY} s, and at two thirds and one third of its hull bursts out ${C.HIVE_BURST} more and an EMP that stops every tower within ${C.HIVE_EMP} m for ${C.QUAKE_STUN} s. Reaching the reactor, it takes ${C.HIVE_LEAK.toLocaleString('en')} off it.</li>
      </ul>
      <h4>VARIATIONS</h4>
      <ul class="rules">
        <li>The next wave is drawn up each break and shown on the panel, like NEXT: SWARM · 12 CRAWLERS · 6 INFESTED WALKERS. From wave 3 a wave leans on one foe (swarm, armor, siege or shielded), sends ${pct(C.FLANK)} of its foes through one gate (flanking), or mixes.</li>
        <li>The gates open over the run in a seeded order: one for waves 1–${C.GATES_ONE}, two for ${C.GATES_ONE + 1}–${C.GATES_TWO}, then all. The preview says how many (1 OF 3 GATES), and only open gates glow.</li>
        <li>Each fork's lane weights are scaled by half to half again for the run. A map also names routes the Bloom can seal: one starts sealed, and after most waves it seals another or bursts one open, called out by name. The infested keep off a sealed route, and a seal never cuts a gate off from the reactor.</li>
      </ul>`,
  };
  const GRABS = {
    tdm: 'A blue mech trades fire with a red one across Foundry. The panel up top keeps the team score.',
    dm: 'Every pilot for themselves in Sump. The panel shows your place and points, the target, and the leader.',
    ma: "Silo A, held by red, launches its missile at the blue base. The panel shows each base's hull, and who holds A, B and C.",
    siege: "The red battleship crosses Riftline as the blue base guns open up on it. The panel shows each bank's energy, the AA, and the ship's hull.",
    ctf: 'A red mech runs the blue flag through Verdigris under fire. The panel shows each flag: home, taken or dropped.',
    convoy: 'The hauler walks across Span, its lights red for the side pushing it. The marker in the panel shows how far it has gone, and which way.',
    defense: "A wave climbs Hivewall's Stair along the red lane under tower fire. The panel shows the wave, the reactor's hull, your scrap and the foes left.",
  };
  return `
    <h1>MODES</h1>
    <p class="lede">A match runs ${SIM.MATCH_SECONDS / 60} minutes (a Co-op Defense run has no clock) and the next starts ${SIM.POST_MATCH_SECONDS} s after. Bots fill any empty seat, unless the game was opened without them. The team modes give each base two guns (see <a href="/guide/mechanics#base-guns">base guns</a>).</p>
    ${MODES.map(([id, name, fit]) => `<section class="card mode" id="${id}">
      ${figure(`mode-${id}`, GRABS[id])}
      <h3>${name.toUpperCase()}</h3><ul class="rules">${RULES[id].map((r) => `<li>${r}</li>`).join('')}</ul>${MORE[id] ?? ''}
      <h4>MAPS</h4>${where(fit)}</section>`).join('')}
    <h2>QUICK PLAY AND OPEN GAMES</h2>
    <p>Quick play puts you in the busiest listed game with a seat and enough time left, or opens one. Its games deal every versus mode on every map that plays it, like a shuffled deck: each pairing plays once before any repeats, never the same map twice running. Co-op Defense isn't in the deck: open a game of your own for it.</p>
    <p>From the home page you can also open a game of your own: one mode or every versus mode in turn, one map or the rotation, a score limit, and bots easy, normal, hard or none. Listed games show on the home page; unlisted ones are joined by code or invite link.</p>`;
}

const picture = (name, alt) => {
  const url = SHOTS[`../guide/shots/${name}.webp`];
  return url ? `<img src="${url}" alt="${alt}" loading="lazy">` : '<div class="wait">NO PICTURE YET</div>';
};
/** A screen grab from a live match (tools/capture.js) and what it shows; nothing if there's none yet. */
const figure = (name, caption) => (SHOTS[`../guide/shots/${name}.webp`] ? `<figure class="grab"><div class="shot">${picture(name, caption)}</div><figcaption>${caption}</figcaption></figure>` : '');
const modesOf = (m) => MODES.filter(([, , fit]) => fit(m));
async function mapList() {
  const maps = await loadMaps();
  return `
    <h1>MAPS</h1>
    <p class="lede">${maps.length} arenas, smallest first. Open one for its layout and the places worth knowing.</p>
    <div class="grid">${maps.map((m) => `<a class="card map" href="/guide/maps/${m.id}" id="${m.id}">
      <div class="shot">${picture(`${m.id}-hero`, m.name)}</div>
      <h3>${m.name.toUpperCase()}<span class="tag">${m.size[0]} M · ${m.night ? 'NIGHT' : 'DAY'}</span></h3>
      <p>${GUIDE_MAPS[m.id]?.blurb ?? ''}</p>
      <div class="chips">${modesOf(m).map(([, name]) => `<span>${name}</span>`).join('')}</div>
    </a>`).join('')}</div>`;
}
async function mapPage(id) {
  const maps = await loadMaps(), i = maps.findIndex((m) => m.id === id);
  if (i < 0) return mapList();
  const m = maps[i], g = GUIDE_MAPS[id] ?? {}, prev = maps[(i + maps.length - 1) % maps.length], next = maps[(i + 1) % maps.length];
  document.title = `${m.name} · MECHWAR guide`;
  return `
    <p class="crumbs"><a href="/guide/maps">MAPS</a> /</p>
    <h1>${m.name.toUpperCase()}</h1>
    <p class="lede">${m.size[0]} m across · ${m.night ? 'night' : 'day'}</p>
    <div class="shot wide">${picture(`${id}-hero`, m.name)}</div>
    <p>${g.blurb ?? ''}</p>
    <div class="chips">${modesOf(m).map(([mode, name]) => `<a href="/guide/modes#${mode}">${name}</a>`).join('')}</div>
    <h2>LAYOUT</h2>
    <div class="layout">
      <div class="plan">${picture(`${id}-plan`, `${m.name} from above`)}${marks(m)}</div>
      <div class="key"><span><i style="color:${TEAM[0]}">●</i> <i style="color:${TEAM[1]}">●</i> the two sides' bases and spawns</span><span><i>■</i> base guns</span><span><i>A B C</i> missile silos</span><span><i style="color:#5dff9a">EU</i> energy station</span><span><i style="color:#ffc46a">AA</i> anti-air</span><span><i style="color:#7fe0ff">⤳</i> jump pads</span><span><i>⚑</i> flag stands</span><span><i style="color:#ffd36a">┄ ●</i> Convoy route, and where the hauler starts</span><span><i style="color:#ff7a1a">━ ┄</i> Co-op lanes, dashed where too narrow for brutes and bosses</span><span><i style="color:#ff7a1a">G</i> co-op gates</span><span><i style="color:#66ccff">R</i> co-op reactor</span></div>
    </div>
    ${g.spots?.length ? `<h2>POINTS OF INTEREST</h2><div class="spots">${g.spots.map((s) => `<figure class="card" id="${s.id}">
      <div class="shot">${picture(`${id}-${s.id}`, s.name)}</div><figcaption><h3>${s.name}</h3><p>${s.text}</p></figcaption></figure>`).join('')}</div>` : ''}
    <p class="pager"><a href="/guide/maps/${prev.id}">← ${prev.name}</a><a href="/guide/maps/${next.id}">${next.name} →</a></p>`;
}
/** The marks over map `m`'s plan, in its own metres (x right, z down). */
function marks(m) {
  const o = m.objectives ?? {}, s = Math.max(...m.size) / 240, xz = (p) => `${p[0]},${p[2]}`;
  const out = [];
  // Convoy's route, under the rest, and where its hauler starts.
  if (o.convoy) out.push(`<polyline points="${o.convoy.points.map(xz).join(' ')}" fill="none" stroke="#ffd36a" stroke-width="${1.5 * s}" stroke-dasharray="${4 * s} ${3 * s}"/><circle cx="${o.convoy.points[o.convoy.start][0]}" cy="${o.convoy.points[o.convoy.start][2]}" r="${3 * s}" fill="#ffd36a" stroke="#000" stroke-width="${0.6 * s}"/>`);
  // Co-op Defense's lanes (those too narrow for brutes and bosses dashed), under the rest.
  const lanes = coop(m) ? o.defense?.lanes : null;
  if (lanes?.points?.length) {
    const path = (narrow) => lanes.edges.filter((_, k) => !!lanes.narrow?.includes(k) === narrow).map(([a, b]) => `M${xz(lanes.points[a])} L${xz(lanes.points[b])}`).join(' ');
    out.push(`<path d="${path(false)}" fill="none" stroke="#ff7a1a" stroke-width="${1.6 * s}" stroke-linecap="round"/><path d="${path(true)}" fill="none" stroke="#ff7a1a" stroke-width="${1.6 * s}" stroke-dasharray="${3 * s} ${2 * s}"/>`);
  }
  for (const pad of m.pads ?? []) out.push(`<path d="M${xz(pad.at)} L${xz(pad.to)}" stroke="#7fe0ff" stroke-width="${1.2 * s}" stroke-dasharray="${3 * s} ${2 * s}" fill="none"/><circle cx="${pad.at[0]}" cy="${pad.at[2]}" r="${2 * s}" fill="#7fe0ff"/>`);
  m.spawns?.forEach((team, t) => team.forEach((p) => out.push(`<circle cx="${p[0]}" cy="${p[2]}" r="${1.6 * s}" fill="${TEAM[t]}"/>`)));
  o.sentries?.forEach((team, t) => team.forEach((p) => out.push(`<rect x="${p[0] - 2.5 * s}" y="${p[2] - 2.5 * s}" width="${5 * s}" height="${5 * s}" fill="${TEAM[t]}" stroke="#000" stroke-width="${0.6 * s}"/>`)));
  // Zones, each mode's (Co-op Defense's are its gates and reactor): where two share a spot (Foundry's
  // middle is silo B, the energy station and the AA), their labels stack.
  const zones = [...(o.silos ?? []).map((z, i) => [z, '#ffffff', 'ABC'[i]]), ...(o.stations ?? []).map((z) => [z, '#5dff9a', 'EU']), ...(o.aa ? [[o.aa, '#ffc46a', 'AA']] : []),
    ...(coop(m) && o.defense ? [...o.defense.gates.map((g) => [{ at: g, radius: 7 }, '#ff7a1a', 'G']), [{ at: o.defense.reactor, radius: o.defense.radius }, '#66ccff', 'R']] : [])];
  const labels = new Map();
  for (const [z, color, label] of zones) {
    out.push(`<circle cx="${z.at[0]}" cy="${z.at[2]}" r="${z.radius}" fill="${color}22" stroke="${color}" stroke-width="${s}"/>`);
    const spot = `${Math.round(z.at[0])},${Math.round(z.at[2])}`;
    labels.set(spot, [...(labels.get(spot) ?? []), [z.at, color, label]]);
  }
  for (const stack of labels.values()) stack.forEach(([at, color, label], i) => out.push(`<text x="${at[0]}" y="${at[2] + (i - (stack.length - 1) / 2) * 10 * s}" fill="${color}" stroke-width="${2.5 * s}">${label}</text>`));
  o.flags?.forEach((f, t) => out.push(`<text x="${f.at[0]}" y="${f.at[2]}" fill="${TEAM[t]}" stroke-width="${2.5 * s}" font-size="${12 * s}">⚑</text>`));
  o.bases?.forEach((p, t) => out.push(`<circle cx="${p[0]}" cy="${p[2]}" r="${6 * s}" fill="${TEAM[t]}" stroke="#000" stroke-width="${s}"/>`));
  const half = Math.max(...m.size) / 2;
  return `<svg viewBox="${-half} ${-half} ${2 * half} ${2 * half}" aria-hidden="true"><g font-size="${9 * s}" stroke-linejoin="round">${out.join('')}</g></svg>`;
}
function mechanics() {
  const heavy = (name) => (cv('C', name) !== T(name) ? ` (Heavy ${cv('C', name)})` : '');
  const lockout = (key) => Math.round(T('heat_decay_delay') + (cv(key, 'heat_max') - T('overheat_release')) / T('overheat_decay'));
  const hellfire = stat(byId.hornet), prices = Object.values(weapons).flat().map((w) => w.unlock).filter((n) => n > 0);
  const xp = [
    ['Downing a pilot', `${SIM.KILL_XP}, shared by the damage each pilot did in the last ${SIM.ASSIST_WINDOW} s; the one who downs them gets ${SIM.KILL_XP * SIM.KILLER_BONUS} more`],
    ['Downing a bot', `${SIM.BOT_KILL_XP}, shared the same way`],
    ['Healing teammates', `${SIM.HEAL_XP} per hp`],
    ['Taking a silo, the AA, or a flag off its stand, or capturing one', `${SIM.CAPTURE_XP}`],
    ['Escorting the Convoy hauler', `${SIM.ESCORT_XP} a second`],
    ['Banking energy (Siege)', `${SIM.EU_XP} per EU`],
    ['Shooting the enemy ship', `${SIM.SHIP_XP} per point of hull`],
    ['Finishing a match', `${SIM.MATCH_XP}, and ${SIM.WIN_XP} more for a win`],
  ];
  return `
    <h1>MECHANICS</h1>
    <p class="lede">The rules under every fight. Where the classes differ, the Medium's number comes first; the <a href="/guide/mechs">mechs</a> page has each class's.</p>

    <h2 id="movement">MOVEMENT</h2>
    ${figure('mech-movement', 'A mech hovers off the deck on its jets.')}
    <p>WASD walks, at ${T('walk_speed')} m/s on a Medium. One fuel tank of ${T('fuel_max')} feeds everything faster:</p>
    <ul>
      <li><b>Boost</b> (Shift+W) runs at ${T('boost_speed')} m/s, forward only, burning ${T('boost_drain')} fuel a second.</li>
      <li><b>Hover</b> (Space) lifts you about 3.5 m, enough to hop a 3 m ledge, and holds you up sinking slowly, burning ${T('hover_drain')} a second.</li>
      <li><b>Dash</b> (Shift+A or D) throws you sideways at ${T('dodge_speed')} m/s for ${T('dodge_fuel_cost')} fuel, again after ${T('dodge_cooldown')} s (Light ${cv('A', 'dodge_cooldown')} s, Heavy ${cv('C', 'dodge_cooldown')} s). A dash can shake off homing rockets.</li>
      <li><b>Turn about</b> (Shift+S) swings you round to face behind.</li>
    </ul>
    <p>Fuel refills at ${T('fuel_regen')} a second once you've spent none for ${T('fuel_regen_delay')} s. Jump pads throw you along a set arc: you can't steer or boost on it, but a dash or hover breaks out. There's no fall damage. Mechs block each other, and the heavier one shoves the lighter aside; a hovering mech passes over.</p>

    <h2 id="heat">HEAT</h2>
    ${figure('mech-heat', 'Running hot, from the cockpit: heat fills the arcs round the sight in red, and the barrel glows. One more burst and the guns lock.')}
    <p>Your primary and secondary share one heat meter of ${T('heat_max')}${heavy('heat_max')}. Every shot adds to it (each primary's card shows its heat a second; a secondary's use says when it runs hot). It starts draining ${T('heat_decay_delay')} s after your last shot, fastest when you're cool (${T('heat_decay') * T('heat_decay_cool')} a second) and slowest near the top (${T('heat_decay')}).</p>
    <p>Fill it and you overheat: your guns lock while heat drains at ${T('overheat_decay')} a second, until it's down to ${T('overheat_release')}, about ${lockout('B')} s from full (${lockout('C')} s on a Heavy). Fire in bursts to stay under it. The ${link('furnace')} and ${link('piston')} still fire overheated, and the Medium's ${link('vent')} dumps all your heat at once.</p>

    <h2 id="damage">DAMAGE AND HEALTH</h2>
    <ul>
      <li>Guns firing rounds hit full strength out to a set range, then fade steadily to a floor further out; each one's card gives its FALLOFF. Rockets, grenades and slugs hit full wherever they land.</li>
      <li>Blasts hit full at their center, fading to ${SIM.EDGE_DAMAGE * 100}% at the edge of their radius, measured to the mech's hull. Walls stop them, so a blast beside cover can miss what's behind it.</li>
      <li>No friendly fire, and your own blasts don't hurt you. A hit anywhere on a mech counts the same.</li>
      <li>Health doesn't come back on its own: repair, health orbs, the ${link('orb')} and the ${link('mender')} are the only ways.</li>
    </ul>

    <h2 id="repair">REPAIR</h2>
    ${figure('mech-repair', 'A mech shut down to repair, crouched low under its repair light.')}
    <p>Hold R to shut down and repair: after ${T('repair_windup')} s you heal ${T('repair_rate')} hp a second until you're full, you let go, or anything hits you, then take ${T('repair_standup')} s to stand back up. Shut down, you crouch lower and can look about, but can't move, fire or use items. Find cover first.</p>

    <h2 id="orbs">HEALTH ORBS</h2>
    ${figure('mech-orbs', 'The health orb a downed mech leaves behind.')}
    <p>Every downed mech leaves an orb holding ${SIM.ORB_HEALTH} hp for anyone, on either side, within ${SIM.ORB_RADIUS} m of it, healing ${SIM.ORB_RATE} hp a second, until it's dry or ${SIM.ORB_SECONDS} s pass. The ${link('orb')} drops one only your side can use.</p>

    <h2 id="respawn">RESPAWN</h2>
    <p>Downed, you're back in the hangar, and can launch again after ${T('respawn_delay')} s; you spawn at your team's spawn farthest from the nearest enemy. A fresh launch is shielded for ${T('spawn_shield')} s: no damage, no EMP, and turrets and base guns ignore you, until you move or fire.</p>

    <h2 id="lock-on">LOCK-ONS AND COUNTERS</h2>
    ${figure('mech-lock-on', 'A Hellfire lock from the cockpit: the diamond turns white and says LOCKED, the card under the crosshair names the target\'s class and weapons, and the time the lock has left counts down below.')}
    <ul>
      <li>The ${link('hornet')} locks on: press MMB with an enemy within ${hellfire('alt_lock_cone')}° of your crosshair and about ${Math.round(hellfire('alt_speed') * hellfire('alt_fuse') / 10) * 10} m, and keep it there ${hellfire('alt_lock_time')} s. The lock then holds ${hellfire('alt_lock_hold')} s wherever you look. Turrets, battleships, base guns and the Convoy hauler can all be locked.</li>
      <li>The ${link('talon')} doesn't lock: its rockets turn toward the enemy nearest your crosshair, within ${stat(byId.talon)('shot_seek_cone')}°, while you keep it there.</li>
      <li>${link('cloak')} breaks locks on you and hides your tag and radar contact; turrets and bots can't see you either.</li>
      <li>A ${link('smoke')} cloud blinds turrets, base guns and bots, and no pilot sees into or through it, though a Hellfire can still lock on through it.</li>
      <li>The ${link('emp')} drains ${T('emp_drain')} fuel from enemies within ${T('emp_radius')} m and stops them boosting for ${T('emp_jam')} s; walls block it, and dash and hover still work.</li>
    </ul>

    <h2 id="base-guns">BASE GUNS</h2>
    ${figure('mech-base-guns', 'A blue base gun fires on a red mech sheltering under its shield dome.')}
    <p>In the team modes each base has two guns, there to cover the spawns rather than hold the base. They open up ${SIM.SENTRY_ACQUIRE} s after an enemy mech shows within ${SIM.SENTRY_RANGE} m, in ${SIM.SENTRY_BURST}-round bursts of ${SIM.SENTRY_ROUND} damage a round, and in Siege fire on an enemy ship within ${SIM.SENTRY_SHIP_RANGE} m. They can't see through walls, smoke or shield domes, or spot a shielded or camouflaged mech.</p>
    <p>Each has a ${SIM.SENTRY_SHIELD} shield that doesn't regenerate. Shoot it through and the gun goes offline for ${SIM.SENTRY_OFFLINE} s, then comes back full and can't be hurt for ${SIM.SENTRY_IMMUNE} s: a window to push a base, or to get a flag out.</p>

    <h2 id="deployables">TURRETS, DOMES AND BARRIERS</h2>
    ${figure('mech-deployables', 'A red shield dome. No shot crosses it but a rail slug; mechs walk straight through.')}
    <p>You can have one of each out at a time; setting down another takes the first away. Each has hull you can shoot off (its card says how much), and the ${link('spindle')}'s slug punches straight through domes and barriers.</p>

    <h2 id="progression">PROGRESSION</h2>
    <p>Matches earn XP:</p>
    <table><tbody>${xp.map(([what, much]) => `<tr><td>${what}</td><td>${much}</td></tr>`).join('')}</tbody></table>
    <p>Level 2 takes ${levelXp(2).toLocaleString('en')} XP, level 3 ${levelXp(3).toLocaleString('en')}, level 5 ${levelXp(5).toLocaleString('en')} and level 10 ${levelXp(10).toLocaleString('en')}, up to level ${SIM.MAX_LEVEL}. Each level past the first brings ${POINTS_PER_LEVEL} unlock points; spend them in the hangar, where a weapon, item or ability costs ${Math.min(...prices)} to ${Math.max(...prices)} points for one mech.</p>
    <p>Your record lives in this browser, signed by the server so it can't be edited. To carry it to another, export it from the settings (the gear) on the home page and import it there.</p>`;
}

// --- The page ----------------------------------------------------------------

const SECTIONS = [
  ['', 'OVERVIEW', overview],
  ['mechs', 'MECHS', mechs, turnMechs],
  ['weapons', 'WEAPONS', weaponsSection, drawWeapons],
  ['items', 'ITEMS', itemsSection],
  ['modes', 'MODES', modes],
  ['maps', 'MAPS', (map) => (map ? mapPage(map) : mapList())],
  ['mechanics', 'MECHANICS', mechanics],
];
// /guide/<section>[/<page>]: a map has a page of its own.
const [path, page] = location.pathname.replace(/^\/guide\/?/, '').replace(/\/$/, '').split('/');
const [here, title, draw, after] = SECTIONS.find(([p]) => p === path) ?? SECTIONS[0];
// The nav's links are in the page itself (guide/index.html), for search engines to follow: mark this one's.
const on = document.querySelector(`#nav a[href="/guide/${here}"]`);
on.className = 'on';
on.setAttribute('aria-current', 'page');
document.title = here ? `${title[0]}${title.slice(1).toLowerCase()} · MECHWAR guide` : 'Guide · MECHWAR';
// One address per page for search engines, whatever host, slash or hash it was reached by.
document.head.insertAdjacentHTML('beforeend', `<link rel="canonical" href="https://mechwar.online/guide/${[here, page].filter(Boolean).join('/')}">`);
$('page').innerHTML = await draw(page);
// The section's own target (a weapon, a map, a heading), marked and scrolled to once it's drawn.
const mark = () => {
  document.querySelector('.hit')?.classList.remove('hit');
  let target = null;
  try { target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; } catch { /* a malformed hash */ }
  target?.classList.add('hit');
  target?.scrollIntoView();
};
mark();
addEventListener('hashchange', mark);
after?.();
