import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ORG,DEMO_ACCOUNTS,demoAccountSql,sqlValue } from './demo-accounts.mjs';
import { migrateDemoAuraEmails } from './migrate-persona-emails.mjs';

if(process.argv.length>2)throw new Error('This command only initializes the isolated local demo. It does not accept remote or custom database options.');
const cwd=fileURLToPath(new URL('../',import.meta.url));
const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const args=[cli,'d1','execute','DB','--local','--persist-to','.wrangler/login-demo','--json'];
const env={...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:join(tmpdir(),'34five-demo-setup-wrangler.log')};
const query=sql=>JSON.parse(execFileSync(process.execPath,[...args,'--command',sql],{cwd,encoding:'utf8',env}))[0].results;
const temp=mkdtempSync(join(tmpdir(),'34five-demo-setup-'));
const execute=sql=>{
  const path=join(temp,'setup.sql');writeFileSync(path,sql,{mode:0o600});
  execFileSync(process.execPath,[...args,'--file',path],{cwd,encoding:'utf8',env});
};
try {
  const tables=query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('auras','studio_members')");
  if(tables.length===0){
    execute(readFileSync(new URL('../../../tests/email/fixtures/studio_parents_2026_10_22.sql',import.meta.url),'utf8'));
  } else if(tables.length!==2) throw new Error('The local demo has incomplete parent tables. Inspect it before setup.');
  for(const file of ['0001_email_model.sql','0002_email_governance.sql','0003_email_workspace_access.sql','0004_email_workspace_login.sql','0005_email_address_provisioning.sql']){
    // Existing schema migrations are not repeatable. Check their primary table first.
    const table={'0001_email_model.sql':'email_domains','0002_email_governance.sql':'email_reviews','0003_email_workspace_access.sql':'email_workspace_access','0004_email_workspace_login.sql':'email_workspace_logins','0005_email_address_provisioning.sql':'email_address_provisioning'}[file];
    const applied=file==='0002_email_governance.sql'?query("SELECT name FROM pragma_table_info('email_reviews') WHERE name='decision_source'").length:query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=${sqlValue(table)}`).length;
    if(!applied) execute(readFileSync(new URL('../../../scripts/'+file,import.meta.url),'utf8'));
  }
  const auras=query("SELECT id,org_id FROM auras WHERE id IN ('aura_demo_001','aura_demo_002','aura_demo_003','aura_demo_004')");
  if(auras.some(a=>a.org_id!==DEMO_ORG))throw new Error('Demo Aura IDs belong to another organization.');
  const access=query(`SELECT org_id,member_id,email FROM email_workspace_access WHERE org_id=${sqlValue(DEMO_ORG)}`);
  for(const account of DEMO_ACCOUNTS){
    const own=access.find(a=>a.member_id===account.member_id);
    if(own && own.email!==account.email)throw new Error('A demo member ID already has unrelated app access.');
    if(access.some(a=>a.email?.toLowerCase()===account.email && a.member_id!==account.member_id))throw new Error('A demo email belongs to another member.');
  }
  const logins=query(`SELECT member_id,login_key FROM email_workspace_logins WHERE org_id=${sqlValue(DEMO_ORG)}`);
  if(logins.some(l=>DEMO_ACCOUNTS.some(a=>(l.member_id===a.member_id||l.login_key===a.email)&&(l.member_id!==a.member_id||l.login_key!==a.email))))throw new Error('A demo login identity conflicts with existing data.');
  execute("INSERT INTO studio_members (org_id,member_id,role) VALUES ('org_demo_001','member_demo_001','member') ON CONFLICT(org_id,member_id) DO NOTHING; INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_001','org_demo_001','Customer Support Aura'),('aura_demo_002','org_demo_001','Sales Aura') ON CONFLICT(id) DO NOTHING;");
  execute(readFileSync(new URL('./provision-addresses.sql',import.meta.url),'utf8'));
  execute(readFileSync(new URL('./provision-governance.sql',import.meta.url),'utf8'));
  migrateDemoAuraEmails({query,execute});
  execute(await demoAccountSql());
  if(query('PRAGMA foreign_key_check').length)throw new Error('Local demo foreign key verification failed.');
  console.log('Local demo accounts are ready. Existing demo sessions were signed out.');
  console.table(DEMO_ACCOUNTS.map(({email,password,role})=>({email,password,role})));
  console.log('Start the local app with npm run demo:worker. Open http://127.0.0.1:8788.');
} finally {rmSync(temp,{recursive:true,force:true});}
