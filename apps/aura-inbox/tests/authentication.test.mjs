import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './harness.mjs';
import { DEMO_ACCOUNTS,DEMO_ORG,demoAccountSql } from '../scripts/demo-accounts.mjs';
import { tokenHash } from '../worker/auth-utils.ts';
const AURA='aura_demo_001';
async function authDemo(t) {
  const x=setup(t);
  x.sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_001','org_demo_001','Customer Support Aura'),('aura_demo_002','org_demo_001','Sales Aura'); INSERT INTO studio_members (org_id,member_id,role) VALUES ('org_demo_001','member_demo_001','member')");
  for(const file of ['provision-addresses','provision-governance'])x.sql.exec(readFileSync(new URL(`../scripts/${file}.sql`,import.meta.url),'utf8'));
  x.sql.exec(await demoAccountSql());
  Object.assign(x.env,{DEMO_ORG_ID:DEMO_ORG,DEMO_LOGIN_ENABLED:'true',GOVERNANCE_ADMIN_TOKEN:'legacy-admin-token',GOVERNANCE_REVIEWER_MEMBER_ID:'member_demo_001'});
  const call=(path,method='GET',body,cookie,headers={})=>x.request(path,{method,headers:{Origin:'https://inbox.example',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=(index=0,changes={},cookie)=>call('/api/auth/login','POST',{email:DEMO_ACCOUNTS[index].email,password:DEMO_ACCOUNTS[index].password,...changes},cookie);
  const cookieOf=response=>response.headers.get('set-cookie')?.split(';')[0];
  return {...x,call,login,cookieOf};
}

test('every inbox, body, attachment, health and management API requires a session; bearer credentials cannot bypass it',async t=>{
  const x=await authDemo(t);
  for(const path of ['/api/auras',`/api/auras/${AURA}/inbox`,`/api/auras/${AURA}/threads/example/messages`,`/api/auras/${AURA}/messages/example/body`,`/api/auras/${AURA}/messages/example/attachments/file`,'/api/manage/workspace','/api/manage/users','/api/manage/domains','/api/health']){
    assert.equal((await x.call(path)).status,401,path);
    assert.equal((await x.call(path,'GET',undefined,undefined,{Authorization:'Bearer legacy-admin-token'})).status,401,path);
  }
  assert.deepEqual(await (await x.call('/api/auth/session')).json(),{user:null,fixed_permissions:true});
});

for(const [index,account] of DEMO_ACCOUNTS.entries())test(`${account.role} can sign in and receives its fixed identity`,async t=>{
  const x=await authDemo(t),response=await x.login(index);
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.user.role,account.role);assert.equal(result.user.email,account.email);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const setCookie=response.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);assert.match(setCookie,/Secure/);assert.match(setCookie,/Max-Age=28800/);
  const cookie=x.cookieOf(response),session=await (await x.call('/api/auth/session','GET',undefined,cookie)).json();assert.equal(session.user.member_id,account.member_id);
  const stored=x.sql.prepare('SELECT token_hash FROM email_workspace_sessions WHERE member_id=?').get(account.member_id);
  assert.equal(stored.token_hash,await tokenHash(cookie.split('=')[1]));assert.ok(!JSON.stringify(result).includes(cookie.split('=')[1]));
  assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,200);
});

test('login validates credentials, ignores body roles and tenant IDs, and normalizes email case',async t=>{
  const x=await authDemo(t);
  const response=await x.login(2,{email:' REVIEWER@345.DEMO ',role:'admin',member_id:'member_demo_001',org_id:'other_org'});
  assert.equal(response.status,200);assert.equal((await response.json()).user.role,'reviewer');
  for(const body of [{email:'',password:'x'},{email:42,password:'x'},{email:'admin@345.demo',password:''},{email:'admin@345.demo',password:'x'.repeat(257)}])assert.equal((await x.call('/api/auth/login','POST',body)).status,400);
  const wrong=await x.login(0,{password:'wrong'}),unknown=await x.login(0,{email:'missing@345.demo'});
  assert.equal(wrong.status,401);assert.equal(unknown.status,401);assert.deepEqual(await wrong.json(),await unknown.json());assert.equal(wrong.headers.get('set-cookie'),null);
});

test('all fixed demo accounts reject user, role, permission and credential changes through the API',async t=>{
  const x=await authDemo(t);
  for(let index=0;index<3;index++){
    const cookie=x.cookieOf(await x.login(index));
    assert.equal((await x.call('/api/manage/users','GET',undefined,cookie)).status,index===0?200:403);
    for(const [path,method] of [['/api/manage/users','POST'],['/api/manage/users/member_demo_reviewer','PUT'],['/api/manage/users/member_demo_reviewer/credential','POST']]){
      assert.equal((await x.call(path,method,{role:'admin'},cookie)).status,403);
    }
  }
  assert.equal(x.sql.prepare("SELECT role FROM email_workspace_access WHERE org_id=? AND member_id='member_demo_reviewer'").get(DEMO_ORG).role,'reviewer');
});

test('reviewers can read assigned Auras and review messages but cannot configure workspace resources',async t=>{
  const x=await authDemo(t),cookie=x.cookieOf(await x.login(2));
  assert.equal((await x.call(`/api/auras/${AURA}/governance`,'GET',undefined,cookie)).status,200);
  for(const path of ['/api/manage/domains',`/api/manage/auras/${AURA}`])assert.equal((await x.call(path,'GET',undefined,cookie)).status,403);
  assert.equal((await x.call(`/api/auras/${AURA}/governance/policy`,'PUT',{tier:'4',version:1,rules:{}},cookie)).status,403);
  x.sql.prepare("UPDATE email_aura_reviewers SET revoked_at='2026-11-05T00:00:00.000Z' WHERE org_id=? AND aura_id=? AND member_id='member_demo_reviewer'").run(DEMO_ORG,AURA);
  const list=await (await x.call('/api/auras','GET',undefined,cookie)).json();assert.ok(!list.auras.some(a=>a.id===AURA));
  for(const path of [`/api/auras/${AURA}/inbox`,`/api/auras/${AURA}/threads/example/messages`,`/api/auras/${AURA}/messages/example/body`,`/api/auras/${AURA}/messages/example/attachments/file`,`/api/auras/${AURA}/governance`])assert.equal((await x.call(path,'GET',undefined,cookie)).status,404,path);
});

test('manager can configure Auras and policies with a session',async t=>{
  const x=await authDemo(t),cookie=x.cookieOf(await x.login(1));
  assert.equal((await x.call('/api/manage/domains','GET',undefined,cookie)).status,200);
  assert.equal((await x.call(`/api/auras/${AURA}/governance/policy`,'PUT',{tier:'2',version:1,rules:{}},cookie)).status,200);
  assert.equal((await x.call('/api/manage/auras','POST',{name:'Session managed Aura',tier:'1'},cookie)).status,201);
});

test('refresh preserves sessions; logout deletes the server session and makes its cookie unusable',async t=>{
  const x=await authDemo(t),cookie=x.cookieOf(await x.login());
  assert.equal((await x.call('/api/manage/workspace','GET',undefined,cookie)).status,200);
  const logout=await x.call('/api/auth/logout','POST',undefined,cookie);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,401);
  assert.equal((await (await x.call('/api/auth/session','GET',undefined,cookie)).json()).user,null);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM email_workspace_sessions').get().n,0);
});

test('sign-in rotates a preexisting session when switching accounts',async t=>{
  const x=await authDemo(t),old=x.cookieOf(await x.login()),next=x.cookieOf(await x.login(2,{},old));
  assert.notEqual(old,next);assert.equal((await x.call('/api/auras','GET',undefined,old)).status,401);
  assert.equal((await (await x.call('/api/auth/session','GET',undefined,next)).json()).user.role,'reviewer');
});

test('expired, forged, duplicated and cross-tenant session cookies fail closed',async t=>{
  const x=await authDemo(t),cookie=x.cookieOf(await x.login());
  for(const bad of ['aura_session=bogus','aura_session='+'f'.repeat(64),cookie+'; '+cookie])assert.equal((await x.call('/api/auras','GET',undefined,bad)).status,401);
  x.env.DEMO_ORG_ID='other_org';assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,401);x.env.DEMO_ORG_ID=DEMO_ORG;
  x.sql.exec('UPDATE email_workspace_sessions SET created_at=0,expires_at=1');assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,401);
});

test('suspending access or tampering with a fixed role invalidates existing sessions',async t=>{
  const x=await authDemo(t),cookie=x.cookieOf(await x.login(2));
  x.sql.exec("UPDATE email_workspace_access SET role='admin' WHERE member_id='member_demo_reviewer'");
  assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,401);
  x.sql.exec("UPDATE email_workspace_access SET role='reviewer',status='suspended' WHERE member_id='member_demo_reviewer'");
  assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,401);assert.equal((await x.login(2)).status,401);
});

test('login, logout, and session-authenticated changes require the exact same origin',async t=>{
  const x=await authDemo(t),cookie=x.cookieOf(await x.login());
  for(const origin of ['','https://hostile.example','https://inbox.example.hostile.example']) {
    assert.equal((await x.call('/api/auth/login','POST',{email:DEMO_ACCOUNTS[0].email,password:DEMO_ACCOUNTS[0].password},undefined,{Origin:origin})).status,403);
    assert.equal((await x.call('/api/auth/logout','POST',undefined,cookie,{Origin:origin})).status,403);
    assert.equal((await x.call('/api/manage/auras','POST',{name:'Forbidden'},cookie,{Origin:origin})).status,403);
  }
  assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,200);
});

test('persistent login throttling catches case variants and prevents more password work after the limit',async t=>{
  const x=await authDemo(t);
  for(let i=0;i<10;i++)assert.equal((await x.login(0,{email:i%2?' ADMIN@345.DEMO ':'admin@345.demo',password:'wrong'})).status,401);
  const blocked=await x.login();assert.equal(blocked.status,429);assert.equal(blocked.headers.get('Retry-After'),'900');
  x.sql.exec('UPDATE email_workspace_login_limits SET expires_at=0');assert.equal((await x.login()).status,200);
});

test('reprovisioning dummy accounts revokes old sessions and preserves email history',async t=>{
  const x=await authDemo(t),cookie=x.cookieOf(await x.login());
  const before=x.sql.prepare('SELECT count(*) AS n FROM email_messages').get().n;
  x.sql.exec(await demoAccountSql());
  assert.equal((await x.call('/api/auras','GET',undefined,cookie)).status,401);assert.equal((await x.login()).status,200);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM email_messages').get().n,before);assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('login migration is additive and repeatable and sessions cannot reference another tenant',async t=>{
  const x=await authDemo(t);
  x.sql.exec(readFileSync(new URL('../../../scripts/0004_email_workspace_login.sql',import.meta.url),'utf8'));
  assert.throws(()=>x.sql.prepare('INSERT INTO email_workspace_sessions (token_hash,org_id,member_id,created_at,expires_at) VALUES (?,?,?,?,?)').run('a'.repeat(64),'other_org','member_demo_001',1,2),/FOREIGN KEY/);
  assert.throws(()=>x.sql.prepare('INSERT INTO email_workspace_sessions (token_hash,org_id,member_id,created_at,expires_at) VALUES (?,?,?,?,?)').run('b'.repeat(64),DEMO_ORG,'member_demo_001',2,1),/CHECK/);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});


test('omitted or misspelled login configuration never restores public inbox access',async t=>{
  const x=await authDemo(t);
  for(const flag of [undefined,'','True','disabled']){
    x.env.DEMO_LOGIN_ENABLED=flag;
    assert.equal((await x.call('/api/auras')).status,401);
    assert.equal((await x.call('/api/manage/users','GET',undefined,undefined,{Authorization:'Bearer legacy-admin-token'})).status,401);
    assert.equal((await x.login()).status,200);
  }
});
