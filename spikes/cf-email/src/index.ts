import PostalMime from "postal-mime";
import { checkThreading, messageIds, normalizeMessageId, sentKey } from "./threading.ts";
import type { SentMessage } from "./threading.ts";

export interface Env {
  EMAIL: SendEmail;
  SENT: KVNamespace;
  SPIKE_SEND_TOKEN?: string;
  SEND_ENABLED?: string;
  SPIKE_ALLOWED_RECIPIENTS?: string;
}

const SENDER = "spike-test@34five.studio";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
const SENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

async function authorized(request: Request, token: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization") ?? "";
  const hashes = await Promise.all([supplied, `Bearer ${token}`].map(value =>
    crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const a = new Uint8Array(hashes[0]);
  const b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new InputError("Body exceeds the size limit.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new InputError("Use Content-Type: application/json.", 415);
  }
  if (!request.body) throw new InputError("A JSON object is required.");
  let body: unknown;
  const bytes = await readBounded(request.body, MAX_REQUEST_BYTES);
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InputError("The request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InputError("A JSON object is required.");
  }
  return body as Record<string, unknown>;
}

function headerValue(value: unknown, field: string, max = 998): string {
  if (typeof value !== "string" || !value.trim() || encoder.encode(value).byteLength > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InputError(`Invalid ${field}.`);
  }
  return value.trim();
}

function wireMessageId(value: unknown): string {
  const id = headerValue(value, "Message-ID", 512).replace(/^<([^<>]+)>$/, "$1");
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(id)) throw new InputError("Message-IDs must contain a local part and domain.");
  return `<${id}>`;
}

function threadingInput(body: Record<string, unknown>, appendParent = false) {
  const parent = body.inReplyTo === undefined ? null : wireMessageId(body.inReplyTo);
  if (body.references !== undefined && (!Array.isArray(body.references) || body.references.length > 100)) {
    throw new InputError("references must be an array of at most 100 Message-IDs.");
  }
  const references = [...new Set(((body.references ?? []) as unknown[]).map(wireMessageId))];
  if (appendParent && parent && !references.some(id => normalizeMessageId(id) === normalizeMessageId(parent))) references.push(parent);
  if (references.length > 100 || encoder.encode(references.join(" ")).byteLength > 12 * 1024) {
    throw new InputError("The reference chain is too large.");
  }
  return { parent, references };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "E_SEND_FAILED";
}

async function send(body: Record<string, unknown>, env: Env, requestId: string): Promise<Response> {
  if (env.SEND_ENABLED !== "true") return json({ error: "Sending is disabled." }, 403);
  const allowed = (env.SPIKE_ALLOWED_RECIPIENTS ?? "").split(",").map(address => address.trim()).filter(Boolean);
  if (allowed.length === 0) return json({ error: "No test recipients are configured." }, 503);
  const to = headerValue(body.to, "to", 254);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(to)) throw new InputError("Use one plain recipient address.");
  if (!allowed.includes(to)) return json({ error: "Recipient is not allowed." }, 403);
  const subject = body.subject === undefined ? "AXI-4 Cloudflare email spike" : headerValue(body.subject, "subject");
  const { parent, references } = threadingInput(body, true);
  const headers: Record<string, string> = {};
  if (parent) headers["In-Reply-To"] = parent;
  if (references.length) headers.References = references.join(" ");
  let result: EmailSendResult;
  try {
    result = await env.EMAIL.send({
      from: { email: SENDER, name: "Aura Spike" },
      to,
      replyTo: SENDER,
      subject,
      text: "AXI-4 Cloudflare email spike. This is the plain text part.",
      html: "<p>AXI-4 Cloudflare email spike. This is the <strong>HTML</strong> part.</p>",
      attachments: [{
        filename: "spike.txt",
        type: "text/plain",
        disposition: "attachment",
        content: encoder.encode("AXI-4 attachment fixture\n"),
      }],
      headers,
    });
  } catch (error) {
    const code = errorCode(error);
    log("outbound_error", { request_id: requestId, recipient: to, code, send_status: "unknown" });
    // Never retry automatically. A failed call can have an uncertain delivery outcome.
    return json({ request_id: requestId, code, send_status: "unknown", retry_safe: false }, 502);
  }
  const record: SentMessage = {
    request_id: requestId,
    message_id_raw: result.messageId,
    message_id_normalized: normalizeMessageId(result.messageId),
    recipient: to,
    subject,
    sent_at: new Date().toISOString(),
  };
  let trackingStatus = "stored";
  try {
    if (!record.message_id_normalized) throw new Error("Missing Message-ID in send result.");
    await env.SENT.put(await sentKey(result.messageId), JSON.stringify(record), { expirationTtl: SENT_TTL_SECONDS });
  } catch {
    trackingStatus = "failed";
  }
  const response = {
    ...result,
    request_id: requestId,
    send_status: "accepted",
    delivery_status: "unverified",
    tracking_status: trackingStatus,
    message_id_normalized: record.message_id_normalized,
    retry_safe: false,
  };
  log("outbound", { ...record, ...response, in_reply_to_raw: parent, references_raw: headers.References ?? null });
  return json(response, 202);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/send" && path !== "/thread-check") return json({ error: "Not found." }, 404);
    if (!env.SPIKE_SEND_TOKEN || env.SPIKE_SEND_TOKEN.length < 32) return json({ error: "Configure a token of at least 32 characters." }, 503);
    if (!await authorized(request, env.SPIKE_SEND_TOKEN)) return json({ error: "Unauthorized." }, 401);
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const requestId = crypto.randomUUID();
    try {
      const body = await bodyObject(request);
      const allowedFields = path === "/send" ? ["to", "subject", "inReplyTo", "references"] : ["inReplyTo", "references"];
      if (Object.keys(body).some(key => !allowedFields.includes(key))) throw new InputError("Unknown request field.");
      if (path === "/send") return await send(body, env, requestId);
      const { parent, references } = threadingInput(body);
      const result = await checkThreading(env.SENT, parent, references);
      log("thread_check", { request_id: requestId, ...result });
      return json({ request_id: requestId, ...result });
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      log("request_error", { request_id: requestId, path });
      return json({ request_id: requestId, error: "The request failed. Check Worker logs." }, 500);
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const receiptId = crypto.randomUUID();
    try {
      if (message.rawSize > MAX_INBOUND_BYTES) throw new Error("Inbound size exceeds 25 MiB.");
      const raw = await readBounded(message.raw, MAX_INBOUND_BYTES);
      const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
      const values = (name: string) => parsed.headers.filter(header => header.key === name).map(header => header.value);
      const first = (name: string) => values(name)[0] ?? message.headers.get(name);
      const parent = first("in-reply-to");
      const referencesRaw = values("references").join(" ") || message.headers.get("references");
      const references = messageIds(referencesRaw);
      let threading: Record<string, unknown>;
      try {
        threading = await checkThreading(env.SENT, parent, references);
      } catch {
        threading = { in_reply_to_match: null, in_reply_to_status: "unavailable", lookup_complete: false };
      }
      log("inbound", {
        receipt_id: receiptId,
        envelope_from: message.from,
        envelope_to: message.to,
        header_from: first("from"),
        header_to: first("to"),
        subject: parsed.subject ?? null,
        message_id_raw: first("message-id"),
        message_id_normalized: first("message-id") ? normalizeMessageId(first("message-id")!) : null,
        in_reply_to_raw: parent,
        references_raw: referencesRaw,
        references,
        thread_index: first("thread-index"),
        thread_topic: first("thread-topic"),
        authentication_results: values("authentication-results"),
        raw_size_bytes: raw.byteLength,
        attachment_count: parsed.attachments.length,
        attachments: parsed.attachments.map(attachment => ({
          filename: attachment.filename,
          mime_type: attachment.mimeType,
          disposition: attachment.disposition,
          size_bytes: typeof attachment.content === "string" ? encoder.encode(attachment.content).byteLength : attachment.content.byteLength,
        })),
        ...threading,
      });
    } catch (error) {
      log("inbound_error", { receipt_id: receiptId, raw_size_bytes: message.rawSize });
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
