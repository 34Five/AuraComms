import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,ORG} from './harness.mjs';

test('inbox delegates pending setup to the Studio service and shows its actual routing result',async t=>{
 const x=setup(t);x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run('aura_megan',ORG,'Megan');
 let calls=0;
 x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';x.env.ADDRESS_PROVISIONER={async fetch(request){
  calls++;assert.equal(request.headers.get('authorization'),'Bearer bridge-secret');assert.equal((await request.json()).aura_id,'aura_megan');
  x.sql.prepare("UPDATE email_address_provisioning SET status='active',worker_name='aura-inbox-test',cloudflare_rule_id='rule-megan' WHERE org_id=?").run(ORG);
  return Response.json({address:{}});
 }};
 const response=await x.request('/api/auras/aura_megan/address',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(response.status,201);assert.equal(calls,1);const data=await response.json();assert.equal(data.address.provisioning.status,'active');assert.equal(data.address.address,'megan@demo.34five.studio');
});

test('an unavailable provisioning service produces a visible retryable error without leaking its response',async t=>{
 const x=setup(t);x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run('aura_megan',ORG,'Megan');
 x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';x.env.ADDRESS_PROVISIONER={async fetch(){return new Response('secret upstream error',{status:503});}};
 const response=await x.request('/api/auras/aura_megan/address',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const data=await response.json();assert.equal(data.address.provisioning.status,'failed');assert.doesNotMatch(JSON.stringify(data),/secret upstream error/);
});
