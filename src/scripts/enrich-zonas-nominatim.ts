/**
 * CLI: enrich zonas vía Nominatim.
 *
 *   npm run enrich:zonas
 *   ENRICH_ZONAS_LOOP=true npm run enrich:zonas
 *   docker compose exec alertas-vip npm run enrich:zonas:prod
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { ejecutarEnrichZonasNominatimJob } from '../jobs/enrich-zonas.job';
import { logger } from '../services/logger';
import { initRedis, closeRedis } from '../services/redis.service';

async function main(): Promise<void> {
  await initRedis();
  const loop = process.env['ENRICH_ZONAS_LOOP'] === 'true';
  let rounds = 0;
  do {
    const s = await ejecutarEnrichZonasNominatimJob();
    rounds++;
    if (!loop) break;
    if (s.scanned === 0) {
      logger.info('🗺️ Enrich loop: cola vacía, paro');
      break;
    }
    if (rounds >= 50) {
      logger.info('🗺️ Enrich loop: tope 50 lotes, paro (re-ejecuta después)');
      break;
    }
  } while (loop);
}

main()
  .catch((err) => {
    logger.error('Enrich zonas Nominatim falló', { err });
    process.exit(1);
  })
  .finally(async () => {
    await closeRedis();
    await prisma.$disconnect();
  });
