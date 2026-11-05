import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ORG, DEMO_PERSONAS } from '../worker/llm/demo-personas.ts';
import { auraConfig, buildReplyPrompt } from '../worker/llm/prompt.ts';
import { renameDemoAuras } from '../scripts/provision-personas.mjs';
import { setup } from './harness.mjs';

test('each demo identity has a distinct personality independent of name and tier', () => {
  assert.equal(new Set(DEMO_PERSONAS.map(p => p.personality)).size, 5);
  for (const persona of DEMO_PERSONAS) {
    const config = auraConfig({ id: persona.id, org_id: DEMO_ORG, name: 'Custom name', tier: '4' });
    assert.equal(config.name, 'Custom name');
    assert.equal(config.personality, persona.personality);
    assert.equal(config.role, persona.role);
    const { system } = buildReplyPrompt(config, [], { attachmentCount: 0 });
    assert.ok(system.includes(persona.personality));
    assert.ok(system.includes('Sign it as Custom name.'));
    assert.ok(system.includes('You cannot take actions'));
  }
});

test('temporary personalities do not apply to another organization, an unknown Aura, or name matches', () => {
  for (const row of [
    { id: 'aura_demo_001', org_id: 'other_org', name: 'Lyra' },
    { id: 'custom_aura', org_id: DEMO_ORG, name: 'Merlin' },
    { id: 'aura_demo_001', name: 'Lyra' },
  ]) assert.equal(auraConfig(row).personality, null);
});

test('imported persona fields replace the temporary personality without blending voices', () => {
  const row = { id: 'aura_demo_001', org_id: DEMO_ORG, name: 'Lyra' };
  for (const field of ['role', 'facet', 'personality', 'system_instructions']) {
    const config = auraConfig({ ...row, [field]: '345 team instructions, unchanged.' });
    assert.equal(config[field], '345 team instructions, unchanged.');
    const { system } = buildReplyPrompt(config, [], { attachmentCount: 0 });
    assert.ok(system.includes('345 team instructions, unchanged.'));
    assert.ok(!system.includes(DEMO_PERSONAS[0].personality));
  }
  assert.equal(auraConfig({ ...row, personality: '  ', system_instructions: null }).personality, DEMO_PERSONAS[0].personality);
  assert.equal(auraConfig({ ...row, blocklist: 'private information' }).personality, DEMO_PERSONAS[0].personality);
  assert.equal(auraConfig({ ...row, role: DEMO_PERSONAS[0].role }).personality, DEMO_PERSONAS[0].personality);
});

function demoRows(x) {
  for (const persona of DEMO_PERSONAS) {
    x.sql.prepare('INSERT INTO auras (id,org_id,name) VALUES (?,?,?)').run(persona.id, DEMO_ORG, persona.previousName);
    if (persona.id !== 'aura_demo_merlin') x.sql.prepare('INSERT INTO email_aura_policies (org_id,aura_id,tier) VALUES (?,?,?)').run(DEMO_ORG, persona.id, String(DEMO_PERSONAS.indexOf(persona) + 1));
  }
  return query => x.sql.prepare(query).all();
}

test('renaming is idempotent and preserves all four policies, routes, history, and Merlin', t => {
  const x = setup(t), query = demoRows(x);
  const tables = ['email_aura_policies', 'email_address_assignments', 'email_messages'];
  const before = tables.map(table => query(`SELECT * FROM ${table}`));
  renameDemoAuras(query);
  renameDemoAuras(query);
  for (const persona of DEMO_PERSONAS) assert.equal(x.sql.prepare('SELECT name FROM auras WHERE id=?').get(persona.id).name, persona.name);
  assert.deepEqual(tables.map(table => query(`SELECT * FROM ${table}`)), before);
});

test('renaming preserves custom names and refuses incomplete or foreign-owned demo identities', t => {
  const x = setup(t), query = demoRows(x);
  x.sql.exec("UPDATE auras SET name='My Lyra' WHERE id='aura_demo_001'");
  renameDemoAuras(query);
  assert.equal(x.sql.prepare("SELECT name FROM auras WHERE id='aura_demo_001'").get().name, 'My Lyra');
  for (const rows of [query('SELECT * FROM auras').filter(row => row.id === 'aura_demo_001'),
    DEMO_PERSONAS.slice(0, 4).map(persona => ({ id: persona.id, org_id: 'other_org', name: persona.previousName }))]) {
    let writes = 0;
    assert.throws(() => renameDemoAuras(sql => { if (sql.startsWith('UPDATE')) writes++; return rows; }), /No names changed/);
    assert.equal(writes, 0);
  }
});
