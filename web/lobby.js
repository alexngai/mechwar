// The landing page: quick play, the public games, opening a game (public or private) and joining
// one by code. Rooms live on the server (`/api/...`, see server/src/main.rs); picking one loads
// the game for it at `/?room=CODE`. The 3D game itself never loads here.
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const go = (code) => { location.href = `/?room=${encodeURIComponent(code)}`; };

document.body.classList.add('lobby');
const lobby = $('lobby');
lobby.hidden = false;
lobby.innerHTML = `
  <h1>WEBHAWK</h1>
  <label class="row">CALLSIGN <input id="lobby-callsign" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Pilot"></label>
  <button id="quick">QUICK PLAY</button>
  <div id="lobby-note"></div>
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
  <a href="/?offline">Practice offline</a>`;

const note = (text) => { $('lobby-note').textContent = text; };
const gone = new URLSearchParams(location.search).get('gone');
if (gone) note(`Game ${gone} has closed.`);

// Callsign: the same one the game uses (main.js sends it on joining).
const callsign = $('lobby-callsign');
callsign.value = stored('webhawk.name') ?? '';
callsign.addEventListener('input', () => { try { localStorage.setItem('webhawk.name', callsign.value.trim()); } catch { /* private mode */ } });

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
