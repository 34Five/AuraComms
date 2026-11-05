import { tokenHash } from './auth-utils.ts';
import { equalHash } from './password.ts';
import { HttpError, type Env } from './types.ts';
import { json, readBounded } from './utils.ts';
export { GovernanceCoordinator } from './coordinator.ts';

function coordinator(env: Env) {
  if (!env.GOVERNANCE) throw new HttpError(503,'Governance coordinator is not configured.');
  return env.GOVERNANCE.get(env.GOVERNANCE.idFromName(env.DEMO_ORG_ID));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/internal/provision-address') {
      const token=request.headers.get('authorization')?.replace(/^Bearer /,'') ?? '';
      if(request.method!=='POST' || !env.ADDRESS_PROVISIONING_SECRET || token.length>256 || !await equalHash(await tokenHash(token),await tokenHash(env.ADDRESS_PROVISIONING_SECRET))) return new Response('Not found',{status:404});
      return coordinator(env).fetch(request);
    }
    if (path !== '/api' && !path.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      const secured = new Response(response.body, response);
      secured.headers.set('Referrer-Policy', 'no-referrer');
      secured.headers.set('X-Content-Type-Options', 'nosniff');
      return secured;
    }
    try { return await coordinator(env).fetch(request); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'inbox_api_error', request_id: crypto.randomUUID() }));
      return json({ error: 'The inbox request failed. Please retry.' }, 500);
    }
  },
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (message.rawSize > 25 * 1024 * 1024) { message.setReject('Email exceeds 25 MiB.'); return; }
    let raw: Uint8Array;
    try { raw = await readBounded(message.raw,25 * 1024 * 1024); }
    catch (error) { if (error instanceof HttpError) { message.setReject(error.message); return; } throw error; }
    // Trust only the first result prepended by Cloudflare, never MIME-supplied results.
    const authentication = (message.headers.get('authentication-results') ?? '').split(',')[0];
    const dmarcPass = /^\s*mx\.cloudflare\.net\s*;/i.test(authentication) && /;\s*dmarc=pass(?:[\s;]|$)/i.test(authentication);
    const response = await coordinator(env).fetch(new Request('https://governance/internal/ingest',{
      method:'POST',headers:{'x-envelope-from':message.from,'x-envelope-to':message.to,'x-dmarc-pass':String(dmarcPass)},body:new Uint8Array(raw).buffer,
    }));
    if (!response.ok) throw new Error('Incoming mail processing failed.');
    const result = await response.json<{rejection: string | null}>();
    if (result.rejection) message.setReject(result.rejection);
  },
} satisfies ExportedHandler<Env>;
