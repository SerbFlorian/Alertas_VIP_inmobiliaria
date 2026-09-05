// ============================================================
// Diccionario de macro-zonas por ciudad (fuente: JSON)
// ============================================================
// Catálogo editable: src/data/zonas-principales.json
// El menú VIP muestra esas macros; scrapers/inventario mapean a ellas.
// ============================================================

import catalogo from '../data/zonas-principales.json';

export type ZonaPrincipal = {
  nombre: string;
  aliases: string[];
};

export type CiudadZonas = {
  sufijo: string;
  zonas: ZonaPrincipal[];
};

export type CatalogoZonas = Record<string, CiudadZonas>;

const CATALOGO = catalogo as CatalogoZonas;

/** Macro canónica → aliases (compat / debug) */
export const ZONAS_DICCIONARIO: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const ciudad of Object.keys(CATALOGO)) {
    const { sufijo, zonas } = CATALOGO[ciudad];
    for (const z of zonas) {
      const macro = `${z.nombre} (${sufijo})`;
      out[macro] = [...new Set([z.nombre, ...z.aliases])];
    }
  }
  return out;
})();

function sinAcentos(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Quita sufijo "(BCN|MAD|VLC)" al final, si existe. */
export function stripSufijoCiudad(zona: string): string {
  return zona.replace(/\s*\((bcn|mad|vlc)\)\s*$/i, '').trim();
}

type AliasEntry = { macro: string; aliasNorm: string; aliasLen: number };

const ALIASES_POR_CIUDAD: Record<string, AliasEntry[]> = (() => {
  const out: Record<string, AliasEntry[]> = {};

  for (const [ciudad, data] of Object.entries(CATALOGO)) {
    const entries: AliasEntry[] = [];
    for (const z of data.zonas) {
      const macro = `${z.nombre} (${data.sufijo})`;
      const aliases = new Set<string>([z.nombre, ...z.aliases, stripSufijoCiudad(macro)]);
      for (const alias of aliases) {
        const aliasNorm = sinAcentos(alias);
        if (aliasNorm.length < 2) continue;
        entries.push({ macro, aliasNorm, aliasLen: aliasNorm.length });
      }
    }
    entries.sort((a, b) => b.aliasLen - a.aliasLen);
    out[ciudad.toLowerCase()] = entries;
  }

  return out;
})();

/**
 * Lista canónica de macros de una ciudad (orden del JSON).
 * Ej: [{ zona: "Centro (MAD)", zonaNorm: "centro (mad)" }, ...]
 */
export function listarZonasPrincipales(
  ciudad: string
): { zona: string; zonaNorm: string }[] {
  const data = CATALOGO[(ciudad || '').toLowerCase()];
  if (!data) return [];

  return data.zonas.map((z) => {
    const zona = `${z.nombre} (${data.sufijo})`;
    return {
      zona,
      zonaNorm: sinAcentos(zona),
    };
  });
}

export function ciudadesConZonas(): string[] {
  return Object.keys(CATALOGO);
}

/**
 * Mapea texto libre (columna zona, título, etc.) a la macro-zona de ESA ciudad.
 * Ignora sufijos de otra ciudad: "Eixample (BCN)" en Valencia → "Eixample (VLC)".
 */
export function mapearAMacroZona(texto: string, ciudad: string): string | undefined {
  const c = (ciudad || '').toLowerCase().trim();
  if (!texto || !c || !ALIASES_POR_CIUDAD[c]) return undefined;

  const haystack = sinAcentos(stripSufijoCiudad(texto));
  if (haystack.length < 2) return undefined;

  // Compat: datos antiguos "Vallecas (MAD)" → Puente de Vallecas
  if (c === 'madrid' && haystack === 'vallecas') {
    return 'Puente de Vallecas (MAD)';
  }

  for (const entry of ALIASES_POR_CIUDAD[c]) {
    if (haystack === entry.aliasNorm) return entry.macro;

    if (entry.aliasLen >= 4) {
      const re = new RegExp(
        `(^|[^a-z0-9])${escapeRegExp(entry.aliasNorm)}([^a-z0-9]|$)`,
        'i'
      );
      if (re.test(haystack)) return entry.macro;
    }
  }

  return undefined;
}

/**
 * Resolución flexible de zona para búsqueda IA / filtros libres.
 * Tolera acentos, aliases y coincidencias parciales (ej. "gracia" → Gràcia).
 */
export function aproximarMacroZona(
  texto: string,
  ciudad?: string | null
): { macro: string; ciudad: string; score: number } | undefined {
  const needle = sinAcentos(stripSufijoCiudad(texto || ''));
  if (needle.length < 2) return undefined;

  const cities = (ciudad ? [ciudad] : ['barcelona', 'madrid', 'valencia']).map((c) =>
    c.toLowerCase().trim()
  );

  // 1) Match exacto / word-boundary por ciudad
  for (const c of cities) {
    const macro = mapearAMacroZona(texto, c);
    if (macro) return { macro, ciudad: c, score: 1 };
  }

  // 2) Parcial: alias↔needle (typos cortos) o alias como palabra dentro de un texto largo
  let best: { macro: string; ciudad: string; score: number; aliasLen: number } | undefined;
  for (const c of cities) {
    for (const entry of ALIASES_POR_CIUDAD[c] || []) {
      if (entry.aliasLen < 3) continue;
      let score = 0;
      if (entry.aliasNorm === needle) {
        score = 1;
      } else if (entry.aliasNorm.includes(needle) && needle.length >= 3 && needle.length <= entry.aliasLen + 2) {
        score = needle.length / entry.aliasNorm.length;
      } else if (entry.aliasLen >= 4 && needle.includes(entry.aliasNorm)) {
        const re = new RegExp(
          `(^|[^a-z0-9])${escapeRegExp(entry.aliasNorm)}([^a-z0-9]|$)`,
          'i'
        );
        if (re.test(needle)) score = 0.9;
      }
      if (score < 0.55) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score && entry.aliasLen > best.aliasLen)
      ) {
        best = { macro: entry.macro, ciudad: c, score, aliasLen: entry.aliasLen };
      }
    }
  }

  return best
    ? { macro: best.macro, ciudad: best.ciudad, score: best.score }
    : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sufijoEsperado(ciudad: string): string | undefined {
  const data = CATALOGO[(ciudad || '').toLowerCase()];
  return data ? `(${data.sufijo})` : undefined;
}
