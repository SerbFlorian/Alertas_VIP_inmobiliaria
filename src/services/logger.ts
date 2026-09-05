import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { redactSecrets } from '../utils/secrets';

const logsDir = process.env['LOG_DIR'] || path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = redactSecrets(info.message);
  }
  try {
    const meta = { ...info } as Record<string, unknown>;
    delete meta['level'];
    delete meta['message'];
    delete meta['timestamp'];
    delete meta['service'];
    const raw = JSON.stringify(meta);
    const safe = redactSecrets(raw);
    if (safe !== raw) {
      Object.assign(info, JSON.parse(safe));
    }
  } catch {
    /* ignore */
  }
  return info;
});

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: 'alertas-vip' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service: _s, ...meta }) => {
          const extra = Object.keys(meta).length > 0 ? ` ${redactSecrets(JSON.stringify(meta))}` : '';
          return `${timestamp} [${level}] ${message}${extra}`;
        }),
      ),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5_000_000,
      maxFiles: 3,
      format: winston.format.json(),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10_000_000,
      maxFiles: 5,
      format: winston.format.json(),
    }),
  ],
});
