import React, {useEffect,useState} from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './style.css';
import { ManagementPage } from './ManagementPage.tsx';

function Application() {
  const [url,setUrl]=useState(location.pathname+location.search),[token,setToken]=useState('');
  useEffect(()=>{const update=()=>setUrl(location.pathname+location.search);window.addEventListener('popstate',update);return ()=>window.removeEventListener('popstate',update);},[]);
  const navigate=(path:string)=>{history.pushState(null,'',path);setUrl(path);};
  const pathname=url.split('?')[0];
  return ['/governance','/auras','/email-settings'].includes(pathname)
    ? <ManagementPage key={pathname} section={pathname} token={token} onToken={setToken} navigate={navigate}/>
    : <App navigate={navigate}/>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Application /></React.StrictMode>);
