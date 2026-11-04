import { CloudflareDomainProvider, type DomainProvider, type DomainRow, type DomainProgress, type PublicRecord } from './domain-provider.ts';
import { domainRecords } from './domain-dns.ts';
import { HttpError, type Env } from './types.ts';

export function normalizeDomain(value:unknown):string {
  if(typeof value!=='string')throw new HttpError(400,'Enter a domain name without an email address, URL or wildcard.');
  const domain=value.trim().toLowerCase().replace(/\.$/,'');
  if(domain.length>189 || !domain.includes('.') || !domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(domain) || !/^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(domain.split('.').at(-1)!)) {
    throw new HttpError(400,'Enter a valid ASCII domain, such as acme.com. Use its punycode form for an international domain.');
  }
  return domain;
}
export function tenantSlug(company:string):string {
  return company.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,63).replace(/-$/,'');
}
export function delegationRecords(d:DomainRow):PublicRecord[] {
  const rows=JSON.parse(d.dns_records_json);
  return Array.isArray(rows)?rows.filter(r=>r?.type==='NS' && r.name===d.domain_key && typeof r.content==='string'):[];
}
export class DomainRegistry {
  readonly org:string;
  private env:Env;
  private provider:DomainProvider;
  constructor(env:Env, provider:DomainProvider=new CloudflareDomainProvider(env)) {
    this.env=env;this.provider=provider;
    if(!env.DEMO_ORG_ID || env.DEMO_ORG_ID==='org')throw new HttpError(503,'A tenant is required for domain management.');
    this.org=env.DEMO_ORG_ID;
  }
  private q(sql:string,...values:any[]) {return this.env.DB.prepare(sql).bind(...values);}
  async get(id:string):Promise<DomainRow> {
    const row=await this.q('SELECT * FROM email_domains WHERE org_id=? AND id=?',this.org,id).first<DomainRow>();
    if(!row)throw new HttpError(404,'Domain not found.');return row;
  }
  async view(d:DomainRow) {
    const usage=await this.q(`SELECT a.address,u.id AS aura_id,u.name AS aura_name FROM email_addresses a
      LEFT JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id AND x.ended_at IS NULL
      LEFT JOIN auras u ON u.org_id=x.org_id AND u.id=x.aura_id WHERE a.org_id=? AND a.domain_id=? AND a.status='active' ORDER BY a.address`,this.org,d.id).all();
    return {id:d.id,domain:d.domain,kind:d.kind,status:d.status,failure_reason:d.failure_reason,verified_at:d.verified_at,activated_at:d.activated_at,
      nameservers:delegationRecords(d).map(r=>r.content),records:domainRecords(d.domain_key,d.dns_records_json),provider_domain_id:d.cloudflare_domain_id,
      provider_managed:!!d.cloudflare_zone_id,setup_url:'https://dash.cloudflare.com/',active_addresses:usage.results,can_remove:d.kind==='custom'&&d.status!=='disabled'&&usage.results.length===0};
  }
  async list(activeOnly=false) {
    const rows=await this.q(`SELECT * FROM email_domains WHERE org_id=?${activeOnly?" AND status='active'":''} ORDER BY kind='default_subdomain' DESC,domain`,this.org).all<DomainRow>();
    return Promise.all(rows.results.map(d=>this.view(d)));
  }
  async addCustom(value:unknown) {
    const domain=normalizeDomain(value),base=normalizeDomain(this.env.DEFAULT_EMAIL_DOMAIN ?? '34five.studio');
    if(domain===base || domain.endsWith('.'+base) || base.endsWith('.'+domain))throw new HttpError(400,'This domain is reserved for default company subdomains.');
    const id=`domain_${crypto.randomUUID()}`;
    await this.q(`INSERT INTO email_domains (id,org_id,domain,domain_key,kind)
      SELECT ?,?,?,?,'custom' WHERE NOT EXISTS(SELECT 1 FROM email_domains WHERE org_id<>? AND
        (domain_key=? OR substr(domain_key,-length(?)-1)='.'||? OR substr(?,-length(domain_key)-1)='.'||domain_key))
      ON CONFLICT DO NOTHING`,id,this.org,domain,domain,this.org,domain,domain,domain,domain).run();
    const row=await this.q('SELECT * FROM email_domains WHERE domain_key=? AND org_id=?',domain,this.org).first<DomainRow>();
    if(!row)throw new HttpError(409,'This domain is unavailable.');
    if(row.kind!=='custom' || row.status==='disabled')throw new HttpError(409,'This domain is already reserved or disabled. Contact the workspace administrator.');
    // A duplicate request returns the same record without another provider mutation.
    if(row.id!==id)return this.view(row);
    return this.prepare(row);
  }
  // Call from address creation before selecting a domain. Company name comes from trusted tenant data.
  async ensureDefault(companyName:string) {
    const existing=await this.q("SELECT * FROM email_domains WHERE org_id=? AND kind='default_subdomain'",this.org).first<DomainRow>();
    if(existing)return this.view(existing);
    const base=normalizeDomain(this.env.DEFAULT_EMAIL_DOMAIN ?? '34five.studio');
    const orgSlug=tenantSlug(this.org);
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(this.org)))].map(n=>n.toString(16).padStart(2,'0')).join('').slice(0,12);
    const suffix=`${orgSlug.slice(0,35)||'org'}-${digest}`;
    const slug=tenantSlug(companyName)||suffix;
    for(const candidate of [slug,`${slug.slice(0,63-suffix.length-1).replace(/-$/,'')}-${suffix}`]) {
      const domain=normalizeDomain(`${candidate}.${base}`),id=`domain_${crypto.randomUUID()}`;
      await this.q("INSERT INTO email_domains (id,org_id,domain,domain_key,kind) VALUES (?,?,?,?,'default_subdomain') ON CONFLICT DO NOTHING",id,this.org,domain,domain).run();
      const row=await this.q("SELECT * FROM email_domains WHERE org_id=? AND kind='default_subdomain'",this.org).first<DomainRow>();
      if(row) {
        if(row.id!==id)return this.view(row);
        await this.prepare(row);
        if((await this.get(row.id)).status==='failed')return this.view(await this.get(row.id));
        return this.check(row.id);
      }
    }
    throw new HttpError(409,'Could not reserve the tenant subdomain. Contact the workspace administrator.');
  }
  private async progress(d:DomainRow,result:DomainProgress,status:string) {
    const now=new Date().toISOString();
    await this.q(`UPDATE email_domains SET status=?,cloudflare_zone_id=?,cloudflare_domain_id=COALESCE(?,cloudflare_domain_id),dns_records_json=?,failure_reason=?,
      verified_at=CASE WHEN ?='active' THEN COALESCE(verified_at,?) ELSE verified_at END,
      activated_at=CASE WHEN ?='active' THEN COALESCE(activated_at,?) ELSE activated_at END,updated_at=? WHERE org_id=? AND id=? AND status<>'disabled'`,
      status,result.zoneId,result.domainId ?? null,JSON.stringify(result.records),result.reason,status,now,status,now,now,this.org,d.id).run();
    return this.view(await this.get(d.id));
  }
  private async failed(d:DomainRow,error:unknown) {
    const reason=error instanceof HttpError?error.message:'Domain provisioning failed. Check again to reconcile the provider state.';
    await this.q("UPDATE email_domains SET status='failed',failure_reason=?,updated_at=? WHERE org_id=? AND id=? AND status<>'disabled'",reason,new Date().toISOString(),this.org,d.id).run();
    return this.view(await this.get(d.id));
  }
  private async prepare(d:DomainRow) {
    try{return await this.progress(d,await this.provider.prepare(d),'pending');}catch(error){return this.failed(d,error);}
  }
  async check(id:string) {
    let d=await this.get(id);
    if(d.status==='disabled')throw new HttpError(409,'This domain is disabled.');
    await this.q("UPDATE email_domains SET status='verifying',failure_reason=NULL,updated_at=? WHERE org_id=? AND id=? AND status<>'disabled'",new Date().toISOString(),this.org,id).run();
    try {
      if(!d.cloudflare_zone_id) {await this.prepare(d);d=await this.get(id);if(d.status==='failed')return this.view(d);}
      const result=await this.provider.check(d);
      return await this.progress(d,result,result.ready?'active':d.kind==='custom'&&!d.verified_at&&result.records.every(r=>r.type==='NS')?'pending':'verifying');
    } catch(error){return this.failed(d,error);}
  }
  async remove(id:string) {
    const d=await this.get(id);
    if(d.kind!=='custom')throw new HttpError(409,'The default company subdomain cannot be removed.');
    const view=await this.view(d);
    if(view.active_addresses.length)throw new HttpError(409,`Disable these addresses before removing the domain: ${view.active_addresses.map((a:any)=>a.aura_name?`${a.address} (${a.aura_name})`:a.address).join(', ')}.`);
    // Soft removal preserves FK references and old mail. It never deletes a customer DNS zone.
    await this.q(`UPDATE email_domains SET status='disabled',disabled_at=COALESCE(disabled_at,?),failure_reason=NULL,updated_at=?
      WHERE org_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM email_addresses WHERE org_id=? AND domain_id=? AND status='active')`,new Date().toISOString(),new Date().toISOString(),this.org,id,this.org,id).run();
    const result=await this.get(id);if(result.status!=='disabled')throw new HttpError(409,'The domain is in use. Refresh before removing it.');
    return this.view(result);
  }
}
