import { HttpError, type Env } from './types.ts';
import { sessionIdentity } from './session-auth.ts';
import { tokenHash } from './auth-utils.ts';
export { tokenHash, managementBody } from './auth-utils.ts';

export type WorkspaceRole = 'admin' | 'manager' | 'reviewer';
export type ManagementIdentity = { member_id: string; role: WorkspaceRole };
export const ROLES: WorkspaceRole[] = ['admin','manager','reviewer'];
export function requireRole(identity: ManagementIdentity, roles: WorkspaceRole[]) {
  if (!roles.includes(identity.role)) throw new HttpError(403,'Your role does not permit this action.');
}
export async function authorizeManagement(request: Request, env: Env): Promise<ManagementIdentity> {
  if (env.DEMO_LOGIN_ENABLED!=='false') return sessionIdentity(request,env);
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!token || token.length>512) throw new HttpError(401,'Enter a valid workspace credential.');
  const ready=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('email_workspace_access','email_workspace_credentials','email_workspace_access_events')").first<{n:number}>();
  if (ready?.n!==3) throw new HttpError(503,'Apply the workspace access migration before using management.');
  const hash=await tokenHash(token);
  const bootstrap=!!env.GOVERNANCE_ADMIN_TOKEN && !!env.GOVERNANCE_REVIEWER_MEMBER_ID && hash===await tokenHash(env.GOVERNANCE_ADMIN_TOKEN);
  let member: Record<string,any> | null;
  if (bootstrap) {
    member=await env.DB.prepare(`SELECT m.member_id,a.role,a.status,a.bootstrap_revoked FROM studio_members m
      LEFT JOIN email_workspace_access a ON a.org_id=m.org_id AND a.member_id=m.member_id
      WHERE m.org_id=? AND m.member_id=?`).bind(env.DEMO_ORG_ID,env.GOVERNANCE_REVIEWER_MEMBER_ID).first();
    if (!member) throw new HttpError(403,'The configured administrator is no longer a workspace member.');
    if (member.bootstrap_revoked) throw new HttpError(401,'This administrator credential was revoked.');
    if (member && member.role===null) member.role='admin';
  } else {
    member=await env.DB.prepare(`SELECT a.member_id,a.role,a.status FROM email_workspace_credentials c
      JOIN email_workspace_access a ON a.org_id=c.org_id AND a.member_id=c.member_id
      JOIN studio_members m ON m.org_id=a.org_id AND m.member_id=a.member_id
      WHERE c.org_id=? AND c.token_hash=?`).bind(env.DEMO_ORG_ID,hash).first();
  }
  if (!member && !env.GOVERNANCE_ADMIN_TOKEN && !token.startsWith('aura_')) throw new HttpError(503,'Management access is not configured.');
  if (!member || member.status==='suspended' || !ROLES.includes(member.role)) throw new HttpError(401,'The workspace credential is invalid or access is suspended.');
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403,'Management changes require the same origin.');
  return {member_id:member.member_id,role:member.role};
}
