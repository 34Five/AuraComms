import { HttpError } from './types.ts';

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  } });
}

export function requireId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new HttpError(400, 'Invalid identifier.');
  return value;
}

export function pageSize(url: URL): number {
  const value = url.searchParams.get('limit') ?? '25';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) {
    throw new HttpError(400, 'Limit must be between 1 and 50.');
  }
  return Number(value);
}

export function cursor(value: string | null): [string, string] | null {
  if (!value) return null;
  try {
    if (value.length > 1024) throw new Error();
    const parsed = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed[0]) ||
        !Number.isFinite(Date.parse(parsed[0])) || typeof parsed[1] !== 'string') throw new Error();
    return [parsed[0], requireId(parsed[1])];
  } catch { throw new HttpError(400, 'Invalid pagination cursor.'); }
}

export function encodeCursor(date: string, id: string): string {
  return btoa(JSON.stringify([date, id])).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function messageIds(header: string | null | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map(match => match[1]).slice(-100);
}

export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Email exceeds 25 MiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
