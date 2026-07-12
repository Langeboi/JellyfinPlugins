bash
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
id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd -r -s /usr/sbin/nologin "$SERVICE_USER"

mkdir -p "$INSTALL_DIR"

# Works both ways:
# - Run from a checkout where subtitle_worker.py sits next to this script.
# - Piped directly from GitHub, in which case the worker is downloaded.
if [ -f "$(dirname "$0")/subtitle_worker.py" ]; then
  cp "$(dirname "$0")/subtitle_worker.py" "$INSTALL_DIR/"
else
  echo "== Downloading subtitle_worker.py from the repo =="
  curl -fsSL "$WORKER_PY_URL" -o "$INSTALL_DIR/subtitle_worker.py"
fi

echo "== Python environment =="
python3 -m venv "$INSTALL_DIR/venv"

"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install \
  fastapi \
  uvicorn \
  ffsubsync

echo "== Whisper transcription support =="
"$INSTALL_DIR/venv/bin/pip" install faster-whisper

WHISPER_NOTE="CPU (model: small)"
TRANSLATE_NOTE="not installed (CPU machine)"
CUDA_LIBS=""

if command -v nvidia-smi >/dev/null 2>&1 && \
   nvidia-smi >/dev/null 2>&1; then

  echo "NVIDIA GPU detected - installing CUDA runtime libraries"

  "$INSTALL_DIR/venv/bin/pip" install \
    nvidia-cublas-cu12 \
    nvidia-cudnn-cu12

  # NVIDIA's Python packages may be namespace packages, so their __file__
  # attribute can be None. Search their __path__ entries for the actual
  # library directories instead.
  if CUDA_LIBS=$("$INSTALL_DIR/venv/bin/python" - <<'PYEOF'
from pathlib import Path

import nvidia.cublas
import nvidia.cudnn


def find_lib_dir(package):
    package_paths = getattr(package, "__path__", None)

    if package_paths is None:
        raise RuntimeError(
            f"{package.__name__} does not expose a package path"
        )

    for package_path in package_paths:
        lib_dir = Path(package_path) / "lib"

        if lib_dir.is_dir():
            return str(lib_dir)

    raise RuntimeError(
        f"Could not find a CUDA library directory for {package.__name__}"
    )


print(
    find_lib_dir(nvidia.cublas)
    + ":"
    + find_lib_dir(nvidia.cudnn)
)
PYEOF
  ); then
    echo "CUDA libraries found at:"
    echo "  $CUDA_LIBS"
    WHISPER_NOTE="CUDA (model: large-v3)"
  else
    echo "WARNING: CUDA libraries could not be located."
    echo "WARNING: Whisper will use CPU mode instead."
    CUDA_LIBS=""
    WHISPER_NOTE="CPU (model: small)"
  fi

  # English-to-Danish translation using NLLB-200 distilled 1.3B.
  #
  # The model is converted once to CTranslate2 format. The download and
  # conversion require roughly 5-6 GB. Existing conversions are preserved.
  #
  # Disable translation installation with:
  #
  #   WITH_TRANSLATE=0 ./install.sh
  #
  # or:
  #
  #   curl ... | sudo WITH_TRANSLATE=0 bash
  if [ "${WITH_TRANSLATE:-1}" = "1" ]; then
    if [ -d "$INSTALL_DIR/nllb-ct2" ]; then
      echo "== NLLB translation model already present, keeping it =="

      if [ -n "$CUDA_LIBS" ]; then
        TRANSLATE_NOTE="NLLB-200 1.3B (CUDA)"
      else
        TRANSLATE_NOTE="NLLB-200 1.3B (CPU)"
      fi
    else
      echo "== Installing NLLB translation =="
      echo "This downloads approximately 6 GB."

      "$INSTALL_DIR/venv/bin/pip" install \
        transformers \
        sentencepiece

      # PyTorch is required for conversion only. CTranslate2 performs
      # inference after the model has been converted.
      "$INSTALL_DIR/venv/bin/pip" install \
        torch \
        --index-url https://download.pytorch.org/whl/cpu

      if "$INSTALL_DIR/venv/bin/ct2-transformers-converter" \
          --model facebook/nllb-200-distilled-1.3B \
          --output_dir "$INSTALL_DIR/nllb-ct2" \
          --quantization float16 \
          --force; then

        if [ -n "$CUDA_LIBS" ]; then
          TRANSLATE_NOTE="NLLB-200 1.3B (CUDA)"
        else
          TRANSLATE_NOTE="NLLB-200 1.3B (CPU)"
        fi
      else
        echo "WARNING: NLLB conversion failed."
        echo "WARNING: Translation is disabled on this worker."

        rm -rf "$INSTALL_DIR/nllb-ct2"
        TRANSLATE_NOTE="FAILED (see output above)"
      fi
    fi
  else
    echo "== NLLB translation installation disabled =="
    TRANSLATE_NOTE="disabled with WITH_TRANSLATE=0"
  fi
fi

# Re-running this installer must not rotate the API key, because doing so
# would silently break the worker's existing enrollment in the plugin.
if [ -f "$INSTALL_DIR/env" ] && \
   grep -q '^SUBWORKER_API_KEY=' "$INSTALL_DIR/env"; then

  echo "== Keeping existing API key =="

  API_KEY=$(
    grep '^SUBWORKER_API_KEY=' "$INSTALL_DIR/env" |
      head -n 1 |
      cut -d= -f2-
  )
else
  echo "== Generating API key =="

  API_KEY=$(
    head -c 48 /dev/urandom |
      base64 |
      tr -dc 'a-zA-Z0-9' |
      head -c 32
  )
fi

cat > "$INSTALL_DIR/env" <<EOF
SUBWORKER_API_KEY=$API_KEY
SUBWORKER_PORT=8099
SUBWORKER_MIN_OFFSET=0.4
SUBWORKER_DB=$INSTALL_DIR/processed.db

# Parallel sync jobs.
# The default is min(4, cores-1).
#
# Each job streams a full media file over the network. Lower this value
# to limit network bandwidth usage.
#
# SUBWORKER_SYNC_CONCURRENCY=2
EOF

if [ -n "$CUDA_LIBS" ]; then
  echo "LD_LIBRARY_PATH=$CUDA_LIBS" >> "$INSTALL_DIR/env"
fi

chmod 600 "$INSTALL_DIR/env"

chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

echo "== systemd service =="

cat > /etc/systemd/system/subtitle-worker.service <<EOF
[Unit]
Description=Subtitle sync worker (Subtitle Guard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
EnvironmentFile=$INSTALL_DIR/env
ExecStart=$INSTALL_DIR/venv/bin/python $INSTALL_DIR/subtitle_worker.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now subtitle-worker

IP_ADDR=$(
  hostname -I 2>/dev/null |
    awk '{print $1}'
)

echo ""
echo "=================================================================="
echo "Done. The worker has been installed."
echo ""
echo "  Worker URL:      http://${IP_ADDR:-<this-machines-ip>}:8099"
echo "  Enrollment code: $API_KEY"
echo "  Transcription:   $WHISPER_NOTE"
echo "  Translation:     $TRANSLATE_NOTE"
echo ""
echo "Paste the worker URL and enrollment code into:"
echo ""
echo "  Jellyfin > Dashboard > Plugins > Subtitle Guard"
echo ""
echo "under 'Tilføj worker'."
echo ""
echo "Service status:"
echo ""
systemctl --no-pager --full status subtitle-worker || true
echo ""
echo "NOTE: The service user '$SERVICE_USER' must have write access to"
echo "the subtitle files in your media library."
echo ""
echo "If your media is mounted with specific ownership, either add"
echo "'$SERVICE_USER' to the appropriate group or edit:"
echo ""
echo "  /etc/systemd/system/subtitle-worker.service"
echo ""
echo "Then run:"
echo ""
echo "  systemctl daemon-reload"
echo "  systemctl restart subtitle-worker"
echo "=================================================================="
```
