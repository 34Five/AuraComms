import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEMO_ORG, DEMO_PERSONAS } from '../worker/llm/demo-personas.ts';

const literal = value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const profiles = DEMO_PERSONAS.filter(p => p.email !== p.previousEmail);
const keys = profiles.flatMap(p => [p.email, p.previousEmail]).map(literal).join(',');
const ids = DEMO_PERSONAS.map(p => literal(p.id)).join(',');
const addressSelect = `SELECT a.id,a.org_id,a.domain_id,a.address_key,a.status,x.id AS assignment_id,x.aura_id,x.assigned_at
  FROM email_addresses a LEFT JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL
  WHERE a.address_key IN (${keys}) OR a.id IN (${profiles.map(p => literal(`address_${p.name.toLowerCase()}`)).join(',')})`;

// execute must run the complete SQL file in one transaction, as Wrangler D1 does.
export function migrateDemoAuraEmails({ query, execute }, now = new Date().toISOString()) {
  const auras = query(`SELECT * FROM auras WHERE id IN (${ids})`);
  if (profiles.some(p => !auras.some(a => a.id === p.id)) || auras.some(a => a.org_id !== DEMO_ORG)) {
    throw new Error('The four demo Auras must exist in the demo organization. No changes made.');
  }
  const domains = query("SELECT id,org_id,status FROM email_domains WHERE domain_key='34five.studio'");
  if (domains.length !== 1 || domains[0].org_id !== DEMO_ORG || domains[0].status !== 'active') {
    throw new Error('The active demo email domain is required. No changes made.');
  }
  const domain = domains[0], addresses = query(addressSelect);
  for (const address of addresses) {
    const profile = profiles.find(p => [p.email, p.previousEmail].includes(address.address_key));
    if (!profile || address.org_id !== DEMO_ORG || address.domain_id !== domain.id ||
      (address.aura_id && address.aura_id !== profile.id) ||
      (address.address_key === profile.email && (address.status !== 'active' || address.aura_id !== profile.id)) ||
      (address.address_key === profile.previousEmail && !['active', 'disabled'].includes(address.status)) ||
      (address.assigned_at && address.assigned_at > now)) {
      throw new Error('A demo address has conflicting ownership or state. No changes made.');
    }
  }
  if (addresses.some(a => a.assigned_at === now)) now = new Date(Date.parse(now) + 1).toISOString();
  const unsent = `SELECT 1 FROM email_messages WHERE org_id=${literal(DEMO_ORG)} AND direction='out'
    AND from_address IN (${profiles.map(p => literal(p.previousEmail)).join(',')}) AND status IN ('sending','draft','queued')`;
  if (query(unsent).length) throw new Error('Finish or cancel unsent messages from the old aliases before migrating. No changes made.');
  const hasRole = query("SELECT name FROM pragma_table_info('auras') WHERE name='role'").length > 0;
  // Check the exact state again inside the transaction. Concurrent edits abort the entire file.
  const auraSnapshot = auras.map(a => `(id=${literal(a.id)} AND org_id=${literal(a.org_id)} AND name IS ${literal(a.name)}${hasRole ? ` AND role IS ${literal(a.role)}` : ''})`).join(' OR ');
  const addressSnapshot = addresses.map(a => `(${Object.entries(a).map(([key, value]) => `${['assignment_id','aura_id','assigned_at'].includes(key) ? 'x.' + (key === 'assignment_id' ? 'id' : key) : 'a.' + key} IS ${literal(value)}`).join(' AND ')})`).join(' OR ');
  const guard = `SELECT json(CASE WHEN
    (SELECT COUNT(*) FROM auras WHERE ${auraSnapshot})=${auras.length}
    AND EXISTS (SELECT 1 FROM email_domains WHERE id=${literal(domain.id)} AND org_id=${literal(DEMO_ORG)} AND status='active')
    AND (SELECT COUNT(*) FROM (${addressSelect}))=${addresses.length}
    ${addresses.length ? `AND (SELECT COUNT(*) FROM email_addresses a LEFT JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL WHERE ${addressSnapshot})=${addresses.length}` : ''}
    AND NOT EXISTS (${unsent}) THEN '{}' ELSE 'Demo Aura state changed before migration' END);`;
  const statements = [guard, ...(!hasRole ? ['ALTER TABLE auras ADD COLUMN role TEXT;'] : [])];
  for (const p of DEMO_PERSONAS.filter(p => auras.some(a => a.id === p.id))) {
    statements.push(`UPDATE auras SET role=${literal(p.role)} WHERE org_id=${literal(DEMO_ORG)} AND id=${literal(p.id)} AND (role IS NULL OR trim(role)='');`);
    statements.push(`UPDATE auras SET name=${literal(p.name)} WHERE org_id=${literal(DEMO_ORG)} AND id=${literal(p.id)} AND name=${literal(p.previousName)};`);
  }
  for (const p of profiles) {
    const local = p.name.toLowerCase();
    statements.push(`INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key)
      VALUES (${literal(`address_${local}`)},${literal(DEMO_ORG)},${literal(domain.id)},${literal(local)},${literal(p.email)},${literal(p.email)}) ON CONFLICT(address_key) DO NOTHING;`);
    statements.push(`INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at,reason)
      SELECT ${literal(`assignment_${local}`)},${literal(DEMO_ORG)},a.id,${literal(p.id)},${literal(now)},'Named Aura email address'
      FROM email_addresses a WHERE a.org_id=${literal(DEMO_ORG)} AND a.address_key=${literal(p.email)}
      AND NOT EXISTS (SELECT 1 FROM email_address_assignments x WHERE x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL);`);
    statements.push(`UPDATE email_address_assignments SET ended_at=${literal(now)}
      WHERE org_id=${literal(DEMO_ORG)} AND aura_id=${literal(p.id)} AND ended_at IS NULL
      AND address_id IN (SELECT id FROM email_addresses WHERE org_id=${literal(DEMO_ORG)} AND address_key=${literal(p.previousEmail)});`);
    statements.push(`UPDATE email_addresses SET status='disabled',disabled_at=${literal(now)}
      WHERE org_id=${literal(DEMO_ORG)} AND address_key=${literal(p.previousEmail)} AND status='active';`);
  }
  execute(statements.join('\n'));
  const after = query(addressSelect);
  if (profiles.some(p => !after.some(a => a.address_key === p.email && a.aura_id === p.id && a.status === 'active') ||
    after.some(a => a.address_key === p.previousEmail && (a.status !== 'disabled' || a.assignment_id)))) {
    throw new Error('Demo email migration verification failed.');
  }
  return { auras: query(`SELECT id,name,role FROM auras WHERE org_id=${literal(DEMO_ORG)} AND id IN (${ids})`), addresses: after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const args = [cli, 'd1', 'execute', 'DB', process.argv.includes('--remote') ? '--remote' : '--local', '--json'];
  const persist = process.argv.indexOf('--persist-to');
  if (persist >= 0) {
    if (process.argv.includes('--remote') || !process.argv[persist + 1]) throw new Error('--persist-to requires a local path.');
    args.push('--persist-to', process.argv[persist + 1]);
  }
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  const query = sql => JSON.parse(execFileSync(process.execPath, [...args, '--command', sql], { cwd, encoding: 'utf8', env }))[0].results;
  const temp = mkdtempSync(join(tmpdir(), 'aura-persona-emails-'));
  try {
    const execute = sql => {
      const path = join(temp, 'migration.sql');
      writeFileSync(path, sql, { mode: 0o600 });
      execFileSync(process.execPath, [...args, '--file', path], { cwd, encoding: 'utf8', env });
    };
    console.log(JSON.stringify(migrateDemoAuraEmails({ query, execute }), null, 2));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
