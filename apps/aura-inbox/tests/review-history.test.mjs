import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup} from './harness.mjs';
import {DEMO_ACCOUNTS,DEMO_ORG,demoAccountSql} from '../scripts/demo-accounts.mjs';
import {SendError} from '../worker/generated-sender.ts';
const AURA='aura_demo_001';
async function historyDemo(t) {
  const x=setup(t);
  x.sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_001','org_demo_001','Orbi'),('aura_demo_002','org_demo_001','Daniel'); INSERT INTO studio_members (org_id,member_id,role) VALUES ('org_demo_001','member_demo_001','member')");
  for(const name of ['provision-addresses','provision-governance'])x.sql.exec(readFileSync(new URL(`../scripts/${name}.sql`,import.meta.url),'utf8'));
  x.sql.exec(await demoAccountSql());Object.assign(x.env,{DEMO_ORG_ID:DEMO_ORG,DEMO_LOGIN_ENABLED:'true'});
  const cookies=[];for(const a of DEMO_ACCOUNTS){
    const r=await x.request('/api/auth/login',{method:'POST',headers:{Origin:'https://inbox.example','Content-Type':'application/json'},body:JSON.stringify({email:a.email,password:a.password})});
    assert.equal(r.status,200);cookies.push(r.headers.get('set-cookie').split(';')[0]);
  }
  const call=(path,method='GET',body,cookie=cookies[0])=>x.request(path,{method,headers:{Origin:'https://inbox.example',Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const sent=[];x.env.EMAIL={async send(m){sent.push(m);return {messageId:'<history@example.invalid>'};}};
  const base=`/api/auras/${AURA}`;
  const compose=async(aura=AURA)=>{const r=await call(`/api/auras/${aura}/governance/compose`,'POST',{to:'alex@example.invalid',subject:'History test',text:'Original text'});assert.equal(r.status,201);return r.json();};
  const draft=await compose();
  const path=`${base}/messages/${draft.message_id}/reviews`;
  const history=async(suffix='',cookie=cookies[0])=>{const r=await call(path+suffix,'GET',undefined,cookie);assert.equal(r.status,200);return r.json();};
  const decide=(review,outcome='approved',cookie=cookies[0])=>call(`${base}/reviews/${review}/decide`,'POST',{outcome},cookie);
  const edit=async(text='Updated text')=>{const r=await call(`${base}/messages/${draft.message_id}/edit`,'POST',{subject:'Updated subject',text});assert.equal(r.status,200);return (await r.json()).review;};
  return {...x,cookies,call,compose,base,draft,path,history,decide,edit,sent};
}
function append(x,message,from,to){
  x.sql.prepare("UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND message_id=?").run(DEMO_ORG,AURA,message);
  const insert=x.sql.prepare(`INSERT INTO email_reviews (id,org_id,aura_id,message_id,revision,tier_applied,status,decision_source,reason,requested_at)
    VALUES (?,?,?,?,?,'1','superseded','human','tier_1_every_message','2026-11-06T00:00:00.000Z')`);
  for(let n=from;n<=to;n++)insert.run(`${message}-r${n}`,DEMO_ORG,AURA,message,n);
}

test('history preserves recorded metadata through approve-edit-reapprove-send without inferring old outcomes',async t=>{
  const x=await historyDemo(t);
  assert.equal((await x.decide(x.draft.review.id,'approved',x.cookies[2])).status,200);
  const next=await x.edit();await x.decide(next.id);
  assert.equal((await x.call(`${x.base}/reviews/${next.id}/send`,'POST',{})).status,200);
  const page=await x.history();assert.deepEqual(page.reviews.map(r=>[r.revision,r.status]),[[2,'sent'],[1,'superseded']]);
  const [latest,old]=page.reviews;
  assert.deepEqual(old.reviewer,{member_id:'member_demo_reviewer',display_name:'Demo Reviewer'});
  assert.ok(old.decided_at);assert.equal(old.sent_at,null);assert.equal(old.decision_source,'human');
  assert.equal(latest.edited_before_send,true);assert.ok(latest.sent_at);assert.ok(latest.requested_at);assert.equal(x.sent.length,1);
  assert.doesNotMatch(JSON.stringify(page),/reviewed_content|policy_snapshot|raw_payload|token|body_text|outcome|cancelled_by|edited_by/);
});

test('history is readable by current inbox readers without management designation; former reviewers remain named',async t=>{
  const x=await historyDemo(t);await x.decide(x.draft.review.id,'rejected',x.cookies[2]);
  x.sql.prepare("UPDATE email_aura_reviewers SET revoked_at='2026-11-06' WHERE org_id=? AND aura_id=?").run(DEMO_ORG,AURA);
  x.sql.prepare("UPDATE email_workspace_access SET status='suspended' WHERE org_id=? AND member_id='member_demo_reviewer'").run(DEMO_ORG);
  for(const cookie of x.cookies.slice(0,2))assert.equal((await x.history('',cookie)).reviews[0].reviewer.display_name,'Demo Reviewer');
  assert.equal((await x.call(x.path,'GET',undefined,x.cookies[2])).status,401);
  // Re-enabling account access does not restore the revoked Aura assignment.
  x.sql.prepare("UPDATE email_workspace_access SET status='active' WHERE org_id=? AND member_id='member_demo_reviewer'").run(DEMO_ORG);
  assert.equal((await x.call(x.path,'GET',undefined,x.cookies[2])).status,404);
  x.sql.prepare("DELETE FROM email_workspace_sessions WHERE org_id=? AND member_id='member_demo_reviewer'").run(DEMO_ORG);
  x.sql.prepare("DELETE FROM email_workspace_logins WHERE org_id=? AND member_id='member_demo_reviewer'").run(DEMO_ORG);
  x.sql.prepare("DELETE FROM email_workspace_access WHERE org_id=? AND member_id='member_demo_reviewer'").run(DEMO_ORG);
  assert.deepEqual((await x.history()).reviews[0].reviewer,{member_id:'member_demo_reviewer',display_name:null});
});

test('history scopes message and reviewer joins by organization and Aura and requires the inbox session',async t=>{
  const x=await historyDemo(t),other=await x.compose('aura_demo_002');
  assert.equal((await x.request(x.path)).status,401);
  const orgMessage=x.sql.prepare("SELECT id FROM email_messages WHERE org_id='e07_demo_org' LIMIT 1").get().id;
  for(const path of [`${x.base}/messages/${other.message_id}/reviews`,`${x.base}/messages/${orgMessage}/reviews`,`${x.base}/messages/unrelated/reviews`,x.path.replace(AURA,'other_aura')])assert.equal((await x.call(path)).status,404,path);
  for(const path of [x.path.replace(x.draft.message_id,'invalid.id'),x.path.replace(AURA,'bad.aura')])assert.equal((await x.call(path)).status,400);
  x.sql.prepare("INSERT INTO studio_members (org_id,member_id,role) VALUES ('other_org','member_demo_001','member')").run();
  x.sql.prepare("INSERT INTO email_workspace_access (org_id,member_id,display_name,role) VALUES ('other_org','member_demo_001','Wrong organization name','admin')").run();
  await x.decide(x.draft.review.id);assert.equal((await x.history()).reviews[0].reviewer.display_name,'Demo Admin');
});

test('revision pagination ignores timestamps and Aura-wide feed limits; new revisions do not shift older pages',async t=>{
  const x=await historyDemo(t);append(x,x.draft.message_id,2,131);
  const unrelated=await x.compose();append(x,unrelated.message_id,2,151);
  const first=await x.history();assert.equal(first.reviews.length,25);assert.equal(first.reviews[0].revision,131);
  append(x,x.draft.message_id,132,132);
  const rows=[...first.reviews];let cursor=first.nextCursor;
  while(cursor){const page=await x.history(`?limit=25&cursor=${encodeURIComponent(cursor)}`);rows.push(...page.reviews);cursor=page.nextCursor;}
  assert.equal(rows.length,131);assert.equal(new Set(rows.map(r=>r.id)).size,131);
  assert.deepEqual(rows.map(r=>r.revision),Array.from({length:131},(_,i)=>131-i));
  assert.equal((await x.history()).reviews[0].revision,132);
  assert.equal((await x.history('?limit=50')).reviews.length,50);
  assert.deepEqual((await x.history('?cursor=revision:1')).reviews,[]);
});

test('history rejects malformed pagination without writes or provider calls',async t=>{
  const x=await historyDemo(t),before=x.sql.prepare('SELECT total_changes() AS n').get().n;
  const snapshot=JSON.stringify(x.sql.prepare('SELECT * FROM email_reviews ORDER BY id').all());
  for(const query of ['limit=0','limit=51','limit=-1','limit=1.5','limit=x','limit=1&limit=2','cursor=','cursor=1','cursor=revision:0','cursor=revision:-1','cursor=revision:01','cursor=revision:1.5','cursor=revision:9007199254740992','cursor=revision:1&cursor=revision:2','cursor='+encodeURIComponent('revision:2 OR 1=1')])assert.equal((await x.call(x.path+'?'+query)).status,400,query);
  await x.history();await x.history('?limit=1');await x.history('?cursor=revision:1');
  assert.equal(x.sql.prepare('SELECT total_changes() AS n').get().n,before);
  assert.equal(JSON.stringify(x.sql.prepare('SELECT * FROM email_reviews ORDER BY id').all()),snapshot);assert.equal(x.sent.length,0);
});

test('automatic, no-review legacy and unknown reasons disclose only safe recorded fields',async t=>{
  const x=await historyDemo(t);
  const auto=await x.compose('aura_demo_004');
  const r=await x.call(`/api/auras/aura_demo_004/messages/${auto.message_id}/reviews`);const a=(await r.json()).reviews[0];
  assert.equal(a.decision_source,'automatic');assert.equal(a.reviewer,null);assert.equal(a.reason_label,'Sending allowed by policy');
  x.sql.prepare("UPDATE email_reviews SET status='superseded',approver_member_id='member_demo_001' WHERE id=?").run(a.id);
  const automaticHistory=await x.call(`/api/auras/aura_demo_004/messages/${auto.message_id}/reviews`);assert.equal((await automaticHistory.json()).reviews[0].reviewer,null);
  for(const reason of ['private provider payload and token','__proto__','toString']){
    x.sql.prepare('UPDATE email_reviews SET reason=? WHERE id=?').run(reason,x.draft.review.id);
    assert.equal((await x.history()).reviews[0].reason_label,'Other recorded reason');
  }
  x.sql.prepare('DELETE FROM email_reviews WHERE message_id=?').run(x.draft.message_id);
  assert.deepEqual(await x.history(),{message_id:x.draft.message_id,reviews:[],nextCursor:null});
});

test('reject/edit, policy supersession, reset and cancellation expose rows without inventing actors or events',async t=>{
  const x=await historyDemo(t);await x.decide(x.draft.review.id,'rejected');const edited=await x.edit();
  let rows=(await x.history()).reviews;assert.equal(rows[1].status,'superseded');assert.equal(rows[1].reviewer.display_name,'Demo Admin');
  assert.equal((await x.call(`${x.base}/governance/policy`,'PUT',{tier:'1',version:1,rules:{daily_limit:10}})).status,200);
  assert.equal((await x.call(`${x.base}/messages/${x.draft.message_id}/evaluate`,'POST',{})).status,200);
  assert.equal((await x.call(`${x.base}/threads/${x.draft.thread_id}/reset`,'POST',{})).status,200);
  assert.equal((await x.call(`${x.base}/messages/${x.draft.message_id}/evaluate`,'POST',{})).status,200);
  assert.equal((await x.call(`${x.base}/messages/${x.draft.message_id}/cancel`,'POST',{})).status,200);
  rows=(await x.history()).reviews;assert.deepEqual(rows.map(r=>r.revision),[4,3,2,1]);assert.ok(rows.every(r=>r.status==='superseded'));
  assert.equal(rows.find(r=>r.id===edited.id).reviewer,null);assert.ok(rows.every(r=>r.sent_at===null));assert.equal(x.sent.length,0);
});

for(const outcome of ['failed','unknown'])test(`history read preserves ${outcome} dispatch state and never retries`,async t=>{
  const x=await historyDemo(t);let calls=0;
  x.env.EMAIL={async send(){calls++;throw outcome==='failed'?new SendError('rejected',400,[10001]):Error('timeout');}};
  await x.decide(x.draft.review.id);await x.call(`${x.base}/reviews/${x.draft.review.id}/send`,'POST',{});
  const before=x.sql.prepare('SELECT total_changes() AS n').get().n;
  for(let n=0;n<3;n++){const rows=(await x.history()).reviews;assert.equal(rows[0].status,'approved');assert.equal(rows[0].sent_at,null);}
  assert.equal(x.sql.prepare('SELECT total_changes() AS n').get().n,before);assert.equal(calls,1);
  assert.equal(x.sql.prepare('SELECT status FROM email_messages WHERE id=?').get(x.draft.message_id).status,outcome==='failed'?'failed':'sending');
});
