import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { normalizePhone } from '../src/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password-123';
const silent = { info() {}, warn() {}, error() {} };

let app, base;

before(async () => {
  app = createApp({
    publicDir: path.join(root, 'public'),
    dbFile: ':memory:',
    adminPassword: PASSWORD,
    trustProxy: true,
    secureCookie: false,
    sessionTtlMs: 3600_000,
    telegram: null,
  }, { log: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.close());

let ipCounter = 0;
const json = (method, url, body, headers = {}) =>
  fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.0.0.${++ipCounter}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function login() {
  const res = await json('POST', '/api/admin/login', { password: PASSWORD });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return cookie.split(';')[0];
}

describe('validation', () => {
  test('утасны дугаар normalize', () => {
    assert.equal(normalizePhone('9560 6825'), '95606825');
    assert.equal(normalizePhone('+976 9959-2940'), '99592940');
    assert.equal(normalizePhone('97695606825'), '95606825');
    assert.equal(normalizePhone('1234'), null);
    assert.equal(normalizePhone('abcdefgh'), null);
  });
});

describe('нийтийн API', () => {
  test('бүртгэл амжилттай хадгалагдана (SAT орно)', async () => {
    const res = await json('POST', '/api/registrations', {
      name: '  Бат   Эрдэнэ ', phone: '+976 8811 2233', course: 'SAT', message: 'Оройн анги',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id > 0);
    const row = app.db.get(body.id);
    assert.equal(row.name, 'Бат Эрдэнэ');
    assert.equal(row.phone, '88112233');
    assert.equal(row.status, 'new');
  });

  test('24 цагийн дотор давхардсан бүртгэл үүсэхгүй', async () => {
    const payload = { name: 'Сараа', phone: '99112233', course: 'IELTS' };
    const a = await json('POST', '/api/registrations', payload);
    const b = await json('POST', '/api/registrations', payload);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal((await b.json()).duplicate, true);
    assert.equal(app.db.list({ q: '99112233' }).total, 1);
  });

  test('буруу өгөгдөл → 422, талбар бүрийн алдаатай', async () => {
    const res = await json('POST', '/api/registrations', { name: 'A', phone: '12', course: 'Франц хэл' });
    assert.equal(res.status, 422);
    const { fields } = await res.json();
    assert.ok(fields.name && fields.phone && fields.course);
  });

  test('honeypot бөглөсөн bot хадгалагдахгүй', async () => {
    const before = app.db.list().total;
    const res = await json('POST', '/api/registrations', {
      name: 'Bot', phone: '99887766', course: 'IELTS', website: 'http://spam',
    });
    assert.equal(res.status, 201);
    assert.equal(app.db.list().total, before);
  });

  test('rate limit: нэг IP-ээс 10 минутад 5-аас олон хүсэлт → 429', async () => {
    const ip = { 'X-Forwarded-For': '203.0.113.9' };
    let last;
    for (let i = 0; i < 6; i++) {
      last = await json('POST', '/api/registrations',
        { name: 'Тест', phone: `9900000${i}`, course: 'Орос хэл' }, ip);
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  });

  test('JSON биш content-type → 415, том body → 413', async () => {
    const a = await fetch(base + '/api/registrations', { method: 'POST', body: 'name=x' });
    assert.equal(a.status, 415);
    const b = await json('POST', '/api/registrations', { name: 'x'.repeat(20_000) });
    assert.equal(b.status, 413);
  });

  test('өөр домэйноос (CSRF) → 403', async () => {
    const res = await json('POST', '/api/registrations',
      { name: 'Хакер', phone: '99001122', course: 'IELTS' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });

  test('сургалтын жагсаалт SAT-тай', async () => {
    const { courses } = await (await fetch(base + '/api/courses')).json();
    assert.ok(courses.includes('SAT'));
    assert.equal(courses.length, 7);
  });
});

describe('админ API', () => {
  test('нэвтрээгүй бол 401', async () => {
    assert.equal((await fetch(base + '/api/admin/registrations')).status, 401);
    assert.equal((await fetch(base + '/api/admin/export.csv')).status, 401);
  });

  test('буруу нууц үг → 401', async () => {
    const res = await json('POST', '/api/admin/login', { password: 'wrong' });
    assert.equal(res.status, 401);
  });

  test('жагсаалт, шүүлт, төлөв/тэмдэглэл өөрчлөх, устгах', async () => {
    const cookie = await login();
    const auth = { Cookie: cookie };

    const created = await (await json('POST', '/api/registrations',
      { name: 'Номин', phone: '95001122', course: 'Солонгос хэл' })).json();

    const list = await (await fetch(base + '/api/admin/registrations?course=' +
      encodeURIComponent('Солонгос хэл'), { headers: auth })).json();
    assert.ok(list.rows.some((r) => r.id === created.id));
    assert.ok(!('ip' in list.rows[0]), 'IP хаяг гадагш гарах ёсгүй');

    const patched = await json('PATCH', `/api/admin/registrations/${created.id}`,
      { status: 'contacted', admin_note: 'Даваа гарагт ирнэ' }, auth);
    assert.equal(patched.status, 200);
    const { row } = await patched.json();
    assert.equal(row.status, 'contacted');
    assert.equal(row.admin_note, 'Даваа гарагт ирнэ');

    const bad = await json('PATCH', `/api/admin/registrations/${created.id}`, { status: 'hacked' }, auth);
    assert.equal(bad.status, 422);

    const search = await (await fetch(base + '/api/admin/registrations?q=' +
      encodeURIComponent('Даваа'), { headers: auth })).json();
    assert.equal(search.total, 1);

    const stats = await (await fetch(base + '/api/admin/stats', { headers: auth })).json();
    assert.ok(stats.total >= 1 && stats.byStatus.contacted >= 1 && stats.today >= 1);

    const del = await json('DELETE', `/api/admin/registrations/${created.id}`, undefined, auth);
    assert.equal(del.status, 200);
    assert.equal(app.db.get(created.id), null);
  });

  test('CSV экспорт: BOM, формула injection хамгаалалт', async () => {
    const cookie = await login();
    await json('POST', '/api/registrations',
      { name: '=HYPERLINK("x")', phone: '96001122', course: 'Хятад хэл', message: 'a, "b"' });
    const res = await fetch(base + '/api/admin/export.csv', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /albus-burtgel-\d{4}-\d{2}-\d{2}\.csv/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = buf.toString('utf8');
    assert.ok(text.includes(`"'=HYPERLINK(""x"")"`));
    assert.ok(text.includes('"a, ""b"""'));
  });

  test('гарсны дараа session хүчингүй', async () => {
    const cookie = await login();
    await json('POST', '/api/admin/logout', {}, { Cookie: cookie });
    const res = await fetch(base + '/api/admin/stats', { headers: { Cookie: cookie } });
    assert.equal(res.status, 401);
  });
});

describe('статик файл', () => {
  test('нүүр, админ, хамгаалалтын header-ууд', async () => {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    const html = await home.text();
    assert.ok(html.includes('data-course="SAT"'));
    assert.ok(!/<script>(?!<\/script>)/.test(html), 'inline script байх ёсгүй (CSP)');

    assert.equal((await fetch(base + '/admin')).status, 200);
    assert.equal((await fetch(base + '/js/main.js')).status, 200);
  });

  test('path traversal хаагдана, 404 хуудас', async () => {
    const a = await fetch(base + '/..%2fpackage.json');
    assert.equal(a.status, 404);
    const b = await fetch(base + '/%2e%2e/src/app.js');
    assert.equal(b.status, 404);
    assert.equal((await fetch(base + '/nope')).status, 404);
  });
});
