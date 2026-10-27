#!/usr/bin/env python3
"""What falls outside its band (balance/bands.json) in a round's baseline: the weapon and item
sweeps (`weapons-<aim>`, `items-<aim>` from sweep.py) and threat_probe's table (`threat-probe.txt`)
in the round's folder.

  python3 balance/bands.py balance/out/r1
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAMES = {w['id']: w['name'] for lst in json.loads((ROOT / 'weapons.json').read_text()).values() if isinstance(lst, list) for w in lst}
NAMES |= {'A': 'Light', 'B': 'Medium', 'C': 'Heavy'}
RANGES = [10, 20, 30, 45, 60, 80]


def strength(folder, bands):
    """Rows (slot, what, aim, rating, median, status) for every rating in the sweeps."""
    rows = []
    for aim in bands['strength']['aims']:
        table = {}
        for family in ('weapons', 'items'):
            path = folder / f'{family}-{aim}' / 'ratings.json'
            if path.exists():
                table |= json.loads(path.read_text())['table']
        slots = {}
        for key, (m, se) in table.items():
            slot, what, cls = key.split('/')
            if cls == 'all':
                slots.setdefault(slot, []).append((what, m, se))
        for slot, entries in slots.items():
            ratings = sorted(m for _, m, _ in entries)
            median = ratings[len(ratings) // 2] if len(ratings) % 2 else 0.5 * (ratings[len(ratings) // 2 - 1] + ratings[len(ratings) // 2])
            for what, m, se in entries:
                off = m - median
                out = abs(off) - 2 * se > bands['strength']['spread']
                rows.append((slot, what, aim, m, se, median, 'OUT' if out else 'ok'))
    return rows


def ranges(folder, bands):
    """Rows (what, band, rank, wanted, status) from threat_probe's played damage."""
    path = folder / 'threat-probe.txt'
    if not path.exists():
        return []
    played = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) > 2 and parts[1] == '-':
            played[parts[0]] = [float(cell.split('/')[0]) for cell in re.findall(r'(\d+\.\d+/\d+\.\d+)\s+\d+\.\d+/\d+\.\d+', line)]
    rows = []
    for band, (lo, hi) in bands['range']['bands'].items():
        cols = [k for k, r in enumerate(RANGES) if lo <= r <= hi]
        mean = {w: sum(v[k] for k in cols) / len(cols) for w, v in played.items()}
        order = sorted(mean, key=lambda w: -mean[w])
        for w, roles in bands['range']['roles'].items():
            if band in roles:
                rank, (a, b) = order.index(w) + 1, roles[band]
                rows.append((w, band, rank, (a, b), mean[w], 'ok' if a <= rank <= b else 'OUT', [f'{NAMES.get(x, x)} {mean[x]:.1f}' for x in order]))
    return rows


def main():
    folder = Path(sys.argv[1])
    bands = json.loads((ROOT / 'balance' / 'bands.json').read_text())
    lines = [f'# Bands, {folder.name}', '']
    stamp = folder / 'STAMP'
    if stamp.exists():
        lines += ['Stamp: ' + stamp.read_text().split()[0][:10], '']
    lines += [f'## Strength: within {bands["strength"]["spread"]} of the slot median (two standard errors given)', '', '| Slot | What | Aim | Rating | Median | |', '| --- | --- | --- | --- | --- | --- |']
    for slot, what, aim, m, se, median, status in sorted(strength(folder, bands), key=lambda r: (r[6] != 'OUT', r[0], r[1], r[2])):
        lines.append(f'| {slot} | {NAMES.get(what, what)} | {aim} | {m:+.2f} ± {se:.2f} | {median:+.2f} | {status} |')
    lines += ['', '## Range roles: rank by played damage a second on a strafing Medium', '', '| What | Band | Rank | Wanted | | Order |', '| --- | --- | --- | --- | --- | --- |']
    for w, band, rank, (a, b), dps, status, order in ranges(folder, bands):
        lines.append(f'| {NAMES.get(w, w)} | {band} | {rank} ({dps:.1f}/s) | {a}-{b} | {status} | {", ".join(order)} |')
    text = '\n'.join(lines) + '\n'
    (folder / 'bands.md').write_text(text)
    print(text)


if __name__ == '__main__':
    main()
