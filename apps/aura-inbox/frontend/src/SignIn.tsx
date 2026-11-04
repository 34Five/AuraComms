import { useState, type FormEvent, type ReactNode } from 'react';

async function send<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !data) throw new Error(data?.error || 'The request failed. Please retry.');
  return data;
}

export function SignInFrame({ children }: { children: ReactNode }) {
  return <div className="app">
    <aside className="sidebar"><a href="/" className="brand">34Five<small>Aura inbox</small></a></aside>
    <main className="signin"><div className="signin-card">{children}</div></main>
  </div>;
}

export function SignIn({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [email,setEmail] = useState('');
  const [code,setCode] = useState('');
  const [codeSent,setCodeSent] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');

  // preventDefault matters: the CSP has form-action 'none', so a native submit would be blocked.
  const submit = (work: () => Promise<void>, onError?: () => void) => async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try { await work(); }
    catch (e) { setError((e as Error).message); onError?.(); }
    finally { setBusy(false); }
  };
  const errorLine = error && <p className="signin-error" role="alert">{error}</p>;

  if (!codeSent) return <SignInFrame>
    <h1>Sign in to the Aura inbox</h1>
    <p>Enter the email address you were invited with. We'll send you a sign-in code.</p>
    <form onSubmit={submit(async () => { await send('/api/auth/request',{ email }); setCodeSent(true); })}>
      <label className="signin-field">Email address<input type="email" autoComplete="email" autoFocus required value={email} onChange={e => setEmail(e.target.value)}/></label>
      {errorLine}
      <button className="signin-submit" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
    </form>
  </SignInFrame>;

  return <SignInFrame>
    <h1>Enter your code</h1>
    <p>We sent a 6-digit code to <strong>{email.trim()}</strong>. It expires in 10 minutes.</p>
    <form onSubmit={submit(async () => { onSignedIn((await send<{ email: string }>('/api/auth/verify',{ email,code })).email); },() => setCode(''))}>
      <label className="signin-field">Sign-in code<input inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code} onChange={e => setCode(e.target.value)}/></label>
      {errorLine}
      <button className="signin-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <button className="signin-back" onClick={() => { setCodeSent(false); setCode(''); setError(''); }}>Use a different email</button>
  </SignInFrame>;
}
