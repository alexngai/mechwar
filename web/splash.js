// The splash on joining a game and at each new match: the map's picture (its hero shot, rendered
// ahead of time by tools/shoot.html for the guide), its name and blurb, and the mode with how it's
// won. It fades after a few seconds, or at the first click or key.
import GUIDE_MAPS from '../guide/maps.json';

const SHOTS = import.meta.glob('../guide/shots/*-hero.webp', { eager: true, query: '?url', import: 'default' });
const SECONDS = 7;
// Each mode by its name (the sim's Mode::name) in brief: what it is, then how it's played and won,
// for `goal`, the match's score limit as the top panel counts it. The guide's MODES has the rules.
const MODES = {
  'Team Deathmatch': (goal) => ['Two teams of four. Every enemy your team downs is a point.', [
    `First team to ${goal} kills wins; at time, the higher score.`,
    'Each base has two guns: keep clear of theirs.',
  ]],
  Deathmatch: (goal) => ['Every pilot for themselves.', [
    'A kill is shared by everyone who damaged the target, with a bonus for whoever lands it.',
    `First to ${goal.toLocaleString('en')} points wins; at time, the most points.`,
  ]],
  'Missile Assault': () => ['Three missile silos, A, B and C, stand between the two bases.', [
    'Stand in a silo’s zone to take it, faster with teammates in it.',
    'Every silo your team holds fires missiles at the enemy base.',
    'Knock their base down to win; at time, more hull left wins.',
  ]],
  Siege: () => ['Only a battleship can hurt a base. Build yours and fly it into theirs.', [
    'Draw energy at the station mid-map and carry it home to bank it.',
    'A full bank launches your battleship at the enemy base.',
    'Hold the AA gun to shoot down their ship. Destroy their base to win.',
  ]],
  'Capture the Flag': () => ['Take the enemy flag from their base to yours.', [
    'Stand at their flag stand to take it; a defender there holds you off.',
    'The carrier can’t boost or dash. Run it into your own stand’s zone to capture.',
    'First to three captures wins.',
  ]],
  Convoy: () => ['A hauler waits mid-route between the two bases.', [
    'Outnumber the enemy near it to walk it toward their base: the bigger your lead, the faster.',
    'Shoot through its shield to stall it.',
    'Walk it into their base to win; at time, whoever pushed it further.',
  ]],
  Practice: () => ['On your own, every weapon unlocked.', [
    'Learn the map and try out loadouts. Esc shows the controls.',
  ]],
};

const el = document.getElementById('splash');
let timer = 0;
function close() {
  clearTimeout(timer);
  el.classList.add('out');
  timer = setTimeout(() => (el.hidden = true), 500);
}
el.addEventListener('click', close);
addEventListener('keydown', () => { if (!el.hidden) close(); });

/** Shows map `id` (`name` to players) and mode `mode` (its name), first to `goal`. */
export function splash(id, name, mode, goal) {
  const [lede, rules] = MODES[mode]?.(goal) ?? ['', []];
  const shot = SHOTS[`../guide/shots/${id}-hero.webp`];
  el.innerHTML = `${shot ? `<img src="${shot}" alt="">` : ''}
    <div class="info">
      <small>${mode.toUpperCase()}</small>
      <h1>${name.toUpperCase()}</h1>
      <p class="blurb">${GUIDE_MAPS[id]?.blurb ?? ''}</p>
      <div class="mode"><p>${lede}</p><ul>${rules.map((r) => `<li>${r}</li>`).join('')}</ul></div>
    </div>
    <div class="go">CLICK OR PRESS ANY KEY<i style="animation-duration: ${SECONDS}s"></i></div>`;
  clearTimeout(timer);
  el.classList.remove('out');
  el.hidden = false;
  timer = setTimeout(close, SECONDS * 1000);
}
