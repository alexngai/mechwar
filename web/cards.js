// What the hangar's cards and the guide's say about a weapon, item or ability: its few numbers,
// read through a lookup `v(name)` of its value as carried (weapons.json stats over the class's,
// over tuning.json), and a glyph for those with no model to draw.
import tuning from '../tuning.json';

/** Damage a second from `v`'s primary, sustained at full spin or charge, before falloff and heat. */
const dps = (v) => {
  const hit = v('shot_damage') * v('pellets') * (v('charge_time') > 0 ? v('charge_damage') : 1);
  return Math.round((hit * v('burst')) / (1 / v('fire_rate') + v('charge_time')));
};
/** Stat bars per weapons.json list: label, value from a lookup `v`, unit. */
export const STATS = {
  primaries: [
    ['Damage/s', (v) => dps(v), ''],
    // A gun's: where its rounds have faded to their floor. A launcher's: how far its shot flies before it bursts.
    ['Range', (v) => (v('shot_speed') > 0 ? (v('shot_fuse') > 0 ? v('shot_speed') * v('shot_fuse') : v('weapon_range')) : Math.min(v('weapon_range'), v('falloff_end'))), ' m'],
    ['Heat/s', (v) => (v('heat_per_shot') * v('burst')) / (1 / v('fire_rate') + v('charge_time')), ''],
  ],
  secondaries: [
    ['Damage', (v) => (v('alt_beam') > 0 ? v('alt_damage') : v('alt_damage') * Math.max(v('alt_count'), 1) + v('alt_split') * v('alt_split_damage')), ''],
    ['Blast', (v) => (v('alt_beam') > 0 ? 0 : v('alt_radius')), ' m'],
    ['Cooldown', (v) => v('alt_cooldown'), ' s'],
  ],
};
export const shown = (x) => (x < 10 ? x.toFixed(1).replace(/\.0$/, '') : Math.round(x));
// Items and abilities have no model to draw: a glyph each instead.
export const GLYPHS = {
  grenade: '●', limpet: '◎', smoke: '▒', mg_turret: '┳', rocket_turret: '▲', emp: '◇', orb: '⊕', dome: '◠', barrier: '▌',
  slipstream: '»', vent: '≋', brace: '▣', cloak: '◌', power: '◆', barrage: '∴', artillery: '⊙',
};
/** The few numbers on the card of `list`'s entry `id`, read through `v`. */
export const facts = (list, id, v) => {
  const has = (name) => name in tuning;
  if (STATS[list]) return STATS[list].map(([label, f, unit]) => [f(v), unit, label]).filter(([x]) => x > 0).map(([x, unit, label]) => `${shown(x)}${unit} ${label.toLowerCase()}`).join(' · ');
  if (has(`${id}_charges`)) return `${v(`${id}_charges`)} ${v(`${id}_charges`) === 1 ? 'charge' : 'charges'} · ${v(`${id}_recharge`)} s recharge`;
  return [has(`${id}_duration`) && `${v(`${id}_duration`)} s on`, has(`${id}_cooldown`) && `${v(`${id}_cooldown`)} s cooldown`].filter(Boolean).join(' · ');
};
