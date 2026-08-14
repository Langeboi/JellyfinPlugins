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
WORKER_VERSION = "2.3.1"

API_KEY = os.environ.get("SUBWORKER_API_KEY", "")
DB_PATH = os.environ.get("SUBWORKER_DB", os.path.expanduser("~/.subtitle-worker.db"))
# Offsets smaller than this are considered "already in sync" - the original
# file is left completely untouched.
MIN_OFFSET_SECONDS = float(os.environ.get("SUBWORKER_MIN_OFFSET", "0.4"))
# Offsets LARGER than this are almost always a mis-alignment (ffsubsync
# latched onto the wrong audio) rather than a real drift - applying them is
# what produced "way off" subtitles. Reject and keep the original instead.
#
# NOTE: with --skip-sync-on-low-quality, ffsubsync applies its OWN offset gate
# first, at DEFAULT_QUALITY_MAX_OFFSET_SECONDS = 30.0 (read from the pinned
# 0.5.0 source, not assumed). Anything past 30s is therefore already rejected
# upstream as low-quality, so a ceiling above 30 here can never actually fire.
# Kept configurable, but the default now matches the gate that really applies.
MAX_OFFSET_SECONDS = float(os.environ.get("SUBWORKER_MAX_OFFSET", "30"))

# ---- Framerate correction policy ----
# ffsubsync does two things at once: it SHIFTS a subtitle (offset) and it can
# RESCALE it in time to repair a framerate mismatch (a 23.976 subtitle against
# a 25fps encode, etc.).
#
# Rescaling was initially suspected of being what mangled good subtitles here,
# on the reasoning that a wrong ratio multiplies every timestamp and produces
# exactly the "fine at the start, progressively wronger" symptom. That was
# tested against the pinned 0.5.0 rather than assumed, and it did not hold up:
#
#   * A subtitle that is correctly timed but simply stops before the credits -
#     the ordinary case that makes the length-inferred ratio look risky -
#     produced a 1.073 candidate ratio that ffsubsync scored and CORRECTLY
#     rejected in favour of 1.0. The inferred ratio is only ever a candidate,
#     never applied on its own authority.
#   * A genuine 23.976->25 stretch was repaired exactly, to the frame.
#   * Turning rescaling off (which needs BOTH --no-fix-framerate AND
#     --skip-infer-framerate-ratio - the first alone is not enough, since the
#     two paths are gated separately) left that real defect unrepaired and
#     103 seconds out by the end of the episode.
#
# So rescaling stays ON: it works, and disabling it is a regression. What was
# actually broken is on our side - see the decision logic in process_job,
# which used to inspect the offset alone and therefore threw away every
# rescale-only repair. This flag exists only as an escape hatch; setting it to
# 0 passes both flags, because one is useless without the other.
ALLOW_FRAMERATE_FIX = os.environ.get("SUBWORKER_ALLOW_FRAMERATE_FIX", "1") == "1"
# Below this, a reported scale factor is just floating-point noise around 1.0
# and means "no rescale happened".
FRAMERATE_EPSILON = 0.0005

# ---- Per-worker path remapping (Windows workers / mixed mounts) ----
# The plugin applies ONE global path mapping for the whole pool. A worker
# whose own mount differs (a Windows box seeing \\nas\Media, a Linux box
# mounting somewhere else) sets these to translate INCOMING paths itself.
# Contract: the job queue and everything REPORTED back to the plugin stay in
# the original plugin-side form - so pool-wide dedupe, history merging and
# work-stealing keep working across a mixed pool - while filesystem access
# and the local ledger use the translated form. lp() is applied where a job
# is actually processed (not at enqueue: a peer stealing queued jobs must
# receive plugin-side paths, not this box's local ones); rp() is applied at
# the reporting endpoints.
PATH_FROM = os.environ.get("SUBWORKER_PATH_FROM", "")
PATH_TO = os.environ.get("SUBWORKER_PATH_TO", "")


def lp(path):
    """Plugin-side path -> local filesystem path (identity when unset).

    On Windows the remainder's separators become backslashes so ledger keys
    are canonical local paths - rp() undoes exactly this."""
    if PATH_FROM and PATH_TO and path and path.startswith(PATH_FROM):
        remainder = path[len(PATH_FROM):]
        if os.name == "nt":
            remainder = remainder.replace("/", "\\")
        return PATH_TO + remainder
    return path


def rp(path):
    """Local filesystem path -> plugin-side path (inverse of lp).

    The remainder's separators are normalized to '/' on Windows: locally
    derived paths (targets, .baks) pick up backslashes, and reporting
    '/Media/Movies\\film.srt' back would silently break the plugin's
    string-compare dedupe against the '/'-separated paths it sent."""
    if PATH_FROM and PATH_TO and path and path.startswith(PATH_TO):
        remainder = path[len(PATH_TO):]
        if os.name == "nt":
            remainder = remainder.replace("\\", "/")
        return PATH_FROM + remainder
    return path


# ---- Idle restart (frees resident ML models when the work is done) ----
# Whisper large-v3 + NLLB stay loaded once used - deliberately, so jobs in
# the same batch don't re-pay the load cost. But on a box that is also
# someone's desktop, that is 6-7GB of VRAM/RAM held hostage all day for
# nothing. When the worker has been fully idle (empty queues, nothing
# processing - a cleared queue lands here too) for this long AND a model is
# actually resident, the process restarts itself to give the memory back.
# Sync-only boxes never load a model, so they never restart. The ledger is
# on disk and pause state persists via the pause flag file, so nothing is
# lost. Disable with SUBWORKER_IDLE_RESTART=0.
IDLE_RESTART_ENABLED = os.environ.get("SUBWORKER_IDLE_RESTART", "1") != "0"
IDLE_RESTART_SECONDS = int(os.environ.get("SUBWORKER_IDLE_RESTART_SECONDS", "120"))


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
    # Windows venvs put console scripts next to python.exe as .exe stubs.
    for path in (candidate, candidate + ".exe"):
        if os.path.exists(path):
            return path
    return "ffsubsync"


FFSUBSYNC = _resolve_ffsubsync()


def _detect_cuda() -> bool:
    try:
        subprocess.run(["nvidia-smi"], capture_output=True, timeout=10, check=True)
        return True
    except Exception:  # noqa: BLE001 - no nvidia-smi / no driver = no CUDA
        return False


def _add_windows_cuda_dll_dirs():
    """Make the pip-installed CUDA libraries findable on Windows.

    Both installers pull in nvidia-cublas-cu12 / nvidia-cudnn-cu12, which drop
    their DLLs under site-packages\\nvidia\\<pkg>\\bin. On Linux CTranslate2
    resolves those fine. On Windows nothing ever adds those directories to the
    DLL search path, so the libraries are present and still unloadable, and
    the first transcription on a GPU box dies with:

        Library cublas64_12.dll is not found or cannot be loaded

    Not at import time, note - faster_whisper imports cleanly, so the worker
    advertises transcribe=cuda and accepts the work before failing per job.
    Every Windows GPU worker would take transcription jobs and fail all of
    them. Found by actually running a transcription on a Windows box with an
    RTX 3080; it cannot reproduce on the Linux workers.

    Must run BEFORE faster_whisper is imported. Harmless elsewhere: the whole
    thing is a no-op off Windows, and on a machine without those packages the
    directories simply don't exist.

    BOTH mechanisms below are required, and it is worth saying why, because
    doing only the obvious one looks like it works:

      * os.add_dll_directory() only affects loads that go through
        LoadLibraryEx with LOAD_LIBRARY_SEARCH_USER_DIRS.
      * CTranslate2 does not load cuBLAS at import, or even when the model is
        constructed - it loads it lazily at the first actual compute, with a
        plain LoadLibrary, which ignores those directories and searches PATH.

    So with add_dll_directory alone, WhisperModel(...) succeeds and reports a
    perfectly healthy CUDA model, and the process still dies on the first
    encode() - which is to say, on the first real transcription. Verified
    exactly that way here: "model OK" followed by RuntimeError from
    model.encode(). Prepending to PATH is what actually fixes it.
    """
    if os.name != "nt":
        return
    try:
        import site

        roots = list(site.getsitepackages())
        if hasattr(site, "getusersitepackages"):
            roots.append(site.getusersitepackages())
    except Exception:  # noqa: BLE001 - fall back to this file's own env
        roots = [os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")]

    found = []
    for root in roots:
        nvidia = os.path.join(root, "nvidia")
        if not os.path.isdir(nvidia):
            continue
        for pkg in sorted(os.listdir(nvidia)):
            bin_dir = os.path.join(nvidia, pkg, "bin")
            if os.path.isdir(bin_dir) and bin_dir not in found:
                found.append(bin_dir)

    for bin_dir in found:
        try:
            os.add_dll_directory(bin_dir)
        except OSError:
            pass
    if found:
        os.environ["PATH"] = os.pathsep.join(found) + os.pathsep + os.environ.get("PATH", "")


_add_windows_cuda_dll_dirs()

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

# ---- Which audio track to transcribe ----
# Whisper transcribes whatever audio ffmpeg hands it, which is the container's
# DEFAULT track. On a lot of releases that default is a dub, with the original
# English sitting at a later index - and the result is a perfectly accurate
# subtitle in a language nobody asked for.
#
# Measured on a 15-item sample here: eight items came back as fr/es/it/pl.
# None of those were detection failures - the files were tagged fra*/spa*/
# ita*/pol* as default with an eng track further down, and Whisper faithfully
# transcribed the dub. Worse, the ledger then records the item as done, so it
# is never revisited and never gets the English subtitle it was queued for.
#
# So the track is chosen deliberately: the first audio stream tagged with one
# of these languages wins, in this order, regardless of which is default.
# Falls back to the container default when none match (a genuinely
# Spanish-only film still gets Spanish, which is the best available).
PREFERRED_AUDIO_LANGS = [
    l.strip().lower()
    for l in os.environ.get("SUBWORKER_AUDIO_LANGS", "en,da").split(",")
    if l.strip()
]

# Language auto-detection reads ONE 30-second window by default
# (language_detection_segments=1), and episodes routinely open on a logo,
# music or ambience. That is how an English-only Peaky Blinders episode was
# detected as Chinese and an English-only Last of Us episode as Indonesian -
# both then transcribed INTO those languages, which is unusable output rather
# than merely mislabelled. Sampling several windows costs a second or two and
# removes that entire failure mode.
LANG_DETECT_SEGMENTS = int(os.environ.get("SUBWORKER_LANG_DETECT_SEGMENTS", "8"))
LANG_DETECT_THRESHOLD = float(os.environ.get("SUBWORKER_LANG_DETECT_THRESHOLD", "0.6"))


# Tags that exist precisely to say "no language here". Truncating them to two
# letters produced 'un' from 'und', which Whisper rejects outright - the job
# died with "'un' is not a valid language code" instead of simply falling back
# to detection. 'und' is the standard undetermined tag and is extremely
# common, so this failed real files: 5 of the first 92 in a full-library run.
NON_LANGUAGE_TAGS = {"und", "unk", "unknown", "zxx", "mis", "mul", "qaa", "none", ""}


def _iso3_to_iso1(code: str) -> str:
    """Container tags are usually ISO 639-2 ('eng'); Whisper wants 639-1.

    Returns '' for anything that is not a language we can name - an explicit
    "don't know", which the caller turns into auto-detection. Blindly
    truncating an unrecognised tag to two characters invents codes that no
    decoder accepts."""
    table = {
        "eng": "en", "dan": "da", "swe": "sv", "nor": "no", "ger": "de", "deu": "de",
        "fre": "fr", "fra": "fr", "spa": "es", "ita": "it", "pol": "pl", "por": "pt",
        "dut": "nl", "nld": "nl", "rus": "ru", "jpn": "ja", "kor": "ko", "chi": "zh",
        "zho": "zh", "fin": "fi", "ces": "cs", "cze": "cs", "hun": "hu", "tur": "tr",
        "ara": "ar", "hin": "hi", "heb": "he", "ell": "el", "gre": "el", "ukr": "uk",
    }
    c = (code or "").strip().lower()
    if c in NON_LANGUAGE_TAGS:
        return ""
    if c in table:
        return table[c]
    # A bare two-letter tag is already ISO 639-1; anything else is a code we
    # do not recognise, and guessing at it is how 'und' became 'un'.
    return c if len(c) == 2 and c.isalpha() else ""


def pick_audio_stream(media: str):
    """Decide what to transcribe: (stream_index_or_None, language_or_None).

    The two halves are independent, and conflating them was a real bug:

      * stream_index is "extract THIS track first", needed only when the
        container default is the wrong language.
      * language is "you already know what this is, don't guess", which is
        worth having even when there is nothing to choose between.

    An earlier version returned (None, None) whenever there was a single audio
    stream, on the reasoning that there was no choice to make. That threw away
    the container's own language tag in exactly the case where auto-detection
    has the least to work with - and auto-detection then read one 30-second
    window of an English-only Peaky Blinders episode and decided it was
    Chinese, and a Last of Us episode Indonesian, transcribing both into those
    languages. The tag said `eng` the whole time.

    Probing is best-effort: no ffprobe, a weird container, or untagged audio
    all fall back to plain auto-detection rather than failing the job."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index:stream_tags=language",
             "-of", "csv=p=0", media],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )
        if proc.returncode != 0:
            return None, None
    except Exception:  # noqa: BLE001 - ffprobe missing/unusable
        return None, None

    streams = []
    for line in (proc.stdout or "").splitlines():
        parts = [p for p in line.strip().split(",") if p != ""]
        if not parts:
            continue
        try:
            idx = int(parts[0])
        except ValueError:
            continue
        streams.append((idx, _iso3_to_iso1(parts[1]) if len(parts) > 1 else ""))

    if not streams:
        return None, None

    # Single track: no extraction needed, but its tag is still the best
    # information available about what language the audio is in.
    if len(streams) == 1:
        return None, (streams[0][1] or None)

    # Several tracks: take the first one in preference order, extracting it
    # so ffmpeg can't hand us the (possibly dubbed) default instead.
    for want in PREFERRED_AUDIO_LANGS:
        for idx, lang in streams:
            if lang == want:
                return idx, lang

    # No preferred language present. Don't extract - the default is as good a
    # guess as any - but if every track agrees on a language, pin it.
    tagged = {lang for _, lang in streams if lang}
    if len(tagged) == 1:
        return None, tagged.pop()
    return None, None

# A short, fully-punctuated example primes Whisper's decode context toward
# consistent sentence-ending punctuation and comma usage - condition_on_
# previous_text (faster-whisper default: on) carries that "style" forward
# window after window, not just the first one. Keyed by job["language"] when
# the caller pins one; auto-detect jobs (the common case) get the English
# prompt, which is fine even for other spoken languages - it's a structural
# cue, not a translation.
WHISPER_PUNCTUATION_PROMPT = {
    "en": "Hello, welcome back. As I was saying, it's going to be fine - don't worry.",
    "da": "Hej, velkommen tilbage. Som jeg sagde, det skal nok gå - bare rolig.",
}


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
# Default resolved RELATIVE TO THIS FILE, not hardcoded to the Linux install
# path. Both installers put the converted model in a "nllb-ct2" folder beside
# the worker, so on Linux this still resolves to exactly
# /opt/subtitle-worker/nllb-ct2 - but on Windows it now finds
# C:\subtitle-worker\nllb-ct2 as well.
#
# Previously it could not: the default was the Linux path and install.ps1
# never wrote SUBWORKER_NLLB_DIR, so a Windows box downloaded and converted
# the ~6GB model, then reported translate=false forever and never used it.
# Nothing surfaced the contradiction - the capability check is just
# os.path.isdir() on a path that simply didn't exist there.
_NLLB_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nllb-ct2")
NLLB_DIR = os.environ.get("SUBWORKER_NLLB_DIR") or (
    _NLLB_DEFAULT if os.path.isdir(_NLLB_DEFAULT) else "/opt/subtitle-worker/nllb-ct2"
)
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


# ---- Translating whole sentences instead of whole cues ----
# NLLB translates a SENTENCE. It has no document context, so whatever it is
# handed is the entire world as far as it is concerned - and it used to be
# handed one subtitle cue at a time.
#
# Cue boundaries are a DISPLAY constraint, not a linguistic one: a sentence
# too long for two lines has to be split across cues to be readable, which is
# why real fragments like "to", "find" and "or run after" existed as separate
# cues. Each was translated in isolation, and no model can translate "to"
# into a language that inflects. Measured: 14.1% of cues did not end a
# sentence, 200 of them two words or fewer.
#
# So cues are grouped back into sentences, the sentence is translated once,
# and the result is redistributed across the original cues' timings. The
# subtitles still break where they must; only the translator sees whole
# thoughts. Sentence-aware cues (CUE_TURN_GAP) already cut the fragment rate
# to ~11%; this removes the rest of the problem rather than the symptom.
TRANSLATE_UNIT_MAX_CUES = int(os.environ.get("SUBWORKER_TRANSLATE_UNIT_MAX_CUES", "6"))
TRANSLATE_UNIT_MAX_CHARS = int(os.environ.get("SUBWORKER_TRANSLATE_UNIT_MAX_CHARS", "400"))

# Both caps matter: a sentence-level model degrades on a whole paragraph just
# as it does on a single word, and a subtitle file missing its final full stop
# would otherwise swallow the entire remainder into one unit.
SENTENCE_END_RE = re.compile(r'[.!?…]["\')\]]?$')


def group_cues_into_sentences(texts):
    """Consecutive cue indices grouped into units that end on a sentence."""
    units, cur, cur_chars = [], [], 0
    for i, t in enumerate(texts):
        cur.append(i)
        cur_chars += len(t) + 1
        if (SENTENCE_END_RE.search(t.strip())
                or len(cur) >= TRANSLATE_UNIT_MAX_CUES
                or cur_chars >= TRANSLATE_UNIT_MAX_CHARS):
            units.append(cur)
            cur, cur_chars = [], 0
    if cur:
        units.append(cur)
    return units


def split_translation(text, weights):
    """Spread one translated sentence back over N cues, proportionally to how
    much of the source each cue held, splitting only at word boundaries.

    Word order differs between languages, so this is an approximation - but it
    is an approximation of the LAYOUT only. The translation itself was made
    from the complete sentence, which is the part that determines whether the
    Danish is any good."""
    n = len(weights)
    if n == 1:
        return [text]
    words = text.split()
    if len(words) < n:
        # Too few words to give each cue one; the caller folds the empties
        # into the preceding cue's time window rather than showing blanks.
        return [text] + [""] * (n - 1)
    total = sum(weights) or 1
    out, start = [], 0
    for k in range(n):
        if k == n - 1:
            out.append(" ".join(words[start:]))
            break
        want = max(1, round(len(words) * weights[k] / total))
        # Always leave at least one word for each remaining cue.
        end = min(len(words) - (n - k - 1), start + want)
        out.append(" ".join(words[start:end]))
        start = end
    return out


# Sentence boundary: terminal punctuation, whitespace, then something that
# starts a new sentence (allowing an opening quote or bracket).
SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?…])\s+(?=["\'(\[]?[A-ZÆØÅ0-9])')


def translate_units(unit_texts):
    """Translate each unit ONE SENTENCE AT A TIME, then rejoin.

    NLLB returns a single sentence. Hand it two and it translates one and
    silently discards the rest - it does not truncate visibly or error, the
    text is simply gone. Measured directly:

        EN  We're here. Yeah, but where the hell is here, man?
        DA  - Ja, men hvor fanden er det her?          <- first sentence lost

        EN  I intend to be an upgrade. You're insane.
        DA  Jeg har til hensigt at blive en opgradering.   <- reply lost

    This predates sentence-grouping and applied to every cue that held more
    than one sentence, which was 25% of them before CUE_TURN_GAP and is still
    ~7% now (Whisper sometimes emits two sentences as one segment). It was
    quietly deleting dialogue from every translated file.

    Splitting here rather than in group_cues_into_sentences is deliberate: the
    grouping exists to REASSEMBLE sentences that a cue boundary tore apart,
    and this exists to SEPARATE sentences that share one. Both are needed, and
    they pull in opposite directions on the same text.

    Everything is still translated in one batched pass, so this costs nothing
    beyond a slightly longer list.
    """
    flat, spans = [], []
    for t in unit_texts:
        parts = [p for p in SENTENCE_SPLIT_RE.split(t) if p.strip()] or [t]
        spans.append((len(flat), len(parts)))
        flat.extend(parts)
    done = translate_texts_en_to_da(flat)
    return [" ".join(done[i:i + n]).strip() for i, n in spans]


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
    media = lp(job["media_path"])
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
        source_path = lp(job.get("subtitle_path"))
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

        # Translate SENTENCES, not cues (see group_cues_into_sentences).
        # Newlines are flattened first: a cue's internal line break is
        # typography, and feeding it to the model as-is just adds noise.
        src = [" ".join(c[1].split()) for c in cues]
        units = group_cues_into_sentences(src)
        unit_texts = [" ".join(src[j] for j in unit) for unit in units]
        translated_units = translate_units(unit_texts)

        translated = [""] * len(src)
        for unit, whole in zip(units, translated_units):
            parts = split_translation(whole, [max(1, len(src[j])) for j in unit])
            for j, part in zip(unit, parts):
                translated[j] = part

        out_cues = []
        for (timing, _), text in zip(cues, translated):
            start, _, end = [p.strip() for p in timing.partition("-->")]
            if text.strip():
                out_cues.append([start, end, text])
            elif out_cues:
                # A unit too short to give every cue a word put everything in
                # the first one. Hold that line across this window rather than
                # writing an empty subtitle or leaving a gap.
                out_cues[-1][1] = end

        fd, tmp_out = tempfile.mkstemp(suffix=".srt")
        os.close(fd)
        with open(tmp_out, "w", encoding="utf-8") as fh:
            for i, (start, end, text) in enumerate(out_cues, start=1):
                fh.write(f"{i}\n{start} --> {end}\n{wrap_cue(text)}\n\n")
        place_subtitle(tmp_out, target)  # overwrite, or re-own if refused

        record(key, mtime, None, "translated")
        # A translation keeps the SOURCE cues' timing verbatim (see the write
        # loop above - `timing` is copied unchanged), so it's exactly as
        # aligned as the English subtitle it came from. Register it in the
        # SYNC ledger too, same as a fresh Whisper transcription already
        # does, so the nightly sync task recognizes it as already-checked
        # and never runs ffsubsync on it - re-aligning an already-aligned
        # file has pure downside (a good sync risks becoming a worse one)
        # and zero upside. Until this fix, translated .da.srt files had NO
        # such protection and were fully exposed to the nightly sync task.
        # The marker is the durable half of that protection; the ledger row
        # below is only the fast path (see MARKER_SUFFIX).
        write_marker(target, "nllb")
        try:
            record(target, os.path.getmtime(target), 0.0, "in-sync")
        except OSError as exc:
            print(f"[oversætter] could not sync-protect {target}: {exc}", flush=True)
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

# Whisper's SEGMENT-level start can itself be wrong, not just individual word
# timestamps (the v2.1.5 fix): VAD can keep a "voice activity" span open
# across a long quiet/musical stretch with no dialogue (common right after a
# studio-logo intro) before the first real line, so a segment's start ends up
# far earlier than when its text was actually spoken - reported live (a
# minute early, then separately 35s, then still 12s after an earlier, looser
# version of this same cap). The segment's END is far more trustworthy. Cap
# how far back a raw cue's start can be from its end, sized off the cue's OWN
# text length. Calibrated against a real reported case: a 50-char line was
# actually spoken over ~6s (34s -> 40s in the source), ~8.3 chars/sec - 6
# chars/sec models even slow, deliberate delivery with real headroom above
# that; wider than what 6 chars/sec would need is almost certainly this same
# start-time artifact, not real speech.
CUE_MIN_SPEECH_CPS = 6.0     # worst-case-slow spoken delivery rate used to sanity-bound a cue's start
CUE_START_SLACK_FLOOR = 2.0  # minimum slack (seconds) so a very short line/interjection isn't over-clipped

# Whisper emits one segment per phrase, so cue-per-segment gives a rapid
# flicker of short single lines. Instead we merge neighbouring segments into
# proper subtitles (up to 2 lines, standard ~42 chars/line) as long as the
# pause between them is short and the result stays readable in one glance.
CUE_MAX_LINE_CHARS = 42      # per-line width before wrapping to a 2nd line
CUE_MAX_LINES = 2            # cap at a 2-line block (subtitle convention)
CUE_MAX_CHARS = CUE_MAX_LINE_CHARS * CUE_MAX_LINES  # merge budget
CUE_MERGE_MAX_GAP = 0.9      # don't merge across a pause longer than this

# Whisper has no idea who is speaking - it produces text and timings, nothing
# else - so a cue can end up holding the end of one person's line and the
# start of the reply, wrapped at whatever character position the width happens
# to land on. Measured across 18 generated files here: 40% of cues contained
# more than one sentence, and a readable share of those were two speakers.
#
# Actually identifying speakers needs diarization (pyannote/WhisperX), which
# is a separate model, licence and a large slice of extra GPU time. But most
# of the damage does not need speaker identity to avoid - it comes from THIS
# file merging two segments that Whisper had correctly kept apart. So the
# merge is simply refused where a turn is likely: the previous segment closed
# a sentence AND there was a real pause before the next one started.
#
# It is a heuristic and it is deliberately conservative. Fast overlapping
# dialogue with no pause will still merge, and a speaker who pauses mid-
# thought after a full stop will still be split into two cues - which is
# harmless, since that is just two subtitles instead of one. What it stops is
# the case that actually reads badly: two people sharing one cue.
# 0 means "never merge across a completed sentence", which is where the
# measurements landed. Swept on a real episode's segments, re-rendering the
# same transcription at each value:
#
#     gap    cues   cues holding 2+ sentences
#     0.90    379   96 (25.3%)   <- the old behaviour
#     0.35    412   75 (18.2%)
#     0.20    437   60 (13.7%)
#     0.00    468   32 ( 6.8%)
#
# 23% more cues buys a two-thirds cut in cues that hold more than one
# utterance. That is not flicker - 468 cues across a 42-minute episode is one
# subtitle every 5.4 seconds against 6.6 before - and CUE_MIN_DURATION still
# guarantees nothing flashes past unreadably.
#
# The 6.8% that remain are cases where Whisper emitted both sentences as ONE
# segment, so no merge ever happened and nothing here can separate them;
# that floor needs real diarization to go lower.
#
# Raise it if you would rather have fewer, denser subtitles: any value up to
# CUE_MERGE_MAX_GAP re-enables merging across sentences that are closer
# together than the value given.
CUE_TURN_GAP = float(os.environ.get("SUBWORKER_CUE_TURN_GAP", "0"))

# Terminal punctuation at the very end of a string (allowing a closing quote
# or bracket after it).
TERMINAL_PUNCT_RE = re.compile(r'[.!?]["\'\)\]]?\s*$')

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
    segment bounds when word timing isn't available. Word timestamps come
    from cross-attention alignment, which occasionally produces a wild
    outlier - a word's start/end off by seconds, sometimes far more (observed
    live: a cue appearing roughly a minute before the line was actually
    spoken). The segment's own bounds are VAD-derived and far more reliable,
    so clamp to them - this is a no-op in the normal case (word timestamps
    naturally fall inside their segment) and only kicks in to reel back a
    glitch."""
    words = getattr(segment, "words", None) or []
    words = [w for w in words if getattr(w, "start", None) is not None and getattr(w, "end", None) is not None]
    if words:
        start = max(words[0].start, segment.start)
        end = min(words[-1].end, segment.end)
        if end > start:
            return start, end
    return segment.start, segment.end


def _wrap_paragraph(text: str, width: int) -> list:
    """Greedy word-fill into lines of at most `width` chars each - never
    breaks a word, so a line can run over width only if a single word does."""
    words = text.split()
    lines, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines


def _wrap_lines(text: str) -> str:
    """Wrap a cue's text to at most CUE_MAX_LINES balanced lines. A single
    short line is left alone; a long line is split near the middle at a word
    boundary so both halves fit CUE_MAX_LINE_CHARS."""
    if len(text) <= CUE_MAX_LINE_CHARS:
        return text
    words = text.split()
    # Prefer a 2-line split that ENDS THE FIRST LINE ON A SENTENCE, falling
    # back to the most balanced split when there is no sentence boundary to
    # use. Balance alone breaks wherever the character count happens to land,
    # so a cue holding two sentences - which is most often two speakers -
    # would put the tail of one line and the head of the next on the same row.
    # Breaking at the boundary keeps each utterance on its own line, and is an
    # improvement even when it IS one person: nobody wants a line break in the
    # middle of a clause when a full stop was available.
    best = None
    for i in range(1, len(words)):
        top = " ".join(words[:i])
        bottom = " ".join(words[i:])
        if len(top) <= CUE_MAX_LINE_CHARS and len(bottom) <= CUE_MAX_LINE_CHARS:
            at_sentence = bool(TERMINAL_PUNCT_RE.search(top))
            # Tuple ordering does the ranking: any sentence-boundary split
            # beats every balanced one, and ties are settled on balance.
            score = (0 if at_sentence else 1, abs(len(top) - len(bottom)))
            if best is None or score < best[0]:
                best = (score, top + "\n" + bottom)
    if best is not None:
        return best[1]
    # write_srt splits any cue too long for CUE_MAX_LINES into multiple
    # subtitle blocks before this is ever called (_split_overlong_cue) - this
    # is just a safety net so nothing is silently dropped if that changes.
    return "\n".join(_wrap_paragraph(text, CUE_MAX_LINE_CHARS))


def _split_overlong_cue(cue):
    """A merged cue whose text can't fit CUE_MAX_LINES at CUE_MAX_LINE_CHARS
    is split into consecutive sub-cues (each capped at CUE_MAX_LINES) instead
    of letting one subtitle block grow a 3rd/4th line - the original time
    span is divided across the pieces proportionally by character count."""
    start, end, text = cue
    lines = _wrap_paragraph(text, CUE_MAX_LINE_CHARS)
    if len(lines) <= CUE_MAX_LINES:
        return [cue]
    chunks = [
        " ".join(lines[i:i + CUE_MAX_LINES])
        for i in range(0, len(lines), CUE_MAX_LINES)
    ]
    total_chars = sum(len(c) for c in chunks) or 1
    total_dur = end - start
    out = []
    t = start
    for i, chunk in enumerate(chunks):
        if i == len(chunks) - 1:
            c_end = end
        else:
            c_end = t + total_dur * (len(chunk) / total_chars)
        out.append([t, c_end, chunk])
        t = c_end
    return out


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
        max_span = max(CUE_START_SLACK_FLOOR, len(text) / CUE_MIN_SPEECH_CPS)
        if end - start > max_span:
            start = end - max_span
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
            # A finished sentence followed by a real pause reads as someone
            # else answering - keep them as separate subtitles (see
            # CUE_TURN_GAP).
            likely_turn = bool(TERMINAL_PUNCT_RE.search(prev[2])) and gap >= CUE_TURN_GAP
            if (not likely_turn
                    and gap <= CUE_MERGE_MAX_GAP
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

    # A merge (or a single long unbroken segment) can still be too long for
    # a 2-line block - split it into consecutive blocks now, before duration/
    # anti-overlap run, so every subtitle actually shown is <=CUE_MAX_LINES.
    expanded = []
    for cue in cues:
        expanded.extend(_split_overlong_cue(cue))
    cues = expanded

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
#
# Each also has a PRIORITY sibling, drained first (see worker_loop/ml_loop).
# The nightly scheduled tasks can queue hundreds of jobs ahead of a one-off
# per-item button click - a plain FIFO meant "instantly" from the item page
# could really mean "behind the whole nightly batch". The plugin's per-item
# endpoints (Fix undertekst-sync / Generér undertekster) mark their job
# priority=True so a manual click jumps straight to the front instead.
job_queue: "queue.Queue[dict]" = queue.Queue()
priority_job_queue: "queue.Queue[dict]" = queue.Queue()
ml_queue: "queue.Queue[dict]" = queue.Queue()
priority_ml_queue: "queue.Queue[dict]" = queue.Queue()


# ---- Queue durability ----
# The four queues above live in memory, and everything in them dies with the
# process. That is not a theoretical concern: a 15-item batch was lost when
# the machine slept two minutes after submission, and a full-library run lost
# 1,817 queued jobs when the worker took a native access violation six hours
# in. Neither left a trace - the jobs were accepted, and then simply gone.
#
# Restarting is NORMAL here, not exceptional: idle-restart deliberately exits
# to free VRAM, the daily self-update restarts, and a crash is relaunched by
# the wrapper within seconds. A queue that cannot survive that is a queue that
# cannot be trusted with a multi-day batch.
#
# So the queue is mirrored into the same SQLite file as the ledger: a row per
# queued job, removed when the job finishes (or is stolen), replayed at
# startup. Deliberately not a full transactional job store - a job that was
# mid-flight when the process died is replayed, which is safe because every
# processor is idempotent (already_processed and the marker check both make a
# repeat a cheap no-op).
QUEUE_PERSIST = os.environ.get("SUBWORKER_PERSIST_QUEUE", "1") != "0"


def _queue_db():
    conn = db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS queued (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job TEXT NOT NULL,
            created TEXT NOT NULL
        )"""
    )
    return conn


def _persist_job(job: dict):
    """Record a queued job and stamp it with its row id so it can be removed
    again once finished."""
    if not QUEUE_PERSIST or job.get("_qid"):
        return
    try:
        import json as _j
        conn = _queue_db()
        try:
            cur = conn.execute(
                "INSERT INTO queued (job, created) VALUES (?,?)",
                (_j.dumps(job), datetime.now(timezone.utc).isoformat()),
            )
            job["_qid"] = cur.lastrowid
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 - never fail a submission over this
        print(f"[queue] could not persist job: {exc}", flush=True)


def forget_job(job: dict):
    """Drop a job's persisted row - it is finished, or has moved to a peer."""
    qid = job.get("_qid") if isinstance(job, dict) else None
    if not QUEUE_PERSIST or not qid:
        return
    try:
        conn = _queue_db()
        try:
            conn.execute("DELETE FROM queued WHERE id = ?", (qid,))
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        print(f"[queue] could not forget job {qid}: {exc}", flush=True)


def restore_queue():
    """Replay jobs that were still queued when this process last stopped."""
    if not QUEUE_PERSIST:
        return
    try:
        import json as _j
        conn = _queue_db()
        try:
            rows = conn.execute("SELECT id, job FROM queued ORDER BY id").fetchall()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        print(f"[queue] could not read persisted queue: {exc}", flush=True)
        return

    restored = 0
    for qid, blob in rows:
        try:
            job = _j.loads(blob)
        except Exception:  # noqa: BLE001 - skip a corrupt row rather than die
            continue
        job["_qid"] = qid
        _enqueue_in_memory(job)
        restored += 1
    if restored:
        print(f"[queue] restored {restored} job(s) left over from the previous run", flush=True)


def _enqueue_in_memory(job: dict):
    priority = bool(job.get("priority"))
    if job.get("type") in ("transcribe", "translate"):
        (priority_ml_queue if priority else ml_queue).put(job)
    else:
        (priority_job_queue if priority else job_queue).put(job)


def enqueue_job(job: dict):
    _persist_job(job)
    _enqueue_in_memory(job)


def total_queue_depth() -> int:
    return job_queue.qsize() + priority_job_queue.qsize() + ml_queue.qsize() + priority_ml_queue.qsize()


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
# "Success" here means RESOLVED, not "we changed something": a file we
# deliberately decided to leave alone is just as finished as one we fixed, and
# must not be picked up again.
#
# low-quality-skip was missing from this list, and that omission was the
# "double work". It is a terminal decision - ffsubsync assessed the alignment,
# rejected it, and wrote the original back untouched - and _stat_category has
# always counted it as "skipped", i.e. resolved. But because it was absent
# here, already_processed() kept returning False for those files, so every
# single night the worker re-streamed the whole media file and re-ran a full
# ffsubsync alignment on every subtitle ffsubsync had already refused, forever,
# to arrive at the identical answer. Nothing ever recorded progress, so nothing
# ever stopped. That gate rejects on ANY of three conditions (anti-correlated
# score, offset over 30s, framerate deviation), so on a real library this is
# not a rare path.
SUCCESS_STATUSES = (
    "fixed",
    "in-sync",
    "already-has-sub",
    "rolled-back",
    "translated",
    "suspect-offset",
    "low-quality-skip",
    "generated-skip",
    "subtitle-mismatch",
)


# The ledger stores a DECISION, and a decision is only as valid as the policy
# it was made under. Turning framerate rescaling off changes what ffsubsync
# would conclude about a file, so verdicts reached under the old policy have
# to be reopened once - otherwise every file previously rejected as
# low-quality would now be skipped forever on the strength of an answer this
# worker would no longer give. (That becomes a permanent condition precisely
# BECAUSE low-quality-skip is now a success status; before this release those
# rows were re-tried nightly, which was its own bug.)
#
# Deliberately limited to the two re-evaluatable verdicts. It must never touch
# 'in-sync', because that status is doubling as the sync-protection row for
# machine-generated subtitles - clearing those would hand every transcription
# and translation straight back to ffsubsync, i.e. cause the exact bug this
# release exists to fix.
# The trailing component is a plain revision counter for how a verdict is
# CLASSIFIED, as opposed to the thresholds above which govern what is applied.
# Bumping it reopens the stored verdicts once.
#
# It is at 2 because 2.3.0 started separating subtitle-mismatch (the subtitle
# is not for this file) from low-quality-skip (couldn't align confidently).
# Without the bump nothing would change on an existing library: every such
# file is already recorded as low-quality-skip, and low-quality-skip is now a
# resolved status, so it would never be looked at again and could never be
# reclassified. The whole point of the new status is to produce a worklist of
# files worth transcribing, and that list would have stayed empty.
SYNC_POLICY = f"framerate={int(ALLOW_FRAMERATE_FIX)};maxoffset={MAX_OFFSET_SECONDS};classify=2"


def reset_stale_verdicts():
    conn = db()
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        row = conn.execute("SELECT value FROM meta WHERE key = 'sync_policy'").fetchone()
        previous = row[0] if row else None
        if previous == SYNC_POLICY:
            return
        cur = conn.execute(
            "DELETE FROM processed WHERE status IN ('low-quality-skip', 'suspect-offset')"
        )
        conn.execute(
            "REPLACE INTO meta (key, value) VALUES ('sync_policy', ?)", (SYNC_POLICY,)
        )
        conn.commit()
        if previous is not None:
            print(
                f"[policy] sync policy changed ({previous} -> {SYNC_POLICY}); "
                f"reopened {cur.rowcount} previous verdict(s) for one re-check",
                flush=True,
            )
    finally:
        conn.close()


def backfill_markers():
    """Mark subtitles this worker generated BEFORE markers existed.

    Without this, the durable protection only covers files generated from now
    on, and every transcription and translation already sitting in the library
    - precisely the ones being damaged today - would stay exposed to the
    nightly sync until something happened to regenerate them.

    The ledger still knows what was produced, and the output paths are
    deterministic: a transcribe row carries the media path in its key and the
    detected language in its status, and a translate row always wrote
    <base>.da.srt. So both can be reconstructed exactly.

    Idempotent, and only ever marks a file that is actually on disk.
    """
    if not MARKERS_ENABLED:
        return
    conn = db()
    try:
        rows = conn.execute(
            "SELECT sub_path, status FROM processed "
            "WHERE sub_path LIKE 'transcribe:%' OR sub_path LIKE 'translate:%'"
        ).fetchall()
    finally:
        conn.close()

    marked = 0
    for sub_path, status in rows:
        s = str(status)
        try:
            if sub_path.startswith("transcribe:") and s.startswith("transcribed:"):
                media = sub_path[len("transcribe:"):]
                lang = s[len("transcribed:"):]
                if not lang:
                    continue
                target = f"{os.path.splitext(media)[0]}.{lang}.srt"
                origin = "whisper"
            elif sub_path.startswith("translate:") and s == "translated":
                media = sub_path[len("translate:"):]
                target = os.path.splitext(media)[0] + ".da.srt"
                origin = "nllb"
            else:
                continue
            if os.path.isfile(target) and not os.path.exists(marker_path(target)):
                write_marker(target, origin)
                marked += 1
        except OSError:
            continue

    if marked:
        print(f"[marker] backfilled {marked} previously-generated subtitle(s)", flush=True)


def already_processed(sub_path: str, mtime: float) -> bool:
    conn = db()
    try:
        row = conn.execute(
            "SELECT mtime, status FROM processed WHERE sub_path = ?", (sub_path,)
        ).fetchone()
        if row is None:
            return False
        # transcribed:<lang> and fixed-framerate:<factor> carry a value in the
        # status, so they can't be matched by membership alone.
        ok = (
            row[1] in SUCCESS_STATUSES
            or str(row[1]).startswith("transcribed:")
            or str(row[1]).startswith("fixed-framerate:")
        )
        return ok and abs(row[0] - mtime) < 1e-6
    finally:
        conn.close()


def _previous_offset(sub_path: str):
    """The offset currently recorded for this path, if any.

    Used when a status changes but the measurement behind it is still worth
    keeping - notably a rollback, where the applied shift is the whole reason
    anyone would investigate later."""
    conn = db()
    try:
        row = conn.execute(
            "SELECT offset_seconds FROM processed WHERE sub_path = ?", (sub_path,)
        ).fetchone()
        return row[0] if row else None
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


# ---- Provenance markers for machine-generated subtitles ----
# A Whisper transcription is built FROM the audio, and a translation copies
# its source's cue timings verbatim. Both are therefore already as aligned as
# they will ever be, and running ffsubsync over them has no upside and real
# downside.
#
# That was already the intent: both paths write an "in-sync" row into the sync
# ledger to make the nightly task skip them. But that protection is a row in
# ONE worker's local SQLite, keyed on an exact mtime, and it is consulted as a
# union across whichever workers happen to answer. It evaporates if the worker
# that generated the file is offline at sync time (GetProcessedPaths swallows
# the error and contributes nothing), if its /processed call fails, if the
# mtime shifts by any amount, or if that worker's DB is ever reset or
# reinstalled. Any one of those and a machine-generated subtitle is handed
# straight to ffsubsync - which is what has been happening.
#
# So the fact is recorded next to the file instead, where it cannot drift out
# of sync with the thing it describes: every worker mounts the same media, so
# every worker can see it, no matter which one generated it or what happened
# to anyone's database. The ledger rows stay as a cheap fast path; this is the
# guarantee underneath them. Precedent for writing beside the media already
# exists here - that is what .bak is.
MARKER_SUFFIX = ".sgmeta"
MARKERS_ENABLED = os.environ.get("SUBWORKER_MARKERS", "1") != "0"


def marker_path(subtitle_path: str) -> str:
    return subtitle_path + MARKER_SUFFIX


def write_marker(subtitle_path: str, generated_by: str):
    """Record that this subtitle is machine-generated. Best-effort: a
    read-only share must not fail the job that just succeeded."""
    if not MARKERS_ENABLED:
        return
    try:
        import json
        with open(marker_path(subtitle_path), "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "generated_by": generated_by,
                    "at": datetime.now(timezone.utc).isoformat(),
                    "worker_version": WORKER_VERSION,
                },
                fh,
            )
    except OSError as exc:
        print(f"[marker] could not mark {subtitle_path}: {exc}", flush=True)


def is_machine_generated(subtitle_path: str) -> bool:
    if not MARKERS_ENABLED:
        return False
    try:
        return os.path.isfile(marker_path(subtitle_path))
    except OSError:
        return False


OFFSET_RE = re.compile(r"offset seconds:\s*(-?[\d.]+)", re.IGNORECASE)
# ffsubsync logs this right beside the offset ("framerate scale factor: %.3f").
# Parsed so a rescale can never be applied without this worker noticing it.
SCALE_RE = re.compile(r"framerate scale factor:\s*(-?[\d.]+)", re.IGNORECASE)
# --skip-sync-on-low-quality's own rejection ("leaving subtitles unmodified")
# still logs "offset seconds: X" BEFORE the quality check runs - so OFFSET_RE
# alone can't tell a real fix from a no-op. This distinguishes them.
LOW_QUALITY_RE = re.compile(r"low-quality alignment", re.IGNORECASE)
# ffsubsync logs its alignment score. The MAGNITUDE is unnormalised and varies
# hugely with subtitle length - measured across six episodes of one show:
# +40,205 to +177,137 - so it is useless as an absolute threshold. The SIGN is
# not: negative means the best alignment found is anti-correlated, i.e. the
# subtitle does not belong to this file.
#
# That distinction matters because the two cases need opposite responses.
# A subtitle that is merely shifted can be repaired. A subtitle for a
# different cut of the film cannot - inserted scenes are non-linear, and
# ffsubsync's model is one offset plus at most a linear scale. Measured on
# Superbad, whose file is the 118.7-minute unrated cut while its subtitle is
# the theatrical one: score -50,569, offset 55.1s, and quite rightly refused.
#
# Recording those separately turns a dead end into a worklist: a subtitle that
# does not match its media is the strongest possible case for transcribing the
# file, which is the one repair that always works because it is made from the
# audio itself.
SCORE_RE = re.compile(r"score:\s*(-?[\d.]+)", re.IGNORECASE)


def place_subtitle(out_path: str, sub: str):
    """Move the corrected subtitle into place. Normally a plain overwrite,
    but many external subs (e.g. Jellyfin's OpenSubtitles plugin downloads)
    are owned by a DIFFERENT identity than the worker's SMB session, so the
    worker can't overwrite them (Permission denied) even though it can create
    and delete files in the folder (that's how it writes the .bak). When the
    overwrite is refused, delete the un-owned file and drop our copy in its
    place - it now belongs to the worker, so this file syncs cleanly forever
    after. Used by every job type that can write over an existing subtitle
    (sync, transcribe, translate) - the incoming file already carries the
    right content (ffsubsync-aligned, or freshly generated), so nothing is
    lost by re-owning the path."""
    try:
        shutil.move(out_path, sub)
        return
    except (PermissionError, OSError) as exc:
        if not isinstance(exc, PermissionError) and getattr(exc, "errno", None) not in (errno.EACCES, errno.EPERM):
            raise
    # Re-own: remove the externally-owned file (a directory-level operation,
    # which the worker is allowed), then write our synced copy as a new file.
    # CIFS/SMB rename-over-an-existing-file can unlink the destination as
    # part of a rename attempt it then still reports as failed (observed
    # live: shutil.move's internal os.rename raised EACCES, but the target
    # had already vanished by the time we got here) - FileNotFoundError here
    # just means the re-own is already halfway done, not a new failure. Any
    # OTHER failure (e.g. a real read-only flag) still propagates.
    try:
        os.remove(sub)
    except FileNotFoundError:
        pass
    shutil.move(out_path, sub)


def process_job(job: dict):
    media = lp(job["media_path"])
    sub = lp(job["subtitle_path"])

    if not os.path.isfile(media) or not os.path.isfile(sub):
        record(sub, 0, None, "missing-file")
        with state_lock:
            state["failed"] += 1
        return

    mtime = os.path.getmtime(sub)

    # Never re-align something this pool generated itself. Checked before the
    # ledger, because the whole point of the marker is to hold when the ledger
    # does not (see MARKER_SUFFIX). Recorded as a resolved outcome so the
    # plugin stops shipping the job at all after the first pass.
    if is_machine_generated(sub):
        record(sub, mtime, None, "generated-skip")
        with state_lock:
            state["skipped"] += 1
        return

    if already_processed(sub, mtime):
        with state_lock:
            state["skipped"] += 1
        return

    out_fd, out_path = tempfile.mkstemp(suffix=os.path.splitext(sub)[1])
    os.close(out_fd)
    try:
        cmd = [
            FFSUBSYNC, media, "-i", sub, "-o", out_path,
            # ffsubsync's OWN confidence gate. Without this it applies
            # whatever alignment it computes, however low-confidence -
            # this flag makes it leave the subtitle unmodified instead
            # when the score is anti-correlated, the offset implausible,
            # or the framerate correction absurd. Note its framerate arm is
            # far looser than it sounds (10% by default), which is why the
            # explicit policy below exists rather than relying on it.
            "--skip-sync-on-low-quality",
        ]
        if not ALLOW_FRAMERATE_FIX:
            # BOTH flags, deliberately. ffsubsync reaches a rescale by two
            # independently-gated routes - the discrete framerate ratios
            # (--no-fix-framerate) and a ratio inferred from track lengths
            # (--skip-infer-framerate-ratio) - so passing only the first
            # silently leaves rescaling fully enabled. Verified against 0.5.0:
            # with --no-fix-framerate alone a 23.976->25 stretch was still
            # rescaled by the inferred path.
            cmd.extend(["--no-fix-framerate", "--skip-infer-framerate-ratio"])
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            # Decode as UTF-8 explicitly. text=True otherwise decodes using the
            # LOCALE encoding, which on a Windows worker is cp1252 - and
            # ffsubsync's progress output contains bytes cp1252 cannot decode.
            # The reader thread then dies with UnicodeDecodeError and the log
            # arrives EMPTY, so no offset is ever parsed and every sync job on
            # that box records unparseable-offset. Seen exactly that way here.
            encoding="utf-8",
            errors="replace",
            timeout=1800,
        )
        log = (proc.stdout or "") + (proc.stderr or "")
        m = OFFSET_RE.search(log)
        offset = float(m.group(1)) if m else None
        sm = SCALE_RE.search(log)
        scale = float(sm.group(1)) if sm else None
        sc = SCORE_RE.search(log)
        score = float(sc.group(1)) if sc else None
        low_quality = bool(LOW_QUALITY_RE.search(log))

        if proc.returncode != 0 or not os.path.getsize(out_path):
            record(sub, mtime, offset, "ffsubsync-failed")
            with state_lock:
                state["failed"] += 1
            return

        if low_quality:
            # ffsubsync itself rejected the alignment and wrote the ORIGINAL
            # content back unchanged - nothing to apply, and doing so anyway
            # would be a no-op that misleadingly logs as "fixed" and churns
            # a fresh .bak for no reason.
            #
            # A NEGATIVE score separates "couldn't align this confidently"
            # from "this subtitle isn't for this file" (see SCORE_RE). The
            # latter is unfixable by shifting and is recorded distinctly, so
            # it can be acted on - transcribing the media is the repair.
            status = "subtitle-mismatch" if (score is not None and score < 0) else "low-quality-skip"
            record(sub, mtime, offset, status)
            with state_lock:
                state["done"] += 1
            return

        if offset is None:
            # Could not confirm what ffsubsync actually did - applying an
            # unverified result is exactly how a bad sync gets applied
            # silently. Fail closed: keep the original, flag for review.
            record(sub, mtime, None, "unparseable-offset")
            with state_lock:
                state["failed"] += 1
            return

        # Did ffsubsync actually rescale time, as opposed to just shifting?
        rescaled = scale is not None and abs(scale - 1.0) > FRAMERATE_EPSILON

        if abs(offset) < MIN_OFFSET_SECONDS and not rescaled:
            # Already in sync - leave the original untouched, remember that
            # this version was checked.
            record(sub, mtime, offset, "in-sync")
            with state_lock:
                state["done"] += 1
            return

        # `and not rescaled` above is the fix for a whole class of subtitle
        # this worker silently refused to repair.
        #
        # A pure framerate mismatch shifts nothing: the first cue is already
        # in the right place, and only later ones drift as the error
        # accumulates. ffsubsync reports exactly that - offset 0.000, scale
        # 0.959 - and the old code, which read the offset and nothing else,
        # concluded "under MIN_OFFSET, therefore fine", recorded in-sync, and
        # discarded a correct repair. Measured on a real 23.976->25 case: the
        # repair was accurate to the frame, and it was thrown away, leaving
        # the subtitle 103 seconds out by the end of the episode. Recording it
        # as in-sync then meant it was never looked at again.
        #
        # So the decision has to be made on the transformation that was
        # actually computed, not on one half of it.

        # Belt and braces on the rescale. --no-fix-framerate above should mean
        # this never fires, but a version/flag drift that quietly re-enables
        # rescaling would otherwise be invisible AND destructive, and this is
        # the exact failure that corrupted subtitles in the first place. If a
        # scale was applied that we did not ask for, keep the original.
        if scale is not None and abs(scale - 1.0) > FRAMERATE_EPSILON and not ALLOW_FRAMERATE_FIX:
            record(sub, mtime, offset, f"framerate-rejected:{scale:.4f}")
            with state_lock:
                state["failed"] += 1
            return

        if abs(offset) > MAX_OFFSET_SECONDS:
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
        # as processed. A rescale gets its own status carrying the factor:
        # stretching every timestamp is a far bigger intervention than sliding
        # them, and if one ever does go wrong the operator needs to be able to
        # find precisely those files rather than sift the whole "fixed" pile.
        status = f"fixed-framerate:{scale:.4f}" if rescaled else "fixed"
        record(sub, os.path.getmtime(sub), offset, status)
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
    media = lp(job["media_path"])
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
    audio_tmp = None
    try:
        model = get_whisper_model()

        # Choose the audio track BEFORE transcribing (see PREFERRED_AUDIO_LANGS).
        # When a preferred track exists it is extracted to a temporary wav and
        # transcribed instead of the file, because faster-whisper decodes the
        # container's default track and gives no way to ask for another.
        # 16kHz mono is exactly what Whisper resamples to anyway, so this
        # costs a short ffmpeg pass and no quality.
        source = media
        forced_lang = job.get("language") or None
        picked_index, picked_lang = (None, None)
        if not forced_lang:
            picked_index, picked_lang = pick_audio_stream(media)
            # Pin the language from the container tag even when no extraction
            # is needed. If the extraction below runs it re-affirms this; if
            # it fails, we still transcribe the default track in the language
            # the file itself says it is, rather than guessing.
            if picked_lang:
                forced_lang = picked_lang
        if picked_index is not None:
            fd, audio_tmp = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            extract = subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", media, "-map", f"0:{picked_index}",
                 "-vn", "-ac", "1", "-ar", "16000", audio_tmp],
                capture_output=True, text=True, timeout=1800,
            )
            if extract.returncode == 0 and os.path.getsize(audio_tmp) > 0:
                source = audio_tmp
                forced_lang = picked_lang
                print(f"[whisper] using audio stream {picked_index} ({picked_lang}) "
                      f"of {os.path.basename(media)}", flush=True)
            else:
                # Extraction failed - fall back to the default track rather
                # than failing a job that would otherwise have produced
                # something usable.
                os.unlink(audio_tmp)
                audio_tmp = None
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
            # initial_prompt primes the decode context with a fully-punctuated
            # example sentence - Whisper measurably keeps punctuating more
            # consistently when the prompt models that style, and this
            # composes fine with hotwords (faster-whisper concatenates
            # hotwords_tokens then previous_tokens - which start with this
            # prompt - into the same decode window; see get_prompt() in
            # faster_whisper/transcribe.py). Kept short so it can't meaningfully
            # eat into the hotwords/decode budget that HOTWORDS_MAX_CHARS and
            # the no-hotwords retry below already guard.
            kw = {
                "language": forced_lang,
                "word_timestamps": True,
                "beam_size": WHISPER_BEAM,
                "vad_filter": WHISPER_VAD,
                "vad_parameters": _whisper_vad_parameters() if WHISPER_VAD else None,
                "initial_prompt": WHISPER_PUNCTUATION_PROMPT.get(
                    forced_lang, WHISPER_PUNCTUATION_PROMPT["en"]
                ),
            }
            if not forced_lang:
                # Only meaningful when auto-detecting; sampling several windows
                # instead of just the opening one (see LANG_DETECT_SEGMENTS).
                kw["language_detection_segments"] = LANG_DETECT_SEGMENTS
                kw["language_detection_threshold"] = LANG_DETECT_THRESHOLD
            if use_hotwords and hotwords:
                import inspect
                if "hotwords" in inspect.signature(model.transcribe).parameters:
                    kw["hotwords"] = hotwords
                else:
                    kw["initial_prompt"] += " Names and terms used: " + hotwords + "."
            # `source` is the extracted preferred track when there was one,
            # otherwise the media file itself.
            return model.transcribe(source, **kw)

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

        # About to overwrite a subtitle that is NOT ours - which now happens
        # deliberately, when the plugin has been told this file's subtitle is
        # the wrong one for it. Keep the original first, using the same .bak
        # convention sync uses, so a machine transcription replacing somebody's
        # real subtitle is always reversible. Ours don't need this: they are
        # reproducible by definition.
        if os.path.exists(target) and not is_machine_generated(target):
            backup = target + ".bak"
            if not os.path.exists(backup):
                try:
                    shutil.copy2(target, backup)
                    print(f"[whisper] kept original as {os.path.basename(backup)}", flush=True)
                except OSError as exc:
                    print(f"[whisper] could not back up {target}: {exc}", flush=True)

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

        place_subtitle(out_path, target)  # overwrite, or re-own if refused
        out_path = None
        record(key, mtime, None, f"transcribed:{info.language}")
        # A Whisper transcription is built FROM the audio (word-level
        # timestamps), so it's already audio-aligned. Two layers stop the
        # nightly sync from "fixing" it: a marker beside the file, which any
        # worker can see and which survives this one's database (see
        # MARKER_SUFFIX), and a ledger row as the cheap fast path.
        write_marker(target, "whisper")
        try:
            record(target, os.path.getmtime(target), 0.0, "in-sync")
        except OSError as exc:
            print(f"[whisper] could not sync-protect {target}: {exc}", flush=True)
        # Auto-chain: a fresh ENGLISH transcription can go straight to the
        # da-translation queue instead of waiting for the nightly translate
        # task - the item has a Danish sub by morning in one flow. Only when
        # this worker can translate (NLLB) - which it can, since transcription
        # is CUDA-only and the NLLB model lives on the same GPU box.
        if job.get("chain_translate") and info.language == "en" and TRANSLATE_CAPABILITY:
            # Inherit priority from the transcribe job that triggered this -
            # a manual per-item click should stay fast end-to-end, not lose
            # its place in line the moment it chains to translation.
            chain_queue = priority_ml_queue if job.get("priority") else ml_queue
            chain_queue.put({"type": "translate", "media_path": media, "subtitle_path": target, "priority": job.get("priority", False)})
        with state_lock:
            state["done"] += 1
    except Exception as exc:  # noqa: BLE001 - keep the worker alive
        record(key, mtime, None, f"error: {exc}")
        with state_lock:
            state["failed"] += 1
    finally:
        if out_path and os.path.exists(out_path):
            os.unlink(out_path)
        # The extracted audio track can be a few hundred MB for a film.
        if audio_tmp and os.path.exists(audio_tmp):
            os.unlink(audio_tmp)


def worker_loop():
    name = threading.current_thread().name
    while True:
        # Respect pause BEFORE pulling a job, so pausing takes effect after
        # the current file finishes and a subsequent queue-clear works.
        pause_event.wait()
        # Priority jobs (a manual per-item click) always go first - only
        # fall through to the regular FIFO's blocking wait when there isn't
        # one sitting ready right now.
        try:
            job = priority_job_queue.get_nowait()
            src_queue = priority_job_queue
        except queue.Empty:
            try:
                job = job_queue.get(timeout=1)
                src_queue = job_queue
            except queue.Empty:
                continue

        # A thread already blocked in get() when /pause engages still wins the
        # next submitted job (confirmed by test: pause -> submit -> the job ran
        # anyway). Hand it back and go respect the gate instead of processing
        # while "paused".
        if not pause_event.is_set():
            src_queue.put(job)
            src_queue.task_done()
            continue

        # ML jobs never belong on sync threads (see enqueue_job) - reroute
        # any stray one instead of letting it block a sync slot on the lock.
        if job.get("type") in ("transcribe", "translate"):
            (priority_ml_queue if job.get("priority") else ml_queue).put(job)
            src_queue.task_done()
            continue

        label = job.get("subtitle_path") or job.get("media_path")
        with state_lock:
            state["processing"][name] = label
        try:
            process_job(job)
        finally:
            # Done (or failed with a recorded verdict) - drop the persisted
            # copy so a restart does not replay it.
            forget_job(job)
            with state_lock:
                state["processing"].pop(name, None)
            src_queue.task_done()


def ml_loop():
    """The single ML thread: transcriptions and translations, one at a time
    (a second large-v3 on the same GPU would OOM). Sync threads keep flowing
    in parallel, so a both-roles box genuinely does sync + transcribe at once."""
    name = threading.current_thread().name
    while True:
        pause_event.wait()
        # Priority first, same reasoning as worker_loop.
        try:
            job = priority_ml_queue.get_nowait()
            src_queue = priority_ml_queue
        except queue.Empty:
            try:
                job = ml_queue.get(timeout=1)
                src_queue = ml_queue
            except queue.Empty:
                continue

        # Same pause-vs-get race as worker_loop: hand the job back if pause
        # engaged while we were blocked in get().
        if not pause_event.is_set():
            src_queue.put(job)
            src_queue.task_done()
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
            forget_job(job)
            with state_lock:
                state["processing"].pop(name, None)
                state["ml_progress"] = None
            src_queue.task_done()


def _models_resident():
    return _whisper_model is not None or _translator is not None


def _worker_busy():
    with state_lock:
        active = bool(state["processing"])
    return active or total_queue_depth() > 0


def keep_awake_loop():
    """Stop Windows sleeping while there is work queued or running.

    A worker on a desktop is a different proposition to one in a rack: the
    machine sleeps on its own schedule, and the job queues live in memory
    (see the queue.Queue definitions above), so anything still queued dies
    with the process and is never heard of again.

    That is not hypothetical - it is how a 15-item batch was lost here. The
    jobs were accepted, the machine slept about two minutes later, and on
    resume the queue was empty with nothing in the ledger to show any of it
    had ever been submitted. A multi-day transcription run on a desktop would
    hit this repeatedly.

    SetThreadExecutionState is a REQUEST from this process, not a change to
    the user's power settings: nothing is reconfigured, and the moment the
    queues drain (or the worker exits, for any reason) the request lapses and
    normal sleep behaviour returns immediately. ES_SYSTEM_REQUIRED without
    ES_DISPLAY_REQUIRED deliberately lets the screen still switch off.
    """
    if os.name != "nt":
        return  # systemd boxes don't sleep out from under us
    try:
        import ctypes
    except Exception:  # noqa: BLE001
        return

    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    holding = False
    while True:
        try:
            busy = _worker_busy()
            if busy and not holding:
                ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
                holding = True
                print("[keep-awake] work in progress - holding off sleep", flush=True)
            elif not busy and holding:
                ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
                holding = False
                print("[keep-awake] idle - sleep allowed again", flush=True)
        except Exception as exc:  # noqa: BLE001 - never take the worker down for this
            print(f"[keep-awake] {exc}", flush=True)
        time.sleep(30)


def _restart_process():
    """Free the resident models by restarting this process.

    Linux: exec in place - same PID, systemd never notices, so this works
    under the deployed units' Restart=on-failure without any unit change.
    Windows: plain exit; the install.ps1 start-wrapper loops and relaunches
    (execv on Windows spawns a child and exits the parent, which a service
    wrapper would see as a crash AND then race the child for the port)."""
    if os.name == "nt":
        os._exit(0)
    os.execv(sys.executable, [sys.executable] + sys.argv)


def idle_restart_loop():
    last_busy = time.monotonic()
    while True:
        time.sleep(10)
        if _worker_busy():
            last_busy = time.monotonic()
            continue
        if not IDLE_RESTART_ENABLED or not _models_resident():
            # Idle without models resident costs nothing - don't count it,
            # so a later model load starts a fresh idle window.
            last_busy = time.monotonic()
            continue
        if time.monotonic() - last_busy >= IDLE_RESTART_SECONDS:
            print(f"[idle-restart] work done and idle {IDLE_RESTART_SECONDS}s "
                  "with ML models resident - restarting to free VRAM/RAM. "
                  "Ledger and pause state persist; the next batch reloads "
                  "models on demand.", flush=True)
            _restart_process()


for _i in range(SYNC_CONCURRENCY):
    threading.Thread(target=worker_loop, name=f"worker-{_i + 1}", daemon=True).start()
threading.Thread(target=ml_loop, name="ml-worker", daemon=True).start()
threading.Thread(target=idle_restart_loop, name="idle-restart", daemon=True).start()
threading.Thread(target=keep_awake_loop, name="keep-awake", daemon=True).start()


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
    priority: bool = False  # jump ahead of the regular FIFO (a manual per-item click)


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
    kept: list[tuple] = []  # (source queue, job) - an unsuitable job goes back to where it came from
    want = max(1, min(20, body.count))
    # Priority jobs first - a peer idle enough to steal should pick up a
    # manual per-item click before any ordinary nightly-batch job.
    for q in (priority_job_queue, job_queue):
        try:
            while len(taken) < want:
                job = q.get_nowait()
                q.task_done()
                if job_suitable_for(job, body.capabilities):
                    taken.append(job)
                else:
                    kept.append((q, job))
        except queue.Empty:
            continue
    for q, job in kept:
        q.put(job)
    # A stolen job becomes the peer's responsibility, so drop our persisted
    # copy - otherwise a restart here would replay work already handed away.
    # The _qid is local to this worker and must not travel with the job.
    for job in taken:
        forget_job(job)
        job.pop("_qid", None)
    return {"jobs": taken, "queue_depth": job_queue.qsize() + priority_job_queue.qsize()}


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
            # Plugin-side form: rollback sends this value straight back.
            items.append({"subtitle_path": rp(sub_path), "offset_seconds": offset, "processed_at": at})
        if len(items) >= limit:
            break
    return {"items": items}


@app.post("/rollback")
def rollback(body: RollbackBody, x_api_key: str = Header(default="")):
    check_key(x_api_key)
    sub = lp(body.subtitle_path)
    bak = sub + ".bak"
    if not os.path.exists(bak):
        raise HTTPException(status_code=404, detail="no backup for this file")
    shutil.copy2(bak, sub)
    # Recorded as its own success status so the nightly task does NOT
    # immediately re-fix what the user deliberately reverted. The .bak is
    # kept, so the decision remains reversible by hand.
    #
    # The offset that WAS applied is carried across rather than nulled. A
    # rollback is the strongest signal available that a correction was wrong,
    # and the shift that caused it is the single most useful number for
    # working out why - so overwriting it with NULL destroyed exactly the
    # evidence needed. Learned the hard way: this pool has 1,233 rolled-back
    # files and not one of them can now say what was done to it.
    record(sub, os.path.getmtime(sub), _previous_offset(sub), "rolled-back")
    return {"restored": body.subtitle_path}


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
        # 'fixed-framerate:<factor>' rows are in-place modifications too - and
        # the most drastic ones, since they rewrote every timestamp rather
        # than sliding them. Omitting them here would have made exactly the
        # files an operator is most likely to want undone the only ones
        # "Gendan originale undertekster" could not touch.
        rows = conn.execute(
            "SELECT sub_path FROM processed "
            "WHERE status = 'fixed' OR status LIKE 'fixed-framerate:%'"
        ).fetchall()
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
            # Keep the applied offset - see the note in /rollback.
            record(sub, os.path.getmtime(sub), _previous_offset(sub), "rolled-back")
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
        for q in (job_queue, priority_job_queue, ml_queue, priority_ml_queue):
            try:
                while True:
                    job = q.get_nowait()
                    q.task_done()
                    # Clearing means clearing - drop the persisted copy too,
                    # or a restart would faithfully bring back everything the
                    # operator just asked to be rid of.
                    forget_job(job)
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
        elif kind == "mismatch":
            # Subtitles ffsubsync found ANTI-CORRELATED with their media, i.e.
            # the wrong subtitle for this file (see SCORE_RE). The plugin uses
            # this to stop treating such a subtitle as "this item already has
            # one" - it is the strongest case for transcribing the media
            # instead, and without it the file stays broken forever because
            # the broken subtitle blocks its own repair.
            if sub_path.startswith("transcribe:") or sub_path.startswith("translate:"):
                continue
            if s != "subtitle-mismatch":
                continue
            real = sub_path
        elif kind == "translate":
            if not sub_path.startswith("translate:"):
                continue
            if s not in ("translated", "already-has-sub"):
                continue
            real = sub_path[len("translate:"):]
        else:
            if sub_path.startswith("transcribe:") or sub_path.startswith("translate:"):
                continue
            # Every RESOLVED sync outcome belongs here, not just the ones that
            # changed a file. suspect-offset, low-quality-skip and
            # generated-skip are all final decisions, but were omitted, so the
            # plugin kept re-shipping those jobs every night - and in
            # low-quality-skip's case the worker then re-ran the full
            # alignment, because it was missing from SUCCESS_STATUSES too.
            if s not in (
                "fixed",
                "in-sync",
                "rolled-back",
                "suspect-offset",
                "low-quality-skip",
                "generated-skip",
                "subtitle-mismatch",
            ) and not s.startswith("fixed-framerate:"):
                continue
            real = sub_path
        if verify:
            try:
                if abs(os.path.getmtime(real) - mtime) > 1e-6:
                    continue
            except OSError:
                continue
        # Report in plugin-side form: the plugin compares these against the
        # paths IT mapped, so a path-remapped worker must translate back.
        paths.append(rp(real))
    return {"kind": kind, "paths": paths}


# Buckets a raw ledger status into the categories the stats/graphs use.
def _stat_category(status: str) -> str:
    s = str(status)
    if s == "fixed" or s.startswith("fixed-framerate:"):
        return "fixed"
    if s == "in-sync":
        return "in-sync"
    if s.startswith("transcribed:"):
        return "transcribed"
    if s == "translated":
        return "translated"
    if s in (
        "already-has-sub",
        "rolled-back",
        "suspect-offset",
        "low-quality-skip",
        "generated-skip",
        "subtitle-mismatch",
    ):
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
    if s == "unparseable-offset":
        return "sync-failed"
    if s.startswith("framerate-rejected:"):
        # Surfaced as its own kind because it means something upstream tried
        # to rescale time despite the policy - worth an operator's attention,
        # not silently lumped in with generic sync failures.
        return "framerate-rejected"
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
        {"media_path": rp(p[len(prefix):]), "status": s, "processed_at": at}
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
    snapshot["sync_queue_depth"] = job_queue.qsize() + priority_job_queue.qsize()
    snapshot["ml_queue_depth"] = ml_queue.qsize() + priority_ml_queue.qsize()
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

    # Before serving: protect anything generated before markers existed, then
    # reopen any verdict reached under a different sync policy, then put back
    # whatever was still queued when this process last stopped.
    backfill_markers()
    reset_stale_verdicts()
    restore_queue()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("SUBWORKER_PORT", "8099")))
