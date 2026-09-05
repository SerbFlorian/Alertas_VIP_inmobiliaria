#!/usr/bin/env bash
set -uo pipefail

# Ejecuta verify-system y notifica al chat admin en fallo/recuperación.
# Uso:
#   bash scripts/verify-and-notify.sh [path/.env]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"
STATE_DIR="${STATE_DIR:-$ROOT_DIR/.ops-state}"
COOLDOWN_MINUTES="${VERIFY_ALERT_COOLDOWN_MINUTES:-60}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"

mkdir -p "$STATE_DIR"
LAST_STATUS_FILE="$STATE_DIR/verify.last_status"
LAST_ALERT_EPOCH_FILE="$STATE_DIR/verify.last_alert_epoch"
OUTPUT_FILE="$STATE_DIR/verify.last_output.log"

now_epoch="$(date +%s)"
last_status="$(cat "$LAST_STATUS_FILE" 2>/dev/null || echo "unknown")"
last_alert_epoch="$(cat "$LAST_ALERT_EPOCH_FILE" 2>/dev/null || echo "0")"

if [[ -n "$PUBLIC_HEALTH_URL" ]]; then
  PUBLIC_HEALTH_URL="$PUBLIC_HEALTH_URL" bash "$ROOT_DIR/scripts/verify-system.sh" "$ENV_FILE" >"$OUTPUT_FILE" 2>&1
else
  bash "$ROOT_DIR/scripts/verify-system.sh" "$ENV_FILE" >"$OUTPUT_FILE" 2>&1
fi
verify_exit=$?

current_status="ok"
if [[ "$verify_exit" -ne 0 ]]; then
  current_status="fail"
fi

should_alert=0
if [[ "$current_status" != "$last_status" ]]; then
  should_alert=1
elif [[ "$current_status" == "fail" ]]; then
  cooldown_secs=$((COOLDOWN_MINUTES * 60))
  if (( now_epoch - last_alert_epoch >= cooldown_secs )); then
    should_alert=1
  fi
fi

if [[ "$should_alert" -eq 1 ]]; then
  if [[ "$current_status" == "fail" ]]; then
    summary="$(grep -E 'Resumen: FAIL=' "$OUTPUT_FILE" | tail -n1 || echo 'Resumen no disponible')"
    detail="$(tail -n 8 "$OUTPUT_FILE" | tr '\n' ' ' | sed 's/[<>]/_/g')"
    bash "$ROOT_DIR/scripts/admin-notify.sh" \
      "Verify FAIL" \
      "${summary}

Detalle rápido: ${detail}" \
      "$ENV_FILE" || true
  else
    summary="$(grep -E 'Resumen: FAIL=' "$OUTPUT_FILE" | tail -n1 || echo 'Resumen no disponible')"
    bash "$ROOT_DIR/scripts/admin-notify.sh" \
      "Verify RECOVERY" \
      "El sistema vuelve a estado OK.

${summary}" \
      "$ENV_FILE" || true
  fi
  echo -n "$now_epoch" > "$LAST_ALERT_EPOCH_FILE"
fi

echo -n "$current_status" > "$LAST_STATUS_FILE"

if [[ "$verify_exit" -ne 0 ]]; then
  cat "$OUTPUT_FILE"
fi

exit "$verify_exit"
