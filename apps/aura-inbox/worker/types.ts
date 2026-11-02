export interface Env {
  DB: D1Database;
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
