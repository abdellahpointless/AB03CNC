import { DEFAULT_CHECKS, FLEET_IDS } from './fleet';

/**
 * Database schema, applied automatically by the Worker on its first request
 * after a deploy. Each migration runs once, inside a single D1 batch (transaction).
 *
 * Never edit a migration that has shipped - append a new one instead.
 */
const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MACHINIST')),
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS login_attempts (
        key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        locked_until INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS tools (
        machine TEXT NOT NULL,
        id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        number INTEGER NOT NULL,
        pocket INTEGER,
        category TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        diameter REAL NOT NULL DEFAULT 0,
        length REAL NOT NULL DEFAULT 0,
        materials TEXT,
        changed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (machine, id)
      )`,
      `CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        date_label TEXT NOT NULL,
        username TEXT NOT NULL,
        machine TEXT,
        original_file_name TEXT NOT NULL,
        exported_file_name TEXT NOT NULL,
        changes TEXT NOT NULL,
        app_chosen INTEGER NOT NULL DEFAULT 0,
        manual_chosen INTEGER NOT NULL DEFAULT 0,
        has_code INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS history_created ON history(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS history_user_created ON history(username, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS code_files (
        id TEXT PRIMARY KEY,
        encoding TEXT NOT NULL,
        size INTEGER NOT NULL,
        chunks INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS code_chunks (
        file_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (file_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS extraction_stats (
        username TEXT PRIMARY KEY,
        extractions INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER
      )`,
      // Small key/value counters: sync versions (v_*) and running totals.
      `CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS part_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        sap_number TEXT NOT NULL,
        qty INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('PRODUCED', 'MODIFICATION')),
        unit_value REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        month_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS part_entries_user ON part_entries(user_id, status, month_key, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS part_entries_status ON part_entries(status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS part_entries_month ON part_entries(month_key, created_at DESC)`,
      `INSERT OR IGNORE INTO counters (name, value) VALUES
        ('v_tools', 1), ('v_history', 1), ('v_users', 1), ('v_settings', 1), ('v_parts', 1),
        ('history_total', 0), ('tools_app_selected', 0), ('tools_manual', 0)`,
    ],
  },
  {
    // Preventive actions: per-machine checklists, open problems and a log of who did what.
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS machine_checks (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'CHECK' CHECK (kind IN ('CHECK', 'ISSUE')),
        title TEXT NOT NULL,
        frequency TEXT CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY')),
        status TEXT NOT NULL DEFAULT 'OK' CHECK (status IN ('OK', 'PROBLEM')),
        note TEXT,
        last_done_at INTEGER,
        last_done_by TEXT,
        status_at INTEGER,
        status_by TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS machine_checks_machine ON machine_checks(machine_id, sort)`,
      `CREATE TABLE IF NOT EXISTS machine_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL,
        check_id TEXT,
        check_title TEXT,
        action TEXT NOT NULL,
        note TEXT,
        username TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS machine_events_at ON machine_events(at DESC)`,
      `INSERT OR IGNORE INTO counters (name, value) VALUES ('v_machines', 1)`,
      ...FLEET_IDS.flatMap((m) =>
        DEFAULT_CHECKS.map(
          (c, i) =>
            `INSERT OR IGNORE INTO machine_checks (id, machine_id, kind, title, frequency, sort, created_at)
             VALUES ('${m.toLowerCase()}-default-${i + 1}', '${m}', 'CHECK', '${c.title.replace(/'/g, "''")}', '${c.frequency}', ${(i + 1) * 10}, 0)`,
        ),
      ),
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

let schemaReady: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = migrate(db).catch((err) => {
      schemaReady = null; // retry on the next request
      throw err;
    });
  }
  return schemaReady;
}

async function migrate(db: D1Database): Promise<void> {
  let current = 0;
  try {
    const row = await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').first<{ v: number | null }>();
    current = row?.v ?? 0;
  } catch {
    await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await db.batch([
      ...m.statements.map((s) => db.prepare(s)),
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').bind(m.version, Date.now()),
    ]);
  }
}
