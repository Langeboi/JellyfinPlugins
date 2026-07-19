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

import errno
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

# Surfaced in /status so the plugin's worker list can show which version each
# box runs and flag stragglers. Bump on every worker release - the self-update
# timer ships this file alone, so this constant IS the deployed version.
WORKER_VERSION = "2.0.3"

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
# A worker can be pinned to sync-only with SUBWORKER_TRANSCRIBE=0 - meant for
# CPU boxes, whose 'small' model is noticeably less accurate. It then reports
# NO transcribe capability, which closes every path a transcription could
# reach it: the plugin won't route one here (/health says null), it won't
# steal one from a peer's queue (work-stealing is capability-gated via
# my_capabilities()), and process_transcribe_job refuses outright if one still
# arrives. Translation is likewise gated by having the NLLB model, so a
# sync-only CPU box already does sync and nothing else.
_TRANSCRIBE_ENABLED = os.environ.get("SUBWORKER_TRANSCRIBE", "1") != "0"
TRANSCRIBE_CAPABILITY = (WHISPER_DEVICE if _HAS_WHISPER else None) if _TRANSCRIBE_ENABLED else None

# Transcription thoroughness (slower = fewer missed words). The safe lever is
# a WIDER BEAM: it lets the decoder recover words it was unsure about, at a
# roughly linear time cost (beam 8 ~ 1.5x beam 5), and if anything it IMPROVES
# text (better punctuation/sentence structure), never strips it.
#
# The VAD-parameter overrides below are OPT-IN only (unset by default). A
# gentler VAD threshold catches quieter speech, but overriding faster-whisper's
# default VAD re-chunks the audio in a way that lost all punctuation in
# testing, so we leave the proven default VAD in place unless you deliberately
# opt in. Set VAD=0 to disable filtering entirely (most thorough, but large-v3
# can then hallucinate a line over music/silence).
WHISPER_BEAM = int(os.environ.get("SUBWORKER_WHISPER_BEAM", "8"))
WHISPER_VAD = os.environ.get("SUBWORKER_WHISPER_VAD", "1") != "0"
# None => use faster-whisper's default VAD tuning (known-good for punctuation).
WHISPER_VAD_THRESHOLD = os.environ.get("SUBWORKER_WHISPER_VAD_THRESHOLD")
WHISPER_VAD_PAD_MS = os.environ.get("SUBWORKER_WHISPER_VAD_PAD_MS")

# Max characters of the hotword prompt handed to Whisper. Kept well under
# half the 448-token decoder context so hotwords + previous-text conditioning
# don't overflow it (which crashes transcription). This is a soft measure -
# the real guarantee is the no-hotwords retry in process_transcribe_job, so a
# list that still overflows never stops a subtitle being produced.
HOTWORDS_MAX_CHARS = int(os.environ.get("SUBWORKER_HOTWORDS_MAX_CHARS", "250"))


def _whisper_vad_parameters():
    """Only override the default VAD tuning when explicitly asked to via env -
    a partial override re-chunks audio and stripped punctuation in testing."""
    params = {}
    if WHISPER_VAD_THRESHOLD is not None:
        params["threshold"] = float(WHISPER_VAD_THRESHOLD)
    if WHISPER_VAD_PAD_MS is not None:
        params["speech_pad_ms"] = int(WHISPER_VAD_PAD_MS)
    return params or None

_whisper_model = None
_whisper_lock = threading.Lock()


def get_whisper_model():
    """Lazy singleton: the model (~3GB for large-v3) downloads on first use
    and stays loaded so back-to-back jobs don't pay the load cost again.

    Load OFFLINE first (local_files_only): faster-whisper otherwise pings
    HuggingFace to check the model revision even when it's already cached, and
    once HF rate-limits the IP (429) that ping fails hard - which took out ALL
    transcription. Offline load uses the on-disk model and never contacts HF.
    Only if the model isn't cached yet do we reach out once to fetch it."""
    global _whisper_model  # noqa: PLW0603
    compute = "float16" if WHISPER_DEVICE == "cuda" else "int8"
    with _whisper_lock:
        if _whisper_model is None:
            try:
                _whisper_model = WhisperModel(
                    WHISPER_MODEL_NAME, device=WHISPER_DEVICE,
                    compute_type=compute, local_files_only=True,
                )
            except Exception:  # noqa: BLE001 - not cached yet: fetch once
                _whisper_model = WhisperModel(
                    WHISPER_MODEL_NAME, device=WHISPER_DEVICE,
                    compute_type=compute, local_files_only=False,
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
# Independent device override: NLLB shares WHISPER_DEVICE by default (both
# models on the same GPU), which risks CUDA OOM the first time translation
# actually loads NLLB alongside an already-resident large-v3 Whisper model -
# a failure mode that can crash or hang the WHOLE process (a CUDA-level
# fault bypasses Python's exception handling, unlike every other error path
# in this file). Set SUBWORKER_NLLB_DEVICE=cpu to run translation on CPU
# instead, trading speed for eliminating that shared-VRAM risk entirely.
NLLB_DEVICE = os.environ.get("SUBWORKER_NLLB_DEVICE") or WHISPER_DEVICE

try:
    import ctranslate2  # noqa: F401

    _HAS_CT2 = True
except Exception:  # noqa: BLE001
    _HAS_CT2 = False

TRANSLATE_CAPABILITY = _HAS_CT2 and os.path.isdir(NLLB_DIR)

_translator = None
_nllb_tokenizer = None
_translate_lock = threading.Lock()


# A failed model load is remembered for this long. Without it every queued
# translate job re-attempts the load: each attempt stalls /status for a
# minute-plus (GIL held by native init), fails, and the next file repeats
# the whole dance - observed live as the worker flapping offline/online
# through an entire batch. Within the backoff window jobs fail FAST with
# the remembered error instead.
NLLB_LOAD_BACKOFF_SECONDS = 600
_translator_load_failed_at = 0.0
_translator_load_error = ""


def get_translator():
    global _translator, _nllb_tokenizer, _translator_load_failed_at, _translator_load_error  # noqa: PLW0603
    with _translate_lock:
        if _translator is None:
            since_failure = time.monotonic() - _translator_load_failed_at
            if _translator_load_failed_at and since_failure < NLLB_LOAD_BACKOFF_SECONDS:
                raise RuntimeError(
                    f"nllb-load-failed ({int(since_failure)}s ago, retry in "
                    f"{int(NLLB_LOAD_BACKOFF_SECONDS - since_failure)}s): {_translator_load_error}")

            # Confirmed live (jul 19): this first-time load - CUDA context +
            # cuBLAS/cuDNN + 2.6GB model upload - holds the GIL long enough
            # that /status stops answering and the plugin paints the worker
            # OFFLINE for a minute or two. The worker is fine; the operator
            # restarting it mid-load just discards the work. Log loudly on
            # both sides of the load so journalctl explains the silence.
            print(f"[oversætter] loading NLLB model on {NLLB_DEVICE} - first "
                  "translation only. The worker may look offline for a minute "
                  "or two while this runs; do NOT restart it.", flush=True)
            load_started = time.monotonic()
            try:
                from transformers import AutoTokenizer

                # Offline-first for the same reason as Whisper: the tokenizer
                # is pulled from HuggingFace at runtime and a 429 would break
                # every translation. Use the cached copy; only fetch if truly
                # missing.
                try:
                    _nllb_tokenizer = AutoTokenizer.from_pretrained(
                        NLLB_TOKENIZER, src_lang="eng_Latn", local_files_only=True)
                except Exception:  # noqa: BLE001 - not cached yet: fetch once
                    _nllb_tokenizer = AutoTokenizer.from_pretrained(
                        NLLB_TOKENIZER, src_lang="eng_Latn", local_files_only=False)
                _translator = ctranslate2.Translator(
                    NLLB_DIR,
                    device=NLLB_DEVICE,
                    compute_type="float16" if NLLB_DEVICE == "cuda" else "int8",
                )
            except Exception as exc:  # noqa: BLE001 - remember + surface
                _translator_load_failed_at = time.monotonic()
                _translator_load_error = str(exc)
                print(f"[oversætter] NLLB model load FAILED after "
                      f"{time.monotonic() - load_started:.1f}s on {NLLB_DEVICE}: {exc}\n"
                      "[oversætter] further translations fail fast for "
                      f"{NLLB_LOAD_BACKOFF_SECONDS // 60} min instead of re-stalling per file. "
                      "If this is CUDA out-of-memory, set SUBWORKER_NLLB_DEVICE=cpu in "
                      "/opt/subtitle-worker/env and restart.", flush=True)
                raise

            _translator_load_failed_at = 0.0
            _translator_load_error = ""
            print(f"[oversætter] NLLB model loaded in "
                  f"{time.monotonic() - load_started:.1f}s - stays resident, "
                  "later translations start instantly.", flush=True)
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
        # Also to stdout: the ledger records this for the plugin's triage,
        # but debugging over journalctl was blind to WHY translations failed.
        print(f"[oversætter] FEJL {os.path.basename(media)}: {exc}", flush=True)
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

# Whisper's classic hallucinations: boilerplate it learned from YouTube subs
# (thanks-for-watching/credits lines, usually over music or silence) and
# loops where the same line repeats for minutes. Both are detectable.
HALLUCINATION_RE = re.compile(
    r"^\s*[\[(♪♫]*\s*("
    r"thanks?\s+for\s+watching|thank\s+you\s+for\s+watching|"
    r"subtitles?\s+(by|made|created|provided)|subs?\s+by|captions?\s+by|"
    r"transcri(bed|ption)\s+by|translat(ed|ion)\s+by|"
    r"copyright|all\s+rights\s+reserved|"
    r"www\.|https?://|"
    r"undertekster?\s+(af|lavet)|tekstet\s+af|tak\s+fordi\s+du\s+så\s+med"
    r")",
    re.IGNORECASE,
)
# Cap on how many times the same text may repeat CONSECUTIVELY before the
# repeats are treated as a decoder loop and dropped (2 legit repeats happen
# in real dialogue; 3+ identical cues in a row almost never do).
HALLUCINATION_MAX_REPEATS = 2


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


def write_srt(segments, path: str, progress=None) -> int:
    """Build a tightly-timed SRT from Whisper segments. Consuming the
    generator is where the transcription time is actually spent, which is
    why progress (if given) is reported per consumed segment."""
    cues = []  # [start, end, text]
    for segment in segments:
        if progress is not None:
            try:
                progress(float(segment.end or 0))
            except Exception:  # noqa: BLE001 - progress must never kill a job
                progress = None
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

    # Hallucination cleanup: drop boilerplate junk cues, and collapse decoder
    # loops (the same text repeated 3+ times in a row) down to the allowed
    # repeats. Runs after merging so loop detection sees final cue texts.
    cleaned = []
    repeat_run = 0
    for cue in cues:
        if HALLUCINATION_RE.search(cue[2]):
            continue
        if cleaned and cue[2].strip().lower() == cleaned[-1][2].strip().lower():
            repeat_run += 1
            if repeat_run >= HALLUCINATION_MAX_REPEATS:
                continue
        else:
            repeat_run = 0
        cleaned.append(cue)
    cues = cleaned

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

# Two queues so heavy ML work can never starve sync: with a single queue,
# several queued transcriptions would each occupy a sync thread (all blocked
# on the one-at-a-time transcribe lock) until no thread was left for sync.
# Sync threads consume job_queue; ONE dedicated ML thread consumes ml_queue -
# so a box with both roles genuinely syncs and transcribes at the same time.
job_queue: "queue.Queue[dict]" = queue.Queue()
ml_queue: "queue.Queue[dict]" = queue.Queue()


def enqueue_job(job: dict):
    if job.get("type") in ("transcribe", "translate"):
        ml_queue.put(job)
    else:
        job_queue.put(job)


def total_queue_depth() -> int:
    return job_queue.qsize() + ml_queue.qsize()


state = {
    "processing": {},  # thread name -> label of the job it is running
    "done": 0,
    "skipped": 0,
    "failed": 0,
    "paused": False,
    "started_at": datetime.now(timezone.utc).isoformat(),
    # {"file": basename, "pct": 0-100} while a transcription runs, else None.
    "ml_progress": None,
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
            if not pause_event.is_set() or total_queue_depth() > 0:
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
                enqueue_job(job)
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


def place_subtitle(out_path: str, sub: str):
    """Move the corrected subtitle into place. Normally a plain overwrite,
    but many external subs (e.g. Jellyfin's OpenSubtitles plugin downloads)
    are owned by a DIFFERENT identity than the worker's SMB session, so the
    worker can't overwrite them (Permission denied) even though it can create
    and delete files in the folder (that's how it writes the .bak). When the
    overwrite is refused, delete the un-owned file and drop our copy in its
    place - it now belongs to the worker, so this file syncs cleanly forever
    after. The corrected copy already carries the original's (human) content,
    time-aligned by ffsubsync, so nothing is lost. Only the .bak-backed 'fixed'
    path calls this, so a failure here still leaves the original + its .bak."""
    try:
        shutil.move(out_path, sub)
        return
    except (PermissionError, OSError) as exc:
        if not isinstance(exc, PermissionError) and getattr(exc, "errno", None) not in (errno.EACCES, errno.EPERM):
            raise
    # Re-own: remove the externally-owned file (a directory-level operation,
    # which the worker is allowed), then write our synced copy as a new file.
    os.remove(sub)  # if this also fails (e.g. read-only flag) it propagates
    shutil.move(out_path, sub)


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
        place_subtitle(out_path, sub)  # overwrite, or re-own if refused
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
        # Per-item hotwords from the plugin (titles, character/place names
        # mined from Jellyfin metadata) bias the decoder toward the right
        # spellings. faster-whisper's `hotwords` prefixes them into the decode
        # window; an older build without the parameter falls back to a short
        # initial_prompt (weaker: only conditions the first window). Clamped
        # for length, but the retry below is the real guarantee.
        hotwords = (job.get("hotwords") or "").strip()
        if len(hotwords) > HOTWORDS_MAX_CHARS:
            hotwords = hotwords[:HOTWORDS_MAX_CHARS].rsplit(",", 1)[0].strip()

        def transcribe(use_hotwords):
            # language=None auto-detects the SPOKEN language. word_timestamps
            # gives per-word timing so write_srt can hug real speech. Wider
            # beam = fewer missed words; VAD left at the proven default.
            kw = {
                "language": job.get("language") or None,
                "word_timestamps": True,
                "beam_size": WHISPER_BEAM,
                "vad_filter": WHISPER_VAD,
                "vad_parameters": _whisper_vad_parameters() if WHISPER_VAD else None,
            }
            if use_hotwords and hotwords:
                import inspect
                if "hotwords" in inspect.signature(model.transcribe).parameters:
                    kw["hotwords"] = hotwords
                else:
                    kw["initial_prompt"] = (
                        "This program may include the following names and terms: " + hotwords + "."
                    )
            return model.transcribe(media, **kw)

        segments, info = transcribe(use_hotwords=bool(hotwords))

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

        # Live progress: consuming the segment generator IS the transcription,
        # and each segment's end time against the media duration gives a real
        # percentage. Shown in the plugin's worker list while this runs.
        duration = float(getattr(info, "duration", 0) or 0)
        media_name = os.path.basename(media)
        with state_lock:
            state["ml_progress"] = {"file": media_name, "pct": 0}

        def _progress(seg_end):
            if duration > 0:
                pct = max(0, min(100, int(seg_end / duration * 100)))
                with state_lock:
                    state["ml_progress"] = {"file": media_name, "pct": pct}

        # The "maximum decoding length must be > 0" error is raised while the
        # generator is CONSUMED (here, not at transcribe()), when hotwords +
        # previous-text conditioning overflow Whisper's 448-token context. If
        # that happens, transcribe ONCE MORE without hotwords - they're a
        # best-effort spelling bias and must never stop a subtitle being made.
        try:
            count = write_srt(segments, out_path, progress=_progress)
        except (ValueError, RuntimeError) as exc:
            if hotwords and "decoding length" in str(exc).lower():
                segments, info = transcribe(use_hotwords=False)
                count = write_srt(segments, out_path, progress=_progress)
            else:
                raise
        if count == 0:
            record(key, mtime, None, "no-speech")
            with state_lock:
                state["failed"] += 1
            return

        shutil.move(out_path, target)
        out_path = None
        record(key, mtime, None, f"transcribed:{info.language}")
        # A Whisper transcription is built FROM the audio (word-level
        # timestamps), so it's already audio-aligned. Record the new subtitle
        # in the SYNC ledger as in-sync too, so the sync task skips it instead
        # of streaming the whole media file to "fix" a file that's already
        # perfect (and risking ffsubsync nudging it out of alignment).
        try:
            record(target, os.path.getmtime(target), 0.0, "in-sync")
        except OSError:
            pass
        # Auto-chain: a fresh ENGLISH transcription can go straight to the
        # da-translation queue instead of waiting for the nightly translate
        # task - the item has a Danish sub by morning in one flow. Only when
        # this worker can translate (NLLB) - which it can, since transcription
        # is CUDA-only and the NLLB model lives on the same GPU box.
        if job.get("chain_translate") and info.language == "en" and TRANSLATE_CAPABILITY:
            ml_queue.put({"type": "translate", "media_path": media, "subtitle_path": target})
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

        # A thread already blocked in get() when /pause engages still wins the
        # next submitted job (confirmed by test: pause -> submit -> the job ran
        # anyway). Hand it back and go respect the gate instead of processing
        # while "paused".
        if not pause_event.is_set():
            job_queue.put(job)
            job_queue.task_done()
            continue

        # ML jobs never belong on sync threads (see enqueue_job) - reroute
        # any stray one instead of letting it block a sync slot on the lock.
        if job.get("type") in ("transcribe", "translate"):
            ml_queue.put(job)
            job_queue.task_done()
            continue

        label = job.get("subtitle_path") or job.get("media_path")
        with state_lock:
            state["processing"][name] = label
        try:
            process_job(job)
        finally:
            with state_lock:
                state["processing"].pop(name, None)
            job_queue.task_done()


def ml_loop():
    """The single ML thread: transcriptions and translations, one at a time
    (a second large-v3 on the same GPU would OOM). Sync threads keep flowing
    in parallel, so a both-roles box genuinely does sync + transcribe at once."""
    name = threading.current_thread().name
    while True:
        pause_event.wait()
        try:
            job = ml_queue.get(timeout=1)
        except queue.Empty:
            continue

        # Same pause-vs-get race as worker_loop: hand the job back if pause
        # engaged while we were blocked in get().
        if not pause_event.is_set():
            ml_queue.put(job)
            ml_queue.task_done()
            continue

        prefix = "[whisper] " if job.get("type") == "transcribe" else "[oversætter] "
        label = prefix + os.path.basename(job.get("media_path") or "")
        with state_lock:
            state["processing"][name] = label
        try:
            with transcribe_job_lock:
                if job.get("type") == "transcribe":
                    process_transcribe_job(job)
                else:
                    process_translate_job(job)
        except Exception as exc:  # noqa: BLE001 - the single ML thread must
            # never die silently. process_transcribe_job/process_translate_job
            # already self-catch everything they know how to fail at, so
            # reaching this handler means something unexpected slipped
            # through - without this, an unhandled exception here would kill
            # this daemon thread for good (Python does not restart threads),
            # leaving every future transcribe/translate job queued forever
            # with nothing processing them, silently, with no crash to notice.
            print(f"[ml-worker] unexpected error, thread stays alive: {exc}", flush=True)
        finally:
            with state_lock:
                state["processing"].pop(name, None)
                state["ml_progress"] = None
            ml_queue.task_done()


for _i in range(SYNC_CONCURRENCY):
    threading.Thread(target=worker_loop, name=f"worker-{_i + 1}", daemon=True).start()
threading.Thread(target=ml_loop, name="ml-worker", daemon=True).start()


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
    hotwords: str | None = None  # transcribe: comma-separated names/terms to bias Whisper
    chain_translate: bool = False  # transcribe: auto-queue en->da translation on success


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


@app.post("/restore-all")
def restore_all(x_api_key: str = Header(default="")):
    """Bulk version of /rollback: reverts every subtitle this worker has
    placed a corrected copy over, back to its pre-modification original,
    using the same .bak that /rollback restores from. Only 'fixed' rows are
    real in-place modifications - in-sync/suspect-offset/etc never touch the
    file - so that's the set iterated (one row per sub_path, since sub_path
    is the ledger's PRIMARY KEY).

    No extra locking/pause-gating here: /rollback (the existing per-item
    mechanism) does a bare file copy with no lock and no pause check, so
    this mirrors that rather than inventing new coordination. Workers only
    stop pulling NEW jobs while paused (see worker_loop/ml_loop) - they
    never hold a lock on a subtitle file, so there is nothing for this to
    contend with beyond the same race /rollback already accepts (a nightly
    resync could be mid-flight on one of these paths). Callers who want a
    clean restore should pause first, same as before clearing the queue.

    Safe to call twice: a restored row's status flips to 'rolled-back'
    (mirrors /rollback), so it is no longer 'fixed' and a second call finds
    nothing left to redo for it - the backup itself is never deleted, so a
    restore stays repeatable by hand via /rollback if needed later."""
    check_key(x_api_key)
    conn = db()
    try:
        rows = conn.execute("SELECT sub_path FROM processed WHERE status = 'fixed'").fetchall()
    finally:
        conn.close()

    restored = 0
    skipped = 0
    failed = 0
    for (sub,) in rows:
        bak = sub + ".bak"
        if not os.path.exists(bak) or not os.path.exists(sub):
            skipped += 1
            continue
        try:
            shutil.copy2(bak, sub)
            record(sub, os.path.getmtime(sub), None, "rolled-back")
            restored += 1
        except Exception:  # noqa: BLE001 - one bad file must not stop the batch
            failed += 1

    print(f"[restore-all] restored={restored} skipped={skipped} failed={failed}", flush=True)
    return {"restored": restored, "skipped": skipped, "failed": failed}


@app.post("/jobs")
def submit_job(job: Job, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    enqueue_job(job.model_dump())
    return {"queued": 1, "queue_depth": total_queue_depth()}


@app.post("/jobs/batch")
def submit_batch(batch: Batch, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    for job in batch.jobs:
        enqueue_job(job.model_dump())
    return {"queued": len(batch.jobs), "queue_depth": total_queue_depth()}


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
    # Pause-drain-restore: without the pause, worker threads race the drain -
    # a thread finishing its current job can pull the next queued item between
    # our get_nowait() calls, so jobs "cleared" would still run. Holding the
    # pause gate closed during the drain stops threads at the wait() before
    # their next get(), making the removed count trustworthy. The previous
    # pause state is restored afterwards, so clearing a running worker doesn't
    # leave it paused.
    was_running = pause_event.is_set()
    pause_event.clear()
    try:
        removed = 0
        for q in (job_queue, ml_queue):
            try:
                while True:
                    q.get_nowait()
                    q.task_done()
                    removed += 1
            except queue.Empty:
                pass
    finally:
        if was_running:
            pause_event.set()
    return {"removed": removed, "queue_depth": total_queue_depth()}


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


# Buckets a raw ledger status into the categories the stats/graphs use.
def _stat_category(status: str) -> str:
    s = str(status)
    if s == "fixed":
        return "fixed"
    if s == "in-sync":
        return "in-sync"
    if s.startswith("transcribed:"):
        return "transcribed"
    if s == "translated":
        return "translated"
    if s in ("already-has-sub", "rolled-back", "suspect-offset"):
        return "skipped"
    return "failed"


# Sub-classifies a failed status into an operator-actionable kind - the
# plugin renders these as human hints ("check ACL inheritance" etc.).
def _failure_kind(status: str) -> str | None:
    s = str(status)
    if _stat_category(s) != "failed":
        return None
    low = s.lower()
    if "permission denied" in low or "errno 13" in low:
        return "permission"
    if s == "missing-file":
        return "missing-file"
    if s == "timeout":
        return "timeout"
    if s == "ffsubsync-failed":
        return "sync-failed"
    if s == "no-speech":
        return "no-speech"
    if s == "no-whisper":
        return "no-whisper"
    if "huggingface" in low or "429" in low or "hf-cache" in low or "snapshot" in low:
        return "model-download"
    return "other"


@app.get("/stats")
def stats(days: int = 14, x_api_key: str = Header(default="")):
    """Daily outcome counts for the last N days, for the plugin's graphs.
    processed_at is stored ISO-8601 UTC, so substr(...,1,10) is the date."""
    check_key(x_api_key)
    days = max(1, min(60, days))
    conn = db()
    try:
        rows = conn.execute(
            "SELECT substr(processed_at,1,10) AS d, status, count(*) FROM processed "
            "WHERE processed_at >= datetime('now', ?) GROUP BY d, status",
            (f"-{days} days",),
        ).fetchall()
        totals_rows = conn.execute("SELECT status, count(*) FROM processed").fetchall()
        # failure_kinds must reflect CURRENT state, not history: a status
        # counts here only if it is the LATEST row for that sub_path (the
        # same latest-per-item dedupe /history uses - MAX(processed_at)
        # GROUP BY sub_path) and that latest row is within the window, so a
        # sub_path whose error was later fixed stops showing up as a failure.
        latest_rows = conn.execute(
            "SELECT sub_path, status FROM ("
            "  SELECT sub_path, status, MAX(processed_at) AS at FROM processed GROUP BY sub_path"
            ") WHERE at >= datetime('now', ?)",
            (f"-{days} days",),
        ).fetchall()
    finally:
        conn.close()

    daily: dict = {}
    for d, status_val, n in rows:
        bucket = daily.setdefault(d, {})
        cat = _stat_category(status_val)
        bucket[cat] = bucket.get(cat, 0) + n

    failure_kinds: dict = {}
    for sub_path, status_val in latest_rows:
        kind = _failure_kind(status_val)
        if kind:
            failure_kinds[kind] = failure_kinds.get(kind, 0) + 1

    totals: dict = {}
    for status_val, n in totals_rows:
        cat = _stat_category(status_val)
        totals[cat] = totals.get(cat, 0) + n

    return {"days": days, "daily": daily, "totals": totals, "failure_kinds": failure_kinds}


@app.get("/history")
def history(kind: str = "transcribe", limit: int = 20, x_api_key: str = Header(default="")):
    """Most recent completed jobs of a kind, newest first - powers the
    transcription-history list in the plugin."""
    check_key(x_api_key)
    prefix = kind + ":"
    conn = db()
    try:
        # Latest entry PER ITEM (SQLite's MAX() bare-column rule pulls the
        # other columns from the max row), so an old failure doesn't linger
        # in the list once a newer attempt succeeded.
        rows = conn.execute(
            "SELECT sub_path, status, MAX(processed_at) FROM processed "
            "WHERE sub_path LIKE ? GROUP BY sub_path ORDER BY 3 DESC LIMIT ?",
            (prefix + "%", max(1, min(100, limit))),
        ).fetchall()
    finally:
        conn.close()
    items = [
        {"media_path": p[len(prefix):], "status": s, "processed_at": at}
        for p, s, at in rows
    ]
    return {"kind": kind, "items": items}


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
    snapshot["queue_depth"] = total_queue_depth()
    snapshot["sync_queue_depth"] = job_queue.qsize()
    snapshot["ml_queue_depth"] = ml_queue.qsize()
    snapshot["capabilities"] = {
        "sync": True,
        "transcribe": TRANSCRIBE_CAPABILITY,
        "translate": TRANSLATE_CAPABILITY,
    }
    snapshot["whisper_model"] = WHISPER_MODEL_NAME if TRANSCRIBE_CAPABILITY else None
    snapshot["translate_device"] = NLLB_DEVICE if TRANSLATE_CAPABILITY else None
    snapshot["version"] = WORKER_VERSION
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
