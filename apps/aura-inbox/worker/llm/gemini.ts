import { LlmError, MAX_OUTPUT_TOKENS, requestJson } from './http.ts';
import type { LlmProvider } from './provider.ts';

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export function geminiProvider(model: string, apiKey: string): LlmProvider {
  return {
    async generateReply({ system, user }) {
      const data = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
      }, [apiKey]);
      const block = data?.promptFeedback?.blockReason;
      if (block) throw new LlmError('E_LLM_SAFETY', `Gemini blocked the prompt: ${String(block).slice(0, 40)}.`);
      const candidate = data?.candidates?.[0];
      const finish = candidate?.finishReason;
      if (BLOCKED.has(finish)) throw new LlmError('E_LLM_SAFETY', `Gemini stopped the reply: ${finish}.`);
      const parts: { text?: string; thought?: boolean }[] = candidate?.content?.parts ?? [];
      const text = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
      if (!text.trim()) throw new LlmError('E_LLM_EMPTY', `Gemini returned no text (finish reason ${String(finish).slice(0, 40)}).`);
      if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') throw new LlmError('E_LLM_BAD_RESPONSE', `Gemini stopped unexpectedly: ${String(finish).slice(0, 40)}.`);
      return { text, truncated: finish === 'MAX_TOKENS' };
    },
  };
}
