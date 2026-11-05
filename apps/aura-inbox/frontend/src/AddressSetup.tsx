import React, {useEffect,useState} from 'react';

type Requester=(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
type Address={address:string;status:string;domain_status:string;provisioning:{status:string;reason:string|null}};
type Domain={id:string;domain:string;address:string};
export function AddressSetup({auraId,request,onChanged}:{auraId:string;request:Requester;onChanged:()=>void}) {
  const [address,setAddress]=useState<Address|null>(null),[domains,setDomains]=useState<Domain[]>([]),[domain,setDomain]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[choosing,setChoosing]=useState(false),[error,setError]=useState(''),[prefix,setPrefix]=useState('');
  const path=`/manage/auras/${auraId}/address`;
  useEffect(()=>{const controller=new AbortController();
    void request(`/manage/auras/${auraId}`,'GET',undefined,controller.signal).then(async data=>{
      if(data.addresses.length) setAddress((await request(path,'GET',undefined,controller.signal)).address);
    }).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[auraId,path,request]);
  async function propose(){setBusy(true);setError('');try{const result=await request(path+'/proposal');setDomains(result.domains);setDomain(result.domains[0]?.id||'');setPrefix(result.domains[0]?.address.split('@')[0]||'');setChoosing(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function save(retry=false){setBusy(true);setError('');try{const result=await request(path+(retry?'/provision':''),'POST',retry?{}:{domain_id:domain,local_part:prefix});setAddress(result.address);setChoosing(false);onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  if(loading)return <p role="status">Checking email setup…</p>;
  const ready=address?.status==='active'&&address.domain_status==='active'&&address.provisioning.status==='active';
  return <div className="address-setup">
    {error&&<p className="error-box" role="alert">{error}</p>}
    {address?<><strong>{address.address}</strong><p role="status">{ready?'Email route active':address.status!=='active'?'Address disabled':address.domain_status!=='active'?'Domain not active':address.provisioning.status==='failed'?'Email setup failed':'Provisioning pending'}</p>
      {address.provisioning.reason&&<p>{address.provisioning.reason}</p>}
      {!ready&&address.status==='active'&&address.domain_status==='active'&&<button className="secondary-button" disabled={busy} onClick={()=>void save(true)}>{busy?'Completing setup…':'Retry email setup'}</button>}
      {ready&&<p>Incoming emails will appear in this Aura’s inbox. Replies follow its governance tier; approval may be required.</p>}
    </>:choosing?<form onSubmit={e=>{e.preventDefault();void save();}}><label>Email domain<select value={domain} onChange={e=>setDomain(e.target.value)}>{domains.map(d=><option key={d.id} value={d.id}>{d.domain}</option>)}</select></label><label>Email prefix<input required maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={prefix} onChange={e=>setPrefix(e.target.value.toLowerCase())}/></label><p>Email address: <strong>{prefix}@{domains.find(d=>d.id===domain)?.domain}</strong></p><button className="primary-button" disabled={busy||!domain||!prefix.trim()}>{busy?'Setting up email…':'Create address'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>setChoosing(false)}>Cancel</button></form>
    :<><p>Generate an address using an active company domain and set up its incoming mail route.</p><button className="primary-button" disabled={busy} onClick={()=>void propose()}>{busy?'Loading domains…':'Generate email'}</button><p>If no domain is available, complete setup in Company email domains.</p></>}
  </div>;
}
