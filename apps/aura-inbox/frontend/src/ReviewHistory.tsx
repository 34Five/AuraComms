import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { workspaceFetch } from './auth';

export type RecordedReview = {
  id:string;revision:number;tier_applied:string;status:string;decision_source:'human'|'automatic';
  reviewer:{member_id:string;display_name:string|null}|null;edited_before_send:boolean;
  requested_at:string|null;decided_at:string|null;sent_at:string|null;reason_label:string;
};
type Page={message_id:string;reviews:RecordedReview[];nextCursor:string|null};
type Loaded={reviews:RecordedReview[];nextCursor:string|null};
const STATUS:Record<string,string>={pending:'Pending',approved:'Approved',rejected:'Rejected',sent:'Sent to provider',superseded:'Superseded'};
function Timestamp({value}:{value:string|null}) {
  if(!value || !Number.isFinite(Date.parse(value)))return <>Not recorded</>;
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

export function ReviewHistory({auraId,messageId,changeKey}:{auraId:string;messageId:string;changeKey:string}) {
  const [open,setOpen]=useState(false),[data,setData]=useState<Loaded|null>(null);
  const [busy,setBusy]=useState(''),[error,setError]=useState('');
  const contentId=useId(), sequence=useRef(0), controller=useRef<AbortController|null>(null);
  const loaded=useRef<Loaded|null>(null), retry=useRef<'refresh'|'older'>('refresh');
  const root=`/api/auras/${auraId}/messages/${messageId}/reviews`;
  const load=useCallback(async(mode:'refresh'|'older')=>{
    controller.current?.abort();
    const abort=new AbortController();controller.current=abort;
    const request=++sequence.current, previous=loaded.current;
    setBusy(mode);setError('');retry.current=mode;
    const get=async(cursor:string|null):Promise<Page>=>{
      const response=await workspaceFetch(`${root}?limit=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:abort.signal});
      const page=await response.json() as Page & {error?:string};
      if(!response.ok)throw new Error(page.error||'Unable to load review history.');
      return page;
    };
    try {
      const page=await get(mode==='older'?previous?.nextCursor??null:null);
      let rows=mode==='older'?[...(previous?.reviews??[]),...page.reviews]:page.reviews;
      let next=page.nextCursor;
      // A new top revision must not evict the oldest revisions already opened.
      const floor=previous?.reviews.at(-1)?.revision;
      while(mode==='refresh' && floor!==undefined && next && (rows.at(-1)?.revision??Infinity)>floor) {
        const older=await get(next);rows=[...rows,...older.reviews];next=older.nextCursor;
      }
      if(request!==sequence.current || abort.signal.aborted)return;
      const result={reviews:[...new Map(rows.map(r=>[r.id,r])).values()].sort((a,b)=>b.revision-a.revision),nextCursor:next};
      loaded.current=result;setData(result);
    }catch(e){
      if(request===sequence.current && !abort.signal.aborted)setError((e as Error).message);
    }finally{if(request===sequence.current)setBusy('');}
  },[root]);
  useEffect(()=>{
    if(open)void load('refresh');
    return ()=>{++sequence.current;controller.current?.abort();};
  },[open,changeKey,load]);
  return <section className="review-history">
    <button className="secondary-button" aria-expanded={open} aria-controls={contentId} onClick={()=>setOpen(v=>!v)}>Review history</button>
    {open && <div id={contentId} className="review-history-content" aria-busy={!!busy}>
      <p className="history-note">Recorded revisions, newest first. Superseded revisions may no longer retain their earlier approval or rejection. This history does not record who edited or cancelled a draft, every edit time, or changes to the text.</p>
      <div className="review-actions"><button className="secondary-button" disabled={!!busy} onClick={()=>void load('refresh')}>Refresh history</button></div>
      {busy && <p role="status">{busy==='older'?'Loading older revisions…':data?'Refreshing review history…':'Loading review history…'}</p>}
      {error && <div role="alert" className="inline-error"><p>{error}{data?' The history below may be out of date.':''}</p><button className="secondary-button" disabled={!!busy} onClick={()=>void load(retry.current)}>Try again</button></div>}
      {data && !data.reviews.length && <p>No recorded reviews for this message.</p>}
      {data && <ol className="review-history-list">{data.reviews.map(r=><li key={r.id} className="review-history-row">
        <div className="review-heading"><h4>Revision {r.revision}</h4><span className="status-tag">{STATUS[r.status]??'Recorded status unavailable'}</span></div>
        {r.status==='superseded' && <p className="history-note">Replaced or invalidated. The earlier decision outcome may not be retained.</p>}
        <dl>
          <div><dt>Tier applied</dt><dd>{r.tier_applied}</dd></div>
          <div><dt>Decision source</dt><dd>{r.decision_source==='automatic'?'Automatic policy':'Human review'}</dd></div>
          <div><dt>Recorded reviewer</dt><dd>{r.decision_source==='automatic'?'No human reviewer (automatic)':r.reviewer?.display_name||r.reviewer?.member_id||'Not recorded'}</dd></div>
          <div><dt>Edited before send</dt><dd>{r.edited_before_send?'Marked as edited':'Not marked as edited'}</dd></div>
          <div><dt>Reason</dt><dd>{r.reason_label}</dd></div>
          <div><dt>Requested</dt><dd><Timestamp value={r.requested_at}/></dd></div>
          {r.decided_at && <div><dt>Decision time recorded</dt><dd><Timestamp value={r.decided_at}/></dd></div>}
          {r.sent_at && <div><dt>Provider accepted</dt><dd><Timestamp value={r.sent_at}/></dd></div>}
        </dl>
        {(r.status==='sent'||r.sent_at) && <p className="history-note">Provider acceptance does not confirm recipient delivery.</p>}
      </li>)}</ol>}
      {data?.nextCursor && <button className="secondary-button" disabled={!!busy} onClick={()=>void load('older')}>Load older revisions</button>}
    </div>}
  </section>;
}
