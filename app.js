import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openDb } from './db.js';
import {
  createRateLimiter, createPasswordVerifier, createSessionStore, parseCookies, SECURITY_HEADERS,
} from './security.js';
import { COURSES, STATUSES, validateRegistration, validateUpdate } from './validate.js';

const MAX_BODY = 16 * 1024;
const COOKIE = 'albus_admin';
const DUPLICATE_WINDOW_MS = 24 * 3600_000;
const UB_OFFSET_MS = 8 * 3600_000; // Asia/Ulaanbaatar, DST байхгүй

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

/* ---------- жижиг туслах функцууд ---------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!type.toLowerCase().startsWith('application/json')) {
      req.resume();
      return reject(new HttpError(415, 'Content-Type нь application/json байх ёстой.'));
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return; // үлдсэнийг хаяж, хариуг хэвийн илгээнэ
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Хүсэлт хэт том байна.', { headers: { Connection: 'close' } }));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'JSON буруу байна.')); }
    });
    req.on('error', reject);
  });
}

function startOfTodayUlaanbaatarIso(now = Date.now()) {
  const local = now + UB_OFFSET_MS;
  return new Date(local - (local % 86_400_000) - UB_OFFSET_MS).toISOString();
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Excel формула injection-оос хамгаална
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATUS_LABEL = { new: 'Шинэ', contacted: 'Холбогдсон', enrolled: 'Элссэн', cancelled: 'Цуцалсан' };

function publicRow(r) {
  const { ip, user_agent, ...rest } = r;
  return rest;
}

/* ---------- Telegram мэдэгдэл (заавал биш) ---------- */

async function notifyTelegram(cfg, reg, log) {
  if (!cfg) return;
  const text = [
    '🆕 Albus — шинэ бүртгэл',
    `👤 ${reg.name}`,
    `📞 ${reg.phone}`,
    `📚 ${reg.course}`,
    reg.message ? `💬 ${reg.message}` : null,
  ].filter(Boolean).join('\n');
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) log.warn(`Telegram мэдэгдэл амжилтгүй: HTTP ${r.status}`);
  } catch (err) {
    log.warn(`Telegram мэдэгдэл амжилтгүй: ${err.message}`);
  }
}

/* ---------- app ---------- */

export function createApp(config, { log = console } = {}) {
  const db = openDb(config.dbFile);
  const verifyPassword = createPasswordVerifier(config.adminPassword);
  const sessions = createSessionStore(config.sessionTtlMs);
  const registerLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 8 });
  const publicDir = path.resolve(config.publicDir);

  const clientIp = (req) => {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const isAdmin = (req) => sessions.valid(parseCookies(req.headers.cookie)[COOKIE]);

  const requireAdmin = (req) => {
    if (!isAdmin(req)) throw new HttpError(401, 'Нэвтрэх шаардлагатай.');
  };

  /** Өөр домэйноос ирсэн өөрчлөх хүсэлтийг (CSRF) хаана. */
  const checkOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Буруу Origin.'); }
    const expected = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    if (host !== expected) throw new HttpError(403, 'Буруу Origin.');
  };

  const sessionCookie = (token, maxAgeSec) =>
    [
      `${COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`,
      config.secureCookie ? 'Secure' : null,
    ].filter(Boolean).join('; ');

  const parseId = (s) => {
    const id = Number(s);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'Олдсонгүй.');
    return id;
  };

  /* ---- маршрутууд ---- */
  const routes = [
    ['GET', /^\/api\/health$/, (req, res) => send(res, 200, { ok: true })],

    ['GET', /^\/api\/courses$/, (req, res) => send(res, 200, { courses: COURSES })],

    ['POST', /^\/api\/registrations$/, async (req, res) => {
      checkOrigin(req);
      const ip = clientIp(req);
      const body = await readJson(req);

      // Honeypot: хүн харахгүй талбар. Bot бөглөвөл амжилттай мэт хариулаад хадгалахгүй.
      if (body && typeof body.website === 'string' && body.website.trim() !== '') {
        return send(res, 201, { ok: true });
      }

      const limit = registerLimiter.check(ip);
      if (!limit.allowed) {
        throw new HttpError(429, 'Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.',
          { headers: { 'Retry-After': String(limit.retryAfter) } });
      }

      const v = validateRegistration(body);
      if (!v.ok) return send(res, 422, { ok: false, error: 'Мэдээллээ шалгана уу.', fields: v.errors });

      const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
      if (db.findRecentDuplicate(v.value.phone, v.value.course, since)) {
        return send(res, 200, { ok: true, duplicate: true });
      }

      const row = db.create(v.value, { ip, userAgent: req.headers['user-agent'] });
      log.info(`[бүртгэл] #${row.id} ${row.course}`);
      notifyTelegram(config.telegram, row, log); // хариуг хүлээлгэхгүй
      return send(res, 201, { ok: true, id: row.id });
    }],

    ['POST', /^\/api\/admin\/login$/, async (req, res) => {
      checkOrigin(req);
      const ip = clientIp(req);
      const limit = loginLimiter.check(ip);
      if (!limit.allowed) {
        throw new HttpError(429, 'Олон удаа буруу оролдлоо. Түр хүлээнэ үү.',
          { headers: { 'Retry-After': String(limit.retryAfter) } });
      }
      const { password } = await readJson(req);
      if (!verifyPassword(password)) {
        log.warn(`[admin] буруу нууц үг (${ip})`);
        throw new HttpError(401, 'Нууц үг буруу байна.');
      }
      loginLimiter.reset(ip);
      const token = sessions.create();
      send(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(token, Math.floor(config.sessionTtlMs / 1000)),
      });
    }],

    ['POST', /^\/api\/admin\/logout$/, (req, res) => {
      checkOrigin(req);
      sessions.destroy(parseCookies(req.headers.cookie)[COOKIE]);
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }],

    ['GET', /^\/api\/admin\/me$/, (req, res) => send(res, 200, { authenticated: isAdmin(req) })],

    ['GET', /^\/api\/admin\/stats$/, (req, res) => {
      requireAdmin(req);
      send(res, 200, db.stats(startOfTodayUlaanbaatarIso()));
    }],

    ['GET', /^\/api\/admin\/registrations$/, (req, res, _m, url) => {
      requireAdmin(req);
      const p = url.searchParams;
      const status = STATUSES.includes(p.get('status')) ? p.get('status') : undefined;
      const course = COURSES.includes(p.get('course')) ? p.get('course') : undefined;
      const q = (p.get('q') || '').trim().slice(0, 100) || undefined;
      const limit = Math.min(Math.max(Number(p.get('limit')) || 50, 1), 500);
      const offset = Math.max(Number(p.get('offset')) || 0, 0);
      const { total, rows } = db.list({ status, course, q, limit, offset });
      send(res, 200, { total, limit, offset, rows: rows.map(publicRow) });
    }],

    ['PATCH', /^\/api\/admin\/registrations\/(\d+)$/, async (req, res, m) => {
      checkOrigin(req);
      requireAdmin(req);
      const id = parseId(m[1]);
      const v = validateUpdate(await readJson(req));
      if (!v.ok) throw new HttpError(422, v.error);
      const row = db.update(id, v.value);
      if (!row) throw new HttpError(404, 'Олдсонгүй.');
      send(res, 200, { ok: true, row: publicRow(row) });
    }],

    ['DELETE', /^\/api\/admin\/registrations\/(\d+)$/, (req, res, m) => {
      checkOrigin(req);
      requireAdmin(req);
      if (!db.remove(parseId(m[1]))) throw new HttpError(404, 'Олдсонгүй.');
      send(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/admin\/export\.csv$/, (req, res) => {
      requireAdmin(req);
      const { rows } = db.list({ limit: 1_000_000 });
      const header = ['ID', 'Огноо (UTC)', 'Нэр', 'Утас', 'Сургалт', 'Нэмэлт мэдээлэл', 'Төлөв', 'Тэмдэглэл'];
      const lines = [header, ...rows.map((r) => [
        r.id, r.created_at, r.name, r.phone, r.course, r.message, STATUS_LABEL[r.status], r.admin_note,
      ])].map((cols) => cols.map(csvCell).join(','));
      const date = new Date(Date.now() + UB_OFFSET_MS).toISOString().slice(0, 10);
      send(res, 200, '﻿' + lines.join('\r\n'), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="albus-burtgel-${date}.csv"`,
      });
    }],
  ];

  /* ---- статик файл ---- */
  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel = decodeURIComponent(pathname);
    if (rel === '/' ) rel = '/index.html';
    else if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';

    const file = path.resolve(publicDir, '.' + rel);
    if (!file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'Олдсонгүй.');

    let stat;
    try { stat = await fs.promises.stat(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      const notFound = path.join(publicDir, '404.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.existsSync(notFound) ? fs.createReadStream(notFound).pipe(res) : res.end('404');
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'Last-Modified': stat.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  /* ---- үндсэн handler ---- */
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (config.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, { ok: false, error: 'Bad request' }); }

    try {
      if (url.pathname.startsWith('/api/')) {
        const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
        if (!route) {
          const exists = routes.some(([, re]) => re.test(url.pathname));
          throw new HttpError(exists ? 405 : 404, exists ? 'Method not allowed' : 'Олдсонгүй.');
        }
        await route[2](req, res, url.pathname.match(route[1]), url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) {
        return send(res, err.status, { ok: false, error: err.message }, err.extra?.headers);
      }
      if (err instanceof URIError) return send(res, 400, { ok: false, error: 'Bad request' });
      log.error('[алдаа]', err);
      send(res, 500, { ok: false, error: 'Серверийн алдаа гарлаа.' });
    }
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = 20_000;

  return {
    server,
    db,
    close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}
