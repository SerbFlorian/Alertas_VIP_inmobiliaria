/**
 * Job: enriquecer zonaNorm null vía Nominatim (OSM) — 0€.
 * Ver src/scripts/enrich-zonas-nominatim.ts para CLI / env.
 */
import { prisma } from '../db/prisma';
import { refreshInventoryStats } from '../db/queries';
import { logger } from '../services/logger';
import { withRedisLock } from '../services/redis.service';
import { normalizarZona, recuperarMacroZona } from '../utils/normalizer';
import { extraerCoords, resolverMacroConNominatim } from '../utils/nominatim';

export type EnrichZonasStats = {
  scanned: number;
  offline: number;
  nominatim: number;
  skipped: number;
  failed: number;
  updated: number;
};

function batchSize(): number {
  const n = parseInt(process.env['ENRICH_ZONAS_BATCH'] || '150', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 150;
}

function enabled(): boolean {
  return process.env['ENRICH_ZONAS_ENABLED'] !== 'false';
}

export async function ejecutarEnrichZonasNominatimJob(): Promise<EnrichZonasStats> {
  const stats: EnrichZonasStats = {
    scanned: 0,
    offline: 0,
    nominatim: 0,
    skipped: 0,
    failed: 0,
    updated: 0,
  };

  if (!enabled()) {
    logger.info('⏭️  Enrich zonas Nominatim desactivado (ENRICH_ZONAS_ENABLED=false)');
    return stats;
  }

  const take = batchSize();
  const lock = await withRedisLock('lock:enrich:zonas-nominatim', 30 * 60 * 1000, async () => {
    const rows = await prisma.piso.findMany({
      where: { zonaNorm: null },
      take,
      orderBy: [{ updated_at: 'asc' }],
      select: {
        id_piso: true,
        portal: true,
        ciudad: true,
        zona: true,
        titulo: true,
        enlace: true,
        resumen: true,
      },
    });

    if (rows.length === 0) {
      logger.info('🗺️ Enrich zonas: cola vacía (zonaNorm null = 0)');
      return stats;
    }

    logger.info(`🗺️ Enrich zonas Nominatim: lote=${rows.length} (batch max ${take})`);

    for (const p of rows) {
      stats.scanned++;

      const offline = recuperarMacroZona(p.ciudad, p.zona, null, p.titulo);
      if (offline) {
        await prisma.piso.update({
          where: { id_piso_portal: { id_piso: p.id_piso, portal: p.portal } },
          data: { zona: offline, zonaNorm: normalizarZona(offline) },
        });
        stats.offline++;
        stats.updated++;
        continue;
      }

      const coords = extraerCoords(p.enlace, p.zona, p.titulo, p.resumen);
      const tieneSenal =
        !!coords ||
        (!!p.zona && !/discover/i.test(p.zona) && p.zona.trim().length >= 5) ||
        (!!p.titulo && p.titulo.trim().length >= 8);

      if (!tieneSenal) {
        stats.skipped++;
        await touchRow(p.id_piso, p.portal);
        continue;
      }

      try {
        const { macro, via } = await resolverMacroConNominatim({
          ciudad: p.ciudad,
          zona: p.zona,
          titulo: p.titulo,
          enlace: p.enlace,
          resumen: p.resumen,
        });

        if (macro) {
          await prisma.piso.update({
            where: { id_piso_portal: { id_piso: p.id_piso, portal: p.portal } },
            data: { zona: macro, zonaNorm: normalizarZona(macro) },
          });
          stats.nominatim++;
          stats.updated++;
          logger.debug(`   ✓ ${p.id_piso} via=${via} → ${macro}`);
        } else {
          stats.failed++;
          await touchRow(p.id_piso, p.portal);
        }
      } catch (err) {
        stats.failed++;
        logger.warn('Enrich zona falló en fila', { id_piso: p.id_piso, err });
      }
    }

    logger.info(
      `🗺️ Enrich zonas OK · scanned=${stats.scanned} · offline=${stats.offline} · ` +
        `nominatim=${stats.nominatim} · skipped=${stats.skipped} · failed=${stats.failed}`
    );

    if (stats.updated > 0 && process.env['ENRICH_ZONAS_REFRESH_STATS'] !== 'false') {
      await refreshInventoryStats({ backfillNorm: false });
      logger.info('📍 InventoryStats refrescado tras enrich zonas');
    }

    return stats;
  });

  if (!lock.ran) {
    logger.warn('⏭️  Enrich zonas: lock ocupado, otro proceso en curso');
  }

  return lock.result ?? stats;
}

async function touchRow(id_piso: string, portal: string): Promise<void> {
  await prisma.piso.update({
    where: { id_piso_portal: { id_piso, portal } },
    data: { updated_at: new Date() },
  });
}
