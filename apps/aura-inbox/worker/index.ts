import { api } from './api.ts';
import { receive } from './inbound.ts';
import { HttpError, type Env } from './types.ts';
import { json } from './utils.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/api' && !path.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      const secured = new Response(response.body, response);
      secured.headers.set('Referrer-Policy', 'no-referrer');
      secured.headers.set('X-Content-Type-Options', 'nosniff');
      return secured;
    }
    try { return await api(request, env); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'inbox_api_error', request_id: crypto.randomUUID() }));
      return json({ error: 'The inbox request failed. Please retry.' }, 500);
    }
  },
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await receive(message, env);
  },
} satisfies ExportedHandler<Env>;
