import 'dotenv/config';
import cron from 'node-cron';
import express from 'express';
import { prisma } from './db/prisma';
import { ejecutarScraperJobRound1, ejecutarScraperJobRound2, shouldRunScrapers } from './jobs/scraper.job';
import { ejecutarNotifierJob, procesarWarmupsDue } from './jobs/notifier.job';
import { iniciarBot, detenerBot } from './bot/telegram.bot';
import { crearStripeRouter } from './webhooks/stripe.webhook';
import { ejecutarCleanupJob } from './jobs/cleanup.job';
import { ejecutarAvailabilityJob } from './jobs/availability.job';
import { ejecutarPublicChannelJob } from './jobs/public_channel.job';
import { ejecutarPrivacyPurgeJob } from './jobs/privacy-purge.job';
import { ejecutarBackupR2 } from './scripts/backup';
import { ejecutarEnrichZonasNominatimJob } from './jobs/enrich-zonas.job';
import { initRedis, closeRedis } from './services/redis.service';
import { installRedactedConsole } from './utils/redactConsole';
import { logger } from './services/logger';

// ============================================================
// ENTRY POINT — APP_ROLE / WORKER_MODE = app | scraper | all
// ============================================================

installRedactedConsole();

type AppRole = 'app' | 'scraper' | 'all';

const rawRole = (process.env['APP_ROLE'] ?? process.env['WORKER_MODE'] ?? 'all').toLowerCase();
const APP_ROLE = (['app', 'scraper', 'all'].includes(rawRole) ? rawRole : 'all') as AppRole;
const isApp = APP_ROLE === 'app' || APP_ROLE === 'all';
const isScraper = APP_ROLE === 'scraper' || APP_ROLE === 'all';

let scraperRunning = false;
let notifierRunning = false;

async function main(): Promise<void> {
  logger.info('');
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║   🏠  Alertas VIP Telegram Bot           ║');
  logger.info('╚══════════════════════════════════════════╝');
  logger.info(`   APP_ROLE=${APP_ROLE}`);
  logger.info('');

  await prisma.$connect();
  await initRedis();

  const app = express();
  const port = parseInt(process.env['PORT'] ?? '3001', 10);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (isApp) {
    app.use('/webhook/stripe', crearStripeRouter());
  }

  // Superficie HTTP mínima: todo lo demás → 404
  app.use((_req, res) => {
    res.status(404).end();
  });

  app.listen(port, () => {
    logger.info(
      `🌐 Express :${port} (role=${APP_ROLE}) · solo /health` + (isApp ? ' + /webhook/stripe' : '')
    );
  });

  if (isApp) {
    try {
      iniciarBot().catch((error) => {
        logger.error('❌ Error asíncrono en bot de Telegram:', { error });
      });
    } catch (error) {
      logger.error('❌ Error iniciando bot de Telegram:', { error });
    }
    scheduleAppJobs();
  }

  if (isScraper) {
    scheduleScraperJobs();
  }

  if (isScraper && shouldRunScrapers()) {
    logger.info('🚀 Scraping inicial (ROUND_1)...');
    scraperRunning = true;
    try {
      await ejecutarScraperJobRound1();
    } catch (error) {
      logger.error('❌ Error scraper inicial ROUND_1:', { error });
    } finally {
      scraperRunning = false;
    }
  } else if (isScraper) {
    logger.info('⏭️  Fuera de horario scraper (L-V 08-20).');
  }

  if (isApp) {
    notifierRunning = true;
    try {
      await ejecutarNotifierJob();
    } catch (error) {
      logger.error('❌ Error notifier inicial:', { error });
    } finally {
      notifierRunning = false;
    }
  }

  logger.info('✅ Sistema activo. Esperando cron jobs...');
}

function scheduleScraperJobs(): void {
  logger.info('⏰ Scraper ROUND_1: cada 2h 08-20 L-V');
  logger.info('⏰ Scraper ROUND_2: cada 4h 08-20 L-V');

  cron.schedule('0 8-20/2 * * 1-5', async () => {
    if (!shouldRunScrapers()) return;
    if (scraperRunning) {
      logger.warn('⏭️  Scraper anterior aún en ejecución. Saltando ROUND_1.');
      return;
    }
    scraperRunning = true;
    try {
      await ejecutarScraperJobRound1();
    } catch (error) {
      logger.error('❌ Error scraper ROUND_1:', { error });
    } finally {
      scraperRunning = false;
    }
  });

  cron.schedule('0 8-20/4 * * 1-5', async () => {
    if (!shouldRunScrapers()) return;
    if (scraperRunning) {
      logger.warn('⏭️  Scraper anterior aún en ejecución. Saltando ROUND_2.');
      return;
    }
    scraperRunning = true;
    try {
      await ejecutarScraperJobRound2();
    } catch (error) {
      logger.error('❌ Error scraper ROUND_2:', { error });
    } finally {
      scraperRunning = false;
    }
  });
}

function scheduleAppJobs(): void {
  const notifierInterval = process.env['NOTIFIER_INTERVAL_MINUTES'] ?? '120';
  const tickMins = Math.min(
    5,
    Math.max(1, parseInt(process.env['NOTIFIER_TICK_MINUTES'] ?? '5', 10))
  );
  // Hard floor 07–22 inclusivo en cron (hora fin exclusiva 23 → cron 7-22)
  const hardStart = parseInt(process.env['NOTIF_HARD_START_HOUR'] ?? '7', 10);
  const hardEndExcl = parseInt(process.env['NOTIF_HARD_END_HOUR'] ?? '23', 10);
  const hardEndCron = Math.max(hardStart, hardEndExcl - 1);
  const DIGEST_HOURS = `${hardStart}-${hardEndCron}`;
  const notifierCronExpr = `*/${tickMins} ${DIGEST_HOURS} * * *`;

  logger.info(
    `⏰ Notifier digests: tick cada ${tickMins} min · cadencia/usuario via /horario (seed=${notifierInterval} min) · hard floor ${hardStart}–${hardEndExcl} (${notifierCronExpr})`
  );

  cron.schedule(notifierCronExpr, async () => {
    if (notifierRunning) {
      logger.warn('⏭️  Notifier anterior aún en ejecución. Saltando.');
      return;
    }
    notifierRunning = true;
    try {
      await ejecutarNotifierJob();
    } catch (error) {
      logger.error('❌ Error notifier:', { error });
    } finally {
      notifierRunning = false;
    }
  });

  // Warmup: primer digest 5–15 min tras Aplicar (respeta hard floor + /horario por VIP)
  cron.schedule('* * * * *', async () => {
    try {
      await procesarWarmupsDue();
    } catch (error) {
      logger.error('❌ Error warmup digests:', { error });
    }
  });
  logger.info(
    `⏰ Digest warmup: cada 1 min (cola Redis; hard floor ${hardStart}–${hardEndExcl} + /horario VIP)`
  );

  cron.schedule('0 2 * * *', async () => {
    try {
      await ejecutarCleanupJob();
    } catch (error) {
      logger.error('❌ Error cleanup:', { error });
    }
  });
  logger.info('⏰ Cleanup diario: 02:00');

  const purgeH = process.env['PRIVACY_PURGE_HOURS'] ?? process.env['DATA_PURGE_HOURS'] ?? '48';
  cron.schedule('30 2 * * *', async () => {
    try {
      await ejecutarPrivacyPurgeJob();
    } catch (error) {
      logger.error('❌ Error privacy purge:', { error });
    }
  });
  logger.info(`⏰ Privacy purge: 02:30 (≥${purgeH}h post-cancel)`);

  cron.schedule('0 4 * * *', async () => {
    try {
      await ejecutarAvailabilityJob();
    } catch (error) {
      logger.error('❌ Error availability:', { error });
    }
  });
  logger.info('⏰ Availability: 04:00');

  cron.schedule('0 10 * * *', async () => {
    try {
      await ejecutarPublicChannelJob();
    } catch (error) {
      logger.error('❌ Error canal público:', { error });
    }
  });
  logger.info('⏰ Canal público: 10:00');

  cron.schedule('0 6 * * *', async () => {
    try {
      await ejecutarBackupR2();
    } catch (error) {
      logger.error('❌ Error backup R2:', { error });
    }
  });
  logger.info('⏰ Backup R2: 06:00');

  // Nominatim (OSM): rellena zonaNorm null por lotes — 0€, ~1 req/s
  cron.schedule('30 */2 * * *', async () => {
    try {
      await ejecutarEnrichZonasNominatimJob();
    } catch (error) {
      logger.error('❌ Error enrich zonas Nominatim:', { error });
    }
  });
  logger.info('⏰ Enrich zonas Nominatim: cada 2h (minuto 30)');
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`⛔ ${signal}. Apagando…`);
  if (isApp) await detenerBot();
  await closeRedis();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error('💥 Error no capturado:', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('💥 Promise rechazada sin manejar:', { reason });
});

main().catch((error) => {
  const errObj = error instanceof Error ? { message: error.message, stack: error.stack } : { error };
  logger.error('💥 Error fatal en main():', errObj);
  process.exit(1);
});
