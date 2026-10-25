#!/usr/bin/env python3
"""MAP-Elites over bot policies, rated by plus-minus from bot-only matches: a proof of concept.

Each archive cell is a class and primary; its elite is the best policy and kit found for that
weapon. Generation 0 is today's bot (default policy, the class's own kit) in every cell. A final
run on fresh seeds rates each cell's champion against it, and today's bot cell by cell: the
balance table.

A genome's rating is its share of the team score margin per match (kills in TDM), against the
stock bot (`base`, random class and build, default policy) at 0, from a ridge regression over
every match it played: teammates and opponents are accounted for.

  SDKROOT=... cargo build --release -p sim --bin arena
  python3 balance/evolve.py --gens 20 --out balance/out/poc
"""
import argparse
import csv
import io
import json
import math
import os
import random
import re
import subprocess
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
# The arena binary: the release build, or another (BALANCE_ARENA) to compare builds.
ARENA = Path(os.environ.get('BALANCE_ARENA', ROOT / 'target' / 'release' / 'arena'))
# The server's rotation, as sim/src/map.rs lists it.
MAPS = re.findall(r'"(\w+)"', re.search(r'ROTATION: \[&str; \d+\] = \[(.*?)\]', (ROOT / 'sim' / 'src' / 'map.rs').read_text()).group(1))
WEAPONS = json.loads((ROOT / 'weapons.json').read_text())
CLASSES = json.loads((ROOT / 'classes.json').read_text())
LISTS = {'primary': 'primaries', 'secondary': 'secondaries', 'offensive': 'offensive', 'support': 'support', 'ability': 'abilities'}
DEFAULT = json.loads(subprocess.run([ARENA, '--policy'], capture_output=True, text=True, check=True).stdout)
# Genome 0's brain: per action, rules of (feature, curve) considerations (sim/src/brain.rs).
# (An older arena has none: genomes then go without one, and play its fixed rules.)
_brain = subprocess.run([ARENA, '--brain'], capture_output=True, text=True)
BRAIN = json.loads(_brain.stdout) if _brain.returncode == 0 else None
# Each measured feature's span, for the thresholds evolution draws; every other feature is a flag.
SPAN = {'hull': (0.0, 1.0), 'heat': (0.0, 1.0), 'range': (0.0, 2.0), 'throws': (0.0, 3.0), 'charges': (0.0, 3.0), 'target_dist': (0.0, 60.0), 'enemies_in_view': (0.0, 4.0), 'mates_near': (0.0, 3.0)}
FLAGS = ['mending', 'in_cover', 'overheated', 'hit', 'fire', 'alt_fire', 'striking', 'melee', 'target_jammed', 'target_thrusters', 'emp_reaches', 'alt_ready',
         'grenade_ready', 'first_sight', 'perched', 'barrier_room', 'orb_near', 'exposed', 'limpet_out', 'limpet_hits', 'cooling', 'vent_ready', 'target_in_sight']
# Which moment a rule is about: rules keep these.
CONTEXT = {'engaged', 'falling_back', 'starting_fall_back'}
# Genes that are shares (of hull, heat, range, or a chance): nudged by adding, kept in (0, 1).
SHARES = {'cool_high', 'cool_low', 'band_near', 'dodge_chance', 'heat_fed'}
ORDERED = [('cool_low', 'cool_high'), ('band_near', 'band_far')]
def options(slot, cls):
    return [w['id'] for w in WEAPONS[LISTS[slot]] if cls in w.get('classes', [cls])]


def cell(g):
    return f"{g['class']}-{g['build']['primary']}"


def stock(cls, primary):
    """Today's bot in a cell: default policy, the class's own kit with this primary."""
    g = {'class': cls, 'build': {**CLASSES[cls]['weapons'], 'primary': primary}, 'policy': dict(DEFAULT)}
    if BRAIN:
        g['brain'] = json.loads(json.dumps(BRAIN))
    return g


def threshold(curve):
    """A curve's threshold (a step's, or a smooth one's middle), and a setter for it."""
    (kind, value), = curve.items()
    if isinstance(value, dict):
        return value['mid'], lambda x: value.update(mid=x)
    return value, lambda x: curve.update({kind: x})


def mutate_brain(brain, rng):
    """One change to one block of rules: a threshold nudged, a step softened, a consideration
    added or dropped, a rule added or dropped."""
    action = rng.choice(list(brain))
    rules = brain[action]
    op = rng.choices(['nudge', 'soften', 'add', 'drop', 'add_rule', 'drop_rule'], [35, 15, 20, 15, 10, 5])[0]
    measured = [(r, c) for r in rules for c in r if c[0] in SPAN]
    if op == 'nudge' and measured:
        _, (feature, curve) = rng.choice(measured)
        lo, hi = SPAN[feature]
        x, put = threshold(curve)
        put(round(min(hi, max(lo, x + rng.gauss(0, 0.1 * (hi - lo)))), 3))
    elif op == 'soften' and measured:
        rule, (feature, curve) = rng.choice(measured)
        (kind, x), = curve.items()
        if not isinstance(x, dict):
            lo, hi = SPAN[feature]
            smooth = 'falling' if kind in ('below', 'at_most') else 'rising'
            rule[rule.index([feature, curve])] = [feature, {smooth: {'mid': x, 'steep': round(8 / (hi - lo), 3)}}]
    elif op == 'add' and rules:
        rng.choice(rules).append(fresh(rng))
    elif op == 'drop' and rules:
        rule = rng.choice(rules)
        loose = [c for c in rule if c[0] not in CONTEXT]
        if len(loose) > 1:
            rule.remove(rng.choice(loose))
    elif op == 'add_rule':
        base = json.loads(json.dumps(rng.choice(rules))) if rules else [['engaged', {'above': 0.5}]]
        rules.append([c for c in base if c[0] in CONTEXT] + [fresh(rng)] + ([fresh(rng)] if rng.random() < 0.5 else []))
    elif op == 'drop_rule' and len(rules) > 1:
        rules.remove(rng.choice(rules))


def fresh(rng):
    """A new consideration: a flag on or off, or a measured feature above or below a threshold."""
    if rng.random() < 0.5:
        return [rng.choice(FLAGS), {rng.choice(['above', 'at_most']): 0.5}]
    feature = rng.choice(list(SPAN))
    lo, hi = SPAN[feature]
    return [feature, {rng.choice(['below', 'above']): round(rng.uniform(lo, hi), 3)}]


def mutate(g, rng, archive, rate=0.2):
    g = json.loads(json.dumps(g))
    # Crossover: genes from another elite of the same class.
    mates = [e['genome'] for e in archive.values() if e['genome']['class'] == g['class']]
    if rng.random() < 0.3 and mates:
        other = rng.choice(mates)['policy']
        g['policy'] = {k: (v if rng.random() < 0.5 else other[k]) for k, v in g['policy'].items()}
    if BRAIN:
        if rng.random() < 0.3 and mates:
            other = rng.choice(mates).get('brain', BRAIN)
            g['brain'] = {a: json.loads(json.dumps(rules if rng.random() < 0.5 else other.get(a, rules))) for a, rules in g.get('brain', BRAIN).items()}
        # Rules change about as often as the numbers do.
        g.setdefault('brain', json.loads(json.dumps(BRAIN)))
        for _ in range(1 + int(rng.random() < 0.3)):
            mutate_brain(g['brain'], rng)
    p = g['policy']
    for k in [k for k in p if rng.random() < rate] or [rng.choice(list(p))]:
        if k == 'role_cuts':
            p[k] = sorted(round(min(1.0, max(0.0, c + rng.gauss(0, 0.08))), 3) for c in p[k])
        elif k in SHARES:
            p[k] = round(min(0.98, max(0.02, p[k] + rng.gauss(0, 0.08))), 3)
        else:
            p[k] = round(min(2.5 * DEFAULT[k], max(0.25 * DEFAULT[k], p[k] * math.exp(rng.gauss(0, 0.2)))), 3)
    for lo, hi in ORDERED:
        if p[lo] > p[hi]:
            p[lo], p[hi] = p[hi], p[lo]
    # Now and then a kit change; rarer, a primary change (a move to that cell).
    if rng.random() < 0.3:
        slot = rng.choice(['secondary', 'offensive', 'support', 'ability'])
        g['build'][slot] = rng.choice(options(slot, g['class']))
    if rng.random() < 0.1:
        g['build']['primary'] = rng.choice(options('primary', g['class']))
    return g


def play(pool, appear, seed, rng, args):
    """Rows from matches where each genome in `pool` plays about `appear` times, a quarter of the
    seats going to the stock bot."""
    seats = [gid for gid in pool for _ in range(appear)]
    seats += ['base'] * (len(seats) // 3)
    rng.shuffle(seats)
    seats += ['base'] * (-len(seats) % 8)
    matches = [{'map': rng.choice(MAPS), 'seed': seed + i, 'teams': [seats[8 * i:8 * i + 4], seats[8 * i + 4:8 * i + 8]]} for i in range(len(seats) // 8)]
    job = {'seconds': args.seconds, 'skill': args.skill, 'ideal': args.ideal, 'genomes': {'base': {}, **pool}, 'matches': matches, **args.tweaks}
    path = args.out / 'job.json'
    path.write_text(json.dumps(job))
    run = subprocess.run([ARENA, path], capture_output=True, text=True)
    if run.returncode:
        raise SystemExit(run.stderr)
    return list(csv.DictReader(io.StringIO(run.stdout)))


def rate(rows, ids, ridge=1.0):
    """Each genome's plus-minus (team margin per match, `base` = 0) and its standard error, and
    the ratings' covariance by `ids` index. A last, unpenalized column takes team 0's edge."""
    col = {gid: i for i, gid in enumerate(ids)}
    by_match = {}
    for r in rows:
        by_match.setdefault(r['match'], []).append(r)
    X = np.zeros((len(by_match), len(ids) + 1))
    X[:, -1] = 1.0
    y = np.zeros(len(by_match))
    for m, rs in enumerate(by_match.values()):
        for r in rs:
            side = 1.0 if r['team'] == '0' else -1.0
            if r['genome'] in col:
                X[m, col[r['genome']]] += side
            if r['team'] == '0':
                y[m] = float(r['score']) - float(r['opp_score'])
    penalty = ridge * np.eye(len(ids) + 1)
    penalty[-1, -1] = 0.0
    a = np.linalg.inv(X.T @ X + penalty)
    beta = a @ X.T @ y
    s2 = float(np.sum((y - X @ beta) ** 2)) / max(1, len(y) - len(ids) - 1)
    cov = s2 * a @ (X.T @ X) @ a
    se = np.sqrt(np.diag(cov))
    return {gid: (float(beta[i]), float(se[i])) for gid, i in col.items()}, cov


def stats(rows, gid):
    """K, D and win share per match for one genome."""
    rs = [r for r in rows if r['genome'] == gid]
    n = max(1, len(rs))
    return {'n': len(rs), 'k': sum(int(r['kills']) for r in rs) / n, 'd': sum(int(r['deaths']) for r in rs) / n, 'win': sum(float(r['result']) for r in rs) / n}


def pooled(history):
    """Inverse-variance mean of an elite's last three ratings."""
    last = history[-3:]
    w = [1 / max(se, 1e-6) ** 2 for _, se in last]
    return sum(wi * m for wi, (m, _) in zip(w, last)) / sum(w), 1 / math.sqrt(sum(w))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--gens', type=int, default=20)
    ap.add_argument('--children', type=int, default=18)
    ap.add_argument('--appear', type=int, default=40, help='matches per genome per generation')
    ap.add_argument('--verify', type=int, default=150, help='matches per genome in the final run')
    ap.add_argument('--seconds', type=float, default=120)
    ap.add_argument('--skill', type=float, default=0.5)
    ap.add_argument('--ideal', action='store_true', help='no aim error, reaction lag or turn cap')
    ap.add_argument('--tweaks', type=json.loads, default={}, help='stat changes, as the arena job takes them (`tuning`, `classes`, `weapons`)')
    ap.add_argument('--z', type=float, default=1.0, help='margin, in standard errors, a child must win its cell by')
    ap.add_argument('--drills', type=int, default=0, help='seeds per drill: a child plays full matches only if it beats its cell\'s elite at drills (0: no drills)')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--out', type=Path, default=ROOT / 'balance' / 'out' / 'poc')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    log = []

    def say(line):
        print(line, flush=True)
        log.append(line)

    archive = {}
    for cls in 'ABC':
        for primary in options('primary', cls):
            g = stock(cls, primary)
            archive[cell(g)] = {'genome': g, 'history': [], 'born': 0}
    # Children that beat their cell's elite once, waiting to be rated again on fresh matches: a
    # single win is inflated by the luck that picked it (the winner's curse).
    pending = {}
    for gen in range(args.gens + 1):
        t = time.time()
        children = [mutate(rng.choice(list(archive.values()))['genome'], rng, archive) for _ in range(args.children if gen else 0)]
        if args.drills and children:
            # Drills first (cheap): only children ahead of their cell's elite go on to full matches.
            import drills
            scores = drills.score({f'c{k}': g for k, g in enumerate(children)} | {f'e:{cell(g)}': archive[cell(g)]['genome'] for g in children}, args.drills, args)
            children = [g for k, g in enumerate(children) if scores[f'c{k}'][0] > scores[f'e:{cell(g)}'][0]]
        pool = {f'e:{c}': e['genome'] for c, e in archive.items()} | {f'p:{c}': g for c, (g, _) in pending.items()} | {f'c{gen}.{k}': g for k, g in enumerate(children)}
        rows = play(pool, args.appear, gen * 1_000_000, rng, args)
        ratings, _ = rate(rows, list(pool))
        for c, e in archive.items():
            e['history'].append(ratings[f'e:{c}'])
        beats = lambda c, m, se: m - pooled(archive[c]['history'])[0] > args.z * math.hypot(se, pooled(archive[c]['history'])[1])
        taken = [c for c in pending if beats(c, *ratings[f'p:{c}'])]
        for c in taken:
            archive[c] = {'genome': pending[c][0], 'history': [ratings[f'p:{c}']], 'born': gen}
        pending = {}
        for k, g in enumerate(children):
            m, se = ratings[f'c{gen}.{k}']
            if beats(cell(g), m, se) and m > pending.get(cell(g), (None, -math.inf))[1]:
                pending[cell(g)] = (g, m)
        best = max(archive.items(), key=lambda kv: pooled(kv[1]['history'])[0])
        say(f'gen {gen:2d}: {len(rows) // 8} matches in {time.time() - t:.0f}s, {len(children)} children played, {len(taken)} cells taken, {len(pending)} challengers, best {best[0]} {pooled(best[1]["history"])[0]:+.2f}')
        (args.out / 'archive.json').write_text(json.dumps(archive, indent=1))

    # Final run, fresh seeds: every champion beside today's bot in its cell.
    pool = {f'champ:{c}': e['genome'] for c, e in archive.items()} | {f'stock:{c}': stock(*c.split('-', 1)) for c in archive}
    rows = play(pool, args.verify, 1_000_000_000, rng, args)
    ratings, cov = rate(rows, list(pool))
    report(args, archive, rows, ratings, cov, list(pool), log)


def report(args, archive, rows, ratings, cov, ids, log):
    lines = [
        '# Balance PoC report',
        '',
        f'{args.gens} generations, {args.children} children each, {args.appear} matches per genome per generation; final run {args.verify} matches per genome on fresh seeds.',
        f'TDM, {args.seconds:.0f} s matches, skill {"ideal" if args.ideal else args.skill}. Ratings are team-margin plus-minus per match against the stock bot (0), ± one standard error.',
        '',
        '## Cells: today\'s bot vs the evolved champion',
        '',
        '| Cell | Today | Champion | Gain | Champion K / D / win | Kit changes |',
        '| --- | --- | --- | --- | --- | --- |',
    ]
    gains = []
    for c, e in sorted(archive.items(), key=lambda kv: -ratings[f'stock:{kv[0]}'][0]):
        (sm, sse), (cm, cse) = ratings[f'stock:{c}'], ratings[f'champ:{c}']
        s = stats(rows, f'champ:{c}')
        if e['born'] == 0:
            # Never replaced: the champion is today's bot, rated twice; the gap is noise.
            lines.append(f'| {c} | {sm:+.2f} ± {sse:.2f} | (today\'s bot) | - | {s["k"]:.1f} / {s["d"]:.1f} / {s["win"]:.0%} | - |')
            continue
        i, j = ids.index(f'champ:{c}'), ids.index(f'stock:{c}')
        gain, gse = cm - sm, math.sqrt(max(0.0, cov[i, i] + cov[j, j] - 2 * cov[i, j]))
        gains.append((gain, gse))
        kit = stock(*c.split('-', 1))['build']
        changed = ', '.join(f'{v}' for k, v in e['genome']['build'].items() if kit[k] != v) or '-'
        lines.append(f'| {c} | {sm:+.2f} ± {sse:.2f} | {cm:+.2f} ± {cse:.2f} | {gain:+.2f} ± {gse:.2f} | {s["k"]:.1f} / {s["d"]:.1f} / {s["win"]:.0%} | {changed} |')
    sig = sum(1 for g, se in gains if g > 2 * se)
    lines += ['', f'{len(gains)} of {len(archive)} cells evolved past today\'s bot during the run; on fresh seeds, {sig} of those beat it by more than two standard errors.', '']
    champs = [e['genome']['policy'] for e in archive.values() if e['born'] > 0] or [DEFAULT]
    lines += ['## Genes: where evolved champions moved', '', '| Gene | Default | Champion median | Champions up / down by 10%+ |', '| --- | --- | --- | --- |']
    for k, d in DEFAULT.items():
        if k == 'role_cuts':
            continue
        vals = sorted(p[k] for p in champs)
        up = sum(v > 1.1 * d for v in vals)
        down = sum(v < 0.9 * d for v in vals)
        lines.append(f'| {k} | {d:g} | {vals[len(vals) // 2]:g} | {up} / {down} |')
    if BRAIN:
        changed = {}
        for e in archive.values():
            for a, rules in e['genome'].get('brain', {}).items() if e['born'] > 0 else ():
                changed[a] = changed.get(a, 0) + (rules != BRAIN.get(a))
        lines += ['', '## Rules: blocks the evolved champions changed', '', ', '.join(f'{a} ({n})' for a, n in sorted(changed.items(), key=lambda kv: -kv[1]) if n) or 'None.']
    lines += ['', '## Log', '', '```', *log, '```', '']
    (args.out / 'report.md').write_text('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
