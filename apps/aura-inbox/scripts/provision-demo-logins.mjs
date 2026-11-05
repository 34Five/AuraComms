import { execFileSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { DEMO_ACCOUNTS,DEMO_ORG,sqlValue as q } from './demo-accounts.mjs';
import { passwordHash,randomHex,PASSWORD_ITERATIONS } from '../worker/password.ts';

// Provision authentication only. Never run local fixtures, address migrations, or account resets here.
export async function planDemoLogins(query) {
  const columns=query("SELECT name,\"notnull\" AS required,dflt_value FROM pragma_table_info('studio_members')");
  const supplied=new Set(['org_id','member_id','name','email','role']);
  if(!columns.some(c=>c.name==='member_id') || !columns.some(c=>c.name==='org_id') || columns.some(c=>c.required&&!c.dflt_value&&!supplied.has(c.name))) throw new Error('Unsupported workspace membership schema. No changes made.');
  const needed=['email_workspace_access','email_workspace_logins','email_workspace_sessions','email_workspace_login_limits'];
  if(query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${needed.map(q).join(',')})`).length!==needed.length)throw new Error('Apply migrations 0003 and 0004 before provisioning.');
  const ids=DEMO_ACCOUNTS.map(a=>q(a.member_id)).join(','),emails=DEMO_ACCOUNTS.map(a=>q(a.email)).join(',');
  const members=query(`SELECT * FROM studio_members WHERE member_id IN (${ids})`);
  const access=query(`SELECT * FROM email_workspace_access WHERE org_id=${q(DEMO_ORG)} AND (member_id IN (${ids}) OR lower(email) IN (${emails}))`);
  const logins=query(`SELECT * FROM email_workspace_logins WHERE org_id=${q(DEMO_ORG)} AND (member_id IN (${ids}) OR login_key IN (${emails}))`);
  const auras=query(`SELECT id FROM auras WHERE org_id=${q(DEMO_ORG)} AND id IN ('aura_demo_001','aura_demo_002','aura_demo_003','aura_demo_004')`);
  if(auras.length!==4)throw new Error('The four existing demo Auras are required. No changes made.');
  for(const a of DEMO_ACCOUNTS){
    if(members.some(m=>m.member_id===a.member_id&&m.org_id!==DEMO_ORG))throw new Error('A demo member ID belongs to another organization.');
    if(access.some(r=>(r.member_id===a.member_id||r.email?.toLowerCase()===a.email)&&(r.member_id!==a.member_id||r.email!==a.email||r.role!==a.role||r.status!=='active')))throw new Error('Existing app access conflicts with a demo account.');
    if(logins.some(r=>(r.member_id===a.member_id||r.login_key===a.email)&&(r.member_id!==a.member_id||r.login_key!==a.email)))throw new Error('Existing login ownership conflicts with a demo account.');
    const login=logins.find(l=>l.member_id===a.member_id);
    if(login && login.password_hash!==await passwordHash(a.password,login.password_salt))throw new Error('An existing password differs. This command never resets credentials.');
  }
  const guards=[];
  for(const [table,rows,where] of [['studio_members',members,`member_id IN (${ids})`],['email_workspace_access',access,`org_id=${q(DEMO_ORG)} AND (member_id IN (${ids}) OR lower(email) IN (${emails}))`],['email_workspace_logins',logins,`org_id=${q(DEMO_ORG)} AND (member_id IN (${ids}) OR login_key IN (${emails}))`]]){
    guards.push(`(SELECT COUNT(*) FROM ${table} WHERE ${where})=${rows.length}`);
    for(const row of rows)guards.push(`EXISTS (SELECT 1 FROM ${table} WHERE ${Object.entries(row).map(([k,v])=>`"${k}" IS ${v===null?'NULL':q(v)}`).join(' AND ')})`);
  }
  const statements=[`SELECT json(CASE WHEN ${guards.join(' AND ')} THEN '{}' ELSE 'Demo identity changed during provisioning' END);`];
  for(const a of DEMO_ACCOUNTS){
    if(!members.some(m=>m.member_id===a.member_id)){
      const values={org_id:DEMO_ORG,member_id:a.member_id,name:a.name,email:a.email,role:'member'};
      const names=columns.map(c=>c.name).filter(name=>Object.hasOwn(values,name));
      statements.push(`INSERT INTO studio_members (${names.join(',')}) VALUES (${names.map(n=>q(values[n])).join(',')});`);
    }
    if(!access.some(r=>r.member_id===a.member_id)) statements.push(`INSERT INTO email_workspace_access (org_id,member_id,display_name,email,role,bootstrap_revoked) VALUES (${q(DEMO_ORG)},${q(a.member_id)},${q(a.name)},${q(a.email)},${q(a.role)},1);`);
    if(!logins.some(l=>l.member_id===a.member_id)){
      const salt=randomHex(16),hash=await passwordHash(a.password,salt);
      statements.push(`INSERT INTO email_workspace_logins (org_id,member_id,login_key,password_salt,password_hash,password_iterations) VALUES (${q(DEMO_ORG)},${q(a.member_id)},${q(a.email)},${q(salt)},${q(hash)},${PASSWORD_ITERATIONS});`);
    }
    statements.push(`INSERT INTO email_aura_reviewers (org_id,aura_id,member_id,configured_by_member_id) SELECT org_id,id,${q(a.member_id)},'member_demo_001' FROM auras WHERE org_id=${q(DEMO_ORG)} AND id IN ('aura_demo_001','aura_demo_002','aura_demo_003','aura_demo_004') ON CONFLICT(org_id,aura_id,member_id) DO NOTHING;`);
  }
  return statements.join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const flags=process.argv.slice(2);
  if(flags.length!==1 || !['--local','--remote'].includes(flags[0]))throw new Error('Specify exactly --local or --remote.');
  const cwd=fileURLToPath(new URL('../',import.meta.url)),cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
  const args=[cli,'d1','execute','DB',flags[0],'--json',...(flags[0]==='--local'?['--persist-to','.wrangler/login-demo']:[])];
  const env={...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:join(tmpdir(),'34five-provision-logins-wrangler.log')};
  const query=sql=>JSON.parse(execFileSync(process.execPath,[...args,'--command',sql],{cwd,encoding:'utf8',env}))[0].results;
  const sql=await planDemoLogins(query),temp=mkdtempSync(join(tmpdir(),'34five-provision-logins-'));
  try{
    const path=join(temp,'logins.sql');writeFileSync(path,sql,{mode:0o600});
    execFileSync(process.execPath,[...args,'--file',path],{cwd,encoding:'utf8',env});
    if(query('PRAGMA foreign_key_check').length)throw new Error('Workspace foreign key verification failed.');
    console.log('Provisioned fixed demo logins. Existing passwords, sessions, reviewer revocations, and email history were preserved.');
    console.table(DEMO_ACCOUNTS.map(({email,role})=>({email,role})));
  }finally{rmSync(temp,{recursive:true,force:true});}
}
