import { retryProvisioning } from './address.ts';
import { managementBody } from './auth-utils.ts';
import { requireId } from './utils.ts';
import { api } from './api.ts';
import { receive } from './inbound.ts';
import { HttpError, type Env } from './types.ts';
import { json } from './utils.ts';

export class GovernanceCoordinator {
  ctx: DurableObjectState;
  env: Env;
  constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (new URL(request.url).pathname === '/internal/provision-address') {
          const data=await managementBody(request);
          return await retryProvisioning(this.env,requireId(data.aura_id));
        }
        if (new URL(request.url).pathname === '/internal/ingest') {
          const raw = new Uint8Array(await request.arrayBuffer());
          let rejection: string | null = null;
          await receive({
            from:request.headers.get('x-envelope-from') ?? '',to:request.headers.get('x-envelope-to') ?? '',
            headers:new Headers({'x-aura-dmarc-pass':request.headers.get('x-dmarc-pass') ?? 'false'}),rawSize:raw.byteLength,raw:new Response(raw).body!,
            setReject(reason: string) { rejection = reason; },
          } as ForwardableEmailMessage,this.env);
          return json({rejection});
        }
        return await api(request,this.env);
      } catch (error) {
        if (error instanceof HttpError) return json({error:error.message},error.status);
        console.error(JSON.stringify({event:'governance_request_failed',request_id:crypto.randomUUID()}));
        return json({error:'The request failed. Refresh before trying again.'},500);
      }
    });
  }
}
