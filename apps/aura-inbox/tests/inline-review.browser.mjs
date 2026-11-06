// Run after npm run build. Install playwright externally or set PLAYWRIGHT_MODULE to its entry point.
// Uses an in-memory database and mocked transport; never contacts an email provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {setup} from './harness.mjs';
import worker from '../worker/index.ts';
import {DEMO_ORG,DEMO_ACCOUNTS,demoAccountSql} from '../scripts/demo-accounts.mjs';
import {SendError} from '../worker/generated-sender.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const cleanup=[],x=setup({after(fn){cleanup.push(fn);}}),aura='aura_demo_001';
x.sql.exec("INSERT INTO auras (id,org_id,name) VALUES ('aura_demo_001','org_demo_001','Orbi'),('aura_demo_002','org_demo_001','Daniel'); INSERT INTO studio_members (org_id,member_id,role) VALUES ('org_demo_001','member_demo_001','member')");
for(const name of ['provision-addresses','provision-governance'])x.sql.exec(readFileSync(new URL(`../scripts/${name}.sql`,import.meta.url),'utf8'));
x.sql.exec(await demoAccountSql());
Object.assign(x.env,{DEMO_ORG_ID:DEMO_ORG,DEMO_LOGIN_ENABLED:'true'});
const sent=[];let outcome='sent';
x.env.EMAIL={async send(message){sent.push(message);await new Promise(r=>setTimeout(r,120));if(outcome==='unknown')throw Error('mock timeout');if(outcome==='failed')throw new SendError('rejected',400,[10001]);return {messageId:`<mock-${sent.length}@example.invalid>`};}};
const dist=resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const server=createServer(async(req,res)=>{
  try{
    let response;
    if(req.url.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      const request=new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
      response=await worker.fetch(request,x.env);
    }else{
      const pathname=new URL(req.url,'http://local').pathname;
      const filename=resolve(dist,'.'+(pathname==='/'?'/index.html':pathname));
      if(!filename.startsWith(dist+sep))throw Error('Invalid asset');
      const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[extname(filename)]||'application/octet-stream';
      response=new Response(readFileSync(filename),{headers:{'Content-Type':type}});
    }
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const shots=resolve(process.env.SCREENSHOT_DIR||fileURLToPath(new URL('../../../docs/verification/axi-18/',import.meta.url)));
mkdirSync(shots,{recursive:true});
const shot=async name=>page.screenshot({path:resolve(shots,`${name}.png`),fullPage:true});
async function login(index=0){
  await page.goto(origin);await page.getByLabel('Email').fill(DEMO_ACCOUNTS[index].email);await page.getByLabel('Password',{exact:true}).fill(DEMO_ACCOUNTS[index].password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:/inbox$/}).waitFor();
}
async function api(path,body){
  const r=await page.request.post(origin+path,{headers:{Origin:origin},data:body});assert.ok(r.ok(),await r.text());return r.json();
}
const base=`/api/auras/${aura}`;
async function draft(text='A message to review in the inbox.'){
  const d=await api(`${base}/governance/compose`,{to:'recipient@example.invalid',subject:'Local inline review verification',text});
  await page.goto(`${origin}/?aura=${aura}&thread=${d.thread_id}`);await page.getByRole('heading',{name:'Needs review',exact:true}).waitFor();return d;
}
try{
  console.log('browser: login');await login();
  console.log('browser: first draft');let d=await draft();await shot('desktop-pending');
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).waitFor();assert.equal(sent.length,0);
  await page.getByRole('button',{name:'Edit draft',exact:true}).click();
  assert.equal(await page.getByLabel('Subject',{exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.getByLabel('Message',{exact:true}).fill('Edited content after approval.');
  await page.getByRole('button',{name:'Save and reevaluate policy',exact:true}).click();await page.getByRole('button',{name:'Approve',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Send email',exact:true}).count(),0);assert.equal(sent.length,0);
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).waitFor();await shot('desktop-approved');
  await page.getByRole('button',{name:'Send email',exact:true}).click();await page.getByRole('heading',{name:'Sent to provider',exact:true}).waitFor();assert.equal(sent.length,1);assert.equal(sent[0].text,'Edited content after approval.');
  await shot('desktop-sent');
  d=await draft(('Long message: '+ 'LongUnbrokenContent'.repeat(12)+'\n').repeat(35));
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Edit draft',exact:true}).click();
  await page.getByLabel('Message',{exact:true}).scrollIntoViewIfNeeded();await shot('mobile-long-editor');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'Save and reevaluate policy',exact:true}).scrollIntoViewIfNeeded();await shot('mobile-editor-actions');
  await page.getByRole('button',{name:'Close editor',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.textContent==='Edit draft');
  assert.equal(await page.getByRole('button',{name:'Edit draft',exact:true}).evaluate(el=>el===document.activeElement),true);
  // Keyboard approval followed by a separate keyboard Send action.
  await page.getByRole('button',{name:'Approve',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Send email',exact:true}).waitFor();assert.equal(sent.length,1);
  // Even a stale approved refresh must not reopen Send after an uncertain attempt.
  const unknownRoute='**/api/auras/*/threads/*/messages?limit=25';
  const approvedSnapshot=await (await page.request.get(`${origin}${base}/threads/${d.thread_id}/messages?limit=25`)).json();
  await page.route(unknownRoute,route=>route.fulfill({json:approvedSnapshot}));
  outcome='unknown';await page.getByRole('button',{name:'Send email',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByText('Provider outcome is unknown. Do not retry this message.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Send email',exact:true}).isDisabled(),true);
  await page.unroute(unknownRoute);await page.getByText('Send outcome unconfirmed',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Send email',exact:true}).count(),0);await page.getByText('Send outcome unconfirmed',{exact:true}).scrollIntoViewIfNeeded();await shot('mobile-unconfirmed');
  outcome='failed';await page.setViewportSize({width:1440,height:1000});d=await draft();
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).click();await page.getByText('Email not sent',{exact:true}).waitFor();await shot('desktop-failed');
  assert.equal(await page.getByRole('button',{name:'Send email',exact:true}).count(),0);
  outcome='sent';d=await draft();await page.getByRole('button',{name:'Reject',exact:true}).click();await page.getByRole('heading',{name:'Draft rejected',exact:true}).waitFor();
  await page.getByRole('button',{name:'Reevaluate policy',exact:true}).click();await page.getByRole('heading',{name:'Draft rejected',exact:true}).waitFor();assert.equal(sent.length,3);
  await page.getByRole('button',{name:'Cancel draft',exact:true}).click();await page.getByRole('button',{name:'Confirm cancellation',exact:true}).click();await page.getByRole('heading',{name:'Draft cancelled',exact:true}).waitFor();
  d=await draft();
  const refreshRoute='**/api/auras/*/threads/*/messages?limit=25';
  await page.route(refreshRoute,route=>route.abort('failed'));
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Refresh draft',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Approve',exact:true}).isDisabled(),true);await shot('desktop-refresh-error');
  await page.unroute(refreshRoute);await page.getByRole('button',{name:'Refresh draft',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).waitFor();
  assert.equal(sent.length,3);
  // Check stale editor preservation against a real server edit from another session.
  d=await draft();await page.getByRole('button',{name:'Edit draft',exact:true}).click();await page.getByLabel('Message',{exact:true}).fill('My unsaved changes');
  await api(`${base}/messages/${d.message_id}/edit`,{subject:'Concurrent edit',text:'Other reviewer update'});
  await page.getByText('This draft changed while you were editing.',{exact:false}).waitFor({timeout:10000});
  assert.equal(await page.getByLabel('Message',{exact:true}).inputValue(),'My unsaved changes');assert.equal(await page.getByRole('button',{name:'Save and reevaluate policy',exact:true}).isDisabled(),true);await shot('desktop-stale-edit');
  // Confirmation must stay bound to the version the reviewer chose to cancel.
  d=await draft();await page.getByRole('button',{name:'Cancel draft',exact:true}).click();
  const beforeCancel=(await (await page.request.get(`${origin}${base}/threads/${d.thread_id}/messages?limit=25`)).json()).messages[0];
  await api(`${base}/messages/${d.message_id}/edit`,{subject:'New revision while cancellation is open',text:'Keep this revised message'});
  await page.getByText('This draft changed after you opened cancellation.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Confirm cancellation',exact:true}).isDisabled(),true);
  assert.equal(x.sql.prepare('SELECT status FROM email_messages WHERE id=?').get(d.message_id).status,'draft');
  // A click arriving before the next poll is independently rejected by the server.
  const staleCancel=await page.request.post(`${origin}${base}/messages/${d.message_id}/cancel`,{headers:{Origin:origin},data:{expected_version:beforeCancel.draft_version}});
  assert.equal(staleCancel.status(),409);await shot('review-stale-cancellation');
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  await page.getByRole('button',{name:'Cancel draft',exact:true}).click();await page.getByRole('button',{name:'Confirm cancellation',exact:true}).click();await page.getByRole('heading',{name:'Draft cancelled',exact:true}).waitFor();
  // Real pre-dispatch 503: missing binding, not a provider timeout. Delay the
  // authoritative refresh to verify that the attempted version stays locked.
  d=await draft();await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).waitFor();
  const transport=x.env.EMAIL,beforeRecovery=sent.length;delete x.env.EMAIL;
  let releaseRefresh;const refreshGate=new Promise(resolve=>{releaseRefresh=resolve;});
  await page.route(refreshRoute,async route=>{await refreshGate;await route.continue();});
  await page.getByRole('button',{name:'Send email',exact:true}).click();
  await page.getByText('The email sender is not configured.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Send email',exact:true}).isDisabled(),true);
  releaseRefresh();await page.unroute(refreshRoute,{behavior:'wait'});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Send email'&&!b.disabled));
  assert.equal(sent.length,beforeRecovery);assert.equal(x.sql.prepare('SELECT status FROM email_messages WHERE id=?').get(d.message_id).status,'draft');
  await page.getByRole('button',{name:'Edit draft',exact:true}).click();await page.getByLabel('Message',{exact:true}).fill('Fresh approved revision after pre-dispatch 503');
  await page.getByRole('button',{name:'Save and reevaluate policy',exact:true}).click();await page.getByRole('button',{name:'Approve',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Send email'&&!b.disabled));
  x.env.EMAIL=transport;await shot('review-send-recovered');
  await page.getByRole('button',{name:'Send email',exact:true}).click();await page.getByRole('heading',{name:'Sent to provider',exact:true}).waitFor();
  assert.equal(sent.length,beforeRecovery+1);assert.equal(sent.at(-1).text,'Fresh approved revision after pre-dispatch 503');
  d=await draft();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await login(2);
  await page.goto(`${origin}/?aura=${aura}&thread=${d.thread_id}`);await page.getByRole('button',{name:'Approve',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Edit draft',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Cancel draft',exact:true}).count(),0);await shot('reviewer-permissions');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'passed',screenshots:shots,mockedProviderCalls:sent.length,checks:['edit invalidates approval','explicit Send','keyboard approval/send','narrow viewport','long editor','unknown send has no retry','failed send distinct','reject/cancel','stale editor preserves text','reviewer permissions','refresh failure disables actions until recovery','stale cancellation requires reconfirmation','pre-dispatch 503 recovers after authoritative refresh and fresh approval','uncertain send remains locked under stale approved refresh']},null,2));
}catch(error){console.error('Browser check failed:',error);await shot('failure');throw error;}finally{
  await browser.close();await new Promise(r=>server.close(r));for(const fn of cleanup)fn();
}
