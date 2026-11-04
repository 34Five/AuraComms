import type { Email } from 'postal-mime';
import type { Env } from './types.ts';
import { messageIds } from './utils.ts';
import { Governance, TEST_ADDRESSES } from './governance.ts';

const ADDRESSES = new Set(TEST_ADDRESSES);
const SAMPLE = '34Five Aura email demo attachment.\nThis is a sample file for testing only.\n';
const encoder = new TextEncoder();
type Context = { org_id: string; aura_id: string; address_id: string; assignment_id: string; message_id: string; thread_id: string };

export async function autoReply(message: ForwardableEmailMessage, env: Env, parsed: Email, context: Context): Promise<void> {
  if (env.TEST_MODE !== 'true' || env.AUTO_REPLY_ENABLED !== 'true') return;
  const address = message.to.trim().toLowerCase();
  const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, message_id: context.message_id, ...fields }));
  const skip = (reason: string) => log('inbox_auto_reply_skipped', { reason });
  if (typeof message.reply !== 'function' && message.headers.get('x-aura-dmarc-pass') !== 'true') return skip('sender_not_authenticated');
  if (!ADDRESSES.has(address)) return skip('not_test_address');
  if (!/^[^\s<>@,;\x00-\x1f\x7f]+@[^\s<>@,;\x00-\x1f\x7f]+$/.test(message.from)) return skip('invalid_sender');
  const sender = message.from.toLowerCase();
  if (parsed.from?.address?.toLowerCase() !== sender) return skip('sender_header_mismatch');
  if (ADDRESSES.has(sender) || sender === 'spike-test@34five.studio' || /^(?:mailer-daemon|postmaster|no-?reply)@/i.test(sender)) return skip('automated_sender');
  const values = (name: string) => {
    const found = parsed.headers.filter(h => h.key === name).map(h => h.value);
    return found.length ? found : [message.headers.get(name) ?? ''].filter(Boolean);
  };
  if (values('auto-submitted').some(v => v.trim().toLowerCase() !== 'no') ||
      values('precedence').some(v => /\b(?:bulk|list|junk)\b/i.test(v)) ||
      values('list-id').length || values('x-aura-demo').length ||
      values('x-auto-response-suppress').some(v => v.trim().toLowerCase() !== 'none') ||
      values('content-type').some(v => /multipart\/report|message\/delivery-status/i.test(v))) return skip('automated_message');
  const original = values('message-id');
  const originalId = original[0]?.trim() ?? '';
  if (original.length !== 1 || !/^<[^\s<>@]+@[^\s<>@]+>$/.test(originalId) || encoder.encode(originalId).byteLength > 512) return skip('invalid_message_id');
  const references = messageIds(values('references').join(' '));
  if (references.length >= 20) return skip('demo_thread_limit');
  const subject = parsed.subject?.trim() || '34Five Aura email demo';
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  if (/[\x00-\x1f\x7f]/.test(replySubject) || encoder.encode(replySubject).byteLength > 998) return skip('invalid_subject');
  const now = new Date().toISOString();
  const activeRoute = () => env.DB.prepare(`SELECT u.name FROM email_address_assignments x
    JOIN email_addresses a ON a.org_id=x.org_id AND a.id=x.address_id
    JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id
    JOIN auras u ON u.org_id=x.org_id AND u.id=x.aura_id
    WHERE x.org_id=? AND x.aura_id=? AND x.id=? AND x.address_id=? AND x.ended_at IS NULL
    AND x.assigned_at<=? AND a.address_key=? AND a.status='active' AND d.status='active'`)
    .bind(context.org_id,context.aura_id,context.assignment_id,context.address_id,new Date().toISOString(),address).first<{ name: string }>();
  const active = await activeRoute();
  if (!active) return skip('assignment_no_longer_active');
  const includeAttachment = parsed.attachments.length > 0 || /\battachments?\b/i.test(`${subject}\n${parsed.text ?? ''}\n${(parsed.html ?? '').replace(/<[^>]*>/g,' ')}`);
  const text = [
    'Hello! This is the 34Five Aura email demo.',
    `Your email reached ${address} (${active.name}), and this is an automatic test reply.`,
    `We received ${parsed.attachments.length} attachment(s).`,
    includeAttachment ? 'A sample test file is attached. Your uploaded files are not echoed back.' : 'Mention attachment or attachments to receive a sample test file.',
    'Reply to this email to continue testing the same conversation.',
    'This is a fixed demo response, not an AI-generated answer.',
  ].join('\n\n');
  const id = `reply_${context.message_id}`;
  const parentId = originalId.slice(1,-1);
  const chain = [...new Set([...references,parentId])];
  // This unique key claims the send atomically, including redeliveries with changed MIME bytes.
  const sendKey = `demo-reply:${sender}:${originalId}`;
  const claim = await env.DB.prepare(`INSERT INTO email_messages
    (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,send_idempotency_key,
    envelope_from,envelope_to,from_address,from_name,subject,body_storage,body_text,body_size_bytes,in_reply_to,references_json,activity_at,created_at)
    VALUES (?,?,?,?,?,?,'out','draft',?,?,?,?,?,?,'inline',?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(id,context.org_id,context.aura_id,context.thread_id,context.address_id,context.assignment_id,sendKey,
      address,message.from,address,active.name,replySubject,text,encoder.encode(text).byteLength,parentId,JSON.stringify(chain),now,now).run();
  if (!claim.meta.changes) return skip('duplicate_reply_claim');
  try {
    const statements = [env.DB.prepare(`INSERT INTO email_message_recipients (id,org_id,aura_id,message_id,kind,ordinal,address,address_key)
      VALUES (?,?,?,?,'to',0,?,?)`).bind(`${id}_to`,context.org_id,context.aura_id,id,message.from,sender)];
    if (includeAttachment) {
      const attachmentKey = `email/${context.org_id}/${context.aura_id}/${id}/aura-demo.txt`;
      await env.MAIL.put(attachmentKey,SAMPLE,{httpMetadata:{contentType:'text/plain'}});
      statements.push(env.DB.prepare(`INSERT INTO email_attachments
        (id,org_id,aura_id,message_id,ordinal,filename,content_type,size_bytes,r2_key)
        VALUES (?,?,?,?,0,'aura-demo.txt','text/plain',?,?)`)
        .bind(`${id}_attachment`,context.org_id,context.aura_id,id,encoder.encode(SAMPLE).byteLength,attachmentKey));
    }
    statements.push(env.DB.prepare('UPDATE email_threads SET last_activity_at=MAX(last_activity_at,?) WHERE org_id=? AND aura_id=? AND id=?')
      .bind(now,context.org_id,context.aura_id,context.thread_id));
    await env.DB.batch(statements);
  } catch {
    // No provider call has happened. Keep the claim to prevent an automatic resend.
    await env.DB.prepare("UPDATE email_messages SET status='failed' WHERE org_id=? AND aura_id=? AND id=?")
      .bind(context.org_id,context.aura_id,id).run().catch(() => undefined);
    log('inbox_auto_reply_preparation_failed', { reply_id: id });
    return;
  }
  const governance = new Governance(env);
  try {
    if (!await activeRoute()) {
      await env.DB.prepare("UPDATE email_messages SET status='cancelled' WHERE org_id=? AND aura_id=? AND id=?")
        .bind(context.org_id,context.aura_id,id).run();
      return skip('assignment_changed_before_send');
    }
    const review = await governance.evaluate(context.aura_id,id);
    if (review.status === 'approved') {
      const result = await governance.dispatch(context.aura_id,review.id,
        typeof message.reply === 'function' ? builder => message.reply(builder) : undefined);
      log('inbox_governed_reply',{reply_id:id,status:result.status});
    } else log('inbox_reply_held',{reply_id:id,review_id:review.id,reason:review.reason});
  } catch (error) {
    // Keep the draft and claim. Missing/invalid policies must never fall back to sending.
    log('inbox_governance_hold',{reply_id:id,reason:error instanceof Error ? error.message : 'Evaluation failed.'});
  }
}
