// A pilot's progression record, as the server signs it (see server/src/main.rs): `payload.tag`,
// the payload base64url JSON. The page keeps it in localStorage, sends it back on joining, and
// reads it only to show it: the server alone can vouch for it.
import weapons from '../weapons.json';
import classes from '../classes.json';
export const STORE = 'mechwar.progress';

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

// Unlocks, as Record in sim/src/progress.rs has them: each mech carries its own two weapons and
// two items (classes.json's `weapons`) and starts with a few more (its `unlocked`), and each level
// past the first earns points that unlock the rest for one mech at a time, at weapons.json's
// `unlock` price.
export const POINTS_PER_LEVEL = 3;
const priceOf = (id) => Object.values(weapons).flat().find((w) => w.id === id)?.unlock ?? 0;
const startsUnlocked = (key, id) => classes[key]?.unlocked?.includes(id) ?? false;

/** Unlock points `record` has left. Unlocks a mech now starts with are free. */
export const pointsLeft = (record) =>
  Math.max(0, POINTS_PER_LEVEL * (record.level - 1) - Object.entries(record.unlocks ?? {}).flatMap(([key, ids]) => ids.filter((id) => !startsUnlocked(key, id))).reduce((sum, id) => sum + priceOf(id), 0));

/** Whether mech `key` (`A`, `B`, `C`) may carry weapons.json entry `w` at all: one listing `classes` fits only those. */
export const fits = (key, w) => !w.classes || w.classes.includes(key);

/** Whether mech `key` (`A`, `B`, `C`) may carry weapon, item or ability `id` under `record` (null: its own only). */
export const owns = (record, key, id) => Object.values(classes[key].weapons).includes(id) || startsUnlocked(key, id) || (record?.unlocks?.[key] ?? []).includes(id);
