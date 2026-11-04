import { Governance } from './governance.ts';
import { HttpError, type Env } from './types.ts';

type RecordRow = {type:string;name:string;content:string;priority?:number;ttl?:number};
export function txtValue(value: string): string {
  const parts = [...value.matchAll(/"((?:\\.|[^"\\])*)"/g)];
  return parts.length ? parts.map(m=>m[1].replace(/\\(\d{3})/g,(_,n)=>String.fromCharCode(Number(n))).replace(/\\(["\\])/g,'$1')).join('') : value.trim();
}
export function txtMatches(name: string, actual: string, expected: string): boolean {
  const a=txtValue(actual),e=txtValue(expected);
  if (!name.startsWith('_dmarc.') && !name.includes('._domainkey.')) return a===e;
  const tags=(value:string)=>{
    const output=new Map<string,string>();
    for(const part of value.split(';').map(s=>s.trim()).filter(Boolean)){
      const split=part.indexOf('=');if(split<1)return null;
      const key=part.slice(0,split).trim().toLowerCase(),value=part.slice(split+1).replace(/\s/g,'');
      if(output.has(key))return null;output.set(key,value);
    }
    return output;
  };
  const actualTags=tags(a),expectedTags=tags(e);
  return !!actualTags && !!expectedTags && expectedTags.size>0 && [...expectedTags].every(([key,value])=>actualTags.get(key)===value);
}
export function domainRecords(domain: string, value: string): RecordRow[] {
  const rows = JSON.parse(value);
  if (!Array.isArray(rows)) return [];
  return rows.slice(0,50).filter((r: any)=>r && ['TXT','MX','CNAME'].includes(r.type) && typeof r.name==='string' && typeof (r.content ?? r.value)==='string'
    && (r.name.toLowerCase()===domain || r.name.toLowerCase().endsWith('.'+domain)))
    .map((r: any)=>({type:r.type,name:r.name.toLowerCase(),content:r.content ?? r.value,...(r.priority!==undefined?{priority:r.priority}:{}),...(r.ttl!==undefined?{ttl:r.ttl}:{})}));
}
export async function verifyDomain(env: Env, id: string, resolver: typeof fetch = fetch) {
  const g = new Governance(env), d = await g.one('SELECT * FROM email_domains WHERE org_id=? AND id=?',g.org,id);
  const expected = domainRecords(d.domain_key,d.dns_records_json);
  if (!expected.length) throw new HttpError(409,'Provider DNS records have not been loaded for this domain. Open Cloudflare setup first.');
  const unique = [...new Map(expected.map(r=>[r.type+':'+r.name,r])).values()];
  const answers = new Map<string,{state:string;answers:any[]}>();
  await Promise.all(unique.map(async r=>{
    try {
      const url = new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',r.name);url.searchParams.set('type',r.type);
      const response = await resolver(url,{headers:{Accept:'application/dns-json'},signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error();
      const data = await response.json() as {Status:number;Answer?:any[]};
      answers.set(r.type+':'+r.name,{state:data.Status===0?'answered':data.Status===3?'missing':'unavailable',answers:data.Answer??[]});
    } catch { answers.set(r.type+':'+r.name,{state:'unavailable',answers:[]}); }
  }));
  const codes: Record<string,number> = {TXT:16,MX:15,CNAME:5};
  const records = expected.map(r=>{
    const result = answers.get(r.type+':'+r.name)!;
    const target = r.type==='TXT'?txtValue(r.content):r.type==='MX'?`${r.priority} ${r.content.replace(/\.$/,'').toLowerCase()}`:r.content.replace(/\.$/,'').toLowerCase();
    const matches = result.answers.some(a=>{
      if (a.type!==codes[r.type] || typeof a.data!=='string') return false;
      const actual = r.type==='TXT'?txtValue(a.data):a.data.replace(/\.$/,'').toLowerCase();
      return r.type==='TXT' ? txtMatches(r.name,actual,target) : actual===target;
    });
    return {...r,status:matches?'verified':result.state==='unavailable'?'unavailable':'missing_or_mismatch'};
  });
  const dkim = records.filter(r=>r.name.includes('._domainkey.'));
  return {domain_id:id,domain:d.domain,checked_at:new Date().toISOString(),dkim_status:!dkim.length?'not_configured':dkim.every(r=>r.status==='verified')?'verified':dkim.some(r=>r.status==='unavailable')?'unavailable':'needs_setup',records};
}
