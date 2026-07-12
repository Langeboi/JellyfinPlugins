"""Subtitle sync worker for the Subtitle Guard Jellyfin plugin.

Runs on a machine that can see the media files (e.g. the Debian container
on the TrueNAS host). Receives (media, subtitle) path pairs from the
plugin, runs ffsubsync to align each subtitle to its media's audio, and
replaces the subtitle file in place (keeping a .bak of the original the
first time it is modified).

Jobs are deduplicated by subtitle path + mtime in a small SQLite database,
so the plugin's scheduled task can blindly resubmit the whole library
every night and only new/changed subtitle files actually get processed.

Auth: every request must carry the X-Api-Key header matching the
SUBWORKER_API_KEY environment variable.
"""

import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import queue
import time
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

API_KEY = os.environ.get("SUBWORKER_API_KEY", "")
DB_PATH = os.environ.get("SUBWORKER_DB", os.path.expanduser("~/.subtitle-worker.db"))
# Offsets smaller than this are considered "already in sync" - the original
# file is left completely untouched.
MIN_OFFSET_SECONDS = float(os.environ.get("SUBWORKER_MIN_OFFSET", "0.4"))
# Offsets LARGER than this are almost always a mis-alignment (ffsubsync
# latched onto the wrong audio) rather than a real drift - applying them is
# what produced "way off" subtitles. Reject and keep the original instead.
MAX_OFFSET_SECONDS = float(os.environ.get("SUBWORKER_MAX_OFFSET", "60"))


def _resolve_ffsubsync() -> str:
    """ffsubsync is installed INTO this venv, but the systemd unit launches
    venv/bin/python directly - which does NOT put venv/bin on PATH for the
    subprocesses we spawn. Calling bare 'ffsubsync' therefore fails with
    'No such file or directory'. Resolve it next to the running interpreter
    (venv/bin/ffsubsync) so it's found regardless of PATH."""
    override = os.environ.get("SUBWORKER_FFSUBSYNC")
    if override:
        return override
    candidate = os.path.join(os.path.dirname(sys.executable), "ffsubsync")
    return candidate if os.path.exists(candidate) else "ffsubsync"


FFSUBSYNC = _resolve_ffsubsync()


def _detect_cuda() -> bool:
    try:
        subprocess.run(["nvidia-smi"], capture_output=True, timeout=10, check=True)
        return True
    except Exception:  # noqa: BLE001 - no nvidia-smi / no driver = no CUDA
        return False


# ---- Whisper transcription (optional capability) ----
# faster-whisper (CTranslate2) is installed by install.sh; if the import
# fails this worker simply advertises transcribe=None and only does sync.
try:
    from faster_whisper import WhisperModel  # noqa: F401

    _HAS_WHISPER = True
except Exception:  # noqa: BLE001 - treat any import problem as "not available"
    _HAS_WHISPER = False

WHISPER_DEVICE = os.environ.get("SUBWORKER_WHISPER_DEVICE") or ("cuda" if _detect_cuda() else "cpu")
# large-v3 is the model that is actually good at Danish; it needs a real GPU.
# CPU workers default to 'small' so a transcription doesn't take all night
# per movie - override with SUBWORKER_WHISPER_MODEL if you want to trade
# speed for quality.
WHISPER_MODEL_NAME = os.environ.get("SUBWORKER_WHISPER_MODEL") or (
    "large-v3" if WHISPER_DEVICE == "cuda" else "small"
)
TRANSCRIBE_CAPABILITY = WHISPER_DEVICE if _HAS_WHISPER else None

# Transcription thoroughness (slower = fewer missed words). Two levers:
#  - The VAD filter trims quiet/edge speech before Whisper ever sees it, which
#    is the usual cause of "missed a word here and there". A gentler threshold
#    (0.35 vs the 0.5 default) keeps quieter speech, and edge-padding stops
#    words at the start/end of a phrase getting clipped.
#  - A wider beam search recovers words the decoder was unsure about, at a
#    roughly linear time cost (beam 8 ~ 1.5x beam 5).
# All overridable via env if you want to push further (e.g. BEAM=10, or set
# VAD=0 to disable filtering entirely - most thorough, but large-v3 can then
# hallucinate a line over music/silence).
WHISPER_BEAM = int(os.environ.get("SUBWORKER_WHISPER_BEAM", "8"))
WHISPER_VAD = os.environ.get("SUBWORKER_WHISPER_VAD", "1") != "0"
WHISPER_VAD_THRESHOLD = float(os.environ.get("SUBWORKER_WHISPER_VAD_THRESHOLD", "0.35"))
WHISPER_VAD_PAD_MS = int(os.environ.get("SUBWORKER_WHISPER_VAD_PAD_MS", "400"))

_whisper_model = None
_whisper_lock = threading.Lock()


def get_whisper_model():
    """Lazy singleton: the model (~3GB for large-v3) downloads on first use
    and stays loaded so back-to-back jobs don't pay the load cost again."""
    global _whisper_model  # noqa: PLW0603
    with _whisper_lock:
        if _whisper_model is None:
            _whisper_model = WhisperModel(
                WHISPER_MODEL_NAME,
                device=WHISPER_DEVICE,
                compute_type="float16" if WHISPER_DEVICE == "cuda" else "int8",
            )
        return _whisper_model


def _srt_timestamp(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


# ---- NLLB translation (optional capability, GPU machines) ----
# The installer converts facebook/nllb-200-distilled-1.3B to a CTranslate2
# model (same engine faster-whisper already uses). Quality-first choice:
# NLLB is a dedicated translation model and the 1.3B distillation is close
# to 1:1 for English->Danish - it just takes a couple of minutes per movie,
# which was explicitly the acceptable trade-off.
NLLB_DIR = os.environ.get("SUBWORKER_NLLB_DIR", "/opt/subtitle-worker/nllb-ct2")
NLLB_TOKENIZER = os.environ.get("SUBWORKER_NLLB_TOKENIZER", "facebook/nllb-200-distilled-1.3B")

try:
    import ctranslate2  # noqa: F401

    _HAS_CT2 = True
except Exception:  # noqa: BLE001
    _HAS_CT2 = False

TRANSLATE_CAPABILITY = _HAS_CT2 and os.path.isdir(NLLB_DIR)

_translator = None
_nllb_tokenizer = None
_translate_lock = threading.Lock()


def get_translator():
    global _translator, _nllb_tokenizer  # noqa: PLW0603
    with _translate_lock:
        if _translator is None:
            from transformers import AutoTokenizer

            _nllb_tokenizer = AutoTokenizer.from_pretrained(NLLB_TOKENIZER, src_lang="eng_Latn")
            _translator = ctranslate2.Translator(
                NLLB_DIR,
                device=WHISPER_DEVICE,
                compute_type="float16" if WHISPER_DEVICE == "cuda" else "int8",
            )
        return _translator, _nllb_tokenizer


def translate_texts_en_to_da(texts):
    """Batch-translate English lines to Danish, preserving list order."""
    translator, tok = get_translator()
    out = []
    batch_size = 16
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        source = [tok.convert_ids_to_tokens(tok.encode(t)) for t in batch]
        results = translator.translate_batch(
            source,
            target_prefix=[["dan_Latn"]] * len(batch),
            beam_size=4,
        )
        for r in results:
            tokens = r.hypotheses[0]
            # drop the forced dan_Latn target-language token
            if tokens and tokens[0] == "dan_Latn":
                tokens = tokens[1:]
            out.append(tok.decode(tok.convert_tokens_to_ids(tokens), skip_special_tokens=True).strip())
    return out


SRT_BLOCK_RE = re.compile(
    r"(\d+)\s*\n(\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}[^\n]*)\n(.*?)(?=\n\s*\n|\Z)",
    re.DOTALL,
)


def parse_srt(text: str):
    """Returns [(timing_line, cue_text), ...] in order."""
    cues = []
    for m in SRT_BLOCK_RE.finditer(text):
        cue_text = m.group(3).strip()
        if cue_text:
            cues.append((m.group(2).strip(), cue_text))
    return cues


def wrap_cue(text: str, width: int = 42) -> str:
    """Rebalance a translated cue into at most two readable lines."""
    text = " ".join(text.split())
    if len(text) <= width:
        return text
    mid = len(text) // 2
    best = None
    for idx, ch in enumerate(text):
        if ch == " " and (best is None or abs(idx - mid) < abs(best - mid)):
            best = idx
    if best is None:
        return text
    return text[:best] + "\n" + text[best + 1:]


def process_translate_job(job: dict):
    media = job["media_path"]
    key = "translate:" + media

    if not TRANSLATE_CAPABILITY:
        record(key, 0, None, "no-translator")
        with state_lock:
            state["failed"] += 1
        return

    if not os.path.isfile(media):
        record(key, 0, None, "missing-file")
        with state_lock:
            state["failed"] += 1
        return

    mtime = os.path.getmtime(media)
    if already_processed(key, mtime):
        with state_lock:
            state["skipped"] += 1
        return

    target = os.path.splitext(media)[0] + ".da.srt"
    if os.path.exists(target):
        record(key, mtime, None, "already-has-sub")
        with state_lock:
            state["skipped"] += 1
        return

    tmp_extract = None
    try:
        # Source English subtitle: an external file when the plugin knows
        # one, otherwise extract the embedded stream with ffmpeg.
        source_path = job.get("subtitle_path")
        if not source_path and job.get("stream_index") is not None:
            fd, tmp_extract = tempfile.mkstemp(suffix=".srt")
            os.close(fd)
            proc = subprocess.run(
                ["ffmpeg", "-y", "-i", media, "-map", f"0:{int(job['stream_index'])}", tmp_extract],
                capture_output=True,
                text=True,
                timeout=900,
            )
            if proc.returncode != 0 or not os.path.getsize(tmp_extract):
                record(key, mtime, None, "extract-failed")
                with state_lock:
                    state["failed"] += 1
                return
            source_path = tmp_extract

        if not source_path or not os.path.isfile(source_path):
            record(key, mtime, None, "missing-source-sub")
            with state_lock:
                state["failed"] += 1
            return

        with open(source_path, "r", encoding="utf-8", errors="replace") as fh:
            cues = parse_srt(fh.read())
        if not cues:
            record(key, mtime, None, "empty-source-sub")
            with state_lock:
                state["failed"] += 1
            return

        # Translate cue texts (newlines flattened - NLLB translates whole
        # sentences better than fragments), then re-wrap for readability.
        translated = translate_texts_en_to_da([" ".join(c[1].split()) for c in cues])

        fd, tmp_out = tempfile.mkstemp(suffix=".srt")
        os.close(fd)
        with open(tmp_out, "w", encoding="utf-8") as fh:
            for i, ((timing, _), text) in enumerate(zip(cues, translated), start=1):
                fh.write(f"{i}\n{timing}\n{wrap_cue(text)}\n\n")
        shutil.move(tmp_out, target)

        record(key, mtime, None, "translated")
        with state_lock:
            state["done"] += 1
    except Exception as exc:  # noqa: BLE001 - keep the worker alive
        record(key, mtime, None, f"error: {exc}")
        with state_lock:
            state["failed"] += 1
    finally:
        if tmp_extract and os.path.exists(tmp_extract):
            os.unlink(tmp_extract)


# Cue-timing tuning. Whisper's SEGMENT timestamps are padded - a cue often
# starts before the line is spoken and lingers after it ends. When word
# timestamps are available we hug the actual speech (first word start ->
# last word end) instead, then apply a tiny lead-in, a readable minimum
# duration, and an anti-overlap pass.
CUE_LEAD_IN = 0.06           # show a hair before the first word
CUE_MIN_DURATION = 0.9       # never flash a cue faster than this
CUE_MAX_DURATION = 7.0       # never hold a cue longer than this
CUE_CHARS_PER_SEC = 16.0     # reading speed used to lengthen short cues
CUE_MIN_GAP = 0.04           # gap kept between consecutive cues

# Whisper emits one segment per phrase, so cue-per-segment gives a rapid
# flicker of short single lines. Instead we merge neighbouring segments into
# proper subtitles (up to 2 lines, standard ~42 chars/line) as long as the
# pause between them is short and the result stays readable in one glance.
CUE_MAX_LINE_CHARS = 42      # per-line width before wrapping to a 2nd line
CUE_MAX_LINES = 2            # cap at a 2-line block (subtitle convention)
CUE_MAX_CHARS = CUE_MAX_LINE_CHARS * CUE_MAX_LINES  # merge budget
CUE_MERGE_MAX_GAP = 0.9      # don't merge across a pause longer than this


def _tight_bounds(segment):
    """(start, end) hugging real speech via word timestamps, or the raw
    segment bounds when word timing isn't available."""
    words = getattr(segment, "words", None) or []
    words = [w for w in words if getattr(w, "start", None) is not None and getattr(w, "end", None) is not None]
    if words:
        return words[0].start, words[-1].end
    return segment.start, segment.end


def _wrap_lines(text: str) -> str:
    """Wrap a cue's text to at most CUE_MAX_LINES balanced lines. A single
    short line is left alone; a long line is split near the middle at a word
    boundary so both halves fit CUE_MAX_LINE_CHARS."""
    if len(text) <= CUE_MAX_LINE_CHARS:
        return text
    words = text.split()
    # Prefer a 2-line split that balances the two halves (smallest length
    # difference) while keeping both within the per-line width.
    best = None
    for i in range(1, len(words)):
        top = " ".join(words[:i])
        bottom = " ".join(words[i:])
        if len(top) <= CUE_MAX_LINE_CHARS and len(bottom) <= CUE_MAX_LINE_CHARS:
            score = abs(len(top) - len(bottom))
            if best is None or score < best[0]:
                best = (score, top + "\n" + bottom)
    if best is not None:
        return best[1]
    # Too long for 2 lines (a very long single segment) - greedily wrap into
    # as many lines as needed rather than dropping any words.
    lines, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > CUE_MAX_LINE_CHARS:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def write_srt(segments, path: str) -> int:
    """Build a tightly-timed SRT from Whisper segments. Consuming the
    generator is where the transcription time is actually spent."""
    cues = []  # [start, end, text]
    for segment in segments:
        text = " ".join(segment.text.split())
        if not text:
            continue
        start, end = _tight_bounds(segment)
        cues.append([max(0.0, start - CUE_LEAD_IN), end, text])

    # Merge neighbouring cues into 2-line subtitles: keeps dialogue together
    # and stops the fast single-line flicker. Only merge across a short pause,
    # while the combined text fits the 2-line budget and the block stays
    # within the max on-screen duration.
    merged = []
    for cue in cues:
        if merged:
            prev = merged[-1]
            gap = cue[0] - prev[1]
            combined_chars = len(prev[2]) + 1 + len(cue[2])
            combined_dur = cue[1] - prev[0]
            if (gap <= CUE_MERGE_MAX_GAP
                    and combined_chars <= CUE_MAX_CHARS
                    and combined_dur <= CUE_MAX_DURATION):
                prev[1] = cue[1]
                prev[2] = f"{prev[2]} {cue[2]}"
                continue
        merged.append(list(cue))
    cues = merged

    # Readable minimum duration: longer for longer lines, floored so short
    # lines don't blink out, capped so nothing lingers too long.
    for cue in cues:
        want = min(CUE_MAX_DURATION, max(CUE_MIN_DURATION, len(cue[2]) / CUE_CHARS_PER_SEC))
        if cue[1] - cue[0] < want:
            cue[1] = cue[0] + want

    # Anti-overlap: if a stretched cue runs into the next one, pull its end
    # back to just before the next cue starts (keeping it at least visible).
    for i in range(len(cues) - 1):
        if cues[i][1] > cues[i + 1][0] - CUE_MIN_GAP:
            cues[i][1] = max(cues[i][0] + 0.3, cues[i + 1][0] - CUE_MIN_GAP)

    count = 0
    with open(path, "w", encoding="utf-8") as fh:
        for start, end, text in cues:
            if end <= start:
                continue
            count += 1
            fh.write(f"{count}\n{_srt_timestamp(start)} --> {_srt_timestamp(end)}\n{_wrap_lines(text)}\n\n")
    return count

app = FastAPI(title="subtitle-sync-worker")

# How many jobs run in parallel. ffsubsync is single-threaded, so an 8-core
# machine doing one job at a time wastes most of its CPU - but each parallel
# job also reads a full media file over the network, so this is as much a
# bandwidth knob as a CPU one. Override with SUBWORKER_SYNC_CONCURRENCY.
SYNC_CONCURRENCY = int(
    os.environ.get("SUBWORKER_SYNC_CONCURRENCY", "0")
) or min(4, max(1, (os.cpu_count() or 2) - 1))

job_queue: "queue.Queue[dict]" = queue.Queue()
state = {
    "processing": {},  # thread name -> label of the job it is running
    "done": 0,
    "skipped": 0,
    "failed": 0,
    "paused": False,
    "started_at": datetime.now(timezone.utc).isoformat(),
}
state_lock = threading.Lock()

# set = running, cleared = paused. Threads finish their current job and
# then wait; pausing never kills work mid-file. The paused state persists
# across restarts via a flag file - a machine you paused stays paused after
# a reboot instead of silently rejoining the pool.
PAUSE_FLAG = os.environ.get(
    "SUBWORKER_PAUSE_FLAG", os.path.join(os.path.dirname(DB_PATH) or ".", ".subworker-paused")
)
pause_event = threading.Event()
if os.path.exists(PAUSE_FLAG):
    state["paused"] = True
else:
    pause_event.set()

# Only ONE transcription at a time regardless of concurrency - a second
# large-v3 on the same GPU would OOM, and on CPU it would thrash. Sync jobs
# keep flowing on the other threads while a transcription runs.
transcribe_job_lock = threading.Lock()

# ---- Work stealing ----
# The plugin distributes each worker's peer list (url + key). When this
# worker goes fully idle, it asks the peer with the deepest queue to hand
# over a slice of its jobs - so a fast machine finishing early helps a slow
# one instead of sitting idle while the nightly backlog grinds elsewhere.
PEERS_FILE = os.path.join(os.path.dirname(DB_PATH) or ".", ".subworker-peers.json")
peers_lock = threading.Lock()
peers: "list[dict]" = []
import json as _json  # noqa: E402

try:
    if os.path.exists(PEERS_FILE):
        with open(PEERS_FILE, "r", encoding="utf-8") as _fh:
            peers = _json.load(_fh)
except Exception:  # noqa: BLE001
    peers = []


def my_capabilities():
    return {"sync": True, "transcribe": TRANSCRIBE_CAPABILITY, "translate": TRANSLATE_CAPABILITY}


def job_suitable_for(job: dict, caps: dict) -> bool:
    jtype = job.get("type", "sync")
    if jtype == "transcribe":
        return bool(caps.get("transcribe"))
    if jtype == "translate":
        return bool(caps.get("translate"))
    return True


def steal_loop():
    import urllib.request

    while True:
        time.sleep(45)
        try:
            if not pause_event.is_set() or job_queue.qsize() > 0:
                continue
            with state_lock:
                if state["processing"]:
                    continue
            with peers_lock:
                current_peers = list(peers)
            if not current_peers:
                continue

            # Find the peer with the deepest queue.
            best = None
            best_depth = 1  # only bother when someone has 2+ queued
            for peer in current_peers:
                try:
                    req = urllib.request.Request(peer["url"].rstrip("/") + "/status")
                    req.add_header("X-Api-Key", peer["api_key"])
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        depth = _json.loads(resp.read()).get("queue_depth", 0)
                    if depth > best_depth:
                        best, best_depth = peer, depth
                except Exception:  # noqa: BLE001 - peer offline, skip
                    continue

            if best is None:
                continue

            payload = _json.dumps({
                "count": min(max(1, best_depth // 2), 10),
                "capabilities": my_capabilities(),
            }).encode("utf-8")
            req = urllib.request.Request(best["url"].rstrip("/") + "/steal", data=payload, method="POST")
            req.add_header("X-Api-Key", best["api_key"])
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=15) as resp:
                stolen = _json.loads(resp.read()).get("jobs", [])
            for job in stolen:
                job_queue.put(job)
        except Exception:  # noqa: BLE001 - never let the loop die
            continue


threading.Thread(target=steal_loop, daemon=True).start()


def db():
    # timeout matters now that several worker threads write concurrently -
    # SQLite serializes writes and a busy writer must wait, not error out.
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS processed (
            sub_path TEXT PRIMARY KEY,
            mtime REAL,
            offset_seconds REAL,
            status TEXT,
            processed_at TEXT
        )"""
    )
    return conn


# Only a SUCCESSFUL check on the current version of a file counts as "done".
# A previously-recorded failure (missing-file, ffsubsync-failed, timeout,
# error) must NOT block a later retry - otherwise a transient problem (like
# the ffsubsync-not-found bug) would poison every affected subtitle forever,
# since the nightly task would keep skipping them.
SUCCESS_STATUSES = ("fixed", "in-sync", "already-has-sub", "rolled-back", "translated", "suspect-offset")


def already_processed(sub_path: str, mtime: float) -> bool:
    conn = db()
    try:
        row = conn.execute(
            "SELECT mtime, status FROM processed WHERE sub_path = ?", (sub_path,)
        ).fetchone()
        if row is None:
            return False
        # transcribed:<lang> counts as success too
        ok = row[1] in SUCCESS_STATUSES or str(row[1]).startswith("transcribed:")
        return ok and abs(row[0] - mtime) < 1e-6
    finally:
        conn.close()


def record(sub_path: str, mtime: float, offset, status: str):
    conn = db()
    try:
        conn.execute(
            "REPLACE INTO processed (sub_path, mtime, offset_seconds, status, processed_at) VALUES (?,?,?,?,?)",
            (sub_path, mtime, offset, status, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


OFFSET_RE = re.compile(r"offset seconds:\s*(-?[\d.]+)", re.IGNORECASE)


def process_job(job: dict):
    media = job["media_path"]
    sub = job["subtitle_path"]

    if not os.path.isfile(media) or not os.path.isfile(sub):
        record(sub, 0, None, "missing-file")
        with state_lock:
            state["failed"] += 1
        return

    mtime = os.path.getmtime(sub)
    if already_processed(sub, mtime):
        with state_lock:
            state["skipped"] += 1
        return

    out_fd, out_path = tempfile.mkstemp(suffix=os.path.splitext(sub)[1])
    os.close(out_fd)
    try:
        proc = subprocess.run(
            [FFSUBSYNC, media, "-i", sub, "-o", out_path],
            capture_output=True,
            text=True,
            timeout=1800,
        )
        log = (proc.stdout or "") + (proc.stderr or "")
        m = OFFSET_RE.search(log)
        offset = float(m.group(1)) if m else None

        if proc.returncode != 0 or not os.path.getsize(out_path):
            record(sub, mtime, offset, "ffsubsync-failed")
            with state_lock:
                state["failed"] += 1
            return

        if offset is not None and abs(offset) < MIN_OFFSET_SECONDS:
            # Already in sync - leave the original untouched, remember that
            # this version was checked.
            record(sub, mtime, offset, "in-sync")
            with state_lock:
                state["done"] += 1
            return

        if offset is not None and abs(offset) > MAX_OFFSET_SECONDS:
            # Implausibly large shift - almost certainly a mis-align, not a
            # real drift. Keep the original rather than corrupting a good
            # subtitle. Recorded as resolved so it isn't retried forever
            # (ffsubsync would report the same bad offset next time).
            record(sub, mtime, offset, "suspect-offset")
            with state_lock:
                state["done"] += 1
            return

        backup = sub + ".bak"
        if not os.path.exists(backup):
            shutil.copy2(sub, backup)
        shutil.move(out_path, sub)
        out_path = None
        # Record against the NEW mtime so the corrected file itself counts
        # as processed.
        record(sub, os.path.getmtime(sub), offset, "fixed")
        with state_lock:
            state["done"] += 1
    except subprocess.TimeoutExpired:
        record(sub, mtime, None, "timeout")
        with state_lock:
            state["failed"] += 1
    except Exception as exc:  # noqa: BLE001 - keep the worker alive
        record(sub, mtime, None, f"error: {exc}")
        with state_lock:
            state["failed"] += 1
    finally:
        if out_path and os.path.exists(out_path):
            os.unlink(out_path)


def process_transcribe_job(job: dict):
    media = job["media_path"]
    key = "transcribe:" + media

    if not TRANSCRIBE_CAPABILITY:
        record(key, 0, None, "no-whisper")
        with state_lock:
            state["failed"] += 1
        return

    if not os.path.isfile(media):
        record(key, 0, None, "missing-file")
        with state_lock:
            state["failed"] += 1
        return

    mtime = os.path.getmtime(media)
    force = bool(job.get("force"))
    if not force and already_processed(key, mtime):
        with state_lock:
            state["skipped"] += 1
        return

    out_path = None
    try:
        model = get_whisper_model()
        # language=None auto-detects the SPOKEN language; Whisper transcribes
        # in that language (it can translate to English but never to Danish -
        # translation is a future, separate step). word_timestamps=True gives
        # per-word timing so write_srt can tighten each cue to real speech.
        segments, info = model.transcribe(
            media,
            language=job.get("language") or None,
            word_timestamps=True,
            # Thoroughness knobs - see WHISPER_* above.
            beam_size=WHISPER_BEAM,
            best_of=WHISPER_BEAM,
            patience=1.5,
            condition_on_previous_text=True,
            vad_filter=WHISPER_VAD,
            vad_parameters=(
                {"threshold": WHISPER_VAD_THRESHOLD, "speech_pad_ms": WHISPER_VAD_PAD_MS}
                if WHISPER_VAD else None
            ),
        )

        base = os.path.splitext(media)[0]
        target = f"{base}.{info.language}.srt"
        if os.path.exists(target) and not force:
            # A subtitle for the detected language already exists (maybe
            # added since the job was queued) - never overwrite real subs
            # with machine output. force=True (explicit re-transcribe from
            # the button) overwrites our OWN previous output.
            record(key, mtime, None, "already-has-sub")
            with state_lock:
                state["skipped"] += 1
            return

        out_fd, out_path = tempfile.mkstemp(suffix=".srt")
        os.close(out_fd)
        count = write_srt(segments, out_path)
        if count == 0:
            record(key, mtime, None, "no-speech")
            with state_lock:
                state["failed"] += 1
            return

        shutil.move(out_path, target)
        out_path = None
        record(key, mtime, None, f"transcribed:{info.language}")
        with state_lock:
            state["done"] += 1
    except Exception as exc:  # noqa: BLE001 - keep the worker alive
        record(key, mtime, None, f"error: {exc}")
        with state_lock:
            state["failed"] += 1
    finally:
        if out_path and os.path.exists(out_path):
            os.unlink(out_path)


def worker_loop():
    name = threading.current_thread().name
    while True:
        # Respect pause BEFORE pulling a job, so pausing takes effect after
        # the current file finishes and a subsequent queue-clear works.
        pause_event.wait()
        try:
            job = job_queue.get(timeout=1)
        except queue.Empty:
            continue

        label = job.get("subtitle_path") or job.get("media_path")
        if job.get("type") == "transcribe":
            label = "[whisper] " + os.path.basename(job.get("media_path") or "")
        elif job.get("type") == "translate":
            label = "[oversætter] " + os.path.basename(job.get("media_path") or "")
        with state_lock:
            state["processing"][name] = label
        try:
            if job.get("type") == "transcribe":
                # Whisper and NLLB share the same GPU - one heavy ML job at
                # a time, sync keeps flowing on the other threads.
                with transcribe_job_lock:
                    process_transcribe_job(job)
            elif job.get("type") == "translate":
                with transcribe_job_lock:
                    process_translate_job(job)
            else:
                process_job(job)
        finally:
            with state_lock:
                state["processing"].pop(name, None)
            job_queue.task_done()


for _i in range(SYNC_CONCURRENCY):
    threading.Thread(target=worker_loop, name=f"worker-{_i + 1}", daemon=True).start()


def check_key(x_api_key):
    if not API_KEY or x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="bad api key")


class Job(BaseModel):
    media_path: str
    subtitle_path: str | None = None
    type: str = "sync"  # "sync" | "transcribe" | "translate"
    language: str | None = None  # transcribe only; None = auto-detect
    stream_index: int | None = None  # translate only: embedded source stream
    force: bool = False  # transcribe: re-run even if already processed / target exists


class Batch(BaseModel):
    jobs: list[Job]


class RollbackBody(BaseModel):
    subtitle_path: str


class PeerEntry(BaseModel):
    url: str
    api_key: str


class PeersBody(BaseModel):
    peers: list[PeerEntry]


class StealBody(BaseModel):
    count: int = 5
    capabilities: dict = {}


@app.post("/peers")
def set_peers(body: PeersBody, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    global peers  # noqa: PLW0603
    with peers_lock:
        peers = [p.model_dump() for p in body.peers]
        try:
            with open(PEERS_FILE, "w", encoding="utf-8") as fh:
                _json.dump(peers, fh)
        except OSError:
            pass
    return {"peers": len(peers)}


@app.post("/steal")
def steal(body: StealBody, x_api_key: str = Header(default="")):
    """Hand queued jobs to an idle peer. Jobs the requester can't run
    (e.g. a transcription asked for by a non-GPU worker) are kept."""
    check_key(x_api_key)
    taken: list[dict] = []
    kept: list[dict] = []
    want = max(1, min(20, body.count))
    try:
        while len(taken) < want:
            job = job_queue.get_nowait()
            job_queue.task_done()
            if job_suitable_for(job, body.capabilities):
                taken.append(job)
            else:
                kept.append(job)
    except queue.Empty:
        pass
    for job in kept:
        job_queue.put(job)
    return {"jobs": taken, "queue_depth": job_queue.qsize()}


@app.get("/health")
def health():
    return {
        "ok": True,
        "capabilities": {
            "sync": True,
            "transcribe": TRANSCRIBE_CAPABILITY,
            "translate": TRANSLATE_CAPABILITY,
        },
        "whisper_model": WHISPER_MODEL_NAME if TRANSCRIBE_CAPABILITY else None,
    }


@app.get("/recent")
def recent(limit: int = 5, x_api_key: str = Header(default="")):
    """Most recent sync FIXES (files actually rewritten) that can still be
    rolled back - i.e. their .bak original exists."""
    check_key(x_api_key)
    conn = db()
    try:
        rows = conn.execute(
            "SELECT sub_path, offset_seconds, processed_at FROM processed "
            "WHERE status = 'fixed' ORDER BY processed_at DESC LIMIT ?",
            (max(1, min(50, limit)) * 3,),  # overfetch: some .baks may be gone
        ).fetchall()
    finally:
        conn.close()

    items = []
    for sub_path, offset, at in rows:
        if os.path.exists(sub_path + ".bak"):
            items.append({"subtitle_path": sub_path, "offset_seconds": offset, "processed_at": at})
        if len(items) >= limit:
            break
    return {"items": items}


@app.post("/rollback")
def rollback(body: RollbackBody, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    sub = body.subtitle_path
    bak = sub + ".bak"
    if not os.path.exists(bak):
        raise HTTPException(status_code=404, detail="no backup for this file")
    shutil.copy2(bak, sub)
    # Recorded as its own success status so the nightly task does NOT
    # immediately re-fix what the user deliberately reverted. The .bak is
    # kept, so the decision remains reversible by hand.
    record(sub, os.path.getmtime(sub), None, "rolled-back")
    return {"restored": sub}


@app.post("/jobs")
def submit_job(job: Job, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    job_queue.put(job.model_dump())
    return {"queued": 1, "queue_depth": job_queue.qsize()}


@app.post("/jobs/batch")
def submit_batch(batch: Batch, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    for job in batch.jobs:
        job_queue.put(job.model_dump())
    return {"queued": len(batch.jobs), "queue_depth": job_queue.qsize()}


@app.post("/pause")
def pause(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    pause_event.clear()
    try:
        with open(PAUSE_FLAG, "w", encoding="utf-8") as fh:
            fh.write(datetime.now(timezone.utc).isoformat())
    except OSError:
        pass  # in-memory pause still works, it just won't survive a reboot
    with state_lock:
        state["paused"] = True
    return {"paused": True}


@app.post("/resume")
def resume(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    pause_event.set()
    try:
        if os.path.exists(PAUSE_FLAG):
            os.unlink(PAUSE_FLAG)
    except OSError:
        pass
    with state_lock:
        state["paused"] = False
    return {"paused": False}


@app.post("/queue/clear")
def clear_queue(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    removed = 0
    try:
        while True:
            job_queue.get_nowait()
            job_queue.task_done()
            removed += 1
    except queue.Empty:
        pass
    return {"removed": removed, "queue_depth": job_queue.qsize()}


@app.get("/processed")
def processed(kind: str = "sync", verify: int = 1, x_api_key: str = Header(default="")):
    """Successfully completed work, so the plugin can merge every worker's
    ledger and stop resubmitting (and re-processing) finished files - the
    fix for a freshly-enrolled worker redoing the whole library. With
    verify=1 (default), entries whose file changed on disk since being
    processed are dropped, so a re-downloaded subtitle gets redone."""
    check_key(x_api_key)
    conn = db()
    try:
        rows = conn.execute("SELECT sub_path, mtime, status FROM processed").fetchall()
    finally:
        conn.close()

    paths = []
    for sub_path, mtime, row_status in rows:
        s = str(row_status)
        if kind == "transcribe":
            if not sub_path.startswith("transcribe:"):
                continue
            if not (s.startswith("transcribed:") or s == "already-has-sub"):
                continue
            real = sub_path[len("transcribe:"):]
        elif kind == "translate":
            if not sub_path.startswith("translate:"):
                continue
            if s not in ("translated", "already-has-sub"):
                continue
            real = sub_path[len("translate:"):]
        else:
            if sub_path.startswith("transcribe:") or sub_path.startswith("translate:"):
                continue
            if s not in ("fixed", "in-sync", "rolled-back"):
                continue
            real = sub_path
        if verify:
            try:
                if abs(os.path.getmtime(real) - mtime) > 1e-6:
                    continue
            except OSError:
                continue
        paths.append(real)
    return {"kind": kind, "paths": paths}


@app.get("/status")
def status(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    with state_lock:
        snapshot = dict(state)
        active = dict(snapshot["processing"])
    snapshot["active"] = len(active)
    snapshot["processing"] = ", ".join(active.values()) if active else None
    snapshot["processing_list"] = list(active.values())
    snapshot["concurrency"] = SYNC_CONCURRENCY
    snapshot["queue_depth"] = job_queue.qsize()
    snapshot["capabilities"] = {
        "sync": True,
        "transcribe": TRANSCRIBE_CAPABILITY,
        "translate": TRANSLATE_CAPABILITY,
    }
    snapshot["whisper_model"] = WHISPER_MODEL_NAME if TRANSCRIBE_CAPABILITY else None
    # Persisted outcome breakdown so problems are visible without opening
    # the database by hand (e.g. a wall of "ffsubsync-failed" is a very
    # different problem from "missing-file").
    conn = db()
    try:
        snapshot["outcomes"] = {
            row[0]: row[1]
            for row in conn.execute("SELECT status, count(*) FROM processed GROUP BY status")
        }
    except Exception:  # noqa: BLE001
        snapshot["outcomes"] = {}
    finally:
        conn.close()
    return snapshot


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("SUBWORKER_PORT", "8099")))
