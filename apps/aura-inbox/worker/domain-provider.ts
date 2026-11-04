import { domainRecords, verifyDomain } from './domain-dns.ts';
import { HttpError, type Env } from './types.ts';

export type DomainRow = {
  id:string;org_id:string;domain:string;domain_key:string;kind:'default_subdomain'|'custom';
  status:string;dns_records_json:string;cloudflare_zone_id:string|null;cloudflare_domain_id:string|null;
  failure_reason:string|null;verified_at:string|null;activated_at:string|null;disabled_at:string|null;
};
export type PublicRecord = {type:string;name:string;content:string;priority?:number;ttl?:number};
export type DomainProgress = {zoneId:string;domainId?:string;records:PublicRecord[];ready:boolean;reason:string|null};
export interface DomainProvider {
  prepare(domain:DomainRow):Promise<DomainProgress>;
  check(domain:DomainRow):Promise<DomainProgress>;
}

// All provider requests use a fixed origin. Customer input never selects a URL.
export class CloudflareDomainProvider implements DomainProvider {
  private env:Env;
  private transport:typeof fetch;
  private deadline=Date.now()+20000;
  constructor(env:Env, transport:typeof fetch=fetch) {this.env=env;this.transport=transport;}
  private signal() {
    if(Date.now()>=this.deadline)throw new HttpError(502,'Cloudflare setup is still incomplete. Check again to continue.');
    return AbortSignal.timeout(Math.min(5000,Math.max(1,this.deadline-Date.now())));
  }
  private async call(path:string, method='GET', body?:unknown):Promise<any> {
    if (!this.env.CLOUDFLARE_DOMAIN_API_TOKEN || !/^[a-f0-9]{32}$/.test(this.env.CLOUDFLARE_ACCOUNT_ID ?? '')) {
      throw new HttpError(503,'Domain provisioning is not configured. Set the Cloudflare account and domain API token on the server.');
    }
    let response:Response;
    try { response=await this.transport('https://api.cloudflare.com/client/v4'+path,{
      method,headers:{Authorization:`Bearer ${this.env.CLOUDFLARE_DOMAIN_API_TOKEN}`,'Content-Type':'application/json'},
      ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:this.signal(),redirect:'error',
    }); } catch { throw new HttpError(502,'Cloudflare did not respond. Check again to reconcile the existing domain before retrying.'); }
    let data:any;try {data=await response.json();} catch {throw new HttpError(502,'Cloudflare returned an unreadable response. Check again.');}
    if (!response.ok || data.success!==true || data.result==null) {
      const codes=Array.isArray(data.errors)?data.errors.map((e:any)=>Number(e.code)).filter(Number.isFinite).join(', '):'';
      // Do not expose provider error text. It can contain request credentials or unrelated account data.
      throw new HttpError(502,`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}${codes?`, code ${codes}`:''}). Check Zone Read/Edit and Email Routing/Sending permissions, entitlement and the 30-domain zone limit.`);
    }
    return data.result;
  }
  private async zone(d:DomainRow):Promise<any> {
    const base=this.env.DEFAULT_EMAIL_DOMAIN ?? '34five.studio';
    const name=d.kind==='custom'?d.domain_key:base;
    let zone:any;
    const id=d.cloudflare_zone_id ?? (d.kind==='default_subdomain'?this.env.DEFAULT_EMAIL_ZONE_ID:undefined);
    if (id) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(503,'The configured Cloudflare zone ID is invalid.');
      zone=await this.call(`/zones/${id}`);
    } else {
      const params=new URLSearchParams({name,'account.id':this.env.CLOUDFLARE_ACCOUNT_ID ?? '',per_page:'50'});
      const zones=await this.call(`/zones?${params}`);
      if (!Array.isArray(zones) || zones.length>1) throw new HttpError(502,'Cloudflare did not return one matching zone.');
      zone=zones[0];
      if (!zone) {
        if (d.kind==='default_subdomain') throw new HttpError(503,'Configure the existing default email zone. It will not be created automatically.');
        zone=await this.call('/zones','POST',{name,account:{id:this.env.CLOUDFLARE_ACCOUNT_ID},type:'full'});
      }
    }
    if (zone.name!==name || zone.account?.id!==this.env.CLOUDFLARE_ACCOUNT_ID || zone.type!=='full' || !/^[a-f0-9]{32}$/.test(zone.id)) {
      throw new HttpError(409,'The Cloudflare zone does not match this domain and account. No email settings were changed.');
    }
    return zone;
  }
  private nameservers(d:DomainRow,zone:any):PublicRecord[] {
    if(d.kind!=='custom')return [];
    if(!Array.isArray(zone.name_servers) || zone.name_servers.length<2 || zone.name_servers.some((n:unknown)=>typeof n!=='string'||!/^[a-z0-9.-]+\.ns\.cloudflare\.com$/.test(n))) {
      throw new HttpError(502,'Cloudflare did not return valid delegation nameservers.');
    }
    return zone.name_servers.map((content:string)=>({type:'NS',name:d.domain_key,content}));
  }
  async prepare(d:DomainRow):Promise<DomainProgress> {
    const zone=await this.zone(d);
    return {zoneId:zone.id,records:this.nameservers(d,zone),ready:false,reason:d.kind==='custom'?'Set these nameservers at your registrar, then select Check now.':'Select Check now to onboard and verify email.'};
  }
  async check(d:DomainRow):Promise<DomainProgress> {
    const zone=await this.zone(d), ns=this.nameservers(d,zone), root=`/zones/${zone.id}/email`;
    if(zone.status!=='active')return {zoneId:zone.id,records:ns,ready:false,reason:'Cloudflare is waiting for nameserver delegation. Check again after DNS propagates.'};
    // Onboarding is idempotent. Read first to reconcile timeouts and interrupted requests.
    const domains=await this.call(`${root}/sending/subdomains?per_page=50`);
    if(!Array.isArray(domains))throw new HttpError(502,'Cloudflare returned an invalid sending-domain list.');
    let sending=domains.find((s:any)=>s.name===d.domain_key);
    if(!sending || !sending.enabled)sending=await this.call(`${root}/sending/subdomains`,'POST',{name:d.domain_key});
    const tag=sending.tag;
    if(sending.name!==d.domain_key || sending.enabled!==true || !/^[a-f0-9]{32}$/.test(tag))throw new HttpError(502,'Cloudflare has not enabled Email Sending for this domain.');
    const raw=await this.call(`${root}/sending/subdomains/${tag}/dns`);
    if(!Array.isArray(raw))throw new HttpError(502,'Cloudflare returned invalid email DNS records.');
    const records=domainRecords(d.domain_key,JSON.stringify(raw.map((r:any)=>({...r,name:r?.name==='@'?d.domain_key:r?.name}))));
    const hasDkim=records.some(r=>r.type==='TXT'&&r.name.includes('._domainkey.'));
    const hasSpf=records.some(r=>r.type==='TXT'&&/^v=spf1\b/i.test(r.content));
    const hasDmarc=records.some(r=>r.type==='TXT'&&r.name===`_dmarc.${d.domain_key}`&&/^v=DMARC1;/i.test(r.content));
    if(!hasDkim||!hasSpf||!hasDmarc||!records.some(r=>r.type==='MX'))throw new HttpError(502,'Cloudflare has not supplied complete DKIM, SPF, DMARC and bounce MX records. Complete Email Sending onboarding in Cloudflare, then check again.');
    // Routing subdomains need a different onboarding flow. Do not alter the parent zone MX records.
    let routing=await this.call(`${root}/routing`);
    if(d.kind==='custom' && (!routing.enabled || routing.status!=='ready'))routing=await this.call(`${root}/routing/dns`,'POST',{});
    let receivingReady=d.kind==='custom' && routing.name===d.domain_key;
    if(d.kind==='default_subdomain') {
      const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',d.domain_key);url.searchParams.set('type','MX');
      const response=await this.transport(url,{headers:{Accept:'application/dns-json'},signal:this.signal()});
      if(!response.ok)throw new HttpError(502,'The DNS resolver is unavailable. Check again.');
      const answer=await response.json() as any;
      receivingReady=answer.Status===0 && answer.Answer?.some((a:any)=>a.type===15 && /^\d+ route\d+\.mx\.cloudflare\.net\.?$/i.test(a.data));
    }
    const published=await verifyDomain(this.env,d.id,this.transport,[...ns,...records]);
    const ready=routing.enabled===true && routing.status==='ready' && receivingReady && published.records.every(r=>r.status==='verified');
    return {zoneId:zone.id,domainId:tag,records:[...ns,...records],ready,reason:ready?null:
      d.kind==='default_subdomain'&&!receivingReady?'Onboard this subdomain for Email Routing in Cloudflare. The parent zone routing is unchanged.':'Complete Cloudflare Email Sending/Routing onboarding and wait for all DNS records to propagate, then check again.'};
  }
}
