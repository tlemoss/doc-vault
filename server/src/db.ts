import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function initDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      kdf_salt TEXT NOT NULL,
      kdf_iterations INTEGER NOT NULL DEFAULT 600000,
      auth_salt TEXT NOT NULL,
      auth_hash TEXT NOT NULL,
      public_key TEXT NOT NULL,
      public_key_fingerprint TEXT NOT NULL,
      encrypted_private_key TEXT NOT NULL,
      private_key_iv TEXT NOT NULL,
      recovery_encrypted_private_key TEXT NOT NULL,
      recovery_iv TEXT NOT NULL,
      recovery_salt TEXT NOT NULL,
      recovery_auth_salt TEXT NOT NULL,
      recovery_auth_hash TEXT NOT NULL,
      quota_bytes INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      username TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')) DEFAULT 'user',
      quota_bytes INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('documents', 'table')),
      encrypted_meta TEXT NOT NULL,
      meta_iv TEXT NOT NULL,
      encrypted_schema TEXT,
      schema_iv TEXT,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tab_access (
      tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
      wrapped_tab_key TEXT NOT NULL,
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (tab_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tab_access_user ON tab_access(user_id);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('file', 'note')),
      encrypted_meta TEXT NOT NULL,
      meta_iv TEXT NOT NULL,
      encrypted_content TEXT,
      content_iv TEXT,
      wrapped_file_key TEXT,
      file_key_iv TEXT,
      blob_iv TEXT,
      blob_size INTEGER NOT NULL DEFAULT 0,
      blob_path TEXT,
      upload_complete INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_tab ON documents(tab_id);
    CREATE INDEX IF NOT EXISTS idx_documents_creator ON documents(created_by);

    CREATE TABLE IF NOT EXISTS table_rows (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      sort_order REAL NOT NULL DEFAULT 0,
      encrypted_data TEXT NOT NULL,
      data_iv TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_table_rows_tab ON table_rows(tab_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_table_rows_creator ON table_rows(created_by);
  `);

  // Persist a random per-instance pepper used only for dummy login challenges
  // (prevents username enumeration without affecting real user salts).
  const existingPepper = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('challenge_pepper') as { value: string } | undefined;
  if (!existingPepper) {
    const pepper = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
      'challenge_pepper',
      pepper
    );
  }

  return db;
}

export function getChallengePepper(db: DatabaseSync): string {
  const row = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('challenge_pepper') as { value: string };
  return row.value;
}
