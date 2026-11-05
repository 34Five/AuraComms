// Deliberately shared dummy accounts for the isolated local demo. Never use these passwords for real accounts.
import { passwordHash, randomHex, PASSWORD_ITERATIONS } from '../worker/password.ts';
export const DEMO_ORG='org_demo_001';
export const DEMO_ACCOUNTS=[
  {member_id:'member_demo_001',name:'Demo Admin',email:'admin@345.demo',role:'admin',password:'Admin345!Demo'},
  {member_id:'member_demo_manager',name:'Demo Manager',email:'manager@345.demo',role:'manager',password:'Manager345!Demo'},
  {member_id:'member_demo_reviewer',name:'Demo Reviewer',email:'reviewer@345.demo',role:'reviewer',password:'Reviewer345!Demo'},
];
export const sqlValue=value=>"'"+String(value).replaceAll("'","''")+"'";
export async function demoAccountSql() {
  const statements=[];
  for(const account of DEMO_ACCOUNTS){
    const salt=randomHex(16),hash=await passwordHash(account.password,salt),q=sqlValue;
    statements.push(
      `INSERT INTO studio_members (org_id,member_id,role) VALUES (${q(DEMO_ORG)},${q(account.member_id)},'member') ON CONFLICT(org_id,member_id) DO NOTHING;`,
      `INSERT INTO email_workspace_access (org_id,member_id,display_name,email,role,bootstrap_revoked) VALUES (${q(DEMO_ORG)},${q(account.member_id)},${q(account.name)},${q(account.email)},${q(account.role)},1)
       ON CONFLICT(org_id,member_id) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,role=excluded.role,status='active',bootstrap_revoked=1,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');`,
      `DELETE FROM email_workspace_sessions WHERE org_id=${q(DEMO_ORG)} AND member_id=${q(account.member_id)};`,
      `UPDATE email_reviews SET status='superseded' WHERE org_id=${q(DEMO_ORG)} AND approver_member_id=${q(account.member_id)} AND status='approved' AND message_id IN (SELECT id FROM email_messages WHERE org_id=${q(DEMO_ORG)} AND status IN ('draft','queued'));`,
      `DELETE FROM email_workspace_credentials WHERE org_id=${q(DEMO_ORG)} AND member_id=${q(account.member_id)};`,
      `INSERT INTO email_workspace_logins (org_id,member_id,login_key,password_salt,password_hash,password_iterations) VALUES (${q(DEMO_ORG)},${q(account.member_id)},${q(account.email)},${q(salt)},${q(hash)},${PASSWORD_ITERATIONS})
       ON CONFLICT(org_id,member_id) DO UPDATE SET login_key=excluded.login_key,password_salt=excluded.password_salt,password_hash=excluded.password_hash,password_iterations=excluded.password_iterations;`,
      `INSERT INTO email_aura_reviewers (org_id,aura_id,member_id,configured_by_member_id) SELECT org_id,id,${q(account.member_id)},'member_demo_001' FROM auras WHERE org_id=${q(DEMO_ORG)}
       ON CONFLICT(org_id,aura_id,member_id) DO UPDATE SET revoked_at=NULL;`,
    );
  }
  statements.push(`DELETE FROM email_workspace_login_limits WHERE org_id=${sqlValue(DEMO_ORG)};`);
  return statements.join('\n');
}
