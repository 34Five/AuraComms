import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {RECIPIENT,SENDER,REJECTION_ADDRESS} from './worker.mjs';
const request = (method='POST',token='test') => new Request('https://example.test/send',{method,headers:{Authorization:`Bearer ${token}`}});
test('the configured address rejects without forwarding or replying',async()=>{
 let reason;
 await worker.email({to:REJECTION_ADDRESS,headers:new Headers({'Message-ID':'<fixture@test>'}),setReject:r=>reason=r,forward:()=>assert.fail(),reply:()=>assert.fail()});
 assert.match(reason,/controlled permanent rejection/);
});
test('unexpected recipients also reject',async()=>{
 let reason;
 await worker.email({to:'other@34five.studio',headers:new Headers(),setReject:r=>reason=r});
 assert.match(reason,/not configured/);
});
test('missing and incorrect credentials cannot send',async()=>{
 const EMAIL={send:()=>assert.fail('unauthorized send')};
 assert.equal((await worker.fetch(request(),{EMAIL})).status,401);
 assert.equal((await worker.fetch(request('POST','wrong'),{EMAIL,TEST_TOKEN:'test'})).status,401);
});
test('GET cannot send',async()=>{
 assert.equal((await worker.fetch(request('GET'),{TEST_TOKEN:'test',EMAIL:{send:()=>assert.fail()}})).status,405);
});
test('sends only to the fixed recipient',async()=>{
 let sent;
 const response=await worker.fetch(request(),{TEST_TOKEN:'test',EMAIL:{send:async payload=>{sent=payload;return {messageId:'fixture'};}}});
 assert.equal(response.status,202);
 assert.equal(sent.to,RECIPIENT);
 assert.equal(sent.from,SENDER);
});
test('suppression errors remain visible',async()=>{
 const response=await worker.fetch(request(),{TEST_TOKEN:'test',EMAIL:{send:async()=>{throw Object.assign(new Error('Suppressed'),{code:'E_RECIPIENT_SUPPRESSED'});}}});
 assert.equal(response.status,502);
 assert.equal((await response.json()).code,'E_RECIPIENT_SUPPRESSED');
});
test('manual test cannot redirect to a caller-supplied recipient',async()=>{
 let sent;
 const response=await worker.fetch(new Request('https://example.test/send-manual',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({to:'someone@example.com'})}),{TEST_TOKEN:'test',MANUAL_TEST_RECIPIENT:'manual@example.test',EMAIL:{send:async payload=>{sent=payload;return {messageId:'fixture'};}}});
 assert.equal(response.status,202);assert.equal(sent.to,'manual@example.test');
});
test('manual test requires authorization',async()=>{
 const response=await worker.fetch(new Request('https://example.test/send-manual',{method:'POST'}),{TEST_TOKEN:'test',EMAIL:{send:()=>assert.fail()}});
 assert.equal(response.status,401);
});

test('manual tests fail closed without an operator-configured recipient',async()=>{
 const response=await worker.fetch(new Request('https://example.test/send-manual',{method:'POST',headers:{Authorization:'Bearer test'}}),{TEST_TOKEN:'test',EMAIL:{send:()=>assert.fail()}});
 assert.equal(response.status,400);
});
