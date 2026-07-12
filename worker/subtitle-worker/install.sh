#!/usr/bin/env bash
# Installer for the subtitle sync worker on a Debian/Ubuntu machine.
# Run as root (or with sudo) on the container that can see the media files.
set -euo pipefail

INSTALL_DIR=/opt/subtitle-worker
SERVICE_USER=${SERVICE_USER:-subworker}
WORKER_PY_URL=${WORKER_PY_URL:-https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/subtitle_worker.py}

echo "== Installing packages =="
apt-get update
apt-get install -y python3 python3-venv python3-pip ffmpeg curl

echo "== Creating service user and directories =="
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$INSTALL_DIR"

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
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA GPU detected - installing CUDA runtime libraries"
  "$INSTALL_DIR/venv/bin/pip" install nvidia-cublas-cu12 nvidia-cudnn-cu12
  CUDA_LIBS=$("$INSTALL_DIR/venv/bin/python" - <<'PYEOF'
import os
import nvidia.cublas, nvidia.cudnn
print(os.path.join(os.path.dirname(nvidia.cublas.__file__), "lib") + ":" +
      os.path.join(os.path.dirname(nvidia.cudnn.__file__), "lib"))
PYEOF
)
  WHISPER_NOTE="CUDA (model: large-v3)"

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
      if "$INSTALL_DIR/venv/bin/ct2-transformers-converter" \
           --model facebook/nllb-200-distilled-1.3B \
           --output_dir "$INSTALL_DIR/nllb-ct2" \
           --quantization float16 --force; then
        TRANSLATE_NOTE="NLLB-200 1.3B (CUDA)"
      else
        echo "WARNING: NLLB conversion failed - translation disabled on this worker"
        rm -rf "$INSTALL_DIR/nllb-ct2"
        TRANSLATE_NOTE="FAILED (see output above)"
      fi
    fi
  fi
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
SUBWORKER_PORT=8099
SUBWORKER_MIN_OFFSET=0.4
SUBWORKER_DB=$INSTALL_DIR/processed.db
# Parallel sync jobs (default: min(4, cores-1)). Each job streams a full
# media file over the network - lower this to cap bandwidth usage.
# SUBWORKER_SYNC_CONCURRENCY=2
EOF
if [ -n "${CUDA_LIBS:-}" ]; then
  echo "LD_LIBRARY_PATH=$CUDA_LIBS" >> "$INSTALL_DIR/env"
fi
chmod 600 "$INSTALL_DIR/env"

chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

echo "== systemd service =="
cat > /etc/systemd/system/subtitle-worker.service <<EOF
[Unit]
Description=Subtitle sync worker (Subtitle Guard)
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
systemctl enable --now subtitle-worker

IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "=================================================================="
echo "Done. The worker is running and enrolled at:"
echo ""
echo "  Worker URL:      http://${IP_ADDR:-<this-machines-ip>}:8099"
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
echo "group or edit /etc/systemd/system/subtitle-worker.service to run"
echo "as a user that can write there, then:"
echo "  systemctl daemon-reload && systemctl restart subtitle-worker"
echo "=================================================================="
