#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR" /tmp/npm-cache 2>/dev/null || true

# Comando custom (prisma studio, shell, etc.): ejecutar tal cual, sin migrate.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

ROLE="${APP_ROLE:-${WORKER_MODE:-all}}"
PRISMA_BIN="/app/node_modules/.bin/prisma"

has_migrations() {
  [ -d "/app/prisma/migrations" ] || return 1
  count="$(find /app/prisma/migrations -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  [ "$count" -gt 0 ]
}

run_migrate() {
  if [ -x "$PRISMA_BIN" ]; then
    "$PRISMA_BIN" migrate deploy
  else
    npx prisma migrate deploy
  fi
}

if [ "$ROLE" = "scraper" ] && [ "${MIGRATE_ON_START:-}" != "true" ]; then
  echo "ℹ️  scraper — se omite migrate (lo hace app)"
elif ! has_migrations; then
  echo "ℹ️  sin migraciones versionadas — se omite migrate"
else
  echo "🗄️  prisma migrate deploy… (role=$ROLE)"
  set +e
  run_migrate
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "⚠️  migrate falló (code=$code) — arrancando igual"
  else
    echo "✅ migrate OK"
  fi
fi

exec node dist/index.js
