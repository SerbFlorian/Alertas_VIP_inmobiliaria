import Redis from 'ioredis';
import { logger } from './logger';

// ============================================================
// REDIS — locks digests + caché inventory (opcional pero recomendado)
// ============================================================

let client: Redis | null = null;
let disabled = false;

export function getRedisUrl(): string {
  if (process.env['REDIS_URL']) return process.env['REDIS_URL'];
  const pass = process.env['REDIS_PASSWORD'];
  if (pass) return `redis://:${encodeURIComponent(pass)}@127.0.0.1:6379`;
  return 'redis://127.0.0.1:6379';
}

export async function initRedis(): Promise<void> {
  if (process.env['REDIS_ENABLED'] === 'false') {
    disabled = true;
    logger.info('ℹ️  Redis desactivado (REDIS_ENABLED=false)');
    return;
  }

  try {
    client = new Redis(getRedisUrl(), {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    await client.connect();
    await client.ping();
    logger.info('✅ Redis conectado');
  } catch (error) {
    logger.warn('⚠️  Redis no disponible — locks/caché en memoria local', { error });
    try {
      await client?.quit();
    } catch {
      /* ignore */
    }
    client = null;
    disabled = true;
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    /* ignore */
  }
  client = null;
}

export function redisAvailable(): boolean {
  return !!client && !disabled;
}

/**
 * Lock distribuido (SET NX PX). Si Redis cae, ejecuta igual (fail-open).
 * TTL en ms — debe cubrir el job más largo razonable.
 */
export async function withRedisLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<{ ran: boolean; result?: T }> {
  if (!client || disabled) {
    return { ran: true, result: await fn() };
  }

  const token = `${process.pid}-${Date.now()}`;
  const ok = await client.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') {
    logger.warn(`⏭️  Lock Redis ocupado: ${key}`);
    return { ran: false };
  }

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    // Solo borra si seguimos siendo dueños
    const cur = await client.get(key);
    if (cur === token) await client.del(key);
  }
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  if (!client || disabled) return null;
  const raw = await client.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  if (!client || disabled) return;
  await client.set(key, JSON.stringify(value), 'EX', ttlSec);
}

export async function cacheDel(patternOrKey: string): Promise<void> {
  if (!client || disabled) return;
  if (!patternOrKey.includes('*')) {
    await client.del(patternOrKey);
    return;
  }
  const stream = client.scanStream({ match: patternOrKey, count: 100 });
  const keys: string[] = [];
  for await (const chunk of stream) {
    keys.push(...(chunk as string[]));
  }
  if (keys.length) await client.del(...keys);
}

// ------------------------------------------------------------
// Digest warmup (primer lote tras Aplicar filtros)
// ------------------------------------------------------------

const WARMUP_KEY_PREFIX = 'digest:warmup:';
const WARMUP_QUOTA_KEY_PREFIX = 'digest:warmup_quota:';
const COOLDOWN_KEY_PREFIX = 'digest:cooldown:';

/** Fallback en memoria si Redis no está (single-process). */
const warmupMemory = new Map<string, number>();
/** telegramId → epoch ms hasta el que la cuota de warmup sigue activa */
const warmupQuotaMemory = new Map<string, number>();
const cooldownMemory = new Map<string, number>();

function warmupKey(telegramId: string): string {
  return `${WARMUP_KEY_PREFIX}${telegramId}`;
}

function warmupQuotaKey(telegramId: string): string {
  return `${WARMUP_QUOTA_KEY_PREFIX}${telegramId}`;
}

function cooldownKey(telegramId: string): string {
  return `${COOLDOWN_KEY_PREFIX}${telegramId}`;
}

function warmupQuotaHours(): number {
  return Math.max(1, parseInt(process.env['DIGEST_WARMUP_QUOTA_HOURS'] ?? '24', 10));
}

export type DigestWarmupScheduleResult =
  | { ok: true; delayMinutes: number }
  | { ok: false; reason: 'pending' }
  | { ok: false; reason: 'quota'; retryAfterSec: number };

async function getWarmupQuotaRetryAfterSec(telegramId: string): Promise<number | null> {
  const memUntil = warmupQuotaMemory.get(telegramId);
  if (memUntil !== undefined) {
    if (memUntil > Date.now()) {
      return Math.max(1, Math.ceil((memUntil - Date.now()) / 1000));
    }
    warmupQuotaMemory.delete(telegramId);
  }

  if (!client || disabled) return null;

  const ttl = await client.ttl(warmupQuotaKey(telegramId));
  if (ttl > 0) return ttl;
  return null;
}

async function markWarmupQuota(telegramId: string): Promise<void> {
  const hours = warmupQuotaHours();
  const ttlSec = hours * 3600;
  const until = Date.now() + ttlSec * 1000;
  warmupQuotaMemory.set(telegramId, until);

  if (!client || disabled) return;
  await client.set(warmupQuotaKey(telegramId), '1', 'EX', ttlSec);
}

/**
 * Encola un primer digest entre min–max minutos (random), dentro de la ventana `/horario` del VIP.
 * Si cae fuera, se agenda al próximo startHour permitido + delay.
 *
 * Anti-abuso: como máximo 1 warmup cada `DIGEST_WARMUP_QUOTA_HOURS` (default 24).
 * Aplicar filtros sigue libre; solo se limita el envío rápido 5–15 min.
 */
export async function scheduleDigestWarmup(
  telegramId: string,
  minMinutes = 5,
  maxMinutes = 15
): Promise<DigestWarmupScheduleResult> {
  // 1) Ya hay uno pendiente → no re-agendar
  if (!client || disabled) {
    if (warmupMemory.has(telegramId)) {
      return { ok: false, reason: 'pending' };
    }
  } else {
    const existing = await client.get(warmupKey(telegramId));
    if (existing) {
      return { ok: false, reason: 'pending' };
    }
  }

  // 2) Cuota (default 24 h)
  const retryAfterSec = await getWarmupQuotaRetryAfterSec(telegramId);
  if (retryAfterSec !== null) {
    return { ok: false, reason: 'quota', retryAfterSec };
  }

  const minM = Math.max(1, minMinutes);
  const maxM = Math.max(minM, maxMinutes);
  const delayMin = minM + Math.floor(Math.random() * (maxM - minM + 1));

  const { loadDigestPrefs, calcularDueWarmupEnVentana } = await import('./digest-schedule.service');
  const prefs = await loadDigestPrefs(telegramId);
  const dueAt = calcularDueWarmupEnVentana(prefs, delayMin);
  const delayUntilMin = Math.max(1, Math.ceil((dueAt - Date.now()) / 60_000));
  const ttlSec = Math.ceil((dueAt - Date.now()) / 1000) + 3600; // margen 1h

  if (!client || disabled) {
    warmupMemory.set(telegramId, dueAt);
    await markWarmupQuota(telegramId);
    return { ok: true, delayMinutes: delayUntilMin };
  }

  const key = warmupKey(telegramId);
  const ok = await client.set(key, String(dueAt), 'EX', Math.max(ttlSec, 3600), 'NX');
  if (ok !== 'OK') {
    return { ok: false, reason: 'pending' };
  }

  await markWarmupQuota(telegramId);
  return { ok: true, delayMinutes: delayUntilMin };
}

/** Reprograma warmup pendiente sin quemar cuota (fuera de ventana /horario). */
export async function rescheduleDigestWarmupAt(telegramId: string, dueAtMs: number): Promise<void> {
  const ttlSec = Math.ceil((dueAtMs - Date.now()) / 1000) + 3600;
  warmupMemory.set(telegramId, dueAtMs);
  if (!client || disabled) return;
  await client.set(warmupKey(telegramId), String(dueAtMs), 'EX', Math.max(ttlSec, 3600));
}

/** Warmups cuyo dueAt ya pasó. */
export async function listDueDigestWarmups(): Promise<string[]> {
  const now = Date.now();
  const due: string[] = [];

  if (!client || disabled) {
    for (const [id, dueAt] of warmupMemory.entries()) {
      if (dueAt <= now) due.push(id);
    }
    return due;
  }

  const stream = client.scanStream({ match: `${WARMUP_KEY_PREFIX}*`, count: 100 });
  for await (const chunk of stream) {
    for (const key of chunk as string[]) {
      const raw = await client.get(key);
      if (!raw) continue;
      const dueAt = parseInt(raw, 10);
      if (!Number.isFinite(dueAt) || dueAt > now) continue;
      due.push(key.slice(WARMUP_KEY_PREFIX.length));
    }
  }
  return due;
}

const WARMUP_ATTEMPTS_KEY_PREFIX = 'digest:warmup_attempts:';
const warmupAttemptsMemory = new Map<string, number>();

function warmupAttemptsKey(telegramId: string): string {
  return `${WARMUP_ATTEMPTS_KEY_PREFIX}${telegramId}`;
}

export async function clearDigestWarmup(telegramId: string): Promise<void> {
  warmupMemory.delete(telegramId);
  warmupAttemptsMemory.delete(telegramId);
  if (!client || disabled) return;
  await client.del(warmupKey(telegramId), warmupAttemptsKey(telegramId));
}

/**
 * Tras fallo de warmup (0 candidatos / Telegram): reintenta más tarde.
 * Tras `maxAttempts` fallos → abandona la cola (ciclo regular).
 */
export async function deferWarmupOrGiveUp(
  telegramId: string,
  delayMinutes = 15,
  maxAttempts = 3
): Promise<'deferred' | 'gave_up'> {
  let attempts = (warmupAttemptsMemory.get(telegramId) ?? 0) + 1;
  if (client && !disabled) {
    const key = warmupAttemptsKey(telegramId);
    attempts = await client.incr(key);
    if (attempts === 1) {
      await client.expire(key, warmupQuotaHours() * 3600);
    }
  }
  warmupAttemptsMemory.set(telegramId, attempts);

  if (attempts >= maxAttempts) {
    await clearDigestWarmup(telegramId);
    return 'gave_up';
  }

  const delayMs = Math.max(1, delayMinutes) * 60_000;
  await rescheduleDigestWarmupAt(telegramId, Date.now() + delayMs);
  return 'deferred';
}


/** Cooldown/debounce corto tras un envío (anti doble-fire). */
export async function markDigestCooldown(telegramId: string, ttlSec = 90): Promise<void> {
  const until = Date.now() + ttlSec * 1000;
  cooldownMemory.set(telegramId, until);
  if (!client || disabled) return;
  await client.set(cooldownKey(telegramId), '1', 'EX', ttlSec);
}

export async function hasDigestCooldown(telegramId: string): Promise<boolean> {
  const mem = cooldownMemory.get(telegramId);
  if (mem && mem > Date.now()) return true;
  if (mem && mem <= Date.now()) cooldownMemory.delete(telegramId);

  if (!client || disabled) return false;
  const v = await client.get(cooldownKey(telegramId));
  return !!v;
}

export async function clearDigestCooldown(telegramId: string): Promise<void> {
  cooldownMemory.delete(telegramId);
  if (!client || disabled) return;
  await client.del(cooldownKey(telegramId));
}

// ------------------------------------------------------------
// Cadencia regular por usuario (anclada al último Aplicar filtros)
// ------------------------------------------------------------

const CADENCE_KEY_PREFIX = 'digest:next_regular:';
const cadenceMemory = new Map<string, number>(); // telegramId → nextDueAt ms

function cadenceKey(telegramId: string): string {
  return `${CADENCE_KEY_PREFIX}${telegramId}`;
}

async function intervalMsForUser(telegramId: string): Promise<number> {
  try {
    const { loadDigestPrefs, intervalMsFromPrefs } = await import('./digest-schedule.service');
    return intervalMsFromPrefs(await loadDigestPrefs(telegramId));
  } catch {
    const mins = Math.max(1, parseInt(process.env['NOTIFIER_INTERVAL_MINUTES'] ?? '120', 10));
    return mins * 60 * 1000;
  }
}

async function setNextRegularAt(telegramId: string, nextAtMs: number): Promise<void> {
  cadenceMemory.set(telegramId, nextAtMs);
  if (!client || disabled) return;
  const ttlSec = Math.ceil((nextAtMs - Date.now()) / 1000) + 7 * 24 * 3600;
  await client.set(cadenceKey(telegramId), String(nextAtMs), 'EX', Math.max(ttlSec, 3600));
}

async function getNextRegularAt(telegramId: string): Promise<number | null> {
  const mem = cadenceMemory.get(telegramId);
  if (mem !== undefined) return mem;

  if (!client || disabled) return null;
  const raw = await client.get(cadenceKey(telegramId));
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  cadenceMemory.set(telegramId, n);
  return n;
}

export async function getNextRegularAtMs(telegramId: string): Promise<number | null> {
  return getNextRegularAt(telegramId);
}

export async function setNextRegularAtMs(telegramId: string, nextAtMs: number): Promise<void> {
  await setNextRegularAt(telegramId, nextAtMs);
}

/**
 * Tras Aplicar filtros: el ciclo (intervalo /horario del VIP) se reinicia desde ahora.
 * El próximo digest *regular* será en now + INTERVAL. El warmup 5–15 min es independiente.
 */
export async function resetDigestCadenceOnFilterApply(telegramId: string): Promise<number> {
  const interval = await intervalMsForUser(telegramId);
  const nextAt = Date.now() + interval;
  await setNextRegularAt(telegramId, nextAt);
  await clearDigestCooldown(telegramId);
  return Math.ceil(interval / 60_000);
}

/** ¿Toca digest regular? (sin clave = due, primera vez / legacy). */
export async function isRegularDigestDue(telegramId: string): Promise<boolean> {
  const next = await getNextRegularAt(telegramId);
  if (next === null) return true;
  return Date.now() >= next;
}

/** Tras un digest regular enviado con éxito → siguiente en +intervalo del usuario. */
export async function markRegularDigestSent(telegramId: string): Promise<void> {
  const interval = await intervalMsForUser(telegramId);
  const nextAt = Date.now() + interval;
  await setNextRegularAt(telegramId, nextAt);
  await markDigestCooldown(telegramId, 90);
}

/** Tras warmup: no mueve la cadencia regular; solo debounce corto. */
export async function markWarmupDigestSent(telegramId: string): Promise<void> {
  await markDigestCooldown(telegramId, 90);
}

/**
 * Soft-purge /eliminar_cuenta: limpia cadencia, warmup, cuota y cooldown
 * (memoria + Redis) para que no queden restos del VIP anterior.
 */
export async function clearDigestStateOnAccountPurge(telegramId: string): Promise<void> {
  await clearDigestWarmup(telegramId);
  await clearDigestCooldown(telegramId);
  warmupQuotaMemory.delete(telegramId);
  cadenceMemory.delete(telegramId);
  if (!client || disabled) return;
  await client.del(
    cadenceKey(telegramId),
    warmupQuotaKey(telegramId),
    warmupKey(telegramId),
    cooldownKey(telegramId)
  );
}
