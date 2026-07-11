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

echo "== Generating API key =="
API_KEY=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
cat > "$INSTALL_DIR/env" <<EOF
SUBWORKER_API_KEY=$API_KEY
SUBWORKER_PORT=8099
SUBWORKER_MIN_OFFSET=0.4
SUBWORKER_DB=$INSTALL_DIR/processed.db
EOF
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
