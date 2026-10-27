import { DEFAULT_CHECKS, FLEET_IDS } from './fleet';
import type { RegionId } from '../src/regions';

/**
 * Database schema, applied automatically by the Worker on its first request
 * after a deploy. Each migration runs once, inside a single D1 batch (transaction).
 *
 * Never edit a migration that has shipped - append a new one instead.
 */
export const MIGRATIONS: { version: number; statements: string[] }[] = [
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
      // Who is responsible for which machine. A user listed here can only update their own machines.
      `CREATE TABLE IF NOT EXISTS machine_owners (
        machine_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        assigned_at INTEGER NOT NULL,
        PRIMARY KEY (machine_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS machine_owners_user ON machine_owners(user_id)`,
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
  {
    // Security hardening: two-step sign-in (TOTP), sign-in challenges and a security event log.
    version: 3,
    statements: [
      `ALTER TABLE users ADD COLUMN mfa_secret TEXT`,
      `ALTER TABLE users ADD COLUMN mfa_pending_secret TEXT`,
      `ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN mfa_recovery TEXT`,
      `ALTER TABLE users ADD COLUMN mfa_last_step INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN password_changed_at INTEGER`,
      `ALTER TABLE sessions ADD COLUMN role TEXT`,
      `CREATE TABLE IF NOT EXISTS login_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        user_id TEXT,
        username TEXT,
        ip TEXT,
        action TEXT NOT NULL,
        detail TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at DESC)`,
      // Generic per-user quotas (history uploads, searches).
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      )`,
    ],
  },
  {
    // Machines become data: each country (database) has its own list, editable by its admins.
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL CHECK (brand IN ('HAAS', 'FANUC', 'DMG MORI', 'OTHER')),
        model TEXT NOT NULL DEFAULT '',
        image TEXT,
        pockets INTEGER,
        has_tools INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // An open problem can stop the machine (breakdown): the status board shows it as down.
    version: 5,
    statements: [`ALTER TABLE machine_checks ADD COLUMN stops INTEGER NOT NULL DEFAULT 0`],
  },
  {
    // Shift checks: every user does every due check once per period (credibility: each person
    // confirms for themselves), and the cales box of each machine at the start of every shift.
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS check_completions (
        check_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        period_key TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('OK', 'PROBLEM')),
        shift_key TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (check_id, user_id, period_key)
      )`,
      `CREATE INDEX IF NOT EXISTS check_completions_user ON check_completions(user_id, period_key)`,
      // Only pairs that are not in good shape have a row; count = how many of the pair's 2 cales.
      `CREATE TABLE IF NOT EXISTS cales_state (
        machine_id TEXT NOT NULL,
        height INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('MISSING', 'DAMAGED')),
        count INTEGER NOT NULL CHECK (count IN (1, 2)),
        at INTEGER NOT NULL,
        username TEXT NOT NULL,
        PRIMARY KEY (machine_id, height)
      )`,
      `CREATE TABLE IF NOT EXISTS cales_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL,
        height INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('MISSING', 'DAMAGED', 'FOUND', 'REPLACED')),
        count INTEGER NOT NULL,
        username TEXT NOT NULL,
        shift_key TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS cales_events_at ON cales_events(at)`,
      `CREATE TABLE IF NOT EXISTS cales_checks (
        machine_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        shift_key TEXT NOT NULL,
        username TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (machine_id, user_id, shift_key)
      )`,
      // Spare single cales per machine and height. The CHECK makes an approval fail (and roll back)
      // rather than ever take the stock below zero.
      `CREATE TABLE IF NOT EXISTS cales_stock (
        machine_id TEXT NOT NULL,
        height INTEGER NOT NULL,
        qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (machine_id, height)
      )`,
      `CREATE TABLE IF NOT EXISTS cales_requests (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        height INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('MISSING', 'DAMAGED')),
        count INTEGER NOT NULL CHECK (count IN (1, 2)),
        requested_by TEXT NOT NULL,
        at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED')),
        decided_by TEXT,
        decided_at INTEGER
      )`,
      // One open request per pair.
      `CREATE UNIQUE INDEX IF NOT EXISTS cales_requests_open ON cales_requests(machine_id, height) WHERE status = 'OPEN'`,
    ],
  },
  {
    // Tasks at the start and at the end of every shift. SQLite cannot change a CHECK constraint, so
    // the table is rebuilt (same columns, every row copied) in this one transaction.
    version: 7,
    statements: [
      `CREATE TABLE machine_checks_v7 (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'CHECK' CHECK (kind IN ('CHECK', 'ISSUE')),
        title TEXT NOT NULL,
        frequency TEXT CHECK (frequency IN ('SHIFT_START', 'SHIFT_END', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY')),
        status TEXT NOT NULL DEFAULT 'OK' CHECK (status IN ('OK', 'PROBLEM')),
        note TEXT,
        last_done_at INTEGER,
        last_done_by TEXT,
        status_at INTEGER,
        status_by TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        stops INTEGER NOT NULL DEFAULT 0
      )`,
      `INSERT INTO machine_checks_v7 (id, machine_id, kind, title, frequency, status, note, last_done_at, last_done_by, status_at, status_by, sort, created_at, stops)
       SELECT id, machine_id, kind, title, frequency, status, note, last_done_at, last_done_by, status_at, status_by, sort, created_at, stops FROM machine_checks`,
      `DROP TABLE machine_checks`,
      `ALTER TABLE machine_checks_v7 RENAME TO machine_checks`,
      `CREATE INDEX IF NOT EXISTS machine_checks_machine ON machine_checks(machine_id, sort)`,
    ],
  },
  {
    // One general security stock per cale size, shared by every machine (no longer one per machine).
    // It starts with today's per-machine counts added up per size; cales_stock is left as it was.
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS cales_spare (
        height INTEGER PRIMARY KEY,
        qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
        updated_at INTEGER NOT NULL
      )`,
      `INSERT OR IGNORE INTO cales_spare (height, qty, updated_at) SELECT height, SUM(qty), MAX(updated_at) FROM cales_stock GROUP BY height`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** One migration promise per database (each country, and the hub, has its own database). */
const schemaReady = new Map<string, Promise<void>>();

/**
 * Brings a database up to date, once per Worker instance. `instance` is the country id or
 * 'master'; it also decides the one-time seed (Morocco gets its original machines).
 */
export function ensureSchema(db: D1Database, instance: RegionId | 'master' = 'ma'): Promise<void> {
  let p = schemaReady.get(instance);
  if (!p) {
    p = migrate(db)
      .then(() => seedInstance(db, instance))
      .catch((err) => {
        schemaReady.delete(instance); // retry on the next request
        throw err;
      });
    schemaReady.set(instance, p);
  }
  return p;
}

/** The machines of the original (Moroccan) installation, in floor order. */
const MOROCCO_MACHINES: [id: string, brand: string, model: string, image: string, pockets: number | null, hasTools: number][] = [
  ['HAAS-1', 'HAAS', 'VF-3', '/machines/haas-vf3.webp', 41, 1],
  ['HAAS-2', 'HAAS', 'VF-3', '/machines/haas-vf3.webp', null, 1],
  ['HAAS-3', 'HAAS', 'VF-2', '/machines/haas-vf2.webp', null, 0],
  ['HAAS-4', 'HAAS', 'VF-3', '/machines/haas-vf3.webp', null, 1],
  ['HAAS-5', 'HAAS', 'VF-3', '/machines/haas-vf3.webp', null, 1],
  ['FANUC-1', 'FANUC', 'Robodrill', '/machines/fanuc-robodrill.webp', null, 1],
  ['FANUC-2', 'FANUC', 'Robodrill', '/machines/fanuc-robodrill.webp', null, 1],
  ['DMG-1', 'DMG MORI', 'CMX 600 V', '/machines/dmg-cmx600v.webp', null, 1],
];

/**
 * Runs once per database. Records which instance the database belongs to and refuses to run
 * if it belongs to another one (a misconfigured binding would otherwise mix two countries).
 */
async function seedInstance(db: D1Database, instance: RegionId | 'master'): Promise<void> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'instance'").first<{ value: string }>();
  if (row) {
    if (row.value !== instance) {
      throw new Error(`Database belongs to "${row.value}" but is bound as "${instance}". Check the D1 bindings in wrangler.jsonc.`);
    }
    return;
  }
  // A database that is new to this instance must not already hold accounts (e.g. a copy of
  // another country restored into it by mistake): its users would gain this instance's rights.
  if (instance !== 'ma') {
    const users = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    if ((users?.n ?? 0) > 0) throw new Error(`Database bound as "${instance}" already has accounts but was never set up for it. Check the D1 bindings.`);
  }
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (instance === 'ma') {
    MOROCCO_MACHINES.forEach(([id, brand, model, image, pockets, hasTools], i) =>
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO machines (id, name, brand, model, image, pockets, has_tools, active, sort, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(id, id, brand, model, image, pockets, hasTools, (i + 1) * 10, now),
      ),
    );
  } else {
    // A new country starts with no machines: drop the checklist rows that migration 2 seeded for
    // the Moroccan machines (they would never be visible here).
    stmts.push(db.prepare(`DELETE FROM machine_checks WHERE id LIKE '%-default-%' AND created_at = 0`));
  }
  stmts.push(
    db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('instance', ?, ?)").bind(instance, now),
    db.prepare("UPDATE counters SET value = value + 1 WHERE name IN ('v_machines', 'v_tools')"),
  );
  await db.batch(stmts);
  // Two isolates may seed at the same time: whoever wrote first wins, the other only checks.
  const after = await db.prepare("SELECT value FROM settings WHERE key = 'instance'").first<{ value: string }>();
  if (after?.value !== instance) throw new Error(`Database belongs to "${after?.value}" but is bound as "${instance}".`);
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
