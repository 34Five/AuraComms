import { useEffect, useState } from 'react';

type Role='admin'|'manager'|'reviewer';
type User={id:string;name:string;email:string|null;role:Role|null;status:'active'|'suspended'|'unconfigured';version:number};
type Event={id:string;actor_member_id:string;target_member_id:string;action:string;created_at:string};
type Data={users:User[];member_id:string;events:Event[]};
type Requester=(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
const ROLES:Role[]=['admin','manager','reviewer'];
const roleName=(role:Role|null)=>role?role[0].toUpperCase()+role.slice(1):'No access';
export function UserManagement({request,readOnly=false}:{request:Requester;readOnly?:boolean}) {
  const [data,setData]=useState<Data|null>(null),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[secret,setSecret]=useState('');
  const [search,setSearch]=useState(''),[roleFilter,setRoleFilter]=useState(''),[statusFilter,setStatusFilter]=useState('');
  const [editing,setEditing]=useState<User|null>(null),[creating,setCreating]=useState(false),[resetting,setResetting]=useState<User|null>(null);
  const [name,setName]=useState(''),[email,setEmail]=useState(''),[role,setRole]=useState<Role>('reviewer'),[status,setStatus]=useState('active');
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);
    void request('/manage/users','GET',undefined,controller.signal).then(d=>{if(!controller.signal.aborted){setData(d);}})
      .catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[request,revision]);
  function edit(user?:User){setEditing(user??null);setCreating(!user);setName(user?.name??'');setEmail(user?.email??'');setRole(user?.role??'reviewer');setStatus(user?.status==='suspended'?'suspended':'active');setError('');setResetting(null);}
  async function change(path:string,method:string,body:unknown){
    setBusy(true);setError('');setNotice('');
    try{const result=await request('/manage/users'+path,method,body);setSecret(result.credential??'');setNotice(result.message);setEditing(null);setCreating(false);setResetting(null);setRevision(n=>n+1);}
    catch(e){setError((e as Error).message);setRevision(n=>n+1);}finally{setBusy(false);}
  }
  const users=data?.users??[],self=editing?.id===data?.member_id;
  const filtered=users.filter(u=>(!roleFilter||u.role===roleFilter)&&(!statusFilter||u.status===statusFilter)&&`${u.name} ${u.email??''} ${u.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="user-management" aria-label="User management">
    <div className="directory-heading"><div><h2>People in your workspace</h2><p>{readOnly?'Demo users have fixed roles and permissions.':'Add users, set their roles, and control access.'}</p></div>{!readOnly&&<button className="primary-button" disabled={loading||busy||!!secret} onClick={()=>edit()}>Add user</button>}</div>
    <div className="user-role-cards">{ROLES.map(r=><article key={r}><span className="management-eyebrow">{users.filter(u=>u.role===r&&u.status==='active').length} active</span><h3>{roleName(r)}</h3><p>{r==='admin'?'View users. Configure Auras, domains, and policies.':r==='manager'?'Configure Auras, domains, and policies. Review for assigned Auras.':'Review, approve, reject, and send for assigned Auras.'}</p></article>)}</div>
    {error&&<div className="error-box" role="alert">{error}<button className="text-button" onClick={()=>{setError('');setRevision(n=>n+1);}}>Reload users</button></div>}
    {notice&&<p className="governance-notice" role="status">{notice}</p>}
    {secret&&<article className="governance-card credential-card"><h3>Copy this user’s credential</h3><p>This credential appears only once. Share it through your approved private channel.</p><label>Workspace credential<textarea rows={3} readOnly autoComplete="off" value={secret}/></label><div className="review-actions"><button className="secondary-button" onClick={async()=>{try{await navigator.clipboard.writeText(secret);setNotice('Credential copied.');}catch{setError('Copy the credential from the field above.');}}}>Copy credential</button><button className="primary-button" onClick={()=>setSecret('')}>I have saved it</button></div></article>}
    {(creating||editing)&&<form className="governance-card user-editor" onSubmit={e=>{e.preventDefault();void change(editing?`/${editing.id}`:'',editing?'PUT':'POST',{name,email,role,...(editing?{status,version:editing.version}:{})});}}>
      <h3>{editing?'Edit user':'Add a user'}</h3><div className="user-form-grid"><label>Full name<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)} /></label><label>Email address<input type="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} /></label><label>Workspace role<select value={role} disabled={self} onChange={e=>setRole(e.target.value as Role)}>{ROLES.map(r=><option key={r} value={r}>{roleName(r)}</option>)}</select></label>{editing&&<label>Access status<select value={status} disabled={self} onChange={e=>setStatus(e.target.value)}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>}</div>
      {self&&<p>Another administrator must change your role or suspend your access.</p>}
      {status==='suspended'&&<p>Suspension revokes credentials and invalidates unsent approvals. Email and decision history stay available.</p>}
      {editing?.status==='suspended'&&status==='active'&&<p>After saving, issue a new credential. Previous credentials stay revoked.</p>}
      {creating&&<p>The user receives access when you share their credential. No invitation email is sent.</p>}
      <div className="review-actions"><button className="primary-button" disabled={busy||loading}>{busy?'Saving…':editing?'Save user':'Add user and create credential'}</button><button className="secondary-button" type="button" disabled={busy} onClick={()=>{setEditing(null);setCreating(false);}}>Cancel</button></div>
    </form>}
    <div className="user-filters"><label>Search users<input type="search" placeholder="Search name or email" value={search} onChange={e=>setSearch(e.target.value)}/></label><label>Role<select value={roleFilter} onChange={e=>setRoleFilter(e.target.value)}><option value="">All roles</option>{ROLES.map(r=><option key={r} value={r}>{roleName(r)}</option>)}</select></label><label>Status<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="unconfigured">No access configured</option></select></label></div>
    <div className="user-table-wrap"><table className="user-table"><caption>{loading?'Loading users…':`${filtered.length} of ${users.length} workspace users`}</caption><thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Status</th>{!readOnly&&<th scope="col">Actions</th>}</tr></thead><tbody>{filtered.map(u=><tr key={u.id}><td><strong>{u.name}{u.id===data?.member_id&&<span className="user-you">You</span>}</strong><small>{u.email??u.id}</small></td><td>{roleName(u.role)}</td><td><span className={`status-tag ${u.status==='active'?'':'archived'}`}>{u.status==='unconfigured'?'No access':u.status}</span></td>{!readOnly&&<td><div className="user-row-actions"><button className="secondary-button" disabled={busy||loading||!!secret} onClick={()=>edit(u)}>{u.status==='unconfigured'?'Grant access':'Edit'}</button>{u.id!==data?.member_id&&u.status==='active'&&u.version>0&&<button className="text-button" disabled={busy||loading||!!secret} onClick={()=>setResetting(u)}>Reset credential</button>}</div></td>}</tr>)}</tbody></table>{!loading&&!filtered.length&&<p className="list-empty">No users match these filters.</p>}</div>
    {resetting&&<article className="governance-card credential-card"><h3>Reset credential for {resetting.name}?</h3><p>Their current credential will stop working immediately. You must share the new credential with this user.</p><div className="review-actions"><button className="primary-button" disabled={busy||loading} onClick={()=>change(`/${resetting.id}/credential`,'POST',{version:resetting.version})}>Confirm credential reset</button><button className="secondary-button" disabled={busy} onClick={()=>setResetting(null)}>Cancel</button></div></article>}
    <details className="governance-card user-audit"><summary>Recent access changes</summary>{data?.events.length?data.events.map(event=><div key={event.id} className="configuration-row"><div><strong>{users.find(u=>u.id===event.target_member_id)?.name??event.target_member_id}</strong><p>{event.action==='created'?'User added':event.action==='updated'?'User updated':'Credential reset'} · by {users.find(u=>u.id===event.actor_member_id)?.name??event.actor_member_id}</p></div><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time></div>):<p>No access changes yet.</p>}</details>
  </section>;
}
