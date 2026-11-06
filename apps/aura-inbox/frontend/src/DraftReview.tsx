import { useRef, useState } from 'react';
import { workspaceFetch } from './auth';

export type Review = {id:string;status:string;revision:number;tier_applied:string;reason:string;decision_source:string;edited_before_send:number;approver_member_id:string|null;requested_at:string;decided_at:string|null};
export type ReviewMessage = {id:string;direction:string;status:string;subject:string|null;body_text:string|null;body_storage:string;draft_version?:string|null;review?:Review|null;review_permissions?:{review:boolean;edit:boolean}};

export function DraftReview({message:m,auraId,onRefresh}:{message:ReviewMessage;auraId:string;onRefresh:()=>Promise<ReviewMessage|undefined>}) {
  const [busy,setBusy] = useState(''), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [editing,setEditing] = useState(false), [confirmCancel,setConfirmCancel] = useState(false);
  const [cancelVersion,setCancelVersion]=useState<string|null>(null);
  const [subject,setSubject] = useState(''), [text,setText] = useState(''), [editVersion,setEditVersion] = useState<string|null>(null);
  const [refreshFailed,setRefreshFailed]=useState(false), [sendAttemptedVersion,setSendAttemptedVersion]=useState<string|null>(null);
  const unavailable=!!busy||refreshFailed;
  const locked = useRef(false), editorButton = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  if (m.direction !== 'out') return null;
  const r=m.review, unsent=['draft','queued'].includes(m.status) && !!m.draft_version;
  if (!r && !unsent) return null;
  const canReview=!!m.review_permissions?.review, canEdit=!!m.review_permissions?.edit;
  const current=r && ['pending','approved','rejected'].includes(r.status);
  const staleCancel=confirmCancel && cancelVersion!==m.draft_version;
  const sendAttempted=!!sendAttemptedVersion && sendAttemptedVersion===m.draft_version;
  const staleEdit=editing && editVersion!==m.draft_version;
  async function action(path:string,label:string,body:Record<string,unknown>,success:string) {
    if (locked.current || refreshFailed) return;
    if(label==='Sending…' && sendAttempted) return;
    if(label==='Sending…')setSendAttemptedVersion(m.draft_version!);
    let requestRejected=false;
    locked.current=true;setBusy(label);setError('');setNotice('');
    try {
      const response=await workspaceFetch(`/api/auras/${auraId}/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json() as {error?:string;status?:string;message?:string};
      if (!response.ok) {requestRejected=true;throw new Error(result.error || 'The action failed.');}
      if(result.status==='unknown') setError(result.message || 'Send outcome unconfirmed. Do not resend until an administrator checks the provider’s activity.');
      else if(result.status==='failed') setError(result.message || 'The provider rejected this send. No email was sent.');
      else {setNotice(success);setEditing(false);setConfirmCancel(false);}
    } catch(e) {
      setError((e as Error).message + (label==='Sending…'&&!requestRejected?' The send outcome may be unconfirmed. Refresh and ask an administrator to check provider activity before taking further action.':''));
    } finally {
      // Refresh even after a failed request: the server may have completed it.
      try {
        const fresh=await onRefresh();
        // A rejected request can recover only after an authoritative read confirms
        // no dispatch claim exists. Ambiguous/network outcomes retain their lock.
        if(label==='Sending…' && requestRejected && fresh?.draft_version
          && ['draft','queued'].includes(fresh.status) && fresh.review?.status==='approved') setSendAttemptedVersion(null);
      }
      catch {setRefreshFailed(true);setError(previous=>(previous?previous+' ':'')+'Unable to refresh the draft. Use Refresh before acting again.');}
      locked.current=false;setBusy('');heading.current?.focus();
    }
  }
  const version={expected_version:m.draft_version};
  return <section className="inline-review" aria-label="Draft review" aria-busy={!!busy}>
    <h3 ref={heading} tabIndex={-1}>{m.status==='sent'?'Sent to provider':m.status==='cancelled'?'Draft cancelled':m.status==='sending'?'Send in progress or awaiting confirmation':m.status==='failed'?'Draft unavailable for sending':!current?'Policy evaluation needed':r.status==='pending'?'Needs review':r.status==='approved'?'Approved · ready to send':'Draft rejected'}</h3>
    {r && <p className="review-metadata">Tier {r.tier_applied} · Revision {r.revision}{r.edited_before_send?' · Edited before send':''}{r.decided_at?` · ${new Date(r.decided_at).toLocaleString()}`:''}</p>}
    {r?.reason==='daily_limit' && unsent && <p>Held by the daily limit. Approval cannot bypass it.</p>}
    {unsent && r?.status==='approved' && <p>{r.decision_source==='automatic'?'Policy permits sending.':'Approval saved.'} Use Send email to send this version.</p>}
    {unsent && !canReview && <p>A designated reviewer must review and send this draft.</p>}
    {busy && <p role="status">{busy}</p>}
    {notice && <p role="status" className="governance-notice">{notice}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {refreshFailed && <button className="secondary-button" disabled={!!busy} onClick={async()=>{setBusy('Refreshing…');try{await onRefresh();setRefreshFailed(false);setError('');}catch{setError('Unable to refresh. Actions remain disabled.');}finally{setBusy('');}}}>Refresh draft</button>}
    {unsent && canReview && <>
      <div className="review-actions">
        {current && r.status==='pending' && <><button className="primary-button" disabled={unavailable||editing} onClick={()=>void action(`reviews/${r.id}/decide`,'Approving…',{outcome:'approved'},'Approved. Send email is a separate action.')}>Approve</button><button className="secondary-button" disabled={unavailable||editing} onClick={()=>void action(`reviews/${r.id}/decide`,'Rejecting…',{outcome:'rejected'},'Draft rejected. Nothing was sent.')}>Reject</button></>}
        {current && r.status==='approved' && <button className="primary-button" disabled={unavailable||editing||sendAttempted} onClick={()=>void action(`reviews/${r.id}/send`,'Sending…',{},'Email accepted by the provider. Recipient delivery is not yet confirmed.')}>Send email</button>}
        {canEdit && <>
          {m.body_storage==='inline' && m.body_text!==null && <button ref={editorButton} className="secondary-button" disabled={unavailable||editing} onClick={()=>{setSubject(m.subject||'');setText(m.body_text||'');setEditVersion(m.draft_version!);setEditing(true);setConfirmCancel(false);}}>Edit draft</button>}
          <button className="secondary-button" disabled={unavailable||editing} onClick={()=>{setCancelVersion(m.draft_version!);setConfirmCancel(v=>!v);}} aria-expanded={confirmCancel}>Cancel draft</button>
          <button className="text-button" disabled={unavailable||editing} onClick={()=>void action(`messages/${m.id}/evaluate`,'Reevaluating policy…',version,'Policy reevaluated. No new AI reply was generated.')}>Reevaluate policy</button>
        </>}
      </div>
      {canEdit && <p className="review-help">Policy reevaluation checks sending rules for this draft. It does not generate a new reply.</p>}
      {confirmCancel && <div className="cancel-confirmation"><p>Cancel this draft? It will not send. Review history is preserved.</p>{staleCancel && <p role="alert" className="inline-error">This draft changed after you opened cancellation. Keep the draft, review the latest version, then open cancellation again to confirm.</p>}<div className="review-actions"><button className="danger-button" disabled={unavailable||staleCancel} onClick={()=>{if(!staleCancel)void action(`messages/${m.id}/cancel`,'Cancelling…',{expected_version:cancelVersion},'Draft cancelled. Nothing was sent.');}}>Confirm cancellation</button><button className="secondary-button" disabled={unavailable} onClick={()=>setConfirmCancel(false)}>Keep draft</button></div></div>}
      {editing && <form className="inline-draft-editor" onSubmit={e=>{e.preventDefault();void action(`messages/${m.id}/edit`,'Saving draft…',{subject,text,expected_version:editVersion},'Draft saved and policy reevaluated. Previous approval was invalidated.');}}>
        <label>Subject<input autoFocus value={subject} required maxLength={200} disabled={unavailable} onChange={e=>setSubject(e.target.value)}/></label>
        <label>Message<textarea aria-label="Message" rows={10} value={text} required disabled={unavailable} onChange={e=>setText(e.target.value)}/></label>
        <p>Saving invalidates the previous approval. Held drafts need approval again, followed by Send email.</p>
        {staleEdit && <p role="alert" className="inline-error">This draft changed while you were editing. Your text is preserved here. Close the editor and reopen the latest draft before saving.</p>}
        {new TextEncoder().encode(text).byteLength>12000 && <p role="alert">Message exceeds the 12 KB limit.</p>}
        <div className="review-actions"><button className="primary-button" disabled={unavailable||staleEdit||new TextEncoder().encode(text).byteLength>12000}>Save and reevaluate policy</button><button type="button" className="secondary-button" disabled={unavailable} onClick={()=>{setEditing(false);requestAnimationFrame(()=>editorButton.current?.focus());}}>Close editor</button></div>
      </form>}
    </>}
  </section>;
}
