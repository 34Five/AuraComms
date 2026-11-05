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
 const send=calls.find(c=>c.url.endsWith('/email/sending/send'));assert.equal(send.body.from.email,'megan@demo.34five.studio');assert.match(send.body.headers['In-Reply-To'],/new@example.invalid/);assert.match(send.body.headers['Message-ID'],/@demo.34five.studio>/);
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
