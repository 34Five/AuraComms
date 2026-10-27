export interface SentMessage {
  request_id: string;
  message_id_raw: string;
  message_id_normalized: string;
  recipient: string;
  subject: string;
  sent_at: string;
}

// Preserve the local part. A different domain is a different ID.
export function normalizeMessageId(value: string): string {
  const id = value.trim().replace(/^<([^<>]+)>$/, "$1");
  const at = id.lastIndexOf("@");
  return at < 0 ? id : id.slice(0, at + 1) + id.slice(at + 1).toLowerCase();
}

export function messageIds(value: string | null): string[] {
  if (!value) return [];
  const bracketed = value.match(/<[^<>\r\n]+>/g);
  const candidates = bracketed ?? value.trim().split(/\s+/);
  return [...new Set(candidates.map(normalizeMessageId).filter(Boolean))];
}

export async function sentKey(id: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeMessageId(id)));
  return "sent:" + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function recordSent(
  store: KVNamespace,
  messageId: string,
  details: Pick<SentMessage, "request_id" | "recipient" | "subject">,
) {
  const record: SentMessage = {
    ...details,
    message_id_raw: messageId,
    message_id_normalized: normalizeMessageId(messageId),
    sent_at: new Date().toISOString(),
  };
  let trackingStatus = "stored";
  try {
    if (!record.message_id_normalized) throw new Error("Missing Message-ID in send result.");
    await store.put(await sentKey(messageId), JSON.stringify(record), { expirationTtl: 7 * 24 * 60 * 60 });
  } catch {
    // The send already happened. A tracking failure must never trigger another send.
    trackingStatus = "failed";
  }
  return { record, trackingStatus };
}

export async function checkThreading(
  store: KVNamespace,
  inReplyTo: string | null,
  references: string[],
) {
  const parents = messageIds(inReplyTo);
  const ids = [...new Set([...parents, ...references.map(normalizeMessageId)])];
  const checked = ids.slice(0, 100);
  const records = new Map<string, SentMessage>();
  // Sequential reads avoid exceeding simultaneous KV request limits.
  for (const id of checked) {
    const record = await store.get<SentMessage>(await sentKey(id), "json");
    if (record) records.set(id, record);
  }
  const parentMatches = parents.filter(id => records.has(id));
  const referenceMatches = [...new Set(references.map(normalizeMessageId))]
    .filter(id => records.has(id));
  return {
    // A KV miss cannot prove a mismatch. Recheck after propagation.
    in_reply_to_match: parentMatches.length > 0 ? true : null,
    in_reply_to_status: parents.length === 0 ? "not_provided" : parentMatches.length > 0 ? "matched" : "pending",
    in_reply_to_matches: parentMatches,
    references_matches: referenceMatches,
    unresolved_ids: ids.filter(id => !records.has(id)),
    lookup_complete: checked.length === ids.length,
    matched_sends: [...records.values()],
  };
}
