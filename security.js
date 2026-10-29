import crypto from 'node:crypto';

/** Санах ойд суурилсан fixed-window rate limiter. Нэг сервер дээр бүрэн хангалттай. */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  return {
    check(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        entry = { count: 0, reset: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count <= max
        ? { allowed: true }
        : { allowed: false, retryAfter: Math.ceil((entry.reset - now) / 1000) };
    },
    reset(key) { hits.delete(key); },
  };
}

/** Нууц үгийг санах ойд plain text-ээр биш, scrypt hash-аар хадгалж тогтмол хугацаанд харьцуулна. */
export function createPasswordVerifier(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return (candidate) => {
    if (typeof candidate !== 'string' || candidate.length > 200) return false;
    const test = crypto.scryptSync(candidate, salt, 32);
    return crypto.timingSafeEqual(hash, test);
  };
}

/** Серверийн талын session. Cookie-д зөвхөн санамсаргүй token л явна. */
export function createSessionStore(ttlMs) {
  const sessions = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (s.expires <= now) sessions.delete(t);
  }, 10 * 60_000);
  timer.unref();

  return {
    create() {
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { expires: Date.now() + ttlMs });
      return token;
    },
    valid(token) {
      if (!token) return false;
      const s = sessions.get(token);
      if (!s) return false;
      if (s.expires <= Date.now()) { sessions.delete(token); return false; }
      s.expires = Date.now() + ttlMs; // sliding expiration
      return true;
    },
    destroy(token) { sessions.delete(token); },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* буруу cookie-г алгасна */ }
    }
  }
  return out;
}

export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
