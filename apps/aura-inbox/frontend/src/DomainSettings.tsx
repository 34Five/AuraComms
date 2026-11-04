import { useEffect, useState } from 'react';

type DnsRecord={type:string;name:string;content:string;priority?:number;status?:string};
type Domain={id:string;domain:string;kind:'default_subdomain'|'custom';status:string;failure_reason:string|null;
  nameservers:string[];records:DnsRecord[];setup_url:string;can_remove:boolean;active_addresses:{address:string;aura_name:string|null}[]};
type Requester=(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
const statusText:Record<string,string>={pending:'Waiting for setup',verifying:'Verifying email',active:'Active',failed:'Setup failed',disabled:'Removed'};

export function DomainSettings({request}:{request:Requester}){
  const [domains,setDomains]=useState<Domain[]>([]),[checks,setChecks]=useState<Record<string,any>>({});
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [domain,setDomain]=useState(''),[copied,setCopied]=useState(''),[removing,setRemoving]=useState('');
  useEffect(()=>{
    const c=new AbortController();setLoading(true);setDomains([]);setChecks({});setError('');setNotice('');
    void request('/manage/domains','GET',undefined,c.signal).then(d=>setDomains(d.domains)).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});
    return()=>c.abort();
  },[request]);
  async function change(key:string,path:string,method='POST',body:unknown={},message='Domain updated.'){
    setBusy(key);setError('');setNotice('');
    try{
      const result=await request('/manage/domains'+path,method,body),updated:Domain=result.domain;
      setDomains(old=>[...old.filter(d=>d.id!==updated.id),updated].sort((a,b)=>Number(b.kind==='default_subdomain')-Number(a.kind==='default_subdomain')||a.domain.localeCompare(b.domain)));
      setChecks(old=>{const next={...old};delete next[updated.id];return next;});
      setNotice(updated.status==='failed'?'Domain saved. Resolve the setup error, then select Check now.':message);
      if(key==='add')setDomain('');setRemoving('');
    }catch(e){setError((e as Error).message);}finally{setBusy('');}
  }
  async function copy(value:string,key:string){try{await navigator.clipboard.writeText(value);setCopied(key);}catch{setError('Select and copy the value from the field.');}}
  return <>
    <div className="setup-intro"><span className="status-tag archived">Company preferences</span><h2>Email domains for your Auras</h2><p>Your company subdomain provides a default email domain. Add your own domain to use addresses such as anthony@acme.com. All Auras on a domain share its email authentication.</p></div>
    {error&&<div className="error-box" role="alert">{error}</div>}{notice&&<p className="governance-notice" role="status">{notice}</p>}
    {loading?<p role="status">Loading company domains…</p>:<>
      {!domains.some(d=>d.kind==='default_subdomain')&&<article className="governance-card"><h3>Company subdomain</h3><p>Create the default subdomain from your company name. Email becomes available after Cloudflare onboarding completes.</p><button className="secondary-button" disabled={!!busy} onClick={()=>void change('default','/default','POST',{},'Company subdomain created.')}>{busy==='default'?'Setting up…':'Set up company subdomain'}</button></article>}
      <form className="governance-card domain-add-form" onSubmit={e=>{e.preventDefault();void change('add','','POST',{domain},'Domain added. Follow the nameserver instructions below.');}}><h3>Add a custom domain</h3><label>Domain name<input required autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={190} placeholder="acme.com" value={domain} onChange={e=>setDomain(e.target.value)}/></label><p>This moves the domain’s DNS to 34Five’s Cloudflare. Ask your IT team to preserve existing website and mail records before changing nameservers.</p><button className="primary-button" disabled={!!busy||!domain.trim()}>{busy==='add'?'Adding domain…':'Add custom domain'}</button></form>
      {domains.map(d=>{const check=checks[d.id],records:DnsRecord[]=check?.records||d.records,disabled=d.status==='disabled';return <article className="governance-card domain-card" key={d.id}>
        <div className="review-heading"><div><span className="management-eyebrow">{d.kind==='default_subdomain'?'Company subdomain':'Custom domain'}</span><h2>{d.domain}</h2></div><span className={`status-tag ${d.status==='active'?'':d.status==='failed'?'closed':'archived'}`}>{statusText[d.status]||d.status}</span></div>
        {d.failure_reason&&<p className={d.status==='failed'?'error-box':'history-note'} role={d.status==='failed'?'alert':undefined}>{d.failure_reason}</p>}
        {!!d.nameservers.length&&!disabled&&<section className="delegation-instructions" aria-label={`Nameservers for ${d.domain}`}><h3>Set nameservers at your domain registrar</h3><p>This delegates DNS for {d.domain} to 34Five’s Cloudflare. Copy both nameservers into your registrar’s nameserver settings. Changes can take up to 24 hours.</p>{d.nameservers.map((ns,i)=><div className="nameserver-row" key={ns}><label>Nameserver {i+1}<input readOnly value={ns}/></label><button className="secondary-button" disabled={!!busy} onClick={()=>void copy(ns,ns)}>{copied===ns?'Copied':'Copy nameserver'}</button></div>)}</section>}
        {d.status==='active'&&<div className="domain-auth-summary" aria-label="Email authentication"><span>DKIM · Configured by 34Five</span><span>SPF · Configured by 34Five</span><span>DMARC · Configured by 34Five</span></div>}
        {!disabled&&<div className="review-actions"><button className="primary-button" disabled={!!busy} onClick={()=>void change(d.id,`/${d.id}/check`,'POST',{},'Domain status checked.')}>{busy===d.id?'Checking…':'Check now'}</button><a className="secondary-button" href={d.setup_url} target="_blank" rel="noreferrer">Open Cloudflare setup</a>
          {!!records.length&&<button className="secondary-button" disabled={!!busy} onClick={async()=>{setBusy('dns-'+d.id);setError('');try{const result=await request(`/manage/domains/${d.id}/verify`,'POST',{});setChecks(old=>({...old,[d.id]:result}));}catch(e){setError((e as Error).message);}finally{setBusy('');}}}>{busy==='dns-'+d.id?'Checking DNS…':'Verify DNS records'}</button>}</div>}
        {!records.length&&!disabled&&<p>{d.status==='active'?'Authentication records have not been loaded. Select Check now to refresh provider details.':'Email authentication records appear after delegation and Cloudflare Email Sending onboarding. Select Check now after setup.'}</p>}
        {!!records.length&&<details className="domain-dns-details"><summary>DNS records ({records.length}){check?` · DKIM ${check.dkim_status.replaceAll('_',' ')}`:''}</summary><div className="dns-records">{records.map((r,i)=><div className="dns-record" key={r.type+r.name+i}><div className="dns-record-heading"><strong>{r.name.includes('._domainkey.')?'DKIM':r.name.startsWith('_dmarc.')?'DMARC':r.type==='MX'?'Mail routing':'SPF / email'} <span>{r.type}</span></strong>{r.status&&<span className={`status-tag ${r.status==='verified'?'':'closed'}`}>{r.status.replaceAll('_',' ')}</span>}</div><label>Record name<input readOnly value={r.name}/></label><label>Record value<textarea readOnly rows={r.name.includes('._domainkey.')?4:2} value={r.content}/></label>{r.priority!==undefined&&<p>Priority {r.priority}</p>}<button className="secondary-button" onClick={()=>void copy(r.content,r.type+r.name+i)}>{copied===r.type+r.name+i?'Copied':'Copy value'}</button></div>)}</div></details>}
        {check&&<p className="history-note">Checked {new Date(check.checked_at).toLocaleString()}. DNS verification does not send email or prove delivery.</p>}
        {!!d.active_addresses.length&&<p>Active addresses: {d.active_addresses.map(a=>`${a.address}${a.aura_name?` (${a.aura_name})`:''}`).join(', ')}.</p>}
        {d.kind==='custom'&&!disabled&&<div className="domain-remove"><p>{d.can_remove?'Removing a domain stops its use in this workspace. DNS and mail history stay in place.':'Disable all active addresses before removing this domain.'}</p>{d.can_remove&&(removing===d.id?<div className="review-actions"><button className="danger-button" disabled={!!busy} onClick={()=>void change('remove-'+d.id,`/${d.id}`,'DELETE',undefined,'Domain removed. Mail history was preserved.')}>Confirm removal of {d.domain}</button><button className="secondary-button" disabled={!!busy} onClick={()=>setRemoving('')}>Cancel</button></div>:<button className="secondary-button" disabled={!!busy} onClick={()=>setRemoving(d.id)}>Remove custom domain</button>)}</div>}
      </article>;})}
      <article className="governance-card"><h3>Check your domain’s mail authentication</h3><p>Ask your IT team to review existing SPF, DKIM and DMARC settings before delegation. Keep one valid SPF record per hostname and preserve DMARC reporting settings. A domain must be active before an Aura can use it.</p><p>Assign an Aura’s email address from the generate-email flow after its domain is active.</p></article>
    </>}
  </>;
}
