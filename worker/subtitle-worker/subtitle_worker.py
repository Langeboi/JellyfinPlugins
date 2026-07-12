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


def write_srt(segments, path: str) -> int:
    """Stream Whisper segments to an SRT file; returns the segment count.
    Streaming matters: faster-whisper yields segments lazily, so this is
    where the actual transcription time is spent."""
    count = 0
    with open(path, "w", encoding="utf-8") as fh:
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            count += 1
            fh.write(f"{count}\n{_srt_timestamp(segment.start)} --> {_srt_timestamp(segment.end)}\n{text}\n\n")
    return count

app = FastAPI(title="subtitle-sync-worker")

job_queue: "queue.Queue[dict]" = queue.Queue()
state = {
    "processing": None,
    "done": 0,
    "skipped": 0,
    "failed": 0,
    "started_at": datetime.now(timezone.utc).isoformat(),
}
state_lock = threading.Lock()


def db():
    conn = sqlite3.connect(DB_PATH)
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
SUCCESS_STATUSES = ("fixed", "in-sync", "already-has-sub")


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
    if already_processed(key, mtime):
        with state_lock:
            state["skipped"] += 1
        return

    out_path = None
    try:
        model = get_whisper_model()
        # language=None auto-detects the SPOKEN language; Whisper transcribes
        # in that language (it can translate to English but never to Danish -
        # translation is a future, separate step).
        segments, info = model.transcribe(media, vad_filter=True, language=job.get("language") or None)

        base = os.path.splitext(media)[0]
        target = f"{base}.{info.language}.srt"
        if os.path.exists(target):
            # A subtitle for the detected language already exists (maybe
            # added since the job was queued) - never overwrite real subs
            # with machine output.
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
    while True:
        job = job_queue.get()
        label = job.get("subtitle_path") or job.get("media_path")
        if job.get("type") == "transcribe":
            label = "[whisper] " + os.path.basename(job.get("media_path") or "")
        with state_lock:
            state["processing"] = label
        try:
            if job.get("type") == "transcribe":
                process_transcribe_job(job)
            else:
                process_job(job)
        finally:
            with state_lock:
                state["processing"] = None
            job_queue.task_done()


threading.Thread(target=worker_loop, daemon=True).start()


def check_key(x_api_key):
    if not API_KEY or x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="bad api key")


class Job(BaseModel):
    media_path: str
    subtitle_path: str | None = None
    type: str = "sync"  # "sync" | "transcribe"
    language: str | None = None  # transcribe only; None = auto-detect


class Batch(BaseModel):
    jobs: list[Job]


@app.get("/health")
def health():
    return {
        "ok": True,
        "capabilities": {"sync": True, "transcribe": TRANSCRIBE_CAPABILITY},
        "whisper_model": WHISPER_MODEL_NAME if TRANSCRIBE_CAPABILITY else None,
    }


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


@app.get("/status")
def status(x_api_key: str = Header(default="")):
    check_key(x_api_key)
    with state_lock:
        snapshot = dict(state)
    snapshot["queue_depth"] = job_queue.qsize()
    snapshot["capabilities"] = {"sync": True, "transcribe": TRANSCRIBE_CAPABILITY}
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
