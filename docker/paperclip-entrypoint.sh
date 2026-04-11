#!/bin/sh
set -e

PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
CONFIG_DIR="$PAPERCLIP_HOME/instances/default"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Create config directory
mkdir -p "$CONFIG_DIR"

# Generate config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Creating Paperclip config at $CONFIG_FILE"
  cat > "$CONFIG_FILE" <<CONF
{
  "deploymentMode": "local_trusted",
  "deploymentExposure": "private",
  "host": "0.0.0.0",
  "port": ${PORT:-3100},
  "serveUi": true,
  "database": {
    "autoBackup": false
  },
  "telemetry": {
    "enabled": false
  }
}
CONF
fi

# Generate secrets key if needed
SECRETS_DIR="$CONFIG_DIR/secrets"
mkdir -p "$SECRETS_DIR"
if [ ! -f "$SECRETS_DIR/master.key" ]; then
  head -c 32 /dev/urandom | base64 > "$SECRETS_DIR/master.key"
fi

echo "Starting Paperclip (DATABASE_URL=${DATABASE_URL:+set})"
exec paperclipai run
