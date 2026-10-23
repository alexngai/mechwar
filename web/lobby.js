// The landing page: quick play, the public games, opening a game (public or private) and joining
// one by code. Rooms live on the server (`/api/...`, see server/src/main.rs); picking one loads
// the game for it at `/?room=CODE`. The 3D game itself never loads here, only the hangar
// backdrop behind the page (backdrop.js). It also shows the pilot's progression record (see
// progress.js), and moves it between browsers as text.
import weapons from '../weapons.json';
import classes from '../classes.json';
import { STORE, fits, levelXp, pointsLeft, readRecord } from './progress.js';

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const go = (code) => { location.href = `/?room=${encodeURIComponent(code)}`; };

// The footer's tip jar (a Buy Me a Coffee page); the link shows once this is set.
const COFFEE = '';
// A gear: four bars crossed over a disc, with a hole through the middle.
const GEAR = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="currentColor"><circle cx="12" cy="12" r="7"/>${
  [0, 45, 90, 135].map((a) => `<rect x="10" y="1.5" width="4" height="21" rx="1" transform="rotate(${a} 12 12)"/>`).join('')
}</g><circle cx="12" cy="12" r="3.2" fill="#0d1014"/></svg>`;

document.body.classList.add('lobby');
const lobby = $('lobby');
lobby.hidden = false;
// The hangar behind it all, once three.js has loaded.
import('./backdrop.js').then(({ backdrop }) => backdrop());
lobby.innerHTML = `
  <button id="settings" title="Settings" aria-label="Settings" aria-expanded="false">${GEAR}</button>
  <div id="settings-panel" hidden>
    <h3>PILOT RECORD</h3>
    <div class="row"><button id="export">EXPORT</button><button id="import">IMPORT</button></div>
    <div class="row" id="import-row" hidden><input id="import-text" placeholder="Paste an exported pilot record" autocomplete="off" spellcheck="false"><button id="import-go">LOAD</button></div>
    <p class="hint">Your progress lives in this browser. Export it to carry it to another.</p>
  </div>
  <div class="hero">
    <h1>MECHWAR</h1>
    <label class="row">CALLSIGN <input id="lobby-callsign" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Pilot"></label>
    <button id="quick">QUICK PLAY</button>
    <div id="lobby-note"></div>
  </div>
  <section>
    <h3>PILOT</h3>
    <div id="pilot"></div>
  </section>
  <section>
    <h3>GAMES</h3>
    <table id="games"></table>
  </section>
  <section>
    <h3>OPEN A GAME</h3>
    <div class="row">
      <input id="new-name" maxlength="24" placeholder="Name" autocomplete="off">
      <select id="new-map"><option value="">Map rotation</option></select>
      <select id="new-score"><option value="10">First to 10</option><option value="25" selected>First to 25</option><option value="50">First to 50</option></select>
      <select id="new-skill"><option value="easy">Easy bots</option><option value="normal" selected>Normal bots</option><option value="hard">Hard bots</option><option value="">No bots</option></select>
      <label><input type="checkbox" id="new-public"> LISTED</label>
      <button id="create">OPEN</button>
    </div>
    <p class="hint">Unlisted games are joined by code or invite link only.</p>
  </section>
  <section>
    <h3>JOIN BY CODE</h3>
    <div class="row"><input id="code" maxlength="4" placeholder="ABCD" autocomplete="off" spellcheck="false"><button id="join">JOIN</button></div>
  </section>
  <a href="/?offline">Practice offline</a>
  <footer>© 2026 Alex Ngai · <a href="https://github.com/alexngai" target="_blank" rel="noopener">GitHub</a>${
    COFFEE ? ` · <a href="${COFFEE}" target="_blank" rel="noopener">Buy me a coffee</a>` : ''
  }</footer>`;

const note = (text) => { $('lobby-note').textContent = text; };
const gone = new URLSearchParams(location.search).get('gone');
if (gone) note(`Game ${gone} has closed.`);

// Callsign: the same one the game uses (main.js sends it on joining).
const callsign = $('lobby-callsign');
callsign.value = stored('mechwar.name') ?? '';
const saveCallsign = () => { try { localStorage.setItem('mechwar.name', callsign.value.trim()); } catch { /* private mode */ } };
callsign.addEventListener('input', saveCallsign);

// The pilot: level, XP toward the next, and lifetime stats from the stored record.
const weaponNames = Object.fromEntries(Object.values(weapons).flat().map((w) => [w.id, w.name]));
// Everything that fits a mech but its own two weapons, two items and ability.
const unlockable = (key) => Object.values(weapons).flat().filter((w) => fits(key, w)).length - 5;
function showPilot() {
  const r = readRecord(stored(STORE) ?? '');
  if (!r) {
    $('pilot').innerHTML = '<p class="hint">No record yet: play a match and one starts here.</p>';
    return;
  }
  const s = r.stats;
  const [from, to] = [levelXp(r.level), levelXp(r.level + 1)];
  const weaponsUsed = Object.entries(s.weapon_kills).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([id, n]) => `${esc(weaponNames[id] ?? id)} ${n}`).join(' · ') || '–';
  const stat = (name, value) => `<div><dt>${name}</dt><dd>${value}</dd></div>`;
  $('pilot').innerHTML = `
    <div class="level">LEVEL ${r.level} · ${r.xp} XP</div>
    <div class="bar"><div style="width: ${r.level < 99 ? (100 * (r.xp - from)) / (to - from) : 100}%"></div></div>
    <dl>${stat('MATCHES', `${s.matches} · ${s.wins} won`)}${stat('PILOTS DOWNED', s.kills)}${stat('DEATHS', s.deaths)}
      ${stat('ASSISTS', s.assists)}${stat('BOTS DOWNED', `${s.bot_kills} · ${s.bot_assists} assists`)}${stat('HEALING', s.healing)}
      ${stat('UNLOCK POINTS', pointsLeft(r))}${stat('UNLOCKED', ['A', 'B', 'C'].map((k) => `${classes[k].name} ${r.unlocks?.[k]?.length ?? 0}/${unlockable(k)}`).join(' · '))}
      ${stat('TOP WEAPONS', weaponsUsed)}</dl>`;
}
showPilot();

// Settings, behind the gear: moving the pilot record between browsers.
const settings = $('settings'), panel = $('settings-panel');
const showSettings = (open) => {
  panel.hidden = !open;
  settings.setAttribute('aria-expanded', String(open));
};
settings.addEventListener('click', () => showSettings(panel.hidden));
addEventListener('keydown', (e) => { if (e.key === 'Escape') showSettings(false); });

$('export').addEventListener('click', async () => {
  const token = stored(STORE);
  if (!token) return note('Nothing to export yet.');
  try {
    await navigator.clipboard.writeText(token);
    note('Pilot record copied: paste it into Import in another browser.');
  } catch {
    $('import-row').hidden = false;
    $('import-text').value = token;
    $('import-text').select();
    note('Copy the record from the box.');
  }
});
$('import').addEventListener('click', () => { $('import-row').hidden = false; $('import-text').focus(); });
$('import-go').addEventListener('click', async () => {
  const token = $('import-text').value.trim();
  if (!token) return;
  const res = await fetch('/api/progress', { method: 'POST', body: token }).catch(() => null);
  if (!res?.ok) return note("That isn't a pilot record this server signed.");
  const record = await res.json();
  const mine = readRecord(stored(STORE) ?? '');
  if (mine && mine.id !== record.id && !confirm(`Replace your level ${mine.level} pilot with this level ${record.level} one?`)) return;
  try { localStorage.setItem(STORE, token); } catch { return note("This browser won't store it (private mode?)."); }
  if (record.callsign) {
    callsign.value = record.callsign;
    saveCallsign();
  }
  $('import-row').hidden = true;
  $('import-text').value = '';
  note(`Welcome back, ${record.callsign || 'pilot'}.`);
  showPilot();
});

/** `fetch` for the room API: the JSON answer, or throws with the server's reason. */
async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.text()) || `${res.status}`);
  return res.json();
}

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
let mapsShown = false;
async function refresh() {
  let lobbyState;
  try { lobbyState = await api('/api/rooms'); } catch { return; }
  if (!mapsShown) {
    mapsShown = true;
    $('new-map').insertAdjacentHTML('beforeend', lobbyState.maps.map((m) => `<option value="${esc(m)}">${esc(m[0].toUpperCase() + m.slice(1))}</option>`).join(''));
  }
  $('games').innerHTML = lobbyState.rooms.length
    ? lobbyState.rooms.map((r) => `<tr>
        <td>${esc(r.name)}</td><td>${esc(r.map)}</td>
        <td>${r.humans}/${r.capacity} pilots${r.bots ? ` · ${r.bots} bots` : ''}</td>
        <td>${r.ended ? 'between matches' : `${clock(r.seconds_left)} left · ${r.scores[0]}–${r.scores[1]}`}</td>
        <td><button data-code="${esc(r.code)}">JOIN</button></td></tr>`).join('')
    : '<tr><td>No listed games right now: quick play opens one.</td></tr>';
}
$('games').addEventListener('click', (e) => { const code = e.target.closest('button')?.dataset.code; if (code) go(code); });
refresh();
setInterval(refresh, 3000);

$('quick').addEventListener('click', async () => {
  try { go((await api('/api/quick', {})).code); } catch (e) { note(`Couldn't find a game: ${e.message}`); }
});
$('create').addEventListener('click', async () => {
  const skill = $('new-skill').value;
  const settings = {
    name: $('new-name').value.trim() || undefined,
    public: $('new-public').checked,
    map: $('new-map').value || undefined,
    score_limit: Number($('new-score').value),
    bots: skill !== '',
    bot_skill: skill || undefined,
  };
  try { go((await api('/api/rooms', settings)).code); } catch (e) { note(`Couldn't open the game: ${e.message}`); }
});
const join = async () => {
  const code = $('code').value.trim().toUpperCase();
  if (!code) return;
  try { go((await api(`/api/rooms/${encodeURIComponent(code)}`)).code); } catch { note(`No game with code ${code}.`); }
};
$('join').addEventListener('click', join);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
