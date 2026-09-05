// ============================================================
// Código postal → macro-zona (fuente: JSON)
// ============================================================
// Usado cuando el anuncio no trae barrio (p. ej. Rentumo: calle + CP).
// ============================================================

import catalogoCp from '../data/codigos-postales.json';
import { mapearAMacroZona, sufijoEsperado } from './zonas-diccionario';

type CatalogoCp = Record<string, Record<string, string>>;

const CATALOGO_CP = catalogoCp as CatalogoCp;

/** Prefijos provinciales de las 3 ciudades VIP (Correos). */
const PREFIJO_CIUDAD: Record<string, string> = {
  barcelona: '08',
  madrid: '28',
  valencia: '46',
};

/**
 * Extrae el primer CP español de 5 dígitos (01xxx–52xxx).
 * Preferible pasar address/URL/título por separado y llamar varias veces.
 */
export function extraerCodigoPostal(texto: string): string | undefined {
  if (!texto) return undefined;
  const re = /\b((?:0[1-9]|[1-4]\d|5[0-2])\d{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    return m[1];
  }
  return undefined;
}

/**
 * Extrae CP preferentemente del prefijo de la ciudad (evita CPs ajenos en texto largo).
 */
export function extraerCodigoPostalDeCiudad(texto: string, ciudad: string): string | undefined {
  if (!texto) return undefined;
  const prefijo = PREFIJO_CIUDAD[(ciudad || '').toLowerCase()];
  if (prefijo) {
    const re = new RegExp(`\\b(${prefijo}\\d{3})\\b`);
    const m = texto.match(re);
    if (m) return m[1];
  }
  return extraerCodigoPostal(texto);
}

/**
 * Mapea CP → macro canónica "Nombre (SUF)".
 * Valida que el nombre exista en el catálogo de zonas de esa ciudad.
 */
export function mapearCodigoPostal(cp: string, ciudad: string): string | undefined {
  const c = (ciudad || '').toLowerCase().trim();
  const codigo = (cp || '').trim();
  if (!c || !/^\d{5}$/.test(codigo)) return undefined;

  const nombre = CATALOGO_CP[c]?.[codigo];
  if (!nombre) return undefined;

  const macro = mapearAMacroZona(nombre, c);
  if (macro) return macro;

  const suf = sufijoEsperado(c);
  return suf ? `${nombre} ${suf}` : undefined;
}

/**
 * Intenta recuperar macro desde textos (address, título, URL…) vía CP.
 */
export function recuperarMacroDesdeCodigoPostal(
  ciudad: string,
  ...textos: (string | null | undefined)[]
): string | undefined {
  const combinado = textos.filter(Boolean).join(' ');
  const cp = extraerCodigoPostalDeCiudad(combinado, ciudad);
  if (!cp) return undefined;
  return mapearCodigoPostal(cp, ciudad);
}
