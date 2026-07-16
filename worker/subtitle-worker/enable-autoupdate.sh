#!/usr/bin/env bash
# Installs the subtitle-worker self-updater: a daily systemd timer that pulls
# the latest worker script from the repo, validates it compiles, and swaps +
# restarts only when it changed. Safe to re-run (used both standalone on
# existing workers and by install.sh for new enrollments).
# Per-box opt-out: add SUBWORKER_AUTOUPDATE=0 to /opt/subtitle-worker/env.
set -euo pipefail

INSTALL_DIR=/opt/subtitle-worker
SELF_UPDATE_URL=${SELF_UPDATE_URL:-https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/self-update.sh}

if [ ! -d "$INSTALL_DIR" ]; then
  echo "ERROR: $INSTALL_DIR not found - enroll the worker with install.sh first." >&2
  exit 1
fi

# Works both from a checkout (file next to this script) and piped from GitHub.
if [ -f "$(dirname "$0")/self-update.sh" ]; then
  cp "$(dirname "$0")/self-update.sh" "$INSTALL_DIR/self-update.sh"
else
  curl -fsSL "${SELF_UPDATE_URL}?v=$(date +%s)" -o "$INSTALL_DIR/self-update.sh"
fi
chmod 755 "$INSTALL_DIR/self-update.sh"

cat > /etc/systemd/system/subtitle-worker-update.service <<'EOF'
[Unit]
Description=Subtitle worker self-update
After=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/subtitle-worker/self-update.sh
EOF

# RandomizedDelaySec spreads the fleet's checks out so three boxes don't hit
# GitHub in the same second; Persistent catches up after a powered-off day.
cat > /etc/systemd/system/subtitle-worker-update.timer <<'EOF'
[Unit]
Description=Daily subtitle worker self-update

[Timer]
OnCalendar=daily
RandomizedDelaySec=45min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now subtitle-worker-update.timer

echo "=================================================================="
echo "Auto-update enabled. The worker now updates itself daily."
echo "  Check log:    journalctl -u subtitle-worker-update"
echo "  Update now:   sudo systemctl start subtitle-worker-update"
echo "  Disable box:  add SUBWORKER_AUTOUPDATE=0 to $INSTALL_DIR/env"
echo "=================================================================="
