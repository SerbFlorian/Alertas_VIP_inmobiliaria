/**
 * Restore DESTRUCTIVO desde Cloudflare R2.
 *
 * Requiere: CONFIRM_RESTORE=YES
 * Opcional: BACKUP_KEY=pg-dumps/backup-….sql.gz (si no, usa el más reciente)
 *
 * Uso:
 *   CONFIRM_RESTORE=YES npm run restore:latest
 *   docker compose exec -e CONFIRM_RESTORE=YES alertas-vip npm run restore:latest
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { logger } from '../services/logger';
import {
  isR2Configured,
  listBackupKeys,
  downloadBackupFromR2,
} from '../services/r2.service';
import { pgConnectionUrl } from './backup';
import { notifyAdminCritical } from '../utils/adminNotify';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  if (process.env['CONFIRM_RESTORE'] !== 'YES') {
    throw new Error('Abortado: define CONFIRM_RESTORE=YES para continuar (destructivo).');
  }
  if (!isR2Configured()) {
    throw new Error('R2 no configurado');
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL no configurada');

  let key = process.env['BACKUP_KEY'];
  if (!key) {
    const list = await listBackupKeys();
    if (list.length === 0) throw new Error('No hay dumps en R2 bajo pg-dumps/');
    key = list[0]!.key;
  }

  logger.info(`☁️ Descargando R2: ${key}`);
  const gz = await downloadBackupFromR2(key);

  const tmpDir = path.resolve(process.cwd(), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const gzPath = path.join(tmpDir, 'restore.sql.gz');
  const sqlPath = path.join(tmpDir, 'restore.sql');
  fs.writeFileSync(gzPath, gz);

  logger.info('🗜️ Descomprimiendo…');
  await pipeline(createReadStream(gzPath), zlib.createGunzip(), createWriteStream(sqlPath));

  const url = pgConnectionUrl(databaseUrl);

  logger.info('🗄️ Limpiando schema public CASCADE…');
  await execFileAsync(
    'psql',
    [url, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'],
    { maxBuffer: 16 * 1024 * 1024 }
  );

  logger.info('🗄️ Aplicando dump con psql…');
  await execFileAsync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], {
    maxBuffer: 64 * 1024 * 1024,
  });

  logger.info(`✅ Restore completo desde ${key}`);

  for (const f of [gzPath, sqlPath]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error('❌ Restore falló', { error: msg });
  await notifyAdminCritical('Fallo restore R2', msg);
  process.exit(1);
});
