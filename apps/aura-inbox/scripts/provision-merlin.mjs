import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const remote=process.argv.includes('--remote');
const query=sql=>JSON.parse(execFileSync(process.execPath,[cli,'d1','execute','DB',remote?'--remote':'--local','--command',sql,'--json'],{cwd,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}}))[0].results;
const stop=reason=>{ throw new Error(`${reason} No changes made.`); };
const domains=query("SELECT org_id,status FROM email_domains WHERE domain_key='34five.studio'");
if(domains.length!==1||domains[0].org_id!=='org_demo_001'||domains[0].status!=='active') stop('The active 34five.studio domain is required.');
const auras=query("SELECT id,org_id,name FROM auras WHERE id='aura_demo_merlin' OR (org_id='org_demo_001' AND lower(name)='merlin')");
if(auras.some(a=>a.id!=='aura_demo_merlin'||a.org_id!=='org_demo_001'||a.name!=='Merlin')) stop('A conflicting Merlin Aura exists.');
const addresses=query("SELECT a.id,a.org_id,a.status,x.aura_id FROM email_addresses a LEFT JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL WHERE a.address_key='merlin@34five.studio'");
if(addresses.some(a=>a.id!=='address_merlin'||a.org_id!=='org_demo_001'||a.status!=='active'||(a.aura_id&&a.aura_id!=='aura_demo_merlin'))) stop('The Merlin address has conflicting ownership or state.');
execFileSync(process.execPath,[cli,'d1','execute','DB',remote?'--remote':'--local','--file','scripts/provision-merlin.sql','--json'],{cwd,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
const actual=query("SELECT a.address,x.aura_id,u.name,d.status AS domain_status FROM email_addresses a JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id JOIN auras u ON u.org_id=x.org_id AND u.id=x.aura_id WHERE a.org_id='org_demo_001' AND a.address_key='merlin@34five.studio' AND x.ended_at IS NULL");
if(actual.length!==1||actual[0].aura_id!=='aura_demo_merlin'||actual[0].name!=='Merlin'||actual[0].domain_status!=='active') throw new Error('Merlin address verification failed.');
console.log(JSON.stringify({addresses:actual},null,2));
