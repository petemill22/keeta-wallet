const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path   = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'keeta.db');
const db      = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS themes (
    key           TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    css_class     TEXT    NOT NULL,
    description   TEXT,
    price_pence   INTEGER,
    owners_count  INTEGER DEFAULT 0,
    artist        TEXT,
    active        INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT    UNIQUE NOT NULL,
    email          TEXT    UNIQUE,
    password_hash  TEXT,
    name           TEXT    DEFAULT 'User',
    is_artist      INTEGER DEFAULT 0,
    keeta_seed     TEXT,
    keeta_address  TEXT,
    created_at     TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                  INTEGER NOT NULL REFERENCES users(id),
    theme_key                TEXT    NOT NULL REFERENCES themes(key),
    stripe_payment_intent_id TEXT,
    keeta_tx_id              TEXT,
    amount_pence             INTEGER NOT NULL,
    purchased_at             TEXT    DEFAULT (datetime('now')),
    UNIQUE(user_id, theme_key)
  );
`);

// ── Migrations (safe — silently skip if column already exists) ────────────────
for (const sql of [
  `ALTER TABLE users ADD COLUMN email TEXT UNIQUE`,
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  `ALTER TABLE users ADD COLUMN name TEXT DEFAULT 'User'`,
  `ALTER TABLE users ADD COLUMN is_artist INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN keeta_seed TEXT`,
  `ALTER TABLE users ADD COLUMN keeta_address TEXT`,
  `ALTER TABLE themes ADD COLUMN theme_vars TEXT`,
  `ALTER TABLE themes ADD COLUMN artwork_data TEXT`,
]) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// ── Seed themes ───────────────────────────────────────────────────────────────
db.exec('BEGIN');
try {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO themes (key, name, css_class, description, price_pence, owners_count, artist)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of [
    ['genesis',  'Genesis',         'theme-genesis',  'Clean and minimal. The default look.',                                            null, 12481, null],
    ['obsidian', 'Obsidian Knight', 'theme-obsidian', 'Dark gothic aesthetic by artist @vale.ink. Deep reds on near-black.',             null,  8204, '@vale.ink'],
    ['neon',     'Neon Ghost',      'theme-neon',     'Cyberpunk colour palette by @glitchwraith. Teal on deep navy.',                   null,  5712, '@glitchwraith'],
    ['solar',    'Solar Flare',     'theme-solar',    'Volcanic warm tones by artist @amberfield. Amber and deep orange on black.',       199,  3108, '@amberfield'],
    ['abyss',    'Abyss',           'theme-abyss',    'Deep ocean palette by @depthstudio. Electric blue on midnight black.',            349,  2441, '@depthstudio'],
    ['sakura',   'Sakura',          'theme-sakura',   'Cherry blossom palette by @yukiart. Soft pinks on deep plum.',                    179,  1902, '@yukiart'],
  ]) ins.run(...t);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

// ── Seed demo user (jordan@keeta.app / demo123) ───────────────────────────────
const demoHash = bcrypt.hashSync('demo123', 10);

db.prepare(`
  INSERT OR IGNORE INTO users (id, wallet_address, email, password_hash, name)
  VALUES (1, 'demo-wallet-jordan', 'jordan@keeta.app', ?, 'Jordan')
`).run(demoHash);

// Patch existing demo user if email/password_hash missing
db.prepare(`
  UPDATE users SET email = 'jordan@keeta.app', password_hash = ?, name = 'Jordan'
  WHERE id = 1 AND (email IS NULL OR email = '')
`).run(demoHash);

// ── Seed default owned themes for demo user ───────────────────────────────────
db.exec('BEGIN');
try {
  const ip = db.prepare(
    `INSERT OR IGNORE INTO purchases (user_id, theme_key, amount_pence) VALUES (?, ?, 0)`
  );
  for (const key of ['genesis', 'obsidian', 'neon']) ip.run(1, key);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

module.exports = db;
