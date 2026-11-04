import type { Env } from './types.ts';
import { HttpError } from './types.ts';
import { cursor, encodeCursor, json, pageSize, requireId } from './utils.ts';
import { FAILURE_SUMMARIES, failureClass } from './llm/http.ts';
import { generateAddress, proposeAddress, readAddress, retryProvisioning } from './address.ts';

type Row = Record<string, any>;

const STALE_REPLY_MS = 120_000;
const ADDRESS_WRITE = /^\/api\/auras\/[^/]+\/address(\/provision)?$/;

function replyFailure(event: Row | undefined): { class: string; summary: string } | null {
  if (!event) return null;
  let code: unknown;
  try { code = JSON.parse(event.raw_payload_json).code; } catch { code = null; }
  const name = failureClass(code);
  return { class: name, summary: FAILURE_SUMMARIES[name] };
}

// Derived at read time. A generation that died mid-call must not look like it is still running.
function displayState(row: Row, now: number): 'timed_out' | null {
  const stalled = row.direction === 'out' && row.status === 'sending' && row.body_storage === 'inline'
    && row.body_text === null && row.body_html === null && now - Date.parse(row.created_at) > STALE_REPLY_MS;
  return stalled ? 'timed_out' : null;
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
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  if (request.method !== 'GET' && !(request.method === 'POST' && ADDRESS_WRITE.test(path))) {
    return json({ error: 'This inbox is read-only.' }, 405);
  }
  // A JSON content type forces a CORS preflight, which this API never grants, so other sites cannot post here.
  if (request.method === 'POST' && !/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
    return json({ error: 'Send a JSON request.' }, 415);
  }
  const org = env.DEMO_ORG_ID;
  if (path === '/api/health') {
    await env.DB.prepare('SELECT 1').first();
    return json({ status: 'ok', mode: 'public-test', organization: org });
  }
  if (path === '/api/auras') {
    const { results } = await env.DB.prepare(`SELECT a.id, a.name,
      (SELECT COUNT(*) FROM email_threads t WHERE t.org_id=a.org_id AND t.aura_id=a.id) AS thread_count,
      (SELECT COUNT(*) FROM email_messages m WHERE m.org_id=a.org_id AND m.aura_id=a.id) AS message_count
      FROM auras a WHERE a.org_id=? ORDER BY a.name, a.id`).bind(org).all<Row>();
    const addresses = await env.DB.prepare(`SELECT x.aura_id, e.address, e.status, d.status AS domain_status,
      COALESCE(p.status,'active') AS provisioning_status
      FROM email_address_assignments x JOIN email_addresses e ON e.org_id=x.org_id AND e.id=x.address_id
      JOIN email_domains d ON d.org_id=e.org_id AND d.id=e.domain_id
      LEFT JOIN email_address_provisioning p ON p.org_id=e.org_id AND p.address_id=e.id
      WHERE x.org_id=? AND x.ended_at IS NULL ORDER BY d.status='active' DESC, e.address`).bind(org).all<Row>();
    return json({ auras: results.map(row => ({ ...row, addresses: addresses.results.filter(a => a.aura_id === row.id) })) });
  }
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'auras' || !parts[2]) throw new HttpError(404, 'Endpoint not found.');
  const auraId = requireId(parts[2]);
  const selectedAura = await aura(env, auraId);
  if (parts[3] === 'address') {
    if (parts.length === 4) return request.method === 'POST' ? generateAddress(request, env, selectedAura) : readAddress(env, auraId);
    if (parts.length === 5 && parts[4] === 'provision' && request.method === 'POST') return retryProvisioning(env, auraId);
    if (parts.length === 5 && parts[4] === 'proposal') return proposeAddress(env, selectedAura);
  }
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
      COALESCE(
        (SELECT m.from_address FROM email_messages m WHERE m.org_id=t.org_id AND m.aura_id=t.aura_id AND m.thread_id=t.id AND m.direction='in' ORDER BY m.activity_at DESC,m.id DESC LIMIT 1),
        (SELECT r.address FROM email_messages m JOIN email_message_recipients r ON r.org_id=m.org_id AND r.aura_id=m.aura_id AND r.message_id=m.id
          WHERE m.org_id=t.org_id AND m.aura_id=t.aura_id AND m.thread_id=t.id AND r.kind='to' ORDER BY m.activity_at DESC,m.id DESC,r.ordinal LIMIT 1)) AS sender,
      COALESCE((SELECT m.status='failed' FROM email_messages m WHERE m.org_id=t.org_id AND m.aura_id=t.aura_id AND m.thread_id=t.id AND m.direction='out' ORDER BY m.activity_at DESC,m.id DESC LIMIT 1),0) AS reply_failed,
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
    const thread = await env.DB.prepare('SELECT id, subject, inbox_status, last_activity_at FROM email_threads WHERE org_id=? AND aura_id=? AND id=?')
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
    let recipients: Row[] = [], attachments: Row[] = [], failures: Row[] = [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [r, a, f] = await Promise.all([
        env.DB.prepare(`SELECT message_id,kind,address,display_name FROM email_message_recipients WHERE org_id=? AND aura_id=? AND kind<>'bcc' AND message_id IN (${placeholders}) ORDER BY ordinal`).bind(org,auraId,...ids).all<Row>(),
        env.DB.prepare(`SELECT id,message_id,filename,content_type,size_bytes FROM email_attachments WHERE org_id=? AND aura_id=? AND message_id IN (${placeholders}) ORDER BY ordinal`).bind(org,auraId,...ids).all<Row>(),
        env.DB.prepare(`SELECT message_id,raw_payload_json FROM email_events WHERE org_id=? AND aura_id=? AND event_type='failed' AND json_extract(raw_payload_json,'$.stage')='generation' AND message_id IN (${placeholders})`).bind(org,auraId,...ids).all<Row>(),
      ]);
      recipients = r.results; attachments = a.results; failures = f.results;
    }
    const now = Date.now();
    return json({ thread, messages: rows.reverse().map(row => ({ ...row,
      recipients: recipients.filter(r => r.message_id === row.id),
      attachments: attachments.filter(a => a.message_id === row.id),
      failure: replyFailure(failures.find(f => f.message_id === row.id)),
      display_state: displayState(row, now),
    })), nextCursor: results.length > limit && last ? encodeCursor(last.activity_at,last.id) : null });
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
