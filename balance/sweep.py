#!/usr/bin/env python3
"""Every class x primary x secondary, played by today's bot (default policy, the class's own items
and ability) and rated together; then each class, primary and secondary averaged over the rest.

With --tweaks (the arena job's `tuning`, `classes` and `weapons` maps), the stats are changed first;
with --against a control run's folder, the report also lists what moved past two standard errors.

  python3 balance/sweep.py --appear 60 [--ideal] --out balance/out/sweep
  python3 balance/sweep.py --tweaks '{"weapons": {"rocket": {"alt_radius": 6.4}}}' \\
      --against balance/out/sweep --out balance/out/rocket
"""
import argparse
import json
import math
import random
from pathlib import Path

import numpy as np

import evolve as ev

CLASS_NAMES = {'A': 'Light', 'B': 'Medium', 'C': 'Heavy', 'all': 'All'}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--appear', type=int, default=60, help='matches per build')
    ap.add_argument('--seconds', type=float, default=120)
    ap.add_argument('--skill', type=float, default=0.5)
    ap.add_argument('--ideal', action='store_true', help='no aim error, reaction lag or turn cap')
    ap.add_argument('--tweaks', type=json.loads, default={}, help='stat changes, as the arena job takes them')
    ap.add_argument('--against', type=Path, help="a control run's folder, to compare with")
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--out', type=Path, default=ev.ROOT / 'balance' / 'out' / 'sweep')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    pool = {}
    for cls in 'ABC':
        for primary in ev.options('primary', cls):
            for secondary in ev.options('secondary', cls):
                g = ev.stock(cls, primary)
                g['build']['secondary'] = secondary
                pool[f'{cls}|{primary}|{secondary}'] = g
    ids = list(pool)
    rows = ev.play(pool, args.appear, 2_000_000_000, random.Random(args.seed), args)
    ratings, cov = ev.rate(rows, ids)
    beta, cov = np.array([ratings[i][0] for i in ids]), cov[:len(ids), :len(ids)]

    def mean(keep):
        """Mean rating of the builds `keep(class, primary, secondary)` picks, and its error."""
        w = np.array([1.0 if keep(*i.split('|')) else 0.0 for i in ids])
        w /= w.sum()
        return float(w @ beta), math.sqrt(float(w @ cov @ w))

    # Every average, keyed slot/id/class ("class/A/all", "secondary/rocket/all", "primary/pike/B").
    table = {f'class/{c}/all': mean(lambda k, *_, c=c: k == c) for c in 'ABC'}
    for slot, pos in (('secondary', 2), ('primary', 1)):
        for w in ev.options(slot, 'A'):
            table[f'{slot}/{w}/all'] = mean(lambda *k, w=w: k[pos] == w)
            for c in 'ABC':
                table[f'{slot}/{w}/{c}'] = mean(lambda *k, w=w, c=c: k[0] == c and k[pos] == w)
    (args.out / 'ratings.json').write_text(json.dumps({'tweaks': args.tweaks, 'ideal': args.ideal, 'skill': args.skill, 'table': table}, indent=1))

    fmt = lambda m: f'{m[0]:+.2f} ± {m[1]:.2f}'
    own = {cls: ev.CLASSES[cls]['weapons'] for cls in 'ABC'}
    names = {w['id']: w['name'] for lst in ev.WEAPONS.values() for w in lst}
    aim = 'ideal aim' if args.ideal else f'skill {args.skill}'
    lines = [f'# Build sweep, {aim}', '', f'{len(ids)} builds, {args.appear} matches each, TDM {args.seconds:.0f} s. Team-margin plus-minus per match against the stock bot (0), ± one standard error. * = the class\'s own.', '']
    if args.tweaks:
        lines += [f'Tweaks: `{json.dumps(args.tweaks)}`', '']
    if args.against:
        control = json.loads((args.against / 'ratings.json').read_text())['table']
        moved = []
        for key, (m, se) in table.items():
            cm, cse = control[key]
            if abs(m - cm) > 2 * math.hypot(se, cse):
                slot, w, c = key.split('/')
                moved.append((m - cm, math.hypot(se, cse), f"{names.get(w, CLASS_NAMES.get(w, w))} ({CLASS_NAMES[c]})", cm, m))
        lines += [f'## Moved past two standard errors, against {args.against.name}', '']
        lines += ['| What | Control | Now | Change |', '| --- | --- | --- | --- |'] if moved else ['Nothing.']
        for d, se, what, cm, m in sorted(moved, key=lambda x: -abs(x[0])):
            lines.append(f'| {what} | {cm:+.2f} | {m:+.2f} | {d:+.2f} ± {se:.2f} |')
        lines.append('')
    lines += ['## Classes (over every primary and secondary)', '', '| Class | Rating |', '| --- | --- |']
    for cls in 'ABC':
        lines.append(f"| {CLASS_NAMES[cls]} | {fmt(table[f'class/{cls}/all'])} |")
    for slot in ('secondary', 'primary'):
        lines += ['', f'## {slot.title()} weapons by class (over the other slot)', '', '| ' + slot.title() + ' | All | Light | Medium | Heavy |', '| --- | --- | --- | --- | --- |']
        for w in sorted(ev.options(slot, 'A'), key=lambda w: -table[f'{slot}/{w}/all'][0]):
            cells = [fmt(table[f'{slot}/{w}/{c}']) + ('*' if own[c][slot] == w else '') for c in 'ABC']
            lines.append(f"| {names[w]} | {fmt(table[f'{slot}/{w}/all'])} | " + ' | '.join(cells) + ' |')
    (args.out / 'report.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
