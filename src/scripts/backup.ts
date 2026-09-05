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
  uploadBackupToR2,
  pruneOldBackups,
  buildBackupKey,
} from '../services/r2.service';
import { notifyAdminCritical } from '../utils/adminNotify';

const execFileAsync = promisify(execFile);

/** Quita ?schema=… de DATABASE_URL para pg_dump/psql */
export function pgConnectionUrl(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    u.search = '';
    return u.toString();
  } catch {
    return databaseUrl.replace(/\?.*$/, '');
  }
}

/**
 * Backup diario: pg_dump → gzip → Cloudflare R2.
 * Éxito → solo logs. Fallo → CRITICAL al admin por Telegram (texto redactado).
 * NUNCA se envía el archivo .sql/.sql.gz por Telegram.
 */
export async function ejecutarBackupR2(): Promise<{ key: string; bytes: number }> {
  if (!isR2Configured()) {
    throw new Error(
      'R2 no configurado. Define R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET'
    );
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL no configurada');

  const retention = parseInt(process.env['BACKUP_RETENTION_DAYS'] ?? '7', 10);
  const tmpBase = process.env['TMPDIR'] || '/tmp';
  const tmpDir = path.join(tmpBase, 'alertas-vip-backups');
  fs.mkdirSync(tmpDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sqlPath = path.join(tmpDir, `backup-${stamp}.sql`);
  const gzPath = `${sqlPath}.gz`;
  const key = buildBackupKey();

  try {
    logger.info('📦 pg_dump → SQL…');
    const url = pgConnectionUrl(databaseUrl);
    // --clean --if-exists facilita restores posteriores
    await execFileAsync(
      'pg_dump',
      ['--clean', '--if-exists', '--no-owner', '--no-acl', url, '-f', sqlPath],
      { maxBuffer: 64 * 1024 * 1024 }
    );

    if (!fs.existsSync(sqlPath) || fs.statSync(sqlPath).size === 0) {
      throw new Error('pg_dump generó un archivo vacío o inexistente');
    }

    logger.info('🗜️ Comprimiendo gzip…');
    await pipeline(createReadStream(sqlPath), zlib.createGzip({ level: 9 }), createWriteStream(gzPath));

    const body = fs.readFileSync(gzPath);
    await uploadBackupToR2(key, body);

    const pruned = await pruneOldBackups(retention);
    if (pruned > 0) logger.info(`🧹 Eliminados ${pruned} dumps antiguos (> ${retention} días)`);

    logger.info(`✅ Backup en R2: ${key}`);
    return { key, bytes: body.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('❌ Backup R2 falló', { error: msg });
    await notifyAdminCritical('Fallo backup R2', msg);
    throw error;
  } finally {
    for (const f of [sqlPath, gzPath]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

if (require.main === module) {
  import('dotenv/config').then(() =>
    ejecutarBackupR2()
      .then((r) => {
        console.log(`✅ Backup on R2: ${r.key} (${(r.bytes / 1024 / 1024).toFixed(2)} MB)`);
        process.exit(0);
      })
      .catch((err) => {
        console.error(err);
        process.exit(1);
      })
  );
}
