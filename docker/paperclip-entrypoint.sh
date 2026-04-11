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

# Generate agent JWT secret if not set
if [ -z "$PAPERCLIP_AGENT_JWT_SECRET" ]; then
  export PAPERCLIP_AGENT_JWT_SECRET=$(head -c 64 /dev/urandom | base64 | tr -d '\n')
fi

# Write .env file for Paperclip to read DATABASE_URL and secrets
cat > "$CONFIG_DIR/.env" <<ENV
DATABASE_URL=${DATABASE_URL}
PAPERCLIP_AGENT_JWT_SECRET=${PAPERCLIP_AGENT_JWT_SECRET}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(head -c 32 /dev/urandom | base64 | tr -d '\n')}
ENV

# Generate config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Creating Paperclip config at $CONFIG_FILE"
  cat > "$CONFIG_FILE" <<CONF
{
  "\$meta": {
    "version": 1,
    "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
    "source": "onboard"
  },
  "database": {
    "mode": "postgres",
    "connectionString": "${DATABASE_URL}",
    "backup": {
      "enabled": false
    }
  },
  "logging": {
    "mode": "file",
    "logDir": "$CONFIG_DIR/logs"
  },
  "server": {
    "deploymentMode": "authenticated",
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

echo "Starting Paperclip (DATABASE_URL=${DATABASE_URL:+set}, mode=authenticated)"
exec paperclipai run --no-repair
