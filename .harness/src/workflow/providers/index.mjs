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
