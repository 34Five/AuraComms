import type { Env } from './types.ts';
import { HttpError } from './types.ts';
import { json } from './utils.ts';

type Row = Record<string, any>;
type Domain = { id: string; domain: string; domain_key: string; kind: string; cloudflare_zone_id: string | null };
type Rule = { id?: string; tag?: string; enabled?: boolean; matchers?: { type?: string; field?: string; value?: string }[];
  actions?: { type?: string; value?: string[] }[] };

const MAX_LOCAL_PART = 64;
const MAX_MATCHER_VALUE = 90; // Cloudflare's limit on a routing rule's literal value.
const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_PAGE_SIZE = 50, CF_MAX_PAGES = 20, CF_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER = 'aura-inbox-demo';
const CLASH_ATTEMPTS = 3;

class ProvisioningError extends Error {}

export function slug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-').replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '') || 'aura';
}

function fit(base: string, suffix: string, domain: string): string {
  const limit = Math.min(MAX_LOCAL_PART, MAX_MATCHER_VALUE - domain.length - 1) - suffix.length;
  return base.slice(0, limit).replace(/[.-]+$/, '') + suffix;
}

// Taken includes released addresses: the current policy never reuses one.
async function freeLocalPart(env: Env, name: string, domain: Domain): Promise<string> {
  const { results } = await env.DB.prepare('SELECT local_part FROM email_addresses WHERE domain_id=?').bind(domain.id).all<Row>();
  const taken = new Set(results.map(r => r.local_part));
  const base = slug(name);
  let candidate = fit(base, '', domain.domain_key);
  for (let n = 2; taken.has(candidate); n++) candidate = fit(base, `-${n}`, domain.domain_key);
  return candidate;
}

async function activeDomains(env: Env): Promise<Domain[]> {
  const { results } = await env.DB.prepare(`SELECT id,domain,domain_key,kind,cloudflare_zone_id FROM email_domains
    WHERE org_id=? AND status='active' ORDER BY domain_key`).bind(env.DEMO_ORG_ID).all<Domain>();
  return results;
}

export function validatePrefix(value: unknown, domain: string): string {
  if (typeof value !== 'string') throw new HttpError(400,'Enter an email prefix.');
  const prefix=value.trim().toLowerCase();
  if (!prefix || prefix.length>MAX_LOCAL_PART || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(prefix)) throw new HttpError(400,'Use an email prefix of up to 64 characters without spaces or an @ sign.');
  if (prefix.length+domain.length+1>MAX_MATCHER_VALUE) throw new HttpError(400,'This email address is too long for routing. Choose a shorter prefix.');
  return prefix;
}


const choice = (d: Domain) => ({ id: d.id, domain: d.domain, kind: d.kind });
const noDomain = () => json({ error: 'This organization has no active email domain yet.', reason: 'no_active_domain' }, 409);

async function current(env: Env, auraId: string): Promise<Row | null> {
  return env.DB.prepare(`SELECT a.id,a.address,a.status,a.domain_id,d.domain,d.status AS domain_status,d.cloudflare_zone_id,
    x.assigned_at,p.status AS provisioning_status,p.worker_name,p.cloudflare_rule_id,p.failure_reason
    FROM email_address_assignments x JOIN email_addresses a ON a.org_id=x.org_id AND a.id=x.address_id
    JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id
    LEFT JOIN email_address_provisioning p ON p.org_id=a.org_id AND p.address_id=a.id
    WHERE x.org_id=? AND x.aura_id=? AND x.ended_at IS NULL ORDER BY d.status='active' DESC,a.address LIMIT 1`)
    .bind(env.DEMO_ORG_ID, auraId).first<Row>();
}

function routingRule(address: string, worker: string) {
  return { name: `AuraComms ${address}`, enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: address }],
    actions: [{ type: 'worker', value: [worker] }] };
}

// An address with no provisioning row was routed by hand, so there is no rule to show or retry.
function present(row: Row) {
  const status = row.provisioning_status ?? 'active';
  return { id: row.id, address: row.address, status: row.status, domain_id: row.domain_id, domain: row.domain,
    domain_status: row.domain_status, assigned_at: row.assigned_at,
    provisioning: { status, reason: row.failure_reason ?? null, rule_id: row.cloudflare_rule_id ?? null,
      rule: status === 'active' ? null : routingRule(row.address, row.worker_name) } };
}

async function cloudflare<T>(env: Env, zone: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  // The thrown error is not recorded: only fixed text and Cloudflare's own codes reach the database.
  try {
    response = await fetch(`${CF_API}/zones/${zone}/email/routing/rules${path}`, { ...init, signal: AbortSignal.timeout(CF_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch { throw new ProvisioningError('Could not reach the Cloudflare API.'); }
  const body = await response.json().catch(() => null) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] } | null;
  if (!response.ok || !body?.success) {
    const detail = (body?.errors ?? []).map(e => `${e.code} ${e.message}`).join('; ').slice(0, 300);
    throw new ProvisioningError(`Cloudflare API returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return body.result as T;
}

async function existingRule(env: Env, zone: string, address: string): Promise<Rule | null> {
  for (let page = 1; page <= CF_MAX_PAGES; page++) {
    const rules = await cloudflare<Rule[]>(env, zone, `?page=${page}&per_page=${CF_PAGE_SIZE}`);
    const found = rules.find(r => r.matchers?.some(m => m.type === 'literal' && m.field === 'to' && m.value?.toLowerCase() === address));
    if (found) return found;
    if (rules.length < CF_PAGE_SIZE) return null;
  }
  return null;
}

async function ensureRule(env: Env, zone: string, address: string, worker: string): Promise<string> {
  const rule = await existingRule(env, zone, address);
  // Never overwrite a rule we did not make: the address may be someone's live mailbox.
  if (rule) {
    const ours = rule.enabled !== false && rule.actions?.some(a => a.type === 'worker' && a.value?.includes(worker));
    if (!ours) throw new ProvisioningError(`Already routed by another Cloudflare rule (${rule.id ?? rule.tag}). Change or remove it, then retry.`);
  }
  const target = rule ?? await cloudflare<Rule>(env, zone, '', { method: 'POST', body: JSON.stringify(routingRule(address, worker)) });
  const id = target.id ?? target.tag;
  if (!id) throw new ProvisioningError('Cloudflare API returned a rule with no identifier.');
  return id;
}

// Never throws for a Cloudflare problem: the address exists either way, and retry can finish it.
async function provision(env: Env, row: Row): Promise<void> {
  if (env.ADDRESS_PROVISIONER && env.ADDRESS_PROVISIONING_SECRET) {
    try {
      const assigned=await env.DB.prepare('SELECT aura_id FROM email_address_assignments WHERE org_id=? AND address_id=? AND ended_at IS NULL').bind(env.DEMO_ORG_ID,row.id).first<{aura_id:string}>();
      if(!assigned) throw new ProvisioningError('The address has no active Aura assignment.');
      const response=await env.ADDRESS_PROVISIONER.fetch(new Request('https://provisioner/internal/provision-address',{method:'POST',headers:{Authorization:`Bearer ${env.ADDRESS_PROVISIONING_SECRET}`,'Content-Type':'application/json'},body:JSON.stringify({aura_id:assigned.aura_id})}));
      if(!response.ok) throw new ProvisioningError('Email setup service is unavailable. Retry or contact an administrator.');
      return;
    } catch {
      await env.DB.prepare("UPDATE email_address_provisioning SET status='failed',failure_reason=?,updated_at=? WHERE org_id=? AND address_id=?").bind('Email setup service is unavailable. Retry or contact an administrator.',new Date().toISOString(),env.DEMO_ORG_ID,row.id).run();
      return;
    }
  }
  const worker = env.DEMO_WORKER_NAME || DEFAULT_WORKER;
  let status = 'provisioning_pending', ruleId: string | null = null, reason: string | null = null;
  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    try {
      ruleId = await ensureRule(env, row.cloudflare_zone_id || env.CF_ZONE_ID, row.address, worker);
      status = 'active';
    } catch (error) {
      if (!(error instanceof ProvisioningError)) throw error;
      status = 'failed'; reason = error.message;
    }
  }
  await env.DB.prepare(`UPDATE email_address_provisioning SET status=?,worker_name=?,cloudflare_rule_id=?,failure_reason=?,updated_at=?
    WHERE org_id=? AND address_id=?`).bind(status, worker, ruleId, reason, new Date().toISOString(), env.DEMO_ORG_ID, row.id).run();
}

async function readBody(request: Request): Promise<Row> {
  const text = await request.text();
  if (!text) return {};
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The request body must be a JSON object.');
  return body as Row;
}

export async function readAddress(env: Env, auraId: string): Promise<Response> {
  const row = await current(env, auraId);
  if (!row) throw new HttpError(404, 'This Aura has no address.');
  return json({ address: present(row) });
}

export async function proposeAddress(env: Env, aura: Row): Promise<Response> {
  const domains = await activeDomains(env);
  if (!domains.length) return noDomain();
  return json({ domains: await Promise.all(domains.map(async d => ({ ...choice(d),
    address: `${await freeLocalPart(env, aura.name, d)}@${d.domain_key}` }))) });
}

export async function generateAddress(request: Request, env: Env, aura: Row): Promise<Response> {
  const body = await readBody(request);
  const existing = await current(env, aura.id);
  if (existing) return retryProvisioning(env,aura.id);
  const domains = await activeDomains(env);
  if (!domains.length) return noDomain();
  let domain = domains[0];
  if (body.domain_id !== undefined) {
    const chosen = domains.find(d => d.id === body.domain_id);
    if (!chosen) return json({ error: 'Choose one of the active domains.', reason: 'invalid_domain', domains: domains.map(choice) }, 400);
    domain = chosen;
  } else if (domains.length > 1) {
    return json({ error: 'Choose a domain for this address.', reason: 'domain_choice_required', domains: domains.map(choice) }, 409);
  }
  const org = env.DEMO_ORG_ID, now = new Date().toISOString();
  for (let attempt = 1; ; attempt++) {
    const local = body.local_part===undefined ? await freeLocalPart(env, aura.name, domain) : validatePrefix(body.local_part,domain.domain_key);
    if(body.local_part!==undefined && await env.DB.prepare('SELECT 1 FROM email_addresses WHERE domain_id=? AND local_part=?').bind(domain.id,local).first()) throw new HttpError(409,'This email address is already reserved. Choose another prefix.');
    const address = `${local}@${domain.domain_key}`;
    const id = `address_${crypto.randomUUID()}`;
    try {
      // The schema allows an Aura several addresses, so the one-per-Aura rule is enforced inside the batch.
      const [created] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO email_addresses (id,org_id,domain_id,local_part,address,address_key,created_at)
          SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM email_address_assignments WHERE org_id=? AND aura_id=? AND ended_at IS NULL)`)
          .bind(id, org, domain.id, local, address, address, now, org, aura.id),
        env.DB.prepare(`INSERT INTO email_address_assignments (id,org_id,address_id,aura_id,assigned_at,reason)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM email_addresses WHERE org_id=? AND id=?)`)
          .bind(`assignment_${crypto.randomUUID()}`, org, id, aura.id, now, 'Generated from the Aura card', org, id),
        env.DB.prepare(`INSERT INTO email_address_provisioning (org_id,address_id,status,worker_name,updated_at)
          SELECT ?,?,'provisioning_pending',?,? WHERE EXISTS (SELECT 1 FROM email_addresses WHERE org_id=? AND id=?)`)
          .bind(org, id, env.DEMO_WORKER_NAME || DEFAULT_WORKER, now, org, id),
      ]);
      if (!created.meta.changes) return json({ address: present((await current(env, aura.id))!) });
      await provision(env, (await current(env, aura.id))!);
      return json({ address: present((await current(env, aura.id))!) }, 201);
    } catch (error) {
      // Another request took this local part between the read and the batch.
      if (body.local_part!==undefined && /UNIQUE constraint/.test(String((error as Error).message))) throw new HttpError(409,'This email address is already reserved. Choose another prefix.');
      if (attempt >= CLASH_ATTEMPTS || !/UNIQUE constraint/.test(String((error as Error).message))) throw error;
    }
  }
}

export async function retryProvisioning(env: Env, auraId: string): Promise<Response> {
  const row = await current(env, auraId);
  if (!row) throw new HttpError(404, 'This Aura has no address.');
  if (row.status !== 'active' || row.domain_status !== 'active') {
    return json({ error: 'This address is not active, so it cannot be provisioned.', reason: 'address_not_active' }, 409);
  }
  if ((row.provisioning_status ?? 'active') === 'active') return json({ address: present(row) });
  await provision(env, row);
  return json({ address: present((await current(env, auraId))!) });
}
