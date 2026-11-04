// Prove a provider key and model work without deploying. Reads keys from .dev.vars or the environment.
// Usage: npm run llm:smoke -- [--model provider:model] "message"
import { existsSync, readFileSync } from 'node:fs';
import { createProvider, resolveModel } from '../worker/llm/provider.ts';

const root = new URL('../', import.meta.url);
const devVars = new URL('.dev.vars', root);
const fileVars = existsSync(devVars) ? Object.fromEntries(readFileSync(devVars, 'utf8').split(/\r?\n/)
  .map(line => line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/)).filter(Boolean).map(match => [match[1], match[2]])) : {};
const keys = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || fileVars.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || fileVars.ANTHROPIC_API_KEY,
};

const args = process.argv.slice(2);
const flag = args.indexOf('--model');
const requested = flag >= 0 ? args.splice(flag, 2)[1] : null;
const message = args.join(' ') || 'hello';
const configured = readFileSync(new URL('wrangler.jsonc', root), 'utf8').match(/"DEFAULT_LLM_MODEL":\s*"([^"]+)"/)?.[1];

const targets = requested ? [requested] : [
  ...(keys.GEMINI_API_KEY ? [configured] : []),
  ...(keys.ANTHROPIC_API_KEY ? ['anthropic:claude-sonnet-4-5'] : []),
];
if (!targets.length) {
  console.error('No API key found. Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .dev.vars (see .dev.vars.example).');
  process.exit(1);
}

let failed = false;
for (const target of targets) {
  try {
    const ref = resolveModel(target, null);
    const reply = await createProvider(ref, keys).generateReply({
      system: 'You are a connectivity test. Reply in one short sentence.', user: message,
    });
    console.log(`OK ${ref.provider}:${ref.model} truncated=${reply.truncated}\n${reply.text}`);
  } catch (error) {
    failed = true;
    console.error(`FAILED ${target} ${error.code ?? 'E_UNKNOWN'}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
