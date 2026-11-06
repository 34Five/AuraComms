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
const shots=resolve(process.env.SCREENSHOT_DIR||fileURLToPath(new URL('../../../docs/verification/axi-18-history/',import.meta.url)));
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
  await login();let d=await draft();
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).waitFor();
  // Build a fixed multi-page recorded trail with equal timestamps. Retain the
  // original recorded human metadata and a current pending revision for actions.
  x.sql.prepare("UPDATE email_workspace_access SET display_name=? WHERE org_id=? AND member_id='member_demo_manager'").run('LongReviewerNameWithoutSpaces'.repeat(3),DEMO_ORG);
  x.sql.prepare("UPDATE email_reviews SET status='superseded',approver_member_id='member_demo_manager' WHERE message_id=?").run(d.message_id);
  const add=x.sql.prepare(`INSERT INTO email_reviews (id,org_id,aura_id,message_id,revision,tier_applied,thread_review_epoch,status,decision_source,policy_snapshot_json,reviewed_content_sha256,reason,requested_at)
    SELECT ?,org_id,aura_id,message_id,?,'1',thread_review_epoch,'superseded','human',policy_snapshot_json,reviewed_content_sha256,'tier_3_first_inbound_reply','2026-11-06T00:00:00.000Z' FROM email_reviews WHERE id=?`);
  for(let n=2;n<=32;n++)add.run(`${d.message_id}-revision-${n}`,n,d.review.id);
  x.sql.prepare("UPDATE email_reviews SET status='pending' WHERE message_id=? AND revision=32").run(d.message_id);
  await page.reload();await page.getByRole('button',{name:'Approve',exact:true}).waitFor();
  let historyRequests=0;page.on('request',r=>{if(/\/reviews\?/.test(r.url()))historyRequests++;});
  const beforeOpen=x.sql.prepare('SELECT total_changes() AS n').get().n;
  const history=page.getByRole('button',{name:'Review history',exact:true});
  await history.focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Revision 32',exact:true}).waitFor();
  assert.equal(await history.getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('.review-history-row').count(),25);
  const olderRoute='**/reviews?*cursor=*';
  await page.route(olderRoute,route=>route.fulfill({status:503,json:{error:'Older revisions are temporarily unavailable.'}}));
  await page.getByRole('button',{name:'Load older revisions',exact:true}).click();await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
  assert.equal(await page.locator('.review-history-row').count(),25);
  await page.unroute(olderRoute);await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('heading',{name:'Revision 1',exact:true}).waitFor();
  assert.equal(await page.locator('.review-history-row').count(),32);
  assert.ok(await page.locator('.review-history').getByText('LongReviewerNameWithoutSpaces'.repeat(3),{exact:true}).count());
  assert.equal(x.sql.prepare('SELECT total_changes() AS n').get().n,beforeOpen);assert.equal(sent.length,0);
  const polled=historyRequests;await page.waitForTimeout(5500);assert.equal(historyRequests,polled,'normal inbox polling must not fetch unchanged history');
  await page.getByRole('heading',{name:'Revision 1',exact:true}).scrollIntoViewIfNeeded();await shot('desktop-recorded-reviewer');
  await page.setViewportSize({width:390,height:844});await page.locator('.review-history').getByText('LongReviewerNameWithoutSpaces'.repeat(3),{exact:true}).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('mobile-long-reviewer');
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit draft',exact:true}).click();await page.getByLabel('Message',{exact:true}).fill('Edited while history stays open');
  await page.getByRole('button',{name:'Save and reevaluate policy',exact:true}).click();await page.getByRole('heading',{name:'Revision 33',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.review-history-row').length===33);
  assert.equal(await page.getByRole('heading',{name:'Revision 1',exact:true}).count(),1);
  assert.equal(await page.locator('.review-history-row').first().getByText('Pending',{exact:true}).count(),1);
  assert.equal(await page.locator('.review-history-row').nth(1).getByText('Superseded',{exact:true}).count(),1);
  await shot('desktop-refreshed-history');
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Send email',exact:true}).click();
  await page.locator('.review-history-row').first().getByText('Sent to provider',{exact:true}).waitFor();
  assert.equal(sent.length,1);await shot('desktop-provider-acceptance');
  // Read retries retain loaded pages, perform no writes and expose safe errors.
  const beforeRetry=x.sql.prepare('SELECT total_changes() AS n').get().n;
  const historyRoute='**/messages/*/reviews?*';
  await page.route(historyRoute,route=>route.fulfill({status:503,json:{error:'History is temporarily unavailable.'}}));
  await page.getByRole('button',{name:'Refresh history',exact:true}).click();await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
  assert.equal(await page.locator('.review-history-row').count(),33);await shot('desktop-history-error');
  await page.unroute(historyRoute);await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.review-history .inline-error') && !document.querySelector('.review-history [aria-busy="true"]'));
  assert.equal(await page.locator('.review-history-row').count(),33);assert.equal(x.sql.prepare('SELECT total_changes() AS n').get().n,beforeRetry);assert.equal(sent.length,1);
  // A request from the old thread must never populate the new message's history.
  const old=d;
  const legacy=await api(`${base}/governance/compose`,{to:'recipient@example.invalid',subject:'Legacy without reviews',text:'Legacy message'});
  x.sql.prepare('DELETE FROM email_reviews WHERE message_id=?').run(legacy.message_id);
  await history.click();
  let releaseOld,oldStarted;const oldGate=new Promise(r=>{releaseOld=r;}),started=new Promise(r=>{oldStarted=r;});
  const oldRoute=`**/messages/${old.message_id}/reviews?*`;
  await page.route(oldRoute,async route=>{const response=await route.fetch();oldStarted();await oldGate;try{await route.fulfill({response});}catch{/* navigation aborts the obsolete request */}});
  await history.click();await started;
  await page.goto(`${origin}/?aura=${aura}&thread=${legacy.thread_id}`);await page.getByRole('button',{name:'Review history',exact:true}).click();
  await page.getByText('No recorded reviews for this message.',{exact:true}).waitFor();releaseOld();await page.unroute(oldRoute,{behavior:'wait'});
  assert.equal(await page.locator('.review-history-row').count(),0);await shot('desktop-no-reviews');
  await page.getByRole('button',{name:'Review history',exact:true}).click();
  let releaseAura,auraStarted;const auraGate=new Promise(r=>{releaseAura=r;}),auraRequest=new Promise(r=>{auraStarted=r;});
  const auraRoute=`**/messages/${legacy.message_id}/reviews?*`;
  await page.route(auraRoute,async route=>{const response=await route.fetch();auraStarted();await auraGate;try{await route.fulfill({response});}catch{/* obsolete Aura request */}});
  await page.getByRole('button',{name:'Review history',exact:true}).click();await auraRequest;
  const automatic=await api('/api/auras/aura_demo_004/governance/compose',{to:'recipient@example.invalid',subject:'Automatic review history',text:'Policy-approved draft'});
  await page.goto(`${origin}/?aura=aura_demo_004&thread=${automatic.thread_id}`);await page.getByRole('button',{name:'Review history',exact:true}).click();
  await page.getByText('No human reviewer (automatic)',{exact:true}).waitFor();releaseAura();await page.unroute(auraRoute,{behavior:'wait'});assert.equal(await page.locator('.review-history-row').count(),1);assert.equal(await page.getByText('Automatic policy',{exact:true}).count(),1);await shot('desktop-automatic');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'passed',screenshots:shots,mockedProviderCalls:sent.length,checks:['keyboard disclosure','message pagination','no five-second history polling','read-only open/page/retry','long reviewer at 390px','retained older range after edit','recorded superseded metadata','provider acceptance distinction','error and older-page retry','stale response across thread and Aura navigation','legacy no-review','automatic has no human actor']},null,2));
}catch(error){console.error('Browser check failed:',error);await shot('failure');throw error;}finally{
  await browser.close();await new Promise(r=>server.close(r));for(const fn of cleanup)fn();
}
