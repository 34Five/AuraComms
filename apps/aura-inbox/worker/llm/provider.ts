import { anthropicProvider } from './anthropic.ts';
import { geminiProvider } from './gemini.ts';
import { LlmError } from './http.ts';

export type LlmPrompt = { system: string; user: string };
export type LlmReply = { text: string; truncated: boolean };
export interface LlmProvider { generateReply(prompt: LlmPrompt): Promise<LlmReply> }

export type ModelRef = { provider: string; model: string };
export type LlmKeys = { GEMINI_API_KEY?: string; ANTHROPIC_API_KEY?: string };

const PROVIDERS: Record<string, { key: keyof LlmKeys; create: (model: string, apiKey: string) => LlmProvider }> = {
  gemini: { key: 'GEMINI_API_KEY', create: geminiProvider },
  anthropic: { key: 'ANTHROPIC_API_KEY', create: anthropicProvider },
};

function parseModel(value: unknown): ModelRef | null {
  const match = typeof value === 'string' ? value.trim().match(/^([a-z0-9]+):([A-Za-z0-9._-]+)$/) : null;
  return match && Object.hasOwn(PROVIDERS, match[1]) ? { provider: match[1], model: match[2] } : null;
}

export function resolveModel(llmId: unknown, fallback: unknown): ModelRef {
  const model = parseModel(llmId) ?? parseModel(fallback);
  if (!model) throw new LlmError('E_LLM_CONFIG', 'Neither the Aura llm_id nor DEFAULT_LLM_MODEL is a usable provider:model value.');
  return model;
}

export function createProvider(ref: ModelRef, keys: LlmKeys): LlmProvider {
  const provider = PROVIDERS[ref.provider];
  const apiKey = provider && keys[provider.key];
  if (!apiKey) throw new LlmError('E_LLM_NO_KEY', `${provider?.key ?? ref.provider} is not set.`);
  return provider.create(ref.model, apiKey);
}
