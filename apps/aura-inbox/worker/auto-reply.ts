import type { Email } from 'postal-mime';
import type { Env } from './types.ts';
import { messageIds } from './utils.ts';
import { LlmError, failureClass, safeDetail } from './llm/http.ts';
import { buildReplyPrompt, finalizeReply, loadThread, type AuraConfig } from './llm/prompt.ts';
import { createProvider, resolveModel, type ModelRef } from './llm/provider.ts';

const ADDRESSES = new Set(['support-test@34five.studio', 'sales-test@34five.studio']);
const SAMPLE = '34Five Aura email demo attachment.\nThis is a sample file for testing only.\n';
const encoder = new TextEncoder();
type Context = { org_id: string; aura_id: string; address_id: string; assignment_id: string; message_id: string; thread_id: string };

function diagnostic(error: unknown): { code: string; message: string } {
  const clean = (s: unknown) => String(s).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512);
  return {
    code: clean(error && typeof error === 'object' && 'code' in error ? error.code : 'E_REPLY_UNKNOWN'),
    message: clean(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Reply outcome is unknown.'),
  };
}

type ReplyContent = { from: { email: string; name: string }; subject: string; text: string;
  attachments?: { filename: string; type: string; disposition: 'attachment'; content: string }[] };

// The single dispatch point. AXI-10 and AXI-15 can route this through submitOutbound() and the rules engine.
export function sendReply(message: ForwardableEmailMessage, { from, subject, text, attachments }: ReplyContent): Promise<EmailSendResult> {
  return message.reply({
    from, replyTo: from.email, subject, text,
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', 'X-Aura-Demo': 'true' },
    ...(attachments ? { attachments } : {}),
  });
}

function capValue(value: string | undefined, fallback: number): number {
  return value && /^\d+$/.test(value) ? Number(value) : fallback;
}

async function llmCapReached(env: Env, context: Context, sender: string): Promise<string | null> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  // Every attempt counts, whatever its status, because each one cost a provider call.
  const counts = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM email_messages WHERE org_id=? AND direction='out' AND id LIKE 'reply_llm_%' AND envelope_to=? COLLATE NOCASE AND created_at>=?) AS sender_count,
    (SELECT COUNT(*) FROM email_messages WHERE org_id=? AND aura_id=? AND direction='out' AND id LIKE 'reply_llm_%' AND created_at>=?) AS aura_count`)
    .bind(context.org_id,sender,hourAgo,context.org_id,context.aura_id,midnight).first<{ sender_count: number; aura_count: number }>();
  if ((counts?.sender_count ?? 0) >= capValue(env.LLM_SENDER_HOURLY_CAP,10)) return 'sender_hourly_cap';
  if ((counts?.aura_count ?? 0) >= capValue(env.LLM_AURA_DAILY_CAP,200)) return 'aura_daily_cap';
  return null;
}

export async function autoReply(message: ForwardableEmailMessage, env: Env, parsed: Email, context: Context): Promise<void> {
  if (env.TEST_MODE !== 'true' || env.AUTO_REPLY_ENABLED !== 'true') return;
  const address = message.to.trim().toLowerCase();
  const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, message_id: context.message_id, ...fields }));
  const skip = (reason: string) => log('inbox_auto_reply_skipped', { reason });
  if (!ADDRESSES.has(address)) return skip('not_test_address');
  if (!/^[^\s<>@,;\x00-\x1f\x7f]+@[^\s<>@,;\x00-\x1f\x7f]+$/.test(message.from)) return skip('invalid_sender');
  const sender = message.from.toLowerCase();
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
  const useLlm = env.AUTO_REPLY_MODE === 'llm';
  if (useLlm) {
    const reason = await llmCapReached(env,context,sender);
    if (reason) return log('inbox_llm_reply_skipped',{ reason });
  }
  const includeAttachment = !useLlm && (parsed.attachments.length > 0 || /\battachments?\b/i.test(`${subject}\n${parsed.text ?? ''}\n${(parsed.html ?? '').replace(/<[^>]*>/g,' ')}`));
  let text: string | null = useLlm ? null : [
    'Hello! This is the 34Five Aura email demo.',
    `Your email reached ${address} (${active.name}), and this is an automatic test reply.`,
    `We received ${parsed.attachments.length} attachment(s).`,
    includeAttachment ? 'A sample test file is attached. Your uploaded files are not echoed back.' : 'Mention attachment or attachments to receive a sample test file.',
    'Reply to this email to continue testing the same conversation.',
    'This is a fixed demo response, not an AI-generated answer.',
  ].join('\n\n');
  // The reply_llm_ prefix is how the cost caps recognise generated replies without a schema change.
  const id = `${useLlm ? 'reply_llm_' : 'reply_'}${context.message_id}`;
  const parentId = originalId.slice(1,-1);
  const chain = [...new Set([...references,parentId])];
  // This unique key claims the send atomically, including redeliveries with changed MIME bytes.
  const sendKey = `demo-reply:${sender}:${originalId}`;
  const claim = await env.DB.prepare(`INSERT INTO email_messages
    (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,send_idempotency_key,
    envelope_from,envelope_to,from_address,from_name,subject,body_storage,body_text,body_size_bytes,in_reply_to,references_json,activity_at,created_at)
    VALUES (?,?,?,?,?,?,'out','sending',?,?,?,?,?,?,'inline',?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(id,context.org_id,context.aura_id,context.thread_id,context.address_id,context.assignment_id,sendKey,
      address,message.from,address,active.name,replySubject,text,encoder.encode(text ?? '').byteLength,parentId,JSON.stringify(chain),now,now).run();
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
  if (useLlm) {
    let model: ModelRef | null = null;
    try {
      const aura = await env.DB.prepare('SELECT name,llm_id,facet,personality,role,blocklist FROM auras WHERE org_id=? AND id=?')
        .bind(context.org_id,context.aura_id).first<AuraConfig & { llm_id: string | null }>();
      if (!aura) throw new LlmError('E_LLM_CONFIG','The Aura row is missing.');
      model = resolveModel(aura.llm_id,env.DEFAULT_LLM_MODEL);
      const provider = createProvider(model,env);
      const thread = await loadThread(env,context);
      const attachmentCount = parsed.attachments.filter(a => a.disposition !== 'inline').length;
      const reply = await provider.generateReply(buildReplyPrompt(aura,thread,{ attachmentCount }));
      text = finalizeReply(reply.text,{ truncated:reply.truncated });
      if (!text) throw new LlmError('E_LLM_EMPTY','The reply was empty after cleanup.');
      await env.DB.prepare('UPDATE email_messages SET body_text=?,body_size_bytes=? WHERE org_id=? AND aura_id=? AND id=?')
        .bind(text,encoder.encode(text).byteLength,context.org_id,context.aura_id,id).run();
    } catch (error) {
      const secrets = [env.GEMINI_API_KEY ?? '',env.ANTHROPIC_API_KEY ?? ''];
      const code = error instanceof LlmError ? error.code : 'E_LLM_UNKNOWN';
      const detail = safeDetail(error instanceof Error ? error.message : error,secrets);
      const failedAt = new Date().toISOString();
      const fields = { provider:model?.provider ?? null, model:model?.model ?? null, code, class:failureClass(code), message:detail };
      // Nothing has been sent, so this outcome is certain. The claim stays to prevent an automatic retry.
      await env.DB.batch([
        env.DB.prepare("UPDATE email_messages SET status='failed' WHERE org_id=? AND aura_id=? AND id=?").bind(context.org_id,context.aura_id,id),
        env.DB.prepare("UPDATE email_message_recipients SET delivery_status='failed',delivery_status_at=? WHERE org_id=? AND aura_id=? AND message_id=?")
          .bind(failedAt,context.org_id,context.aura_id,id),
        env.DB.prepare(`INSERT INTO email_events (id,org_id,aura_id,message_id,event_type,provider,dedup_key,occurred_at,raw_payload_json)
          VALUES (?,?,?,?,'failed',?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(`${id}_failed`,context.org_id,context.aura_id,id,model?.provider ?? 'llm',`${id}:failed`,failedAt,JSON.stringify({ stage:'generation', retry_safe:false, ...fields })),
      ]).catch(() => undefined);
      log('inbox_llm_reply_failed',{ reply_id:id, ...fields });
      return;
    }
  }
  let result: EmailSendResult;
  try {
    if (!await activeRoute()) {
      await env.DB.prepare("UPDATE email_messages SET status='cancelled' WHERE org_id=? AND aura_id=? AND id=?")
        .bind(context.org_id,context.aura_id,id).run();
      return skip('assignment_changed_before_send');
    }
    result = await sendReply(message,{
      from: { email: address, name: active.name }, subject: replySubject, text: text as string,
      ...(includeAttachment ? { attachments: [{ filename:'aura-demo.txt', type:'text/plain', disposition:'attachment' as const, content:btoa(SAMPLE) }] } : {}),
    });
  } catch (error) {
    const detail = diagnostic(error);
    // A failed native call can have an uncertain outcome. Leave it claimed and never retry automatically.
    await env.DB.prepare(`INSERT INTO email_events (id,org_id,aura_id,message_id,event_type,dedup_key,occurred_at,raw_payload_json)
      VALUES (?,?,?,?,'unknown',?,?,?) ON CONFLICT DO NOTHING`)
      .bind(`${id}_unknown`,context.org_id,context.aura_id,id,`${id}:unknown`,new Date().toISOString(),JSON.stringify({send_status:'unknown',retry_safe:false,...detail}))
      .run().catch(() => undefined);
    log('inbox_auto_reply_error', { reply_id:id, ...detail, retry_safe:false });
    return;
  }
  const sentAt = new Date().toISOString();
  const rfcId = messageIds(result.messageId).at(-1) ?? (result.messageId?.replace(/^<|>$/g,'') || null);
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE email_messages SET status='sent',sent_at=?,provider_message_id=?,rfc_message_id=?,activity_at=? WHERE org_id=? AND aura_id=? AND id=?")
        .bind(sentAt,result.messageId,rfcId,sentAt,context.org_id,context.aura_id,id),
      env.DB.prepare("UPDATE email_message_recipients SET delivery_status='accepted',delivery_status_at=? WHERE org_id=? AND aura_id=? AND message_id=?")
        .bind(sentAt,context.org_id,context.aura_id,id),
      env.DB.prepare('UPDATE email_threads SET last_activity_at=MAX(last_activity_at,?) WHERE org_id=? AND aura_id=? AND id=?')
        .bind(sentAt,context.org_id,context.aura_id,context.thread_id),
    ]);
    log('inbox_auto_reply_sent',{ reply_id:id, provider_message_id:result.messageId });
  } catch {
    log('inbox_auto_reply_tracking_failed',{reply_id:id,provider_message_id:result.messageId,retry_safe:false});
  }
}
