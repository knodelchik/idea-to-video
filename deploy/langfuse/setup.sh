#!/usr/bin/env bash
# Run on the server in ~/langfuse. Writes .env with fresh random secrets once (never printed), then starts the stack.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  umask 077
  r() { openssl rand -hex "$1"; }
  cat > .env <<ENV
LANGFUSE_DOMAIN=langfuse.158-180-45-68.sslip.io
POSTGRES_PASSWORD=$(r 24)
CLICKHOUSE_PASSWORD=$(r 24)
MINIO_ROOT_PASSWORD=$(r 24)
REDIS_AUTH=$(r 24)
SALT=$(r 24)
ENCRYPTION_KEY=$(r 32)
NEXTAUTH_SECRET=$(r 32)
AUTH_DISABLE_SIGNUP=false
ENV
  echo "wrote .env (secrets not shown)"
fi
docker compose pull
docker compose up -d
docker compose ps
