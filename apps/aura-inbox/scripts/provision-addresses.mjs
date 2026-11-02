import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const remote=process.argv.includes('--remote');
const query=sql=>JSON.parse(execFileSync(process.execPath,[cli,'d1','execute','DB',remote?'--remote':'--local','--command',sql,'--json'],{cwd,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}}))[0].results;
const expected=new Map([['support-test@34five.studio','aura_demo_001'],['sales-test@34five.studio','aura_demo_002']]);
const parents=query("SELECT id FROM auras WHERE org_id='org_demo_001' AND id IN ('aura_demo_001','aura_demo_002')");
if(parents.length!==2) throw new Error('The two existing demo Auras are required.');
const domains=query("SELECT org_id,status FROM email_domains WHERE domain_key='34five.studio'");
if(domains.some(d=>d.org_id!=='org_demo_001'||d.status!=='active')) throw new Error('Domain ownership/state conflicts. No changes made.');
const rows=query("SELECT a.address_key,a.org_id,a.status,x.aura_id FROM email_addresses a LEFT JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL WHERE a.address_key IN ('support-test@34five.studio','sales-test@34five.studio')");
if(rows.some(a=>a.org_id!=='org_demo_001'||a.status!=='active'||(a.aura_id&&a.aura_id!==expected.get(a.address_key)))) throw new Error('An address has conflicting ownership/state. No changes made.');
execFileSync(process.execPath,[cli,'d1','execute','DB',remote?'--remote':'--local','--file','scripts/provision-addresses.sql','--json'],{cwd,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
const actual=query("SELECT a.address,x.aura_id,d.status AS domain_status FROM email_addresses a JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id WHERE a.org_id='org_demo_001' AND a.address_key IN ('support-test@34five.studio','sales-test@34five.studio') AND x.ended_at IS NULL");
if(actual.length!==2||actual.some(a=>a.aura_id!==expected.get(a.address)||a.domain_status!=='active')) throw new Error('Receiving address verification failed.');
console.log(JSON.stringify({addresses:actual},null,2));
