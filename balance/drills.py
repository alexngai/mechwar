#!/usr/bin/env python3
"""Drills: short fixed scenarios on the open test map that score a genome cheaply, with little
noise, before it spends full matches. Each pits the genome (team 0's first seat) against stock
bots from set spots; its score is the share of the foes' hull it dealt less the share of its own
it lost (-1 to 1 in a duel), per drill, averaged over seeds.

  python3 balance/drills.py [--seeds 20]     (genome 0 in every class and primary, as a baseline)
"""
import argparse
import json
import math
import subprocess
from pathlib import Path

import evolve as ev

# Each drill: where every seat starts (the genome's first, its mates', then the foes'), each seat's
# share of hull, and how many mates and foes.
DRILLS = {
    'duel-20': {'at': [[0, 0.1, 15], [0, 0.1, -5]], 'hull': [1, 1], 'mates': 0, 'foes': 1},
    'duel-40': {'at': [[0, 0.1, 35], [0, 0.1, -5]], 'hull': [1, 1], 'mates': 0, 'foes': 1},
    'hurt-25': {'at': [[0, 0.1, 20], [0, 0.1, -5]], 'hull': [0.4, 1], 'mates': 0, 'foes': 1},
    'team-30': {'at': [[-4, 0.1, 25], [4, 0.1, 25], [-4, 0.1, -5], [4, 0.1, -5]], 'hull': [1, 1, 1, 1], 'mates': 1, 'foes': 2},
}
SECONDS = 20
TUNING = json.loads((ev.ROOT / 'tuning.json').read_text())
# Each class's hull, for the shares.
HULL = {c: ev.CLASSES[c]['overrides'].get('health_max', TUNING['health_max']['value']) for c in 'ABC'}


def score(pool, seeds, args, seed0=7_000_000):
    """Each genome's drill score: (mean, standard error, {drill: mean})."""
    matches = []
    for gid in pool:
        for name, d in DRILLS.items():
            for s in range(seeds):
                seats = [[gid] + ['base'] * d['mates'], ['base'] * d['foes']]
                matches.append({'map': 'blockout', 'seed': seed0 + s, 'teams': seats, 'at': d['at'], 'hull': d['hull'], 'drill': name})
    job = {'seconds': SECONDS, 'skill': args.skill, 'ideal': args.ideal, 'genomes': {'base': {}, **pool},
           'matches': [{k: v for k, v in m.items() if k != 'drill'} for m in matches], **getattr(args, 'tweaks', {})}
    path = args.out / 'drills-job.json'
    path.write_text(json.dumps(job))
    run = subprocess.run([ev.ARENA, path], capture_output=True, text=True)
    if run.returncode:
        raise SystemExit(run.stderr)
    import csv, io
    rows = list(csv.DictReader(io.StringIO(run.stdout)))
    nets = {gid: {name: [] for name in DRILLS} for gid in pool}
    by_match = {}
    for r in rows:
        by_match.setdefault(int(r['match']), []).append(r)
    for i, rs in by_match.items():
        m = matches[i]
        me = next(r for r in rs if r['team'] == '0' and r['genome'] == m['teams'][0][0])
        foes = sum(HULL[r['class']] for r in rs if r['team'] == '1')
        nets[me['genome']][m['drill']].append(float(me['dealt']) / foes - float(me['taken']) / HULL[me['class']])
    out = {}
    for gid, by in nets.items():
        every = [x for xs in by.values() for x in xs]
        mean = sum(every) / len(every)
        sd = math.sqrt(sum((x - mean) ** 2 for x in every) / max(1, len(every) - 1))
        out[gid] = (mean, sd / math.sqrt(len(every)), {k: sum(v) / len(v) for k, v in by.items()})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--seeds', type=int, default=20)
    ap.add_argument('--skill', type=float, default=0.5)
    ap.add_argument('--ideal', action='store_true')
    ap.add_argument('--out', type=Path, default=ev.ROOT / 'balance' / 'out' / 'drills')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    pool = {f'{c}-{p}': ev.stock(c, p) for c in 'ABC' for p in ev.options('primary', c)}
    scores = score(pool, args.seeds, args)
    print(f"{'build':12s} {'score':>14s}  " + '  '.join(f'{d:>8s}' for d in DRILLS))
    for gid, (m, se, by) in sorted(scores.items(), key=lambda kv: -kv[1][0]):
        print(f'{gid:12s} {m:+7.2f} ± {se:4.2f}  ' + '  '.join(f'{by[d]:+8.2f}' for d in DRILLS))


if __name__ == '__main__':
    main()
