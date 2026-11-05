import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEMO_ORG, DEMO_PERSONAS } from '../worker/llm/demo-personas.ts';

const literal = value => `'${value.replaceAll("'", "''")}'`;
const profiles = DEMO_PERSONAS.filter(persona => persona.name !== persona.previousName);
const ids = profiles.map(persona => literal(persona.id)).join(',');
const select = `SELECT id,org_id,name FROM auras WHERE id IN (${ids})`;

// One guarded update changes names only. Custom names, tiers, routes, and historical messages stay intact.
export function renameDemoAuras(query) {
  const before = query(select);
  if (before.length !== profiles.length || before.some(row => row.org_id !== DEMO_ORG)) {
    throw new Error('The four existing demo Auras must belong to the demo organization. No names changed.');
  }
  query(`UPDATE auras SET name=CASE id ${profiles.map(persona => `WHEN ${literal(persona.id)} THEN ${literal(persona.name)}`).join(' ')} END
    WHERE org_id=${literal(DEMO_ORG)} AND (${profiles.map(persona => `(id=${literal(persona.id)} AND name=${literal(persona.previousName)})`).join(' OR ')})`);
  const after = query(select);
  if (after.length !== profiles.length || after.some(row => row.org_id !== DEMO_ORG || profiles.some(persona => persona.id === row.id && row.name === persona.previousName))) {
    throw new Error('Demo Aura name verification failed.');
  }
  return after;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const target = process.argv.includes('--remote') ? '--remote' : '--local';
  const query = sql => JSON.parse(execFileSync(process.execPath, [cli, 'd1', 'execute', 'DB', target, '--command', sql, '--json'], {
    cwd, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  }))[0].results;
  console.log(JSON.stringify({ auras: renameDemoAuras(query) }, null, 2));
}
