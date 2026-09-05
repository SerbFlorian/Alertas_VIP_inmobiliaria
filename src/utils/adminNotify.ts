import { logger } from '../services/logger';
import { redactSecrets } from './secrets';

export { redactSecrets };

/**
 * Notifica al admin por Telegram solo en fallos CRITICAL.
 * Nunca envía dumps ni secretos en claro.
 */

let lastAlertAt = 0;

export async function notifyAdminCritical(titulo: string, detalle?: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const adminId = process.env['TELEGRAM_ADMIN_ID'];
  const cooldown = parseInt(process.env['ADMIN_ALERT_COOLDOWN_MS'] ?? '900000', 10);

  if (!token || !adminId) {
    logger.error('CRITICAL sin canal admin:', { titulo, detalle });
    return;
  }

  const now = Date.now();
  if (now - lastAlertAt < cooldown) {
    logger.warn(`⏭️ Admin CRITICAL en cooldown (${titulo})`);
    return;
  }
  lastAlertAt = now;

  const cuerpo = [
    `🚨 <b>CRITICAL — Alertas VIP</b>`,
    ``,
    `<b>${escapeHtml(titulo)}</b>`,
    detalle ? `<pre>${escapeHtml(redactSecrets(detalle).slice(0, 1500))}</pre>` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminId,
        text: cuerpo,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error('Fallo enviando CRITICAL a Telegram', { status: res.status, body });
    }
  } catch (error) {
    logger.error('Error notifyAdminCritical', { error });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
