import { Governance, bareAddress, TEST_ADDRESSES } from './governance.ts';
import { HttpError, type Env } from './types.ts';
import { json } from './utils.ts';
import { authorizeManagement, requireRole, managementBody as body } from './management-auth.ts';
type Row = Record<string, any>;
export async function authorize(request: Request, env: Env, aura: string) {
  const identity = await authorizeManagement(request,env);
  await new Governance(env).reviewer(aura,identity.member_id);
  return identity;
}
export async function governanceApi(request: Request, env: Env, aura: string, parts: string[]): Promise<Response | null> {
  const g = new Governance(env), section = parts[3];
  if (section !== 'governance' && request.method === 'GET') return null;
  if (section !== 'governance' && request.method !== 'POST') return null;
  const identity = await authorize(request,env,aura), member=identity.member_id;
  const reviewAction=parts.length===6 && section==='reviews' && ['decide','send'].includes(parts[5]) && request.method==='POST';
  if (request.method!=='GET' && !reviewAction) requireRole(identity,['admin','manager']);
  if (section === 'governance' && parts.length === 4 && request.method === 'GET') {
    const reviews = await g.q(`SELECT r.*,m.thread_id,m.subject,m.status AS message_status,m.body_text,
      (SELECT group_concat(address,', ') FROM email_message_recipients x WHERE x.org_id=m.org_id AND x.aura_id=m.aura_id AND x.message_id=m.id AND x.kind='to') AS to_addresses
      FROM email_reviews r JOIN email_messages m ON m.org_id=r.org_id AND m.aura_id=r.aura_id AND m.id=r.message_id
      WHERE r.org_id=? AND r.aura_id=? ORDER BY r.requested_at DESC,r.id DESC LIMIT 100`,g.org,aura).all();
    const drafts = await g.q(`SELECT m.id,m.thread_id,m.subject,m.status FROM email_messages m WHERE m.org_id=? AND m.aura_id=? AND m.direction='out'
      AND m.status IN ('draft','queued') AND NOT EXISTS (SELECT 1 FROM email_reviews r WHERE r.org_id=m.org_id AND r.aura_id=m.aura_id AND r.message_id=m.id AND r.status IN ('pending','approved','rejected'))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 100`,g.org,aura).all();
    const reviewers = await g.q('SELECT member_id FROM email_aura_reviewers WHERE org_id=? AND aura_id=? AND revoked_at IS NULL',g.org,aura).all();
    const threads = await g.q('SELECT id,subject,review_epoch,tier_state FROM email_threads WHERE org_id=? AND aura_id=? ORDER BY last_activity_at DESC,id DESC LIMIT 100',g.org,aura).all();
    return json({policy:await g.policyConfig(aura),threads:threads.results,reviews:reviews.results,drafts:drafts.results,reviewers:reviewers.results,member_id:member});
  }
  if (section === 'governance' && parts[4] === 'policy' && parts.length === 5 && request.method === 'PUT') return json({policy:await g.updatePolicy(aura,member,await body(request))});
  if (section === 'governance' && parts[4] === 'policy' && parts.length === 5 && request.method === 'DELETE') {
    const data = await body(request);
    return json({policy:await g.removePolicy(aura,member,data.version)});
  }
  if (section === 'governance' && parts[4] === 'compose' && parts.length === 5 && request.method === 'POST') {
    await g.policy(aura);
    const data = await body(request);
    if (!bareAddress(data.to) || typeof data.subject !== 'string' || !data.subject.trim() || data.subject.length > 200 || /[\x00-\x1f\x7f]/.test(data.subject)
      || typeof data.text !== 'string' || !data.text.trim() || new TextEncoder().encode(data.text).byteLength > 12000) throw new HttpError(400,'Enter one valid recipient, a subject, and message text (at most 12 KB).');
    const route = await g.one(`SELECT a.id AS address_id,a.address,x.id AS assignment_id,u.name FROM email_address_assignments x
      JOIN email_addresses a ON a.org_id=x.org_id AND a.id=x.address_id JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id
      JOIN auras u ON u.org_id=x.org_id AND u.id=x.aura_id WHERE x.org_id=? AND x.aura_id=? AND x.ended_at IS NULL AND x.assigned_at<=?
      AND a.status='active' AND d.status='active'
      ORDER BY CASE WHEN a.address_key IN (${TEST_ADDRESSES.map(()=>'?').join(',')}) THEN 0 ELSE 1 END,a.address_key
      LIMIT 1`,g.org,aura,new Date().toISOString(),...TEST_ADDRESSES);
    const id = `out_${crypto.randomUUID()}`, thread = `thread_${crypto.randomUUID()}`, now = new Date().toISOString();
    await env.DB.batch([
      g.q('INSERT INTO email_threads (id,org_id,aura_id,subject,last_activity_at,created_at) VALUES (?,?,?,?,?,?)',thread,g.org,aura,data.subject,now,now),
      g.q(`INSERT INTO email_messages (id,org_id,aura_id,thread_id,email_address_id,address_assignment_id,direction,status,send_idempotency_key,
        from_address,from_name,envelope_from,envelope_to,subject,body_text,body_size_bytes,activity_at,created_at)
        VALUES (?,?,?,?,?,?,'out','draft',?,?,?,?,?,?,?,?,?,?)`,id,g.org,aura,thread,route.address_id,route.assignment_id,id,route.address,route.name,route.address,data.to,data.subject,data.text,new TextEncoder().encode(data.text).byteLength,now,now),
      g.q("INSERT INTO email_message_recipients (id,org_id,aura_id,message_id,kind,ordinal,address,address_key) VALUES (?,?,?,?,'to',0,?,?)",crypto.randomUUID(),g.org,aura,id,data.to,data.to.toLowerCase()),
      g.q('UPDATE email_threads SET first_message_id=? WHERE org_id=? AND aura_id=? AND id=?',id,g.org,aura,thread),
    ]);
    return json({message_id:id,thread_id:thread,review:await g.evaluate(aura,id)},201);
  }
  if (request.method === 'POST' && parts.length === 6) {
    const id = parts[4], action = parts[5];
    if (section === 'reviews' && action === 'decide') return json({review:await g.decide(aura,id,member,(await body(request)).outcome)});
    if (section === 'reviews' && action === 'send') return json(await g.dispatch(aura,id));
    if (section === 'messages' && action === 'cancel') {
      const m = await g.message(aura,id);
      if (!['draft','queued','failed'].includes(m.status)) throw new HttpError(409,'Only unsent drafts can be cancelled. A send in progress must be reconciled.');
      await env.DB.batch([
        g.q("UPDATE email_messages SET status='cancelled' WHERE org_id=? AND aura_id=? AND id=?",g.org,aura,id),
        g.q("UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND message_id=? AND status IN ('pending','approved')",g.org,aura,id),
      ]);
      return json({status:'cancelled'});
    }
    if (section === 'messages' && action === 'edit') {
      const data = await body(request), m = await g.message(aura,id);
      if (!['draft','queued'].includes(m.status) || m.body_storage !== 'inline') throw new HttpError(409,'Only inline unsent drafts can be edited here.');
      if (typeof data.subject !== 'string' || !data.subject.trim() || data.subject.length > 200 || /[\x00-\x1f\x7f]/.test(data.subject)
        || typeof data.text !== 'string' || !data.text.trim() || new TextEncoder().encode(data.text).byteLength > 12000) throw new HttpError(400,'Enter a subject and message text (at most 12 KB).');
      await env.DB.batch([
        g.q('UPDATE email_messages SET subject=?,body_text=?,body_html=NULL,body_size_bytes=? WHERE org_id=? AND aura_id=? AND id=?',data.subject,data.text,new TextEncoder().encode(data.text).byteLength,g.org,aura,id),
        g.q("UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND message_id=? AND status IN ('pending','approved','rejected')",g.org,aura,id),
      ]);
      return json({review:await g.evaluate(aura,id)});
    }
    if (section === 'messages' && action === 'evaluate') return json({review:await g.evaluate(aura,id)});
    if (section === 'threads' && action === 'reset') return json(await g.reset(aura,id,member));
  }
  return null;
}
