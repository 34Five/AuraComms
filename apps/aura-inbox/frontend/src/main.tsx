import React, {useCallback,useEffect,useRef,useState} from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ManagementPage } from './ManagementPage.tsx';
import { LoginPage } from './LoginPage.tsx';
import type { User } from './auth';
import './style.css';

function Application() {
  const [url,setUrl]=useState(location.pathname+location.search),[user,setUser]=useState<User|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[logoutBusy,setLogoutBusy]=useState(false);
  const generation=useRef(0);
  const navigate=(path:string)=>{history.pushState(null,'',path);setUrl(path);};
  const loadSession=useCallback(async()=>{
    const current=++generation.current;setLoading(true);setError('');
    try{const response=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});const result=await response.json() as {user:User|null;error?:string};if(!response.ok)throw new Error(result.error||'Could not check your session.');if(current===generation.current)setUser(result.user);}
    catch(e){if(current===generation.current){setUser(null);setError((e as Error).message);}}
    finally{if(current===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{
    const update=()=>setUrl(location.pathname+location.search);
    const expire=()=>{++generation.current;setUser(null);setLoading(false);setError('');};
    window.addEventListener('popstate',update);window.addEventListener('workspace-session-expired',expire);void loadSession();
    return()=>{++generation.current;window.removeEventListener('popstate',update);window.removeEventListener('workspace-session-expired',expire);};
  },[loadSession]);
  async function logout(){
    if(logoutBusy)return;setLogoutBusy(true);setError('');
    try{const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});if(!response.ok)throw new Error('Could not sign out. Please retry.');++generation.current;setUser(null);navigate('/');}
    catch(e){setError((e as Error).message);}finally{setLogoutBusy(false);}
  }
  if(loading)return <main className="login-loading" role="status">Loading your workspace…</main>;
  if(!user)return <LoginPage sessionError={error} onRetry={()=>void loadSession()} onSignedIn={next=>{++generation.current;setUser(next);setError('');if(location.pathname==='/login')navigate('/');}}/>;
  const pathname=url.split('?')[0];
  return <>{error&&<div className="session-error error-box" role="alert">{error}</div>}{['/governance','/auras','/email-settings','/users'].includes(pathname)
    ? <ManagementPage key={pathname+user.member_id} section={pathname} user={user} onLogout={()=>void logout()} logoutBusy={logoutBusy} navigate={navigate}/>
    : <App key={user.member_id} user={user} onLogout={()=>void logout()} logoutBusy={logoutBusy} navigate={navigate}/>}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Application /></React.StrictMode>);
