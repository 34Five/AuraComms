import { useCallback, useEffect, useRef, useState } from 'react';
import { GovernancePanel, TIER_LABELS } from './GovernancePanel';
type Aura={id:string;name:string;tier:string|null;pending_count:number;message_count:number;thread_count:number;addresses:{address:string;status:string;domain_status:string}[]};
type Detail={aura:{id:string;name:string};policy:{tier:string|null;version:number};can_delete:boolean;addresses:{id:string;address:string;status:string;domain:string;domain_status:string}[];reviewers:{member_id:string;revoked_at:string|null}[]};
type Member={id:string;name:string};
type DnsRecord={type:string;name:string;content:string;priority?:number;status?:string};
type Domain={id:string;domain:string;status:string;provider_managed:boolean;records:DnsRecord[];setup_url:string};
const PAGES=[['/','Inbox'],['/governance','Governance'],['/auras','Aura management'],['/email-settings','Email setup']];

export function ManagementPage({section,token,onToken,navigate}:{section:string;token:string;onToken:(v:string)=>void;navigate:(path:string)=>void}) {
  const [credential,setCredential]=useState(''),[auras,setAuras]=useState<Aura[]>([]),[auraId,setAuraId]=useState(new URLSearchParams(location.search).get('aura')||'');
  const [members,setMembers]=useState<Member[]>([]),[revision,setRevision]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [creating,setCreating]=useState(false),[name,setName]=useState(''),[tier,setTier]=useState('1'),[busy,setBusy]=useState(false);
  const title=PAGES.find(([path])=>path===section)![1];
  const request=useCallback(async(path:string,method='GET',body?:unknown,signal?:AbortSignal)=>{
    const response=await fetch('/api'+path,{method,signal,cache:'no-store',headers:{Authorization:`Bearer ${token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await response.json() as any;if(!response.ok)throw new Error(data.error||'The request failed.');return data;
  },[token]);
  const loadGeneration=useRef(0);
  const reload=()=>{++loadGeneration.current;setRevision(n=>n+1);};
  useEffect(()=>{
    if(!token){setAuras([]);setMembers([]);setLoading(false);return;}
    setLoading(true);
    const controller=new AbortController(),generation=++loadGeneration.current;
    void Promise.all([request('/auras','GET',undefined,controller.signal),request('/manage/workspace','GET',undefined,controller.signal)])
      .then(([a,w])=>{if(controller.signal.aborted||generation!==loadGeneration.current)return;setAuras(a.auras);setMembers(w.members);setAuraId(old=>a.auras.some((v:Aura)=>v.id===old)?old:a.auras[0]?.id||'');setError('');})
      .catch(e=>{if(e.name!=='AbortError'&&generation===loadGeneration.current)setError(e.message);}).finally(()=>{if(!controller.signal.aborted&&generation===loadGeneration.current)setLoading(false);});
    return ()=>controller.abort();
  },[request,revision]);
  function pick(id:string){setAuraId(id);const url=new URL(location.href);url.searchParams.set('aura',id);history.replaceState(null,'',url);setNotice('');}
  return <div className="app management-app">
    <aside className="sidebar management-sidebar"><a className="brand" href="/" onClick={e=>{e.preventDefault();navigate('/');}}>34Five<small>Workspace management</small></a>
      <nav className="workspace-nav" aria-label="Workspace pages">{PAGES.map(([path,label])=><a key={path} href={path} className={path===section?'active':''} aria-current={path===section?'page':undefined} onClick={e=>{e.preventDefault();navigate(path);}}>{label}</a>)}</nav>
      <div className="test-note"><strong>Test workspace</strong>Manage Auras and email policies.</div>
    </aside>
    <main className="main management-main"><header className="management-topbar"><div><span className="management-eyebrow">Workspace</span><h1>{title}</h1><p>{section==='/governance'?'Select an Aura to manage its sending policy and reviews.':section==='/auras'?'Create Auras and manage their email configuration.':'Configure and verify the domain shared by your Auras.'}</p></div>{token&&<button className="secondary-button" onClick={()=>onToken('')}>Lock management</button>}</header>
      <div className="management-content">
        {!token?<form className="governance-card access-card" onSubmit={e=>{e.preventDefault();onToken(credential);setCredential('');}}><span className="status-tag archived">Manager access</span><h2>Manage your workspace</h2><p>Enter your management credential. It stays in memory while you use these pages.</p><label>Management credential<input type="password" required autoComplete="off" value={credential} onChange={e=>setCredential(e.target.value)}/></label><button className="primary-button">Unlock management</button></form>:<>
          {error&&<div role="alert" className="error-box">{error}</div>}{notice&&<p role="status" className="governance-notice">{notice}</p>}
          {section==='/governance'&&<><div className="aura-picker"><label>Choose Aura<select value={auraId} disabled={loading} onChange={e=>pick(e.target.value)}><option value="" disabled>{loading?'Loading Auras…':'Select an Aura'}</option>{auras.map(a=><option key={a.id} value={a.id}>{a.name} · {a.tier?`Tier ${a.tier}`:'No policy'}</option>)}</select></label>{auraId&&<button className="secondary-button" onClick={()=>navigate(`/auras?aura=${auraId}`)}>Aura configuration</button>}</div>
            {auraId?<GovernancePanel key={auraId} auraId={auraId} token={token} onToken={onToken} onChanged={reload} onConversation={id=>navigate(`/?aura=${auraId}&thread=${id}`)}/>:<div className="governance-card">{loading?<p>Loading Auras…</p>:<><h2>No Auras yet</h2><p>Create an Aura to configure governance.</p><button className="primary-button" onClick={()=>navigate('/auras')}>Open Aura management</button></>}</div>}</>}
          {section==='/auras'&&<><div className="directory-heading"><p>{loading?'Loading Auras…':`${auras.length} Auras in this workspace`}</p><button className="primary-button" disabled={loading||busy} onClick={()=>setCreating(v=>!v)}>{creating?'Close form':'Create Aura'}</button></div>
            {creating&&<form className="governance-card" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const result=await request('/manage/auras','POST',{name,tier});setCreating(false);setName('');setTier('1');pick(result.aura.id);setNotice(result.message);reload();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><h2>Create an Aura</h2><label>Aura name<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><label>Initial sending tier<select value={tier} onChange={e=>setTier(e.target.value)}>{Object.entries(TIER_LABELS).map(([id,label])=><option key={id} value={id}>Tier {id} · {label}</option>)}</select></label><p>You become the first designated reviewer. An email address must be provisioned before the new Aura can receive or send mail.</p><button className="primary-button" disabled={busy}>Create Aura</button></form>}
            <div className="aura-directory">{auras.map(a=><button className={`aura-directory-card ${a.id===auraId?'selected':''}`} key={a.id} onClick={()=>pick(a.id)} aria-pressed={a.id===auraId}><div className="directory-card-top"><span className="directory-avatar">{a.name.split(/\s+/).slice(0,2).map(s=>s[0]).join('')}</span><span className="status-tag">{a.tier?`Tier ${a.tier}`:'No policy'}</span></div><h2>{a.name}</h2><p>{a.addresses[0]?.address||'No email address assigned'}</p><small>{a.message_count} messages · {a.pending_count} pending reviews</small></button>)}</div>
            {auraId&&<AuraConfiguration key={auraId} auraId={auraId} members={members} request={request} revision={revision} onChanged={reload} onGovernance={()=>navigate(`/governance?aura=${auraId}`)}/>}</>}
          {section==='/email-settings'&&<EmailSettings request={request}/>}
        </>}
      </div>
    </main>
  </div>;
}

type Requester=(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
function AuraConfiguration({auraId,members,request,revision,onChanged,onGovernance}:{auraId:string;members:Member[];request:Requester;revision:number;onChanged:()=>void;onGovernance:()=>void}){
  const [data,setData]=useState<Detail|null>(null),[name,setName]=useState(''),[reviewer,setReviewer]=useState(''),[confirmName,setConfirmName]=useState(''),[deleting,setDeleting]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{const controller=new AbortController();void request(`/manage/auras/${auraId}`,'GET',undefined,controller.signal).then(d=>{setData(d);setName(d.aura.name);}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[auraId,request,revision]);
  async function change(path:string,method:string,body?:unknown,message='Saved.'){
    setBusy(true);setError('');setNotice('');try{await request(`/manage/auras/${auraId}${path}`,method,body);setNotice(message);onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  if(!data)return <div className="governance-card">{error||'Loading Aura configuration…'}</div>;
  const active=data.reviewers.filter(r=>!r.revoked_at);
  return <section className="aura-configuration" aria-label="Selected Aura configuration"><div className="configuration-title"><div><span className="management-eyebrow">Selected Aura</span><h2>{data.aura.name}</h2></div><button className="secondary-button" onClick={onGovernance}>Manage governance</button></div>
    {error&&<div className="error-box" role="alert">{error}</div>}{notice&&<p className="governance-notice" role="status">{notice}</p>}
    <div className="configuration-grid"><form className="governance-card" onSubmit={e=>{e.preventDefault();void change('','PUT',{name,previous_name:data.aura.name},'Aura name updated.');}}><h3>Aura details</h3><label>Aura name<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><p className="config-id">{data.aura.id}</p><button className="primary-button" disabled={busy||name===data.aura.name}>Save Aura</button></form>
      <article className="governance-card"><h3>Sending configuration</h3><p>{data.policy.tier?`Tier ${data.policy.tier} · ${TIER_LABELS[data.policy.tier]}`:'No sending policy. Outgoing messages are held.'}</p><p>Policy settings, limits and copies are managed on the Governance page.</p><button className="secondary-button" onClick={onGovernance}>Edit sending policy</button></article>
      <article className="governance-card"><h3>Email addresses</h3>{!data.addresses.length&&<p>No address is assigned. Provision an address and its Cloudflare route before sending or receiving email.</p>}{data.addresses.map(a=><div className="configuration-row" key={a.id}><div><strong>{a.address}</strong><p>{a.status} · Domain {a.domain_status}</p></div><button className="secondary-button" disabled={busy} onClick={()=>change(`/addresses/${a.id}`,'PUT',{status:a.status==='active'?'disabled':'active'},'Address updated. Previous unsent decisions must be evaluated again.')}>{a.status==='active'?'Disable address':'Enable address'}</button></div>)}<p>Disabling an address stops incoming routing in this app and prevents outgoing sends. Message history stays available.</p></article>
      <article className="governance-card"><h3>Designated reviewers</h3>{active.map(r=><div className="configuration-row" key={r.member_id}><span>{members.find(m=>m.id===r.member_id)?.name||r.member_id}</span><button className="secondary-button" disabled={busy} onClick={()=>change(`/reviewers/${r.member_id}`,'DELETE',undefined,'Reviewer removed. Unsent approvals by this reviewer were invalidated.')}>Remove reviewer</button></div>)}{!active.length&&<p>No reviewers assigned. Add a reviewer before reviewing messages or changing policy.</p>}
        <form onSubmit={e=>{e.preventDefault();void change(`/reviewers/${reviewer}`,'PUT',{},'Reviewer added.');setReviewer('');}}><label>Add reviewer<select value={reviewer} required onChange={e=>setReviewer(e.target.value)}><option value="">Choose a workspace member</option>{members.filter(m=>!active.some(r=>r.member_id===m.id)).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><button className="secondary-button" disabled={busy||!reviewer}>Add reviewer</button></form></article>
    </div>
    <article className="governance-card danger-card"><h3>Delete Aura</h3><p>{data.can_delete?'This Aura has no email or address history and can be deleted.':'This Aura has email or address history. Remove its sending policy to pause it while preserving its records.'}</p>{data.can_delete&&!deleting&&<button className="danger-button" onClick={()=>setDeleting(true)}>Delete this Aura</button>}{data.can_delete&&deleting&&<form onSubmit={e=>{e.preventDefault();void change('','DELETE',{confirm_name:confirmName},'Aura deleted.');}}><label>Type the Aura name to confirm<input required value={confirmName} onChange={e=>setConfirmName(e.target.value)}/></label><button className="danger-button" disabled={busy||confirmName!==data.aura.name}>Confirm deletion</button></form>}</article>
  </section>;
}

function EmailSettings({request}:{request:Requester}){
  const [domains,setDomains]=useState<Domain[]>([]),[checks,setChecks]=useState<Record<string,any>>({}),[busy,setBusy]=useState(''),[error,setError]=useState(''),[copied,setCopied]=useState('');
  useEffect(()=>{const c=new AbortController();void request('/manage/domains','GET',undefined,c.signal).then(d=>setDomains(d.domains)).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>c.abort();},[request]);
  return <><div className="setup-intro"><span className="status-tag archived">Domain configuration</span><h2>Authenticate your email domain</h2><p>DKIM identifies the sending domain. Every Aura with an address on that domain shares its records. Cloudflare generates and manages the signing keys.</p></div>{error&&<div className="error-box" role="alert">{error}</div>}
    {domains.map(d=>{const check=checks[d.id],records:DnsRecord[]=check?.records||d.records;return <article className="governance-card domain-card" key={d.id}><div className="review-heading"><div><h2>{d.domain}</h2><p>Domain {d.status} · {d.provider_managed?'Cloudflare managed':'Provider configuration required'}</p></div><span className={`status-tag ${check?.dkim_status==='verified'?'': 'archived'}`}>{check?`DKIM ${check.dkim_status.replaceAll('_',' ')}`:'DKIM not checked'}</span></div>
      <div className="setup-steps"><div><strong>1. Get the provider records</strong><p>Open Cloudflare, select this domain, then Email Service → Email Sending → Settings.</p></div><div><strong>2. Configure DNS</strong><p>Add the exact DKIM, SPF and bounce records provided by Cloudflare. Keep existing mail records unless your provider directs a change.</p></div><div><strong>3. Check public DNS</strong><p>After DNS propagates, verify that the published records match the required values.</p></div></div>
      <div className="review-actions"><a className="secondary-button" href={d.setup_url} target="_blank" rel="noreferrer">Open Cloudflare setup</a><button className="primary-button" disabled={!!busy||!records.length} onClick={async()=>{setBusy(d.id);setError('');try{const result=await request(`/manage/domains/${d.id}/verify`,'POST',{});setChecks(old=>({...old,[d.id]:result}));}catch(e){setError((e as Error).message);}finally{setBusy('');}}}>{busy===d.id?'Checking DNS…':'Verify DNS records'}</button></div>
      {!records.length&&<p>Provider records have not been loaded for this domain. Complete provider setup before verification.</p>}
      <div className="dns-records">{records.map((r,i)=><div className="dns-record" key={r.type+r.name+i}><div className="dns-record-heading"><strong>{r.name.includes('._domainkey.')?'DKIM':r.name.startsWith('_dmarc.')?'DMARC':r.type==='MX'?'Bounce routing':'SPF'} <span>{r.type}</span></strong>{r.status&&<span className={`status-tag ${r.status==='verified'?'':'closed'}`}>{r.status.replaceAll('_',' ')}</span>}</div><label>Record name<input readOnly value={r.name}/></label><label>Record value<textarea readOnly rows={r.name.includes('._domainkey.')?4:2} value={r.content}/></label>{r.priority!==undefined&&<p>Priority {r.priority}</p>}<button className="secondary-button" onClick={async()=>{try{await navigator.clipboard.writeText(r.content);setCopied(r.type+r.name+i);}catch{setError('Select and copy the record value.');}}}>{copied===r.type+r.name+i?'Copied':'Copy value'}</button></div>)}</div>
      {check&&<p className="history-note">Checked {new Date(check.checked_at).toLocaleString()}. DNS verification confirms published records. It does not send email or prove delivery.</p>}
    </article>;})}
  </>;
}
