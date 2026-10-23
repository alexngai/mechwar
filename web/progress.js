// A pilot's progression record, as the server signs it (see server/src/main.rs): `payload.tag`,
// the payload base64url JSON. The page keeps it in localStorage, sends it back on joining, and
// reads it only to show it: the server alone can vouch for it.
export const STORE = 'webhawk.progress';

/** The record a token holds, or null. */
export function readRecord(token) {
  try {
    const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** Total XP level `n` starts at; matches level_xp in sim/src/progress.rs. */
export const levelXp = (n) => 250 * n * (n - 1);

/** The level `xp` reaches (at most 99). */
export function levelAt(xp) {
  let n = 1;
  while (n < 99 && levelXp(n + 1) <= xp) n++;
  return n;
}
