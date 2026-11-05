import { managementBody, tokenHash } from './auth-utils.ts';
import type { ManagementIdentity } from './management-auth.ts';
import { equalHash, passwordHash, randomHex } from './password.ts';
import { DEMO_ROLES } from './demo-roles.ts';
import { HttpError, type Env } from './types.ts';
import { json } from './utils.ts';

const COOKIE='aura_session',SESSION_SECONDS=8*60*60,WINDOW_SECONDS=15*60;
type SessionIdentity=ManagementIdentity & {name:string;email:string};
export function requireSameOrigin(request: Request) {
  if (request.headers.get('origin')!==new URL(request.url).origin) throw new HttpError(403,'Sign-in and changes require the same origin.');
}
function sessionToken(request: Request): string {
  const values=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
  const value=values.length===1?values[0].slice(COOKIE.length+1):'';
  return /^[a-f0-9]{64}$/.test(value)?value:'';
}
function cookie(request: Request,value: string,maxAge: number) {
  const url=new URL(request.url),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol!=='https:' && !local) throw new HttpError(503,'Sign-in requires HTTPS.');
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol==='https:'?'; Secure':''}`;
}
async function ready(env: Env) {
  const row=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('email_workspace_logins','email_workspace_sessions','email_workspace_login_limits')").first<{n:number}>();
  if(row?.n!==3) throw new HttpError(503,'Apply the workspace login migration and provision the demo accounts.');
}
export async function sessionIdentity(request: Request,env: Env): Promise<SessionIdentity> {
  await ready(env);
  const token=sessionToken(request);
  if (!token) throw new HttpError(401,'Sign in to your workspace.');
  const row=await env.DB.prepare(`SELECT a.member_id,a.role,a.display_name AS name,l.login_key AS email FROM email_workspace_sessions s
    JOIN email_workspace_logins l ON l.org_id=s.org_id AND l.member_id=s.member_id
    JOIN email_workspace_access a ON a.org_id=l.org_id AND a.member_id=l.member_id
    JOIN studio_members m ON m.org_id=a.org_id AND m.member_id=a.member_id
    WHERE s.token_hash=? AND s.org_id=? AND s.expires_at>? AND a.status='active'`)
    .bind(await tokenHash(token),env.DEMO_ORG_ID,Math.floor(Date.now()/1000)).first<SessionIdentity>();
  if (!row || !Object.hasOwn(DEMO_ROLES,row.member_id) || DEMO_ROLES[row.member_id]!==row.role) throw new HttpError(401,'Your session expired. Sign in again.');
  if(request.method!=='GET') requireSameOrigin(request);
  return row;
}
export async function authenticationApi(request: Request,env: Env): Promise<Response> {
  if (env.DEMO_LOGIN_ENABLED==='false') throw new HttpError(503,'Workspace login is not enabled.');
  const path=new URL(request.url).pathname.replace(/\/$/,'');
  await ready(env);
  if(path==='/api/auth/session' && request.method==='GET') {
    try {return json({user:await sessionIdentity(request,env),fixed_permissions:true});}
    catch(error) {if(error instanceof HttpError && error.status===401) return json({user:null,fixed_permissions:true});throw error;}
  }
  if (path==='/api/auth/logout' && request.method==='POST') {
    requireSameOrigin(request);
    const token=sessionToken(request);
    if(token) await env.DB.prepare('DELETE FROM email_workspace_sessions WHERE org_id=? AND token_hash=?').bind(env.DEMO_ORG_ID,await tokenHash(token)).run();
    const response=json({status:'signed_out'});response.headers.set('Set-Cookie',cookie(request,'',0));return response;
  }
  if (path==='/api/auth/login' && request.method==='POST') {
    requireSameOrigin(request);
    // Validate transport before creating a session or doing password work.
    cookie(request,'',0);
    const body=await managementBody(request);
    if(typeof body.email!=='string' || body.email.length>254 || !body.email.trim() || typeof body.password!=='string' || !body.password || body.password.length>256) throw new HttpError(400,'Enter your email address and password.');
    const login=body.email.trim().toLowerCase(),now=Math.floor(Date.now()/1000),org=env.DEMO_ORG_ID;
    const scopes=[{key:'login:'+await tokenHash(login),limit:10},{key:'client:'+await tokenHash(request.headers.get('cf-connecting-ip')??'local'),limit:30}];
    await env.DB.batch([
      env.DB.prepare('DELETE FROM email_workspace_login_limits WHERE org_id=? AND expires_at<=?').bind(org,now),
      env.DB.prepare('DELETE FROM email_workspace_sessions WHERE org_id=? AND expires_at<=?').bind(org,now),
    ]);
    for(const scope of scopes) {
      const limit=await env.DB.prepare('SELECT attempts FROM email_workspace_login_limits WHERE org_id=? AND scope_key=? AND expires_at>?').bind(org,scope.key,now).first<{attempts:number}>();
      if(limit && limit.attempts>=scope.limit) {
        const response=json({error:'Too many sign-in attempts. Try again in 15 minutes.'},429);response.headers.set('Retry-After',String(WINDOW_SECONDS));return response;
      }
    }
    await env.DB.batch(scopes.map(s=>env.DB.prepare(`INSERT INTO email_workspace_login_limits (org_id,scope_key,attempts,expires_at) VALUES (?,?,1,?)
      ON CONFLICT(org_id,scope_key) DO UPDATE SET attempts=attempts+1`).bind(org,s.key,now+WINDOW_SECONDS)));
    const row=await env.DB.prepare(`SELECT l.*,a.display_name AS name,a.role,a.status FROM email_workspace_logins l
      JOIN email_workspace_access a ON a.org_id=l.org_id AND a.member_id=l.member_id
      JOIN studio_members m ON m.org_id=a.org_id AND m.member_id=a.member_id WHERE l.org_id=? AND l.login_key=?`).bind(org,login).first<Record<string,any>>();
    // Unknown users still pay the password cost and receive the same public error.
    const candidate=await passwordHash(body.password,row?.password_salt??'00000000000000000000000000000000');
    if(!row || !equalHash(candidate,row.password_hash) || row.status!=='active' || !Object.hasOwn(DEMO_ROLES,row.member_id) || DEMO_ROLES[row.member_id]!==row.role) throw new HttpError(401,'The email address or password is incorrect.');
    const token=randomHex(),oldToken=sessionToken(request);
    const statements=[env.DB.prepare('INSERT INTO email_workspace_sessions (token_hash,org_id,member_id,created_at,expires_at) VALUES (?,?,?,?,?)').bind(await tokenHash(token),org,row.member_id,now,now+SESSION_SECONDS)];
    if(oldToken) statements.push(env.DB.prepare('DELETE FROM email_workspace_sessions WHERE org_id=? AND token_hash=?').bind(org,await tokenHash(oldToken)));
    await env.DB.batch(statements);
    const response=json({user:{member_id:row.member_id,name:row.name,email:row.login_key,role:row.role},fixed_permissions:true});
    response.headers.set('Set-Cookie',cookie(request,token,SESSION_SECONDS));return response;
  }
  throw new HttpError(404,'Authentication endpoint not found.');
}
