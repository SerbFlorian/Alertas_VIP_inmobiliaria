// ============================================================
// NORMALIZADOR DE ZONAS
// ============================================================
// Convierte una zona/macro-zona en su forma normalizada para
// comparar, indexar y agrupar sin depender de mayúsculas/acentos.
// Ej: "Eixample (BCN)" -> "eixample (bcn)"
// ============================================================

import { mapearAMacroZona, sufijoEsperado } from './zonas-diccionario';
import { recuperarMacroDesdeCodigoPostal } from './codigos-postales';

/** Normaliza una zona: minúsculas, sin acentos, espacios colapsados */
export function normalizarZona(zona: string): string {
  return zona
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // eliminar diacríticos
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Basura / calles / UI — NO es un distrito. Se ignora como zona y se
 * intenta mapear desde el título.
 */
export function esZonaBasuraOCalle(zona: string): boolean {
  const t = (zona || '').trim();
  if (!t) return true;
  if (/discover/i.test(t)) return true;
  // "barcelona Carrer de …", "madrid Calle …", calles sueltas
  if (
    /\b(carrer|calle|avinguda|avenida|avda\.?|paseo|passeig|plaza|plaça|ronda|travessera|camino|camí)\b/i.test(
      t
    )
  ) {
    return true;
  }
  // Solo ciudad sin barrio
  if (/^(barcelona|madrid|valencia)\s*$/i.test(t)) return true;
  return false;
}

/**
 * Valida que una zona sea utilizable: no sea basura y (si tiene el formato
 * de macro-zona "Nombre (XXX)") que el sufijo de ciudad coincida con la
 * ciudad del piso.
 */
export function esZonaValida(zona: string, ciudad: string): boolean {
  if (!zona || zona.trim().length < 2) return false;
  if (esZonaBasuraOCalle(zona)) return false;

  const matchSufijo = zona.match(/\(([a-zA-Z]{3})\)\s*$/);
  if (matchSufijo) {
    const sufijoEncontrado = `(${matchSufijo[1].toLowerCase()})`;
    const esperado = sufijoEsperado(ciudad)?.toLowerCase();
    if (esperado && sufijoEncontrado !== esperado) {
      return false;
    }
  }

  return true;
}

/** Quita prefijos "Barcelona,", "en Madrid:", etc. para no tapar el barrio. */
function limpiarRuidoCiudad(texto: string, ciudad: string): string {
  const c = (ciudad || '').trim();
  if (!c) return texto;
  let t = texto.trim();
  t = t.replace(
    /^(piso|habitaci[oó]n|estudio|ático|atico|apartamento|alquiler|casa)\s+(en\s+|de\s+)?/i,
    ''
  );
  const reCity = new RegExp(
    `(^|[\\s,\\-/])${escapeRegExp(c)}([\\s,\\-:/]|$)`,
    'ig'
  );
  t = t.replace(reCity, ' ').replace(/\s+/g, ' ').trim();
  return t || texto.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function intentarMapear(texto: string, ciudad: string): string | null {
  const t = (texto || '').trim();
  if (!t) return null;
  // Calles/Discover no aportan distrito (salvo que el mismo string traiga barrio tras coma)
  if (esZonaBasuraOCalle(t) && !/,/.test(t)) return null;

  if (esZonaValida(t, ciudad) && /\((bcn|mad|vlc)\)\s*$/i.test(t)) {
    return mapearAMacroZona(t, ciudad) ?? t;
  }

  const mapped = mapearAMacroZona(t, ciudad);
  if (mapped) return mapped;

  const limpio = limpiarRuidoCiudad(t, ciudad);
  if (limpio !== t && !esZonaBasuraOCalle(limpio)) {
    const mapped2 = mapearAMacroZona(limpio, ciudad);
    if (mapped2) return mapped2;
  }

  for (const parte of limpio.split(/[,|/·•]+/)) {
    const p = parte.trim();
    if (p.length < 3 || esZonaBasuraOCalle(p)) continue;
    const m = mapearAMacroZona(p, ciudad);
    if (m) return m;
  }

  return null;
}

/**
 * Recupera una macro-zona canónica.
 * Preferencia: macros válidas en zona/zonaNorm → título → combo.
 * Calles/"Discover" en zona se saltan para no tapar un título útil.
 */
export function recuperarMacroZona(
  ciudad: string,
  zona?: string | null,
  zonaNorm?: string | null,
  titulo?: string | null
): string | null {
  const c = (ciudad || '').trim();
  if (!c) return null;

  // 1) zonaNorm / zona solo si parecen macros o barrios (no calles)
  for (const raw of [zonaNorm, zona]) {
    const t = (raw || '').trim();
    if (!t || esZonaBasuraOCalle(t)) continue;
    const hit = intentarMapear(t, c);
    if (hit) return hit;
  }

  // 2) Título (a menudo trae el barrio aunque zona sea "Carrer …")
  const hitTitulo = intentarMapear(titulo || '', c);
  if (hitTitulo) return hitTitulo;

  // 3) Combo por si el barrio está partido entre campos
  const combo = [zona, titulo].filter(Boolean).join(' | ');
  if (combo.trim()) {
    const hitCombo = intentarMapear(combo, c);
    if (hitCombo) return hitCombo;
  }

  // 4) Código postal (Rentumo: calle + CP sin barrio)
  const desdeCp = recuperarMacroDesdeCodigoPostal(c, zona, zonaNorm, titulo);
  if (desdeCp) return desdeCp;

  return null;
}
