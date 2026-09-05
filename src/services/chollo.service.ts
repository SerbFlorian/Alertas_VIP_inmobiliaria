import { logger } from './logger';
import { normalizarZona } from '../utils/normalizer';

// ============================================================
// CHOLLO SCORE — % real bajo mediana (ciudad × zona × habs)
// ============================================================
// La mediana se calcula sobre el inventario reciente en memoria
// (sin tabla extra). Fallbacks: ciudad+zona → ciudad+habs → ciudad.
// ============================================================

export interface CholloScore {
  mediana: number | null;
  pctBajoMediana: number | null;
  esChollo: boolean;
  muestra: number;
  bucket: string;
}

const MIN_MUESTRA = parseInt(process.env['CHOLLO_MIN_SAMPLES'] ?? '5', 10);
/** % mínimo bajo la mediana para etiquetar “chollo” (default 5 %) */
const MIN_PCT_CHOLLO = parseInt(process.env['CHOLLO_MIN_PCT'] ?? '5', 10);

type PisoLike = {
  precio: number;
  ciudad?: string | null;
  zona?: string | null;
  zonaNorm?: string | null;
  habitaciones?: number | null;
};

function key(ciudad: string, zonaNorm: string | null, habs: number | null): string {
  return `${ciudad}|${zonaNorm ?? '*'}|${habs ?? '*'}`;
}

export function mediana(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * Índice de precios por bucket para un ciclo de notifier.
 * Construye mapas ciudad|zona|habs, ciudad|zona|*, ciudad|*|habs, ciudad|*|*.
 */
export function construirIndiceMedianas(pisos: PisoLike[]): Map<string, number[]> {
  const map = new Map<string, number[]>();

  const push = (k: string, precio: number) => {
    if (!precio || precio <= 0) return;
    const arr = map.get(k);
    if (arr) arr.push(precio);
    else map.set(k, [precio]);
  };

  for (const p of pisos) {
    if (!p.ciudad || !p.precio) continue;
    const ciudad = p.ciudad.toLowerCase();
    const znRaw = (p.zonaNorm || (p.zona ? normalizarZona(p.zona) : '') || '').toLowerCase();
    const zn = znRaw || null;
    const habs = p.habitaciones ?? null;

    push(key(ciudad, zn, habs), p.precio);
    if (zn) push(key(ciudad, zn, null), p.precio);
    if (habs !== null) push(key(ciudad, null, habs), p.precio);
    push(key(ciudad, null, null), p.precio);
  }

  return map;
}

function medianaDeBucket(index: Map<string, number[]>, k: string): { mediana: number; muestra: number } | null {
  const arr = index.get(k);
  if (!arr || arr.length < MIN_MUESTRA) return null;
  const med = mediana(arr);
  if (med === null) return null;
  return { mediana: med, muestra: arr.length };
}

/**
 * Calcula cuánto % está el precio por debajo de la mediana del bucket más específico posible.
 */
export function calcularCholloScore(piso: PisoLike, index: Map<string, number[]>): CholloScore {
  const ciudad = (piso.ciudad || '').toLowerCase();
  const znRaw = (piso.zonaNorm || (piso.zona ? normalizarZona(piso.zona) : '') || '').toLowerCase();
  const zn = znRaw || null;
  const habs = piso.habitaciones ?? null;

  const candidatos = [
    key(ciudad, zn, habs),
    key(ciudad, zn, null),
    key(ciudad, null, habs),
    key(ciudad, null, null),
  ];

  let elegido: { mediana: number; muestra: number; bucket: string } | null = null;
  for (const k of candidatos) {
    const r = medianaDeBucket(index, k);
    if (r) {
      elegido = { ...r, bucket: k };
      break;
    }
  }

  if (!elegido || !piso.precio) {
    return {
      mediana: null,
      pctBajoMediana: null,
      esChollo: false,
      muestra: 0,
      bucket: candidatos[0]!,
    };
  }

  const pct =
    elegido.mediana > 0
      ? Math.round(((elegido.mediana - piso.precio) / elegido.mediana) * 100)
      : null;

  const esChollo = pct !== null && pct >= MIN_PCT_CHOLLO;

  return {
    mediana: elegido.mediana,
    pctBajoMediana: pct,
    esChollo,
    muestra: elegido.muestra,
    bucket: elegido.bucket,
  };
}

export function formatearLineaChollo(score: CholloScore): string | null {
  if (score.mediana === null || score.pctBajoMediana === null) return null;
  const med = `aprox. ${score.mediana}€`;
  if (score.pctBajoMediana > 0) {
    return `📉 <b>${score.pctBajoMediana}% bajo la mediana</b> de la zona (${med})`;
  }
  if (score.pctBajoMediana === 0) {
    return `📊 En la mediana de la zona (${med})`;
  }
  // Por encima de la mediana: no vender como chollo
  return `📊 ~${Math.abs(score.pctBajoMediana)}% sobre la mediana (${med})`;
}

export function logCholloConfig(): void {
  logger.info(`📊 Chollo score: min muestra=${MIN_MUESTRA}, min % chollo=${MIN_PCT_CHOLLO}`);
}
