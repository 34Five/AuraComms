import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,ORG,email} from './harness.mjs';
import worker from '../worker/index.ts';
import {Governance} from '../worker/governance.ts';

function world(t){
 const x=setup(t);Object.assign(x.env,{GOVERNANCE_ADMIN_TOKEN:'admin',GOVERNANCE_REVIEWER_MEMBER_ID:'e07_demo_reviewer',CLOUDFLARE_DOMAIN_API_TOKEN:'cf-secret',DEFAULT_EMAIL_ZONE_ID:'zone',CLOUDFLARE_ACCOUNT_ID:'account',AUTO_REPLY_ENABLED:'true',AUTO_REPLY_MODE:'llm',GEMINI_API_KEY:'gemini-secret',DEFAULT_LLM_MODEL:'gemini:test'});
 const call=(path,method='GET',body,headers={})=>x.request('/api/manage'+path,{method,headers:{Authorization:'Bearer admin',Origin:'https://inbox.example','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...x,call};
}
function transport(t,{conflict=false,denied=false}={}){
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init={})=>{
  url=String(url);const body=init.body?JSON.parse(init.body):null;calls.push({url,body,init});
  if(url.includes('generativelanguage'))return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'Hello from your new Aura.'}]}}]});
  if(url.endsWith('/email/sending/send'))return Response.json({success:true,result:{delivered:body.to,queued:[],permanent_bounces:[]}});
  if(denied)return Response.json({success:false,errors:[{code:10000,message:'secret-should-not-leak'}]},{status:403});
  if((init.method??'GET')==='GET')return Response.json({success:true,result:conflict?[{id:'existing',enabled:true,matchers:[{type:'literal',field:'to',value:'megan@demo.34five.studio'}],actions:[{type:'worker',value:['other-worker']}]}]:[]});
  return Response.json({success:true,result:{id:'new-rule'}});
 });return calls;
}
async function megan(x,tier='4'){
 const response=await x.call('/auras','POST',{name:'Megan',tier});assert.equal(response.status,201);return (await response.json()).aura.id;
}
async function generate(x,id){return x.call(`/auras/${id}/address`,'POST',{});}

test('Studio generates, assigns and routes an address with existing domain credentials; retry is idempotent',async t=>{
 const x=world(t),calls=transport(t),id=await megan(x);
 assert.equal((await x.call(`/auras/${id}/address/proposal`)).status,200);
 const response=await generate(x,id);assert.equal(response.status,201);const result=await response.json();
 assert.equal(result.address.address,'megan@demo.34five.studio');assert.equal(result.address.provisioning.status,'active');
 assert.equal(calls.find(c=>c.body?.actions)?.body.actions[0].value[0],'aura-inbox-test');
 assert.equal((await generate(x,id)).status,200);assert.equal(x.sql.prepare('SELECT count(*) n FROM email_address_assignments WHERE aura_id=?').get(id).n,1);
 assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('pending address can be repaired; foreign rules and provider failures are visible without leaking secrets',async t=>{
 const x=world(t),id=await megan(x);delete x.env.CLOUDFLARE_DOMAIN_API_TOKEN;
 assert.equal((await (await generate(x,id)).json()).address.provisioning.status,'provisioning_pending');
 x.env.CLOUDFLARE_DOMAIN_API_TOKEN='cf-secret';transport(t,{conflict:true});
 let result=await (await x.call(`/auras/${id}/address/provision`,'POST',{})).json();assert.equal(result.address.provisioning.status,'failed');assert.match(result.address.provisioning.reason,/another Cloudflare rule/);
 t.mock.restoreAll();transport(t,{denied:true});result=await (await x.call(`/auras/${id}/address/provision`,'POST',{})).json();assert.equal(result.address.provisioning.status,'failed');assert.doesNotMatch(JSON.stringify(result),/secret-should-not-leak/);
 t.mock.restoreAll();transport(t);result=await (await x.call(`/auras/${id}/address/provision`,'POST',{})).json();assert.equal(result.address.provisioning.status,'active');
});

for(const tier of ['1','4'])test(`generated Tier ${tier} address receives mail, generates an LLM draft and respects approval`,async t=>{
 const x=world(t),calls=transport(t),id=await megan(x,tier);assert.equal((await generate(x,id)).status,201);
 const m=email('megan@demo.34five.studio');m.headers.set('Authentication-Results','mx.cloudflare.net; dmarc=pass');
 await worker.email(m,x.env);assert.equal(m.rejected,null);
 const draft=x.sql.prepare("SELECT * FROM email_messages WHERE aura_id=? AND direction='out'").get(id);assert.ok(draft);assert.equal(draft.body_text,'Hello from your new Aura.');
 let review=x.sql.prepare('SELECT * FROM email_reviews WHERE aura_id=? AND message_id=?').get(id,draft.id);
 if(tier==='1'){
  assert.equal(review.status,'pending');assert.equal(calls.filter(c=>c.url.endsWith('/email/sending/send')).length,0);
  const g=new Governance(x.env);await g.decide(id,review.id,'e07_demo_reviewer','approved');await g.dispatch(id,review.id);
 }
 const sent=x.sql.prepare('SELECT * FROM email_messages WHERE id=?').get(draft.id);assert.equal(sent.status,'sent');
 const send=calls.find(c=>c.url.endsWith('/email/sending/send'));assert.equal(send.body.from.email,'megan@demo.34five.studio');assert.match(send.body.headers['In-Reply-To'],/new@example.invalid/);assert.equal(send.body.headers['Message-ID'],undefined);assert.equal(send.body.reply_to,'megan@demo.34five.studio');assert.equal(send.body.replyTo,undefined);assert.equal(sent.rfc_message_id,null);
});

test('generation requires management authorization and same-origin JSON, and cannot cross tenants',async t=>{
 const x=world(t),id=await megan(x);transport(t);
 assert.equal((await x.call(`/auras/${id}/address`,'POST',{}, {Authorization:'Bearer wrong'})).status,401);
 assert.equal((await x.call(`/auras/${id}/address`,'POST',{}, {Origin:'https://evil.example'})).status,403);
 assert.equal((await x.call('/auras/other_aura/address','POST',{})).status,404);
 assert.equal((await x.call(`/auras/${id}/address`,'POST',{}, {'Content-Type':'text/plain'})).status,415);
});

test('inbox provisioning bridge only accepts its dedicated server secret',async t=>{
 const x=world(t),id=await megan(x);transport(t);await generate(x,id);x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';
 const request=token=>worker.fetch(new Request('https://inbox.example/internal/provision-address',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({aura_id:id})}),x.env);
 assert.equal((await request('wrong')).status,404);assert.equal((await request('bridge-secret')).status,200);
});

test('one Create operation provisions the chosen prefix and domain without a second setup action',async t=>{
 const x=world(t),calls=transport(t);
 const response=await x.call('/auras','POST',{name:'New colleague',role:'Assistant',tier:'1',generate_email:true,domain_id:'domain_default',local_part:'CUSTOM.prefix'});
 assert.equal(response.status,201);const data=await response.json();assert.equal(data.address.address,'custom.prefix@demo.34five.studio');assert.equal(data.address.provisioning.status,'active');assert.match(data.message,/Incoming mail is ready/);
 const assignment=x.sql.prepare('SELECT aura_id FROM email_address_assignments WHERE address_id=?').get(data.address.id);assert.equal(assignment.aura_id,data.aura.id);
 assert.equal(calls.filter(c=>c.init.method==='POST').length,1);
});

test('invalid, reserved, and unverified-domain addresses fail before creating an Aura',async t=>{
 const x=world(t);transport(t);
 const before=x.sql.prepare('SELECT count(*) n FROM auras').get().n;
 for(const local_part of ['a@b','two words','.leading','trailing.','two..dots','a'.repeat(65)]){
  const response=await x.call('/auras','POST',{name:'Invalid',generate_email:true,domain_id:'domain_default',local_part});assert.equal(response.status,400,local_part);
 }
 assert.equal((await x.call('/auras','POST',{name:'Taken',generate_email:true,domain_id:'domain_default',local_part:'sales'})).status,409);
 assert.equal((await x.call('/auras','POST',{name:'Wrong domain',generate_email:true,domain_id:'foreign',local_part:'valid'})).status,409);
 assert.equal(x.sql.prepare('SELECT count(*) n FROM auras').get().n,before);
});


test('reserved hand-routed names fail before creating Aura or address records',async t=>{
 const x=world(t),calls=transport(t),auras=x.sql.prepare('SELECT count(*) n FROM auras').get().n,addresses=x.sql.prepare('SELECT count(*) n FROM email_addresses').get().n;
 for(const local_part of ['anthony','melina','merlin','spike-test','operations','notifications-test','postmaster','abuse','admin']){
  const response=await x.call('/auras','POST',{name:'Reserved',generate_email:true,domain_id:'domain_default',local_part});assert.equal(response.status,409,local_part);
 }
 assert.equal(x.sql.prepare('SELECT count(*) n FROM auras').get().n,auras);assert.equal(x.sql.prepare('SELECT count(*) n FROM email_addresses').get().n,addresses);assert.equal(calls.length,0);
});

test('a reservation race returns 409 and cleans up the unassigned new Aura',async t=>{
 const x=world(t);transport(t);const batch=x.env.DB.batch,auras=x.sql.prepare('SELECT count(*) n FROM auras').get().n;
 let calls=0;x.env.DB.batch=async statements=>{calls++;if(calls===2)throw new Error('UNIQUE constraint failed: email_addresses.domain_id, email_addresses.local_part');return batch(statements);};
 const response=await x.call('/auras','POST',{name:'Race',generate_email:true,domain_id:'domain_default',local_part:'race-check'});
 assert.equal(response.status,409);assert.match((await response.json()).error,/already reserved/);assert.equal(x.sql.prepare('SELECT count(*) n FROM auras').get().n,auras);
});

test('an existing address rejects a different requested prefix or domain',async t=>{
 const x=world(t);transport(t);const id=await megan(x);await generate(x,id);
 for(const body of [{local_part:'another-prefix'},{domain_id:'another-domain'}])assert.equal((await x.call(`/auras/${id}/address`,'POST',body)).status,409);
});

test('fixed mode keeps existing demo replies fixed while generated addresses use LLM',async t=>{
 const x=world(t),calls=transport(t),id=await megan(x);x.env.AUTO_REPLY_MODE='fixed';await generate(x,id);
 const message=email('megan@demo.34five.studio');message.headers.set('Authentication-Results','mx.cloudflare.net; dmarc=pass');await worker.email(message,x.env);
 assert.ok(calls.some(c=>c.url.includes('generativelanguage')));assert.equal(x.sql.prepare("SELECT status FROM email_messages WHERE aura_id=? AND direction='out'").get(id).status,'sent');
});

test('a foreign same-worker rule is not adopted',async t=>{
 const x=world(t),id=await megan(x);
 t.mock.method(globalThis,'fetch',async()=>Response.json({success:true,result:[{name:'Foreign manual rule',id:'manual',enabled:true,matchers:[{type:'literal',field:'to',value:'megan@demo.34five.studio'}],actions:[{type:'worker',value:['aura-inbox-test']}]}]}));
 const result=await (await generate(x,id)).json();assert.equal(result.address.provisioning.status,'failed');
});

test('routing calls share a total deadline smaller than the coordinator reset',async t=>{
 const x=world(t),id=await megan(x),timeout=AbortSignal.timeout,limits=[];
 t.mock.method(AbortSignal,'timeout',ms=>{limits.push(ms);return ms===12000?AbortSignal.abort():timeout(ms);});
 t.mock.method(globalThis,'fetch',async(_url,init)=>{init.signal.throwIfAborted();throw Error('unreachable');});
 const result=await (await generate(x,id)).json();assert.equal(result.address.provisioning.status,'failed');assert.ok(limits.includes(12000));
});


test('internal retry handles unknown Aura and reserved address without rejecting the coordinator barrier',async t=>{
 const x=world(t);x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';
 const internal=id=>worker.fetch(new Request('https://inbox.example/internal/provision-address',{method:'POST',headers:{Authorization:'Bearer bridge-secret','Content-Type':'application/json'},body:JSON.stringify({aura_id:id})}),x.env);
 assert.equal((await internal('unknown_aura')).status,404);
 const id=await megan(x);x.sql.prepare('INSERT INTO email_addresses(id,org_id,domain_id,local_part,address,address_key) VALUES (?,?,?,?,?,?)').run('old_atlas',ORG,'domain_default','atlas','atlas@demo.34five.studio','atlas@demo.34five.studio');
 x.sql.prepare('INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES (?,?,?,?,?)').run('old_atlas_assignment',ORG,'old_atlas',id,new Date().toISOString());
 x.sql.prepare('INSERT INTO email_address_provisioning(org_id,address_id,status,worker_name,updated_at) VALUES (?,?,?,?,?)').run(ORG,'old_atlas','provisioning_pending','old-worker',new Date().toISOString());
 const response=await internal(id);assert.equal(response.status,409);assert.equal((await response.json()).reason,'manual_routing_required');
 assert.equal((await x.call('/domains')).status,200);
});

test('temporary persona IDs cannot generate addresses, even using a neutral prefix or renamed Aura',async t=>{
 const x=world(t);x.env.DEMO_ORG_ID='org_demo_001';const calls=transport(t);
 const {generateAddress,proposeAddress,retryProvisioning}=await import('../worker/address.ts');
 for(const id of ['aura_demo_001','aura_demo_002','aura_demo_003','aura_demo_004','aura_demo_merlin']){
  x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run(id,'org_demo_001','Renamed');
  await assert.rejects(generateAddress(new Request('https://inbox.example',{method:'POST',body:JSON.stringify({local_part:'neutral-prefix'})}),x.env,{id,name:'Renamed'}),{status:409});
  await assert.rejects(proposeAddress(x.env,{id,name:'Renamed'}),{status:409});
 }
 assert.equal(x.sql.prepare("SELECT count(*) n FROM email_address_assignments WHERE org_id='org_demo_001'").get().n,0);assert.equal(calls.length,0);
});

test('internal persona rejection is caught as 409 and leaves the coordinator usable',async t=>{
 const x=world(t);x.env.DEMO_ORG_ID='org_demo_001';x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';
 x.sql.exec("INSERT INTO auras(id,org_id,name) VALUES ('aura_demo_003','org_demo_001','Renamed'); INSERT INTO email_domains(id,org_id,domain,domain_key,kind,status,verified_at,activated_at) VALUES ('persona_domain','org_demo_001','persona.example.com','persona.example.com','custom','active','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'); INSERT INTO email_addresses(id,org_id,domain_id,local_part,address,address_key) VALUES ('persona_address','org_demo_001','persona_domain','neutral','neutral@persona.example.com','neutral@persona.example.com'); INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES ('persona_assignment','org_demo_001','persona_address','aura_demo_003','2026-11-01T00:00:00.000Z'); INSERT INTO email_address_provisioning(org_id,address_id,status,worker_name,updated_at) VALUES ('org_demo_001','persona_address','provisioning_pending','old-worker','2026-11-01T00:00:00.000Z');");
 const request=id=>worker.fetch(new Request('https://inbox.example/internal/provision-address',{method:'POST',headers:{Authorization:'Bearer bridge-secret','Content-Type':'application/json'},body:JSON.stringify({aura_id:id})}),x.env);
 const response=await request('aura_demo_003');assert.equal(response.status,409);assert.match((await response.json()).error,/client-provided configuration/);assert.equal((await request('unknown')).status,404);
});
