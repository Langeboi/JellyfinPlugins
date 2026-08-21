"""Build per-title name lists from IMDb's public datasets.

Harvesting names from a title's own subtitles only works when it has some.
230 titles here have none - almost all of them films - and for those the
names have to come from somewhere else.

IMDb publishes bulk dumps at https://datasets.imdbws.com/ under a
non-commercial licence, no API key. title.principals.tsv.gz carries a
`characters` column, which is the part that matters: character names are
what dialogue actually says. Jellyfin already stores an IMDb id for every
title in this library, so the join is exact rather than fuzzy name
matching.

For a series the cast lives on the individual episode rows, so
title.episode.tsv.gz is used to map episodes back to their series and the
whole roster is gathered.

    imdb_terms.py --ids received.json --out extra_terms.json

Output is {library title: [names]}, which namefix.py reads directly.
"""
import argparse
import collections
import gzip
import io
import json
import os
import re
import sys

# Roles that describe a function rather than name a person. They would only
# add noise to a glossary - and worse, act as targets a real word could be
# "corrected" into.
GENERIC = {
    'self', 'narrator', 'host', 'guest', 'various', 'uncredited', 'extra',
    'man', 'woman', 'boy', 'girl', 'nurse', 'doctor', 'cop', 'police officer',
    'soldier', 'guard', 'waiter', 'waitress', 'bartender', 'reporter',
    'student', 'teacher', 'driver', 'pilot', 'clerk', 'secretary', 'judge',
    'lawyer', 'prisoner', 'thug', 'gangster', 'villager', 'passenger',
    'customer', 'patient', 'detective', 'agent', 'officer', 'captain',
    'sergeant', 'lieutenant', 'colonel', 'general', 'commander', 'young man',
    'young woman', 'old man', 'old woman', 'additional voices',
}
NAME_OK = re.compile(r"^[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F' .\-]*$")


def clean(raw):
    """A usable name, or None.

    IMDb character fields carry a lot that never reaches dialogue:
    parentheticals ("Murph (10 Yrs.)"), segment markers, pure job labels."""
    s = re.sub(r'\([^)]*\)', ' ', raw or '')
    s = re.sub(r'\s+', ' ', s).strip().strip('"').strip()
    s = s.rstrip(',;:')
    if len(s) < 3 or len(s) > 30:
        return None
    if s.lower() in GENERIC:
        return None
    if any(ch.isdigit() for ch in s):
        return None
    if len(s.split(' ')) > 3:
        return None
    if not NAME_OK.match(s):
        return None
    return s


def load_ids(path):
    """Read every JSON payload the Jellyfin page posted to the receiver.

    There may be several: the ids and movie cast in one, episode-level cast
    for particular series in another. Later payloads add to earlier ones
    rather than replacing them."""
    ids, people = {}, collections.defaultdict(dict)
    found = 0
    with io.open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.strip()
            if not line.startswith('{'):
                continue
            try:
                blob = json.loads(line)
            except ValueError:
                continue
            found += 1
            ids.update(blob.get('ids', {}))
            # Cast from Jellyfin: movie-level in "people", and for series
            # that have no reference subtitles, episode-level in "epPeople".
            # IMDb's dump lists only the ~10 principal cast per title, so for
            # a short series it is thin - Band of Brothers gets 34 names from
            # IMDb against 64 from Jellyfin's own episode records.
            for key in ('people', 'epPeople'):
                for title, bag in (blob.get(key) or {}).items():
                    people[title].update(bag)
    if not found:
        raise SystemExit('no JSON payload found in %s' % path)
    out = {}
    for title, v in ids.items():
        imdb = v[0] if isinstance(v, (list, tuple)) else v
        kind = v[2] if isinstance(v, (list, tuple)) and len(v) > 2 else 'M'
        if imdb:
            out[title] = (imdb, kind)
    print('payloads read          : %d' % found)
    return out, people


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', required=True)
    ap.add_argument('--imdb-dir', default=r'C:\subtitle-worker\imdb')
    ap.add_argument('--out', default=os.path.join(here, 'extra_terms.json'))
    args = ap.parse_args()

    titles, people = load_ids(args.ids)
    print('titles with an IMDb id : %d' % len(titles))

    by_tconst = collections.defaultdict(list)   # tconst -> [library titles]
    series = {}                                 # series tconst -> library title
    for title, (tconst, kind) in titles.items():
        by_tconst[tconst].append(title)
        if kind == 'S':
            series[tconst] = title
    print('of which series        : %d' % len(series))

    # Episodes belong to their series, so their cast rows count too.
    ep_path = os.path.join(args.imdb_dir, 'title.episode.tsv.gz')
    episodes = 0
    with gzip.open(ep_path, 'rt', encoding='utf-8', errors='replace') as fh:
        next(fh, None)
        for line in fh:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 2:
                continue
            parent = parts[1]
            if parent in series:
                by_tconst[parts[0]].append(series[parent])
                episodes += 1
    print('episode rows mapped    : %d' % episodes)

    terms = collections.defaultdict(collections.Counter)
    pr_path = os.path.join(args.imdb_dir, 'title.principals.tsv.gz')
    seen_rows = matched = 0
    with gzip.open(pr_path, 'rt', encoding='utf-8', errors='replace') as fh:
        header = next(fh, '').rstrip('\n').split('\t')
        try:
            ci = header.index('characters')
        except ValueError:
            raise SystemExit('no characters column: %s' % header)
        for line in fh:
            seen_rows += 1
            if seen_rows % 10000000 == 0:
                print('  %d million rows...' % (seen_rows // 1000000), flush=True)
            tab = line.find('\t')
            if tab < 0:
                continue
            tconst = line[:tab]
            owners = by_tconst.get(tconst)
            if not owners:
                continue
            parts = line.rstrip('\n').split('\t')
            if len(parts) <= ci:
                continue
            raw = parts[ci]
            if not raw or raw == '\\N':
                continue
            matched += 1
            try:
                names = json.loads(raw)
            except ValueError:
                names = [raw]
            for n in names:
                c = clean(n)
                if c:
                    for owner in owners:
                        terms[owner][c] += 1

    # Jellyfin's own cast, where we have it, is a second opinion for free.
    for title, bag in (people or {}).items():
        for raw in bag:
            c = clean(raw)
            if c:
                terms[title][c] += 1

    out = {t: [n for n, _ in c.most_common()] for t, c in terms.items() if c}
    io.open(args.out, 'w', encoding='utf-8').write(
        json.dumps(out, ensure_ascii=False, indent=1))
    print()
    print('rows scanned           : %d' % seen_rows)
    print('cast rows for our library: %d' % matched)
    print('titles with names      : %d' % len(out))
    print('total names            : %d' % sum(len(v) for v in out.values()))
    print('written                : %s' % args.out)
    biggest = sorted(out, key=lambda t: -len(out[t]))[:8]
    print()
    for t in biggest:
        print('   %-44s %d names' % (t[:44], len(out[t])))


if __name__ == '__main__':
    main()
