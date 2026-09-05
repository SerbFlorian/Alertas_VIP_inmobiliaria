import {
  getUsuariosParaPrivacyPurge,
  eliminarCuentaUsuario,
} from '../db/queries';
import { logger } from '../services/logger';

// ============================================================
// PRIVACY PURGE — soft-purge automático 48 h tras fin de VIP
// ============================================================
// Tras cleanup marca estado=Cancelado al llegar cancel_at.
// Este job, 48 h después, borra PII (email, Stripe, filtros, notifs)
// conservando telegram_id + freeAiUsed (misma semántica que /eliminar_cuenta).
// ============================================================

export async function ejecutarPrivacyPurgeJob(): Promise<void> {
  const horas = parseInt(
    process.env['PRIVACY_PURGE_HOURS'] ?? process.env['DATA_PURGE_HOURS'] ?? '48',
    10
  );
  logger.info('-'.repeat(50));
  logger.info(`🔐 PRIVACY PURGE (soft-purge ≥${horas}h post-cancel)`);
  logger.info('-'.repeat(50));

  const usuarios = await getUsuariosParaPrivacyPurge(horas);
  let purged = 0;

  for (const u of usuarios) {
    const ok = await eliminarCuentaUsuario(u.telegram_id);
    if (ok) {
      purged++;
      logger.info(`🧹 Soft-purge privacidad → ${u.telegram_id}`);
    }
  }

  logger.info(`✅ Privacy purge: ${purged}/${usuarios.length} cuentas limpiadas`);
  logger.info('-'.repeat(50));
}
