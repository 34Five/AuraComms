import { workspaceFetch } from './auth';
import { useEffect, useState } from 'react';
export const TIER_LABELS: Record<string,string> = {'1':'Review every message','2':'Review first outgoing message','3':'Review first reply after inbound','4':'Automatic sending'};
const DETAILS: Record<string,string> = {
  '1':'Every outgoing message waits for a reviewer.',
  '2':'The first outgoing message in each conversation needs approval. Later messages become automatic after it sends.',
  '3':'Outreach can send automatically. The first reply after incoming mail needs approval. Later replies become automatic after it sends.',
  '4':'Messages can send without human approval. Configured copies and daily limits still apply.',
};
type Review = {id:string;message_id:string;thread_id:string;subject:string;to_addresses:string;body_text:string|null;status:string;message_status:string;reason:string;decision_source:string;revision:number;tier_applied:string;requested_at:string;approver_member_id:string|null;edited_before_send:number};
type Data = {threads:{id:string;subject:string|null;review_epoch:number;tier_state:string|null}[];policy:{tier:string|null;version:number;rules:{cc?:string[];bcc?:string[];daily_limit?:number|null}};reviews:Review[];drafts:{id:string;thread_id:string;subject:string}[];reviewers:{member_id:string}[];member_id:string};
export function GovernancePanel({canConfigure=true,auraId,onConversation,onChanged}: {canConfigure?:boolean;auraId:string;onConversation:(id:string)=>void;onChanged:()=>void}) {
  const [data,setData] = useState<Data|null>(null);
  const [tab,setTab] = useState('reviews'), [error,setError] = useState(''), [loadError,setLoadError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false);
  const [revision,setRevision] = useState(0), [tier,setTier] = useState('1'), [limit,setLimit] = useState(''), [cc,setCc] = useState(''), [bcc,setBcc] = useState('');
  const [to,setTo] = useState(''), [subject,setSubject] = useState(''), [text,setText] = useState(''), [showHistory,setShowHistory] = useState(false), [removePolicy,setRemovePolicy] = useState(false);
  const root = `/api/auras/${auraId}`;
  async function request(path:string,method='GET',body?:unknown,signal?:AbortSignal) {
    const response = await workspaceFetch(root+path,{method,signal,cache:'no-store',headers:{...(body !== undefined ? {'Content-Type':'application/json'} : {})},...(body !== undefined ? {body:JSON.stringify(body)} : {})});
    const value = await response.json() as any;
    if (!response.ok) throw new Error(value.error || 'The request failed.');
    return value;
  }
  useEffect(() => {setData(null);setNotice('');setError('');},[auraId]);
  useEffect(() => {
    setLoadError('');
    const controller = new AbortController(); let loading=false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading=true;
      try { const next=await request('/governance','GET',undefined,controller.signal);setData(next);setLoadError(''); }
      catch(e) {if((e as Error).name !== 'AbortError') setLoadError((e as Error).message);} finally {loading=false;}
    };
    void load(); const interval=setInterval(load,5000);
    return () => {controller.abort();clearInterval(interval);};
  },[auraId,revision]);
  useEffect(() => {
    if (!data) return;
    setTier(data.policy.tier ?? '1');setLimit(String(data.policy.rules.daily_limit ?? ''));
    setCc((data.policy.rules.cc ?? []).join(', '));setBcc((data.policy.rules.bcc ?? []).join(', '));
  },[data?.policy.version]);
  async function action(path:string,method='POST',body?:unknown,success='Saved.') {
    setBusy(true);setError('');setNotice('');
    try {
      const result=await request(path,method,body);
      setNotice(result.message || success);setRevision(n=>n+1);onChanged();
      return result;
    } catch(e) {setError((e as Error).message);return null;} finally {setBusy(false);}
  }
  const actionable = data?.reviews.filter(r=>['pending','approved'].includes(r.status) && ['draft','queued'].includes(r.message_status)) ?? [];
  const history = data?.reviews.filter(r=>!actionable.some(a=>a.id===r.id)) ?? [];
  return <div className="governance-panel">

      <nav className="governance-tabs" aria-label="Governance sections">{[['reviews',`Reviews (${actionable.length})`],['settings','Policy settings'],['compose','New conversation'],['conversations','Conversations']].filter(([id])=>canConfigure||['reviews','conversations'].includes(id)).map(([id,label])=><button key={id} className={tab===id?'active':''} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</nav>
      {(error||loadError) && <div role="alert" className="error-box">{error||loadError}</div>}{notice && <p role="status" className="governance-notice">{notice}</p>}
      {!data && !error && !loadError && <p>Loading governance…</p>}
      {data && canConfigure && tab==='settings' && <form className="governance-card" onSubmit={async e=>{
        e.preventDefault();const split=(v:string)=>v.split(',').map(x=>x.trim()).filter(Boolean);
        await action('/governance/policy','PUT',{tier,version:data.policy.version,rules:{daily_limit:limit===''?null:Number(limit),cc:split(cc),bcc:split(bcc)}},'Policy saved. Previous unsent approvals need a new evaluation.');
      }}><h3>Sending policy</h3><label>Tier<select value={tier} onChange={e=>setTier(e.target.value)}>{Object.entries(TIER_LABELS).map(([id,label])=><option key={id} value={id}>Tier {id} · {label}</option>)}</select></label><p className="policy-explanation">{DETAILS[tier]}</p>
        <label>Daily sending limit<input type="number" min="1" step="1" placeholder="No configured limit" value={limit} onChange={e=>setLimit(e.target.value)}/></label><p>Counts sent messages and reserved approvals per Aura, using UTC days.</p>
        <label>Cc for Tier 4<input value={cc} onChange={e=>setCc(e.target.value)} placeholder="reviewer@example.com, audit@example.com"/></label>
        <label>Bcc for Tier 4<input value={bcc} onChange={e=>setBcc(e.target.value)} placeholder="audit@example.com"/></label>
        <p>Copies apply to Tier 4. Existing draft recipients remain until explicitly edited.</p>
        <div className="review-actions"><button className="primary-button" disabled={busy}>{data.policy.tier?'Save policy':'Create policy'}</button>{data.policy.tier&&<button type="button" className="danger-button" disabled={busy} onClick={()=>setRemovePolicy(v=>!v)}>Remove policy</button>}</div>
        {removePolicy&&<div className="policy-removal"><p>Remove this sending policy? Outgoing mail will stop until you create a new policy. Decision history will stay available.</p><button type="button" className="danger-button" disabled={busy} onClick={async()=>{const result=await action('/governance/policy','DELETE',{version:data.policy.version},'Policy removed. Outgoing mail is held.');if(result)setRemovePolicy(false);}}>Confirm policy removal</button><button type="button" className="secondary-button" onClick={()=>setRemovePolicy(false)}>Keep policy</button></div>}
        <div className="reviewer-note"><strong>Designated reviewers</strong><p>{data.reviewers.map(r=>r.member_id).join(', ') || 'None'}</p><p>Current reviewer: {data.member_id}</p></div>
      </form>}
      {data && canConfigure && tab==='compose' && <form className="governance-card" onSubmit={async e=>{
        e.preventDefault();const result=await action('/governance/compose','POST',{to,subject,text},'Draft created and evaluated. Open Reviews to approve or send it.');
        if(result){setTo('');setSubject('');setText('');setTab('reviews');}
      }}><h3>Start a conversation</h3><p>Create an outgoing draft to demonstrate how this tier handles Aura-initiated email.</p>
        <label>To<input type="email" required value={to} onChange={e=>setTo(e.target.value)}/></label>
        <label>Subject<input required maxLength={200} value={subject} onChange={e=>setSubject(e.target.value)}/></label>
        <label>Message<textarea required rows={7} maxLength={12000} value={text} onChange={e=>setText(e.target.value)}/></label>
        <button className="primary-button" disabled={busy||!data.policy.tier}>Create and evaluate draft</button>{!data.policy.tier&&<p>Create a sending policy before composing mail.</p>}<p>Creating a draft does not send it. Approved drafts have a separate Send email action.</p>
      </form>}
      {data && tab==='conversations' && <><p className="history-note">{canConfigure?'Reset a conversation when its next Tier 2 or Tier 3 response needs review again.':'Open a conversation to inspect its messages.'} Sent history stays available.</p>{data.threads.length===0&&<div className="governance-card"><h3>No conversations yet</h3></div>}{data.threads.map(t=><article key={t.id} className="governance-card"><div className="review-heading"><h3>{t.subject||'(No subject)'}</h3><span className="status-tag archived">Review cycle {t.review_epoch+1}</span></div><div className="review-actions"><button className="secondary-button" onClick={()=>onConversation(t.id)}>Open conversation</button>{canConfigure&&<button className="secondary-button" disabled={busy} onClick={()=>action(`/threads/${t.id}/reset`,'POST',undefined,'Review requirement reset. Unsent decisions were invalidated.')}>Reset review requirement</button>}</div></article>)}</>}
      {data && tab==='reviews' && <>
        <div className="policy-summary"><span className="status-tag">{data.policy.tier?`Tier ${data.policy.tier}`:'No policy'}</span><strong>{data.policy.tier?TIER_LABELS[data.policy.tier]:'Outgoing mail is held'}</strong><p>{data.policy.tier?DETAILS[data.policy.tier]:'Create a sending policy under Policy settings.'}</p></div>
        {data.drafts.map(d=><article className="governance-card" key={d.id}><h3>{d.subject || '(No subject)'}</h3><p>This draft needs evaluation under the current policy.</p>{canConfigure&&<button className="primary-button" disabled={busy} onClick={()=>action(`/messages/${d.id}/evaluate`)}>Evaluate draft</button>}<button className="secondary-button" onClick={()=>onConversation(d.thread_id)}>Open conversation</button></article>)}
        {!actionable.length && !data.drafts.length && <div className="governance-card"><h3>No messages need action</h3><p>Incoming mail can create drafts. {canConfigure?'Use New conversation to test outgoing email.':'Assigned Aura drafts will appear here when they need review.'}</p></div>}
        {actionable.map(r=><article className="governance-card" key={r.id}>
          <div className="review-heading"><h3>{r.subject || '(No subject)'}</h3><span className={`status-tag ${r.status==='pending'?'closed':''}`}>{r.status==='pending'?'Needs review':'Ready to send'}</span></div>
          <p>To: {r.to_addresses}</p><pre className="review-preview">{r.body_text || 'Open the conversation to inspect the full message and attachments.'}</pre>
          <p>{r.reason==='daily_limit'?'Held by the daily limit. Approval cannot bypass it.':r.decision_source==='automatic'?'The tier allows automatic sending.':TIER_LABELS[r.tier_applied]}</p>
          <div className="review-actions">{r.status==='pending' ? <><button className="primary-button" disabled={busy} onClick={()=>action(`/reviews/${r.id}/decide`,'POST',{outcome:'approved'},'Approved. The conversation unlocks only after this email sends.')}>Approve</button><button className="secondary-button" disabled={busy} onClick={()=>action(`/reviews/${r.id}/decide`,'POST',{outcome:'rejected'},'Draft rejected.')}>Reject</button></> : <button className="primary-button" disabled={busy} onClick={()=>action(`/reviews/${r.id}/send`,'POST',undefined,'Email sent.')}>Send email</button>}
            <button className="secondary-button" onClick={()=>onConversation(r.thread_id)}>Open conversation</button>{canConfigure&&<><button className="secondary-button" disabled={busy} onClick={()=>action(`/messages/${r.message_id}/cancel`,'POST',undefined,'Draft cancelled. Review history was preserved.')}>Cancel draft</button><button className="text-button" disabled={busy} onClick={()=>action(`/messages/${r.message_id}/evaluate`,'POST',undefined,'Draft evaluated.')}>Reevaluate</button></>}</div>
          {canConfigure&&<DraftEditor review={r} busy={busy} onSave={(subject,text)=>action(`/messages/${r.message_id}/edit`,'POST',{subject,text},'Draft updated and evaluated.')}/>}
          <small>Revision {r.revision} · {r.decision_source} decision{r.approver_member_id ? ` · ${r.approver_member_id}`:''}</small>
        </article>)}
        <button className="secondary-button" onClick={()=>setShowHistory(v=>!v)} aria-expanded={showHistory}>{showHistory?'Hide':'Show'} decision history ({history.length})</button>
        {showHistory && history.map(r=><article key={r.id} className="governance-card history-card"><div className="review-heading"><button className="history-link" onClick={()=>onConversation(r.thread_id)}>{r.subject || '(No subject)'}</button><span className="status-tag archived">{r.message_status==='sending'?'Send outcome uncertain':r.status}</span></div><p>Tier {r.tier_applied} · Revision {r.revision} · {r.decision_source} · {new Date(r.requested_at).toLocaleString()}</p><p>{r.reason?.replaceAll('_',' ')}{r.approver_member_id ? ` · Reviewer: ${r.approver_member_id}`:''}{r.edited_before_send ? ' · Edited before send':''}</p>{canConfigure && r.status==='rejected' && ['draft','queued'].includes(r.message_status) && <DraftEditor review={r} busy={busy} onSave={(subject,text)=>action(`/messages/${r.message_id}/edit`,'POST',{subject,text},'Revised draft evaluated.')}/>}</article>)}
        <p className="history-note">Shows the latest 100 review revisions for this Aura. Sent means provider acceptance.</p>
      </>}
  </div>;
}
function DraftEditor({review,busy,onSave}:{review:Review;busy:boolean;onSave:(subject:string,text:string)=>Promise<unknown>}) {
  const [subject,setSubject]=useState(review.subject || ''),[text,setText]=useState(review.body_text || '');
  if(review.body_text===null) return null;
  return <details className="draft-editor"><summary>Edit draft</summary><form onSubmit={e=>{e.preventDefault();void onSave(subject,text);}}><label>Subject<input value={subject} required maxLength={200} onChange={e=>setSubject(e.target.value)}/></label><label>Message<textarea rows={5} maxLength={12000} required value={text} onChange={e=>setText(e.target.value)}/></label><p>Saving invalidates the previous decision and evaluates the new revision.</p><button className="secondary-button" disabled={busy}>Save and reevaluate</button></form></details>;
}
