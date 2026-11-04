import { HttpError, type Env } from './types.ts';
import { readBounded } from './utils.ts';

export async function authorizeManagement(request: Request, env: Env): Promise<string> {
  if (!env.GOVERNANCE_ADMIN_TOKEN || !env.GOVERNANCE_REVIEWER_MEMBER_ID) throw new HttpError(503,'Management access is not configured.');
  const token = request.headers.get('authorization')?.replace(/^Bearer /,'') ?? '';
  const digest = async (v: string) => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
  const [a,b] = await Promise.all([digest(token),digest(env.GOVERNANCE_ADMIN_TOKEN)]);
  let mismatch = 0; for (let i=0;i<a.length;i++) mismatch |= a[i]^b[i];
  if (mismatch) throw new HttpError(401,'The management credential is invalid.');
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403,'Management changes require the same origin.');
  const member = await env.DB.prepare('SELECT member_id FROM studio_members WHERE org_id=? AND member_id=?')
    .bind(env.DEMO_ORG_ID,env.GOVERNANCE_REVIEWER_MEMBER_ID).first();
  if (!member) throw new HttpError(403,'The configured manager is no longer a workspace member.');
  return env.GOVERNANCE_REVIEWER_MEMBER_ID;
}
export async function managementBody(request: Request): Promise<Record<string, any>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415,'Send JSON content.');
  if (!request.body) throw new HttpError(400,'JSON content is required.');
  try {
    const data = JSON.parse(new TextDecoder().decode(await readBounded(request.body,16384,'The management request exceeds 16 KiB.')));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400,'Invalid JSON content.'); }
}
