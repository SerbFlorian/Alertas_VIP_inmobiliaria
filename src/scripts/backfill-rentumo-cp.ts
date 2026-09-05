/**
 * Backfill Rentumo: zona desde código postal (sin reabrir URLs / Bright Data).
 *
 * - Extrae CP de zona / título / enlace / resumen
 * - Si mapea → zona + zonaNorm canónicos
 * - Si no → limpia basura (calles) dejando zona/zonaNorm null
 * - Refresca InventoryStats + invalida caché de menú
 *
 * Uso:
 *   npm run backfill:rentumo-cp
 *   docker compose exec alertas-vip npm run backfill:rentumo-cp:prod
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { refreshInventoryStats } from '../db/queries';
import { logger } from '../services/logger';
import { normalizarZona, esZonaBasuraOCalle } from '../utils/normalizer';
import { mapearAMacroZona } from '../utils/zonas-diccionario';
import { recuperarMacroDesdeCodigoPostal } from '../utils/codigos-postales';

const BATCH = 200;

async function main(): Promise<void> {
  logger.info('📮 Backfill Rentumo CP→zona…');

  const totalRentumo = await prisma.piso.count({ where: { portal: 'rentumo' } });
  logger.info(`   Filas portal=rentumo: ${totalRentumo}`);

  let offset = 0;
  let scanned = 0;
  let mapped = 0;
  let cleared = 0;
  let unchanged = 0;

  for (;;) {
    const rows = await prisma.piso.findMany({
      where: { portal: 'rentumo' },
      take: BATCH,
      skip: offset,
      orderBy: [{ id_piso: 'asc' }],
      select: {
        id_piso: true,
        portal: true,
        ciudad: true,
        zona: true,
        zonaNorm: true,
        titulo: true,
        enlace: true,
        resumen: true,
      },
    });

    if (rows.length === 0) break;
    offset += rows.length;

    const updates: {
      id_piso: string;
      portal: string;
      zona: string | null;
      zonaNorm: string | null;
    }[] = [];

    for (const p of rows) {
      scanned++;
      const desdeBarrio =
        mapearAMacroZona(p.zona || '', p.ciudad) ||
        mapearAMacroZona(p.titulo || '', p.ciudad) ||
        null;

      const desdeCp = recuperarMacroDesdeCodigoPostal(
        p.ciudad,
        p.zona,
        p.titulo,
        p.enlace,
        p.resumen
      );

      const macro = desdeBarrio || desdeCp || null;
      const nextZona = macro;
      const nextNorm = macro ? normalizarZona(macro) : null;

      const curZona = p.zona ?? null;
      const curNorm = p.zonaNorm ?? null;

      if (nextZona === curZona && nextNorm === curNorm) {
        if (!macro && curZona && esZonaBasuraOCalle(curZona)) {
          updates.push({
            id_piso: p.id_piso,
            portal: p.portal,
            zona: null,
            zonaNorm: null,
          });
          cleared++;
        } else {
          unchanged++;
        }
        continue;
      }

      if (macro) {
        updates.push({
          id_piso: p.id_piso,
          portal: p.portal,
          zona: nextZona,
          zonaNorm: nextNorm,
        });
        mapped++;
      } else if (curZona || curNorm) {
        updates.push({
          id_piso: p.id_piso,
          portal: p.portal,
          zona: null,
          zonaNorm: null,
        });
        cleared++;
      } else {
        unchanged++;
      }
    }

    for (let i = 0; i < updates.length; i += 50) {
      const chunk = updates.slice(i, i + 50);
      await prisma.$transaction(
        chunk.map((u) =>
          prisma.piso.update({
            where: {
              id_piso_portal: { id_piso: u.id_piso, portal: u.portal },
            },
            data: { zona: u.zona, zonaNorm: u.zonaNorm },
          })
        )
      );
    }

    logger.info(
      `   Progreso: scanned=${scanned}/${totalRentumo} · updates=${updates.length}`
    );
  }

  logger.info(
    `📮 Rentumo CP done · scanned=${scanned} · mapped=${mapped} · cleared=${cleared} · unchanged=${unchanged}`
  );

  await refreshInventoryStats({ backfillNorm: true });
  logger.info('✅ InventoryStats refreshed tras backfill Rentumo');
}

main()
  .catch((err) => {
    logger.error('Backfill Rentumo CP falló', { err });
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
