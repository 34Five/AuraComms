import type { Env } from './types.ts';
import { HttpError } from './types.ts';
import { json, pageSize } from './utils.ts';

const REASONS: Record<string,string> = {
  tier_1_every_message:'Every message requires review',
  tier_2_first_outbound:'First outgoing message requires review',
  tier_3_first_inbound_reply:'First reply after incoming mail requires review',
  tier_automatic:'Sending allowed by policy',
  daily_limit:'Daily sending limit reached',
};

// Called only after the inbox session, Aura visibility and message lookup checks.
// Revision is unique within this org/Aura/message; timestamps do not order pages.
export async function reviewHistory(env:Env, aura:string, message:string, url:URL) {
  if (url.searchParams.getAll('limit').length>1 || url.searchParams.getAll('cursor').length>1) {
    throw new HttpError(400,'Use one limit and one cursor.');
  }
  const limit=pageSize(url), cursor=url.searchParams.get('cursor');
  let before:number|null=null;
  if(cursor!==null) {
    const match=/^revision:([1-9]\d{0,15})$/.exec(cursor);
    if(!match || !Number.isSafeInteger(Number(match[1]))) throw new HttpError(400,'Invalid review history cursor.');
    before=Number(match[1]);
  }
  const args:(string|number)[]=[env.DEMO_ORG_ID,aura,message];
  if(before!==null)args.push(before);
  args.push(limit+1);
  const {results}=await env.DB.prepare(`SELECT r.id,r.revision,r.tier_applied,r.status,r.decision_source,
    r.approver_member_id,r.edited_before_send,r.requested_at,r.decided_at,r.sent_at,r.reason,
    a.display_name AS reviewer_display_name
    FROM email_reviews r LEFT JOIN email_workspace_access a ON a.org_id=r.org_id AND a.member_id=r.approver_member_id
    WHERE r.org_id=? AND r.aura_id=? AND r.message_id=? ${before!==null?'AND r.revision<?':''}
    ORDER BY r.revision DESC LIMIT ?`).bind(...args).all<Record<string,any>>();
  const rows=results.slice(0,limit);
  return json({message_id:message,reviews:rows.map(r=>({
    id:r.id,revision:r.revision,tier_applied:r.tier_applied,status:r.status,decision_source:r.decision_source,
    reviewer:r.decision_source==='human' && r.approver_member_id ? {
      member_id:r.approver_member_id,display_name:r.reviewer_display_name?.trim() || null,
    } : null,
    edited_before_send:!!r.edited_before_send,requested_at:r.requested_at,decided_at:r.decided_at,sent_at:r.sent_at,
    reason_label:r.reason ? (Object.hasOwn(REASONS,r.reason) ? REASONS[r.reason] : 'Other recorded reason') : 'Reason not recorded',
  })),nextCursor:results.length>limit ? `revision:${rows.at(-1)!.revision}` : null});
}
