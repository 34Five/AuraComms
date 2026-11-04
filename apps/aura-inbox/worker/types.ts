export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  EMAIL: SendEmail;
  SESSION_SECRET?: string;
  DEMO_ORG_ID: string;
  TEST_MODE: string;
  AUTO_REPLY_ENABLED?: string;
  AUTO_REPLY_MODE?: string;
  DEFAULT_LLM_MODEL?: string;
  LLM_SENDER_HOURLY_CAP?: string;
  LLM_AURA_DAILY_CAP?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  DEMO_WORKER_NAME?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
