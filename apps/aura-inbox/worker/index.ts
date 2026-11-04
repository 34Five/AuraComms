import { api } from './api.ts';
import { authApi, signedInEmail } from './auth.ts';
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
    try {
      // The same trailing-slash rule api() uses, so a path cannot pass the gate as one route and run as another.
      const route = path.replace(/\/$/, '');
      if (route === '/api/health') return await api(request, env);
      if (!env.SESSION_SECRET) return json({ error: 'Sign-in is unavailable right now.' }, 503);
      if (route === '/api/auth' || route.startsWith('/api/auth/')) return await authApi(request, env, route);
      if (!await signedInEmail(request, env)) return json({ error: 'Sign in to continue.' }, 401);
      return await api(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'inbox_api_error', request_id: crypto.randomUUID() }));
      return json({ error: 'The inbox request failed. Please retry.' }, 500);
    }
  },
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await receive(message, env);
  },
} satisfies ExportedHandler<Env>;
