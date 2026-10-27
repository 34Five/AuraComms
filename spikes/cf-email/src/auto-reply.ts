import type { Email } from "postal-mime";
import type { Env } from "./index.ts";
import { messageIds, normalizeMessageId, recordSent, sentKey } from "./threading.ts";

const ADDRESS = "spike-test@34five.studio";
const DEMO_ATTACHMENT = "34Five Aura email demo attachment.\nThis is a sample file for testing only.\n";
const MAX_DEMO_REFERENCES = 20;
type Logger = (event: string, fields: Record<string, unknown>) => void;

export async function autoReply(
  message: ForwardableEmailMessage,
  env: Env,
  parsed: Email,
  receiptId: string,
  log: Logger,
): Promise<void> {
  if (env.AUTO_REPLY_ENABLED !== "true" || env.SEND_ENABLED !== "true") return;
  const values = (name: string) => {
    const found = parsed.headers.filter(header => header.key === name).map(header => header.value);
    return found.length ? found : [message.headers.get(name) ?? ""].filter(Boolean);
  };
  const first = (name: string) => values(name)[0] ?? "";
  const skip = (reason: string) => log("auto_reply_skipped", { receipt_id: receiptId, reason });
  if (message.to.toLowerCase() !== ADDRESS) return skip("not_demo_address");
  if (!/^[^\s<>@,;\x00-\x1f\x7f]+@[^\s<>@,;\x00-\x1f\x7f]+$/.test(message.from)) return skip("invalid_sender");
  if (message.from.toLowerCase() === ADDRESS || /^(?:mailer-daemon|postmaster|no-?reply)@/i.test(message.from)) return skip("automated_sender");
  if (values("auto-submitted").some(value => value.trim().toLowerCase() !== "no")
    || values("precedence").some(value => /\b(?:bulk|list|junk)\b/i.test(value))
    || values("list-id").length || values("x-aura-demo").length
    || values("x-auto-response-suppress").some(value => value.trim().toLowerCase() !== "none")
    || values("content-type").some(value => /multipart\/report|message\/delivery-status/i.test(value))) {
    return skip("automated_message");
  }
  const originalId = first("message-id").trim();
  if (values("message-id").length !== 1 || !/^<[^\s<>@]+@[^\s<>@]+>$/.test(originalId)
    || new TextEncoder().encode(originalId).byteLength > 512) return skip("invalid_message_id");
  const references = messageIds(values("references").join(" "));
  if (references.length >= MAX_DEMO_REFERENCES) return skip("demo_thread_limit");
  const subject = parsed.subject?.trim() || "34Five Aura email demo";
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  if (/[\x00-\x1f\x7f]/.test(replySubject) || new TextEncoder().encode(replySubject).byteLength > 998) return skip("invalid_subject");

  // KV limits repeat replies after redelivery. It is eventually consistent, not an atomic lock.
  const attemptKey = `demo-reply:${await sentKey(normalizeMessageId(originalId))}`;
  try {
    if (await env.SENT.get(attemptKey)) return skip("duplicate_message");
    // Claim before sending. Keep the claim if delivery fails or its outcome is unknown.
    await env.SENT.put(attemptKey, JSON.stringify({ attempted_at: new Date().toISOString() }), { expirationTtl: 7 * 24 * 60 * 60 });
  } catch {
    return skip("deduplication_unavailable");
  }

  const includeAttachment = parsed.attachments.length > 0
    || /\battachments?\b/i.test(`${subject}\n${parsed.text ?? ""}\n${(parsed.html ?? "").replace(/<[^>]*>/g, " ")}`);
  const text = [
    "Hello! This is the 34Five Aura email demo.",
    "Your email reached spike-test@34five.studio, and this is an automatic test reply.",
    `We received ${parsed.attachments.length} attachment(s).`,
    includeAttachment ? "A sample test file is attached. Your uploaded files are not echoed back." : "Mention attachment or attachments to receive a sample test file.",
    "Reply to this email to continue testing the same conversation.",
    "This is a fixed demo response, not an AI-generated answer.",
  ].join("\n\n");
  const attachmentBytes = new TextEncoder().encode(DEMO_ATTACHMENT);
  try {
    // The native reply API enforces DMARC and the original sender, and sets threading headers.
    const result = await message.reply({
      from: { email: ADDRESS, name: "34Five Aura Demo" },
      replyTo: ADDRESS,
      subject: replySubject,
      text,
      html: text.split("\n\n").map(paragraph => `<p>${paragraph}</p>`).join(""),
      headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All", "X-Aura-Demo": "true" },
      ...(includeAttachment ? { attachments: [{
        filename: "aura-demo.txt",
        type: "text/plain",
        disposition: "attachment" as const,
        // Base64 also works in the local Cloudflare simulator.
        content: btoa(DEMO_ATTACHMENT),
      }] } : {}),
    });
    const { trackingStatus } = await recordSent(env.SENT, result.messageId, {
      request_id: receiptId, recipient: message.from, subject: replySubject,
    });
    log("auto_reply", {
      receipt_id: receiptId,
      message_id_raw: result.messageId,
      in_reply_to_raw: originalId,
      send_status: "accepted",
      delivery_status: "unverified",
      tracking_status: trackingStatus,
      attachment_count: includeAttachment ? 1 : 0,
      attachment_size_bytes: includeAttachment ? attachmentBytes.byteLength : 0,
    });
  } catch (error) {
    // Do not throw or retry a send with an uncertain outcome after accepting inbound mail.
    log("auto_reply_error", {
      receipt_id: receiptId,
      code: error && typeof error === "object" && "code" in error ? error.code : "E_REPLY_FAILED",
      send_status: "unknown",
      retry_safe: false,
    });
  }
}
