import PostalMime from 'postal-mime';
import { HttpError, type Env } from './types.ts';
import { messageIds, readBounded } from './utils.ts';

const encoder = new TextEncoder();
const MAX_BYTES = 25 * 1024 * 1024;
type Route = { org_id: string; aura_id: string; address_id: string; assignment_id: string; assigned_at: string };

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function receive(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (env.TEST_MODE !== 'true' || !env.DEMO_ORG_ID) throw new Error('Test inbox is not configured.');
  const recipient = message.to.trim().toLowerCase();
  if (message.rawSize > MAX_BYTES) { message.setReject('Email exceeds 25 MiB.'); return; }
  const route = await env.DB.prepare(`SELECT a.org_id,a.id AS address_id,x.aura_id,x.id AS assignment_id,x.assigned_at
    FROM email_addresses a JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id
    JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id
    WHERE a.org_id=? AND a.address_key=? AND a.status='active' AND d.status='active' AND x.ended_at IS NULL`)
    .bind(env.DEMO_ORG_ID,recipient).first<Route>();
  if (!route) { message.setReject('This address has no active Aura inbox.'); return; }
  let raw: Uint8Array;
  try { raw = await readBounded(message.raw, MAX_BYTES); }
  catch (error) {
    if (error instanceof HttpError && error.status === 413) { message.setReject(error.message); return; }
    throw error;
  }
  const prefix = encoder.encode(`${route.org_id}\n${message.from.trim().toLowerCase()}\n${recipient}\n`);
  const fingerprintInput = new Uint8Array(prefix.byteLength + raw.byteLength);
  fingerprintInput.set(prefix); fingerprintInput.set(raw, prefix.byteLength);
  const fingerprint = await hash(fingerprintInput);
  const ingestKey = `mime-sha256:${fingerprint}`;
  const existing = await env.DB.prepare('SELECT id FROM email_messages WHERE org_id=? AND ingest_key=? LIMIT 1')
    .bind(route.org_id,ingestKey).first();
  if (existing) return;
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  if (parsed.attachments.length > 20 || (parsed.to?.length ?? 0) + (parsed.cc?.length ?? 0) > 20) {
    message.setReject('The test inbox accepts at most 20 attachments and 20 recipients.'); return;
  }
  const header = (name: string) => parsed.headers.filter(h => h.key === name).map(h => h.value).join(' ') || message.headers.get(name);
  const references = messageIds(header('references')).slice(-40);
  const parent = messageIds(header('in-reply-to')).at(-1) ?? null;
  const candidates = [...new Set([...(parent ? [parent] : []),...references])];
  let threadId = `thread_${fingerprint}`;
  if (candidates.length) {
    const known = await env.DB.prepare(`SELECT DISTINCT thread_id FROM email_messages WHERE org_id=? AND aura_id=? AND rfc_message_id IN (${candidates.map(() => '?').join(',')})`)
      .bind(route.org_id,route.aura_id,...candidates).all<{ thread_id: string }>();
    if (known.results.length === 1) threadId = known.results[0].thread_id;
  }
  const now = new Date().toISOString();
  if (now < route.assigned_at) throw new Error('The active assignment starts in the future.');
  const id = `in_${fingerprint}`;
  const contactAddress = (parsed.from?.address || message.from).trim().toLowerCase();
  const contactId = `contact_${await hash(encoder.encode(`${route.org_id}\n${contactAddress}`))}`;
  const rfcId = messageIds(header('message-id')).at(-1) ?? null;
  const text = parsed.text ?? null, html = parsed.html ?? null;
  const bodyBytes = encoder.encode(text ?? '').byteLength + encoder.encode(html ?? '').byteLength;
  const large = bodyBytes > 65536;
  const storagePrefix = `email/${route.org_id}/${route.aura_id}/${id}`;
  const rawKey = `${storagePrefix}/raw.eml`;
  const bodyKey = large ? `${storagePrefix}/body.json` : null;
  // Attempt-specific keys keep failed concurrent deliveries from deleting a winner's objects.
  const attempt = crypto.randomUUID();
  const storedKeys: string[] = [];
  const put = async (key: string, value: ArrayBuffer | Uint8Array | string, contentType: string) => {
    const attemptKey = `${key}.${attempt}`;
    await env.MAIL.put(attemptKey,value,{ httpMetadata: { contentType } });
    storedKeys.push(attemptKey);
    return attemptKey;
  };
  let committed = false;
  try {
    const rawStored = await put(rawKey,raw,'message/rfc822');
    const bodyStored = bodyKey ? await put(bodyKey,JSON.stringify({ text, html }),'application/json') : null;
    const attachmentRows = [];
    for (const [ordinal, attachment] of parsed.attachments.entries()) {
      const attachmentId = `${id}_att_${ordinal}`;
      const content = attachment.content as ArrayBuffer;
      const key = await put(`${storagePrefix}/attachments/${attachmentId}`,content,attachment.mimeType);
      attachmentRows.push({ id: attachmentId, ordinal, key, size: content.byteLength, attachment });
    }
    const statements = [
      env.DB.prepare(`INSERT INTO email_contacts (id,org_id,address,address_key,display_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id,address_key) DO NOTHING`)
        .bind(contactId,route.org_id,contactAddress,contactAddress,parsed.from?.name ?? null,now,now),
      env.DB.prepare(`INSERT INTO email_threads (id,org_id,aura_id,subject,last_activity_at,created_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(threadId,route.org_id,route.aura_id,parsed.subject ?? null,now,now),
      env.DB.prepare(`INSERT INTO email_messages
        (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,rfc_message_id,ingest_key,
        envelope_from,envelope_to,from_address,from_name,sender_contact_id,subject,body_storage,body_text,body_html,
        body_r2_key,body_size_bytes,raw_mime_r2_key,in_reply_to,references_json,received_at,activity_at,created_at,reply_to_json)
        VALUES (?,?,?,?,?,?,'in','received',?,?,?,?,?,?,
        (SELECT id FROM email_contacts WHERE org_id=? AND address_key=?),?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT DO NOTHING`).bind(id,route.org_id,route.aura_id,threadId,route.address_id,route.assignment_id,
          rfcId,ingestKey,message.from,recipient,parsed.from?.address || message.from,parsed.from?.name ?? null,
          route.org_id,contactAddress,parsed.subject ?? null,large ? 'r2' : 'inline',large ? null : text,large ? null : html,
          bodyStored,bodyBytes,rawStored,parent,JSON.stringify(references),now,now,now,JSON.stringify(parsed.replyTo ?? [])),
    ];
    const recipients = [...(parsed.to ?? []).map(r => ({ ...r, kind: 'to' })),...(parsed.cc ?? []).map(r => ({ ...r, kind: 'cc' }))];
    if (!recipients.some(r => r.address?.toLowerCase() === recipient)) recipients.push({ address: recipient, name: '', kind: 'to' });
    for (const [ordinal,r] of recipients.entries()) {
      if (!r.address) continue;
      statements.push(env.DB.prepare(`INSERT INTO email_message_recipients
        (id,org_id,aura_id,message_id,kind,ordinal,address,address_key,display_name)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(`${id}_rcpt_${ordinal}`,route.org_id,route.aura_id,id,r.kind,ordinal,r.address,r.address.toLowerCase(),r.name || null));
    }
    for (const row of attachmentRows) {
      statements.push(env.DB.prepare(`INSERT INTO email_attachments
        (id,org_id,aura_id,message_id,ordinal,filename,content_type,size_bytes,r2_key,content_id,disposition)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(row.id,route.org_id,route.aura_id,id,row.ordinal,row.attachment.filename ?? null,
          row.attachment.mimeType,row.size,row.key,row.attachment.contentId ?? null,
          row.attachment.disposition === 'inline' ? 'inline' : 'attachment'));
    }
    statements.push(env.DB.prepare(`UPDATE email_threads SET first_message_id=COALESCE(first_message_id,?),
      last_activity_at=MAX(last_activity_at,(SELECT activity_at FROM email_messages WHERE org_id=? AND aura_id=? AND id=?))
      WHERE org_id=? AND aura_id=? AND id=?`).bind(id,route.org_id,route.aura_id,id,route.org_id,route.aura_id,threadId));
    const result = await env.DB.batch(statements);
    committed = true;
    // The third statement owns this delivery. A concurrent duplicate leaves its private objects unreferenced.
    if (!result[2].meta.changes) await env.MAIL.delete(storedKeys);
    console.log(JSON.stringify({ event: 'inbox_received', aura_id: route.aura_id, message_id: id, thread_id: threadId }));
  } catch (error) {
    // Never remove objects after an ambiguous database response: the transaction may have committed.
    if (!committed) {
      const saved = await env.DB.prepare('SELECT raw_mime_r2_key FROM email_messages WHERE org_id=? AND id=?')
        .bind(route.org_id,id).first<{ raw_mime_r2_key: string }>().catch(() => null);
      if (saved && !storedKeys.includes(saved.raw_mime_r2_key)) await env.MAIL.delete(storedKeys);
    }
    console.error(JSON.stringify({ event: 'inbox_receive_failed', message_id: id }));
    throw error;
  }
}
