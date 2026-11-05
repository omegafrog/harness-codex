const providers = {
  codex: () => import('./codex.mjs'),
  'claude-code': () => import('./claude-code.mjs'),
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
