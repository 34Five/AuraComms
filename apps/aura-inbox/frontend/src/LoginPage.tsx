import { useState } from 'react';
import type { User } from './auth';
export function LoginPage({onSignedIn,sessionError,onRetry}:{onSignedIn:(user:User)=>void;sessionError:string;onRetry:()=>void}) {
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[showPassword,setShowPassword]=useState(false);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <main className="login-page"><section className="login-story"><a className="brand" href="/">34Five<small>Aura workspace</small></a><div><span className="login-kicker">Your team. Your Auras.</span><h1>A shared workspace.<br/>The right access.</h1><p>Manage Auras, review messages, and keep conversations moving with access built for your role.</p><div className="login-role-list"><span>Admin</span><span>Manager</span><span>Reviewer</span></div></div><p className="login-demo-label">Demo workspace · Fixed role permissions</p></section>
    <section className="login-form-area"><form className="login-form" onSubmit={async e=>{
      e.preventDefault();if(busy||sessionError)return;setBusy(true);setError('');
      try {
        const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
        const result=await response.json() as {user:User;error?:string};if(!response.ok)throw new Error(result.error||'Sign-in failed.');
        setPassword('');onSignedIn(result.user);
      } catch(e){setError((e as Error).message);} finally{setBusy(false);}
    }}><span className="management-eyebrow">Welcome to 34Five</span><h2>Sign in to your workspace</h2><p>Use your demo account to explore its role.</p>
      {(error||sessionError)&&<div className="error-box" role="alert">{error||sessionError}{sessionError&&<button type="button" className="text-button" onClick={onRetry}>Try again</button>}</div>}
      <label htmlFor="login-email">Email address</label><input id="login-email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@345.demo"/>
      <label htmlFor="login-password">Password</label><div className="login-password"><input id="login-password" type={showPassword?'text':'password'} autoComplete="current-password" maxLength={256} required value={password} onChange={e=>setPassword(e.target.value)}/><button type="button" aria-label={showPassword?'Hide password':'Show password'} aria-pressed={showPassword} onClick={()=>setShowPassword(v=>!v)}>{showPassword?'Hide':'Show'}</button></div>
      <button className="primary-button login-submit" disabled={busy||!!sessionError}>{busy?'Signing in…':'Sign in'}</button><p className="login-help">Each demo account has a fixed role. Sign out to switch users.</p>
    </form></section></main>;
}
