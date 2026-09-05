import { redactSecrets } from './secrets';

/**
 * Intercepta console.* y redacta secretos (estilo AutoBroker).
 * Llamar una vez al arranque, antes de logs sensibles.
 */
export function installRedactedConsole(): void {
  const wrap = (fn: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      const safe = args.map((a) => {
        if (typeof a === 'string') return redactSecrets(a);
        if (a instanceof Error) {
          return new Error(redactSecrets(a.message));
        }
        try {
          return JSON.parse(redactSecrets(JSON.stringify(a)));
        } catch {
          return a;
        }
      });
      fn(...safe);
    };
  };

  console.log = wrap(console.log.bind(console));
  console.info = wrap(console.info.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
}
