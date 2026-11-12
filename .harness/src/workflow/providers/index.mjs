import { AGENT_KEYS, AGENT_PROVIDERS, legacyAgentKeys } from '../agent-config.mjs';

const providers = {
  codex: () => import('./codex.mjs'),
  // The Claude Code provider lives with the rest of its code under .claude/harness and exists only when it was installed.
  'claude-code': () => import('../../../../.claude/harness/providers/claude-code.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('The claude-code provider is not installed; install Harness with --provider claude-code or all');
    throw error;
  }),
};

export async function loadProvider(provider) {
  if (!Object.hasOwn(providers, provider)) throw new Error(`Unsupported agent provider: ${provider}`);
  return providers[provider]();
}

export function configuredProvider(config) {
  const provider = config.agents?.provider || 'codex';
  if (!Object.hasOwn(providers, provider)) throw new Error(`Unsupported agents.provider: ${provider}`);
  return provider;
}

// Claude Code model aliases and IDs; every other model ID belongs to Codex. Setup picks one provider
// and only that provider's models may run, so a workflow never mixes providers.
const CLAUDE_MODEL = /^(opus|sonnet|haiku|claude-[A-Za-z0-9._-]+)(\[[A-Za-z0-9]+\])?$/i;
const MODEL_KEYS = AGENT_KEYS.filter((key) => key.endsWith('_model'));

export function modelBelongsToProvider(provider, model) {
  return provider === 'claude-code' ? CLAUDE_MODEL.test(model) : !CLAUDE_MODEL.test(model);
}

export function assertSingleProvider(config, binding = null) {
  const provider = configuredProvider(config);
  if (binding && binding.provider !== provider) throw new Error(`Workflow binding provider ${binding.provider} differs from the setup provider ${provider}; run setup with ${binding.provider} first. Providers are never mixed in one workflow.`);
  if (binding && !modelBelongsToProvider(provider, binding.model)) throw new Error(`Workflow binding model ${binding.model} is not a ${provider} model.`);
  const [flat] = legacyAgentKeys(config);
  if (flat) throw new Error(`agents.${flat} is a flat key; run harness-codex update to move the model settings under agents.${provider}`);
  for (const section of AGENT_PROVIDERS) for (const key of MODEL_KEYS) {
    const model = config.agents?.[section]?.[key];
    if (typeof model === 'string' && model.trim() && !model.startsWith('agents.') && !modelBelongsToProvider(section, model)) throw new Error(`agents.${section}.${key} is ${model}, which is not a ${section} model; rerun setup so each provider keeps its own models.`);
  }
  return provider;
}

export function parseWorkflowBinding(value) {
  if (value === undefined || value === '') return null;
  let binding;
  try { binding = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new Error('HARNESS_WORKFLOW_BINDING must be valid JSON'); }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).sort().join(',') !== 'model,provider,reasoning_effort'
    || !Object.hasOwn(providers, binding.provider)
    || typeof binding.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(binding.model)
    || typeof binding.reasoning_effort !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(binding.reasoning_effort)) {
    throw new Error('Invalid HARNESS_WORKFLOW_BINDING; expected provider, model and reasoning_effort');
  }
  return binding;
}
