// The page's entry: the lobby for a production page with nothing to join, else the game. In a
// room, the hangar shows its code, a link to invite others, and the way back to the lobby; a room
// that has closed sends the page back to the lobby, saying so.
// The game was called webhawk: carry its saved settings, loadouts and pilot over to the new names.
try {
  for (const key of Object.keys(localStorage).filter((k) => k.startsWith('webhawk.'))) {
    const renamed = `mechwar.${key.slice('webhawk.'.length)}`;
    if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch { /* private mode: nothing saved to move */ }

const params = new URLSearchParams(location.search);
const room = params.get('room')?.toUpperCase();
const playing = room || ['offline', 'server'].some((p) => params.has(p));

if (import.meta.env.PROD && !playing) {
  await import('./lobby.js');
} else {
  if (room) {
    const found = await fetch(`/api/rooms/${encodeURIComponent(room)}`).catch(() => null);
    if (found?.status === 404) location.replace(`/?gone=${encodeURIComponent(room)}`);
    const row = document.getElementById('room-row');
    row.hidden = false;
    document.getElementById('room-code').textContent = room;
    const invite = document.getElementById('invite');
    invite.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`${location.origin}/?room=${room}`);
        invite.textContent = 'COPIED';
      } catch {
        invite.textContent = `${location.origin}/?room=${room}`;
      }
      setTimeout(() => (invite.textContent = 'COPY INVITE LINK'), 2000);
    });
  }
  await import('./main.js');
}
