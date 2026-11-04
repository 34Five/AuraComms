import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { messageState } from './message-state.ts';
import { fragmentToText, splitQuotedText } from './quoted-text.ts';

type Aura = { id: string; name: string; thread_count: number; message_count: number;
  addresses: { address: string; status: string; domain_status: string }[] };
type Thread = { id: string; subject: string | null; sender: string | null; preview: string | null;
  last_activity_at: string; message_count: number; inbox_status: string };
type Message = { id: string; direction: string; status: string; from_address: string; from_name: string | null;
  subject: string | null; body_text: string | null; body_html: string | null; body_storage: string; activity_at: string;
  recipients: { kind: string; address: string; display_name: string | null }[];
  attachments: { id: string; filename: string; size_bytes: number }[];
  failure: { class: string; summary: string } | null; display_state: string | null };
type ThreadPage = { threads: Thread[]; nextCursor: string | null };
type MessagePage = { thread: Thread; messages: Message[]; nextCursor: string | null };

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string,string> = {
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
    search: 'm21 21-4.34-4.34 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5',
    back: 'm15 18-6-6 6-6', mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 7l-10 6L2 7',
    attachment: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
    check: 'M20 6 9 17l-5-5',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.mail}/></svg>;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store' });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Unable to load your inbox.');
  return data;
}
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0,2).map(n => n[0]).join('').toUpperCase(); }
function date(value: string, full = false) {
  return new Date(value).toLocaleString(undefined, full
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function merge<T extends { id: string }>(older: T[], newer: T[]): T[] {
  return [...new Map([...older,...newer].map(row => [row.id,row])).values()];
}
function plain(text: string | null, html: string | null): string {
  if (text) return text;
  if (!html) return 'This message has no text content.';
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['blockquote','br','p','div','li','ul','ol','table','tbody','tr','td','th','pre','span','b','strong','i','em','a'],
    ALLOWED_ATTR: ['class'],
    FORBID_TAGS: ['style','script','img','video','audio','iframe','object','svg'],
  });
  return fragmentToText(fragment) || 'This message has no text content.';
}

function MessageBody({ text }: { text: string }) {
  const parts = useMemo(() => splitQuotedText(text), [text]);
  return <div className="message-body">{parts.map((part,index) => part.quoted
    ? <details className="quoted-history" key={index}><summary><span className="quote-dots" aria-hidden="true">•••</span><span className="quote-show">Show quoted text</span><span className="quote-hide">Hide quoted text</span></summary><div className="quoted-content">{part.text}</div></details>
    : <div className="reply-text" key={index}>{part.text}</div>)}</div>;
}

function MessageCard({ message: m, auraId }: { message: Message; auraId: string }) {
  const [body,setBody] = useState<{ body_text: string | null; body_html: string | null } | null>(null);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  const load = async () => {
    setLoading(true); setError('');
    try { setBody(await get(`/api/auras/${auraId}/messages/${m.id}/body`)); }
    catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  };
  const state = messageState(m);
  const hasBody = m.body_storage === 'r2' || m.body_text !== null || m.body_html !== null;
  return <article className={m.direction === 'out' ? 'message-card outbound' : 'message-card'}>
    <div className="message-heading"><span className="sender-avatar">{initials(m.from_name || m.from_address)}</span>
      <div className="sender-detail"><strong>{m.from_name || m.from_address}</strong>{m.from_name && <span>{m.from_address}</span>}</div>
      <time dateTime={m.activity_at}>{date(m.activity_at,true)}</time>
    </div>
    <div className="recipient-line">To: {m.recipients.filter(r => r.kind === 'to').map(r => r.address).join(', ') || '—'}
      {m.recipients.some(r => r.kind === 'cc') && <span className="recipient-cc">Cc: {m.recipients.filter(r => r.kind === 'cc').map(r => r.address).join(', ')}</span>}</div>
    {state === 'failed' && <div className="reply-failed" role="alert"><strong>Reply failed</strong>{m.failure && <p>{m.failure.summary}</p>}<p>No email was sent.</p></div>}
    {state === 'timed_out' && <div className="reply-failed" role="alert"><strong>Reply timed out</strong><p>The reply did not finish generating, and no email was sent.</p></div>}
    {state === 'generating' && <p className="reply-generating">Generating reply…</p>}
    {(state === 'normal' || (state === 'failed' && hasBody)) && (m.body_storage === 'r2' && !body ? <button className="text-button" onClick={load} disabled={loading}>{loading ? 'Loading message…' : 'Load full message'}</button>
      : <MessageBody text={plain(body?.body_text ?? m.body_text,body?.body_html ?? m.body_html)}/>)}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {m.attachments.length > 0 && <div className="attachments">{m.attachments.map(a => <a key={a.id} href={`/api/auras/${auraId}/messages/${m.id}/attachments/${a.id}`} className="attachment"><Icon name="attachment" size={16}/><span>{a.filename || 'Attachment'}<small>{Math.max(1,Math.round(a.size_bytes/1024))} KB</small></span></a>)}</div>}
    {state === 'normal' && <div className="message-status"><Icon name="check" size={13}/>{m.direction === 'in' ? 'Received' : m.status}</div>}
  </article>;
}

export function App() {
  const [auras,setAuras] = useState<Aura[]>([]);
  const [auraId,setAuraId] = useState(new URLSearchParams(location.search).get('aura') || '');
  const [threadId,setThreadId] = useState('');
  const [threads,setThreads] = useState<Thread[]>([]);
  const [threadCursor,setThreadCursor] = useState<string | null>(null);
  const [messages,setMessages] = useState<Message[]>([]);
  const [messageCursor,setMessageCursor] = useState<string | null>(null);
  const [threadDetail,setThreadDetail] = useState<Thread | null>(null);
  const [search,setSearch] = useState('');
  const [query,setQuery] = useState('');
  const [status,setStatus] = useState('');
  const [error,setError] = useState('');
  const [messageError,setMessageError] = useState('');
  const [loading,setLoading] = useState(true);
  const [loadingMessages,setLoadingMessages] = useState(false);
  const [moreBusy,setMoreBusy] = useState(false);
  const [refreshKey,setRefreshKey] = useState(0);
  const [synced,setSynced] = useState<Date | null>(null);
  const listGeneration = useRef(0), messageGeneration = useRef(0);
  const aura = auras.find(a => a.id === auraId);
  const liveAddress = aura?.addresses.find(a => a.status === 'active' && a.domain_status === 'active')?.address;
  const inboxPath = useMemo(() => `/api/auras/${auraId}/inbox?limit=25&q=${encodeURIComponent(query)}${status ? `&status=${status}` : ''}`,[auraId,query,status]);
  const messagePath = `/api/auras/${auraId}/threads/${threadId}/messages?limit=25`;

  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()),250); return () => clearTimeout(timer); },[search]);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const data = await get<{ auras: Aura[] }>('/api/auras',controller.signal);
        setAuras(data.auras);
        setAuraId(current => data.auras.some(a => a.id === current) ? current : data.auras[0]?.id || '');
        if (!data.auras.length) setLoading(false);
      } catch (e) { if ((e as Error).name !== 'AbortError') { setError((e as Error).message); setLoading(false); } }
      finally { busy = false; }
    };
    void load(); const timer = setInterval(load,5000);
    document.addEventListener('visibilitychange',load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange',load); };
  },[refreshKey]);

  useEffect(() => {
    if (!auraId) return;
    const url = new URL(location.href); url.searchParams.set('aura',auraId); history.replaceState(null,'',url);
    const generation = ++listGeneration.current;
    const controller = new AbortController();
    let busy = false, first = true;
    setLoading(true); setThreads([]); setThreadCursor(null); setError(''); setMoreBusy(false);
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const page = await get<ThreadPage>(inboxPath,controller.signal);
        if (generation !== listGeneration.current) return;
        setThreads(old => first ? page.threads : merge(old,page.threads).sort((a,b) => b.last_activity_at.localeCompare(a.last_activity_at) || b.id.localeCompare(a.id)));
        if (first) setThreadCursor(page.nextCursor);
        first = false; setError(''); setSynced(new Date());
      } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
      finally { busy = false; if (generation === listGeneration.current) setLoading(false); }
    };
    void load();
    const interval = setInterval(load,5000);
    document.addEventListener('visibilitychange',load);
    return () => { ++listGeneration.current; controller.abort(); clearInterval(interval); document.removeEventListener('visibilitychange',load); };
  },[auraId,inboxPath,refreshKey]);

  useEffect(() => {
    const generation = ++messageGeneration.current;
    const controller = new AbortController();
    let busy = false, first = true;
    setMessages([]); setThreadDetail(null); setMessageCursor(null); setMessageError('');
    if (!auraId || !threadId) { setLoadingMessages(false); return; }
    setLoadingMessages(true);
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const page = await get<MessagePage>(messagePath,controller.signal);
        if (generation !== messageGeneration.current) return;
        setThreadDetail(page.thread);
        setMessages(old => merge(old,page.messages).sort((a,b) => a.activity_at.localeCompare(b.activity_at) || a.id.localeCompare(b.id)));
        if (first) setMessageCursor(page.nextCursor);
        first = false; setMessageError('');
      } catch (e) { if ((e as Error).name !== 'AbortError') setMessageError((e as Error).message); }
      finally { busy = false; if (generation === messageGeneration.current) setLoadingMessages(false); }
    };
    void load(); const interval = setInterval(load,5000);
    document.addEventListener('visibilitychange',load);
    return () => { ++messageGeneration.current; controller.abort(); clearInterval(interval); document.removeEventListener('visibilitychange',load); };
  },[auraId,threadId,refreshKey]);

  const moreThreads = useCallback(async () => {
    const generation = listGeneration.current; setMoreBusy(true);
    try {
      const page = await get<ThreadPage>(`${inboxPath}&cursor=${encodeURIComponent(threadCursor!)}`);
      if (generation !== listGeneration.current) return;
      setThreads(old => merge(old,page.threads)); setThreadCursor(page.nextCursor);
    } catch (e) { if (generation === listGeneration.current) setError((e as Error).message); }
    finally { if (generation === listGeneration.current) setMoreBusy(false); }
  },[inboxPath,threadCursor]);
  const moreMessages = async () => {
    const generation = messageGeneration.current;
    try {
      const page = await get<MessagePage>(`${messagePath}&cursor=${encodeURIComponent(messageCursor!)}`);
      if (generation !== messageGeneration.current) return;
      setMessages(old => merge(page.messages,old).sort((a,b) => a.activity_at.localeCompare(b.activity_at) || a.id.localeCompare(b.id)));
      setMessageCursor(page.nextCursor);
    } catch (e) { if (generation === messageGeneration.current) setMessageError((e as Error).message); }
  };

  return <div className={`app ${threadId ? 'has-conversation' : ''}`}>
    <aside className="sidebar">
      <a href="/" className="brand">34Five<small>Aura inbox</small></a>
      <div className="section-label">Aura inboxes</div>
      <nav className="aura-nav" aria-label="Aura inboxes">{auras.map((a,index) => <button key={a.id} className={`aura-button ${a.id === auraId ? 'active' : ''}`} onClick={() => { setAuraId(a.id); setThreadId(''); setSearch(''); setStatus(''); }} aria-current={a.id === auraId ? 'page' : undefined}>
        <span className={`aura-avatar tone-${index%3}`}>{initials(a.name.replace(' Aura',''))}</span><span className="aura-label"><strong>{a.name.replace(/ Aura$/,'')}</strong><small>{a.addresses.find(x => x.domain_status === 'active')?.address || 'No receiving address'}</small></span><span className="aura-count">{a.thread_count}</span>
      </button>)}</nav>
      <div className="test-note"><strong>Test workspace</strong> Public access. Use test messages only.</div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="topbar-title"><h1>{aura?.name.replace(/ Aura$/,'') || 'Your'} inbox</h1><p>{liveAddress ? <>Receiving at <span className="mail-address">{liveAddress}</span></> : 'Select an Aura to view its conversations.'}</p></div>
        <div className="search"><Icon name="search" size={16}/><input aria-label="Search conversations" placeholder="Search subject or sender" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label="Clear search" onClick={() => setSearch('')}>×</button>}</div>
        <div className="topbar-right"><span className="read-only">Read-only</span><button className="refresh-button" onClick={() => setRefreshKey(n => n+1)}><Icon name="refresh" size={15}/>Refresh</button></div>
      </header>
      <div className="inbox-layout">
        <section className="thread-panel" aria-label="Conversations">
          <div className="list-toolbar"><h2>Conversations <span>{threads.length}</span></h2><select aria-label="Filter conversation status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All mail</option><option value="open">Open</option><option value="closed">Closed</option><option value="archived">Archived</option></select></div>
          <div className="thread-list">{error && <div className="error-box" role="alert">{error}<button onClick={() => setRefreshKey(n => n+1)}>Try again</button></div>}
            {loading && <div className="list-empty">Loading conversations…</div>}
            {!loading && !error && threads.length === 0 && <div className="list-empty"><Icon name="inbox" size={28}/><strong>{query || status ? 'No matching conversations' : 'No mail yet'}</strong><p>{query || status ? 'Try another search or status.' : 'Incoming messages for this Aura will appear here.'}</p></div>}
            {threads.map(t => <button key={t.id} className={`thread-item ${t.id === threadId ? 'selected' : ''}`} onClick={() => setThreadId(t.id)}><div className="thread-top"><strong>{t.sender || aura?.name || 'Conversation'}</strong>{t.message_count > 1 && <span className="thread-count">{t.message_count}<span className="sr-only"> messages</span></span>}<time dateTime={t.last_activity_at}>{date(t.last_activity_at)}</time></div><h3>{t.subject || '(No subject)'}</h3><div className="thread-bottom"><p>{t.preview || 'Open to view this conversation.'}</p>{t.inbox_status !== 'open' && <span className={`status-tag ${t.inbox_status}`}>{t.inbox_status}</span>}</div></button>)}
            {threadCursor && <button className="load-more" disabled={moreBusy} onClick={moreThreads}>{moreBusy ? 'Loading…' : 'Load more conversations'}</button>}
          </div><div className="sync-line"><span className={`live-dot ${error ? 'offline' : ''}`}/>{error ? 'Connection needs attention' : synced ? `Updated ${synced.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}` : 'Connecting…'}<span>Refreshes every 5 seconds</span></div>
        </section>
        <section className="conversation-panel" aria-label="Message view">
          {!threadId ? <div className="conversation-empty"><Icon name="mail" size={32}/><h2>Select a conversation</h2><p>Messages for this Aura open here.</p></div>
            : <><div className="conversation-header"><button className="back-button" aria-label="Back to conversations" onClick={() => setThreadId('')}><Icon name="back"/></button><h2>{threadDetail?.subject || (loadingMessages ? 'Loading conversation…' : '(No subject)')}</h2>{threadDetail && <span className={`status-tag ${threadDetail.inbox_status}`}>{threadDetail.inbox_status}</span>}</div><div className="message-list">{messageError && <div className="error-box" role="alert">{messageError}<button onClick={() => setRefreshKey(n => n+1)}>Try again</button></div>}{loadingMessages && <div className="list-empty">Loading messages…</div>}{messageCursor && <button className="load-more" onClick={moreMessages}>Load earlier messages</button>}{messages.map(m => <MessageCard key={m.id} message={m} auraId={auraId}/>)}</div><div className="conversation-footer"><Icon name="inbox" size={15}/>You are viewing this conversation in read-only mode.</div></>}
        </section>
      </div>
    </main>
  </div>;
}
