// The Esc menu's controls card: every key the game uses on a keyboard map, colored by what it's
// for, a mouse whose buttons say what the carried loadout does with them (its weapons.json `use`
// steps on each button), and the same bindings listed by group.

const GROUPS = [
  ['move', 'MOVE', '#7fe0ff'],
  ['fight', 'FIGHT', '#ff8a5c'],
  ['kit', 'KIT', '#9be37a'],
  ['game', 'GAME', '#c3cad2'],
];
// Key caps by row, each [label, width in key units]; a row's leading number is its indent.
const ROWS = [
  [0, ['Esc', 1.25]],
  [0, ['Tab', 1.5], 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  [0, ['Caps', 1.75], 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  [0, ['Shift', 2.25], 'Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  [3, ['Space', 6]],
];
const UNIT = 28; // px per key unit

/** The bindings: keys (a chord with `+`), group, and what they do; the mouse's come from `loadout`. */
function bindings({ primary, secondary, offensive, support, ability }, offline) {
  // A weapon's first step on `key`, else `fallback`.
  const step = (w, key, fallback) => w.use?.find(([k]) => k === key)?.[1] ?? fallback;
  return [
    [['W', 'A', 'S', 'D'], 'move', 'Walk'],
    [['Shift', '+', 'W'], 'move', 'Boost (burns fuel)'],
    [['Shift', '+', 'A', '/', 'D'], 'move', 'Dash sideways'],
    [['Shift', '+', 'S'], 'move', 'Turn about'],
    [['Space'], 'move', 'Hover (burns fuel)'],
    [['LMB'], 'fight', `${primary.name}: ${step(primary, 'LMB', 'fire')}`],
    [['RMB'], 'fight', `${secondary.name}: ${step(secondary, 'RMB', 'fire')}`],
    [['MMB'], 'fight', step(secondary, 'MMB', `Nothing for the ${secondary.name}`)],
    [['Q'], 'kit', `${offensive.name}: ${step(offensive, 'Q', offensive.desc)}`],
    [['E'], 'kit', `${support.name}: ${step(support, 'E', support.desc)}`],
    [['F'], 'kit', `${ability.name}: ${ability.desc}`],
    [['R'], 'kit', 'Hold to shut down and repair'],
    [['Z'], 'game', 'Ping the enemy you aim at, or a spot to send bots to'],
    [['X'], 'game', 'Enemy sighted: mark where you aim for your team'],
    [['Tab'], 'game', 'Scores, while held'],
    [['C'], 'game', 'Hangar: change your build for the next launch'],
    [['M'], 'game', 'Mute'],
    [['I'], 'game', 'Network stats'],
    ...(offline ? [[['K'], 'game', 'Respawn']] : []),
    [['Esc'], 'game', 'This menu'],
  ];
}

/** The card for the mech carrying `loadout` (weapons.json entries by slot); `offline` adds the sandbox's keys. */
export function controlsHtml(loadout, offline) {
  const binds = bindings(loadout, offline), color = Object.fromEntries(GROUPS.map(([g, , c]) => [g, c]));
  // Each key's group: the first binding it's in (Shift's is movement's).
  const groupOf = new Map();
  for (const [keys, group] of binds) for (const k of keys) if (!groupOf.has(k)) groupOf.set(k, group);
  const cap = (k) => {
    const [label, w] = Array.isArray(k) ? k : [k, 1], g = groupOf.get(label);
    const style = `width:${w * UNIT - 4}px${g ? `;border-color:${color[g]};color:${color[g]};background:${color[g]}22` : ''}`;
    return `<span class="cap${g ? ' used' : ''}" style="${style}">${label}</span>`;
  };
  const keyboard = ROWS.map(([indent, ...keys]) => `<div class="krow" style="padding-left:${indent * UNIT}px">${keys.map(cap).join('')}</div>`).join('');
  const fight = color.fight, button = (d) => `<path d="${d}" fill="${fight}33" stroke="${fight}" stroke-width="1.5"/>`;
  const mouse = `<svg class="mouse" viewBox="0 0 64 96" width="64" height="96" aria-hidden="true">
    ${button('M32 4 C14 4 6 16 6 34 L6 40 L31 40 L31 4 Z')}${button('M33 4 C50 4 58 16 58 34 L58 40 L33 40 L33 4 Z')}
    <path d="M6 42 L58 42 L58 66 C58 82 46 92 32 92 C18 92 6 82 6 66 Z" fill="#ffffff08" stroke="#ffffff55" stroke-width="1.5"/>
    <rect x="28" y="12" width="8" height="18" rx="4" fill="${fight}" />
    <text x="18" y="30" class="mb">L</text><text x="46" y="30" class="mb">R</text></svg>`;
  const chip = (k) => (k === '+' || k === '/' ? `<i>${k}</i>` : `<kbd>${k}</kbd>`);
  const legend = GROUPS.map(([g, name, c]) => `<div class="cgroup"><h4 style="color:${c}">${name}</h4>${binds
    .filter(([, group]) => group === g)
    .map(([keys, , what]) => `<div class="bind"><span class="keys" style="--c:${c}">${keys.map(chip).join('')}</span><span>${what}</span></div>`)
    .join('')}</div>`).join('');
  return `<div class="controls-map"><div class="keyboard">${keyboard}</div>${mouse}</div><div class="legend">${legend}</div>`;
}
