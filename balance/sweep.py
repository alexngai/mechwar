#!/usr/bin/env python3
"""Every class x primary x secondary, played by today's bot (default policy, the class's own items
and ability) and rated together; then each class, primary and secondary averaged over the rest.

  python3 balance/sweep.py --appear 60 [--ideal] --out balance/out/sweep
"""
import argparse
import math
import random
from pathlib import Path

import numpy as np

import evolve as ev


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--appear', type=int, default=60, help='matches per build')
    ap.add_argument('--seconds', type=float, default=120)
    ap.add_argument('--skill', type=float, default=0.5)
    ap.add_argument('--ideal', action='store_true', help='no aim error, reaction lag or turn cap')
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

    fmt = lambda m: f'{m[0]:+.2f} ± {m[1]:.2f}'
    own = {cls: ev.CLASSES[cls]['weapons'] for cls in 'ABC'}
    names = {w['id']: w['name'] for lst in ev.WEAPONS.values() for w in lst}
    aim = 'ideal aim' if args.ideal else f'skill {args.skill}'
    lines = [f'# Build sweep, {aim}', '', f'{len(ids)} builds, {args.appear} matches each, TDM {args.seconds:.0f} s. Team-margin plus-minus per match against the stock bot (0), ± one standard error. * = the class\'s own.', '']
    lines += ['## Classes (over every primary and secondary)', '', '| Class | Rating |', '| --- | --- |']
    for cls in 'ABC':
        lines.append(f"| {ev.CLASSES[cls]['name']} | {fmt(mean(lambda c, p, s: c == cls))} |")
    for slot, pos in (('secondary', 2), ('primary', 1)):
        ids_ = ev.options(slot, 'A')
        overall = {w: mean(lambda *k: k[pos] == w) for w in ids_}
        lines += ['', f'## {slot.title()}s by class (over the other slot)', '', '| ' + slot.title() + ' | All | Light | Medium | Heavy |', '| --- | --- | --- | --- | --- |']
        for w in sorted(ids_, key=lambda w: -overall[w][0]):
            cells = [fmt(mean(lambda c, *k, cls=cls: c == cls and k[pos - 1] == w)) + ('*' if own[cls][slot] == w else '') for cls in 'ABC']
            lines.append(f'| {names[w]} | {fmt(overall[w])} | ' + ' | '.join(cells) + ' |')
    (args.out / 'report.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
