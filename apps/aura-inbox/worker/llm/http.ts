export const MAX_OUTPUT_TOKENS = 1024;
const TIMEOUT_MS = 20_000;
const MAX_DETAIL_CHARS = 200;

export class LlmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

export type FailureClass = 'provider_error' | 'timeout' | 'safety_block' | 'empty_reply' | 'bad_config' | 'internal_error';

// These phrases reach everyone who can open the inbox, and raw provider detail stays in email_events.
export const FAILURE_SUMMARIES: Record<FailureClass, string> = {
  provider_error: 'The AI provider returned an error.',
  timeout: 'The AI provider did not respond in time.',
  safety_block: 'The AI provider blocked this reply for safety reasons.',
  empty_reply: 'The AI provider returned an empty reply.',
  bad_config: 'AI replies are not configured correctly for this Aura.',
  internal_error: 'The reply could not be generated.',
};

export function failureClass(code: unknown): FailureClass {
  switch (code) {
    case 'E_LLM_TIMEOUT': return 'timeout';
    case 'E_LLM_SAFETY': return 'safety_block';
    case 'E_LLM_EMPTY': return 'empty_reply';
    case 'E_LLM_CONFIG': case 'E_LLM_NO_KEY': return 'bad_config';
    case 'E_LLM_NETWORK': case 'E_LLM_BAD_RESPONSE': return 'provider_error';
    default: return typeof code === 'string' && code.startsWith('E_LLM_HTTP_') ? 'provider_error' : 'internal_error';
  }
}

export function safeDetail(value: unknown, secrets: readonly string[] = []): string {
  let text = String(value).replace(/[\x00-\x1f\x7f]/g, ' ');
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text
    .replace(/AIza[0-9A-Za-z_-]{6,}/g, '[redacted]')
    .replace(/sk-ant-[0-9A-Za-z_-]+/g, '[redacted]')
    .replace(/((?:x-goog-api-|x-api-|api[_-]?)?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, MAX_DETAIL_CHARS);
}

export async function requestJson(url: string, init: RequestInit, secrets: readonly string[]): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let status: number, ok: boolean, body: string;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    ({ status, ok } = response);
    body = await response.text();
  } catch (error) {
    if (controller.signal.aborted || (error as Error)?.name === 'AbortError') throw new LlmError('E_LLM_TIMEOUT', 'The provider did not respond within 20 seconds.');
    throw new LlmError('E_LLM_NETWORK', safeDetail((error as Error)?.message ?? error, secrets));
  } finally { clearTimeout(timer); }
  let data: any;
  try { data = JSON.parse(body); }
  catch { data = undefined; }
  if (!ok) throw new LlmError(`E_LLM_HTTP_${status}`, safeDetail(data?.error?.message ?? `The provider returned HTTP ${status}.`, secrets));
  if (data === undefined) throw new LlmError('E_LLM_BAD_RESPONSE', 'The provider returned a response that is not JSON.');
  return data;
}
