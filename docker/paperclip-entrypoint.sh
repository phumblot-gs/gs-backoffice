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

# Build connection string — add sslmode=require for RDS
PAPERCLIP_DATABASE_URL="$DATABASE_URL"
case "$DATABASE_URL" in
  *rds.amazonaws.com*)
    PAPERCLIP_DATABASE_URL="${DATABASE_URL}?sslmode=require"
    ;;
esac
export PAPERCLIP_DATABASE_URL

# Write .env file for Paperclip to read DATABASE_URL and secrets
cat > "$CONFIG_DIR/.env" <<ENV
DATABASE_URL=${PAPERCLIP_DATABASE_URL}
PAPERCLIP_AGENT_JWT_SECRET=${PAPERCLIP_AGENT_JWT_SECRET}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(head -c 32 /dev/urandom | base64 | tr -d '\n')}
ENV

# Build allowed hostnames JSON array
# PAPERCLIP_ALLOWED_HOSTNAMES is a comma-separated list (no quotes)
# e.g. "backoffice-staging.grand-shooting.com,mcp-backoffice-staging.grand-shooting.com"
CONTAINER_IP=$(hostname -i 2>/dev/null | awk '{print $1}' || echo "")
HOSTNAMES_CSV="${PAPERCLIP_ALLOWED_HOSTNAMES:-}"
if [ -n "$CONTAINER_IP" ]; then
  if [ -n "$HOSTNAMES_CSV" ]; then
    HOSTNAMES_CSV="${HOSTNAMES_CSV},${CONTAINER_IP}"
  else
    HOSTNAMES_CSV="${CONTAINER_IP}"
  fi
fi
# Convert comma-separated list to JSON array: "a,b,c" -> "a","b","c"
ALLOWED_JSON=$(echo "$HOSTNAMES_CSV" | tr ',' '\n' | sed 's/^.*$/"&"/' | tr '\n' ',' | sed 's/,$//')

# Generate config — always regenerate to pick up new IPs
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
    "connectionString": "${PAPERCLIP_DATABASE_URL}",
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
    "exposure": "public",
    "host": "0.0.0.0",
    "port": ${PORT:-3100},
    "allowedHostnames": [${ALLOWED_JSON}],
    "serveUi": true
  },
  "auth": {
    "baseUrlMode": "explicit",
    "publicBaseUrl": "${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}",
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

# Override DATABASE_URL in the process env so the server sees the SSL version
export DATABASE_URL="$PAPERCLIP_DATABASE_URL"

echo "Starting Paperclip (DATABASE_URL=${DATABASE_URL:+set}, allowedHostnames=[${ALLOWED_JSON}])"
exec paperclipai run --no-repair
