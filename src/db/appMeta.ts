import { prisma } from './prisma';
import { logger } from '../services/logger';

let tableReady = false;

/** Crea app_meta si aún no existe (BD previa sin migraciones / migrate fallido). */
export async function ensureAppMetaTable(): Promise<void> {
  if (tableReady) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "app_meta" (
        "key" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "app_meta_pkey" PRIMARY KEY ("key")
      );
    `);
    tableReady = true;
  } catch (error) {
    logger.warn('⚠️ ensureAppMetaTable falló', { error });
  }
}

export async function getAppMeta(key: string): Promise<string | null> {
  await ensureAppMetaTable();
  try {
    const row = await prisma.appMeta.findUnique({ where: { key } });
    return row?.value ?? null;
  } catch (error) {
    logger.warn(`⚠️ getAppMeta(${key})`, { error });
    return null;
  }
}

export async function setAppMeta(key: string, value: string): Promise<void> {
  await ensureAppMetaTable();
  try {
    await prisma.appMeta.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  } catch (error) {
    logger.warn(`⚠️ setAppMeta(${key})`, { error });
  }
}

export async function deleteAppMeta(key: string): Promise<void> {
  await ensureAppMetaTable();
  try {
    await prisma.appMeta.delete({ where: { key } }).catch(() => undefined);
  } catch (error) {
    logger.warn(`⚠️ deleteAppMeta(${key})`, { error });
  }
}
