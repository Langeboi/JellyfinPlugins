#!/usr/bin/env bash
# Self-updater for the subtitle worker, run by subtitle-worker-update.timer.
# Fetches the latest worker script from the repo, validates that it compiles,
# and swaps + restarts ONLY if it actually changed. Fails safe in every
# branch: a bad download or non-compiling file keeps the current version and
# simply tries again on the next timer run.
set -u

# Multi-instance: the systemd unit passes these for non-default instances.
INSTALL_DIR=${SUBWORKER_INSTALL_DIR:-/opt/subtitle-worker}
SERVICE_NAME=${SUBWORKER_SERVICE:-subtitle-worker}
ENV_FILE="$INSTALL_DIR/env"
RAW_URL="https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/subtitle_worker.py"

# Opt-out: SUBWORKER_AUTOUPDATE=0 in the env file pins this box to its
# current version until the flag is removed.
if grep -q '^SUBWORKER_AUTOUPDATE=0' "$ENV_FILE" 2>/dev/null; then
  echo "autoupdate disabled (SUBWORKER_AUTOUPDATE=0), skipping"
  exit 0
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Cache-buster: raw.githubusercontent caches ~5 min, which a daily timer
# tolerates, but the buster makes a manual `systemctl start` fetch fresh.
if ! curl -fsSL "${RAW_URL}?v=$(date +%s)" -o "$TMP"; then
  echo "download failed, keeping current version"
  exit 0
fi

if cmp -s "$TMP" "$INSTALL_DIR/subtitle_worker.py"; then
  echo "already up to date"
  exit 0
fi

if ! "$INSTALL_DIR/venv/bin/python" -m py_compile "$TMP"; then
  echo "downloaded file does not compile, keeping current version"
  exit 0
fi

# Don't restart under a running job - killing a transcription mid-file just
# wastes work (it would retry, but no reason to interrupt). Next run gets it.
PORT=$(grep '^SUBWORKER_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
KEY=$(grep '^SUBWORKER_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
if [ -n "${KEY:-}" ]; then
  BUSY=$(curl -fsS -m 5 -H "X-Api-Key: $KEY" "http://127.0.0.1:${PORT:-8099}/status" 2>/dev/null \
    | grep -o '"active":[0-9]*' | cut -d: -f2)
  if [ -n "${BUSY:-}" ] && [ "$BUSY" -gt 0 ]; then
    echo "worker busy ($BUSY active jobs), deferring update to next run"
    exit 0
  fi
fi

# Overwriting in place keeps the destination file's owner (the service user),
# so no chown is needed regardless of what SERVICE_USER the box enrolled with.
OWNER=$(stat -c '%U:%G' "$INSTALL_DIR/subtitle_worker.py" 2>/dev/null || echo "")
cp "$TMP" "$INSTALL_DIR/subtitle_worker.py"
if [ -n "$OWNER" ]; then
  chown "$OWNER" "$INSTALL_DIR/subtitle_worker.py" 2>/dev/null || true
fi
systemctl restart "$SERVICE_NAME"
echo "worker updated and restarted ($SERVICE_NAME)"
