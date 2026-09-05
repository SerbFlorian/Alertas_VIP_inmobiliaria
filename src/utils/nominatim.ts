// ============================================================
// Nominatim (OpenStreetMap) — geocode gratis con rate-limit
// ============================================================
// Uso permitido: ~1 req/s, User-Agent identificable, caché agresiva.
// Docs: https://operations.osmfoundation.org/policies/nominatim/
// ============================================================

import axios from 'axios';
import { createHash } from 'crypto';
import { logger } from '../services/logger';
import { cacheGetJson, cacheSetJson } from '../services/redis.service';
import { mapearAMacroZona } from './zonas-diccionario';
import { mapearCodigoPostal } from './codigos-postales';
import { esZonaBasuraOCalle } from './normalizer';

export type Coords = { lat: number; lon: number };

type NominatimAddress = {
  suburb?: string;
  neighbourhood?: string;
  quarter?: string;
  city_district?: string;
  district?: string;
  borough?: string;
  city?: string;
  town?: string;
  municipality?: string;
  postcode?: string;
  road?: string;
  pedestrian?: string;
};

type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: NominatimAddress;
};

const DEFAULT_UA =
  process.env['NOMINATIM_USER_AGENT'] ||
  'AlertasVIP-Telegram/1.0 (zonas-enrich; local-ops; no-commercial-bulk)';

const BASE_URL = (
  process.env['NOMINATIM_BASE_URL'] || 'https://nominatim.openstreetmap.org'
).replace(/\/$/, '');

/** left,bottom,right,top — acota búsquedas a la ciudad */
const VIEWBOX: Record<string, string> = {
  barcelona: '2.05,41.32,2.23,41.47',
  madrid: '-3.83,40.31,-3.52,40.56',
  valencia: '-0.43,39.42,-0.28,39.52',
};

const CACHE_OK_TTL = 60 * 60 * 24 * 30; // 30d
const CACHE_MISS_TTL = 60 * 60 * 24 * 7; // 7d

let lastRequestAt = 0;

function delayMs(): number {
  const n = parseInt(process.env['ENRICH_ZONAS_DELAY_MS'] || '1100', 10);
  return Number.isFinite(n) && n >= 1000 ? n : 1100;
}

async function throttle(): Promise<void> {
  const minGap = delayMs();
  const wait = lastRequestAt + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function cacheKey(kind: 'ok' | 'miss', payload: string): string {
  const h = createHash('sha1').update(payload).digest('hex').slice(0, 24);
  return `geocode:${kind}:${h}`;
}

/** Extrae lat/lng de URLs de Maps / query strings. */
export function extraerCoords(...textos: (string | null | undefined)[]): Coords | undefined {
  const t = textos.filter(Boolean).join(' ');
  if (!t) return undefined;

  const patterns = [
    /[?&#]lat=(-?\d+\.?\d*)[^\d]+(?:lng|lon)=(-?\d+\.?\d*)/i,
    /[?&#](?:lng|lon)=(-?\d+\.?\d*)[^\d]+lat=(-?\d+\.?\d*)/i,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let lat = parseFloat(m[1]);
    let lon = parseFloat(m[2]);
    // Patrón lon,lat invertido
    if (re.source.startsWith('[?&#](?:lng|lon)')) {
      lon = parseFloat(m[1]);
      lat = parseFloat(m[2]);
    }
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= 35 &&
      lat <= 44 &&
      lon >= -10 &&
      lon <= 5
    ) {
      return { lat, lon };
    }
  }
  return undefined;
}

/** Limpia "barcelona Calle X" → "Calle X" para geocode. */
export function limpiarDireccionParaGeocode(
  zona: string | null | undefined,
  ciudad: string
): string | undefined {
  let t = (zona || '').trim();
  if (!t || /discover/i.test(t)) return undefined;
  if (/^(barcelona|madrid|valencia)\s*$/i.test(t)) return undefined;

  t = t.replace(
    new RegExp(`^(${ciudad})\\s*[,:\\-]?\\s*`, 'i'),
    ''
  );
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length < 5) return undefined;
  // Solo tiene sentido geocodificar si parece calle/dirección
  if (!esZonaBasuraOCalle(t) && !/\d/.test(t)) {
    // Puede ser un barrio suelto mal escrito — aún útil para search
    return t;
  }
  if (
    !/\b(carrer|calle|avinguda|avenida|avda\.?|paseo|passeig|plaza|plaça|ronda|travessera|camino|camí|c\/|c\.)\b/i.test(
      t
    ) &&
    !/\d{5}/.test(t)
  ) {
    return undefined;
  }
  return t;
}

function candidatosDesdeAddress(addr: NominatimAddress | undefined, ciudad: string): string[] {
  if (!addr) return [];
  const raw = [
    addr.suburb,
    addr.neighbourhood,
    addr.quarter,
    addr.city_district,
    addr.district,
    addr.borough,
  ].filter(Boolean) as string[];

  const out: string[] = [];
  for (const r of raw) {
    const macro = mapearAMacroZona(r, ciudad);
    if (macro) out.push(macro);
  }
  if (addr.postcode) {
    const fromCp = mapearCodigoPostal(addr.postcode, ciudad);
    if (fromCp) out.push(fromCp);
  }
  return out;
}

export function macroDesdeNominatim(
  result: NominatimResult | null | undefined,
  ciudad: string
): string | undefined {
  if (!result) return undefined;
  const hits = candidatosDesdeAddress(result.address, ciudad);
  return hits[0];
}

async function nominatimGet(
  path: string,
  params: Record<string, string>
): Promise<NominatimResult | NominatimResult[] | null> {
  await throttle();
  try {
    const { data } = await axios.get(`${BASE_URL}${path}`, {
      params: { ...params, format: 'json', addressdetails: '1' },
      timeout: 15000,
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json',
        'Accept-Language': 'es',
      },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (!data) return null;
    return data as NominatimResult | NominatimResult[];
  } catch (err) {
    logger.warn('Nominatim request falló', { err, path, params });
    return null;
  }
}

export async function reverseGeocode(
  coords: Coords,
  ciudad: string
): Promise<string | undefined> {
  const payload = `rev:${coords.lat.toFixed(5)},${coords.lon.toFixed(5)}:${ciudad}`;
  const cached = await cacheGetJson<{ macro: string | null }>(cacheKey('ok', payload));
  if (cached) return cached.macro || undefined;
  const miss = await cacheGetJson<boolean>(cacheKey('miss', payload));
  if (miss) return undefined;

  const data = (await nominatimGet('/reverse', {
    lat: String(coords.lat),
    lon: String(coords.lon),
    zoom: '18',
  })) as NominatimResult | null;

  const macro = macroDesdeNominatim(data, ciudad);
  if (macro) {
    await cacheSetJson(cacheKey('ok', payload), { macro }, CACHE_OK_TTL);
    return macro;
  }
  await cacheSetJson(cacheKey('miss', payload), true, CACHE_MISS_TTL);
  await cacheSetJson(cacheKey('ok', payload), { macro: null }, CACHE_MISS_TTL);
  return undefined;
}

export async function forwardGeocode(
  direccion: string,
  ciudad: string
): Promise<string | undefined> {
  const ciudadLabel =
    ciudad.toLowerCase() === 'barcelona'
      ? 'Barcelona'
      : ciudad.toLowerCase() === 'madrid'
        ? 'Madrid'
        : 'Valencia';
  const q = `${direccion}, ${ciudadLabel}, España`;
  const payload = `fwd:${q.toLowerCase()}`;
  const cached = await cacheGetJson<{ macro: string | null }>(cacheKey('ok', payload));
  if (cached) return cached.macro || undefined;
  const miss = await cacheGetJson<boolean>(cacheKey('miss', payload));
  if (miss) return undefined;

  const viewbox = VIEWBOX[ciudad.toLowerCase()];
  const params: Record<string, string> = {
    q,
    limit: '1',
    countrycodes: 'es',
  };
  if (viewbox) {
    params.viewbox = viewbox;
    params.bounded = '1';
  }

  const data = await nominatimGet('/search', params);
  const first = Array.isArray(data) ? data[0] : data;
  const macro = macroDesdeNominatim(first, ciudad);
  if (macro) {
    await cacheSetJson(cacheKey('ok', payload), { macro }, CACHE_OK_TTL);
    return macro;
  }
  await cacheSetJson(cacheKey('miss', payload), true, CACHE_MISS_TTL);
  await cacheSetJson(cacheKey('ok', payload), { macro: null }, CACHE_MISS_TTL);
  return undefined;
}

/**
 * Resuelve macro: coords (reverse) → dirección (forward).
 * No llama a Nominatim si no hay señal útil.
 */
export async function resolverMacroConNominatim(opts: {
  ciudad: string;
  zona?: string | null;
  titulo?: string | null;
  enlace?: string | null;
  resumen?: string | null;
}): Promise<{ macro?: string; via: 'coords' | 'forward' | 'none' }> {
  const { ciudad } = opts;
  const coords = extraerCoords(opts.enlace, opts.zona, opts.titulo, opts.resumen);
  if (coords) {
    const macro = await reverseGeocode(coords, ciudad);
    if (macro) return { macro, via: 'coords' };
  }

  const dir =
    limpiarDireccionParaGeocode(opts.zona, ciudad) ||
    limpiarDireccionParaGeocode(opts.titulo, ciudad);
  if (dir) {
    const macro = await forwardGeocode(dir, ciudad);
    if (macro) return { macro, via: 'forward' };
  }

  return { via: 'none' };
}
