import { emailSlug } from '../../shared/email-prefix.ts';
import {useEffect,useState} from 'react';
import {TIER_LABELS} from './GovernancePanel';

type Requester=(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
type Domain={id:string;domain:string};
const prefixFor=(name:string)=>name.trim()?emailSlug(name).slice(0,64).replace(/[.-]+$/g,''):'';
export function CreateAuraForm({request,onCreated,onBusy}:{request:Requester;onCreated:(data:any)=>void;onBusy:(value:boolean)=>void}) {
  const [name,setName]=useState(''),[role,setRole]=useState('General assistant'),[tier,setTier]=useState('1');
  const [prefix,setPrefix]=useState(''),[edited,setEdited]=useState(false),[domains,setDomains]=useState<Domain[]>([]),[domain,setDomain]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();void request('/manage/domains?active=true','GET',undefined,c.signal).then(d=>{setDomains(d.domains);setDomain(d.domains[0]?.id||'');}).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[request]);
  async function create(e:React.FormEvent){e.preventDefault();setBusy(true);onBusy(true);setError('');try{const result=await request('/manage/auras','POST',{name,role,tier,generate_email:true,domain_id:domain,local_part:prefix});onCreated(result);}catch(e){setError((e as Error).message);}finally{setBusy(false);onBusy(false);}}
  return <form className="governance-card" onSubmit={e=>void create(e)}><h2>Create Email</h2>
    {error&&<p className="error-box" role="alert">{error}</p>}
    <label>Aura name<input required maxLength={100} disabled={busy} value={name} onChange={e=>{setName(e.target.value);if(!edited)setPrefix(prefixFor(e.target.value));}}/></label>
    <label>Aura role<input required maxLength={100} disabled={busy} value={role} onChange={e=>setRole(e.target.value)}/></label>
    <label>Email prefix<input required maxLength={64} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={prefix} onChange={e=>{setEdited(true);setPrefix(e.target.value.toLowerCase());}}/></label>
    <label>Company email domain<select required disabled={loading||busy||!domains.length} value={domain} onChange={e=>setDomain(e.target.value)}><option value="" disabled>{loading?'Loading verified domains…':'Choose a verified domain'}</option>{domains.map(d=><option key={d.id} value={d.id}>{d.domain}</option>)}</select></label>
    {domain&&<p>Email address: <strong>{prefix||'…'}@{domains.find(d=>d.id===domain)?.domain}</strong></p>}
    {!loading&&!domains.length&&<p role="alert">Set up a company email domain before creating an email address.</p>}
    <label>Sending governance tier<select disabled={busy} value={tier} onChange={e=>setTier(e.target.value)}>{Object.entries(TIER_LABELS).map(([id,label])=><option key={id} value={id}>Tier {id} · {label}</option>)}</select></label>
    <p>The address and incoming mail route are configured automatically. {tier==='1'?'Every reply requires approval before sending.':tier==='4'?'AI replies can send automatically.':'Initial replies require approval according to the selected tier.'}</p>
    <button className="primary-button" disabled={loading||busy||!domain||!prefix.trim()}>{busy?'Creating email…':'Create Email'}</button>
  </form>;
}
