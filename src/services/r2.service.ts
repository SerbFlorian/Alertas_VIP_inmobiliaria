import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { logger } from './logger';

// ============================================================
// Cloudflare R2 (API compatible S3) — backups offsite
// ============================================================

const PREFIX = 'pg-dumps/';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno ${name} para R2`);
  return v;
}

export function isR2Configured(): boolean {
  return Boolean(
    process.env['R2_ACCOUNT_ID'] &&
      process.env['R2_ACCESS_KEY_ID'] &&
      process.env['R2_SECRET_ACCESS_KEY'] &&
      process.env['R2_BUCKET']
  );
}

function getClient(): S3Client {
  const accountId = requireEnv('R2_ACCOUNT_ID');
  const endpoint =
    process.env['R2_ENDPOINT'] ?? `https://${accountId}.r2.cloudflarestorage.com`;

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
}

function bucket(): string {
  return requireEnv('R2_BUCKET');
}

export async function uploadBackupToR2(
  key: string,
  body: Buffer,
  contentType = 'application/gzip'
): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  logger.info(`☁️ Subido a R2: ${key} (${(body.length / 1024 / 1024).toFixed(2)} MB)`);
}

export async function listBackupKeys(): Promise<{ key: string; lastModified?: Date; size?: number }[]> {
  const client = getClient();
  const out: { key: string; lastModified?: Date; size?: number }[] = [];
  let token: string | undefined;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: PREFIX,
        ContinuationToken: token,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) {
        out.push({
          key: obj.Key,
          lastModified: obj.LastModified,
          size: obj.Size,
        });
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return out.sort((a, b) => {
    const ta = a.lastModified?.getTime() ?? 0;
    const tb = b.lastModified?.getTime() ?? 0;
    return tb - ta;
  });
}

export async function downloadBackupFromR2(key: string): Promise<Buffer> {
  const client = getClient();
  const res = await client.send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
    })
  );
  if (!res.Body) throw new Error(`R2 object vacío: ${key}`);

  const stream = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function pruneOldBackups(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const keys = await listBackupKeys();
  const client = getClient();
  let deleted = 0;

  for (const item of keys) {
    const t = item.lastModified?.getTime() ?? 0;
    if (t > 0 && t < cutoff) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket(),
          Key: item.key,
        })
      );
      deleted++;
      logger.info(`🧹 R2 prune: ${item.key}`);
    }
  }
  return deleted;
}

export function buildBackupKey(date = new Date()): string {
  const iso = date.toISOString().replace(/[:.]/g, '-');
  return `${PREFIX}backup-${iso}.sql.gz`;
}

export { PREFIX as R2_BACKUP_PREFIX };
