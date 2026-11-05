import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { planDemoLogins } from '../scripts/provision-demo-logins.mjs';

for(const live of [false,true])test(`auth-only provisioning handles ${live?'live minimal':'fixture'} parent membership and preserves rerun state`,async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  sql.exec(live?"CREATE TABLE auras (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,name TEXT NOT NULL,UNIQUE(org_id,id)); CREATE TABLE studio_members (member_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT,UNIQUE(org_id,member_id));":readFileSync(new URL('../../../tests/email/fixtures/studio_parents_2026_10_22.sql',import.meta.url),'utf8'));
  for(const f of ['0001_email_model.sql','0002_email_governance.sql','0003_email_workspace_access.sql','0004_email_workspace_login.sql'])sql.exec(readFileSync(new URL('../../../scripts/'+f,import.meta.url),'utf8'));
  sql.exec(live?"INSERT INTO studio_members (org_id,member_id,name,email) VALUES ('org_demo_001','member_demo_001','Original name','original@example.invalid')":"INSERT INTO studio_members (org_id,member_id,role) VALUES ('org_demo_001','member_demo_001','original-role')");
  for(let i=1;i<=4;i++)sql.prepare('INSERT INTO auras (id,org_id,name) VALUES (?,?,?)').run('aura_demo_00'+i,'org_demo_001','Aura '+i);
  const query=q=>sql.prepare(q).all(),parent=JSON.stringify(query("SELECT * FROM studio_members WHERE member_id='member_demo_001'"));
  sql.exec(await planDemoLogins(query));
  assert.equal(JSON.stringify(query("SELECT * FROM studio_members WHERE member_id='member_demo_001'")),parent);
  sql.exec("INSERT INTO email_workspace_sessions (token_hash,org_id,member_id,created_at,expires_at) VALUES ('"+'f'.repeat(64)+"','org_demo_001','member_demo_001',1,9999999999); UPDATE email_aura_reviewers SET revoked_at='2026-11-05T00:00:00.000Z' WHERE member_id='member_demo_reviewer';");
  const tables=['email_workspace_access','email_workspace_logins','email_workspace_sessions','email_aura_reviewers','email_messages','email_reviews','email_aura_policies'];
  const before=Object.fromEntries(tables.map(table=>[table,JSON.stringify(query('SELECT * FROM '+table))]));
  sql.exec(await planDemoLogins(query));
  for(const table of tables)assert.equal(JSON.stringify(query('SELECT * FROM '+table)),before[table],table);
  assert.deepEqual(query('PRAGMA foreign_key_check'),[]);
  sql.prepare("UPDATE email_workspace_access SET email='conflict@example.invalid' WHERE member_id='member_demo_manager'").run();
  await assert.rejects(planDemoLogins(query),/conflicts/);
});
