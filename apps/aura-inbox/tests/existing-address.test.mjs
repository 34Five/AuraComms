import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,ORG} from './harness.mjs';
import {retryProvisioning} from '../worker/address.ts';

function legacy(t,prefix,status='provisioning_pending') {
 const x=setup(t),id='aura_legacy',address=`${prefix}@demo.34five.studio`;
 x.sql.prepare('INSERT INTO auras(id,org_id,name) VALUES (?,?,?)').run(id,ORG,'Existing Aura');
 x.sql.prepare('INSERT INTO email_addresses(id,org_id,domain_id,local_part,address,address_key) VALUES (?,?,?,?,?,?)').run('address_legacy',ORG,'domain_default',prefix,address,address);
 x.sql.prepare('INSERT INTO email_address_assignments(id,org_id,address_id,aura_id,assigned_at) VALUES (?,?,?,?,?)').run('assignment_legacy',ORG,'address_legacy',id,new Date().toISOString());
 x.sql.prepare('INSERT INTO email_address_provisioning(org_id,address_id,status,worker_name,cloudflare_rule_id,updated_at) VALUES (?,?,?,?,?,?)').run(ORG,'address_legacy',status,'previous-worker',status==='active'?'existing-rule':null,new Date().toISOString());
 const calls=[];t.mock.method(globalThis,'fetch',async()=>{calls.push('provider');throw Error('Provider unavailable');});
 Object.assign(x.env,{CF_API_TOKEN:'test-token',CF_ZONE_ID:'test-zone'});
 return {...x,id,address,calls};
}
for(const prefix of ['atlas','a+b','orbi']) {
 test(`active existing ${prefix} is preserved without revalidating or calling the provider`,async t=>{
  const x=legacy(t,prefix,'active'),response=await retryProvisioning(x.env,x.id);
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.address.address,x.address);assert.equal(body.address.provisioning.status,'active');assert.deepEqual(x.calls,[]);
 });
 test(`pending existing ${prefix} reports manual routing without asking for a new prefix`,async t=>{
  const x=legacy(t,prefix),response=await retryProvisioning(x.env,x.id);
  assert.equal(response.status,409);const body=await response.json();assert.equal(body.reason,'manual_routing_required');assert.match(body.error,/preserved.*manually/);assert.doesNotMatch(body.error,/Choose another prefix/);assert.equal(body.address.address,x.address);assert.deepEqual(x.calls,[]);
  assert.equal(x.sql.prepare('SELECT status FROM email_address_provisioning WHERE address_id=?').get('address_legacy').status,'provisioning_pending');
 });
}
test('retry cannot downgrade an active Megan address when Cloudflare is unavailable',async t=>{
 const x=legacy(t,'megan','active');const response=await retryProvisioning(x.env,x.id);assert.equal(response.status,200);assert.equal((await response.json()).address.provisioning.status,'active');assert.deepEqual(x.calls,[]);
});
