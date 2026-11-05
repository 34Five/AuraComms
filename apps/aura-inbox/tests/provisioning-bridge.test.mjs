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


for(const [label,handler] of [
 ['HTML asset response',async()=>new Response('<html>Old Worker</html>')],
 ['JSON success without D1 activation',async()=>Response.json({address:{provisioning:{status:'active'}}})],
 ['pending response',async()=>Response.json({address:{provisioning:{status:'provisioning_pending'}}})],
 ['network failure',async()=>{throw Error('private details');}],
])test(`delegation rejects ${label} and logs only sanitized context`,async t=>{
 const x=setup(t);x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run('aura_megan',ORG,'Megan');
 const logs=[];t.mock.method(console,'warn',line=>logs.push(JSON.parse(line)));
 x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';x.env.ADDRESS_PROVISIONER={fetch:handler};
 const response=await x.request('/api/auras/aura_megan/address',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const body=await response.json();assert.equal(body.address.provisioning.status,'failed');assert.equal(logs[0].event,'address_provision_delegate_failed');assert.equal(logs[0].aura_id,'aura_megan');assert.deepEqual(Object.keys(logs[0]).sort(),['aura_id','event','status']);assert.doesNotMatch(JSON.stringify(body),/private details/);
});

test('a delegate error cannot downgrade a concurrently activated address',async t=>{
 const x=setup(t);x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run('aura_megan',ORG,'Megan');
 x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';x.env.ADDRESS_PROVISIONER={async fetch(){x.sql.prepare("UPDATE email_address_provisioning SET status='active',cloudflare_rule_id='confirmed' WHERE org_id=?").run(ORG);throw Error('after activation');}};
 const response=await x.request('/api/auras/aura_megan/address',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal((await response.json()).address.provisioning.status,'active');
});

test('delegated fetch has a 15 second timeout',async t=>{
 const x=setup(t);x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run('aura_megan',ORG,'Megan');
 const timeout=AbortSignal.timeout,limits=[];t.mock.method(AbortSignal,'timeout',ms=>{limits.push(ms);return timeout(ms);});
 x.env.ADDRESS_PROVISIONING_SECRET='bridge-secret';x.env.ADDRESS_PROVISIONER={async fetch(request){assert.ok(request.signal instanceof AbortSignal);return new Response('unavailable',{status:503});}};
 await x.request('/api/auras/aura_megan/address',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.ok(limits.includes(15000));
});


test('new pending instructions use the configured server name and delegated failures replace stale errors',async t=>{
 const x=setup(t);x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run('aura_megan',ORG,'Megan');
 Object.assign(x.env,{ADDRESS_PROVISIONING_SECRET:'bridge-secret',ADDRESS_PROVISIONER_WORKER:'configured-studio'});
 x.env.ADDRESS_PROVISIONER={async fetch(){const row=x.sql.prepare('SELECT worker_name FROM email_address_provisioning WHERE org_id=?').get(ORG);assert.equal(row.worker_name,'configured-studio');x.sql.prepare("UPDATE email_address_provisioning SET failure_reason='stale error' WHERE org_id=?").run(ORG);return new Response('Unavailable',{status:503});}};
 const response=await x.request('/api/auras/aura_megan/address',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const body=await response.json();assert.equal(body.address.provisioning.status,'failed');assert.notEqual(body.address.provisioning.reason,'stale error');assert.equal(body.address.provisioning.rule.actions[0].value[0],'configured-studio');
});
