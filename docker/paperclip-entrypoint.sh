#!/bin/sh
set -e

PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
CONFIG_DIR="$PAPERCLIP_HOME/instances/default"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Create directories
mkdir -p "$CONFIG_DIR/logs" "$CONFIG_DIR/data/storage" "$CONFIG_DIR/data/backups" "$CONFIG_DIR/secrets"

# Generate secrets key if needed
if [ ! -f "$CONFIG_DIR/secrets/master.key" ]; then
  head -c 32 /dev/urandom | base64 > "$CONFIG_DIR/secrets/master.key"
fi

# Generate config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Creating Paperclip config at $CONFIG_FILE"
  cat > "$CONFIG_FILE" <<CONF
{
  "\$meta": {
    "version": 1,
    "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
    "source": "docker-entrypoint"
  },
  "database": {
    "mode": "external-postgres",
    "backup": {
      "enabled": false
    }
  },
  "logging": {
    "mode": "file",
    "logDir": "$CONFIG_DIR/logs"
  },
  "server": {
    "deploymentMode": "local_trusted",
    "exposure": "private",
    "host": "0.0.0.0",
    "port": ${PORT:-3100},
    "allowedHostnames": [],
    "serveUi": true
  },
  "auth": {
    "baseUrlMode": "auto",
    "disableSignUp": false
  },
  "telemetry": {
    "enabled": false
  },
  "storage": {
    "provider": "local_disk",
    "localDisk": {
      "baseDir": "$CONFIG_DIR/data/storage"
    },
    "s3": {
      "bucket": "paperclip",
      "region": "eu-west-1",
      "prefix": "",
      "forcePathStyle": false
    }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": {
      "keyFilePath": "$CONFIG_DIR/secrets/master.key"
    }
  }
}
CONF
fi

echo "Starting Paperclip (DATABASE_URL=${DATABASE_URL:+set}, HOME=$PAPERCLIP_HOME)"
exec paperclipai run --no-repair
