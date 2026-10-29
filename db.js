import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Схемийн хувилбарууд. Шинэ өөрчлөлтийг доор нь нэмж бичнэ — хуучныг хэзээ ч засахгүй.
 * PRAGMA user_version-оор аль хүртэл ажилласныг хянана.
 */
const MIGRATIONS = [
  `CREATE TABLE registrations (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     name        TEXT NOT NULL,
     phone       TEXT NOT NULL,
     course      TEXT NOT NULL,
     message     TEXT NOT NULL DEFAULT '',
     status      TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','contacted','enrolled','cancelled')),
     admin_note  TEXT NOT NULL DEFAULT '',
     ip          TEXT,
     user_agent  TEXT,
     created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX idx_reg_created ON registrations (created_at DESC);
   CREATE INDEX idx_reg_dupe    ON registrations (phone, course, created_at);
   CREATE INDEX idx_reg_status  ON registrations (status);`,
];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  migrate(db);

  const stmt = {
    insert: db.prepare(
      `INSERT INTO registrations (name, phone, course, message, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`),
    dupe: db.prepare(
      `SELECT id FROM registrations
       WHERE phone = ? AND course = ? AND created_at >= ? AND status != 'cancelled'
       LIMIT 1`),
    get: db.prepare('SELECT * FROM registrations WHERE id = ?'),
    remove: db.prepare('DELETE FROM registrations WHERE id = ?'),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM registrations GROUP BY status'),
    today: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE created_at >= ?'),
  };

  return {
    raw: db,

    create({ name, phone, course, message }, { ip, userAgent }) {
      return stmt.insert.get(name, phone, course, message, ip ?? null, (userAgent ?? '').slice(0, 300));
    },

    findRecentDuplicate(phone, course, sinceIso) {
      return stmt.dupe.get(phone, course, sinceIso) ?? null;
    },

    get(id) {
      return stmt.get.get(id) ?? null;
    },

    list({ status, course, q, limit = 200, offset = 0 } = {}) {
      const where = [];
      const params = [];
      if (status) { where.push('status = ?'); params.push(status); }
      if (course) { where.push('course = ?'); params.push(course); }
      if (q) {
        where.push(`(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
                     OR message LIKE ? ESCAPE '\\' OR admin_note LIKE ? ESCAPE '\\')`);
        const like = `%${likeEscape(q)}%`;
        params.push(like, like, like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM registrations ${clause}`).get(...params).n;
      const rows = db
        .prepare(`SELECT * FROM registrations ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
      return { total, rows };
    },

    update(id, patch) {
      const sets = [];
      const params = [];
      for (const key of ['status', 'admin_note']) {
        if (patch[key] !== undefined) { sets.push(`${key} = ?`); params.push(patch[key]); }
      }
      if (!sets.length) return this.get(id);
      sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      return db
        .prepare(`UPDATE registrations SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
        .get(...params, id) ?? null;
    },

    remove(id) {
      return stmt.remove.run(id).changes > 0;
    },

    stats(todayStartIso) {
      const byStatus = { new: 0, contacted: 0, enrolled: 0, cancelled: 0 };
      let total = 0;
      for (const { status, n } of stmt.counts.all()) { byStatus[status] = n; total += n; }
      return { total, today: stmt.today.get(todayStartIso).n, byStatus };
    },

    close() { db.close(); },
  };
}
