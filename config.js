import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** .env файлыг гадны сангүйгээр уншина (process.env-д байгааг дарж бичихгүй). */
export async function loadDotEnv(file = path.join(ROOT, '.env')) {
  const fs = await import('node:fs');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let adminPassword = env.ADMIN_PASSWORD || '';
  let generatedPassword = false;

  if (!adminPassword) {
    if (production) {
      throw new Error('ADMIN_PASSWORD орчны хувьсагч заавал тохируулагдсан байх ёстой (production).');
    }
    adminPassword = crypto.randomBytes(9).toString('base64url');
    generatedPassword = true;
  }
  if (production && adminPassword.length < 10) {
    throw new Error('ADMIN_PASSWORD хамгийн багадаа 10 тэмдэгт байх ёстой.');
  }

  return {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    dbFile: env.DB_PATH || path.join(ROOT, 'data', 'albus.db'),
    adminPassword,
    generatedPassword,
    production,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    secureCookie: env.SECURE_COOKIE ? env.SECURE_COOKIE === '1' : production,
    sessionTtlMs: (Number(env.SESSION_HOURS) || 12) * 3600_000,
    telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
      : null,
  };
}
