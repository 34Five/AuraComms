import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.ts';

export const ORG = 'e07_demo_org';
export const SALES = 'e07_demo_aura_sales', SUPPORT = 'e07_demo_aura_support';

export function setup(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec('PRAGMA foreign_keys=ON;');
  for (const path of ['tests/email/fixtures/studio_parents_2026_10_22.sql','scripts/0001_email_model.sql','scripts/email/seed.sql','scripts/0003_email_address_provisioning.sql','scripts/0004_demo_auth.sql']) {
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
  let batches = Promise.resolve();
  const sent = [];
  const env = {
    DEMO_ORG_ID: ORG, TEST_MODE:'true', SESSION_SECRET:'test-session-secret',
    EMAIL: { async send(message) {
      if (x.failSend) throw Object.assign(new Error(`Rejected ${message.to}`),{ code:'E_RECIPIENT_NOT_ALLOWED' });
      sent.push(message);
      return { messageId:`<login-${sent.length}@cloudflare.example>` };
    } },
    // D1 runs each batch as one transaction, so concurrent batches take turns here too.
    DB: { prepare, batch(statements) {
      const run = batches.then(async () => {
        sql.exec('BEGIN');
        try { const results=[]; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; }
        catch (e) { sql.exec('ROLLBACK'); throw e; }
      });
      batches = run.catch(() => undefined);
      return run;
    } },
    MAIL: {
      async put(key,value) { objects.set(key,new Uint8Array(typeof value==='string' ? new TextEncoder().encode(value) : value)); },
      async get(key) { const data=objects.get(key); if (!data) return null; return { body:data, async json(){ return JSON.parse(new TextDecoder().decode(data)); } }; },
      async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
    },
    ASSETS:{ async fetch(){ return new Response('app'); } },
  };
  const anon = (path,options) => worker.fetch(new Request('https://inbox.example'+path,options),env);
  const x = { env,sql,objects,sent,failSend:false,anon, async request(path,options) { return anon(path,options); } };
  return x;
}

export function email(to='sales@demo.34five.studio',id='new@example.invalid',extra='',body='A new test message.') {
  const raw = new TextEncoder().encode(`From: Alex <alex@example.invalid>\r\nTo: ${to}\r\nSubject: New inquiry\r\nMessage-ID: <${id}>\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
  return { to,from:'alex@example.invalid',rawSize:raw.byteLength,raw:new Response(raw).body,headers:new Headers(),rejected:null,
    setReject(reason){ this.rejected=reason; } };
}

export function enableReplies(x) {
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
