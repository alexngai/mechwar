#!/usr/bin/env python3
"""Tune bot Policy weights by the cross-entropy method on full matches: each generation draws
candidates from a Gaussian over the weights, plays each with a team of four against a team of
today's bot (sides swapped, the same seeds for every candidate), and refits the Gaussian to the
best. The mean at the end is the tuned policy; check it on fresh seeds with --check.

  python3 balance/tune.py [--gens 15] [--pop 12] [--matches 120] --out balance/out/tune
  python3 balance/tune.py --check '{"post_take": 1.4}' [--matches 600] [--skill 1.0] [--mode ma]
"""
import argparse
import csv
import io
import json
import math
import subprocess
from pathlib import Path

import numpy as np

import evolve as ev

# Weight: (low, high). The posts' and team play's continuous weights.
SPACE = {
    'post_take': (0.3, 3.0),
    'post_horizon': (2.0, 15.0),
    'post_moving': (0.0, 1.0),
    'post_stay': (0.0, 0.5),
    'post_reach': (8.0, 40.0),
    'post_leash': (1.0, 10.0),
    'post_split': (0.0, 1.5),
    'post_cross': (0.0, 1.5),
    'trade_reach': (0.0, 90.0),
}
MAPS = {'tdm': ['foundry', 'isotope', 'verdigris', 'riftline', 'sump', 'sinkhole', 'canopy', 'crashsite', 'ziggurat', 'span'],
        'ma': ['foundry', 'verdigris', 'riftline', 'sinkhole', 'canopy', 'crashsite', 'ziggurat', 'span'],
        'siege': ['foundry', 'riftline', 'canopy', 'crashsite', 'span'],
        'ctf': ['foundry', 'verdigris', 'riftline', 'sinkhole', 'canopy', 'crashsite'],
        'convoy': ['foundry', 'riftline', 'canopy', 'crashsite', 'span']}


def margins(pool, n, seed, args):
    """Each policy in `pool` (name: overrides) against today's bot over `n` matches, sides
    swapped, on the same seeds: its margin a match (kills; base hull in Missile Assault and Siege;
    captures in Capture the Flag; percent of the way pushed in Convoy)."""
    matches, owner = [], []
    for name in pool:
        for k in range(n):
            teams = [[name] * 4, ['base'] * 4] if k % 2 == 0 else [['base'] * 4, [name] * 4]
            matches.append({'map': MAPS[args.mode][(k // 2) % len(MAPS[args.mode])], 'seed': seed + k, 'teams': teams})
            owner.append(name)
    job = {'mode': args.mode, 'seconds': args.seconds, 'skill': args.skill, 'ideal': args.ideal,
           'genomes': {'base': {}, **{name: {'policy': p} for name, p in pool.items()}}, 'matches': matches}
    path = args.out / 'job.json'
    path.write_text(json.dumps(job))
    run = subprocess.run([ev.ARENA, path], capture_output=True, text=True)
    if run.returncode:
        raise SystemExit(run.stderr)
    out = {name: [] for name in pool}
    seen = set()
    for r in csv.DictReader(io.StringIO(run.stdout)):
        i = int(r['match'])
        if r['genome'] != 'base' and i not in seen:
            seen.add(i)
            out[owner[i]].append(int(r['score']) - int(r['opp_score']))
    return out


def summary(xs):
    m = sum(xs) / len(xs)
    return m, math.sqrt(sum((x - m) ** 2 for x in xs) / max(1, len(xs) - 1) / len(xs))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--gens', type=int, default=15)
    ap.add_argument('--pop', type=int, default=12)
    ap.add_argument('--elite', type=int, default=4)
    ap.add_argument('--matches', type=int, default=120, help='per candidate (a generation); per check')
    ap.add_argument('--skill', type=float, default=0.5)
    ap.add_argument('--ideal', action='store_true')
    ap.add_argument('--mode', default='tdm', choices=list(MAPS))
    ap.add_argument('--seconds', type=float, default=120)
    ap.add_argument('--seed', type=int, default=31)
    ap.add_argument('--check', type=json.loads, help='a policy to play against today\'s bot on fresh seeds, instead of tuning')
    ap.add_argument('--out', type=Path, default=ev.ROOT / 'balance' / 'out' / 'tune')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.check is not None:
        m, se = summary(margins({'check': args.check}, args.matches, 900_000_000 + args.seed * 10_000, args)['check'])
        print(f'{args.mode} skill {"ideal" if args.ideal else args.skill}, {args.matches} matches: margin {m:+.2f} ± {se:.2f} a match')
        return
    names = list(SPACE)
    lo, hi = (np.array([SPACE[k][i] for k in names]) for i in (0, 1))
    default = np.array([ev.DEFAULT[k] for k in names], dtype=float)
    mean, sd = default.copy(), 0.25 * (hi - lo)
    rng = np.random.default_rng(args.seed)
    log = []
    for gen in range(args.gens):
        draws = np.clip(mean + sd * rng.standard_normal((args.pop, len(names))), lo, hi)
        # The current mean plays too, as a yardstick.
        draws[0] = mean
        pool = {f'c{k}': {n: round(float(v), 3) for n, v in zip(names, d)} for k, d in enumerate(draws)}
        scores = {k: summary(v) for k, v in margins(pool, args.matches, args.seed * 1_000_000 + gen * 10_000, args).items()}
        order = sorted(range(args.pop), key=lambda k: -scores[f'c{k}'][0])
        elite = draws[order[: args.elite]]
        mean = 0.3 * mean + 0.7 * elite.mean(axis=0)
        sd = np.maximum(0.3 * sd + 0.7 * elite.std(axis=0), 0.04 * (hi - lo))
        line = f'gen {gen:2d}: mean played {scores["c0"][0]:+.2f} ± {scores["c0"][1]:.2f}, best {scores[f"c{order[0]}"][0]:+.2f}; new mean ' + ', '.join(f'{n} {v:.3g}' for n, v in zip(names, mean))
        print(line, flush=True)
        log.append(line)
    tuned = {n: round(float(v), 3) for n, v in zip(names, mean)}
    (args.out / 'tuned.json').write_text(json.dumps(tuned, indent=1))
    (args.out / 'log.txt').write_text('\n'.join(log) + '\n')
    print(json.dumps(tuned))


if __name__ == '__main__':
    main()
