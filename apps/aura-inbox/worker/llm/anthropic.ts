import { LlmError, MAX_OUTPUT_TOKENS, requestJson } from './http.ts';
import type { LlmProvider } from './provider.ts';

export function anthropicProvider(model: string, apiKey: string): LlmProvider {
  return {
    async generateReply({ system, user }) {
      const data = await requestJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
        body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, system, messages: [{ role: 'user', content: user }] }),
      }, [apiKey]);
      const stop = data?.stop_reason;
      if (stop === 'refusal') throw new LlmError('E_LLM_SAFETY', 'Anthropic declined to generate this reply.');
      const blocks: { type?: string; text?: string }[] = Array.isArray(data?.content) ? data.content : [];
      const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
      if (!text.trim()) throw new LlmError('E_LLM_EMPTY', `Anthropic returned no text (stop reason ${String(stop).slice(0, 40)}).`);
      return { text, truncated: stop === 'max_tokens' };
    },
  };
}
