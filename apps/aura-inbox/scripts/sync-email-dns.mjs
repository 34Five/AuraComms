// Import public provider DNS records only. This does not change Cloudflare DNS.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const flag=(name,fallback)=>{const i=process.argv.indexOf(name);return i===-1?fallback:process.argv[i+1];};
const domain=flag('--domain','34five.studio'),org=flag('--org','org_demo_001'),zone=flag('--zone-id','1c60311626bbfe94b6fe3496d15de727');
if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)||!domain.includes('.')||!/^\w[\w-]*$/.test(org)||!/^[a-f0-9]{32}$/.test(zone))throw new Error('Invalid domain, organization or zone.');
const env={...process.env,WRANGLER_SEND_METRICS:'false'},target=process.argv.includes('--remote')?'--remote':'--local';
const run=args=>execFileSync(process.execPath,[cli,...args],{cwd,env,encoding:'utf8'});
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const query=sql=>JSON.parse(run(['d1','execute','DB',target,'--command',sql,'--json']))[0].results;
const registered=query(`SELECT id,cloudflare_zone_id FROM email_domains WHERE org_id=${quote(org)} AND domain_key=${quote(domain)}`);
if(registered.length!==1||registered[0].cloudflare_zone_id!==zone)throw new Error('The domain is not registered to this workspace and zone.');
const output=run(['email','sending','dns','get',domain,'--zone-id',zone]);
const records=[...output.matchAll(/^(TXT|MX|CNAME) record:\s*\n\s+Name:\s+([^\n]+)\n\s+Content:\s+([^\n]+)(?:\n\s+Priority:\s+(\d+))?(?:\n\s+TTL:\s+(\d+))?/gm)].map(([,type,name,content,priority,ttl])=>({type,name:name.trim(),content:content.trim(),...(priority?{priority:Number(priority)}:{}),...(ttl?{ttl:Number(ttl)}:{})}));
if(!records.length||records.length>50||!records.some(r=>r.name.includes('._domainkey.'))||records.some(r=>r.name!==domain&&!r.name.endsWith('.'+domain)))throw new Error('The provider DNS response is incomplete or outside the requested domain.');
const settings=run(['email','sending','settings',domain,'--zone-id',zone]);
const tag=settings.match(/^\s+Tag:\s+([a-f0-9]{32})/m)?.[1];
if(!tag)throw new Error('Provider domain identity was not returned.');
const dir=mkdtempSync(join(tmpdir(),'aura-dns-'));
try {
  const path=join(dir,'public-dns.sql');
  writeFileSync(path,`UPDATE email_domains SET dns_records_json=${quote(JSON.stringify(records))},cloudflare_domain_id=${quote(tag)},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id=${quote(org)} AND id=${quote(registered[0].id)} AND cloudflare_zone_id=${quote(zone)};`,{mode:0o600});
  run(['d1','execute','DB',target,'--file',path,'--json']);
} finally {rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify({domain,records:records.length,dkim_names:records.filter(r=>r.name.includes('._domainkey.')).map(r=>r.name),dns_changed:false},null,2));
