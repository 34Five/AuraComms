import { HttpError } from './types.ts';
import { readBounded } from './utils.ts';

export async function tokenHash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
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
