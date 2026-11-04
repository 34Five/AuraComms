import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.ts';
import { receive } from '../worker/inbound.ts';
import { GovernanceCoordinator } from '../worker/coordinator.ts';
import { Governance } from '../worker/governance.ts';
import { verifyDomain, txtValue, txtMatches, domainRecords } from '../worker/domain-dns.ts';

const ORG = 'e07_demo_org';
const SALES = 'e07_demo_aura_sales', SUPPORT = 'e07_demo_aura_support';

function setup(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec('PRAGMA foreign_keys=ON;');
  for (const path of ['tests/email/fixtures/studio_parents_2026_10_22.sql','scripts/0001_email_model.sql','scripts/email/seed.sql','scripts/0002_email_governance.sql']) {
    sql.exec(readFileSync(new URL('../../../'+path,import.meta.url),'utf8'));
  }
  sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('other_aura','other_org','Other organization');");
  const prepare = (query,values=[]) => ({
    bind(...args) { return prepare(query,args); },
    async first(column) { const row = sql.prepare(query).get(...values); return row ? (column ? row[column] : row) : null; },
    async all() { return { success: true, results: sql.prepare(query).all(...values) }; },
    async run() { const result = sql.prepare(query).run(...values); return { success:true, meta:{ changes:Number(result.changes) } }; },
  });
  const objects = new Map();
  const env = {
    DEMO_ORG_ID: ORG, TEST_MODE:'true',
    DB: { prepare, async batch(statements) {
      sql.exec('BEGIN');
      try { const results=[]; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; }
      catch (e) { sql.exec('ROLLBACK'); throw e; }
    } },
    MAIL: {
      async put(key,value) { objects.set(key,new Uint8Array(typeof value==='string' ? new TextEncoder().encode(value) : value)); },
      async get(key) { const data=objects.get(key); if (!data) return null; return { body:data, async json(){ return JSON.parse(new TextDecoder().decode(data)); } }; },
      async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
    },
    ASSETS:{ async fetch(){ return new Response('app'); } },
  };
  let queue=Promise.resolve();
  const coordinator = new GovernanceCoordinator({blockConcurrencyWhile:fn=>{ const task=queue.then(fn); queue=task.catch(()=>{}); return task; }},env);
  env.GOVERNANCE={idFromName:name=>name,get:()=>({fetch:request=>coordinator.fetch(request)})};
  return { env,sql,objects, async request(path,options) { return worker.fetch(new Request('https://inbox.example'+path,options),env); } };
}

function email(to='sales@demo.34five.studio',id='new@example.invalid',extra='',body='A new test message.') {
  const raw = new TextEncoder().encode(`From: Alex <alex@example.invalid>\r\nTo: ${to}\r\nSubject: New inquiry\r\nMessage-ID: <${id}>\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
  return { to,from:'alex@example.invalid',rawSize:raw.byteLength,raw:new Response(raw).body,headers:new Headers(),rejected:null,
    setReject(reason){ this.rejected=reason; } };
}

function enableReplies(x) {
  x.sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_001','org_demo_001','Customer Support Aura'),('aura_demo_002','org_demo_001','Sales Aura')");
  x.sql.exec(readFileSync(new URL('../scripts/provision-addresses.sql',import.meta.url),'utf8'));
  x.sql.exec("INSERT INTO email_aura_policies (org_id,aura_id,tier) VALUES ('org_demo_001','aura_demo_001','4'),('org_demo_001','aura_demo_002','4')");
  x.env.DEMO_ORG_ID='org_demo_001'; x.env.AUTO_REPLY_ENABLED='true';
  const replies=[];
  return { replies, message(to='sales-test@34five.studio',id='reply-test@example.invalid',extra='',body='A new test message.') {
    const m=email(to,id,extra,body);
    m.reply=async value=>{ replies.push(value); return {messageId:`<out-${replies.length}@cloudflare.example>`}; };
    return m;
  } };
}

test('the API lists only the configured organization and real inbox rows',async t => {
  const x=setup(t);
  const response=await x.request('/api/auras');
  const data=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(data.auras.map(a=>a.id).sort(),[SALES,SUPPORT].sort());
  assert.equal(data.auras.find(a=>a.id===SALES).message_count,3);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await x.request('/api/auras/other_aura/inbox')).status,404);
  assert.equal((await x.request(`/api/auras/${SUPPORT}/threads/thread_quote/messages`)).status,404);
  assert.equal((await x.request('/api/auras',{method:'POST'})).status,405);
});

test('keyset pagination, literal search, invalid input and missing endpoints',async t => {
  const x=setup(t);
  const one=await (await x.request(`/api/auras/${SALES}/inbox?limit=1`)).json();
  assert.equal(one.threads.length,1); assert.ok(one.nextCursor);
  const two=await (await x.request(`/api/auras/${SALES}/inbox?limit=1&cursor=${one.nextCursor}`)).json();
  assert.notEqual(one.threads[0].id,two.threads[0].id);
  const all=await (await x.request(`/api/auras/${SALES}/inbox?q=%25`)).json();
  assert.equal(all.threads.length,0);
  for (const tail of ['limit=0','limit=51','cursor=invalid','status=bogus']) {
    assert.equal((await x.request(`/api/auras/${SALES}/inbox?${tail}`)).status,400);
  }
  assert.equal((await x.request('/api/missing')).status,404);
  assert.equal((await x.request(`/api/auras/${SALES}/messages/msg_support_in/body`)).status,404);
});

test('message pagination includes recipients, omits Bcc, and scopes attachment access',async t => {
  const x=setup(t);
  const page=await (await x.request(`/api/auras/${SALES}/threads/thread_quote/messages?limit=1`)).json();
  assert.equal(page.messages[0].id,'msg_quote_draft');
  assert.equal(page.messages[0].recipients.length,2);
  assert.ok(page.messages[0].recipients.every(r=>r.kind!=='bcc'));
  assert.ok(page.nextCursor);
  const old=await (await x.request(`/api/auras/${SALES}/threads/thread_quote/messages?limit=1&cursor=${page.nextCursor}`)).json();
  assert.equal(old.messages[0].id,'msg_quote_in');
  assert.equal((await x.request(`/api/auras/${SALES}/messages/msg_support_out/attachments/attachment_setup`)).status,404);
  assert.equal((await x.request(`/api/auras/${SUPPORT}/messages/msg_large/body`)).status,404);
});

test('real MIME ingest creates one scoped message, recipients and a contact, then deduplicates retries',async t => {
  const x=setup(t), before=x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n;
  await receive(email(),x.env);
  const row=x.sql.prepare("SELECT * FROM email_messages WHERE rfc_message_id='new@example.invalid'").get();
  assert.equal(row.aura_id,SALES); assert.equal(row.body_text.trim(),'A new test message.');
  assert.equal(row.status,'received'); assert.equal(row.address_assignment_id,'assignment_sales');
  assert.ok(x.objects.has(row.raw_mime_r2_key));
  assert.equal(x.sql.prepare('SELECT first_message_id FROM email_threads WHERE id=?').get(row.thread_id).first_message_id,row.id);
  await receive(email(),x.env);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n,before+1);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('reply headers stay in one Aura, and cross-Aura references never join histories',async t => {
  const x=setup(t);
  await receive(email(undefined,'reply@example.invalid','In-Reply-To: <msg_quote_in@example.invalid>\r\n'),x.env);
  assert.equal(x.sql.prepare("SELECT thread_id FROM email_messages WHERE rfc_message_id='reply@example.invalid'").get().thread_id,'thread_quote');
  await receive(email('support@demo.34five.studio','cross@example.invalid','In-Reply-To: <msg_quote_in@example.invalid>\r\n'),x.env);
  const row=x.sql.prepare("SELECT thread_id,aura_id FROM email_messages WHERE rfc_message_id='cross@example.invalid'").get();
  assert.equal(row.aura_id,SUPPORT); assert.notEqual(row.thread_id,'thread_quote');
});

test('unknown recipients, inactive domains, oversized streams and unconfigured workers do not persist mail',async t => {
  const x=setup(t);
  const unknown=email('nobody@demo.34five.studio'); await receive(unknown,x.env); assert.ok(unknown.rejected);
  const tooBig=email(); tooBig.rawSize=26*1024*1024; await receive(tooBig,x.env); assert.match(tooBig.rejected,/25 MiB/);
  x.sql.exec("UPDATE email_domains SET status='disabled',disabled_at='2026-10-22T10:00:00.000Z' WHERE id='domain_default'");
  const disabled=email(); await receive(disabled,x.env); assert.ok(disabled.rejected);
  assert.equal(x.objects.size,0);
  x.env.TEST_MODE='false'; assert.equal((await x.request('/api/auras')).status,503);
});

test('large Unicode bodies and binary attachments retain their bytes and download safely',async t => {
  const x=setup(t);
  await receive(email(undefined,'large@example.invalid','','🌻'.repeat(18000)),x.env);
  const row=x.sql.prepare("SELECT * FROM email_messages WHERE rfc_message_id='large@example.invalid'").get();
  assert.equal(row.body_storage,'r2'); assert.equal(row.body_text,null); assert.ok(row.body_size_bytes>65536);
  const body=await (await x.request(`/api/auras/${SALES}/messages/${row.id}/body`)).json();
  assert.equal(body.body_text.trim(),'🌻'.repeat(18000));
  const raw=`From: Alex <alex@example.invalid>\r\nTo: sales@demo.34five.studio\r\nMessage-ID: <attachment@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=test\r\n\r\n--test\r\nContent-Type: text/plain\r\n\r\nAttached.\r\n--test\r\nContent-Type: text/html\r\nContent-Disposition: attachment; filename="test.html"\r\nContent-Transfer-Encoding: base64\r\n\r\nPHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\r\n--test--\r\n`;
  const m=email(); m.raw=new Response(raw).body; m.rawSize=raw.length; await receive(m,x.env);
  const attachment=x.sql.prepare('SELECT * FROM email_attachments ORDER BY rowid DESC LIMIT 1').get();
  const response=await x.request(`/api/auras/${SALES}/messages/${attachment.message_id}/attachments/${attachment.id}`);
  assert.equal(response.headers.get('content-type'),'application/octet-stream');
  assert.match(response.headers.get('content-disposition'),/^attachment;/);
  assert.equal(await response.text(),'<script>alert(1)</script>');
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('a database failure cannot leave a partial inbox message or thread',async t => {
  const x=setup(t);
  const before=x.sql.prepare('SELECT COUNT(*) AS n FROM email_threads').get().n;
  const realBatch=x.env.DB.batch;
  x.env.DB.batch=async statements=>realBatch([...statements,x.env.DB.prepare("SELECT * FROM missing_table")]);
  await assert.rejects(receive(email(),x.env));
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_threads').get().n,before);
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE rfc_message_id='new@example.invalid'").get().n,0);
});

test('provisioning adds both real addresses once and preserves existing seed history',t => {
  const x=setup(t);
  x.sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_001','org_demo_001','Customer Support Aura'),('aura_demo_002','org_demo_001','Sales Aura')");
  const before=x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n;
  const sql=readFileSync(new URL('../scripts/provision-addresses.sql',import.meta.url),'utf8');
  x.sql.exec(sql); x.sql.exec(sql);
  const rows=x.sql.prepare("SELECT a.address,x.aura_id FROM email_addresses a JOIN email_address_assignments x ON x.address_id=a.id AND x.org_id=a.org_id WHERE a.org_id='org_demo_001' AND x.ended_at IS NULL ORDER BY a.address").all();
  assert.deepEqual(rows.map(r=>({...r})),[
    {address:'sales-test@34five.studio',aura_id:'aura_demo_002'},
    {address:'support-test@34five.studio',aura_id:'aura_demo_001'},
  ]);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n,before);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('the byte limit still applies when the sender understates rawSize',async t => {
  const x=setup(t), msg=email();
  msg.rawSize=1;
  msg.raw=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(26*1024*1024));controller.close();}});
  await receive(msg,x.env);
  assert.match(msg.rejected,/25 MiB/); assert.equal(x.objects.size,0);
});

for (const [address,auraId] of [['support-test@34five.studio','aura_demo_001'],['sales-test@34five.studio','aura_demo_002']]) {
  test(`default reply from ${address} is saved in the correct Aura conversation`,async t => {
    const x=setup(t), demo=enableReplies(x);
    await receive(demo.message(address),x.env);
    assert.equal(demo.replies.length,1);
    const reply=demo.replies[0];
    assert.equal(reply.from.email,address); assert.equal(reply.replyTo,address);
    assert.equal(reply.subject,'Re: New inquiry'); assert.match(reply.text,/fixed demo response/);
    assert.equal(reply.headers['Auto-Submitted'],'auto-replied');
    const rows=x.sql.prepare("SELECT * FROM email_messages WHERE org_id='org_demo_001' ORDER BY direction").all();
    assert.equal(rows.length,2); assert.equal(rows[0].thread_id,rows[1].thread_id);
    const outgoing=rows.find(r=>r.direction==='out');
    assert.equal(outgoing.aura_id,auraId); assert.equal(outgoing.status,'sent');
    assert.equal(outgoing.rfc_message_id,'out-1@cloudflare.example');
    assert.equal(outgoing.in_reply_to,'reply-test@example.invalid');
    const api=await (await x.request(`/api/auras/${auraId}/threads/${outgoing.thread_id}/messages`)).json();
    assert.equal(api.messages.length,2); assert.ok(api.messages.some(m=>m.direction==='out'));
    assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
  });
}

test('attachment requests send and store only the fixed sample file',async t => {
  const x=setup(t), demo=enableReplies(x);
  await receive(demo.message(undefined,undefined,'','Please send an attachment.'),x.env);
  const attachment=demo.replies[0].attachments[0];
  assert.equal(attachment.filename,'aura-demo.txt'); assert.match(new TextDecoder().decode(attachment.content),/sample file/);
  const stored=x.sql.prepare("SELECT * FROM email_attachments WHERE message_id LIKE 'reply_%'").get();
  assert.ok(x.objects.has(stored.r2_key));
  const response=await x.request(`/api/auras/aura_demo_002/messages/${stored.message_id}/attachments/${stored.id}`);
  assert.equal(await response.text(),new TextDecoder().decode(attachment.content));
});

test('duplicate MIME and changed-MIME redelivery cannot send another reply',async t => {
  const x=setup(t), demo=enableReplies(x);
  await receive(demo.message(),x.env); await receive(demo.message(),x.env);
  await receive(demo.message(undefined,undefined,'','Modified redelivery bytes.'),x.env);
  assert.equal(demo.replies.length,1);
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE org_id='org_demo_001' AND direction='out'").get().n,1);
});

for (const header of ['Auto-Submitted: auto-replied','Auto-Submitted: no\r\nAuto-Submitted: auto-generated','Precedence: bulk','List-Id: demo','X-Aura-Demo: true','X-Auto-Response-Suppress: All']) {
  test(`automated mail does not trigger a reply: ${header}`,async t => {
    const x=setup(t), demo=enableReplies(x);
    await receive(demo.message(undefined,undefined,header+'\r\n'),x.env);
    assert.equal(demo.replies.length,0);
    assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE org_id='org_demo_001' AND direction='in'").get().n,1);
  });
}

test('reply-to cannot redirect a reply and follow-ups reuse the same thread',async t => {
  const x=setup(t), demo=enableReplies(x);
  await receive(demo.message(undefined,undefined,'Reply-To: attacker@example.invalid\r\n'),x.env);
  assert.equal(demo.replies[0].to,undefined);
  const outgoing=x.sql.prepare("SELECT * FROM email_messages WHERE org_id='org_demo_001' AND direction='out'").get();
  assert.equal(outgoing.envelope_to,'alex@example.invalid');
  await receive(demo.message(undefined,'followup@example.invalid','In-Reply-To: <out-1@cloudflare.example>\r\nReferences: <reply-test@example.invalid> <out-1@cloudflare.example>\r\n'),x.env);
  assert.equal(demo.replies.length,2);
  const count=x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages WHERE thread_id=?').get(outgoing.thread_id).n;
  assert.equal(count,4);
});

test('uncertain send failures keep incoming mail and an unretried send claim',async t => {
  const x=setup(t), demo=enableReplies(x); let attempts=0;
  const m=demo.message(); m.reply=async()=>{ attempts++; throw new Error('Provider timeout'); };
  await receive(m,x.env);
  await receive(demo.message(undefined,undefined,'','Different redelivery'),x.env);
  assert.equal(attempts,1); assert.equal(demo.replies.length,0);
  const row=x.sql.prepare("SELECT * FROM email_messages WHERE org_id='org_demo_001' AND direction='out'").get();
  assert.equal(row.status,'sending');
  const event=x.sql.prepare('SELECT event_type,raw_payload_json FROM email_events WHERE message_id=?').get(row.id);
  assert.equal(event.event_type,'unknown'); assert.equal(JSON.parse(event.raw_payload_json).retry_safe,false);
});

test('outcome-storage failures never resend an accepted reply',async t => {
  const x=setup(t), demo=enableReplies(x); let sent=false;
  const batch=x.env.DB.batch; x.env.DB.batch=async statements=>{ if(sent) throw new Error('Tracking unavailable'); return batch(statements); };
  const m=demo.message(); m.reply=async value=>{ sent=true; demo.replies.push(value); return {messageId:'<accepted@example.invalid>'}; };
  await receive(m,x.env); await receive(demo.message(),x.env);
  assert.equal(demo.replies.length,1);
});

test('disabled replies, test-address senders, ambiguous IDs and long threads fail closed',async t => {
  const x=setup(t), demo=enableReplies(x);
  x.env.AUTO_REPLY_ENABLED='false'; await receive(demo.message(),x.env); x.env.AUTO_REPLY_ENABLED='true';
  const self=demo.message(undefined,'self@example.invalid'); self.from='support-test@34five.studio'; await receive(self,x.env);
  await receive(demo.message(undefined,'ambiguous@example.invalid','Message-ID: <duplicate@example.invalid>\r\n'),x.env);
  const refs=Array.from({length:20},(_,i)=>`<parent-${i}@example.invalid>`).join(' ');
  await receive(demo.message(undefined,'long@example.invalid',`References: ${refs}\r\n`),x.env);
  assert.equal(demo.replies.length,0);
});

test('an address disabled during reply preparation cancels the claimed reply',async t => {
  const x=setup(t), demo=enableReplies(x);
  const put=x.env.MAIL.put;
  x.env.MAIL.put=async(key,value)=>{
    await put(key,value);
    if (key.endsWith('/aura-demo.txt')) x.sql.exec("UPDATE email_addresses SET status='disabled',disabled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE address_key='sales-test@34five.studio'");
  };
  await receive(demo.message(undefined,undefined,'','Please send an attachment'),x.env);
  assert.equal(demo.replies.length,0);
  assert.equal(x.sql.prepare("SELECT status FROM email_messages WHERE org_id='org_demo_001' AND direction='out'").get().status,'cancelled');
});

function governanceDemo(t) {
  const x=setup(t);
  x.sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_001','org_demo_001','Customer Support Aura'),('aura_demo_002','org_demo_001','Sales Aura'); INSERT INTO studio_members (org_id,member_id,role) VALUES ('org_demo_001','member_demo_001','admin')");
  for(const f of ['provision-addresses','provision-governance'])x.sql.exec(readFileSync(new URL(`../scripts/${f}.sql`,import.meta.url),'utf8'));
  Object.assign(x.env,{DEMO_ORG_ID:'org_demo_001',AUTO_REPLY_ENABLED:'true',GOVERNANCE_ADMIN_TOKEN:'test-credential',GOVERNANCE_REVIEWER_MEMBER_ID:'member_demo_001'});
  const sent=[];x.env.EMAIL={async send(builder){sent.push(builder);return {messageId:`<governed-${sent.length}@example.invalid>`};}};
  const call=(aura,path,method='GET',body)=>x.request(`/api/auras/${aura}/${path}`,{method,headers:{Authorization:'Bearer test-credential',Origin:'https://inbox.example',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const compose=async(aura)=>{
    const response=await call(aura,'governance/compose','POST',{to:'alex@example.invalid',subject:'Governance demo',text:'A reviewed test message.'});
    const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));return result;
  };
  return {...x,call,compose,sent,g:new Governance(x.env)};
}

test('four-tier provisioning preserves existing Auras and policies on reruns',async t=>{
  const x=governanceDemo(t),before=x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n;
  x.sql.exec(readFileSync(new URL('../scripts/provision-governance.sql',import.meta.url),'utf8'));
  const data=await (await x.request('/api/auras')).json();
  assert.deepEqual(data.auras.map(a=>[a.id,a.tier]).sort(),[['aura_demo_001','1'],['aura_demo_002','2'],['aura_demo_003','3'],['aura_demo_004','4']]);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n,before);
  assert.equal(x.sql.prepare("SELECT version FROM email_aura_policies WHERE aura_id='aura_demo_001'").get().version,1);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('management requires a server credential, same origin and active designated reviewer',async t=>{
  const x=governanceDemo(t),a='aura_demo_001';
  assert.equal((await x.request(`/api/auras/${a}/governance`)).status,401);
  assert.equal((await x.request(`/api/auras/${a}/governance/policy`,{method:'PUT',headers:{Authorization:'Bearer test-credential',Origin:'https://hostile.example'}})).status,403);
  x.env.GOVERNANCE_ADMIN_TOKEN=undefined;assert.equal((await x.call(a,'governance')).status,503);x.env.GOVERNANCE_ADMIN_TOKEN='test-credential';
  x.sql.exec("UPDATE email_aura_reviewers SET revoked_at='2026-11-04T00:00:00.000Z' WHERE aura_id='aura_demo_001'");
  assert.equal((await x.call(a,'governance')).status,403);assert.equal((await x.call('other_aura','governance')).status,404);
});

for(const [a,tier,expected] of [['aura_demo_001','1','pending'],['aura_demo_002','2','pending'],['aura_demo_003','3','approved'],['aura_demo_004','4','approved']]) {
  test(`Tier ${tier}: initial outbound gate, actual send and later conversation behavior`,async t=>{
    const x=governanceDemo(t),d=await x.compose(a);assert.equal(d.review.status,expected);assert.equal(x.sent.length,0);
    if(expected==='pending')assert.equal((await x.call(a,`reviews/${d.review.id}/decide`,'POST',{outcome:'approved',member_id:'forged'})).status,200);
    assert.equal((await x.call(a,`reviews/${d.review.id}/send`,'POST')).status,200);assert.equal(x.sent.length,1);
    assert.equal((await (await x.call(a,`reviews/${d.review.id}/send`,'POST')).json()).status,'already_sent');assert.equal(x.sent.length,1);
    const m=x.sql.prepare('SELECT * FROM email_messages WHERE id=?').get(d.message_id),id=`later-${tier}`;
    x.sql.prepare(`INSERT INTO email_messages (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,send_idempotency_key,from_address,subject,body_text,body_size_bytes,activity_at)
      VALUES (?,?,?,?,?,?,'out','draft',?,?,?,'Later',5,?)`).run(id,m.org_id,a,m.thread_id,m.email_address_id,m.address_assignment_id,id,m.from_address,'Later',new Date().toISOString());
    const later=await x.g.evaluate(a,id);assert.equal(later.status,tier==='1'?'pending':'approved');
    assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
  });
}

test('approval alone cannot unlock Tier 2',async t=>{
  const x=governanceDemo(t),a='aura_demo_002',d=await x.compose(a);await x.g.decide(a,d.review.id,'member_demo_001','approved');
  const m=await x.g.message(a,d.message_id);assert.equal(await x.g.reason(m,await x.g.thread(m),await x.g.policy(a)),'tier_2_first_outbound');
});

test('Tier 3 first inbound invalidates proactive approval and requires a reviewed reply',async t=>{
  const x=governanceDemo(t),a='aura_demo_003',d=await x.compose(a),m=await x.g.message(a,d.message_id),now=new Date().toISOString();
  x.sql.prepare(`INSERT INTO email_messages (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,from_address,received_at,activity_at)
    VALUES ('tier3-in',?,?,?,?,?,'in','received','alex@example.invalid',?,?)`).run(m.org_id,a,m.thread_id,m.email_address_id,m.address_assignment_id,now,now);
  assert.equal((await x.call(a,`reviews/${d.review.id}/send`,'POST')).status,409);assert.equal(x.sent.length,0);
  const next=await x.g.evaluate(a,d.message_id);assert.equal(next.status,'pending');assert.equal(next.reason,'tier_3_first_inbound_reply');
  await x.g.decide(a,next.id,'member_demo_001','approved');await x.g.dispatch(a,next.id);assert.equal(x.sent.length,1);
});

test('production email entry holds Tier 1 and sends Tier 4 through the binding',async t=>{
  const x=governanceDemo(t);
  for(const [address,tier] of [['support-test@34five.studio','1'],['notifications-test@34five.studio','4']]){
    const msg=email(address,`tier-${tier}@example.invalid`);msg.headers.set('Authentication-Results','mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass');
    await worker.email(msg,x.env);
    assert.equal(x.sql.prepare('SELECT status FROM email_reviews WHERE tier_applied=?').get(tier).status,tier==='1'?'pending':'sent');
  }
  assert.equal(x.sent.length,1);assert.equal(x.sent[0].from.email,'notifications-test@34five.studio');
});

test('edits and policy changes invalidate unsent approvals while preserving revisions',async t=>{
  const x=governanceDemo(t),a='aura_demo_001',d=await x.compose(a);await x.g.decide(a,d.review.id,'member_demo_001','approved');
  const edited=await x.call(a,`messages/${d.message_id}/edit`,'POST',{subject:'Changed',text:'Changed content'});assert.equal(edited.status,200);
  const r=(await edited.json()).review;assert.equal(r.status,'pending');assert.equal(r.revision,2);assert.equal(r.edited_before_send,1);
  assert.equal((await x.call(a,`reviews/${d.review.id}/send`,'POST')).status,409);
  const p=await x.g.policy(a);await x.g.updatePolicy(a,'member_demo_001',{...p,rules:{daily_limit:1}});
  assert.equal((await x.g.review(a,r.id)).status,'superseded');assert.equal((await x.call(a,'governance/policy','PUT',{...p,rules:{}})).status,409);
});

test('identical rejected content cannot become automatic and malformed guardrails fail closed',async t=>{
  const x=governanceDemo(t),a='aura_demo_001',d=await x.compose(a);await x.g.decide(a,d.review.id,'member_demo_001','rejected');
  assert.equal((await x.g.evaluate(a,d.message_id)).status,'rejected');assert.equal((await x.call(a,`reviews/${d.review.id}/send`,'POST')).status,409);
  for(const rules of [{daily_limit:0},{daily_limit:true},{unknown:true},{cc:['Name <a@example.invalid>']},{bcc:['x@example.invalid\r\nBcc: injected@example.invalid']}])assert.equal((await x.call(a,'governance/policy','PUT',{tier:'4',version:1,rules})).status,400);
  assert.equal(x.sent.length,0);
});

test('daily reservations serialize concurrent drafts and approval cannot bypass the limit',async t=>{
  const x=governanceDemo(t),a='aura_demo_004';await x.g.updatePolicy(a,'member_demo_001',{tier:'4',version:1,rules:{daily_limit:1}});
  const [d,e]=await Promise.all([x.compose(a),x.compose(a)]);assert.deepEqual([d.review.status,e.review.status].sort(),['approved','pending']);
  const held=d.review.status==='pending'?d:e;assert.equal(held.review.reason,'daily_limit');assert.equal((await x.call(a,`reviews/${held.review.id}/decide`,'POST',{outcome:'approved'})).status,409);
});

test('parallel dispatches make one provider call and revoked reviewers cannot send',async t=>{
  const x=governanceDemo(t),a='aura_demo_001',d=await x.compose(a);await x.g.decide(a,d.review.id,'member_demo_001','approved');
  await Promise.all([x.call(a,`reviews/${d.review.id}/send`,'POST'),x.call(a,`reviews/${d.review.id}/send`,'POST')]);assert.equal(x.sent.length,1);
  const next=await x.compose(a);await x.g.decide(a,next.review.id,'member_demo_001','approved');
  x.sql.exec("UPDATE email_aura_reviewers SET revoked_at='2026-11-04T00:00:00.000Z' WHERE aura_id='aura_demo_001'");await assert.rejects(x.g.dispatch(a,next.review.id),/reviewer/);assert.equal(x.sent.length,1);
});

test('reset invalidates decisions and relocks the conversation',async t=>{
  const x=governanceDemo(t),a='aura_demo_002',d=await x.compose(a);await x.g.decide(a,d.review.id,'member_demo_001','approved');await x.g.reset(a,d.thread_id,'member_demo_001');
  assert.equal((await x.g.review(a,d.review.id)).status,'superseded');assert.equal((await x.g.evaluate(a,d.message_id)).status,'pending');assert.equal(x.sql.prepare('SELECT review_epoch FROM email_threads WHERE id=?').get(d.thread_id).review_epoch,1);
});

test('Tier 4 copies are persisted, deduplicated and actually sent; Bcc stays private',async t=>{
  const x=governanceDemo(t),a='aura_demo_004';await x.g.updatePolicy(a,'member_demo_001',{tier:'4',version:1,rules:{cc:['copy@example.invalid','copy@example.invalid'],bcc:['audit@example.invalid']}});
  const d=await x.compose(a);await x.g.dispatch(a,d.review.id);assert.deepEqual(x.sent[0].cc,['copy@example.invalid']);assert.deepEqual(x.sent[0].bcc,['audit@example.invalid']);
  const data=await (await x.call(a,`threads/${d.thread_id}/messages`)).json();assert.ok(data.messages[0].recipients.every(r=>r.kind!=='bcc'));
});

test('uncertain outcomes retain a capacity reservation and cannot be retried',async t=>{
  const x=governanceDemo(t),a='aura_demo_004';await x.g.updatePolicy(a,'member_demo_001',{tier:'4',version:1,rules:{daily_limit:1}});
  const d=await x.compose(a);let attempts=0;x.env.EMAIL.send=async()=>{attempts++;throw new Error('timeout');};assert.equal((await x.g.dispatch(a,d.review.id)).status,'unknown');
  await assert.rejects(x.g.dispatch(a,d.review.id),/unsent/);assert.equal(attempts,1);assert.equal((await x.compose(a)).review.reason,'daily_limit');
});


test('delayed reply path trusts only Cloudflare’s first authentication result',async t=>{
  const x=governanceDemo(t);
  for(const [i,authentication] of ['', 'sender.example; dmarc=pass', 'mx.cloudflare.net; dmarc=fail, mx.cloudflare.net; dmarc=pass'].entries()){
    const msg=email('notifications-test@34five.studio',`untrusted-${i}@example.invalid`,'X-Aura-Dmarc-Pass: true\r\n');
    if(authentication)msg.headers.set('Authentication-Results',authentication);
    await worker.email(msg,x.env);
  }
  assert.equal(x.sent.length,0);
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE org_id='org_demo_001' AND direction='in'").get().n,3);
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE org_id='org_demo_001' AND direction='out'").get().n,0);
});


test('authenticated header sender cannot redirect replies through a different envelope sender',async t=>{
  const x=governanceDemo(t),msg=email('notifications-test@34five.studio','mismatched-sender@example.invalid');
  msg.from='victim@example.invalid';msg.headers.set('Authentication-Results','mx.cloudflare.net; dmarc=pass');
  await worker.email(msg,x.env);assert.equal(x.sent.length,0);
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE org_id='org_demo_001' AND direction='out'").get().n,0);
});


function manage(x,path,method='GET',body) {
  return x.request('/api/manage/'+path,{method,headers:{Authorization:'Bearer test-credential',Origin:'https://inbox.example',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
test('Aura CRUD uses workspace scope and preserves existing Auras',async t=>{
  const x=governanceDemo(t);
  const created=await manage(x,'auras','POST',{name:'New test Aura',org_id:'other_org',member_id:'forged'});assert.equal(created.status,201);
  const a=(await created.json()).aura;assert.equal((await x.g.policy(a.id)).tier,'1');await x.g.reviewer(a.id,'member_demo_001');
  assert.equal(x.sql.prepare('SELECT org_id FROM auras WHERE id=?').get(a.id).org_id,'org_demo_001');
  assert.equal((await manage(x,`auras/${a.id}`,'PUT',{name:'Renamed Aura',previous_name:'wrong'})).status,409);
  assert.equal((await manage(x,`auras/${a.id}`,'PUT',{name:'Renamed Aura',previous_name:a.name})).status,200);
  assert.equal((await manage(x,`auras/${a.id}`,'DELETE',{confirm_name:a.name})).status,400);
  assert.equal((await manage(x,`auras/${a.id}`,'DELETE',{confirm_name:'Renamed Aura'})).status,200);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM auras WHERE id=?').get(a.id).n,0);
  assert.equal(x.sql.prepare("SELECT COUNT(*) AS n FROM auras WHERE org_id='org_demo_001'").get().n,4);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('Aura deletion refuses address or message history and foreign Aura access',async t=>{
  const x=governanceDemo(t),before=x.sql.prepare('SELECT COUNT(*) AS n FROM email_address_assignments').get().n;
  assert.equal((await manage(x,'auras/aura_demo_003','DELETE',{confirm_name:'Operations Aura'})).status,409);
  assert.equal((await manage(x,'auras/other_aura','PUT',{name:'Hijacked',previous_name:'Other organization'})).status,404);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_address_assignments').get().n,before);
});
test('management endpoints require credentials and current workspace membership',async t=>{
  const x=governanceDemo(t);
  assert.equal((await x.request('/api/manage/workspace')).status,401);
  const response=await manage(x,'workspace');assert.equal(response.status,200);assert.equal((await response.json()).member_id,'member_demo_001');
  x.env.GOVERNANCE_REVIEWER_MEMBER_ID='missing-member';assert.equal((await manage(x,'workspace')).status,403);
  assert.equal((await x.request('/api/manage/auras',{method:'POST',headers:{Authorization:'Bearer test-credential',Origin:'https://hostile.example'}})).status,403);
});
test('policy removal holds outgoing mail, preserves revisions and recreates with a higher version',async t=>{
  const x=governanceDemo(t),a='aura_demo_004',d=await x.compose(a),count=x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n;
  const removed=await x.call(a,'governance/policy','DELETE',{version:1});assert.equal(removed.status,200);assert.equal((await removed.json()).policy.tier,null);
  assert.equal((await x.g.review(a,d.review.id)).status,'superseded');await assert.rejects(x.g.dispatch(a,d.review.id),/approved/);
  const page=await x.call(a,'governance');assert.equal(page.status,200);assert.equal((await page.json()).policy.version,2);
  assert.equal((await x.call(a,'governance/compose','POST',{to:'alex@example.invalid',subject:'Paused',text:'No send'})).status,409);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages').get().n,count);
  assert.equal((await x.call(a,'governance/policy','PUT',{tier:'1',version:2,rules:{}})).status,200);
  const p=await x.g.policy(a);assert.equal(p.version,3);assert.equal((await x.g.evaluate(a,d.message_id)).status,'pending');
});
test('a missing policy can be created without a schema migration',async t=>{
  const x=governanceDemo(t),a='aura_demo_003';x.sql.prepare('DELETE FROM email_aura_policies WHERE org_id=? AND aura_id=?').run(x.env.DEMO_ORG_ID,a);
  assert.equal((await (await x.call(a,'governance')).json()).policy.version,0);
  assert.equal((await x.call(a,'governance/policy','PUT',{tier:'2',version:0,rules:{daily_limit:10}})).status,200);
  assert.equal((await x.g.policy(a)).version,1);
});
test('reviewer removal and regrant cannot revive previous approvals',async t=>{
  const x=governanceDemo(t),a='aura_demo_001',d=await x.compose(a);await x.g.decide(a,d.review.id,'member_demo_001','approved');
  assert.equal((await manage(x,`auras/${a}/reviewers/member_demo_001`,'DELETE')).status,200);
  assert.equal((await x.g.review(a,d.review.id)).status,'superseded');assert.equal((await x.call(a,'governance')).status,403);
  assert.equal((await manage(x,`auras/${a}/reviewers/member_demo_001`,'PUT',{})).status,200);
  assert.equal((await x.call(a,'governance')).status,200);assert.equal((await x.call(a,`reviews/${d.review.id}/send`,'POST')).status,409);
  assert.equal((await manage(x,`auras/${a}/reviewers/e07_demo_reviewer`,'PUT',{})).status,404);
});
test('address disable and restore preserve history and invalidate unsent decisions',async t=>{
  const x=governanceDemo(t),a='aura_demo_004',d=await x.compose(a),path=`auras/${a}/addresses/address_notifications_test`;
  assert.equal((await manage(x,path,'PUT',{status:'disabled'})).status,200);assert.equal((await x.g.review(a,d.review.id)).status,'superseded');
  const incoming=email('notifications-test@34five.studio','paused@example.invalid');await receive(incoming,x.env);assert.ok(incoming.rejected);
  assert.equal((await manage(x,'auras/aura_demo_001/addresses/address_notifications_test','PUT',{status:'active'})).status,404);
  assert.equal((await manage(x,path,'PUT',{status:'active'})).status,200);assert.equal((await x.call(a,`reviews/${d.review.id}/send`,'POST')).status,409);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM email_messages WHERE id=?').get(d.message_id).n,1);assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('cancelling drafts releases reservations and cannot cancel a send claim',async t=>{
  const x=governanceDemo(t),a='aura_demo_004';await x.g.updatePolicy(a,'member_demo_001',{tier:'4',version:1,rules:{daily_limit:1}});
  const d=await x.compose(a);assert.equal((await x.call(a,`messages/${d.message_id}/cancel`,'POST')).status,200);assert.equal((await x.g.review(a,d.review.id)).status,'superseded');
  const next=await x.compose(a);assert.equal(next.review.status,'approved');x.sql.prepare("UPDATE email_messages SET status='sending' WHERE id=?").run(next.message_id);
  assert.equal((await x.call(a,`messages/${next.message_id}/cancel`,'POST')).status,409);assert.equal(x.sent.length,0);
});
test('new management requests validate names and JSON size without partial writes',async t=>{
  const x=governanceDemo(t),before=x.sql.prepare('SELECT COUNT(*) AS n FROM auras').get().n;
  for(const name of ['', 'A'.repeat(101), 'Injected\nAura'])assert.equal((await manage(x,'auras','POST',{name})).status,400);
  assert.equal((await manage(x,'auras','POST',{name:'Valid',tier:'5'})).status,400);
  assert.equal((await manage(x,'auras','POST',{name:'Valid',padding:'x'.repeat(17000)})).status,413);
  assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM auras').get().n,before);
});
test('DNS records normalize split TXT data and exclude other domains',async()=>{
  assert.equal(txtValue('"v=DKIM1; p=abc" "def"'),'v=DKIM1; p=abcdef');
  assert.equal(txtValue('"v=DKIM1;\\032p=abc"'),'v=DKIM1; p=abc');
  assert.deepEqual(domainRecords('example.com',JSON.stringify([{type:'TXT',name:'cf._domainkey.example.com',content:'key'},{type:'TXT',name:'example.com.hostile.invalid',content:'bad'},{type:'NS',name:'example.com',content:'unsupported'}])).map(r=>r.name),['cf._domainkey.example.com']);
});
test('DKIM verification compares provider records to public DNS and handles resolver failure',async t=>{
  const x=governanceDemo(t),domain='domain_34five_inbox_test';
  const records=[{type:'TXT',name:'cf-bounce._domainkey.34five.studio',content:'"v=DKIM1; p=abcdef"'}];
  x.sql.prepare('UPDATE email_domains SET dns_records_json=? WHERE id=?').run(JSON.stringify(records),domain);
  let calls=0;
  const resolver=async url=>{calls++;assert.equal(url.origin,'https://cloudflare-dns.com');assert.equal(url.searchParams.get('type'),'TXT');return Response.json({Status:0,Answer:[{type:16,data:'"v=DKIM1; p=abc" "def"'}]});};
  assert.equal((await verifyDomain(x.env,domain,resolver)).dkim_status,'verified');assert.equal(calls,1);
  assert.equal((await verifyDomain(x.env,domain,async()=>Response.json({Status:3}))).dkim_status,'needs_setup');
  assert.equal((await verifyDomain(x.env,domain,async()=>{throw new Error('DNS offline');})).dkim_status,'unavailable');
  assert.equal(x.sql.prepare('SELECT status FROM email_domains WHERE id=?').get(domain).status,'active');
  await assert.rejects(verifyDomain(x.env,'domain_default',resolver),/not found/);
});
test('DNS setup returns only registered workspace domains and never changes provider DNS',async t=>{
  const x=governanceDemo(t),r=await manage(x,'domains'),data=await r.json();assert.equal(r.status,200);assert.deepEqual(data.domains.map(d=>d.domain),['34five.studio']);
  assert.equal((await manage(x,'domains/domain_34five_inbox_test/verify','POST',{})).status,409);
  assert.equal((await manage(x,'domains/domain_default/verify','POST',{})).status,404);
});


test('authentication DNS comparison accepts extra DMARC tags and reordered DKIM tags',()=>{
  assert.equal(txtMatches('_dmarc.example.com','"v=DMARC1; p=reject; sp=reject; rua=mailto:audit@example.com;"','"v=DMARC1; p=reject;"'),true);
  assert.equal(txtMatches('_dmarc.example.com','"v=DMARC1; p=none;"','"v=DMARC1; p=reject;"'),false);
  assert.equal(txtMatches('cf._domainkey.example.com','"k=rsa; p=abc123; v=DKIM1;"','"v=DKIM1; k=rsa; p=abc123;"'),true);
  assert.equal(txtMatches('cf._domainkey.example.com','"v=DKIM1; p=changed;"','"v=DKIM1; p=abc123;"'),false);
  assert.equal(txtMatches('_dmarc.example.com','"v=DMARC1; p=reject; p=none;"','"v=DMARC1; p=reject;"'),false);
});


test('demo reprovisioning cannot restore a policy removed through management',async t=>{
  const x=governanceDemo(t),a='aura_demo_004';await x.g.removePolicy(a,'member_demo_001',1);
  x.sql.exec(readFileSync(new URL('../scripts/provision-governance.sql',import.meta.url),'utf8'));
  const policy=await x.g.policyConfig(a);assert.equal(policy.tier,null);assert.equal(policy.version,2);
});
