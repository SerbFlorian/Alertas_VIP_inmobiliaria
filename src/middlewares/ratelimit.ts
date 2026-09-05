/**
 * Rate-limit simple en memoria por IP (anti-abuso webhook Stripe).
 * Sin dependencia externa — suficiente para T0 detrás de NPM/localhost.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

export function isRateLimited(
  key: string,
  max: number = 60,
  windowMs: number = 60_000
): boolean {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || now >= cur.resetAt) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  cur.count++;
  if (cur.count > max) return true;
  return false;
}

/** Limpieza ocasional para no crecer sin límite */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) {
    if (now >= v.resetAt) hits.delete(k);
  }
}, 120_000).unref?.();
