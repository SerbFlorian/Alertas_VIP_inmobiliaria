#!/usr/bin/env bash
set -euo pipefail

# Envía una notificación al chat de admins usando token del .env.
# Uso:
#   bash scripts/admin-notify.sh "Título" "Mensaje" [path/.env]

TITLE="${1:-Alerta Ops}"
BODY="${2:-Sin detalle}"
ENV_FILE="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ No existe .env: $ENV_FILE" >&2
  exit 1
fi

read_env_var() {
  local var_name="$1"
  local value
  value="$(grep -E "^${var_name}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  value="${value%\"}"
  value="${value#\"}"
  echo -n "$(echo -n "$value" | tr -d '\r')"
}

TOKEN="$(read_env_var TELEGRAM_BOT_TOKEN)"
ADMIN_CHAT_ID="$(read_env_var TELEGRAM_ADMIN_ID)"

if [[ -z "$TOKEN" || -z "$ADMIN_CHAT_ID" ]]; then
  echo "❌ Falta TELEGRAM_BOT_TOKEN o TELEGRAM_ADMIN_ID en .env" >&2
  exit 1
fi

TEXT="🛡️ <b>${TITLE}</b>

${BODY}

<i>$(date -u '+%Y-%m-%d %H:%M:%S UTC')</i>"

curl -fsS "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${ADMIN_CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "parse_mode=HTML" \
  --data-urlencode "disable_web_page_preview=true" \
  >/dev/null

echo "✅ Notificación enviada al chat admin"
