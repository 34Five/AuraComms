import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

type Aura = { id: string; name: string; thread_count: number; message_count: number;
  addresses: { address: string; status: string; domain_status: string }[] };
type Thread = { id: string; subject: string | null; sender: string | null; preview: string | null;
  last_activity_at: string; message_count: number; inbox_status: string };
type Message = { id: string; direction: string; status: string; from_address: string; from_name: string | null;
  subject: string | null; body_text: string | null; body_html: string | null; body_storage: string; activity_at: string;
  recipients: { kind: string; address: string; display_name: string | null }[];
  attachments: { id: string; filename: string; size_bytes: number }[] };
type ThreadPage = { threads: Thread[]; nextCursor: string | null };
type MessagePage = { thread: Thread; messages: Message[]; nextCursor: string | null };

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string,string> = {
    inbox: 'M4 4h16v16H4z M4 13h4l2 3h4l2-3h4',
    search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.5-2L20 8 M4 16l2.4 3A7 7 0 0 0 18 17',
    arrow: 'm9 5 7 7-7 7', back: 'm15 5-7 7 7 7', mail: 'M3 5h18v14H3z m0 0 9 7 9-7',
    attachment: 'm8 12 6-6a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L12 4 M6 16l9-9',
    check: 'm5 12 4 4L19 6', external: 'M14 3h7v7 m0-7-11 11 M10 3H3v18h18v-7',
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
  const stripped = DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [], FORBID_TAGS: ['style','script','img','video','audio','iframe','object','svg'] });
  const textarea = document.createElement('textarea');
  textarea.innerHTML = stripped;
  return textarea.value.trim() || 'This message has no text content.';
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
  return <article className="message-card">
    <div className="message-heading"><span className="sender-avatar">{initials(m.from_name || m.from_address)}</span>
      <div className="sender-detail"><strong>{m.from_name || m.from_address}</strong>{m.from_name && <span>{m.from_address}</span>}</div>
      <time dateTime={m.activity_at}>{date(m.activity_at,true)}</time>
    </div>
    <div className="recipient-line">To: {m.recipients.filter(r => r.kind === 'to').map(r => r.address).join(', ') || '—'}
      {m.recipients.some(r => r.kind === 'cc') && <span> · Cc: {m.recipients.filter(r => r.kind === 'cc').map(r => r.address).join(', ')}</span>}</div>
    {m.body_storage === 'r2' && !body ? <button className="text-button" onClick={load} disabled={loading}>{loading ? 'Loading message…' : 'Load full message'}</button>
      : <div className="message-body">{plain(body?.body_text ?? m.body_text,body?.body_html ?? m.body_html)}</div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {m.attachments.length > 0 && <div className="attachments">{m.attachments.map(a => <a key={a.id} href={`/api/auras/${auraId}/messages/${m.id}/attachments/${a.id}`} className="attachment"><Icon name="attachment" size={16}/><span>{a.filename || 'Attachment'}<small>{Math.max(1,Math.round(a.size_bytes/1024))} KB</small></span></a>)}</div>}
    <div className="message-status"><Icon name="check" size={13}/>{m.direction === 'in' ? 'Received' : m.status}</div>
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
      <a href="/" className="brand"><span className="brand-mark">a</span><span>aura<span className="brand-dot">.</span></span></a>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <div className="workspace"><span className="workspace-icon">34</span><div><strong>34Five Studio</strong><small>Email workspace</small></div><span className="test-chip">TEST</span></div>
      <div className="nav-item"><Icon name="inbox"/><span>Inbox</span><span className="nav-count">{auras.reduce((n,a) => n+a.thread_count,0)}</span></div>
      <div className="section-label">AURA INBOXES <span>{auras.length.toString().padStart(2,'0')}</span></div>
      <nav className="aura-nav" aria-label="Aura inboxes">{auras.map((a,index) => <button key={a.id} className={`aura-button ${a.id === auraId ? 'active' : ''}`} onClick={() => { setAuraId(a.id); setThreadId(''); setSearch(''); setStatus(''); }} aria-current={a.id === auraId ? 'page' : undefined}>
        <span className={`aura-avatar tone-${index%3}`}>{initials(a.name.replace(' Aura',''))}</span><span className="aura-label"><strong>{a.name.replace(/ Aura$/,'')}</strong><small>{a.addresses.find(x => x.domain_status === 'active')?.address || 'No receiving address'}</small></span><span className="aura-count">{a.thread_count}</span>
      </button>)}</nav>
      <div className="sidebar-footer"><span className="live-dot"/><div><strong>Connected to Cloudflare</strong><small>New mail refreshes automatically</small></div></div>
      <div className="test-note">Test workspace · Public access<br/>Use test messages only.</div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumb">Workspace <Icon name="arrow" size={12}/> Inbox <Icon name="arrow" size={12}/><strong>{aura?.name || 'Auras'}</strong></div><div className="topbar-right"><span className="read-only"><span/>Read-only</span><span className="profile">34</span></div></header>
      <div className="page-heading"><div><div className="eyebrow">A SPACE FOR EVERY CONVERSATION</div><h1>{aura?.name.replace(/ Aura$/,'') || 'Your'} inbox<span className="heading-dot">.</span></h1><p>{liveAddress ? <><span className="live-dot"/>Receiving at <span className="mail-address">{liveAddress}</span></> : 'Select an Aura to explore its conversations.'}</p></div><button className="refresh-button" onClick={() => setRefreshKey(n => n+1)}><Icon name="refresh" size={16}/>Refresh</button></div>
      <div className="inbox-layout">
        <section className="thread-panel" aria-label="Conversations">
          <div className="list-toolbar"><h2>Conversations <span>{threads.length}</span></h2><select aria-label="Filter conversation status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All mail</option><option value="open">Open</option><option value="closed">Closed</option><option value="archived">Archived</option></select></div>
          <div className="search"><Icon name="search" size={17}/><input aria-label="Search conversations" placeholder="Search subject or sender" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label="Clear search" onClick={() => setSearch('')}>×</button>}</div>
          <div className="thread-list">{error && <div className="error-box" role="alert">{error}<button onClick={() => setRefreshKey(n => n+1)}>Try again</button></div>}
            {loading && <div className="list-empty">Loading conversations…</div>}
            {!loading && !error && threads.length === 0 && <div className="list-empty"><Icon name="inbox" size={30}/><strong>{query ? 'No matching conversations' : 'Your inbox is ready'}</strong><p>{query ? 'Try another subject or sender.' : 'Incoming messages for this Aura will appear here.'}</p></div>}
            {threads.map(t => <button key={t.id} className={`thread-item ${t.id === threadId ? 'selected' : ''}`} onClick={() => setThreadId(t.id)}><div className="thread-top"><strong>{t.sender || aura?.name || 'Conversation'}</strong><time dateTime={t.last_activity_at}>{date(t.last_activity_at)}</time></div><h3>{t.subject || '(No subject)'}</h3><p>{t.preview || 'Open to view this conversation.'}</p><div className="thread-bottom"><span className={`status-tag ${t.inbox_status}`}>{t.inbox_status}</span><span>{t.message_count} {t.message_count === 1 ? 'message' : 'messages'}</span></div></button>)}
            {threadCursor && <button className="load-more" disabled={moreBusy} onClick={moreThreads}>{moreBusy ? 'Loading…' : 'Load more conversations'}</button>}
          </div><div className="sync-line"><span className={`live-dot ${error ? 'offline' : ''}`}/>{error ? 'Connection needs attention' : synced ? `Updated ${synced.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}` : 'Connecting…'}<span>Auto-refresh · 5s</span></div>
        </section>
        <section className="conversation-panel" aria-label="Message view">
          {!threadId ? <div className="conversation-empty"><div className="mail-art"><div className="art-circle"/><Icon name="mail" size={42}/><span className="art-star">✦</span><span className="art-spark">+</span></div><span className="empty-eyebrow">LESS NOISE. MORE CONTEXT.</span><h2>A little space to focus.</h2><p>Select a conversation to read its messages.<br/>Each Aura keeps its own inbox, right here.</p><div className="empty-footer"><Icon name="check" size={14}/>Your conversations stay with their Aura</div></div>
            : <><div className="conversation-header"><button className="back-button" aria-label="Back to conversations" onClick={() => setThreadId('')}><Icon name="back"/></button><div><div className="conversation-eyebrow">{aura?.name}</div><h2>{threadDetail?.subject || (loadingMessages ? 'Loading conversation…' : '(No subject)')}</h2></div>{threadDetail && <span className={`status-tag ${threadDetail.inbox_status}`}>{threadDetail.inbox_status}</span>}</div><div className="message-list">{messageError && <div className="error-box" role="alert">{messageError}<button onClick={() => setRefreshKey(n => n+1)}>Try again</button></div>}{loadingMessages && <div className="list-empty">Loading messages…</div>}{messageCursor && <button className="load-more" onClick={moreMessages}>Load earlier messages</button>}{messages.map(m => <MessageCard key={m.id} message={m} auraId={auraId}/>)}</div><div className="conversation-footer"><Icon name="inbox" size={15}/>You are viewing this conversation in read-only mode.</div></>}
        </section>
      </div>
    </main>
  </div>;
}
