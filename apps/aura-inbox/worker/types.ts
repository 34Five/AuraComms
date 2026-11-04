export interface Env {
  DB: D1Database;
  GOVERNANCE: DurableObjectNamespace;
  EMAIL?: SendEmail;
  GOVERNANCE_ADMIN_TOKEN?: string;
  GOVERNANCE_REVIEWER_MEMBER_ID?: string;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  DEMO_ORG_ID: string;
  TEST_MODE: string;
  AUTO_REPLY_ENABLED?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
