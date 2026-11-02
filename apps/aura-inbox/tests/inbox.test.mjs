import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.ts';
import { receive } from '../worker/inbound.ts';

const ORG = 'e07_demo_org';
const SALES = 'e07_demo_aura_sales', SUPPORT = 'e07_demo_aura_support';

function setup(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec('PRAGMA foreign_keys=ON;');
  for (const path of ['tests/email/fixtures/studio_parents_2026_10_22.sql','scripts/0001_email_model.sql','scripts/email/seed.sql']) {
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
  assert.equal(attachment.filename,'aura-demo.txt'); assert.match(atob(attachment.content),/sample file/);
  const stored=x.sql.prepare("SELECT * FROM email_attachments WHERE message_id LIKE 'reply_%'").get();
  assert.ok(x.objects.has(stored.r2_key));
  const response=await x.request(`/api/auras/aura_demo_002/messages/${stored.message_id}/attachments/${stored.id}`);
  assert.equal(await response.text(),atob(attachment.content));
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
