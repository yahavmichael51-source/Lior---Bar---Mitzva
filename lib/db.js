// SQL storage for the Node server (server.js). Uses PostgreSQL when DATABASE_URL is set,
// otherwise a local SQLite file (DATA_DIR/rsvp.db) — handy for running on your own machine.
// (On Netlify, lib/blobs-store.js is used instead.)
const path = require('node:path');
const fs = require('node:fs');

const isId = (id) => /^\d{1,15}$/.test(String(id));

function rowToResponse(r) {
  return {
    id: Number(r.id),
    firstName: r.first_name,
    lastName: r.last_name || '',
    status: r.status,
    people: Number(r.people),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    editTokenHash: r.edit_token_hash || null,
  };
}

async function createPostgres(url) {
  const { Pool } = require('pg');
  const needsSsl = !/localhost|127\.0\.0\.1/.test(url) && process.env.PGSSLMODE !== 'disable';
  const pool = new Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('yes','no','maybe')),
      people INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS last_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS edit_token_hash TEXT;
  `);
  return {
    kind: 'postgres',
    async addResponse({ firstName, lastName, status, people, editTokenHash }) {
      const { rows } = await pool.query(
        'INSERT INTO responses (first_name, last_name, status, people, edit_token_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [firstName, lastName, status, people, editTokenHash]
      );
      return rowToResponse(rows[0]);
    },
    async getResponse(id) {
      if (!isId(id)) return null;
      const { rows } = await pool.query('SELECT * FROM responses WHERE id=$1', [id]);
      return rows[0] ? rowToResponse(rows[0]) : null;
    },
    async listResponses() {
      const { rows } = await pool.query('SELECT * FROM responses ORDER BY created_at DESC, id DESC');
      return rows.map(rowToResponse);
    },
    async updateResponse(id, { firstName, lastName, status, people }) {
      if (!isId(id)) return null;
      const { rows } = await pool.query(
        'UPDATE responses SET first_name=$1, last_name=$2, status=$3, people=$4, updated_at=now() WHERE id=$5 RETURNING *',
        [firstName, lastName, status, people, id]
      );
      return rows[0] ? rowToResponse(rows[0]) : null;
    },
    async deleteResponse(id) {
      if (!isId(id)) return false;
      const { rowCount } = await pool.query('DELETE FROM responses WHERE id=$1', [id]);
      return rowCount > 0;
    },
    async getSettings() {
      const { rows } = await pool.query('SELECT key, value FROM settings');
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },
    async setSettings(updates) {
      for (const [key, value] of Object.entries(updates)) {
        await pool.query(
          'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
          [key, value]
        );
      }
    },
  };
}

function createSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('yes','no','maybe')),
      people INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Add columns introduced after the first version (SQLite has no ADD COLUMN IF NOT EXISTS).
  const columns = new Set(db.prepare('PRAGMA table_info(responses)').all().map((c) => c.name));
  if (!columns.has('last_name')) db.exec("ALTER TABLE responses ADD COLUMN last_name TEXT NOT NULL DEFAULT ''");
  if (!columns.has('edit_token_hash')) db.exec('ALTER TABLE responses ADD COLUMN edit_token_hash TEXT');
  const now = () => new Date().toISOString();
  return {
    kind: 'sqlite',
    async addResponse({ firstName, lastName, status, people, editTokenHash }) {
      const row = db
        .prepare(
          'INSERT INTO responses (first_name, last_name, status, people, edit_token_hash, created_at) VALUES (?,?,?,?,?,?) RETURNING *'
        )
        .get(firstName, lastName, status, people, editTokenHash, now());
      return rowToResponse(row);
    },
    async getResponse(id) {
      if (!isId(id)) return null;
      const row = db.prepare('SELECT * FROM responses WHERE id=?').get(Number(id));
      return row ? rowToResponse(row) : null;
    },
    async listResponses() {
      return db.prepare('SELECT * FROM responses ORDER BY created_at DESC, id DESC').all().map(rowToResponse);
    },
    async updateResponse(id, { firstName, lastName, status, people }) {
      if (!isId(id)) return null;
      const row = db
        .prepare('UPDATE responses SET first_name=?, last_name=?, status=?, people=?, updated_at=? WHERE id=? RETURNING *')
        .get(firstName, lastName, status, people, now(), Number(id));
      return row ? rowToResponse(row) : null;
    },
    async deleteResponse(id) {
      return isId(id) && db.prepare('DELETE FROM responses WHERE id=?').run(Number(id)).changes > 0;
    },
    async getSettings() {
      const out = {};
      for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
      return out;
    },
    async setSettings(updates) {
      const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [key, value] of Object.entries(updates)) stmt.run(key, value);
    },
  };
}

async function openDatabase() {
  if (process.env.DATABASE_URL) return createPostgres(process.env.DATABASE_URL);
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return createSqlite(path.join(dir, 'rsvp.db'));
}

module.exports = { openDatabase };
