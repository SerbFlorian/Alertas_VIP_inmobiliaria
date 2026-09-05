/**
 * Backfill one-shot: rellena zona + zonaNorm (desde zona/título) y refresca InventoryStats.
 *
 * Uso:
 *   npm run backfill:zonas
 *   # prod Docker:
 *   docker compose exec alertas-vip npm run backfill:zonas:prod
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { refreshInventoryStats } from '../db/queries';
import { logger } from '../services/logger';

async function main(): Promise<void> {
  logger.info('🗺️ Backfill zonas: recuperando macros desde zona/zonaNorm/título…');
  await refreshInventoryStats({ backfillNorm: true });

  const [total, conNorm, conZona, stats, porCiudad] = await Promise.all([
    prisma.piso.count(),
    prisma.piso.count({ where: { zonaNorm: { not: null } } }),
    prisma.piso.count({ where: { zona: { not: null } } }),
    prisma.inventoryStats.aggregate({ _sum: { count: true }, _count: true }),
    prisma.inventoryStats.groupBy({
      by: ['ciudad'],
      _sum: { count: true },
      orderBy: { ciudad: 'asc' },
    }),
  ]);

  const cobertura = porCiudad
    .map((g) => `${g.ciudad}=${g._sum.count ?? 0}`)
    .join(' · ');

  logger.info(
    `✅ Backfill OK · total=${total} · con zona=${conZona} · con zonaNorm=${conNorm} · ` +
      `InventoryStats filas=${stats._count} · suma counts=${stats._sum.count ?? 0} · ${cobertura}`
  );

  // Cobertura por ciudad vs total real (diagnóstico del menú VIP)
  for (const ciudad of ['madrid', 'barcelona', 'valencia'] as const) {
    const totalC = await prisma.piso.count({ where: { ciudad } });
    const mapeados =
      (await prisma.inventoryStats.aggregate({
        where: { ciudad },
        _sum: { count: true },
      }))._sum.count ?? 0;
    const pct = totalC > 0 ? Math.round((mapeados / totalC) * 100) : 0;
    logger.info(
      `📍 ${ciudad}: menú=${mapeados}/${totalC} mapeados (${pct}%) · sin macro≈${Math.max(0, totalC - mapeados)}`
    );
  }
}

main()
  .catch((err) => {
    logger.error('Backfill zonas falló', { err });
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
