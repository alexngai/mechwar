#!/usr/bin/env python3
"""Stat sensitivity: how far each weapon, item and ability's rating moves when its key stat gets
better (by --better, 50% by default), per 10%. Near zero means bots can't use it: a behaviour task,
not a balance one.

Each runs as two small sweeps (balance/sweep.py --only) of the builds carrying it: as it is, and
with the stat changed.

  python3 balance/sensitivity.py [--skill 1.0] [--appear 60] [--just rocket,hail] --out balance/out/sensitivity
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import evolve as ev

TUNING = json.loads((ev.ROOT / 'tuning.json').read_text())
# Each one's key stat, and which way is better: up, or down (a recharge or cooldown).
BETTER, FASTER = 'up', 'down'
ITEMS = {
    'grenade': ('grenade_damage', BETTER), 'limpet': ('limpet_damage', BETTER), 'smoke': ('smoke_seconds', BETTER),
    'mg_turret': ('mg_turret_damage', BETTER), 'rocket_turret': ('rocket_turret_damage', BETTER),
    'emp': ('emp_jam', BETTER), 'orb': ('orb_recharge', FASTER), 'dome': ('dome_seconds', BETTER), 'barrier': ('barrier_seconds', BETTER),
    'slipstream': ('slipstream_duration', BETTER), 'vent': ('vent_cooldown', FASTER), 'brace': ('brace_duration', BETTER),
    'cloak': ('cloak_duration', BETTER), 'power': ('power_duration', BETTER), 'barrage': ('barrage_duration', BETTER),
    'artillery': ('artillery_duration', BETTER),
}
WEAPON_KEY = {'mender': 'alt_beam_heal', 'splitter': 'alt_split_damage'}


def checks(better):
    """(slot, id, tweaks, the stat it changes) for everything there is, each `better` times better."""
    for slot in ('primary', 'secondary'):
        for w in ev.WEAPONS[ev.LISTS[slot]]:
            key = WEAPON_KEY.get(w['id'], 'shot_damage' if slot == 'primary' else 'alt_damage')
            base = w.get('stats', {}).get(key, TUNING[key]['value'])
            yield slot, w['id'], {'weapons': {w['id']: {key: round(base * better, 3)}}}, key
    for slot in ('offensive', 'support', 'ability'):
        for w in ev.WEAPONS[ev.LISTS[slot]]:
            key, way = ITEMS[w['id']]
            value = TUNING[key]['value']
            yield slot, w['id'], {'tuning': {key: round(value * better if way == BETTER else value / better, 3)}}, key


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--skill', type=float, default=1.0)
    ap.add_argument('--appear', type=int, default=120)
    ap.add_argument('--better', type=float, default=1.5, help='how much better the key stat gets (1.5: 50%%)')
    ap.add_argument('--just', help='comma-separated ids to check (default: all)')
    ap.add_argument('--seed', type=int, default=41)
    ap.add_argument('--out', type=Path, default=ev.ROOT / 'balance' / 'out' / 'sensitivity')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    just = set(args.just.split(',')) if args.just else None
    names = {w['id']: w['name'] for lst in ev.WEAPONS.values() for w in lst}
    lines = [f'# Stat sensitivity, skill {args.skill}', '',
             f'Rating change for its key stat {args.better - 1:.0%} better, per 10% (team-margin plus-minus per match), ± one standard error; {args.appear} matches per build. Flagged insensitive: under 0.1 per 10% even at two standard errors up; unclear: within two standard errors of nothing, but not surely under 0.1.', '',
             '| Slot | What | Key stat | Rating | Per 10% better | Uses / match | Flag |', '| --- | --- | --- | --- | --- | --- | --- |']
    results = []
    for slot, w, tweaks, key in checks(args.better):
        if just and w not in just:
            continue
        family = ['--items'] if slot in ('offensive', 'support', 'ability') else []
        base = [sys.executable, str(ev.ROOT / 'balance' / 'sweep.py'), '--appear', str(args.appear), '--skill', str(args.skill), '--seed', str(args.seed), '--only', f'{slot}={w}', *family]
        control, tweaked = args.out / f'{w}-control', args.out / f'{w}-better'
        subprocess.run([*base, '--out', str(control)], check=True, capture_output=True)
        subprocess.run([*base, '--tweaks', json.dumps(tweaks), '--out', str(tweaked)], check=True, capture_output=True)
        c, t = (json.loads((d / 'ratings.json').read_text()) for d in (control, tweaked))
        (cm, cse), (tm, tse) = c['table'][f'{slot}/{w}/all'], t['table'][f'{slot}/{w}/all']
        steps = (args.better - 1) * 10
        per10, se = (tm - cm) / steps, math.hypot(cse, tse) / steps
        uses = c['use'][f'{slot}/{w}'][0]
        flag = 'bots can\'t use it' if uses < 0.1 else 'insensitive' if per10 + 2 * se < 0.1 else 'unclear: more matches' if abs(per10) < 2 * se else ''
        results.append((slot, w, key, cm, per10, se, uses, flag))
        print(f'{slot:9s} {w:14s} {cm:+.2f} per10 {per10:+.2f} ± {se:.2f} uses {uses:.1f} {flag}', flush=True)
    for slot, w, key, cm, per10, se, uses, flag in results:
        lines.append(f'| {slot} | {names[w]} | `{key}` | {cm:+.2f} | {per10:+.2f} ± {se:.2f} | {uses:.1f} | {flag} |')
    (args.out / 'report.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
