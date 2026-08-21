"""Repair proper nouns in machine-transcribed subtitles, library-wide.

WHY THIS EXISTS
    Whisper renders a name it was not told about phonetically: Guarnere
    becomes "Garnier", Perconte becomes "Pecani". Names it *was* given as
    hotwords come out right, so the failure is not the model - it is that
    Jellyfin's cast metadata lists a couple of dozen people per title and
    never lists places at all.

    A title that already owns real subtitles can teach us its own
    vocabulary: words used in that title and almost nowhere else in the
    library are, by definition, its proper nouns.

WHAT IT WILL NOT DO
    Rewrite ordinary words. An early version turned "Herr" into "Harry"
    nine times in Schindler's List and "Lane" into "Lynn" thirty times in
    one film. Every guard below exists because of a specific observed
    failure, and each one costs real corrections to keep the wrong ones
    out. That trade is deliberate: a bad fix invents dialogue nobody said.

USAGE
    namefix.py scan     build the word-frequency table (once, slow)
    namefix.py report   dry run - what would change, nothing written
    namefix.py apply    write the changes, keeping a .bak of each file
    namefix.py revert   restore every .bak this tool created

    namefix.py ranks        dry run of the rank-capitalisation pass
    namefix.py ranks-apply  write those (needs no glossary, so it also
                            reaches titles with no reference subtitles)
"""
import argparse
import collections
import io
import json
import os
import re
import unicodedata

# Unicode-aware on purpose. With an ASCII-only class the Danish
# "Kongedrabbrødrene" split at the ø, and a correction meant for a
# whole word was applied to the fragment before it.
WORD = re.compile(r"[^\W\d_](?:[^\W\d_]|['\-])*")
CUE_RE = re.compile(r'(\d+)\n([\d:,]+ --> [\d:,]+)\n(.*?)(?=\n\s*\n|\Z)', re.S)
BACKUP_SUFFIX = '.namefix.bak'
NEWLINE = chr(10)

# A word appearing in more titles than this is ordinary vocabulary and is
# never rewritten into somebody's surname.
DF_MAX = 3
# Harvest thresholds: a term must be rare library-wide and actually recur
# inside its own title, or a single mis-hearing becomes a "reference".
HARVEST_DF_MAX = 2
HARVEST_MIN_HITS = 2
HARVEST_MIN_LEN = 4
# Distance ceiling for a correction, once the sounds already match.
MAX_EDITS = 3
# A correction must aim at a spelling the title uses at least this many
# times more often than the one being replaced.
CANONICAL_RATIO = 3

RANKS_AND_FILLER = {
    'i', 'we', 'you', 'he', 'she', 'it', 'they', 'the', 'a', 'an', 'and', 'or', 'but',
    'so', 'of', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'sir', 'yes', 'no', 'ok',
    'okay', 'god', 'jesus', 'christ', 'mr', 'mrs', 'ms', 'dr', 'captain', 'lieutenant',
    'sergeant', 'private', 'corporal', 'major', 'colonel', 'general', 'commander',
    'company', 'easy', 'dog', 'fox', 'able', 'baker', 'sarge', 'doc', 'chief',
}


def title_of(path):
    """The library folder a file belongs to - the unit a glossary covers.

    Episodes of one show share a title, so a name recurring across a show's
    own episodes still counts as title-specific rather than as ordinary
    English."""
    parts = path.replace(chr(92), '/').split('/')
    for i, part in enumerate(parts):
        if part.lower() in ('shows', 'movies') and i + 1 < len(parts):
            return parts[i + 1]
    return parts[-1] if parts else path


def fold(s):
    s = unicodedata.normalize('NFD', s)
    return ''.join(c for c in s if not unicodedata.combining(c)).lower()


def skeleton(word):
    """Consonant skeleton: first letter, then consonants, doubles collapsed.

    Guarnere and Garnier both reduce to g-r-n-r. Two spellings of one sound
    is exactly the shape of this failure, so matching on consonants finds
    them where ordinary edit distance does not."""
    w = re.sub(r'[^a-z]', '', fold(word))
    if not w:
        return ''
    out = [w[0]]
    for ch in w[1:]:
        if ch in 'aeiouy' or (out and out[-1] == ch):
            continue
        out.append(ch)
    return ''.join(out)


def edit(a, b, cap):
    """Levenshtein, abandoned as soon as it exceeds cap."""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def read_text(path):
    with io.open(path, encoding='utf-8-sig', errors='replace') as fh:
        return fh.read().replace('\r\n', '\n')


def looks_human(path):
    """Is this a person's subtitle, or a machine's?

    It matters enormously: a machine transcription used as a reference
    teaches the tool its own mis-hearings as if they were ground truth.
    That is how "Barbas" came to be "corrected" into Barbus - the only
    Charmed subtitles containing the name at all were machine-made.

    Our own marker is not enough to tell them apart, because output from
    before the marker existed carries none. Speaker dashes and italics are
    the giveaway: 97% of our known output has neither, against 20% of
    everything else."""
    try:
        text = read_text(path)
    except OSError:
        return False
    cues = text.count('-->')
    if not cues:
        return False
    dashes = len(re.findall(r'(?m)^\s*-\s+', text))
    return text.count('<i>') > 0 or (dashes / cues) >= 0.02


class Glossary:
    def __init__(self, terms):
        self.terms = {}
        self.by_skel = collections.defaultdict(set)
        for term in terms:
            for word in WORD.findall(term):
                if len(word) < 3:
                    continue
                # Cast lists describe some parts by relation - "Davina's
                # Mother", "Hayley's Dad" - and splitting those into words
                # turns the possessive into a "name". It then proposed
                # Danish "Davinas magt" -> "Davina's magt", which is not
                # even correct Danish. A possessive is never a name.
                if word.lower().endswith("'s"):
                    continue
                self.terms[fold(word)] = word
                self.by_skel[skeleton(word)].add(word)

    def suggest(self, token):
        """The correct spelling for token, or None to leave it alone.

        A possessive is split off first: "Garnier's" has the skeleton grnrs,
        which matches nothing, and possessives are how names most often
        appear in dialogue."""
        suffix = ''
        m = re.search(r"('s|')$", token)
        if m:
            suffix, token = m.group(1), token[:m.start()]
        f = fold(token)
        if f in self.terms:
            return None                      # already correct
        best, best_d = None, 99
        for cand in self.by_skel.get(skeleton(token), ()):
            d = edit(f, fold(cand), MAX_EDITS)
            if d < best_d and abs(len(f) - len(cand)) <= 2:
                best, best_d = cand, d
        if best is None or best_d > MAX_EDITS:
            return None
        return best + suffix


def harvest(paths, df):
    """Learn a title's proper nouns from subtitles it already owns.

    Case is not usable as a filter - real subtitles often lowercase names
    after the first word ("lieutenant dike", "thank you, perconte") - so
    rarity across the library is the signal instead.

    Returns (terms, attested, counts):
      terms    candidate spellings a correction may aim AT
      attested every word these subtitles use at all - a token in here is
               spelled the way the title itself spells it and must never be
               "corrected". Without this the rarity cap silently excluded
               the right spelling while admitting a rarer variant, and the
               pass rewrote Pawnee into "Pawnean" 339 times.
      counts   how often each spelling occurs here, so the commoner of two
               rival spellings can be recognised as the canonical one."""
    counts = collections.Counter()
    casing = collections.defaultdict(collections.Counter)
    for p in paths:
        try:
            text = read_text(p)
        except OSError:
            continue
        for line in text.split('\n'):
            if '-->' in line or line.strip().isdigit():
                continue
            for w in WORD.findall(line):
                # A possessive is not a different name. Harvesting "Anubis'"
                # as its own term made the pass "correct" Anubis to Anubis',
                # and then Anubis' to Anubis''.
                w = w.rstrip("'").replace("'s", "") if w.endswith("'") else re.sub(r"'s$", '', w)
                if not w:
                    continue
                counts[w.lower()] += 1
                casing[w.lower()][w] += 1

    attested = set(counts)
    terms = []
    for word, n in counts.items():
        if n < HARVEST_MIN_HITS or len(word) < HARVEST_MIN_LEN:
            continue
        if df.get(word, 0) > HARVEST_DF_MAX:
            continue
        forms = casing[word]
        capitalised = [f for f in forms if f[0].isupper()]
        terms.append(max(capitalised, key=lambda f: forms[f]) if capitalised
                     else word.capitalize())
    return terms, attested, counts


def corrections(text, gloss, df, attested=frozenset(), counts=None, allow=None):
    """Every change this pass would make to one cue.

    Walks the words instead of substituting on a context-matching pattern:
    re.sub consumes the context it matches, so in a roll call ("Toy,
    Pecani, Lipton") each match eats the separator the next one needs and
    every other name is silently skipped."""
    spans = list(WORD.finditer(text))
    out, last, hits = [], 0, []
    for pos, m in enumerate(spans):
        token = m.group(0)
        if not token[0].isupper() or fold(token) in RANKS_AND_FILLER:
            continue

        before = text[:m.start()].rstrip()
        starts_sentence = (not before) or before[-1] in '.!?'
        # At a sentence start every word is capitalised, so capitalisation
        # says nothing; only longer tokens are eligible there, which keeps
        # a short real word ("Toy soldiers...") safe.
        if starts_sentence and len(token.rstrip("'s")) < 5:
            continue

        bare = fold(re.sub(r"'s$|'$", '', token))
        # The title's own subtitles already use this spelling, so it is the
        # title's spelling. Nothing rarer may displace it.
        if bare in attested:
            continue

        sug = gloss.suggest(token)
        if not sug or sug == token:
            continue

        # Of two rival spellings the one the title uses far more often is
        # the canonical one; only correct decisively in that direction.
        if counts:
            target = fold(re.sub(r"'s$|'$", '', sug))
            if counts.get(target, 0) < CANONICAL_RATIO * max(1, counts.get(bare, 0)):
                continue
        if df.get(bare, 0) > DF_MAX:
            # An ordinary word. The only admissible change is a pure suffix
            # extension (Toy -> Toye), and even that needs a neighbouring
            # known name: the same rule produced a correct "Joe Toye Day"
            # and a wrong "Purple Toye" within one file.
            plain = fold(sug.rstrip("'s"))
            if not (plain.startswith(bare) and len(plain) - len(bare) <= 2):
                continue
            neighbours = []
            if pos:
                neighbours.append(spans[pos - 1].group(0))
            if pos + 1 < len(spans):
                neighbours.append(spans[pos + 1].group(0))
            if not any(fold(n.rstrip("'s")) in gloss.terms for n in neighbours):
                continue

        if allow is not None and (token, sug) not in allow:
            continue

        out.append(text[last:m.start()])
        out.append(sug)
        last = m.end()
        hits.append((token, sug))
    out.append(text[last:])
    return ''.join(out), hits


def process_file(path, gloss, df, attested=frozenset(), counts=None, allow=None):
    raw = read_text(path)
    changes = []

    def fix(m):
        body = m.group(3)
        new, hits = corrections(body, gloss, df, attested, counts, allow)
        if hits:
            changes.append((m.group(1), body, new, hits))
        return '%s\n%s\n%s' % (m.group(1), m.group(2), new)

    return CUE_RE.sub(fix, raw), changes


# A rank is capitalised when it is used as a title in front of a name
# ("Captain Sobel") and lowercase otherwise ("the captain"). Whisper gets
# this wrong about half the time.
#
# Kinship terms are deliberately absent. "father", "brother", "sister" and
# "mother" precede a name constantly without being titles - "my brother
# Dave" - and "miss" is usually the verb, as in "I miss Sarah". Together
# those account for 3,600 of the 7,900 candidates in this library, and
# nearly all of them would have been wrong.
TITLE_RANKS = (
    'captain', 'lieutenant', 'sergeant', 'corporal', 'private', 'colonel',
    'general', 'commander', 'admiral', 'major', 'doctor', 'officer', 'agent',
    'detective', 'sheriff', 'deputy', 'professor', 'president', 'senator',
    'judge', 'inspector', 'constable', 'marshal', 'governor', 'chief',
)
# In front of one of these the word is a common noun, not a title:
# "the doctor Smith recommended", "a general Johnson mentioned".
RANK_BLOCKERS = {
    'my', 'your', 'his', 'her', 'our', 'their', 'its', 'the', 'a', 'an',
    'this', 'that', 'these', 'those', 'some', 'any', 'every', 'no', 'one',
    'another', 'other', 'own', 'former', 'late', 'old', 'young', 'dear',
}
RANK_RE = re.compile(r'\b(' + '|'.join(TITLE_RANKS) + r')(\s+)([A-Z][a-z]{2,})')


def fix_ranks(text):
    """Capitalise a rank that is acting as a title before a name."""
    hits = []

    def repl(m):
        rank, gap, name = m.group(1), m.group(2), m.group(3)
        if rank[0].isupper():
            return m.group(0)
        before = text[:m.start()].rstrip()
        prev = re.search(r"([A-Za-z']+)$", before)
        if prev and prev.group(1).lower() in RANK_BLOCKERS:
            return m.group(0)
        fixed = rank[0].upper() + rank[1:]
        hits.append((rank + ' ' + name, fixed + ' ' + name))
        return fixed + gap + name

    return RANK_RE.sub(repl, text), hits


def is_english(path):
    """Only English subtitles are in scope.

    Every rule here is English orthography - which words are common, when a
    capital means a name, how a possessive is written. Danish forms its
    genitive without an apostrophe, so "Davinas magt" is already correct and
    "Davina's magt" is not. 104 Danish files were in range before this."""
    name = os.path.basename(path).lower()
    parts = name.split('.')
    return any(p in ('en', 'eng', 'english') for p in parts[1:-1] if p)


def load_list(path):
    return [l.strip() for l in io.open(path, encoding='utf-8-sig') if l.strip()]


def load_df(path):
    df = {}
    with io.open(path, encoding='utf-8') as fh:
        for line in fh:
            w, _, c = line.partition('\t')
            if c.strip().isdigit():
                df[w] = int(c)
    return df


def cmd_scan(args):
    """Document frequency: how many distinct titles use each word."""
    files = load_list(args.all_subs)
    per_title = collections.defaultdict(set)
    for n, p in enumerate(files):
        try:
            text = read_text(p)
        except OSError:
            continue
        t = title_of(p)
        for w in WORD.findall(text):
            per_title[t].add(w.lower())
        if n % 1000 == 0:
            print('  %d/%d' % (n, len(files)), flush=True)
    df = collections.Counter()
    for words in per_title.values():
        for w in words:
            df[w] += 1
    with io.open(args.freq, 'w', encoding='utf-8') as fh:
        for w, c in df.most_common():
            fh.write('%s\t%d\n' % (w, c))
    print('titles=%d  distinct words=%d  -> %s' % (len(per_title), len(df), args.freq))


def run(args, write):
    df = load_df(args.freq)
    every = [p for p in load_list(args.our_subs) if p.lower().endswith('.srt')]
    ours = [p for p in every if is_english(p)]
    print('subtitles in scope     : %d of %d (English only)' % (len(ours), len(every)))
    refs = load_list(args.ref_subs)

    ours_by = collections.defaultdict(list)
    refs_by = collections.defaultdict(list)
    for p in ours:
        ours_by[title_of(p)].append(p)
    for p in refs:
        refs_by[title_of(p)].append(p)

    extra = {}
    if args.extra_terms and os.path.exists(args.extra_terms):
        extra = json.load(io.open(args.extra_terms, encoding='utf-8'))

    # Harvesting alone runs at roughly half precision: it cannot know that
    # Barbas is right and Barbus wrong, because the only local evidence is
    # a subtitle that says Barbus. So the pass proposes, and an approvals
    # file decides. Without one, nothing is written.
    approved = None
    if args.approved and os.path.exists(args.approved):
        approved = set()
        for line in io.open(args.approved, encoding='utf-8'):
            if line.startswith('#') or not line.strip():
                continue
            parts = [c.strip() for c in line.rstrip('\n').split('\t')]
            if len(parts) >= 3:
                approved.add((parts[0], parts[1], parts[2]))
        print('approvals loaded: %d' % len(approved))
    if write and approved is None:
        raise SystemExit('refusing to apply without an approvals file (--approved); '
                         'run "report" first and review the decisions')

    report = []
    totals = collections.Counter()
    pairs = collections.Counter()
    for title in sorted(ours_by):
        # Only genuine human subtitles may act as references.
        sources = [p for p in refs_by.get(title, []) if looks_human(p)]
        if sources:
            terms, attested, counts = harvest(sources, df)
        else:
            terms, attested, counts = [], set(), collections.Counter()
        terms += extra.get(title, [])
        if not terms:
            totals['titles_without_glossary'] += 1
            totals['files_skipped'] += len(ours_by[title])
            continue
        totals['titles_with_glossary'] += 1
        gloss = Glossary(terms)
        allow = None
        if approved is not None:
            allow = {(w, n) for (t, w, n) in approved if t == title}
            if not allow:
                continue
        for path in ours_by[title]:
            try:
                new, changes = process_file(path, gloss, df, attested, counts, allow)
            except OSError as exc:
                print('  !! %s: %s' % (os.path.basename(path), exc))
                totals['errors'] += 1
                continue
            totals['files_examined'] += 1
            if not changes:
                continue
            totals['files_changed'] += 1
            for _, _, _, hits in changes:
                for was, now in hits:
                    pairs[(title, was, now)] += 1
                    totals['replacements'] += 1
            report.append((title, path, changes))
            if write:
                backup = path + BACKUP_SUFFIX
                if not os.path.exists(backup):
                    with io.open(path, encoding='utf-8-sig', errors='replace', newline='') as fh:
                        original = fh.read()
                    io.open(backup, 'w', encoding='utf-8', newline='').write(original)
                io.open(path, 'w', encoding='utf-8', newline='\n').write(new)

    with io.open(args.out, 'w', encoding='utf-8') as fh:
        for title, path, changes in report:
            fh.write('== %s\n   %s\n' % (title, path))
            for idx, before, after, hits in changes:
                fh.write('   cue %s  %s\n' % (idx, ', '.join('%s->%s' % h for h in hits)))
                fh.write('      - %s\n' % before.replace('\n', ' '))
                fh.write('      + %s\n' % after.replace('\n', ' '))

    print()
    print('titles with a glossary : %d' % totals['titles_with_glossary'])
    print('titles without one     : %d  (%d files skipped)' % (
        totals['titles_without_glossary'], totals['files_skipped']))
    print('files examined         : %d' % totals['files_examined'])
    print('files changed          : %d' % totals['files_changed'])
    print('replacements           : %d' % totals['replacements'])
    if totals['errors']:
        print('unreadable files       : %d' % totals['errors'])
    print('detail written to      : %s' % args.out)
    print()
    print('most common corrections:')
    for (title, was, now), n in pairs.most_common(30):
        print('   %-28s %-16s -> %-16s x%d' % (title[:28], was, now, n))
    return pairs


def cmd_ranks(args, write=False):
    """Capitalise ranks used as titles. Needs no glossary, so it reaches the
    machine-transcribed files that have no reference subtitles either."""
    ours = [p for p in load_list(args.our_subs)
            if p.lower().endswith('.srt') and is_english(p)]
    total = collections.Counter()
    samples = []
    for path in ours:
        try:
            raw = read_text(path)
        except OSError:
            total['unreadable'] += 1
            continue
        changes = []

        def fix(m):
            body = m.group(3)
            new, hits = fix_ranks(body)
            if hits:
                changes.append((m.group(1), body, new, hits))
            return NEWLINE.join((m.group(1), m.group(2), new))

        new_text = CUE_RE.sub(fix, raw)
        if not changes:
            continue
        total['files'] += 1
        for _, before, after, hits in changes:
            for was, now in hits:
                total['replacements'] += 1
                total[was.split()[0].lower()] += 1
            if len(samples) < 25:
                samples.append((os.path.basename(path), before, after))
        if write:
            backup = path + BACKUP_SUFFIX
            if not os.path.exists(backup):
                with io.open(path, encoding='utf-8-sig', errors='replace', newline='') as fh:
                    io.open(backup, 'w', encoding='utf-8', newline='').write(fh.read())
            io.open(path, 'w', encoding='utf-8', newline=NEWLINE).write(new_text)

    print('files changed : %d' % total['files'])
    print('replacements  : %d' % total['replacements'])
    print()
    print('by rank:')
    for r in TITLE_RANKS:
        if total.get(r):
            print('   %-12s %d' % (r, total[r]))
    print()
    print('samples:')
    for name, before, after in samples[:12]:
        print('   %s' % name[:44])
        print('      - %s' % before.replace(NEWLINE, ' ')[:96])
        print('      + %s' % after.replace(NEWLINE, ' ')[:96])


def cmd_ranks_apply(args):
    cmd_ranks(args, write=True)


def cmd_report(args):
    run(args, write=False)


def cmd_apply(args):
    run(args, write=True)


def cmd_revert(args):
    restored = 0
    for p in load_list(args.our_subs):
        b = p + BACKUP_SUFFIX
        if os.path.exists(b):
            with io.open(b, encoding='utf-8-sig', errors='replace', newline='') as fh:
                original = fh.read()
            io.open(p, 'w', encoding='utf-8', newline='').write(original)
            os.remove(b)
            restored += 1
    print('restored %d file(s) from %s' % (restored, BACKUP_SUFFIX))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['scan', 'report', 'apply', 'revert',
                                        'ranks', 'ranks-apply'])
    ap.add_argument('--all-subs', default=os.path.join(here, 'all_subs.txt'))
    ap.add_argument('--our-subs', default=os.path.join(here, 'our_subs.txt'))
    ap.add_argument('--ref-subs', default=os.path.join(here, 'ref_subs.txt'))
    ap.add_argument('--freq', default=os.path.join(here, 'wordfreq.txt'))
    ap.add_argument('--extra-terms', default=os.path.join(here, 'extra_terms.json'),
                    help='optional {title: [names]} for titles with no reference subtitles')
    ap.add_argument('--approved', default=os.path.join(here, 'approved.tsv'),
                    help='tab-separated title/wrong/right; only these are written')
    ap.add_argument('--out', default=os.path.join(here, 'namefix-report.txt'))
    args = ap.parse_args()
    {'scan': cmd_scan, 'report': cmd_report, 'apply': cmd_apply,
     'revert': cmd_revert, 'ranks': cmd_ranks,
     'ranks-apply': cmd_ranks_apply}[args.command](args)


if __name__ == '__main__':
    main()
