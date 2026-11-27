/*
 * Türkiye's setup for the deploy (A032, A035): its 17 machines as the app creates them (Türkiye's checklist, the
 * "machine added" event), HAAS F at 41 slots, and the tool database read from the shop's list with the app's own
 * reading and check. Prints the statements (SQL with bound values) to run once on Türkiye's database.
 * Usage: npx esbuild tools/trSetup.ts --bundle --platform=node --format=esm --outfile=<dir>/trSetup.mjs
 *        node <dir>/trSetup.mjs <shop list .csv> <out.json>
 * The list is never kept in the repository (confidential); only its path is given here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { catalogFromRows, normalizeCatalog, parseCsv } from '../src/lib/toolCatalog';
import { DEFAULT_CHECKS_TR } from '../worker/fleet';
import { newId } from '../worker/context';

// Layout v2: ASB (6 HAAS, 6 FANUC), OSB (2 HAAS, 3 FANUC). OSB's get their own ids so none is a Moroccan machine's.
const MACHINES: [id: string, name: string, brand: 'HAAS' | 'FANUC', slots: number][] = [
  ['HAAS-K', 'HAAS K', 'HAAS', 50], // 50 tools, the probe not counted
  ['HAAS-M', 'HAAS M', 'HAAS', 41],
  ['HAAS-G', 'HAAS G', 'HAAS', 41],
  ['HAAS-E', 'HAAS E', 'HAAS', 41],
  ['HAAS-F', 'HAAS F', 'HAAS', 41], // already there: slots 32 -> 41, its tools kept
  ['HAAS-H', 'HAAS H', 'HAAS', 41],
  ['FANUC-P', 'FANUC P', 'FANUC', 21],
  ['FANUC-A', 'FANUC A', 'FANUC', 21],
  ['FANUC-C', 'FANUC C', 'FANUC', 21],
  ['FANUC-O', 'FANUC O', 'FANUC', 21],
  ['FANUC-D', 'FANUC D', 'FANUC', 21],
  ['FANUC-B', 'FANUC B', 'FANUC', 21],
  ['OSB-HAAS-1', 'HAAS 1', 'HAAS', 41],
  ['OSB-HAAS-2', 'HAAS 2', 'HAAS', 41],
  ['OSB-FANUC-1', 'FANUC 1', 'FANUC', 21],
  ['OSB-FANUC-2', 'FANUC 2', 'FANUC', 21],
  ['OSB-FANUC-3', 'FANUC 3', 'FANUC', 21],
];

const [list, out] = process.argv.slice(2);
if (!list || !out) throw new Error('usage: trSetup.mjs <shop list .csv> <out.json>');
const tools = normalizeCatalog(catalogFromRows(parseCsv(readFileSync(list, 'utf8'))).tools);
if (!tools?.length) throw new Error('the list gives no tool the server would keep');
const now = Date.now();
const plan: { sql: string; params: unknown[] }[] = [];
MACHINES.forEach(([id, name, brand, slots], i) => {
  const sort = (i + 1) * 10;
  if (id === 'HAAS-F') return void plan.push({ sql: "UPDATE machines SET pockets = ?, sort = ? WHERE id = 'HAAS-F'", params: [slots, sort] });
  plan.push({
    sql: 'INSERT INTO machines (id, name, brand, model, image, pockets, has_tools, active, sort, created_at, max_rpm, max_feed, rapid, tool_change) VALUES (?, ?, ?, ?, NULL, ?, 1, 1, ?, ?, NULL, NULL, NULL, NULL)',
    params: [id, name, brand, '', slots, sort, now],
  });
  DEFAULT_CHECKS_TR.forEach((c, k) =>
    plan.push({ sql: "INSERT INTO machine_checks (id, machine_id, kind, title, frequency, sort, created_at) VALUES (?, ?, 'CHECK', ?, ?, ?, ?)", params: [newId(), id, c.title, c.frequency, (k + 1) * 10, now] }),
  );
  plan.push({ sql: 'INSERT INTO machine_events (machine_id, check_id, check_title, action, note, username, at) VALUES (?, NULL, NULL, ?, ?, ?, ?)', params: [id, 'MACHINE_ADDED', name, 'setup', now] });
});
plan.push({
  sql: "INSERT INTO settings (key, value, updated_at) VALUES ('tool_catalog', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  params: [JSON.stringify({ tools, by: 'setup' }), now],
});
plan.push({ sql: "UPDATE counters SET value = value + 1 WHERE name IN ('v_machines', 'v_tools')", params: [] });
writeFileSync(out, JSON.stringify(plan));
console.log(`${plan.length} statements: ${MACHINES.length - 1} machines added, HAAS F to 41 slots, ${tools.length} tools in the database`);
