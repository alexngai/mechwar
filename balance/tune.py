#!/usr/bin/env python3
"""Tune bot Policy weights by the cross-entropy method on full matches: each generation draws
candidates from a Gaussian over the weights, plays each with a team of four against a team of
today's bot (sides swapped, the same seeds for every candidate), and refits the Gaussian to the
best. The mean at the end is the tuned policy; check it on fresh seeds with --check.

  python3 balance/tune.py [--gens 15] [--pop 12] [--matches 120] [--mode tdm,ma,ctf] --out balance/out/tune
  python3 balance/tune.py --mode ctf --space ctf_raid,ctf_escort,ctf_chase,ctf_guard,carry_retreat --skip walled
  python3 balance/tune.py --check '{"post_take": 1.4}' [--matches 600] [--skill 1.0] [--mode ma]

With several modes, a candidate plays --matches in each, and its fitness is the mean over modes of
its margin over that mode's spread of margins (so kills, base hull, captures and push add up).
Team Deathmatch matches last --seconds; the objective modes' five minutes.
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
# Each mode's own weights, tuned with --space: Capture the Flag's squads and when a carrier falls
# back; Missile Assault's spread; Siege's crew; Convoy's escort. And when a rocket punch goes in.
MODE_SPACE = {
    'ctf_raid': (0.0, 4.0),
    'ctf_escort': (0.0, 3.0),
    'ctf_chase': (0.0, 4.0),
    'ctf_guard': (0.0, 3.0),
    'carry_retreat': (0.0, 1.0),
    'assault_spread': (1.0, 5.0),
    'siege_bank': (0.2, 1.0),
    'siege_aa': (0.0, 3.0),
    'siege_aa_ship': (0.0, 4.0),
    'convoy_cover': (0.0, 20.0),
    'convoy_spare': (1.0, 4.0),
    'convoy_scout': (10.0, 60.0),
    'punch_focus': (0.0, 3.0),
    'punch_low': (0.0, 1.0),
    'punch_alone': (0.0, 40.0),
    'punch_slip': (0.5, 3.0),
}
MAPS = {'tdm': ['foundry', 'isotope', 'verdigris', 'riftline', 'sump', 'sinkhole', 'canopy', 'crashsite', 'ziggurat', 'span', 'walled'],
        'ma': ['foundry', 'verdigris', 'riftline', 'sinkhole', 'canopy', 'crashsite', 'ziggurat', 'span', 'walled'],
        'siege': ['foundry', 'riftline', 'canopy', 'crashsite', 'span'],
        'ctf': ['foundry', 'verdigris', 'riftline', 'sinkhole', 'canopy', 'crashsite', 'walled'],
        'convoy': ['foundry', 'riftline', 'canopy', 'crashsite', 'span', 'walled']}


def margins(pool, n, seed, args, mode=None):
    """Each policy in `pool` (name: overrides) against today's bot over `n` matches, sides
    swapped, on the same seeds: its margin a match (kills; base hull in Missile Assault and Siege;
    captures and a tenth a flag taken in Capture the Flag; percent of the way pushed in Convoy)."""
    mode = mode or args.mode
    seconds = args.seconds if mode == 'tdm' else max(args.seconds, 300.0)
    matches, owner = [], []
    for name in pool:
        for k in range(n):
            teams = [[name] * 4, ['base'] * 4] if k % 2 == 0 else [['base'] * 4, [name] * 4]
            matches.append({'map': MAPS[mode][(k // 2) % len(MAPS[mode])], 'seed': seed + k, 'teams': teams})
            owner.append(name)
    job = {'mode': mode, 'seconds': seconds, 'skill': args.skill, 'ideal': args.ideal,
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
            out[owner[i]].append(ev.margin(r))
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
    ap.add_argument('--mode', default='tdm', help='a mode, or several, comma-separated: ' + ', '.join(MAPS))
    ap.add_argument('--seconds', type=float, default=120)
    ap.add_argument('--seed', type=int, default=31)
    ap.add_argument('--skip', default='', help='maps to leave out, comma-separated (Walled City costs about 15 times a match)')
    ap.add_argument('--space', help='the weights to tune, comma-separated (default: the posts\' and team play\'s, SPACE)')
    ap.add_argument('--check', type=json.loads, help='a policy to play against today\'s bot on fresh seeds, instead of tuning')
    ap.add_argument('--out', type=Path, default=ev.ROOT / 'balance' / 'out' / 'tune')
    args = ap.parse_args()
    modes = args.mode.split(',')
    assert all(m in MAPS for m in modes), f'modes: {", ".join(MAPS)}'
    for mode in MAPS:
        MAPS[mode] = [m for m in MAPS[mode] if m not in args.skip.split(',')]
    args.out.mkdir(parents=True, exist_ok=True)
    if args.check is not None:
        for mode in modes:
            m, se = summary(margins({'check': args.check}, args.matches, 900_000_000 + args.seed * 10_000, args, mode)['check'])
            print(f'{mode} skill {"ideal" if args.ideal else args.skill}, {args.matches} matches: margin {m:+.2f} ± {se:.2f} a match')
        return
    space = SPACE | MODE_SPACE
    names = args.space.split(',') if args.space else list(SPACE)
    lo, hi = (np.array([space[k][i] for k in names]) for i in (0, 1))
    default = np.array([ev.DEFAULT[k] for k in names], dtype=float)
    mean, sd = default.copy(), 0.25 * (hi - lo)
    rng = np.random.default_rng(args.seed)
    log = []
    for gen in range(args.gens):
        draws = np.clip(mean + sd * rng.standard_normal((args.pop, len(names))), lo, hi)
        # The current mean plays too, as a yardstick.
        draws[0] = mean
        pool = {f'c{k}': {n: round(float(v), 3) for n, v in zip(names, d)} for k, d in enumerate(draws)}
        # Each mode's margins over its spread, then the mean over modes.
        per = [margins(pool, args.matches, args.seed * 1_000_000 + gen * 10_000, args, mode) for mode in modes]
        scores = {}
        for k in pool:
            fits = []
            for by in per:
                spread = summary([x for v in by.values() for x in v])[1] * math.sqrt(sum(len(v) for v in by.values())) or 1.0
                fits.append([x / spread for x in by[k]])
            fit = sum(summary(f)[0] for f in fits) / len(fits)
            se = math.sqrt(sum(summary(f)[1] ** 2 for f in fits)) / len(fits)
            scores[k] = (fit, se)
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
