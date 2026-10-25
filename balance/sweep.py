#!/usr/bin/env python3
"""Every build in a family, played by today's bot (default policy) and rated together; then each
class and each weapon, item or ability averaged over the rest, with how much it was used.

Weapons (default): class x primary x secondary, with the class's own items and ability.
--items: class x offensive x support x ability, with the class's own guns, every item included
(also the ones bots don't know how to use yet: they show as unused).

With --tweaks (the arena job's `tuning`, `classes` and `weapons` maps), the stats are changed first;
with --against a control run's folder, the report also lists what moved past two standard errors;
with --only slot=id, only the builds carrying that one weapon, item or ability play (cheap, for
sensitivity runs).

  python3 balance/sweep.py --appear 60 [--ideal] [--items] --out balance/out/sweep
  python3 balance/sweep.py --tweaks '{"weapons": {"rocket": {"alt_damage": 38}}}' \\
      --against balance/out/sweep --out balance/out/rocket
"""
import argparse
import itertools
import json
import math
import random
from pathlib import Path

import numpy as np

import evolve as ev

CLASS_NAMES = {'A': 'Light', 'B': 'Medium', 'C': 'Heavy', 'all': 'All'}
SLOT_COLUMN = {'primary': 'primary', 'secondary': 'secondary', 'offensive': 'offensive', 'support': 'support', 'ability': 'ability'}


def every(slot, cls):
    """Every entry of `slot` that `cls` may carry, bots' gaps included."""
    return [w['id'] for w in ev.WEAPONS[ev.LISTS[slot]] if cls in w.get('classes', [cls])]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--appear', type=int, default=60, help='matches per build')
    ap.add_argument('--seconds', type=float, default=120)
    ap.add_argument('--skill', type=float, default=0.5)
    ap.add_argument('--ideal', action='store_true', help='no aim error, reaction lag, turn cap or misjudging')
    ap.add_argument('--items', action='store_true', help='vary items and abilities instead of guns')
    ap.add_argument('--only', help='slot=id: only builds carrying it')
    ap.add_argument('--tweaks', type=json.loads, default={}, help='stat changes, as the arena job takes them')
    ap.add_argument('--against', type=Path, help="a control run's folder, to compare with")
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--out', type=Path, default=ev.ROOT / 'balance' / 'out' / 'sweep')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    slots = ('offensive', 'support', 'ability') if args.items else ('primary', 'secondary')
    only = args.only.split('=') if args.only else None
    pool = {}
    for cls in 'ABC':
        for picks in itertools.product(*(every(s, cls) for s in slots)):
            if only and dict(zip(slots, picks)).get(only[0]) != only[1]:
                continue
            g = ev.stock(cls, ev.CLASSES[cls]['weapons']['primary'])
            g['build'].update(zip(slots, picks))
            pool['|'.join((cls, *picks))] = g
    if not pool:
        raise SystemExit(f'no build carries {args.only}')
    ids = list(pool)
    rows = ev.play(pool, args.appear, 2_000_000_000, random.Random(args.seed), args)
    ratings, cov = ev.rate(rows, ids)
    beta, cov = np.array([ratings[i][0] for i in ids]), cov[:len(ids), :len(ids)]

    def mean(keep):
        """Mean rating of the builds `keep(class, *picks)` picks, and its error."""
        w = np.array([1.0 if keep(*i.split('|')) else 0.0 for i in ids])
        w /= w.sum()
        return float(w @ beta), math.sqrt(float(w @ cov @ w))

    # Every average, keyed slot/id/class ("class/A/all", "secondary/rocket/all", "primary/pike/B"),
    # and each one's use per match: uses and hull dealt by its slot.
    table = {f'class/{c}/all': mean(lambda k, *_, c=c: k == c) for c in 'ABC'}
    use = {}
    mine = [r for r in rows if r['genome'] in pool]
    for pos, slot in enumerate(slots, start=1):
        for w in sorted({i.split('|')[pos] for i in ids}):
            table[f'{slot}/{w}/all'] = mean(lambda *k, w=w, pos=pos: k[pos] == w)
            for c in 'ABC':
                if any(i.split('|')[0] == c and i.split('|')[pos] == w for i in ids):
                    table[f'{slot}/{w}/{c}'] = mean(lambda *k, w=w, c=c, pos=pos: k[0] == c and k[pos] == w)
            rs = [r for r in mine if r['genome'].split('|')[pos] == w]
            n = max(1, len(rs))
            use[f'{slot}/{w}'] = (sum(int(r[f'uses_{slot}']) for r in rs) / n, sum(float(r[f'dealt_{slot}']) for r in rs) / n)
    doing = {k: sum(float(r[f's_{k}']) for r in mine) / max(1, len(mine)) for k in ('fight', 'fall_back', 'mend', 'move')}
    (args.out / 'ratings.json').write_text(json.dumps({'tweaks': args.tweaks, 'ideal': args.ideal, 'skill': args.skill, 'items': args.items, 'only': args.only, 'table': table, 'use': use, 'doing': doing}, indent=1))

    fmt = lambda m: f'{m[0]:+.2f} ± {m[1]:.2f}'
    names = {w['id']: w['name'] for lst in ev.WEAPONS.values() for w in lst}
    aim = 'ideal aim' if args.ideal else f'skill {args.skill}'
    family = 'items and abilities' if args.items else 'guns'
    lines = [f'# Build sweep, {family}, {aim}', '', f'{len(ids)} builds, {args.appear} matches each, TDM {args.seconds:.0f} s. Team-margin plus-minus per match against the stock bot (0), ± one standard error. * = the class\'s own. Uses and hull dealt are per match.', '']
    lines.append('Time alive, per match: ' + ', '.join(f'{k.replace("_", " ")} {v:.0f} s' for k, v in doing.items()) + '.')
    lines.append('')
    if args.tweaks:
        lines += [f'Tweaks: `{json.dumps(args.tweaks)}`', '']
    if args.against:
        control = json.loads((args.against / 'ratings.json').read_text())['table']
        moved = []
        for key, (m, se) in table.items():
            if key not in control:
                continue
            cm, cse = control[key]
            if abs(m - cm) > 2 * math.hypot(se, cse):
                slot, w, c = key.split('/')
                moved.append((m - cm, math.hypot(se, cse), f"{names.get(w, CLASS_NAMES.get(w, w))} ({CLASS_NAMES[c]})", cm, m))
        lines += [f'## Moved past two standard errors, against {args.against.name}', '']
        lines += ['| What | Control | Now | Change |', '| --- | --- | --- | --- |'] if moved else ['Nothing.']
        for d, se, what, cm, m in sorted(moved, key=lambda x: -abs(x[0])):
            lines.append(f'| {what} | {cm:+.2f} | {m:+.2f} | {d:+.2f} ± {se:.2f} |')
        lines.append('')
    lines += ['## Classes', '', '| Class | Rating |', '| --- | --- |']
    for cls in 'ABC':
        lines.append(f"| {CLASS_NAMES[cls]} | {fmt(table[f'class/{cls}/all'])} |")
    for slot in slots:
        own = {c: ev.CLASSES[c]['weapons'][slot] for c in 'ABC'}
        present = sorted({k.split('/')[1] for k in table if k.startswith(slot + '/')}, key=lambda w: -table[f'{slot}/{w}/all'][0])
        lines += ['', f'## {slot.title()} by class', '', '| ' + slot.title() + ' | All | Light | Medium | Heavy | Uses | Hull dealt |', '| --- | --- | --- | --- | --- | --- | --- |']
        for w in present:
            cells = [(fmt(table[f'{slot}/{w}/{c}']) + ('*' if own[c] == w else '')) if f'{slot}/{w}/{c}' in table else '-' for c in 'ABC']
            uses, dealt = use[f'{slot}/{w}']
            lines.append(f"| {names[w]} | {fmt(table[f'{slot}/{w}/all'])} | " + ' | '.join(cells) + f' | {uses:.1f} | {dealt:.0f} |')
    (args.out / 'report.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
