#!/usr/bin/env bash
# Installer for the subtitle sync worker on a Debian/Ubuntu machine.
# Run as root (or with sudo) on the container that can see the media files.
set -euo pipefail

INSTALL_DIR=/opt/subtitle-worker
SERVICE_USER=${SERVICE_USER:-subworker}

echo "== Installing packages =="
apt-get update
apt-get install -y python3 python3-venv python3-pip ffmpeg

echo "== Creating service user and directories =="
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/subtitle_worker.py" "$INSTALL_DIR/"

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

echo ""
echo "=================================================================="
echo "Done. The worker is running on port 8099."
echo "API key (paste this into the Subtitle Guard plugin settings):"
echo ""
echo "  $API_KEY"
echo ""
echo "NOTE: the service user '$SERVICE_USER' must have WRITE access to"
echo "the subtitle files in your media library. If your media is mounted"
echo "with specific ownership, either add $SERVICE_USER to the right"
echo "group or edit /etc/systemd/system/subtitle-worker.service to run"
echo "as a user that can write there, then:"
echo "  systemctl daemon-reload && systemctl restart subtitle-worker"
echo "=================================================================="
