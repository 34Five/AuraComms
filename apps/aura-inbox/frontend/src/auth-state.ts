export type Session = { state: 'signed-in'; email: string } | { state: 'signed-out' } | { state: 'unavailable' };

// status is null when the request never got a response. Only a 503 means sign-in itself is down.
export function sessionFrom(status: number | null, body: { email?: unknown } | null): Session {
  if (status === 503) return { state: 'unavailable' };
  if (status === 200 && typeof body?.email === 'string') return { state: 'signed-in', email: body.email };
  return { state: 'signed-out' };
}

// A 429 refuses a new code, but one already sent can still work, so the code step must stay reachable.
export function opensCodeStepOnFailure(status: number | null): boolean {
  return status === 429;
}
