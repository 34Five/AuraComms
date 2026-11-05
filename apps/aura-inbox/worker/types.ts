export interface Env {
  DB: D1Database;
  DEMO_LOGIN_ENABLED?: string;
  CLOUDFLARE_DOMAIN_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  DEFAULT_EMAIL_DOMAIN?: string;
  DEFAULT_EMAIL_ZONE_ID?: string;
  TENANT_COMPANY_NAME?: string;
  GOVERNANCE: DurableObjectNamespace;
  EMAIL?: SendEmail;
  GOVERNANCE_ADMIN_TOKEN?: string;
  GOVERNANCE_REVIEWER_MEMBER_ID?: string;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  DEMO_ORG_ID: string;
  TEST_MODE: string;
  AUTO_REPLY_ENABLED?: string;
  AUTO_REPLY_MODE?: string;
  DEFAULT_LLM_MODEL?: string;
  LLM_SENDER_HOURLY_CAP?: string;
  LLM_AURA_DAILY_CAP?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
