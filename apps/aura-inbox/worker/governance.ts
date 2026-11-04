import { HttpError, type Env } from './types.ts';

type Row = Record<string, any>;
export type Rules = { cc?: string[]; bcc?: string[]; daily_limit?: number | null };
export type Policy = { tier: string; version: number; rules: Rules };
const encoder = new TextEncoder();
const fields = ['from_address','from_name','envelope_from','envelope_to','subject','reply_to_json','body_storage',
  'body_text','body_html','body_r2_key','body_size_bytes','in_reply_to','references_json','rfc_message_id'];
export const TEST_ADDRESSES = ['support-test@34five.studio','sales-test@34five.studio','operations-test@34five.studio','notifications-test@34five.studio'];
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function bareAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || value.split('@').length !== 2) return false;
  const [local,domain] = value.split('@');
  return local.length <= 64 && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)
    && domain.length <= 253 && domain.split('.').every(p => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(p));
}
export function validateRules(value: unknown): Rules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400,'Rules must be an object.');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !['cc','bcc','daily_limit'].includes(k))) throw new HttpError(400,'Unsupported guardrail.');
  for (const k of ['cc','bcc']) if (r[k] !== undefined && (!Array.isArray(r[k]) || (r[k] as unknown[]).length > 20 || !(r[k] as unknown[]).every(bareAddress))) {
    throw new HttpError(400,'Copies must contain at most 20 bare email addresses per kind.');
  }
  if (r.daily_limit !== undefined && r.daily_limit !== null && (!Number.isSafeInteger(r.daily_limit) || Number(r.daily_limit) < 1)) throw new HttpError(400,'Daily limit must be a positive integer or empty.');
  return r as Rules;
}

// Every production entry point runs through one organization-scoped Durable Object.
// Its concurrency barrier covers reads, D1 batches, reservations and provider calls.
export class Governance {
  env: Env;
  org: string;
  constructor(env: Env) { this.env = env; this.org = env.DEMO_ORG_ID; }
  q(sql: string, ...args: any[]) { return this.env.DB.prepare(sql).bind(...args); }
  async one(sql: string, ...args: any[]): Promise<Row> {
    const row = await this.q(sql,...args).first<Row>();
    if (!row) throw new HttpError(404,'Record not found in this Aura.');
    return row;
  }
  async message(aura: string, id: string) {
    const m = await this.one('SELECT * FROM email_messages WHERE org_id=? AND aura_id=? AND id=?',this.org,aura,id);
    if (m.direction !== 'out') throw new HttpError(400,'Only outgoing messages can be reviewed.');
    return m;
  }
  thread(m: Row) { return this.one('SELECT * FROM email_threads WHERE org_id=? AND aura_id=? AND id=?',this.org,m.aura_id,m.thread_id); }
  async reviewer(aura: string, member: string) {
    if (!member) throw new HttpError(403,'No reviewer is configured.');
    const row = await this.q(`SELECT r.member_id FROM email_aura_reviewers r JOIN studio_members m ON m.org_id=r.org_id AND m.member_id=r.member_id
      WHERE r.org_id=? AND r.aura_id=? AND r.member_id=? AND r.revoked_at IS NULL`,this.org,aura,member).first();
    if (!row) throw new HttpError(403,'An active designated reviewer is required.');
  }
  async policyConfig(aura: string) {
    const row = await this.q('SELECT * FROM email_aura_policies WHERE org_id=? AND aura_id=?',this.org,aura).first<Row>();
    return {tier:row?.tier ?? null,version:row?.version ?? 0,rules:row ? JSON.parse(row.rules_json) as Rules : {}};
  }
  async policy(aura: string): Promise<Policy> {
    const p = await this.one('SELECT * FROM email_aura_policies WHERE org_id=? AND aura_id=?',this.org,aura);
    if (!['1','2','3','4'].includes(p.tier)) throw new HttpError(409,'Configure a tier from 1 to 4 before sending.');
    return {tier:p.tier,version:p.version,rules:validateRules(JSON.parse(p.rules_json))};
  }
  async fingerprint(m: Row) {
    const recipients = await this.q(`SELECT kind,ordinal,address,address_key,display_name FROM email_message_recipients
      WHERE org_id=? AND aura_id=? AND message_id=? ORDER BY kind,ordinal`,this.org,m.aura_id,m.id).all();
    const attachments = await this.q(`SELECT ordinal,filename,content_type,size_bytes,r2_key,content_id,disposition FROM email_attachments
      WHERE org_id=? AND aura_id=? AND message_id=? ORDER BY ordinal`,this.org,m.aura_id,m.id).all();
    const bytes = encoder.encode(canonical({message:Object.fromEntries(fields.map(k => [k,m[k]])),recipients:recipients.results,attachments:attachments.results}));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
  }
  async inbound(m: Row) {
    return this.q(`SELECT id FROM email_messages WHERE org_id=? AND aura_id=? AND thread_id=? AND direction='in'
      AND activity_at<=? ORDER BY activity_at,id LIMIT 1`,this.org,m.aura_id,m.thread_id,new Date().toISOString()).first<Row>();
  }
  async snapshot(m: Row, p: Policy) {
    return canonical({...p,...(p.tier === '3' ? {tier_3_inbound_id:(await this.inbound(m))?.id ?? null} : {})});
  }
  async limitReached(m: Row, p: Policy) {
    if (p.rules.daily_limit == null) return false;
    const day = new Date().toISOString().slice(0,10);
    const row = await this.one(`SELECT COUNT(*) AS n FROM email_messages m WHERE m.org_id=? AND m.aura_id=? AND m.direction='out' AND m.id<>?
      AND ((m.status='sent' AND substr(m.sent_at,1,10)=?) OR m.status='sending' OR
        (m.status NOT IN ('sent','cancelled','sending') AND EXISTS (SELECT 1 FROM email_reviews r
          WHERE r.org_id=m.org_id AND r.aura_id=m.aura_id AND r.message_id=m.id AND r.status='approved' AND substr(r.decided_at,1,10)=?)))`,
      this.org,m.aura_id,m.id,day,day);
    return row.n >= p.rules.daily_limit;
  }
  async reason(m: Row, t: Row, p: Policy): Promise<string | null> {
    if (await this.limitReached(m,p)) return 'daily_limit';
    if (p.tier === '1') return 'tier_1_every_message';
    if (p.tier === '4') return null;
    const now = new Date().toISOString();
    if (p.tier === '3') {
      const inbound = await this.inbound(m);
      if (!inbound) return null;
      const reviewed = await this.q(`SELECT 1 FROM email_messages m JOIN email_reviews r ON r.org_id=m.org_id AND r.aura_id=m.aura_id AND r.message_id=m.id
        WHERE m.org_id=? AND m.aura_id=? AND m.thread_id=? AND m.id<>? AND m.direction='out' AND m.status='sent' AND m.sent_at<=?
        AND r.status='sent' AND r.decision_source='human' AND r.tier_applied='3' AND r.thread_review_epoch=?
        AND json_extract(r.policy_snapshot_json,'$.tier_3_inbound_id')=? LIMIT 1`,this.org,m.aura_id,m.thread_id,m.id,now,t.review_epoch,inbound.id).first();
      return reviewed ? null : 'tier_3_first_inbound_reply';
    }
    const sent = await this.q(`SELECT 1 FROM email_messages m WHERE m.org_id=? AND m.aura_id=? AND m.thread_id=? AND m.id<>?
      AND m.direction='out' AND m.status='sent' AND m.sent_at<=? AND (?=0 OR EXISTS (SELECT 1 FROM email_reviews r
        WHERE r.org_id=m.org_id AND r.aura_id=m.aura_id AND r.message_id=m.id AND r.status='sent' AND r.thread_review_epoch=?)) LIMIT 1`,
      this.org,m.aura_id,m.thread_id,m.id,now,t.review_epoch,t.review_epoch).first();
    return sent ? null : 'tier_2_first_outbound';
  }
  review(aura: string, id: string) { return this.one('SELECT * FROM email_reviews WHERE org_id=? AND aura_id=? AND id=?',this.org,aura,id); }
  async evaluate(aura: string, id: string) {
    const m = await this.message(aura,id);
    if (!['draft','queued'].includes(m.status)) throw new HttpError(409,'Only unsent drafts can be evaluated.');
    const p = await this.policy(aura), t = await this.thread(m);
    // Validate all copy addresses before modifying any recipient.
    if (p.tier === '4') {
      const copies: D1PreparedStatement[] = [];
      for (const kind of ['cc','bcc'] as const) for (const address of [...new Set(p.rules[kind] ?? [])]) {
        copies.push(this.q(`INSERT INTO email_message_recipients (id,org_id,aura_id,message_id,kind,ordinal,address,address_key)
          SELECT ?,?,?,?,?,COALESCE((SELECT MAX(ordinal)+1 FROM email_message_recipients WHERE org_id=? AND aura_id=? AND message_id=? AND kind=?),0),?,?
          WHERE NOT EXISTS (SELECT 1 FROM email_message_recipients WHERE org_id=? AND aura_id=? AND message_id=? AND kind=? AND address_key=?)`,
          crypto.randomUUID(),this.org,aura,id,kind,this.org,aura,id,kind,address,address.toLowerCase(),this.org,aura,id,kind,address.toLowerCase()));
      }
      if (copies.length) await this.env.DB.batch(copies);
    }
    const digest = await this.fingerprint(m), snapshot = await this.snapshot(m,p);
    const latest = await this.q('SELECT * FROM email_reviews WHERE org_id=? AND aura_id=? AND message_id=? ORDER BY revision DESC LIMIT 1',this.org,aura,id).first<Row>();
    if (latest && ['pending','approved','rejected'].includes(latest.status) && latest.thread_review_epoch === t.review_epoch
      && latest.reviewed_content_sha256 === digest && latest.policy_snapshot_json === snapshot) return latest;
    const reason = await this.reason(m,t,p), status = reason ? 'pending' : 'approved', review = crypto.randomUUID(), now = new Date().toISOString();
    await this.env.DB.batch([
      this.q("UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND message_id=? AND status IN ('pending','approved','rejected')",this.org,aura,id),
      this.q(`INSERT INTO email_reviews (id,org_id,aura_id,message_id,revision,tier_applied,thread_review_epoch,status,decision_source,
        policy_snapshot_json,reviewed_content_sha256,reason,requested_at,decided_at,edited_before_send) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        review,this.org,aura,id,(latest?.revision ?? 0)+1,p.tier,t.review_epoch,status,reason?'human':'automatic',snapshot,digest,reason??'tier_automatic',now,reason?null:now,latest && latest.reviewed_content_sha256 !== digest ? 1:0),
      this.q('UPDATE email_threads SET current_tier=?,tier_state=?,state_version=state_version+1 WHERE org_id=? AND aura_id=? AND id=?',p.tier,status,this.org,aura,m.thread_id),
    ]);
    return this.review(aura,review);
  }
  async fresh(r: Row, m: Row) {
    const p = await this.policy(m.aura_id), t = await this.thread(m);
    if (r.thread_review_epoch !== t.review_epoch || r.reviewed_content_sha256 !== await this.fingerprint(m)
      || r.policy_snapshot_json !== await this.snapshot(m,p)) throw new HttpError(409,'This review is stale. Evaluate the draft again.');
    return p;
  }
  async decide(aura: string, id: string, member: string, outcome: string) {
    if (!['approved','rejected'].includes(outcome)) throw new HttpError(400,'Choose approve or reject.');
    await this.reviewer(aura,member);
    const r = await this.review(aura,id), m = await this.message(aura,r.message_id);
    if (r.status !== 'pending' || !['draft','queued'].includes(m.status)) throw new HttpError(409,'This review is no longer pending.');
    const p = await this.fresh(r,m);
    if (outcome === 'approved' && await this.limitReached(m,p)) throw new HttpError(409,'The daily limit cannot be bypassed by approval.');
    await this.env.DB.batch([
      this.q("UPDATE email_reviews SET status=?,decision_source='human',approver_member_id=?,decided_at=? WHERE org_id=? AND aura_id=? AND id=? AND status='pending'",outcome,member,new Date().toISOString(),this.org,aura,id),
      this.q('UPDATE email_threads SET tier_state=?,state_version=state_version+1 WHERE org_id=? AND aura_id=? AND id=?',outcome,this.org,aura,m.thread_id),
    ]);
    return this.review(aura,id);
  }
  async updatePolicy(aura: string, member: string, body: Row) {
    await this.reviewer(aura,member);
    if (!['1','2','3','4'].includes(body.tier)) throw new HttpError(400,'Choose a tier from 1 to 4.');
    const rules = validateRules(body.rules), old = await this.policyConfig(aura);
    if (body.version !== old.version) throw new HttpError(409,'Policy changed. Reload before saving.');
    await this.env.DB.batch([
      old.version === 0 ? this.q('INSERT INTO email_aura_policies (org_id,aura_id,tier,rules_json,updated_by_member_id) VALUES (?,?,?,?,?)',this.org,aura,body.tier,canonical(rules),member)
        : this.q('UPDATE email_aura_policies SET tier=?,rules_json=?,version=version+1,updated_by_member_id=?,updated_at=? WHERE org_id=? AND aura_id=? AND version=?',body.tier,canonical(rules),member,new Date().toISOString(),this.org,aura,old.version),
      this.q(`UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND status IN ('pending','approved')
        AND message_id IN (SELECT id FROM email_messages WHERE org_id=? AND aura_id=? AND status IN ('draft','queued'))`,this.org,aura,this.org,aura),
    ]);
    return this.policy(aura);
  }
  async removePolicy(aura: string, member: string, version: unknown) {
    await this.reviewer(aura,member);
    const old = await this.policyConfig(aura);
    if (!old.version || version !== old.version) throw new HttpError(409,'Policy changed. Reload before removing it.');
    await this.env.DB.batch([
      this.q("UPDATE email_aura_policies SET tier=NULL,rules_json='{}',version=version+1,updated_by_member_id=?,updated_at=? WHERE org_id=? AND aura_id=? AND version=?",member,new Date().toISOString(),this.org,aura,version),
      this.q("UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND status IN ('pending','approved') AND message_id IN (SELECT id FROM email_messages WHERE org_id=? AND aura_id=? AND status IN ('draft','queued'))",this.org,aura,this.org,aura),
    ]);
    return this.policyConfig(aura);
  }
  async reset(aura: string, thread: string, member: string) {
    await this.reviewer(aura,member);
    await this.one('SELECT id FROM email_threads WHERE org_id=? AND aura_id=? AND id=?',this.org,aura,thread);
    await this.env.DB.batch([
      this.q("UPDATE email_threads SET review_epoch=review_epoch+1,state_version=state_version+1,review_reset_at=?,review_reset_by_member_id=?,tier_state='reset' WHERE org_id=? AND aura_id=? AND id=?",new Date().toISOString(),member,this.org,aura,thread),
      this.q(`UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND status IN ('pending','approved')
        AND message_id IN (SELECT id FROM email_messages WHERE org_id=? AND aura_id=? AND thread_id=?)`,this.org,aura,this.org,aura,thread),
    ]);
    return {status:'reset'};
  }
  async route(m: Row) {
    const r = await this.q(`SELECT a.id FROM email_address_assignments x JOIN email_addresses a ON a.org_id=x.org_id AND a.id=x.address_id
      JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id WHERE x.org_id=? AND x.aura_id=? AND x.id=? AND x.address_id=?
      AND x.ended_at IS NULL AND x.assigned_at<=? AND a.address_key=? AND a.status='active' AND d.status='active'`,
      this.org,m.aura_id,m.address_assignment_id,m.email_address_id,new Date().toISOString(),m.from_address.toLowerCase()).first();
    if (!r || !TEST_ADDRESSES.includes(m.from_address.toLowerCase())) throw new HttpError(409,'The test sending address is no longer active.');
  }
  async dispatch(aura: string, id: string, nativeReply?: (builder: EmailReplyMessageBuilder) => Promise<EmailSendResult>) {
    const r = await this.review(aura,id), m = await this.message(aura,r.message_id);
    if (m.status === 'sent' && r.status === 'sent') return {status:'already_sent'};
    if (r.status !== 'approved' || !['draft','queued'].includes(m.status)) throw new HttpError(409,'Only approved unsent messages can be sent.');
    const p = await this.fresh(r,m);
    if (r.decision_source === 'human') await this.reviewer(aura,r.approver_member_id);
    if (await this.limitReached(m,p)) throw new HttpError(409,'Daily limit reached.');
    if (r.decision_source === 'automatic' && await this.reason(m,await this.thread(m),p)) throw new HttpError(409,'The conversation needs review again.');
    await this.route(m);
    const recipients = (await this.q('SELECT kind,address FROM email_message_recipients WHERE org_id=? AND aura_id=? AND message_id=? ORDER BY kind,ordinal',this.org,aura,m.id).all<Row>()).results;
    if (!recipients.length || recipients.length > 50 || recipients.some(v => !bareAddress(v.address))) throw new HttpError(409,'Invalid recipients.');
    const byKind = (kind: string) => recipients.filter(r => r.kind === kind).map(r => r.address as string);
    if (!byKind('to').length) throw new HttpError(409,'A To recipient is required.');
    let body = {text:m.body_text,html:m.body_html};
    if (m.body_storage === 'r2') {
      const object = await this.env.MAIL.get(m.body_r2_key);
      if (!object) throw new HttpError(409,'Stored body is unavailable.');
      body = await object.json();
    }
    const attachmentRows = (await this.q('SELECT * FROM email_attachments WHERE org_id=? AND aura_id=? AND message_id=? ORDER BY ordinal',this.org,aura,m.id).all<Row>()).results;
    const attachments: EmailAttachment[] = [];
    let bytes = encoder.encode(body.text ?? '').byteLength + encoder.encode(body.html ?? '').byteLength;
    for (const a of attachmentRows) {
      const object = await this.env.MAIL.get(a.r2_key);
      if (!object) throw new HttpError(409,'An attachment is unavailable.');
      const data = await new Response(object.body).arrayBuffer(); bytes += data.byteLength;
      attachments.push(a.disposition === 'inline' && a.content_id
        ? {filename:a.filename || 'attachment',type:a.content_type,content:data,disposition:'inline',contentId:a.content_id}
        : {filename:a.filename || 'attachment',type:a.content_type,content:data,disposition:'attachment'});
    }
    if (bytes > 3 * 1024 * 1024) throw new HttpError(413,'The demo sender accepts at most 3 MiB before encoding.');
    const refs = JSON.parse(m.references_json) as string[];
    if ([m.subject,m.from_name,...refs,m.in_reply_to].some(v => v && /[\x00-\x1f\x7f]/.test(v))) throw new HttpError(409,'Invalid outgoing headers.');
    const builder: EmailReplyMessageBuilder = {
      from:{email:m.from_address,name:m.from_name ?? ''},replyTo:m.from_address,subject:m.subject ?? '',
      ...(body.text != null ? {text:body.text} : {}),...(body.html != null ? {html:body.html} : {}),
      headers:{'Auto-Submitted':'auto-replied','X-Auto-Response-Suppress':'All','X-Aura-Demo':'true',
        ...(m.in_reply_to ? {'In-Reply-To':`<${m.in_reply_to}>`} : {}),...(refs.length ? {References:refs.map(v => `<${v}>`).join(' ')} : {})},
      ...(attachments.length ? {attachments} : {}),
    };
    if ((!nativeReply || byKind('cc').length || byKind('bcc').length) && !this.env.EMAIL) throw new HttpError(503,'The email sender is not configured.');
    // Object reads may be slow. Recheck the exact decision and route at the provider boundary.
    await this.fresh(r,await this.message(aura,m.id)); await this.route(m);
    if (r.decision_source === 'human') await this.reviewer(aura,r.approver_member_id);
    const claim = await this.q("UPDATE email_messages SET status='sending' WHERE org_id=? AND aura_id=? AND id=? AND status IN ('draft','queued')",this.org,aura,m.id).run();
    if (!claim.meta.changes) throw new HttpError(409,'This message already has a send claim.');
    let result: EmailSendResult;
    try {
      // Native replies cannot carry CC/BCC. Use the sending binding whenever copies exist.
      result = nativeReply && !byKind('cc').length && !byKind('bcc').length
        ? await nativeReply(builder)
        : await this.env.EMAIL!.send({...builder,to:byKind('to'),...(byKind('cc').length ? {cc:byKind('cc')} : {}),...(byKind('bcc').length ? {bcc:byKind('bcc')} : {})});
    } catch {
      await this.q(`INSERT INTO email_events (id,org_id,aura_id,message_id,event_type,dedup_key,occurred_at,raw_payload_json)
        VALUES (?,?,?,?,'unknown',?,?,?) ON CONFLICT DO NOTHING`,crypto.randomUUID(),this.org,aura,m.id,`${m.id}:unknown`,new Date().toISOString(),JSON.stringify({send_status:'unknown',retry_safe:false})).run();
      return {status:'unknown',message:'Provider outcome is unknown. Do not retry this message.'};
    }
    const now = new Date().toISOString();
    try {
      await this.env.DB.batch([
        this.q("UPDATE email_messages SET status='sent',sent_at=?,activity_at=?,provider_message_id=?,rfc_message_id=? WHERE org_id=? AND aura_id=? AND id=?",now,now,result.messageId,result.messageId.replace(/^<|>$/g,''),this.org,aura,m.id),
        this.q("UPDATE email_reviews SET status='sent',sent_at=? WHERE org_id=? AND aura_id=? AND id=?",now,this.org,aura,id),
        this.q("UPDATE email_message_recipients SET delivery_status='accepted',delivery_status_at=? WHERE org_id=? AND aura_id=? AND message_id=?",now,this.org,aura,m.id),
        this.q("UPDATE email_threads SET tier_state='sent',last_activity_at=MAX(last_activity_at,?),state_version=state_version+1 WHERE org_id=? AND aura_id=? AND id=?",now,this.org,aura,m.thread_id),
      ]);
    } catch {
      return {status:'unknown',message:'Provider accepted the message, but tracking failed. Do not retry.'};
    }
    return {status:'sent'};
  }
}
