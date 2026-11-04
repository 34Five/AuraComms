import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,ORG} from './harness.mjs';
import {DomainRegistry,normalizeDomain,tenantSlug} from '../worker/domain-registry.ts';
import {CloudflareDomainProvider} from '../worker/domain-provider.ts';
import {HttpError} from '../worker/types.ts';

const ZONE='a'.repeat(32),ACCOUNT='b'.repeat(32),TAG='c'.repeat(32);
const nameservers=domain=>[{type:'NS',name:domain,content:'alice.ns.cloudflare.com'},{type:'NS',name:domain,content:'bob.ns.cloudflare.com'}];
const authRecords=domain=>[
  {type:'TXT',name:`s._domainkey.${domain}`,content:'v=DKIM1; k=rsa; p=PUBLIC'},
  {type:'TXT',name:`cf-bounce.${domain}`,content:'v=spf1 include:_spf.mx.cloudflare.net ~all'},
  {type:'TXT',name:`_dmarc.${domain}`,content:'v=DMARC1; p=none;'},
  {type:'MX',name:`cf-bounce.${domain}`,content:'route1.mx.cloudflare.net',priority:10},
];
function provider(){
  return {calls:[],ready:false,reason:'Waiting for delegation.',error:null,
    async prepare(d){this.calls.push(['prepare',d.domain]);if(this.error)throw this.error;return {zoneId:ZONE,records:d.kind==='custom'?nameservers(d.domain):[],ready:false,reason:this.reason};},
    async check(d){this.calls.push(['check',d.domain]);if(this.error)throw this.error;return {zoneId:ZONE,domainId:TAG,records:[...nameservers(d.domain),...authRecords(d.domain)],ready:this.ready,reason:this.ready?null:this.reason};},
  };
}
function registry(t){const x=setup(t),p=provider();return {...x,p,r:new DomainRegistry(x.env,p)};}
function managed(x){
  Object.assign(x.env,{GOVERNANCE_ADMIN_TOKEN:'test-secret',GOVERNANCE_REVIEWER_MEMBER_ID:'member_reviewer'});
  return (path,method='GET',body,extra={})=>x.request('/api/manage/domains'+path,{method,headers:{Authorization:'Bearer test-secret',Origin:'https://inbox.example','Content-Type':'application/json',...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}

test('domain names reject URLs, mailboxes, wildcards, IPs, invalid labels and unsafe lengths',()=>{
  assert.equal(normalizeDomain(' ACME.COM. '),'acme.com');
  for(const value of [null,'','https://acme.com','a@acme.com','*.acme.com','127.0.0.1','acme..com','a_.com','-acme.com','acme-.com','acme.com/path','éxample.com','a'.repeat(64)+'.com','a.com\nmalicious'])assert.throws(()=>normalizeDomain(value),{status:400});
  assert.equal(normalizeDomain('xn--xample-9ua.com'),'xn--xample-9ua.com');
  assert.equal(tenantSlug('  Axía & Co.  '),'axia-co');assert.equal(tenantSlug('A'.repeat(80)).length,63);
});

test('custom domains reserve once and walk through pending, verifying, active and failed without schema changes',async t=>{
  const x=registry(t),d=await x.r.addCustom(' Acme.com. ');
  assert.equal(d.status,'pending');assert.deepEqual(d.nameservers,['alice.ns.cloudflare.com','bob.ns.cloudflare.com']);
  assert.equal((await x.r.addCustom('ACME.COM')).id,d.id);assert.equal(x.p.calls.length,1);
  const checking=await x.r.check(d.id);assert.equal(checking.status,'verifying');assert.equal(checking.verified_at,null);
  x.p.ready=true;const active=await x.r.check(d.id);assert.equal(active.status,'active');assert.ok(active.verified_at);assert.ok(active.activated_at);
  assert.equal((await x.r.list(true)).some(v=>v.id===d.id),true);
  const firstActivated=active.activated_at;assert.equal((await x.r.check(d.id)).activated_at,firstActivated);
  x.p.error=new HttpError(502,'Cloudflare permission denied.');const failed=await x.r.check(d.id);
  assert.equal(failed.status,'failed');assert.match(failed.failure_reason,/permission/);assert.ok(failed.records.length);
  assert.equal((await x.r.list(true)).some(v=>v.id===d.id),false);
  x.p.error=null;assert.equal((await x.r.check(d.id)).status,'active');
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('unknown provider errors never expose secrets, and interrupted setup reconciles the existing row',async t=>{
  const x=registry(t);x.p.error=new Error('Bearer secret-leak');
  const failed=await x.r.addCustom('retry.com');assert.equal(failed.status,'failed');assert.doesNotMatch(failed.failure_reason,/secret-leak/);
  x.p.error=null;x.p.ready=true;
  assert.equal((await x.r.check(failed.id)).status,'active');assert.equal(x.sql.prepare("SELECT count(*) n FROM email_domains WHERE domain_key='retry.com'").get().n,1);
});

test('tenant scope hides other domains and atomically rejects parent/child reservations in both orders',async t=>{
  const x=registry(t),other=new DomainRegistry({...x.env,DEMO_ORG_ID:'other_org'},x.p);
  const d=await x.r.addCustom('private.com');assert.equal((await other.list()).length,0);
  for(const operation of [()=>other.get(d.id),()=>other.check(d.id),()=>other.remove(d.id)])await assert.rejects(operation(),{status:404});
  for(const domain of ['private.com','mail.private.com'])await assert.rejects(other.addCustom(domain),{status:409});
  await other.addCustom('sub.parent.com');await assert.rejects(x.r.addCustom('parent.com'),{status:409});
  assert.equal(x.p.calls.length,2);
  for(const domain of ['34five.studio','foo.34five.studio','studio'])await assert.rejects(x.r.addCustom(domain),{status:400});
});

test('default subdomains use readable slugs, stable org collision fallback and stay inactive until ready',async t=>{
  const x=registry(t),other=new DomainRegistry({...x.env,DEMO_ORG_ID:'other_org'},x.p);
  x.sql.exec("DELETE FROM email_domains WHERE kind='default_subdomain' AND org_id='other_org'");
  const first=await other.ensureDefault('Acme');assert.equal(first.domain,'acme.34five.studio');assert.notEqual(first.status,'active');
  // Remove only the unused seeded default to model another new tenant.
  const another=new DomainRegistry({...x.env,DEMO_ORG_ID:'new_org'},x.p);
  const second=await another.ensureDefault('Acme');assert.match(second.domain,/^acme-new-org-[a-f0-9]{12}\.34five\.studio$/);
  assert.equal((await another.ensureDefault('Renamed company')).id,second.id);
  assert.equal(x.sql.prepare("SELECT count(*) n FROM email_domains WHERE org_id='new_org'").get().n,1);
  x.p.ready=true;assert.equal((await another.check(second.id)).status,'active');
  await assert.rejects(another.remove(second.id),{status:409});
});

test('concurrent same-tenant registration reserves one domain and one provider preparation',async t=>{
  const x=registry(t);const results=await Promise.all([x.r.addCustom('race.com'),x.r.addCustom('RACE.COM')]);
  assert.equal(results[0].id,results[1].id);assert.equal(x.p.calls.length,1);
  const other=new DomainRegistry({...x.env,DEMO_ORG_ID:'other_org'},x.p);
  const results2=await Promise.allSettled([x.r.addCustom('parallel.com'),other.addCustom('mail.parallel.com')]);
  assert.equal(results2.filter(r=>r.status==='fulfilled').length,1);
});

test('removal refuses active addresses, lists their Aura, and preserves disabled address and message history',async t=>{
  const x=registry(t);
  const added=await x.r.addCustom('remove.com');x.p.ready=true;await x.r.check(added.id);
  x.sql.prepare("INSERT INTO email_addresses(id,org_id,domain_id,local_part,address,address_key) VALUES ('custom_address',?,?, 'a','a@remove.com','a@remove.com')").run(ORG,added.id);
  x.sql.prepare("INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES ('custom_assignment',?,'custom_address','e07_demo_aura_sales','2026-10-20T00:00:00.000Z')").run(ORG);
  await assert.rejects(x.r.remove(added.id),e=>e.status===409&&e.message.includes('a@remove.com')&&e.message.includes('Sales'));
  const before=x.sql.prepare('SELECT count(*) n FROM email_messages').get().n;
  x.sql.exec("UPDATE email_addresses SET status='disabled',disabled_at='2026-11-04T00:00:00.000Z' WHERE id='custom_address'");
  assert.equal((await x.r.remove(added.id)).status,'disabled');
  assert.equal(x.sql.prepare('SELECT count(*) n FROM email_messages').get().n,before);
  assert.ok(x.sql.prepare("SELECT id FROM email_addresses WHERE id='custom_address'").get());
  assert.ok(x.sql.prepare("SELECT id FROM email_address_assignments WHERE id='custom_assignment'").get());
  await assert.rejects(x.r.check(added.id),{status:409});await assert.rejects(x.r.addCustom('remove.com'),{status:409});
  managed(x);x.sql.prepare("INSERT OR IGNORE INTO studio_members(org_id,member_id,role) VALUES (?,?,'admin')").run(ORG,'member_reviewer');
  const reenable=await x.request('/api/manage/auras/e07_demo_aura_sales/addresses/custom_address',{method:'PUT',headers:{Authorization:'Bearer test-secret',Origin:'https://inbox.example','Content-Type':'application/json'},body:JSON.stringify({status:'active'})});
  assert.equal(reenable.status,409);assert.equal(x.sql.prepare("SELECT status FROM email_addresses WHERE id='custom_address'").get().status,'disabled');
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('management endpoints require authorization and same-origin mutations without trusting a body tenant',async t=>{
  const x=setup(t),call=managed(x);
  // The seeded reviewer belongs to this workspace.
  x.sql.prepare("INSERT OR IGNORE INTO studio_members(org_id,member_id,role) VALUES (?,?,'admin')").run(ORG,'member_reviewer');
  assert.equal((await call('')).status,200);
  assert.equal((await call('','POST',{domain:'api.com',org_id:'other_org'})).status,201);
  const row=x.sql.prepare("SELECT * FROM email_domains WHERE domain_key='api.com'").get();
  assert.equal(row.org_id,ORG);assert.equal(row.status,'failed');assert.match(row.failure_reason,/not configured/);
  assert.equal((await call('','POST',{domain:'bad.com'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('','POST',{domain:'bad.com'},{Authorization:'Bearer wrong'})).status,401);
  assert.equal((await call('/other_id/check','POST',{})).status,404);
  assert.equal((await call(`/${row.id}`)).status,200);
  assert.equal((await call(`/${row.id}`,'DELETE')).status,200);
  assert.equal((await call(`/${row.id}/check`,'POST',{})).status,409);
});

function cloudflare(t,{domain='real.com',status='pending',existing=true,records=authRecords(domain),routingName=domain,zoneName=domain,sendingExists=true,routingEnabled=true,mxEnabled=true}={}){
  const x=setup(t),requests=[];
  Object.assign(x.env,{CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_DOMAIN_API_TOKEN:'server-secret',DEFAULT_EMAIL_ZONE_ID:ZONE});
  const zone={id:ZONE,account:{id:ACCOUNT},name:zoneName,type:'full',status,name_servers:['alice.ns.cloudflare.com','bob.ns.cloudflare.com']};
  let exists=existing;
  const transport=async(url,options={})=>{
    url=new URL(url);requests.push({url,method:options.method||'GET',body:options.body});
    if(url.hostname==='cloudflare-dns.com'){
      const type=url.searchParams.get('type'),name=url.searchParams.get('name');
      if(type==='MX' && name===domain)return Response.json({Status:0,Answer:mxEnabled?[{type:15,data:'10 route1.mx.cloudflare.net.'}]:[]});
      const record=records.find(r=>r.name===name&&r.type===type);
      return Response.json({Status:0,Answer:record?[{type:type==='TXT'?16:type==='MX'?15:5,data:type==='TXT'?`"${record.content}"`:type==='MX'?`${record.priority} ${record.content}.`:record.content}]:[]});
    }
    assert.equal(url.hostname,'api.cloudflare.com');assert.equal(options.headers.Authorization,'Bearer server-secret');
    let result;
    if(url.pathname==='/client/v4/zones'){
      if(options.method==='POST'){exists=true;result=zone;}else result=exists?[zone]:[];
    }else if(url.pathname===`/client/v4/zones/${ZONE}`)result=zone;
    else if(url.pathname.endsWith('/sending/subdomains'))result=options.method==='POST'?{name:domain,tag:TAG,enabled:true}:sendingExists?[{name:domain,tag:TAG,enabled:true}]:[];
    else if(url.pathname.endsWith('/sending/subdomains/'+TAG+'/dns'))result=records;
    else if(url.pathname.endsWith('/routing'))result={name:routingName,enabled:routingEnabled,status:routingEnabled?'ready':'unconfigured'};
    else if(url.pathname.endsWith('/routing/dns'))result={name:routingName,enabled:true,status:'ready'};
    else throw new Error('Unexpected provider request: '+url);
    return Response.json({success:true,result});
  };
  const p=new CloudflareDomainProvider(x.env,transport),r=new DomainRegistry(x.env,p);
  return {...x,r,p,requests,zone,transport};
}

test('real Cloudflare adapter creates a zone once, returns nameservers, and waits for delegation',async t=>{
  const x=cloudflare(t,{existing:false}),d=await x.r.addCustom('real.com');
  assert.equal(d.status,'pending');assert.equal(x.requests.filter(r=>r.method==='POST').length,1);
  assert.equal((await x.r.check(d.id)).status,'pending');assert.equal(x.requests.filter(r=>r.url.pathname.includes('/email/')).length,0);
  assert.equal(x.requests.filter(r=>r.method==='POST').length,1);
});

test('adapter activates only with correct zone, routing and complete publicly verified authentication',async t=>{
  const x=cloudflare(t,{status:'active'}),d=await x.r.addCustom('real.com');
  const active=await x.r.check(d.id);assert.equal(active.status,'active');assert.ok(active.records.some(r=>r.name.includes('._domainkey.')));
  assert.equal(x.requests.filter(r=>r.method==='POST').length,0,'existing sending identity is reused');
  x.zone.account.id='f'.repeat(32);const failed=await x.r.check(d.id);assert.equal(failed.status,'failed');assert.match(failed.failure_reason,/does not match/);
});

test('incomplete provider authentication and DNS mismatch never activate a domain',async t=>{
  const x=cloudflare(t,{status:'active',records:authRecords('real.com').filter(r=>!r.name.includes('_domainkey'))});
  const d=await x.r.addCustom('real.com');assert.equal((await x.r.check(d.id)).status,'failed');
  const y=cloudflare(t,{status:'active'}),a=await y.r.addCustom('real.com');
  const wrongResolver=async(url,options)=>new URL(url).hostname==='cloudflare-dns.com'?Response.json({Status:0,Answer:[]}):y.transport(url,options);
  const r=new DomainRegistry(y.env,new CloudflareDomainProvider(y.env,wrongResolver));
  assert.equal((await r.check(a.id)).status,'verifying');
});

test('provider errors redact raw text and report the operation and status',async t=>{
  const x=setup(t);Object.assign(x.env,{CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_DOMAIN_API_TOKEN:'server-secret'});
  const p=new CloudflareDomainProvider(x.env,async()=>Response.json({success:false,errors:[{code:10000,message:'server-secret leak'}]},{status:403}));
  const d=await new DomainRegistry(x.env,p).addCustom('blocked.com');
  assert.equal(d.status,'failed');assert.match(d.failure_reason,/HTTP 403, code 10000/);assert.doesNotMatch(d.failure_reason,/server-secret/);
});


test('adapter onboards a new sending identity and routing via provider APIs only',async t=>{
  const x=cloudflare(t,{status:'active',sendingExists:false,routingEnabled:false}),d=await x.r.addCustom('real.com');
  assert.equal((await x.r.check(d.id)).status,'active');
  assert.deepEqual(x.requests.filter(r=>r.method==='POST').map(r=>r.url.pathname),[
    `/client/v4/zones/${ZONE}/email/sending/subdomains`, `/client/v4/zones/${ZONE}/email/routing/dns`,
  ]);
  assert.deepEqual(JSON.parse(x.requests.find(r=>r.method==='POST').body),{name:'real.com'});
  assert.equal(x.requests.some(r=>r.url.pathname.endsWith('/dns_records')),false);
});

test('default subdomain activates only with public routing MX and never mutates the parent routing DNS',async t=>{
  const x=cloudflare(t,{domain:'axia.34five.studio',zoneName:'34five.studio',routingName:'34five.studio',status:'active'});
  x.env.DEMO_ORG_ID='new_org';const r=new DomainRegistry(x.env,x.p),d=await r.ensureDefault('Axia');
  assert.equal(d.domain,'axia.34five.studio');assert.equal(d.status,'active');
  assert.equal(x.requests.filter(r=>r.method==='POST').length,0);
  const y=cloudflare(t,{domain:'pending.34five.studio',zoneName:'34five.studio',routingName:'34five.studio',status:'active',mxEnabled:false});
  y.env.DEMO_ORG_ID='new_org';const pending=await new DomainRegistry(y.env,y.p).ensureDefault('Pending');
  assert.equal(pending.status,'verifying');assert.match(pending.failure_reason,/Onboard this subdomain/);
  assert.ok(pending.records.length);assert.equal(y.requests.filter(r=>r.method==='POST').length,0);
});
