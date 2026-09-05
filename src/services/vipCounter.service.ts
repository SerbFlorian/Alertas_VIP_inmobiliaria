import { contarUsuariosVip } from '../db/queries';
import { deleteAppMeta, getAppMeta, setAppMeta } from '../db/appMeta';
import { editarMensaje, enviarMensaje } from './telegram.service';
import { cacheDel, cacheGetJson, cacheSetJson } from './redis.service';
import { logger } from './logger';

// ============================================================
// CAJITA VIP ADMIN — un solo mensaje que se reescribe in situ
// Persistencia: memoria proceso → Redis → app_meta (Postgres)
// ============================================================

const META_KEY = 'vip_cajita_message_id';
const REDIS_KEY = 'admin:vip_cajita:ref';
const REDIS_TTL_SEC = 60 * 60 * 24 * 90; // 90 días
const BOX_INNER = 10;

export type VipCajitaRef = {
  chatId: string;
  messageId: number;
};

let memoryRef: VipCajitaRef | null = null;
let refreshChain: Promise<void> = Promise.resolve();

function adminChatId(): string | null {
  const id = String(process.env['TELEGRAM_ADMIN_ID'] ?? '').trim();
  return id || null;
}

/** Etiqueta de precio según umbrales de Payment Links. */
export function etiquetaTierVip(vipCount: number): string {
  if (vipCount < 200) return 'Tier 1 (≤200)';
  if (vipCount < 300) return 'Tier 2 (≤300)';
  return 'Tier 3 (300+)';
}

function cajaAscii(n: number): string {
  const s = String(n);
  const pad = Math.max(0, BOX_INNER - s.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  const line = `${' '.repeat(left)}${s}${' '.repeat(right)}`;
  return [
    `╔${'═'.repeat(BOX_INNER)}╗`,
    `║${line}║`,
    `╚${'═'.repeat(BOX_INNER)}╝`,
  ].join('\n');
}

function fechaMadridAhora(): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

/** Texto HTML de la cajita (mismo formato que el panel vivo). */
export function construirTextoCajitaVip(vipCount: number): string {
  return [
    `💎 <b>VIP activos</b>`,
    ``,
    `<pre>${cajaAscii(vipCount)}</pre>`,
    ``,
    `Precio actual: ${etiquetaTierVip(vipCount)}`,
    `<i>${fechaMadridAhora()}</i>`,
  ].join('\n');
}

function parseRef(raw: string | null | undefined): VipCajitaRef | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as VipCajitaRef;
    if (o?.chatId && Number.isFinite(o.messageId)) {
      return { chatId: String(o.chatId), messageId: Number(o.messageId) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function loadRef(): Promise<VipCajitaRef | null> {
  if (memoryRef) return memoryRef;

  const fromRedis = await cacheGetJson<VipCajitaRef>(REDIS_KEY);
  if (fromRedis?.chatId && Number.isFinite(fromRedis.messageId)) {
    memoryRef = { chatId: String(fromRedis.chatId), messageId: Number(fromRedis.messageId) };
    return memoryRef;
  }

  const fromDb = parseRef(await getAppMeta(META_KEY));
  if (fromDb) {
    memoryRef = fromDb;
    await cacheSetJson(REDIS_KEY, fromDb, REDIS_TTL_SEC);
    return memoryRef;
  }

  return null;
}

async function saveRef(ref: VipCajitaRef): Promise<void> {
  memoryRef = ref;
  await cacheSetJson(REDIS_KEY, ref, REDIS_TTL_SEC);
  await setAppMeta(META_KEY, JSON.stringify(ref));
}

async function clearRef(): Promise<void> {
  memoryRef = null;
  await cacheDel(REDIS_KEY);
  await deleteAppMeta(META_KEY);
}

async function refreshCajitaVipImpl(): Promise<void> {
  const chatId = adminChatId();
  if (!chatId) {
    logger.warn('⚠️ Cajita VIP: TELEGRAM_ADMIN_ID no configurado');
    return;
  }

  const vipCount = await contarUsuariosVip();
  const texto = construirTextoCajitaVip(vipCount);

  let ref = await loadRef();

  // Si el chat admin cambió, el message_id antiguo no sirve.
  if (ref && ref.chatId !== chatId) {
    await clearRef();
    ref = null;
  }

  if (ref) {
    const ok = await editarMensaje(chatId, ref.messageId, texto, 'HTML');
    if (ok) {
      logger.info(`📊 Cajita VIP actualizada (edit) · VIP=${vipCount} · msg=${ref.messageId}`);
      return;
    }
    // Mensaje borrado o inaccesible → enviar uno nuevo
    logger.warn('⚠️ Cajita VIP: edit falló; se envía mensaje nuevo');
    await clearRef();
  }

  const sent = await enviarMensaje(chatId, texto, 'HTML', undefined, {
    disableWebPagePreview: true,
  });
  if (!sent?.messageId) {
    logger.error('❌ Cajita VIP: no se pudo enviar el mensaje inicial');
    return;
  }

  await saveRef({ chatId, messageId: sent.messageId });
  logger.info(`📊 Cajita VIP creada (send) · VIP=${vipCount} · msg=${sent.messageId}`);
}

/**
 * Actualiza (o crea) la cajita VIP en el chat admin.
 * Serializa llamadas concurrentes (Stripe + arranque + cleanup).
 */
export function actualizarCajitaVip(): Promise<void> {
  refreshChain = refreshChain
    .then(() => refreshCajitaVipImpl())
    .catch((error) => {
      logger.error('❌ Error actualizando cajita VIP', { error });
    });
  return refreshChain;
}

/** Arranque diferido (~12 s) para dejar Redis/BD/bot listos. */
export function programarCajitaVipAlArranque(delayMs = 12_000): void {
  setTimeout(() => {
    actualizarCajitaVip().catch((error) => {
      logger.error('❌ Cajita VIP en arranque', { error });
    });
  }, delayMs);
}
