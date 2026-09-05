/**
 * Redacción de secretos — sin imports de logger (evita ciclos).
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk_live_[A-Za-z0-9]+/g,
  /sk_test_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
  /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /sk-[A-Za-z0-9]{20,}/g,
];

export function redactSecrets(texto: string): string {
  let out = texto;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(/(postgresql:\/\/[^:]+:)([^@]+)(@)/gi, '$1***$3');
  out = out.replace(/(redis:\/\/:)([^@]+)(@)/gi, '$1***$3');
  out = out.replace(/(redis:\/\/[^:]+:)([^@]+)(@)/gi, '$1***$3');
  out = out.replace(/(R2_SECRET_ACCESS_KEY[=:\s]+)([^\s"']+)/gi, '$1***');
  out = out.replace(/(BRIGHTDATA_API_KEY[=:\s]+)([^\s"']+)/gi, '$1***');
  out = out.replace(/(POSTGRES_PASSWORD[=:\s]+)([^\s"']+)/gi, '$1***');
  out = out.replace(/(REDIS_PASSWORD[=:\s]+)([^\s"']+)/gi, '$1***');
  return out;
}
