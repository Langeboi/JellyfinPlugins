#!/usr/bin/env bash
# Installer for the subtitle sync worker on a Debian/Ubuntu machine.
# Run as root (or with sudo) on the container that can see the media files.
set -euo pipefail

# Multi-instance support: override these to run a SECOND worker on the same
# machine - e.g. one per GPU:
#   INSTALL_DIR=/opt/subtitle-worker2 SERVICE_NAME=subtitle-worker2 \
#   WORKER_PORT=8100 GPU_INDEX=1 sudo -E bash install.sh
# GPU_INDEX pins the instance to one GPU via CUDA_VISIBLE_DEVICES, so a 3080
# and a 2060 in the same box become two independent pool workers.
INSTALL_DIR=${INSTALL_DIR:-/opt/subtitle-worker}
SERVICE_NAME=${SERVICE_NAME:-subtitle-worker}
WORKER_PORT=${WORKER_PORT:-8099}
GPU_INDEX=${GPU_INDEX:-}
SERVICE_USER=${SERVICE_USER:-subworker}
WORKER_PY_URL=${WORKER_PY_URL:-https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/subtitle_worker.py}

echo "== Installing packages =="
apt-get update
apt-get install -y python3 python3-venv python3-pip ffmpeg curl

echo "== Creating service user and directories =="
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$INSTALL_DIR"

# Models are cached INSIDE the install dir. The service user is a system
# user with no real home, so the default ~/.cache/huggingface path isn't
# writable for it - which is exactly why runtime downloads never stuck and
# hammered HuggingFace into 429 rate-limits. A fixed, service-user-owned
# cache (pre-filled below) means the runtime never contacts HuggingFace.
HF_CACHE_DIR="$INSTALL_DIR/hf-cache"
mkdir -p "$HF_CACHE_DIR"
export HF_HOME="$HF_CACHE_DIR"

# HuggingFace pulls get rate-limited (429) when several fire at once, so
# retry with a long backoff during install rather than failing outright.
hf_retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 5 ]; then
      return 1
    fi
    echo "  (HuggingFace download failed - backing off 60s, attempt $n/5)"
    sleep 60
  done
}

# Works both ways: run from a checkout (file sits next to this script) or
# piped straight from GitHub (curl -sL .../install.sh | sudo bash), in which
# case the worker script is fetched from the repo.
if [ -f "$(dirname "$0")/subtitle_worker.py" ]; then
  cp "$(dirname "$0")/subtitle_worker.py" "$INSTALL_DIR/"
else
  echo "== Downloading subtitle_worker.py from the repo =="
  curl -fsSL "$WORKER_PY_URL" -o "$INSTALL_DIR/subtitle_worker.py"
fi

echo "== Python environment =="
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install fastapi uvicorn ffsubsync

echo "== Whisper transcription support =="
"$INSTALL_DIR/venv/bin/pip" install faster-whisper
WHISPER_NOTE="CPU (model: small)"
TRANSLATE_NOTE="not installed (CPU machine)"
WHISPER_MODEL=small
WHISPER_DEV=cpu
WHISPER_CT=int8
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA GPU detected - installing CUDA runtime libraries"
  "$INSTALL_DIR/venv/bin/pip" install nvidia-cublas-cu12 nvidia-cudnn-cu12
  # The nvidia-* wheels install as PEP 420 namespace packages, so their
  # __file__ is None (this crashed the installer on Python 3.14). Use
  # __path__ instead, and never let a detection failure abort the install
  # (|| true) - a missing LD_LIBRARY_PATH is recoverable, a dead install
  # is not.
  CUDA_LIBS=$("$INSTALL_DIR/venv/bin/python" - <<'PYEOF' || true
import os
def libdir(name):
    try:
        mod = __import__(name, fromlist=["__path__"])
        paths = list(getattr(mod, "__path__", []) or [])
        return os.path.join(paths[0], "lib") if paths else ""
    except Exception:
        return ""
parts = [p for p in (libdir("nvidia.cublas"), libdir("nvidia.cudnn")) if p and os.path.isdir(p)]
print(":".join(parts))
PYEOF
)
  WHISPER_NOTE="CUDA (model: large-v3)"
  WHISPER_MODEL=large-v3
  WHISPER_DEV=cuda
  WHISPER_CT=float16

  # English->Danish translation (NLLB-200 distilled 1.3B, quality-first
  # choice). Converted once to CTranslate2 format; the download+conversion
  # is ~5-6GB and takes a while - skipped when already done, and skippable
  # entirely with WITH_TRANSLATE=0.
  if [ "${WITH_TRANSLATE:-1}" = "1" ]; then
    if [ -d "$INSTALL_DIR/nllb-ct2" ]; then
      echo "== NLLB translation model already present, keeping it =="
      TRANSLATE_NOTE="NLLB-200 1.3B (CUDA)"
    else
      echo "== Installing NLLB translation (this downloads ~6GB, be patient) =="
      "$INSTALL_DIR/venv/bin/pip" install transformers sentencepiece
      "$INSTALL_DIR/venv/bin/pip" install torch --index-url https://download.pytorch.org/whl/cpu
      if hf_retry "$INSTALL_DIR/venv/bin/ct2-transformers-converter" \
           --model facebook/nllb-200-distilled-1.3B \
           --output_dir "$INSTALL_DIR/nllb-ct2" \
           --quantization float16 --force; then
        # The tokenizer is loaded from HuggingFace at RUNTIME too - pre-cache
        # it now so translation never depends on a live HF call either.
        hf_retry "$INSTALL_DIR/venv/bin/python" -c \
          "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('facebook/nllb-200-distilled-1.3B'); print('nllb tokenizer cached')" || true
        TRANSLATE_NOTE="NLLB-200 1.3B (CUDA)"
      else
        echo "WARNING: NLLB conversion failed - translation disabled on this worker"
        rm -rf "$INSTALL_DIR/nllb-ct2"
        TRANSLATE_NOTE="FAILED (see output above)"
      fi
    fi
  fi
fi

# Pre-download the Whisper model into the fixed cache so the RUNTIME never
# contacts HuggingFace (the v1.4.0.0 failure: many jobs each re-downloading
# the model, hitting a 429 rate limit, all failing). CUDA loads need the
# runtime libs on LD_LIBRARY_PATH here too.
echo "== Pre-downloading Whisper model ($WHISPER_MODEL) =="
if LD_LIBRARY_PATH="${CUDA_LIBS:-}" HF_HOME="$HF_CACHE_DIR" hf_retry \
     "$INSTALL_DIR/venv/bin/python" - "$WHISPER_MODEL" "$WHISPER_DEV" "$WHISPER_CT" <<'PYEOF'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3])
print("whisper model cached")
PYEOF
then
  echo "  Whisper model cached OK"
else
  echo "  WARNING: Whisper model pre-download failed - it will retry at runtime"
fi

# Re-running this installer (e.g. to upgrade) must NOT rotate the API key -
# that would silently break the worker's enrollment in the plugin.
if [ -f "$INSTALL_DIR/env" ] && grep -q '^SUBWORKER_API_KEY=' "$INSTALL_DIR/env"; then
  echo "== Keeping existing API key =="
  API_KEY=$(grep '^SUBWORKER_API_KEY=' "$INSTALL_DIR/env" | cut -d= -f2-)
else
  echo "== Generating API key =="
  API_KEY=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
fi

cat > "$INSTALL_DIR/env" <<EOF
SUBWORKER_API_KEY=$API_KEY
SUBWORKER_PORT=$WORKER_PORT
SUBWORKER_MIN_OFFSET=0.4
SUBWORKER_DB=$INSTALL_DIR/processed.db
HF_HOME=$HF_CACHE_DIR
# Parallel sync jobs (default: min(4, cores-1)). Each job streams a full
# media file over the network - lower this to cap bandwidth usage.
# SUBWORKER_SYNC_CONCURRENCY=2
# Reject ffsubsync results whose offset exceeds this many seconds - such a
# large shift is almost always a mis-alignment, so the original is kept.
# SUBWORKER_MAX_OFFSET=60
# Set to 0 to pin this box to its current worker version (skips the daily
# self-update timer).
# SUBWORKER_AUTOUPDATE=0
EOF
if [ -n "${CUDA_LIBS:-}" ]; then
  echo "LD_LIBRARY_PATH=$CUDA_LIBS" >> "$INSTALL_DIR/env"
fi
if [ -n "$GPU_INDEX" ]; then
  # Pin this instance to one GPU (multi-GPU boxes run one instance per card).
  echo "CUDA_VISIBLE_DEVICES=$GPU_INDEX" >> "$INSTALL_DIR/env"
fi
chmod 600 "$INSTALL_DIR/env"

chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

echo "== systemd service =="
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Subtitle sync worker (Subtitle Guard, $SERVICE_NAME)
After=network.target

[Service]
User=$SERVICE_USER
EnvironmentFile=$INSTALL_DIR/env
ExecStart=$INSTALL_DIR/venv/bin/python $INSTALL_DIR/subtitle_worker.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# Self-updating worker: a daily timer pulls the latest worker script from the
# repo (validated before swap, deferred while jobs run). Opt out per box with
# SUBWORKER_AUTOUPDATE=0 in the env file.
echo "== Enabling auto-update timer =="
export INSTALL_DIR SERVICE_NAME
if [ -f "$(dirname "$0")/enable-autoupdate.sh" ]; then
  bash "$(dirname "$0")/enable-autoupdate.sh" || echo "WARNING: auto-update setup failed - update manually"
else
  curl -fsSL "https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/enable-autoupdate.sh?v=$(date +%s)" | bash \
    || echo "WARNING: auto-update setup failed - update manually"
fi

IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "=================================================================="
echo "Done. The worker is running and enrolled at:"
echo ""
echo "  Worker URL:      http://${IP_ADDR:-<this-machines-ip>}:$WORKER_PORT"
echo "  Enrollment code: $API_KEY"
echo "  Transcription:   $WHISPER_NOTE"
echo "  Translation:     $TRANSLATE_NOTE"
echo ""
echo "Paste both into Jellyfin > Dashboard > Plugins > Subtitle Guard"
echo "under 'Tilføj worker'."
echo ""
echo "NOTE: the service user '$SERVICE_USER' must have WRITE access to"
echo "the subtitle files in your media library. If your media is mounted"
echo "with specific ownership, either add $SERVICE_USER to the right"
echo "group or edit /etc/systemd/system/${SERVICE_NAME}.service to run"
echo "as a user that can write there, then:"
echo "  systemctl daemon-reload && systemctl restart $SERVICE_NAME"
echo "=================================================================="
