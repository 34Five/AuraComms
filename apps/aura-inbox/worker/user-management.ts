import { Governance } from './governance.ts';
import { managementBody, requireRole, ROLES, tokenHash, type ManagementIdentity } from './management-auth.ts';
import { HttpError, type Env } from './types.ts';
import { json, requireId } from './utils.ts';

type Row = Record<string,any>;
export async function workspaceUsers(env: Env): Promise<Row[]> {
  const rows=await env.DB.prepare(`SELECT m.member_id AS id,a.display_name,a.email,a.role,a.status,a.version,a.updated_at
    FROM studio_members m LEFT JOIN email_workspace_access a ON a.org_id=m.org_id AND a.member_id=m.member_id
    WHERE m.org_id=? ORDER BY coalesce(a.display_name,m.member_id),m.member_id`).bind(env.DEMO_ORG_ID).all<Row>();
  return rows.results.map(row=>({...row,name:row.display_name ?? row.id,
    role:row.role ?? (env.GOVERNANCE_ADMIN_TOKEN && row.id===env.GOVERNANCE_REVIEWER_MEMBER_ID?'admin':null),
    status:row.status ?? (env.GOVERNANCE_ADMIN_TOKEN && row.id===env.GOVERNANCE_REVIEWER_MEMBER_ID?'active':'unconfigured'),version:row.version ?? 0}));
}
function fields(data: Row) {
  if (typeof data.name!=='string' || !data.name.trim() || data.name.trim().length>100 || /[\x00-\x1f\x7f]/.test(data.name)) throw new HttpError(400,'Enter a name from 1 to 100 characters.');
  const email=typeof data.email==='string'?data.email.trim().toLowerCase():null;
  if ((data.email!==null && data.email!==undefined && typeof data.email!=='string') || (email && (email.length>254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)))) throw new HttpError(400,'Enter a valid email address.');
  if (!ROLES.includes(data.role)) throw new HttpError(400,'Choose Admin, Manager, or Reviewer.');
  return {name:data.name.trim(),email:email || null,role:data.role};
}
function credential() {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return 'aura_'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export async function userManagement(request: Request,env: Env,actor: ManagementIdentity,parts: string[]): Promise<Response> {
  requireRole(actor,['admin']);
  if(env.DEMO_LOGIN_ENABLED!=='false' && request.method!=='GET') throw new HttpError(403,'Demo accounts have fixed roles and permissions. User changes are disabled.');
  const g=new Governance(env), users=await workspaceUsers(env), id=parts[3]?requireId(parts[3]):null;
  const audit=(target:string,action:string,details:Row)=>g.q(`INSERT INTO email_workspace_access_events
    (id,org_id,actor_member_id,target_member_id,action,details_json) VALUES (?,?,?,?,?,?)`,crypto.randomUUID(),g.org,actor.member_id,target,action,JSON.stringify(details));
  if (parts.length===3 && request.method==='GET') {
    const events=await g.q(`SELECT id,actor_member_id,target_member_id,action,details_json,created_at FROM email_workspace_access_events
      WHERE org_id=? ORDER BY created_at DESC,id DESC LIMIT 50`,g.org).all();
    return json({users,member_id:actor.member_id,events:events.results});
  }
  if (parts.length===3 && request.method==='POST') {
    const f=fields(await managementBody(request)), member='member_'+crypto.randomUUID(),token=credential();
    if (f.email && users.some(u=>u.email===f.email)) throw new HttpError(409,'This email address already has workspace access.');
    await env.DB.batch([
      g.q('INSERT INTO studio_members (org_id,member_id,role) VALUES (?,?,?)',g.org,member,'member'),
      g.q('INSERT INTO email_workspace_access (org_id,member_id,display_name,email,role) VALUES (?,?,?,?,?)',g.org,member,f.name,f.email,f.role),
      g.q('INSERT INTO email_workspace_credentials (token_hash,org_id,member_id) VALUES (?,?,?)',await tokenHash(token),g.org,member),
      audit(member,'created',{name:f.name,email:f.email,role:f.role,status:'active'}),
    ]);
    return json({member_id:member,credential:token,message:'User added. Copy the credential now. It will not be shown again.'},201);
  }
  const current=users.find(u=>u.id===id);
  if (!id || !current) throw new HttpError(404,'Workspace user not found.');
  if (parts.length===4 && request.method==='PUT') {
    const data=await managementBody(request),f=fields(data);
    if (!Number.isSafeInteger(data.version) || data.version!==current.version) throw new HttpError(409,'This user changed. Reload before saving.');
    if (!['active','suspended'].includes(data.status)) throw new HttpError(400,'Choose active or suspended.');
    if (id===actor.member_id && (f.role!==current.role || data.status!=='active')) throw new HttpError(409,'Another administrator must change your role or suspend your access.');
    if (current.role==='admin' && current.status==='active' && (f.role!=='admin' || data.status!=='active') && users.filter(u=>u.role==='admin' && u.status==='active').length<=1) throw new HttpError(409,'Keep at least one active administrator.');
    if (f.email && users.some(u=>u.id!==id && u.email===f.email)) throw new HttpError(409,'This email address already has workspace access.');
    const revoke=data.status==='suspended' || f.role!==current.role;
    const statements=[g.q(`INSERT INTO email_workspace_access (org_id,member_id,display_name,email,role,status,bootstrap_revoked)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id,member_id) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,
      role=excluded.role,status=excluded.status,bootstrap_revoked=max(email_workspace_access.bootstrap_revoked,excluded.bootstrap_revoked),
      version=email_workspace_access.version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,g.org,id,f.name,f.email,f.role,data.status,data.status==='suspended'?1:0)];
    if (data.status==='suspended') statements.push(g.q('DELETE FROM email_workspace_credentials WHERE org_id=? AND member_id=?',g.org,id));
    if (revoke) statements.push(g.q(`UPDATE email_reviews SET status='superseded' WHERE org_id=? AND approver_member_id=? AND status='approved'
      AND message_id IN (SELECT id FROM email_messages WHERE org_id=? AND status IN ('draft','queued'))`,g.org,id,g.org));
    statements.push(audit(id,'updated',{previous:{name:current.name,email:current.email,role:current.role,status:current.status},next:{...f,status:data.status}}));
    await env.DB.batch(statements);
    return json({message:data.status==='suspended'?'User suspended. Credentials were revoked and unsent approvals were invalidated.':current.status!=='active'?'User saved. Issue a new credential to enable sign-in.':'User saved.'});
  }
  if (parts.length===5 && parts[4]==='credential' && request.method==='POST') {
    const data=await managementBody(request);
    if (id===actor.member_id) throw new HttpError(409,'Ask another administrator to reset your credential.');
    if (data.version!==current.version) throw new HttpError(409,'This user changed. Reload before resetting the credential.');
    if (current.status!=='active' || current.version===0) throw new HttpError(409,'Save active workspace access before issuing a credential.');
    const token=credential();
    await env.DB.batch([
      g.q('DELETE FROM email_workspace_credentials WHERE org_id=? AND member_id=?',g.org,id),
      g.q('INSERT INTO email_workspace_credentials (token_hash,org_id,member_id) VALUES (?,?,?)',await tokenHash(token),g.org,id),
      g.q("UPDATE email_workspace_access SET bootstrap_revoked=1,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id=? AND member_id=?",g.org,id),
      audit(id,'credential_reset',{}),
    ]);
    return json({credential:token,message:'Credential reset. The previous credential no longer works. Copy this credential now.'});
  }
  throw new HttpError(404,'User management endpoint not found.');
}
