import { sendFailureSummary } from './generated-sender.ts';
import { authenticationApi, sessionIdentity } from './session-auth.ts';
import type { Env } from './types.ts';
import { managementApi } from './management-api.ts';
import { Governance } from './governance.ts';
import { governanceApi } from './governance-api.ts';
import { HttpError } from './types.ts';
import { cursor, encodeCursor, json, pageSize, requireId } from './utils.ts';
import { FAILURE_SUMMARIES, failureClass } from './llm/http.ts';
import { auraConfig } from './llm/prompt.ts';

type Row = Record<string, any>;

const STALE_REPLY_MS = 120_000;

function replyFailure(event: Row | undefined): { class: string; summary: string } | null {
  if (!event) return null;
  let code: unknown;
  try { code = JSON.parse(event.raw_payload_json).code; } catch { code = null; }
  const name = failureClass(code);
  return { class: name, summary: FAILURE_SUMMARIES[name] };
}

// Derived at read time. A generation that died mid-call must not look like it is still running.
function displayState(row: Row, now: number, event?:Row): 'timed_out' | 'send_unknown' | 'send_failed' | null {
  const stalled = row.direction === 'out' && row.status === 'sending' && row.body_storage === 'inline'
    && row.body_text === null && row.body_html === null && now - Date.parse(row.created_at) > STALE_REPLY_MS;
  if(stalled)return 'timed_out';
  if(row.direction==='out' && row.status==='failed' && event?.event_type==='failed')return 'send_failed';
  if(row.direction==='out' && row.status==='sending' && (event?.event_type==='unknown' || ((row.body_storage==='r2'||row.body_text!==null||row.body_html!==null) && now-Date.parse(row.activity_at)>STALE_REPLY_MS)))return 'send_unknown';
  return null;
}

function sendFailure(event?:Row) {
  if(event?.event_type!=='failed')return null;
  let payload:Record<string,any>={};try{payload=JSON.parse(event.raw_payload_json);}catch{}
  return {summary:sendFailureSummary(Number.isInteger(payload.http_status)?payload.http_status:null,Array.isArray(payload.codes)?payload.codes.filter(Number.isInteger):[])};
}

async function aura(env: Env, id: string): Promise<Row> {
  const row = await env.DB.prepare('SELECT id, name FROM auras WHERE org_id = ? AND id = ?')
    .bind(env.DEMO_ORG_ID, requireId(id)).first<Row>();
  if (!row) throw new HttpError(404, 'Aura not found.');
  return row;
}

async function message(env: Env, auraId: string, messageId: string): Promise<Row> {
  const row = await env.DB.prepare('SELECT * FROM email_messages WHERE org_id = ? AND aura_id = ? AND id = ?')
    .bind(env.DEMO_ORG_ID, auraId, requireId(messageId)).first<Row>();
  if (!row) throw new HttpError(404, 'Message not found.');
  return row;
}

export async function api(request: Request, env: Env): Promise<Response> {
  if (env.TEST_MODE !== 'true' || !env.DEMO_ORG_ID || env.DEMO_ORG_ID === 'org') {
    throw new HttpError(503, 'The test inbox is not configured.');
  }
  if (!['GET','POST','PUT','DELETE'].includes(request.method)) return json({error:'Method not allowed.'},405);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  const org = env.DEMO_ORG_ID;
  if(path==='/api/auth'||path.startsWith('/api/auth/')) return authenticationApi(request,env);
  const identity=env.DEMO_LOGIN_ENABLED!=='false'?await sessionIdentity(request,env):null;
  if (path === '/api/manage' || path.startsWith('/api/manage/')) return managementApi(request,env);
  if (path === '/api/health' && request.method === 'GET') {
    await env.DB.prepare('SELECT 1').first();
    return json({ status: 'ok', mode: identity?'authenticated-demo':'public-test', organization: org });
  }
  if (path === '/api/auras' && request.method !== 'GET') return json({error:'Method not allowed.'},405);
  if (path === '/api/auras') {
    const { results } = await env.DB.prepare(`SELECT a.*,
      (SELECT p.tier FROM email_aura_policies p WHERE p.org_id=a.org_id AND p.aura_id=a.id) AS tier,
      (SELECT COUNT(*) FROM email_reviews r JOIN email_messages m ON m.org_id=r.org_id AND m.aura_id=r.aura_id AND m.id=r.message_id WHERE r.org_id=a.org_id AND r.aura_id=a.id AND r.status='pending' AND m.status IN ('draft','queued')) AS pending_count,
      (SELECT COUNT(*) FROM email_threads t WHERE t.org_id=a.org_id AND t.aura_id=a.id) AS thread_count,
      (SELECT COUNT(*) FROM email_messages m WHERE m.org_id=a.org_id AND m.aura_id=a.id) AS message_count
      FROM auras a WHERE a.org_id=? ORDER BY CASE WHEN tier IN ('1','2','3','4') THEN CAST(tier AS INTEGER) ELSE 5 END, a.name, a.id`).bind(org).all<Row>();
    const addresses = await env.DB.prepare(`SELECT x.aura_id, e.address, e.status, d.status AS domain_status
      FROM email_address_assignments x JOIN email_addresses e ON e.org_id=x.org_id AND e.id=x.address_id
      JOIN email_domains d ON d.org_id=e.org_id AND d.id=e.domain_id
      WHERE x.org_id=? AND x.ended_at IS NULL ORDER BY d.status='active' DESC, e.address`).bind(org).all<Row>();
    const assigned=new Set(identity?.role==='reviewer'?(await env.DB.prepare('SELECT aura_id FROM email_aura_reviewers WHERE org_id=? AND member_id=? AND revoked_at IS NULL').bind(org,identity.member_id).all<{aura_id:string}>()).results.map(a=>a.aura_id):[]);
    const visible=identity?.role==='reviewer'?results.filter(row=>assigned.has(String(row.id))):results;
    return json({ auras: visible.map(row => ({ id:row.id,name:row.name,role:auraConfig(row).role,tier:row.tier,pending_count:row.pending_count,thread_count:row.thread_count,message_count:row.message_count,addresses: addresses.results.filter(a => a.aura_id === row.id) })) });
  }
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'auras' || !parts[2]) throw new HttpError(404, 'Endpoint not found.');
  const auraId = requireId(parts[2]);
  const selectedAura = await aura(env, auraId);
  if(identity?.role==='reviewer' && !await env.DB.prepare('SELECT 1 FROM email_aura_reviewers WHERE org_id=? AND aura_id=? AND member_id=? AND revoked_at IS NULL').bind(org,auraId,identity.member_id).first()) throw new HttpError(404,'Aura not found.');
  const governance = await governanceApi(request,env,auraId,parts);
  if (governance) return governance;
  if (request.method !== 'GET') return json({error:'Method not allowed.'},405);
  if (parts.length === 4 && parts[3] === 'inbox') {
    const limit = pageSize(url);
    const after = cursor(url.searchParams.get('cursor'));
    const status = url.searchParams.get('status');
    if (status && !['open', 'closed', 'archived'].includes(status)) throw new HttpError(400, 'Invalid inbox status.');
    const search = (url.searchParams.get('q') ?? '').trim();
    if (search.length > 200) throw new HttpError(400, 'Search must have at most 200 characters.');
    const filters = ['t.org_id=?', 't.aura_id=?'];
    const binds: (string | number)[] = [org, auraId];
    if (status) { filters.push('t.inbox_status=?'); binds.push(status); }
    if (after) { filters.push('(t.last_activity_at,t.id)<(?,?)'); binds.push(...after); }
    if (search) {
      filters.push("(t.subject LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM email_messages s WHERE s.org_id=t.org_id AND s.aura_id=t.aura_id AND s.thread_id=t.id AND s.from_address LIKE ? ESCAPE '\\'))");
      const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
      binds.push(pattern, pattern);
    }
    const { results } = await env.DB.prepare(`SELECT t.id,t.subject,t.inbox_status,t.last_activity_at,
      (SELECT COUNT(*) FROM email_messages m WHERE m.org_id=t.org_id AND m.aura_id=t.aura_id AND m.thread_id=t.id) AS message_count,
      (SELECT m.from_address FROM email_messages m WHERE m.org_id=t.org_id AND m.aura_id=t.aura_id AND m.thread_id=t.id ORDER BY m.activity_at DESC,m.id DESC LIMIT 1) AS sender,
      (SELECT substr(m.body_text,1,160) FROM email_messages m WHERE m.org_id=t.org_id AND m.aura_id=t.aura_id AND m.thread_id=t.id ORDER BY m.activity_at DESC,m.id DESC LIMIT 1) AS preview
      FROM email_threads t WHERE ${filters.join(' AND ')} ORDER BY t.last_activity_at DESC,t.id DESC LIMIT ?`)
      .bind(...binds, limit + 1).all<Row>();
    const rows = results.slice(0, limit);
    const last = rows.at(-1);
    return json({ aura: selectedAura, threads: rows,
      nextCursor: results.length > limit && last ? encodeCursor(last.last_activity_at, last.id) : null });
  }
  if (parts.length === 6 && parts[3] === 'threads' && parts[5] === 'messages') {
    const threadId = requireId(parts[4]);
    const thread = await env.DB.prepare('SELECT id, subject, inbox_status, last_activity_at, review_epoch, tier_state FROM email_threads WHERE org_id=? AND aura_id=? AND id=?')
      .bind(org, auraId, threadId).first<Row>();
    if (!thread) throw new HttpError(404, 'Conversation not found.');
    const limit = pageSize(url);
    const after = cursor(url.searchParams.get('cursor'));
    const binds: (string | number)[] = [org, auraId, threadId];
    if (after) binds.push(...after);
    const { results } = await env.DB.prepare(`SELECT id,direction,status,from_address,from_name,subject,body_storage,
      body_text,body_html,body_size_bytes,activity_at,created_at FROM email_messages
      WHERE org_id=? AND aura_id=? AND thread_id=? ${after ? 'AND (activity_at,id)<(?,?)' : ''}
      ORDER BY activity_at DESC,id DESC LIMIT ?`).bind(...binds, limit + 1).all<Row>();
    const rows = results.slice(0, limit);
    const last = rows.at(-1);
    const ids = rows.map(m => m.id);
    let recipients: Row[] = [], attachments: Row[] = [], failures: Row[] = [], sends:Row[]=[];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [r, a, f, s] = await Promise.all([
        env.DB.prepare(`SELECT message_id,kind,address,display_name FROM email_message_recipients WHERE org_id=? AND aura_id=? AND kind<>'bcc' AND message_id IN (${placeholders}) ORDER BY ordinal`).bind(org,auraId,...ids).all<Row>(),
        env.DB.prepare(`SELECT id,message_id,filename,content_type,size_bytes FROM email_attachments WHERE org_id=? AND aura_id=? AND message_id IN (${placeholders}) ORDER BY ordinal`).bind(org,auraId,...ids).all<Row>(),
        env.DB.prepare(`SELECT message_id,raw_payload_json FROM email_events WHERE org_id=? AND aura_id=? AND event_type='failed' AND json_extract(raw_payload_json,'$.stage')='generation' AND message_id IN (${placeholders})`).bind(org,auraId,...ids).all<Row>(),
        env.DB.prepare(`SELECT message_id,event_type,raw_payload_json FROM email_events WHERE org_id=? AND aura_id=? AND (event_type='unknown' OR (event_type='failed' AND json_extract(raw_payload_json,'$.stage')='dispatch')) AND message_id IN (${placeholders}) ORDER BY occurred_at DESC`).bind(org,auraId,...ids).all<Row>(),
      ]);
      recipients = r.results; attachments = a.results; failures = f.results; sends=s.results;
    }
    const g = new Governance(env);
    // Read current revisions per message, independent of the management history limit.
    const reviews = ids.length ? (await env.DB.prepare(`SELECT r.id,r.message_id,r.status,r.revision,r.tier_applied,r.reason,r.decision_source,r.edited_before_send,r.approver_member_id,r.requested_at,r.decided_at
      FROM email_reviews r WHERE r.org_id=? AND r.aura_id=? AND r.message_id IN (${ids.map(()=>'?').join(',')})
      AND r.revision=(SELECT MAX(x.revision) FROM email_reviews x WHERE x.org_id=r.org_id AND x.aura_id=r.aura_id AND x.message_id=r.message_id)`)
      .bind(org,auraId,...ids).all<Row>()).results : [];
    let canReview = false;
    if (identity) {
      try { await g.reviewer(auraId,identity.member_id); canReview = true; }
      catch (error) { if (!(error instanceof HttpError) || error.status !== 403) throw error; }
    }
    const now = Date.now();
    return json({ thread, messages: await Promise.all(rows.reverse().map(async row => ({ ...row,
      review: reviews.find(r=>r.message_id===row.id) ?? null,
      review_permissions: {review:canReview,edit:canReview && identity?.role!=='reviewer'},
      draft_version: row.direction==='out' && ['draft','queued'].includes(row.status) ? await g.draftVersion(await message(env,auraId,row.id)) : null,
      recipients: recipients.filter(r => r.message_id === row.id),
      attachments: attachments.filter(a => a.message_id === row.id),
      failure: replyFailure(failures.find(f => f.message_id === row.id)),
      send_failure: sendFailure(sends.find(s=>s.message_id===row.id)),
      display_state: displayState(row, now,sends.find(s=>s.message_id===row.id)),
    }))), nextCursor: results.length > limit && last ? encodeCursor(last.activity_at,last.id) : null });
  }
  if (parts[3] === 'messages' && parts[4]) {
    const msg = await message(env, auraId, parts[4]);
    if (parts.length === 6 && parts[5] === 'body') {
      if (msg.body_storage === 'inline') return json({ body_text: msg.body_text, body_html: msg.body_html });
      const object = await env.MAIL.get(msg.body_r2_key);
      if (!object) throw new HttpError(404, 'Stored message body is unavailable.');
      const body = await object.json<{ text: string | null; html: string | null }>();
      return json({ body_text: body.text, body_html: body.html });
    }
    if (parts.length === 7 && parts[5] === 'attachments') {
      const attachment = await env.DB.prepare('SELECT filename,r2_key FROM email_attachments WHERE org_id=? AND aura_id=? AND message_id=? AND id=?')
        .bind(org,auraId,msg.id,requireId(parts[6])).first<Row>();
      if (!attachment) throw new HttpError(404, 'Attachment not found.');
      const object = await env.MAIL.get(attachment.r2_key);
      if (!object) throw new HttpError(404, 'Attachment content is unavailable.');
      const filename = encodeURIComponent(attachment.filename || 'attachment').replaceAll("'", '%27');
      return new Response(object.body, { headers: {
        'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      } });
    }
  }
  throw new HttpError(404, 'Endpoint not found.');
}
