import { prisma } from './prisma';
import { logger } from '../services/logger';
import type { Piso, EstadoUsuario } from '../types';
import { normalizarZona, recuperarMacroZona } from '../utils/normalizer';
import { aproximarMacroZona, listarZonasPrincipales } from '../utils/zonas-diccionario';

export const AI_VIP_DAILY_MAX = parseInt(process.env['AI_VIP_DAILY_MAX'] ?? '20', 10);
export const AI_VIP_WEEKLY_MAX = parseInt(process.env['AI_VIP_WEEKLY_MAX'] ?? '140', 10);
export const AI_FREE_MAX = parseInt(process.env['AI_FREE_MAX'] ?? '3', 10);
/** VIP: 1 alternativa/día si un enlace «Anuncio encontrado» está caído */
export const AI_BROKEN_LINK_DAILY_MAX = parseInt(process.env['AI_BROKEN_LINK_DAILY_MAX'] ?? '1', 10);
/** VIP: 3 recuperaciones/día de anuncio perdido (ficha + link) */
export const AI_AD_RECOVERY_DAILY_MAX = parseInt(process.env['AI_AD_RECOVERY_DAILY_MAX'] ?? '3', 10);

export type TipoRecuperacionFicha = 'enlace_roto' | 'recuperacion';


/**
 * Resuelve zona/zonaNorm canónicas.
 * Si falta zonaNorm o el sufijo está mal, recupera desde zona (o título).
 */
function resolverZona(piso: Piso): { zona: string | null; zonaNorm: string | null } {
  const macro = recuperarMacroZona(piso.ciudad, piso.zona, piso.zonaNorm, piso.titulo);
  if (!macro) return { zona: null, zonaNorm: null };
  return { zona: macro, zonaNorm: normalizarZona(macro) };
}

async function upsertPiso(piso: Piso): Promise<'inserted' | 'updated' | 'skipped'> {
  const existing = await prisma.piso.findUnique({
    where: {
      id_piso_portal: {
        id_piso: piso.id,
        portal: piso.portal
      }
    }
  });

  // Filtro anti-basura: si las habitaciones son estrictamente nulas, rechazamos el piso.
  if (piso.habitaciones === null || piso.habitaciones === undefined) {
    if (existing) {
      // Si ya existía y ahora nos damos cuenta de que es basura, lo fulminamos.
      await prisma.piso.delete({
        where: { id_piso_portal: { id_piso: piso.id, portal: piso.portal } }
      });
    }
    return 'skipped';
  }

  const resolved = resolverZona(piso);
  // No borrar zona buena ya guardada si el scrape nuevo no pudo mapear.
  const zona =
    resolved.zona ??
    (existing ? recuperarMacroZona(piso.ciudad, (existing as any).zona, (existing as any).zonaNorm, piso.titulo) : null);
  const zonaNorm = zona ? normalizarZona(zona) : null;
  const resumen = piso.resumen ? piso.resumen.slice(0, 120) : null;

  const data = {
    titulo: piso.titulo,
    precio: piso.precio,
    enlace: piso.enlace,
    ciudad: piso.ciudad,
    zona,
    zonaNorm,
    habitaciones: piso.habitaciones ?? null,
    tipo: piso.tipo ?? null,
    resumen,
  };

  if (!existing) {
    await prisma.piso.create({
      data: {
        id_piso: piso.id,
        portal: piso.portal,
        publicado_en_telegram: false,
        ...data
      } as any
    });
    return 'inserted';
  }

  if (!(existing as any)?.publicado_en_telegram) {
    await prisma.piso.update({
      where: {
        id_piso_portal: {
          id_piso: piso.id,
          portal: piso.portal
        }
      },
      data
    });
    return 'updated';
  }

  return 'skipped';
}

export async function upsertPisos(pisos: Piso[]): Promise<{ inserted: number; updated: number; skipped: number }> {
  const stats = { inserted: 0, updated: 0, skipped: 0 };
  for (const piso of pisos) {
    const res = await upsertPiso(piso);
    stats[res]++;
  }
  return stats;
}

/**
 * Obtiene todos los pisos creados en los últimos N días
 */
export async function getPisosRecientes(dias: number = 3): Promise<any[]> {
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() - dias);

  const pisos = await prisma.piso.findMany({
    where: {
      created_at: { gte: fechaLimite }
    },
    orderBy: { created_at: 'desc' }
  });
  return pisos.map((p: any) => ({ ...p, id: p.id_piso }));
}

export async function haRecibidoPiso(
  telegramId: string,
  idPiso: string,
  portal: string
): Promise<boolean> {
  try {
    const record = await (prisma as any).notificacionEnviada.findUnique({
      where: {
        telegram_id_id_piso_portal: {
          telegram_id: telegramId,
          id_piso: idPiso,
          portal: portal
        }
      }
    });
    return !!record;
  } catch (e) {
    return false;
  }
}

export async function registrarNotificacionEnviada(
  telegramId: string,
  idPiso: string,
  portal: string
): Promise<boolean> {
  try {
    await (prisma as any).notificacionEnviada.create({
      data: {
        telegram_id: telegramId,
        id_piso: idPiso,
        portal: portal
      }
    });
    return true;
  } catch (e) {
    return false;
  }
}


/**
 * Obtiene todos los pisos que ya han sido publicados en Telegram
 * para comprobar si siguen vivos.
 */
export async function getPisosPublicados(): Promise<any[]> {
  const pisos = await prisma.piso.findMany({
    where: { publicado_en_telegram: true },
    orderBy: { created_at: 'desc' }
  });
  return pisos.map((p: any) => ({ ...p, id: p.id_piso }));
}

/**
 * Obtiene los pisos publicados en las últimas N horas
 */
export async function getPisosPublicadosRecientes(horas: number = 48): Promise<any[]> {
  const fechaLimite = new Date(Date.now() - horas * 60 * 60 * 1000);
  const pisos = await prisma.piso.findMany({
    where: { 
      publicado_en_telegram: true,
      created_at: { gte: fechaLimite }
    },
    orderBy: { created_at: 'desc' }
  });
  return pisos.map((p: any) => ({ ...p, id: p.id_piso }));
}

export async function marcarPisoComoPublicado(
  idPiso: string,
  portal: string,
  messageId?: number,
  chatId?: string
): Promise<boolean> {
  try {
    await prisma.piso.update({
      where: {
        id_piso_portal: {
          id_piso: idPiso,
          portal: portal
        }
      },
      data: {
        publicado_en_telegram: true,
        telegram_message_id: messageId ?? null,
        telegram_chat_id: chatId ?? null
      }
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function getEstadisticasPisos() {
  const total = await prisma.piso.count();
  const publicados = await prisma.piso.count({ where: { publicado_en_telegram: true } });
  const pendientes = await prisma.piso.count({ where: { publicado_en_telegram: false } });
  
  const agrupado = await prisma.piso.groupBy({
    by: ['portal'],
    _count: { portal: true }
  });
  
  const porPortal: Record<string, number> = {};
  agrupado.forEach((g: any) => {
    porPortal[g.portal] = g._count.portal;
  });

  return { total, publicados, pendientes, porPortal };
}

// ------------------------------------------------------------
// Inventario por zona (para menús VIP inventory-aware)
// ------------------------------------------------------------

/**
 * Zona efectiva para inventario/matching:
 * 1) zonaNorm si se puede recuperar/validar
 * 2) si no, columna zona (aunque falte Norm o el sufijo esté mal)
 * 3) si no, título del anuncio
 */
function resolverZonaEfectiva(
  ciudad: string,
  zona: string | null | undefined,
  zonaNorm: string | null | undefined,
  titulo?: string | null
): { zonaDisplay: string; zonaNorm: string } | null {
  const macro = recuperarMacroZona(ciudad, zona, zonaNorm, titulo);
  if (!macro) return null;
  return { zonaDisplay: macro, zonaNorm: normalizarZona(macro) };
}

/**
 * Recalcula InventoryStats usando zonaNorm O, si falta, la columna zona
 * (y título como último recurso). No descarta anuncios recuperables.
 * @param opts.backfillNorm — rellena zona/zonaNorm en BD (default true)
 */
export async function refreshInventoryStats(opts?: { backfillNorm?: boolean }): Promise<void> {
  const doBackfill = opts?.backfillNorm !== false;

  // Incluye filas con zona/zonaNorm O solo título (para remapeo).
  const pisos = await prisma.piso.findMany({
    select: {
      id_piso: true,
      portal: true,
      ciudad: true,
      zona: true,
      zonaNorm: true,
      titulo: true,
      precio: true,
      updated_at: true,
    },
  });

  type Agg = {
    ciudad: string;
    zonaNorm: string;
    zonaDisplay: string;
    count: number;
    minPrice: number | null;
    maxPrice: number | null;
    latestAt: number;
  };

  const agg = new Map<string, Agg>();
  const backfill: {
    id_piso: string;
    portal: string;
    zona: string;
    zonaNorm: string;
  }[] = [];
  let sinZona = 0;

  for (const p of pisos) {
    const resolved = resolverZonaEfectiva(p.ciudad, p.zona, p.zonaNorm, p.titulo);
    if (!resolved) {
      sinZona += 1;
      continue;
    }

    const ciudad = p.ciudad.toLowerCase();
    const key = `${ciudad}|${resolved.zonaNorm}`;
    const prev = agg.get(key);
    const precio = p.precio > 0 ? p.precio : null;
    const ts = p.updated_at?.getTime() ?? 0;

    if (!prev) {
      agg.set(key, {
        ciudad,
        zonaNorm: resolved.zonaNorm,
        zonaDisplay: resolved.zonaDisplay,
        count: 1,
        minPrice: precio,
        maxPrice: precio,
        latestAt: ts,
      });
    } else {
      prev.count += 1;
      if (precio != null) {
        prev.minPrice = prev.minPrice == null ? precio : Math.min(prev.minPrice, precio);
        prev.maxPrice = prev.maxPrice == null ? precio : Math.max(prev.maxPrice, precio);
      }
      if (ts >= prev.latestAt) {
        prev.latestAt = ts;
        prev.zonaDisplay = resolved.zonaDisplay;
      }
    }

    const actualNorm = (p.zonaNorm || '').trim();
    const actualZona = (p.zona || '').trim();
    if (actualNorm !== resolved.zonaNorm || actualZona !== resolved.zonaDisplay) {
      backfill.push({
        id_piso: p.id_piso,
        portal: p.portal,
        zona: resolved.zonaDisplay,
        zonaNorm: resolved.zonaNorm,
      });
    }
  }

  if (doBackfill && backfill.length > 0) {
    // Un pase grande: en VPS con ~8k pisos conviene cubrir todos.
    const MAX_BACKFILL = 12000;
    const lote = backfill.slice(0, MAX_BACKFILL);
    const CHUNK = 80;
    for (let i = 0; i < lote.length; i += CHUNK) {
      const slice = lote.slice(i, i + CHUNK);
      await Promise.all(
        slice.map((b) =>
          prisma.piso
            .update({
              where: { id_piso_portal: { id_piso: b.id_piso, portal: b.portal } },
              data: { zona: b.zona, zonaNorm: b.zonaNorm },
            })
            .catch(() => undefined)
        )
      );
    }
    logger.info(
      `🗺️ Inventory: backfill zona+zonaNorm ${lote.length}/${backfill.length} filas (desde zona/título)`
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.inventoryStats.deleteMany({});

    for (const g of agg.values()) {
      await tx.inventoryStats.create({
        data: {
          ciudad: g.ciudad,
          zona: g.zonaDisplay,
          zonaNorm: g.zonaNorm,
          count: g.count,
          minPrice: g.minPrice,
          maxPrice: g.maxPrice,
        },
      });
    }
  });

  logger.info(
    `📊 InventoryStats: ${agg.size} zonas · ${pisos.length - sinZona}/${pisos.length} pisos mapeados` +
      (sinZona ? ` · ${sinZona} sin zona recuperable` : '')
  );

  try {
    const { cacheDel } = await import('../services/redis.service');
    await cacheDel('inventory:zonas:v2:barcelona');
    await cacheDel('inventory:zonas:v2:madrid');
    await cacheDel('inventory:zonas:v2:valencia');
    // Legacy keys (pre-v2)
    await cacheDel('inventory:zonas:barcelona');
    await cacheDel('inventory:zonas:madrid');
    await cacheDel('inventory:zonas:valencia');
  } catch {
    /* Redis opcional */
  }
}

/**
 * Cuenta anuncios por macro-zona LEYENDO pisos.zona / zonaNorm / título
 * y mapeando con zonas-principales.json (no usa inventory_stats stale).
 */
async function contarZonasDesdePisos(
  ciudadKey: string
): Promise<Map<string, { zonaDisplay: string; count: number }>> {
  const rows = await prisma.piso.findMany({
    where: { ciudad: ciudadKey },
    select: { zona: true, zonaNorm: true, titulo: true },
  });

  const counts = new Map<string, { zonaDisplay: string; count: number }>();

  for (const p of rows) {
    const resolved = resolverZonaEfectiva(ciudadKey, p.zona, p.zonaNorm, p.titulo);
    if (!resolved) continue;

    const prev = counts.get(resolved.zonaNorm);
    if (prev) {
      prev.count += 1;
    } else {
      counts.set(resolved.zonaNorm, {
        zonaDisplay: resolved.zonaDisplay,
        count: 1,
      });
    }
  }

  return counts;
}

/**
 * Menú VIP de zonas: catálogo JSON + conteo en vivo desde columna zona
 * (y zonaNorm/título si hace falta). Cada alias del JSON cae en su macro.
 */
export type ZonaConStock = { zona: string; zonaNorm: string; count: number };

export type ZonasConStockResult = {
  zonas: ZonaConStock[];
  totalCiudad: number;
  sinClasificar: number;
};

export async function getZonasConStock(ciudad: string): Promise<ZonasConStockResult> {
  const ciudadKey = ciudad.toLowerCase();
  const key = `inventory:zonas:v2:${ciudadKey}`;
  const principales = listarZonasPrincipales(ciudadKey);

  if (principales.length === 0) {
    return { zonas: [], totalCiudad: 0, sinClasificar: 0 };
  }

  try {
    const { cacheGetJson } = await import('../services/redis.service');
    const cached = await cacheGetJson<ZonasConStockResult>(key);
    if (
      cached &&
      Array.isArray(cached.zonas) &&
      cached.zonas.length === principales.length &&
      typeof cached.totalCiudad === 'number'
    ) {
      return cached;
    }
  } catch {
    /* Redis opcional */
  }

  const live = await contarZonasDesdePisos(ciudadKey);

  // Compat: datos antiguos "vallecas (mad)" → Puente de Vallecas
  if (ciudadKey === 'madrid' && live.has('vallecas (mad)')) {
    const extra = live.get('vallecas (mad)')!;
    live.delete('vallecas (mad)');
    const puente = 'puente de vallecas (mad)';
    const prev = live.get(puente);
    if (prev) prev.count += extra.count;
    else live.set(puente, { zonaDisplay: 'Puente de Vallecas (MAD)', count: extra.count });
  }

  const merged = principales.map((p) => {
    const hit = live.get(p.zonaNorm);
    return {
      zona: p.zona,
      zonaNorm: p.zonaNorm,
      count: hit?.count ?? 0,
    };
  });

  merged.sort((a, b) => b.count - a.count || a.zona.localeCompare(b.zona, 'es'));

  const mapeados = merged.reduce((s, z) => s + z.count, 0);
  const totalCiudad = await prisma.piso.count({ where: { ciudad: ciudadKey } });
  const sinClasificar = Math.max(0, totalCiudad - mapeados);
  logger.info(
    `📍 Zonas menú ${ciudadKey}: ${mapeados}/${totalCiudad} en macros JSON · sin clasificar=${sinClasificar} · ${principales.length} zonas`
  );

  const result: ZonasConStockResult = {
    zonas: merged,
    totalCiudad,
    sinClasificar,
  };

  try {
    const { cacheSetJson } = await import('../services/redis.service');
    await cacheSetJson(key, result, 90);
  } catch {
    /* ignore */
  }

  return result;
}

// ------------------------------------------------------------
// Asesor IA — búsqueda de alternativas
// ------------------------------------------------------------

export interface FiltrosBusquedaPiso {
  ciudad?: string;
  zona?: string;
  precioMax?: number;
}

export interface PisoAlternativa {
  id: string;
  titulo: string;
  precio: number;
  zona: string | null;
  ciudad: string | null;
  habitaciones: number | null;
  tipo: string | null;
  resumen: string | null;
  enlace: string;
  portal: string;
}

/**
 * Busca 1 piso que coincida con los filtros y que NO se le haya
 * enviado ya a este usuario (digests VIP ni fichas del Asesor IA),
 * vía NotificacionEnviada.
 *
 * Zona: matching flexible (sin acentos, aliases, parcial → macro canónica).
 * Si la zona no resuelve o no hay stock en esa macro, amplía a ciudad+precio
 * (no bloquea por un typo / acento).
 */
export async function buscarPisoAlternativo(
  telegramId: string,
  filtros: FiltrosBusquedaPiso,
  excluirExtra: string[] = []
): Promise<PisoAlternativa | null> {
  const notificados = await prisma.notificacionEnviada.findMany({
    where: { telegram_id: telegramId },
    select: { id_piso: true },
  });
  const idsExcluidos = [
    ...new Set([...notificados.map((n) => n.id_piso), ...excluirExtra.filter(Boolean)]),
  ];

  const ciudadRaw = (filtros.ciudad || '').toLowerCase().trim();
  const zonaRaw = (filtros.zona || '').trim();
  const precioMax = filtros.precioMax;

  const approx = zonaRaw ? aproximarMacroZona(zonaRaw, ciudadRaw || null) : undefined;
  const ciudad = ciudadRaw || approx?.ciudad || undefined;
  const macro = approx?.macro;

  const baseWhere: Record<string, unknown> = {
    ...(ciudad ? { ciudad } : {}),
    ...(precioMax ? { precio: { lte: precioMax } } : {}),
    ...(idsExcluidos.length > 0 ? { id_piso: { notIn: idsExcluidos } } : {}),
  };

  const mapPiso = (piso: {
    id_piso: string;
    titulo: string;
    precio: number;
    zona: string | null;
    ciudad: string | null;
    habitaciones: number | null;
    tipo: string | null;
    resumen: string | null;
    enlace: string;
    portal: string;
  }): PisoAlternativa => ({
    id: piso.id_piso,
    titulo: piso.titulo,
    precio: piso.precio,
    zona: piso.zona,
    ciudad: piso.ciudad,
    habitaciones: piso.habitaciones,
    tipo: piso.tipo,
    resumen: piso.resumen,
    enlace: piso.enlace,
    portal: piso.portal,
  });

  // --- Intento 1: macro / zonaNorm resuelta ---
  if (macro || zonaRaw) {
    const zonaNormMacro = macro ? normalizarZona(macro) : undefined;
    const zonaNormInput = zonaRaw ? normalizarZona(zonaRaw) : undefined;
    const nombreCorto = macro
      ? normalizarZona(macro.replace(/\s*\((bcn|mad|vlc)\)\s*$/i, ''))
      : zonaNormInput;

    const orZona: object[] = [];
    if (macro) {
      orZona.push({ zona: { equals: macro, mode: 'insensitive' as const } });
    }
    if (zonaNormMacro) {
      orZona.push({ zonaNorm: zonaNormMacro });
      orZona.push({ zonaNorm: { contains: zonaNormMacro } });
    }
    if (nombreCorto && nombreCorto.length >= 3) {
      orZona.push({ zonaNorm: { contains: nombreCorto } });
    }
    if (zonaNormInput && zonaNormInput.length >= 3 && zonaNormInput !== nombreCorto) {
      orZona.push({ zonaNorm: { contains: zonaNormInput } });
    }

    if (orZona.length > 0) {
      const piso = await prisma.piso.findFirst({
        where: { ...baseWhere, OR: orZona },
        orderBy: { updated_at: 'desc' },
      });
      if (piso) return mapPiso(piso);
    }
  }

  // --- Intento 2: ciudad + precio (flexible; no bloquear por typo de zona) ---
  if (ciudad || precioMax) {
    const piso = await prisma.piso.findFirst({
      where: baseWhere,
      orderBy: { updated_at: 'desc' },
    });
    if (piso) return mapPiso(piso);
  }

  return null;
}

// ------------------------------------------------------------
// Cuotas de uso del Asesor IA
// ------------------------------------------------------------

function esMismoDia(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function esMismaSemana(a: Date, b: Date): boolean {
  const msPorDia = 24 * 60 * 60 * 1000;
  const diffDias = Math.floor(Math.abs(a.getTime() - b.getTime()) / msPorDia);
  return diffDias < 7;
}

export interface AiQuotaStatus {
  permitido: boolean;
  esVIP: boolean;
  restanteHoy: number;
  restanteSemana: number;
  freeRestante: number;
  motivo?: string;
}

/**
 * Comprueba si un usuario puede hacer una consulta al Asesor IA sin
 * consumir cuota todavía (solo lectura).
 */
export async function getAiQuotaStatus(telegramId: string): Promise<AiQuotaStatus> {
  const user = await prisma.usuarioVIP.findUnique({ where: { telegram_id: telegramId } });
  const ahora = new Date();

  if (!user) {
    return { permitido: false, esVIP: false, restanteHoy: 0, restanteSemana: 0, freeRestante: 0, motivo: 'Usuario no registrado' };
  }

  const esVIP = user.estado === 'Pagado' || user.estado === 'Cancelando';

  if (!esVIP) {
    const freeRestante = Math.max(0, AI_FREE_MAX - user.freeAiUsed);
    return {
      permitido: freeRestante > 0,
      esVIP: false,
      restanteHoy: 0,
      restanteSemana: 0,
      freeRestante,
      motivo: freeRestante > 0 ? undefined : 'Has agotado tus consultas gratuitas',
    };
  }

  const ultimaFecha = user.lastAiRequestDate;
  const dailyCount = ultimaFecha && esMismoDia(ultimaFecha, ahora) ? user.dailyAiRequests : 0;
  const weeklyCount = ultimaFecha && esMismaSemana(ultimaFecha, ahora) ? user.weeklyAiRequests : 0;

  const restanteHoy = Math.max(0, AI_VIP_DAILY_MAX - dailyCount);
  const restanteSemana = Math.max(0, AI_VIP_WEEKLY_MAX - weeklyCount);
  const permitido = restanteHoy > 0 && restanteSemana > 0;

  return {
    permitido,
    esVIP: true,
    restanteHoy,
    restanteSemana,
    freeRestante: 0,
    motivo: permitido ? undefined : (restanteHoy === 0 ? 'Límite diario alcanzado' : 'Límite semanal alcanzado'),
  };
}

/**
 * Incrementa el contador de uso del Asesor IA para un usuario (VIP o gratuito).
 * Reinicia los contadores diario/semanal automáticamente cuando corresponde.
 */
export async function incrementAiUsage(telegramId: string): Promise<void> {
  const user = await prisma.usuarioVIP.findUnique({ where: { telegram_id: telegramId } });
  if (!user) return;

  const esVIP = user.estado === 'Pagado' || user.estado === 'Cancelando';
  const ahora = new Date();

  if (!esVIP) {
    await prisma.usuarioVIP.update({
      where: { telegram_id: telegramId },
      data: { freeAiUsed: { increment: 1 } },
    });
    return;
  }

  const ultimaFecha = user.lastAiRequestDate;
  const dailyCount = ultimaFecha && esMismoDia(ultimaFecha, ahora) ? user.dailyAiRequests : 0;
  const weeklyCount = ultimaFecha && esMismaSemana(ultimaFecha, ahora) ? user.weeklyAiRequests : 0;

  await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data: {
      dailyAiRequests: dailyCount + 1,
      weeklyAiRequests: weeklyCount + 1,
      lastAiRequestDate: ahora,
    },
  });
}

/**
 * Día civil Europe/Madrid (reinicio de cupos de recuperación).
 */
function esMismoDiaMadrid(a: Date, b: Date): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(a) === fmt.format(b);
}

export interface RecoveryQuotaStatus {
  permitido: boolean;
  tipo: TipoRecuperacionFicha;
  usadoHoy: number;
  maxHoy: number;
  restanteHoy: number;
  motivo?: string;
}

/**
 * Cupo VIP para ficha+enlace: enlace roto (1/día) o recuperación perdida (3/día).
 */
export async function getRecoveryQuotaStatus(
  telegramId: string,
  tipo: TipoRecuperacionFicha
): Promise<RecoveryQuotaStatus> {
  const maxHoy = tipo === 'enlace_roto' ? AI_BROKEN_LINK_DAILY_MAX : AI_AD_RECOVERY_DAILY_MAX;
  const user = await prisma.usuarioVIP.findUnique({ where: { telegram_id: telegramId } });
  const ahora = new Date();

  if (!user) {
    return {
      permitido: false,
      tipo,
      usadoHoy: 0,
      maxHoy,
      restanteHoy: 0,
      motivo: 'Usuario no registrado',
    };
  }

  const esVIP = user.estado === 'Pagado' || user.estado === 'Cancelando';
  if (!esVIP) {
    return {
      permitido: false,
      tipo,
      usadoHoy: 0,
      maxHoy,
      restanteHoy: 0,
      motivo: 'Solo VIP',
    };
  }

  const ultima = user.lastRecoveryQuotaDate;
  const mismoDia = ultima != null && esMismoDiaMadrid(ultima, ahora);
  const usadoHoy = mismoDia
    ? tipo === 'enlace_roto'
      ? user.dailyBrokenLinkRecoveries
      : user.dailyAdRecoveries
    : 0;
  const restanteHoy = Math.max(0, maxHoy - usadoHoy);

  return {
    permitido: restanteHoy > 0,
    tipo,
    usadoHoy,
    maxHoy,
    restanteHoy,
    motivo:
      restanteHoy > 0
        ? undefined
        : tipo === 'enlace_roto'
          ? `Ya usaste tu ${maxHoy} alternativa por enlace roto de hoy. Se reinicia mañana.`
          : `Has alcanzado el máximo de ${maxHoy} recuperaciones con enlace de hoy. Se reinicia mañana.`,
  };
}

/**
 * Consume 1 cupo de recuperación VIP (enlace roto o anuncio perdido).
 */
export async function incrementRecoveryUsage(
  telegramId: string,
  tipo: TipoRecuperacionFicha
): Promise<void> {
  const user = await prisma.usuarioVIP.findUnique({ where: { telegram_id: telegramId } });
  if (!user) return;

  const esVIP = user.estado === 'Pagado' || user.estado === 'Cancelando';
  if (!esVIP) return;

  const ahora = new Date();
  const ultima = user.lastRecoveryQuotaDate;
  const mismoDia = ultima != null && esMismoDiaMadrid(ultima, ahora);

  const broken = mismoDia ? user.dailyBrokenLinkRecoveries : 0;
  const ads = mismoDia ? user.dailyAdRecoveries : 0;

  await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data: {
      dailyBrokenLinkRecoveries: tipo === 'enlace_roto' ? broken + 1 : broken,
      dailyAdRecoveries: tipo === 'recuperacion' ? ads + 1 : ads,
      lastRecoveryQuotaDate: ahora,
    },
  });
}

export async function logScraperEjecucion(params: {
  portal: string;
  ciudad: string;
  url: string;
  pisosEncontrados: number;
  pisosNuevos: number;
  error?: string;
  duracionMs?: number;
}): Promise<void> {
  await prisma.scraperLog.create({
    data: {
      portal: params.portal,
      ciudad: params.ciudad,
      url: params.url,
      pisos_encontrados: params.pisosEncontrados,
      pisos_nuevos: params.pisosNuevos,
      error: params.error ?? null,
      duracion_ms: params.duracionMs ?? null,
    }
  });
}

// Vip Users functions

/** VIP con acceso real: Pagado, o Cancelando con cancel_at aún futuro (o null). */
export async function contarUsuariosVip(): Promise<number> {
  try {
    const now = new Date();
    const count = await prisma.usuarioVIP.count({
      where: {
        OR: [
          { estado: 'Pagado' },
          {
            estado: 'Cancelando',
            OR: [{ cancel_at: null }, { cancel_at: { gt: now } }],
          },
        ],
      },
    });
    return count;
  } catch (error) {
    logger.error('Error al contar usuarios VIP:', error);
    return 0;
  }
}

export async function getUsuarioPorTelegramId(telegramId: string) {
  return prisma.usuarioVIP.findUnique({ where: { telegram_id: telegramId } });
}

export async function actualizarEstadoUsuarioPorTelegramId(
  telegramId: string,
  estado: EstadoUsuario,
  email?: string,
  stripeCustomerId?: string
) {
  try {
    await prisma.usuarioVIP.update({
      where: { telegram_id: telegramId },
      data: {
        estado,
        ...(email && { email }),
        ...(stripeCustomerId && { stripe_customer_id: stripeCustomerId }),
      }
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function actualizarEstadoUsuarioPorCustomerId(
  customerId: string,
  estado: EstadoUsuario
) {
  try {
    return await prisma.usuarioVIP.update({
      where: { stripe_customer_id: customerId },
      data: { estado }
    });
  } catch (e) {
    return null;
  }
}

export async function getUsuarioPorCustomerId(customerId: string) {
  return prisma.usuarioVIP.findUnique({ where: { stripe_customer_id: customerId } });
}

export async function programarCancelacionUsuarioPorCustomerId(
  customerId: string,
  cancelAt: string
) {
  try {
    return await prisma.usuarioVIP.update({
      where: { stripe_customer_id: customerId },
      data: {
        estado: 'Cancelando',
        cancel_at: new Date(cancelAt)
      }
    });
  } catch (e) {
    return null;
  }
}

export async function reactivarUsuarioPorCustomerId(customerId: string) {
  try {
    return await prisma.usuarioVIP.update({
      where: { stripe_customer_id: customerId },
      data: {
        estado: 'Pagado',
        cancel_at: null
      }
    });
  } catch (e) {
    return null;
  }
}

export async function actualizarFiltrosUsuario(telegramId: string, filtros: any) {
  try {
    return await prisma.usuarioVIP.update({
      where: { telegram_id: telegramId },
      data: {
        filtro_ciudad: filtros.ciudad !== undefined ? filtros.ciudad : undefined,
        filtro_zonas: filtros.zonas !== undefined ? filtros.zonas : undefined,
        filtro_precio_max: filtros.precioMax !== undefined ? filtros.precioMax : undefined,
        filtro_tipo: filtros.tipo !== undefined ? filtros.tipo : undefined,
        filtro_habitaciones: filtros.habitaciones !== undefined ? filtros.habitaciones : undefined,
      } as any
    });
  } catch (error) {
    logger.error('Error al actualizar filtros:', error);
    return null;
  }
}

export async function getUsuariosActivos() {
  return prisma.usuarioVIP.findMany({
    where: {
      estado: {
        in: ['Pagado', 'Cancelando']
      }
    }
  });
}

export async function getPisosParaBorrarTelegram(diasInactivo: number) {
  const limite = new Date();
  limite.setDate(limite.getDate() - diasInactivo);
  
  return prisma.piso.findMany({
    where: {
      telegram_message_id: { not: null },
      telegram_chat_id: { not: null },
      updated_at: { lt: limite }
    }
  });
}

export async function getPisosParaBorrarTelegramPublico(diasInactivo: number): Promise<any[]> {
  const limite = new Date();
  limite.setDate(limite.getDate() - diasInactivo);
  
  return prisma.piso.findMany({
    where: {
      telegram_public_message_id: { not: null },
      fecha_publicacion_publica: { lt: limite }
    } as any
  });
}

export async function marcarMensajeTelegramBorrado(id_piso: string) {
  await prisma.piso.updateMany({
    where: { id_piso },
    data: { telegram_message_id: null }
  });
}

export async function marcarMensajeTelegramPublicoBorrado(id_piso: string) {
  await prisma.piso.updateMany({
    where: { id_piso },
    data: { telegram_public_message_id: null } as any
  });
}

export async function eliminarPisosBD(diasInactivo: number) {
  const limite = new Date();
  limite.setDate(limite.getDate() - diasInactivo);
  
  const res = await prisma.piso.deleteMany({
    where: { updated_at: { lt: limite } }
  });
  return res.count;
}

export async function getUsuariosExpiradosParaBorrar() {
  return prisma.usuarioVIP.findMany({
    where: {
      estado: 'Cancelando',
      cancel_at: { lte: new Date() }
    }
  });
}

/**
 * Usuarios ya en Cancelado cuyo cancel_at pasó hace ≥N horas
 * y aún tienen PII/filtros (no han soft-purgeado).
 */
export async function getUsuariosParaPrivacyPurge(horas: number = 48) {
  const limite = new Date(Date.now() - horas * 60 * 60 * 1000);
  return prisma.usuarioVIP.findMany({
    where: {
      estado: 'Cancelado',
      cancel_at: { lte: limite },
      OR: [
        { email: { not: null } },
        { stripe_customer_id: { not: null } },
        { filtro_ciudad: { not: null } },
        { filtro_precio_max: { not: null } },
        { filtro_tipo: { not: null } },
        { filtro_habitaciones: { not: null } },
        { NOT: { filtro_zonas: { equals: [] } } },
      ],
    },
  });
}

export async function registrarUsuario(telegramId: string): Promise<'nuevo' | 'existente'> {
  const existing = await prisma.usuarioVIP.findUnique({ where: { telegram_id: telegramId } });
  if (existing) return 'existente';
  
  await prisma.usuarioVIP.create({
    data: {
      telegram_id: telegramId,
      estado: 'Pendiente_Pago'
    }
  });
  return 'nuevo';
}

/**
 * Elimina un piso específico de la base de datos (Ej: por no estar disponible).
 */
export async function eliminarPiso(id_piso: string, portal: string) {
  try {
    await prisma.piso.delete({ 
      where: { 
        id_piso_portal: { id_piso, portal } 
      } 
    });
    return true;
  } catch (error) {
    logger.error(`❌ Error eliminando piso ${id_piso} de ${portal}:`, { error });
    return false;
  }
}

/**
 * Borrado "suave" de cuenta (RGPD): limpia datos personales, filtros,
 * horario de alertas y vínculos de Stripe, pero MANTIENE la fila
 * `UsuarioVIP` (`telegram_id` + `freeAiUsed`) para que las pruebas
 * gratuitas del Asesor IA no se reinicien si el usuario vuelve.
 * También borra su historial de `NotificacionEnviada` y limpia
 * claves Redis de digests/warmup.
 */
export async function eliminarCuentaUsuario(telegramId: string): Promise<boolean> {
  try {
    await prisma.notificacionEnviada.deleteMany({
      where: { telegram_id: telegramId }
    });

    await prisma.usuarioVIP.update({
      where: { telegram_id: telegramId },
      data: {
        email: null,
        stripe_customer_id: null,
        estado: 'Pendiente_Pago',
        cancel_at: null,
        filtro_ciudad: null,
        filtro_zonas: [],
        filtro_precio_max: null,
        filtro_tipo: null,
        filtro_habitaciones: null,
        // /horario → defaults de producto (L–D · 08–21 · cada 2 h)
        digest_days: [1, 2, 3, 4, 5, 6, 7],
        digest_start_hour: 8,
        digest_end_hour: 21,
        digest_interval_h: 2,
        dailyAiRequests: 0,
        weeklyAiRequests: 0,
        lastAiRequestDate: null,
        dailyBrokenLinkRecoveries: 0,
        dailyAdRecoveries: 0,
        lastRecoveryQuotaDate: null,
        // freeAiUsed se conserva a propósito
      }
    });

    // Redis: prefs cache, cadencia, warmup, cuota, cooldown
    try {
      const { invalidateDigestPrefsCache } = await import('../services/digest-schedule.service');
      const { clearDigestStateOnAccountPurge } = await import('../services/redis.service');
      await invalidateDigestPrefsCache(telegramId);
      await clearDigestStateOnAccountPurge(telegramId);
    } catch (redisErr) {
      logger.warn('Soft-purge: no se pudo limpiar Redis digests', { error: redisErr });
    }

    return true;
  } catch (e) {
    logger.error('Error al eliminar cuenta de usuario (soft-purge):', e);
    return false;
  }
}

// ------------------------------------------------------------
// Funciones Canal Público
// ------------------------------------------------------------

export async function getPisosParaCanalPublico(diasRetraso: number = 3, limite: number = 5): Promise<any[]> {
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() - diasRetraso);

  const pisos = await prisma.piso.findMany({
    where: { 
      publicado_en_canal_publico: false,
      created_at: { lte: fechaLimite }
    } as any,
    orderBy: { created_at: 'asc' }, // Publicamos los más antiguos elegibles
    take: limite
  });
  return pisos.map((p: any) => ({ ...p, id: p.id_piso }));
}

export async function marcarPisoComoPublicadoPublico(
  idPiso: string,
  portal: string,
  messageId: number
): Promise<boolean> {
  try {
    await prisma.piso.update({
      where: {
        id_piso_portal: {
          id_piso: idPiso,
          portal: portal
        }
      },
      data: {
        publicado_en_canal_publico: true,
        telegram_public_message_id: messageId,
        fecha_publicacion_publica: new Date()
      } as any
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function getCountPublicacionesSemanalesPublico(): Promise<number> {
  const hace7Dias = new Date();
  hace7Dias.setDate(hace7Dias.getDate() - 7);

  return prisma.piso.count({
    where: {
      publicado_en_canal_publico: true,
      fecha_publicacion_publica: { gte: hace7Dias }
    } as any
  });
}

export async function haPublicadoHoyEnCanalPublico(): Promise<boolean> {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  try {
    const count = await prisma.piso.count({
      where: {
        publicado_en_canal_publico: true,
        fecha_publicacion_publica: { gte: hoy }
      } as any
    });
    return count > 0;
  } catch (error) {
    return true; // En caso de error asumimos true para no spamear
  }
}

export async function marcarPisoPublicadoCanalPublico(idPiso: string, portal: string, messageId: number) {
  try {
    await prisma.piso.update({
      where: { id_piso_portal: { id_piso: idPiso, portal: portal } },
      data: {
        publicado_en_canal_publico: true,
        fecha_publicacion_publica: new Date(),
        telegram_public_message_id: messageId
      } as any
    });
  } catch (error) {
    logger.error('Error al marcar en canal publico', error);
  }
}
