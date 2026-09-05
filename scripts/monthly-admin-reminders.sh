#!/usr/bin/env bash
set -euo pipefail

# Recordatorio mensual al chat admin:
# 1) revisión manual de dependencias
# 2) drill real de restore desde R2
#
# Uso:
#   bash scripts/monthly-admin-reminders.sh [path/.env]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"

MONTH_LABEL="$(date '+%Y-%m')"

bash "$ROOT_DIR/scripts/admin-notify.sh" \
  "Recordatorio mensual de seguridad (${MONTH_LABEL})" \
  "Checklist mensual:
• Revisar dependencias manualmente (npm outdated + npm audit).
• Evaluar upgrades de versión de forma controlada.
• Ejecutar verify:system tras cualquier cambio." \
  "$ENV_FILE"

bash "$ROOT_DIR/scripts/admin-notify.sh" \
  "Recordatorio mensual de DR (${MONTH_LABEL})" \
  "Toca drill de restore real:
1) backup ahora,
2) restore en entorno controlado,
3) validar integridad (usuarios/pisos),
4) anotar RTO/RPO y hallazgos." \
  "$ENV_FILE"

echo "✅ Recordatorios mensuales enviados"
