import { Governance } from './governance.ts';
import { authorizeManagement, managementBody, requireRole } from './management-auth.ts';
import { userManagement, workspaceUsers } from './user-management.ts';
import { DomainRegistry } from './domain-registry.ts';
import { verifyDomain } from './domain-dns.ts';
import { HttpError, type Env } from './types.ts';
import { json, requireId } from './utils.ts';
import { auraConfig } from './llm/prompt.ts';

export async function managementApi(request: Request, env: Env): Promise<Response> {
  const identity = await authorizeManagement(request,env), member=identity.member_id, g = new Governance(env);
  const parts = new URL(request.url).pathname.replace(/\/$/,'').split('/').filter(Boolean), resource=parts[2], id=parts[3] ? requireId(parts[3]):null;
  if (parts.length===3 && resource==='workspace' && request.method==='GET') {
    const users=await workspaceUsers(env);
    const assigned=await g.q('SELECT aura_id FROM email_aura_reviewers WHERE org_id=? AND member_id=? AND revoked_at IS NULL',g.org,member).all<{aura_id:string}>();
    return json({member_id:member,role:identity.role,reviewer_aura_ids:assigned.results.map(a=>a.aura_id),members:identity.role==='reviewer'?[]:users.filter(u=>u.status==='active').map(u=>({id:u.id,name:u.name}))});
  }
  if (resource==='users') return userManagement(request,env,identity,parts);
  requireRole(identity,['admin','manager']);
  if (parts.length===3 && resource==='auras' && request.method==='POST') {
    const data=await managementBody(request), name=validName(data.name), role=validName(data.role ?? 'General assistant','Aura role'), tier=data.tier ?? '1';
    if (!['1','2','3','4'].includes(tier)) throw new HttpError(400,'Choose a tier from 1 to 4.');
    const aura=`aura_${crypto.randomUUID()}`;
    await env.DB.batch([
      g.q('INSERT INTO auras (id,org_id,name,role) VALUES (?,?,?,?)',aura,g.org,name,role),
      g.q('INSERT INTO email_aura_policies (org_id,aura_id,tier,updated_by_member_id) VALUES (?,?,?,?)',g.org,aura,tier,member),
      g.q('INSERT INTO email_aura_reviewers (org_id,aura_id,member_id,configured_by_member_id) VALUES (?,?,?,?)',g.org,aura,member,member),
    ]);
    return json({aura:{id:aura,name,role},message:'Aura created. Configure an email address before sending.'},201);
  }
  if (resource==='auras' && id) {
    const row=await g.one('SELECT * FROM auras WHERE org_id=? AND id=?',g.org,id);
    const aura={id:row.id,name:row.name,role:auraConfig(row).role};
    if (parts.length===4 && request.method==='GET') {
      const addresses=await g.q(`SELECT a.id,a.address,a.status,d.domain,d.status AS domain_status,x.id AS assignment_id FROM email_addresses a
        JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id
        WHERE x.org_id=? AND x.aura_id=? AND x.ended_at IS NULL ORDER BY a.address`,g.org,id).all();
      const reviewers=await g.q('SELECT member_id,revoked_at FROM email_aura_reviewers WHERE org_id=? AND aura_id=? ORDER BY member_id',g.org,id).all();
      const history=await g.one(`SELECT (SELECT COUNT(*) FROM email_threads WHERE org_id=? AND aura_id=?) AS threads,
        (SELECT COUNT(*) FROM email_address_assignments WHERE org_id=? AND aura_id=?) AS assignments`,g.org,id,g.org,id);
      return json({aura,policy:await g.policyConfig(id),addresses:addresses.results,reviewers:reviewers.results,can_delete:history.threads===0 && history.assignments===0});
    }
    if (parts.length===4 && request.method==='PUT') {
      const data=await managementBody(request), name=validName(data.name);
      if (data.previous_name!==aura.name) throw new HttpError(409,'The Aura changed. Reload before saving.');
      const role=data.role===undefined ? row.role ?? null : validName(data.role,'Aura role');
      if (data.role!==undefined && data.previous_role!==aura.role) throw new HttpError(409,'The Aura role changed. Reload before saving.');
      const result=await g.q('UPDATE auras SET name=?,role=? WHERE org_id=? AND id=? AND name=? AND role IS ?',name,role,g.org,id,aura.name,row.role ?? null).run();
      if (!result.meta.changes) throw new HttpError(409,'The Aura changed. Reload before saving.');
      return json({aura:{id,name,role}});
    }
    if (parts.length===4 && request.method==='DELETE') {
      const data=await managementBody(request);
      if (data.confirm_name!==aura.name) throw new HttpError(400,'Enter the Aura name to confirm deletion.');
      const history=await g.one(`SELECT (SELECT COUNT(*) FROM email_threads WHERE org_id=? AND aura_id=?) AS threads,
        (SELECT COUNT(*) FROM email_address_assignments WHERE org_id=? AND aura_id=?) AS assignments`,g.org,id,g.org,id);
      if (history.threads || history.assignments) throw new HttpError(409,'This Aura has email or address history. Remove its policy to pause sending and preserve that history.');
      try {
        await env.DB.batch([
          g.q('DELETE FROM email_aura_reviewers WHERE org_id=? AND aura_id=?',g.org,id),
          g.q('DELETE FROM email_aura_policies WHERE org_id=? AND aura_id=?',g.org,id),
          g.q('DELETE FROM auras WHERE org_id=? AND id=?',g.org,id),
        ]);
      } catch { throw new HttpError(409,'Other records still reference this Aura. Its history was preserved.'); }
      return json({status:'deleted'});
    }
    if (parts.length===6 && parts[4]==='reviewers' && ['PUT','DELETE'].includes(request.method)) {
      const reviewer=requireId(parts[5]);
      await g.one('SELECT member_id FROM studio_members WHERE org_id=? AND member_id=?',g.org,reviewer);
      if (request.method==='PUT') {
        const users=await workspaceUsers(env);
        if (!users.some(u=>u.id===reviewer && u.status==='active')) throw new HttpError(409,'Configure active workspace access before assigning this reviewer.');
        await g.q(`INSERT INTO email_aura_reviewers (org_id,aura_id,member_id,configured_by_member_id) VALUES (?,?,?,?)
          ON CONFLICT(org_id,aura_id,member_id) DO UPDATE SET revoked_at=NULL,configured_by_member_id=excluded.configured_by_member_id,configured_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,g.org,id,reviewer,member).run();
      } else {
        await env.DB.batch([
          g.q('UPDATE email_aura_reviewers SET revoked_at=? WHERE org_id=? AND aura_id=? AND member_id=? AND revoked_at IS NULL',new Date().toISOString(),g.org,id,reviewer),
          g.q("UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND approver_member_id=? AND status='approved' AND message_id IN (SELECT id FROM email_messages WHERE org_id=? AND aura_id=? AND status IN ('draft','queued'))",g.org,id,reviewer,g.org,id),
        ]);
      }
      return json({status:request.method==='PUT'?'assigned':'revoked'});
    }
    if (parts.length===6 && parts[4]==='addresses' && request.method==='PUT') {
      const address=requireId(parts[5]),data=await managementBody(request);
      if (!['active','disabled'].includes(data.status)) throw new HttpError(400,'Choose active or disabled.');
      const current=await g.one(`SELECT a.id,a.status,d.status AS domain_status FROM email_addresses a JOIN email_domains d ON d.org_id=a.org_id AND d.id=a.domain_id JOIN email_address_assignments x ON x.org_id=a.org_id AND x.address_id=a.id
        WHERE x.org_id=? AND x.aura_id=? AND x.ended_at IS NULL AND a.id=?`,g.org,id,address);
      if(data.status==='active' && current.domain_status!=='active')throw new HttpError(409,'Verify and activate the domain before enabling this address.');
      if (current.status==='released') throw new HttpError(409,'Released addresses cannot be reactivated.');
      const statements=[g.q('UPDATE email_addresses SET status=?,disabled_at=? WHERE org_id=? AND id=?',data.status,data.status==='disabled'?new Date().toISOString():null,g.org,address)];
      if (data.status==='disabled') statements.push(g.q("UPDATE email_reviews SET status='superseded' WHERE org_id=? AND aura_id=? AND status IN ('pending','approved') AND message_id IN (SELECT id FROM email_messages WHERE org_id=? AND aura_id=? AND email_address_id=? AND status IN ('draft','queued'))",g.org,id,g.org,id,address));
      await env.DB.batch(statements);
      return json({status:data.status});
    }
  }
  if (resource==='domains') {
    const registry=new DomainRegistry(env);
    if(parts.length===3 && request.method==='GET')return json({domains:await registry.list(new URL(request.url).searchParams.get('active')==='true')});
    if(parts.length===3 && request.method==='POST') {
      const data=await managementBody(request);
      return json({domain:await registry.addCustom(data.domain)},201);
    }
    if(parts.length===4 && id==='default' && request.method==='POST') {
      await managementBody(request);
      return json({domain:await registry.ensureDefault(env.TENANT_COMPANY_NAME ?? env.DEMO_ORG_ID)});
    }
    if(id && parts.length===4 && request.method==='GET')return json({domain:await registry.view(await registry.get(id))});
    if(id && parts.length===4 && request.method==='DELETE')return json({domain:await registry.remove(id)});
    if(id && parts.length===5 && parts[4]==='check' && request.method==='POST')return json({domain:await registry.check(id)});
    if(id && parts.length===5 && parts[4]==='verify' && request.method==='POST')return json(await verifyDomain(env,id));
  }
  throw new HttpError(404,'Management endpoint not found.');
}
function validName(value: unknown,label='Aura name'): string {
  if (typeof value!=='string' || !value.trim() || value.trim().length>100 || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400,`Enter an ${label} from 1 to 100 characters.`);
  return value.trim();
}
