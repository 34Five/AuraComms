import {messageState} from '../frontend/src/message-state.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendGenerated,SendError,sendErrorDetail} from '../worker/generated-sender.ts';
const env={CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_DOMAIN_API_TOKEN:'private-test-token'};
const builder={from:{email:'sam@example.com',name:'Sam'},replyTo:'sam@example.com',subject:'Test',text:'Hello',headers:{'In-Reply-To':'<original@example.com>'}};

test('explicit provider permission rejection keeps safe codes and no raw secret text',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({success:false,errors:[{code:10102,message:'private-test-token private provider text'}]},{status:403,headers:{'cf-ray':'safe-ray-id'}}));
 await assert.rejects(sendGenerated(env,builder,{to:['recipient@example.com']}),e=>{assert.ok(e instanceof SendError);assert.equal(e.outcome,'rejected');assert.deepEqual(e.codes,[10102]);assert.equal(e.httpStatus,403);assert.doesNotMatch(JSON.stringify(sendErrorDetail(e)),/private/);return true;});
});

test('network failure, malformed success and partial acceptance stay unknown and cannot be retried automatically',async t=>{
 for(const response of [()=>{throw Error('private-test-token');},()=>new Response('<html>Error</html>',{status:502}),()=>Response.json({success:true,result:{delivered:[],queued:[]}})]){
  t.mock.method(globalThis,'fetch',response);await assert.rejects(sendGenerated(env,builder,{to:['recipient@example.com']}),e=>e instanceof SendError&&e.outcome==='unknown');t.mock.restoreAll();
 }
});

test('REST acceptance preserves the actual provider message ID and uses REST field names',async t=>{
 t.mock.method(globalThis,'fetch',async(_url,init)=>{const body=JSON.parse(init.body);assert.deepEqual(body.from,{address:'sam@example.com',name:'Sam'});assert.equal(body.from.email,undefined);assert.equal(body.reply_to,'sam@example.com');assert.equal(body.replyTo,undefined);assert.equal(body.headers['Message-ID'],undefined);return Response.json({success:true,result:{message_id:'<real@cloudflare.example>',delivered:['recipient@example.com'],queued:[]}});});
 assert.deepEqual(await sendGenerated(env,builder,{to:['recipient@example.com']}),{messageId:'<real@cloudflare.example>'});
});



test('REST named addresses use address instead of the Workers binding email property',async t=>{
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  const body=JSON.parse(init.body);
  // Reject the old binding-shaped payload just as the REST schema does.
  if(body.from.email||!body.from.address||body.reply_to.email||!body.reply_to.address)return Response.json({success:false,errors:[{code:10001}]},{status:400});
  return Response.json({success:true,result:{delivered:['recipient@example.com'],queued:[],message_id:'<accepted@example.com>'}});
 });
 assert.deepEqual(await sendGenerated(env,{...builder,replyTo:{email:'sam@example.com',name:'Sam'}},{to:['recipient@example.com']}),{messageId:'<accepted@example.com>'});
});

test('partial acceptance can never be treated as a safe complete rejection',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({success:false,errors:[{code:10001}],result:{delivered:['one@example.com'],queued:[]}},{status:400}));
 await assert.rejects(sendGenerated(env,builder,{to:['one@example.com','two@example.com']}),e=>e instanceof SendError&&e.outcome==='unknown');
});


test('inbox distinguishes provider rejection and unconfirmed dispatch from AI generation failure',()=>{
 const message={direction:'out',status:'sending',body_storage:'inline',body_text:'Draft text',body_html:null};
 assert.equal(messageState({...message,display_state:'send_unknown'}),'send_unknown');
 assert.equal(messageState({...message,status:'failed',display_state:'send_failed'}),'send_failed');
 assert.equal(messageState({...message,status:'sending',body_text:null}),'generating');
});
