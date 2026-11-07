import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTemplates, type Family } from '../src/lib/cam/templates';

/*
 * The shop's CAM templates (the "Program Order" HTML pages exported from NX, one per material
 * family) into src/lib/cam/library.json: the only tools CAM AI may use, with each operation's
 * depth per pass, step-over, feed and rpm.
 *   npm run import-templates -- ALU=Program_Order_ALU.html POM=Program_Order_pom.html FH=Program_Order_1_1.html
 */

const out: Partial<Record<Family, unknown>> = {};
for (const arg of process.argv.slice(2)) {
  const [family, path] = arg.split('=') as [Family, string];
  if (!['ALU', 'POM', 'FH'].includes(family) || !path) throw new Error(`expected FAMILY=file.html, got ${arg}`);
  const tools = parseTemplates(readFileSync(path, 'utf8'));
  out[family] = tools;
  const ops = tools.reduce((t, x) => t + x.ops.length, 0);
  console.log(`${family}: ${tools.length} tools, ${ops} operations`);
}
writeFileSync(join(process.cwd(), 'src/lib/cam/library.json'), JSON.stringify(out, null, 1) + '\n');
