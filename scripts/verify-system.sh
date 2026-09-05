#!/usr/bin/env bash
set -u

# Verificación operativa rápida para VPS.
# Uso:
#   bash scripts/verify-system.sh
#   bash scripts/verify-system.sh /ruta/a/.env

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"

SERVICE_APP="${SERVICE_APP:-alertas-vip}"
SERVICE_SCRAPER="${SERVICE_SCRAPER:-scraper}"
SERVICE_DB="${SERVICE_DB:-db}"
SERVICE_REDIS="${SERVICE_REDIS:-redis}"

LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3001/health}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"

FAILS=0
WARNS=0

ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; WARNS=$((WARNS + 1)); }
err()  { echo "❌ $*"; FAILS=$((FAILS + 1)); }

echo "=================================================="
echo "🔎 Alertas VIP — System Verification"
echo "📄 ENV: $ENV_FILE"
echo "=================================================="

if [[ ! -f "$ENV_FILE" ]]; then
  err "No existe el archivo .env en: $ENV_FILE"
  echo
  echo "Resumen: FAIL=$FAILS WARN=$WARNS"
  exit 1
fi

read_env_var() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  value="${value%\"}"
  value="${value#\"}"
  echo -n "$(echo -n "$value" | tr -d '\r')"
}

# Si no viene por entorno, intenta leerla del .env para evitar tener que
# anteponer PUBLIC_HEALTH_URL=... en cada ejecución.
if [[ -z "$PUBLIC_HEALTH_URL" ]]; then
  PUBLIC_HEALTH_URL="$(read_env_var PUBLIC_HEALTH_URL)"
fi

if ! command -v docker >/dev/null 2>&1; then
  err "docker no está disponible en PATH"
  echo
  echo "Resumen: FAIL=$FAILS WARN=$WARNS"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  err "curl no está disponible en PATH"
  echo
  echo "Resumen: FAIL=$FAILS WARN=$WARNS"
  exit 1
fi

echo
echo "1) Verificación de secretos en .env"
direct_sensitive_vars=(
  TELEGRAM_BOT_TOKEN
  TELEGRAM_PUBLIC_CHANNEL_ID
  TELEGRAM_ADMIN_ID
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  STRIPE_PAYMENT_LINK
  STRIPE_PAYMENT_LINK_TIER2
  STRIPE_PAYMENT_LINK_TIER3
  STRIPE_BILLING_PORTAL_URL
  OPENAI_API_KEY
  R2_ACCOUNT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET
)

missing_direct=0
missing_list=()
for var in "${direct_sensitive_vars[@]}"; do
  val="$(read_env_var "$var")"
  if [[ -z "$val" ]]; then
    missing_direct=$((missing_direct + 1))
    missing_list+=("$var")
  fi
done

if [[ "$missing_direct" -eq 0 ]]; then
  ok "Variables sensibles presentes en .env"
else
  warn "Hay $missing_direct variables sensibles vacías en .env"
  warn "Faltantes: ${missing_list[*]}"
fi

# Bright Data puede ser opcional según estrategia de scraping.
bright_enabled="$(read_env_var BRIGHTDATA_ENABLED)"
bright_key="$(read_env_var BRIGHTDATA_API_KEY)"
if [[ -z "$bright_key" ]]; then
  if [[ "$bright_enabled" == "true" ]]; then
    ok "BRIGHTDATA_API_KEY vacío: el scraper seguirá sin unlocker BD"
  else
    ok "BRIGHTDATA_API_KEY vacío y BRIGHTDATA_ENABLED!=true (correcto)"
  fi
fi

echo
echo "2) Estado de contenedores docker compose"
for svc in "$SERVICE_APP" "$SERVICE_SCRAPER" "$SERVICE_DB" "$SERVICE_REDIS"; do
  cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
  if [[ -z "$cid" ]]; then
    err "Servicio '$svc' no está creado/running"
    continue
  fi

  state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)"
  if [[ "$state" != "running" ]]; then
    err "$svc state=$state health=$health"
  else
    if [[ "$health" == "unhealthy" ]]; then
      err "$svc state=$state health=$health"
    else
      ok "$svc state=$state health=$health"
    fi
  fi
done

echo
echo "3) Health endpoints"
local_payload="$(curl -fsS "$LOCAL_HEALTH_URL" 2>/dev/null || true)"
if [[ "$local_payload" == '{"status":"ok"}' ]]; then
  ok "Health local OK: $LOCAL_HEALTH_URL"
else
  err "Health local inesperado en $LOCAL_HEALTH_URL (respuesta: ${local_payload:-<vacía>})"
fi

if [[ -n "$PUBLIC_HEALTH_URL" ]]; then
  public_payload="$(curl -fsS "$PUBLIC_HEALTH_URL" 2>/dev/null || true)"
  if [[ "$public_payload" == '{"status":"ok"}' ]]; then
    ok "Health público OK: $PUBLIC_HEALTH_URL"
  else
    err "Health público inesperado en $PUBLIC_HEALTH_URL (respuesta: ${public_payload:-<vacía>})"
  fi
else
  ok "PUBLIC_HEALTH_URL no definido (check público omitido)"
fi

echo
echo "4) Búsqueda de errores críticos recientes (últimos 15m app)"
recent_errors="$(docker compose logs --since=15m "$SERVICE_APP" 2>/dev/null | grep -E 'error|Error|409|getUpdates|ENOENT|Webhook signature verification failed' || true)"
if [[ -n "$recent_errors" ]]; then
  # Ignorar ruido conocido de baseline Prisma (no bloqueante) si no hay más errores.
  filtered_errors="$(echo "$recent_errors" | grep -Ev 'Error: P3005|Error: P3017' || true)"
  if [[ -n "$filtered_errors" ]]; then
    warn "Se detectaron posibles errores recientes en logs de app:"
    echo "--------------------------------------------------"
    echo "$filtered_errors"
    echo "--------------------------------------------------"
  else
    ok "Sin errores críticos relevantes (P3005/P3017 filtrados)"
  fi
else
  ok "Sin errores críticos detectados en logs recientes"
fi

echo
echo "=================================================="
echo "Resumen: FAIL=$FAILS WARN=$WARNS"
echo "=================================================="

if [[ "$FAILS" -gt 0 ]]; then
  exit 1
fi

exit 0
