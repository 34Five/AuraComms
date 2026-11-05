import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, ORG, SALES, SUPPORT } from './harness.mjs';
import { Governance } from '../worker/governance.ts';
import { tokenHash } from '../worker/management-auth.ts';

const ADMIN='e07_demo_reviewer', BOOTSTRAP='bootstrap-credential';
function demo(t) {
  const x=setup(t);
  Object.assign(x.env,{GOVERNANCE_ADMIN_TOKEN:BOOTSTRAP,GOVERNANCE_REVIEWER_MEMBER_ID:ADMIN});
  x.sql.exec("UPDATE email_aura_policies SET tier='1'");
  const call=(path='',method='GET',body,token=BOOTSTRAP,extra={})=>x.request('/api'+path,{method,headers:{Authorization:`Bearer ${token}`,Origin:'https://inbox.example',...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const user=async(role='reviewer',email=role+'@example.invalid')=>{
    const response=await call('/manage/users','POST',{name:role+' Person',email,role,org_id:'other_org',member_id:'spoofed'});
    const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));return data;
  };
  const list=async()=> (await (await call('/manage/users')).json()).users;
  const update=async(id,changes={},token=BOOTSTRAP)=>{
    const u=(await list()).find(u=>u.id===id);
    return call('/manage/users/'+id,'PUT',{name:u.name,email:u.email,role:u.role,status:u.status,version:u.version,...changes},token);
  };
  const assign=(id,aura=SALES)=>call(`/manage/auras/${aura}/reviewers/${id}`,'PUT',{});
  const compose=async()=>{
    const response=await call(`/auras/${SALES}/governance/compose`,'POST',{to:'alex@example.invalid',subject:'Review test',text:'Please review this email.'});
    const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));return data;
  };
  return {...x,call,user,list,update,assign,compose,g:new Governance(x.env)};
}

test('migration is repeatable, preserves mail and enforces tenant keys and enum constraints', t=>{
  const x=demo(t), count=x.sql.prepare('SELECT count(*) AS n FROM email_messages').get().n;
  x.sql.exec(readFileSync(new URL('../../../scripts/0003_email_workspace_access.sql',import.meta.url),'utf8'));
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM email_messages').get().n,count);
  assert.throws(()=>x.sql.prepare('INSERT INTO email_workspace_access (org_id,member_id,display_name,role) VALUES (?,?,?,?)').run('other_org',ADMIN,'Test','admin'),/FOREIGN KEY/);
  assert.throws(()=>x.sql.prepare('INSERT INTO email_workspace_access (org_id,member_id,display_name,role) VALUES (?,?,?,?)').run(ORG,ADMIN,'Test','owner'),/CHECK/);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('bootstrap identity stays compatible and missing migration fails closed with a clear status',async t=>{
  const x=demo(t),data=await (await x.call('/manage/workspace')).json();
  assert.equal(data.role,'admin');assert.equal(data.member_id,ADMIN);
  assert.equal((await x.call('/manage/users','GET',undefined,'')).status,401);
  assert.equal((await x.call('/manage/users','GET',undefined,'bad-token')).status,401);
  x.sql.exec('DROP TABLE email_workspace_credentials');
  assert.equal((await x.call('/manage/users')).status,503);
});

test('new users get independent random credentials; list and audit never expose secrets',async t=>{
  const x=demo(t),u=await x.user();
  assert.match(u.credential,/^aura_[a-f0-9]{64}$/);assert.notEqual(u.member_id,'spoofed');
  const row=x.sql.prepare('SELECT * FROM email_workspace_credentials WHERE member_id=?').get(u.member_id);
  assert.equal(row.org_id,ORG);assert.equal(row.token_hash,await tokenHash(u.credential));
  assert.notEqual(row.token_hash,u.credential);
  const response=await x.call('/manage/users'),body=await response.text();
  assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(!body.includes(u.credential));assert.ok(!body.includes(row.token_hash));
  const identity=await (await x.call('/manage/workspace','GET',undefined,u.credential)).json();
  assert.equal(identity.member_id,u.member_id);assert.equal(identity.role,'reviewer');assert.deepEqual(identity.members,[]);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

for (const role of ['manager','reviewer']) test(`${role} cannot read or change user access, even with a spoofed admin body`,async t=>{
  const x=demo(t),u=await x.user(role);
  for (const [path,method,body] of [['','GET'],['','POST',{name:'Admin',role:'admin',member_id:ADMIN}],['/'+ADMIN,'PUT',{role:'admin'}],['/'+ADMIN+'/credential','POST',{version:0}]]) {
    assert.equal((await x.call('/manage/users'+path,method,body,u.credential)).status,403);
  }
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM email_workspace_access_events').get().n,1);
});

test('manager can configure Auras and domains; reviewer cannot change any configuration',async t=>{
  const x=demo(t),manager=await x.user('manager'),reviewer=await x.user();
  const response=await x.call('/manage/auras','POST',{name:'Managed Aura',tier:'1'},manager.credential);
  assert.equal(response.status,201);const aura=(await response.json()).aura.id;
  assert.equal((await x.call('/manage/domains','GET',undefined,manager.credential)).status,200);
  assert.equal((await x.call(`/auras/${aura}/governance/policy`,'PUT',{tier:'2',version:1,rules:{}},manager.credential)).status,200);
  for(const [path,method,body] of [['/manage/auras','POST',{name:'Forbidden'}],[`/manage/auras/${SALES}`,'GET'],['/manage/domains','GET'],[`/manage/auras/${SALES}/reviewers/${reviewer.member_id}`,'PUT',{}]]) {
    assert.equal((await x.call(path,method,body,reviewer.credential)).status,403);
  }
});

test('reviewer must be assigned and can approve and send while configuration actions stay forbidden',async t=>{
  const x=demo(t),u=await x.user();
  assert.equal((await x.call(`/auras/${SALES}/governance`,'GET',undefined,u.credential)).status,403);
  assert.equal((await x.assign(u.member_id)).status,200);
  const workspace=await (await x.call('/manage/workspace','GET',undefined,u.credential)).json();
  assert.deepEqual(workspace.reviewer_aura_ids,[SALES]);
  assert.equal((await x.call(`/auras/${SALES}/governance`,'GET',undefined,u.credential)).status,200);
  assert.equal((await x.call(`/auras/${SUPPORT}/governance`,'GET',undefined,u.credential)).status,403);
  x.sql.exec("INSERT INTO email_domains (id,org_id,domain,domain_key,kind,status,verified_at,activated_at) VALUES ('test_domain','e07_demo_org','34five.studio','34five.studio','custom','active','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'); INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key) VALUES ('test_address','e07_demo_org','test_domain','nova','nova@34five.studio','nova@34five.studio'); INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at) VALUES ('test_assignment','e07_demo_org','test_address','e07_demo_aura_sales','2026-11-01T00:00:00.000Z');");
  const d=await x.compose();
  for (const [path,method,body] of [['governance/policy','PUT',{tier:'4',version:1,rules:{}}],['governance/policy','DELETE',{version:1}],['governance/compose','POST',{}],[`messages/${d.message_id}/edit`,'POST',{}],[`messages/${d.message_id}/cancel`,'POST'],[`messages/${d.message_id}/evaluate`,'POST'],[`threads/${d.thread_id}/reset`,'POST']]) {
    assert.equal((await x.call(`/auras/${SALES}/${path}`,method,body,u.credential)).status,403,path);
  }
  assert.equal((await x.call(`/auras/${SALES}/reviews/${d.review.id}/decide`,'POST',{outcome:'approved',member_id:ADMIN},u.credential)).status,200);
  assert.equal((await x.g.review(SALES,d.review.id)).approver_member_id,u.member_id);
  const sent=[];x.env.EMAIL={async send(){sent.push(1);return {messageId:'<reviewed@example.invalid>'};}};
  assert.equal((await x.call(`/auras/${SALES}/reviews/${d.review.id}/send`,'POST',undefined,u.credential)).status,200);assert.equal(sent.length,1);
});

test('suspension revokes credentials and approvals, and reactivation cannot revive either',async t=>{
  const x=demo(t),u=await x.user();await x.assign(u.member_id);const d=await x.compose();
  await x.g.decide(SALES,d.review.id,u.member_id,'approved');
  const count=x.sql.prepare('SELECT count(*) AS n FROM email_messages').get().n;
  assert.equal((await x.update(u.member_id,{status:'suspended'})).status,200);
  assert.equal((await x.call('/manage/workspace','GET',undefined,u.credential)).status,401);
  await assert.rejects(x.g.reviewer(SALES,u.member_id),/active designated reviewer/);
  assert.equal((await x.g.review(SALES,d.review.id)).status,'superseded');
  assert.equal((await x.assign(u.member_id)).status,409);
  assert.equal((await x.update(u.member_id,{status:'active'})).status,200);
  assert.equal((await x.call('/manage/workspace','GET',undefined,u.credential)).status,401);
  assert.equal((await x.call(`/auras/${SALES}/reviews/${d.review.id}/send`,'POST')).status,409);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM email_messages').get().n,count);
});

test('role changes apply immediately and invalidate unsent approvals',async t=>{
  const x=demo(t),u=await x.user('manager');await x.assign(u.member_id);const d=await x.compose();await x.g.decide(SALES,d.review.id,u.member_id,'approved');
  assert.equal((await x.update(u.member_id,{role:'reviewer'})).status,200);
  assert.equal((await x.g.review(SALES,d.review.id)).status,'superseded');
  assert.equal((await x.call('/manage/domains','GET',undefined,u.credential)).status,403);
  assert.equal((await (await x.call('/manage/workspace','GET',undefined,u.credential)).json()).role,'reviewer');
});

test('credential reset revokes the previous key and bootstrap secrets stay revoked after suspension',async t=>{
  const x=demo(t),u=await x.user(),secondAdmin=await x.user('admin');
  const r=await x.call(`/manage/users/${u.member_id}/credential`,'POST',{version:1});assert.equal(r.status,200);const next=await r.json();
  assert.notEqual(next.credential,u.credential);assert.equal((await x.call('/manage/workspace','GET',undefined,u.credential)).status,401);
  assert.equal((await x.call('/manage/workspace','GET',undefined,next.credential)).status,200);
  assert.equal((await x.update(ADMIN,{name:'Original Admin',status:'suspended'},secondAdmin.credential)).status,200);
  assert.equal((await x.call('/manage/workspace')).status,401);
  // Reactivate with the second administrator; the bootstrap key must never revive.
  const saved=x.sql.prepare('SELECT * FROM email_workspace_access WHERE member_id=?').get(ADMIN);
  assert.equal((await x.call(`/manage/users/${ADMIN}`,'PUT',{name:saved.display_name,email:null,role:'admin',status:'active',version:saved.version},secondAdmin.credential)).status,200);
  assert.equal((await x.call('/manage/workspace')).status,401);
  const reset=await x.call(`/manage/users/${ADMIN}/credential`,'POST',{version:2},secondAdmin.credential);assert.equal(reset.status,200);
  assert.equal((await x.call('/manage/workspace','GET',undefined,(await reset.json()).credential)).status,200);
});

test('admins cannot demote or suspend themselves; the last administrator remains protected',async t=>{
  const x=demo(t);
  assert.equal((await x.update(ADMIN,{role:'manager'})).status,409);
  assert.equal((await x.update(ADMIN,{status:'suspended'})).status,409);
  assert.equal((await x.call(`/manage/users/${ADMIN}/credential`,'POST',{version:0})).status,409);
  assert.equal((await x.update(ADMIN,{name:'Workspace Admin'})).status,200);
  assert.equal(x.sql.prepare('SELECT role FROM studio_members WHERE member_id=?').get(ADMIN).role,'admin');
});

test('version conflicts serialize competing edits and credential resets',async t=>{
  const x=demo(t),u=await x.user();
  const body={name:'Edited',email:'edited@example.invalid',role:'manager',status:'active',version:1};
  const responses=await Promise.all([x.call(`/manage/users/${u.member_id}`,'PUT',body),x.call(`/manage/users/${u.member_id}`,'PUT',body)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal((await x.call(`/manage/users/${u.member_id}/credential`,'POST',{version:1})).status,409);
});

test('invalid names, roles, JSON, duplicate emails and foreign users cannot partially change access',async t=>{
  const x=demo(t);await x.user('manager','shared@example.invalid');
  for(const body of [{name:'',role:'admin'},{name:'Bad\nName',role:'admin'},{name:'Test',role:'owner'},{name:'Test',role:'reviewer',email:42},{name:'Test',role:'reviewer',email:'not-email'}]) {
    assert.equal((await x.call('/manage/users','POST',body)).status,400);
  }
  assert.equal((await x.call('/manage/users','POST',{name:'Duplicate',role:'reviewer',email:' SHARED@EXAMPLE.INVALID '})).status,409);
  assert.equal((await x.call('/manage/users','POST',{name:'x'.repeat(17000),role:'reviewer'})).status,413);
  assert.equal((await x.call('/manage/users','POST',undefined)).status,415);
  assert.equal((await x.call('/manage/users/foreign_user','PUT',{})).status,404);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM email_workspace_access_events').get().n,1);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM email_workspace_credentials').get().n,1);
});

test('individual credentials remain tenant-scoped and independent of the bootstrap configuration',async t=>{
  const x=demo(t),u=await x.user('admin');
  x.env.GOVERNANCE_ADMIN_TOKEN=undefined;x.env.GOVERNANCE_REVIEWER_MEMBER_ID=undefined;
  assert.equal((await x.call('/manage/users','GET',undefined,u.credential)).status,200);
  x.env.DEMO_ORG_ID='other_org';assert.equal((await x.call('/manage/users','GET',undefined,u.credential)).status,401);
});

test('all user mutations require same-origin requests and membership still exists at authentication',async t=>{
  const x=demo(t);
  assert.equal((await x.call('/manage/users','POST',{name:'Bad',role:'admin'},BOOTSTRAP,{Origin:'https://hostile.example'})).status,403);
  const u=await x.user('admin');
  // A parent membership cannot be removed while access and credentials reference it.
  assert.throws(()=>x.sql.prepare('DELETE FROM studio_members WHERE org_id=? AND member_id=?').run(ORG,u.member_id),/FOREIGN KEY/);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('granting access to an existing membership preserves the parent role and requires a new credential',async t=>{
  const x=demo(t);
  x.sql.prepare('INSERT INTO studio_members (org_id,member_id,role) VALUES (?,?,?)').run(ORG,'existing_member','developer');
  const existing=(await x.list()).find(u=>u.id==='existing_member');
  assert.equal(existing.status,'unconfigured');assert.equal(existing.role,null);assert.equal(existing.version,0);
  assert.equal((await x.assign(existing.id)).status,409);
  assert.equal((await x.update(existing.id,{name:'Existing Member',role:'reviewer',status:'active'})).status,200);
  assert.equal(x.sql.prepare('SELECT role FROM studio_members WHERE org_id=? AND member_id=?').get(ORG,existing.id).role,'developer');
  const response=await x.call(`/manage/users/${existing.id}/credential`,'POST',{version:1});assert.equal(response.status,200);
  assert.equal((await x.call('/manage/workspace','GET',undefined,(await response.json()).credential)).status,200);
  assert.equal((await x.assign(existing.id)).status,200);
});

test('an audit write failure rolls back membership, access and credential creation together',async t=>{
  const x=demo(t),before=x.sql.prepare('SELECT count(*) AS n FROM studio_members').get().n;
  const batch=x.env.DB.batch;
  x.env.DB.batch=statements=>batch([...statements,x.env.DB.prepare('SELECT * FROM nonexistent_audit_table')]);
  assert.equal((await x.call('/manage/users','POST',{name:'Failed User',role:'admin'})).status,500);
  assert.equal(x.sql.prepare('SELECT count(*) AS n FROM studio_members').get().n,before);
  for(const table of ['email_workspace_access','email_workspace_credentials','email_workspace_access_events']) assert.equal(x.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
});

test('competing administrators cannot remove all administrator access',async t=>{
  const x=demo(t),second=await x.user('admin');
  const [firstResult,secondResult]=await Promise.all([
    x.call(`/manage/users/${second.member_id}`,'PUT',{name:'Second Admin',email:null,role:'manager',status:'active',version:1}),
    x.call(`/manage/users/${ADMIN}`,'PUT',{name:'Original Admin',email:null,role:'manager',status:'active',version:0},second.credential),
  ]);
  assert.deepEqual([firstResult.status,secondResult.status],[200,403]);
  assert.equal((await x.list()).filter(u=>u.role==='admin'&&u.status==='active').length,1);
});
