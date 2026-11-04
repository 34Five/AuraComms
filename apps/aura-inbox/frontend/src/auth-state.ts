export type Session = { state: 'signed-in'; email: string } | { state: 'signed-out' } | { state: 'unavailable' };

export function sessionFrom(status: number, body: { email?: unknown } | null): Session {
  if (status === 401) return { state: 'signed-out' };
  if (status === 200 && typeof body?.email === 'string') return { state: 'signed-in', email: body.email };
  return { state: 'unavailable' };
}
