// Model settings are kept per provider under `agents.<provider>`, so each provider has its own models and switching
// the active `agents.provider` never needs them to be entered again. Only the active provider's section is used to run.
export const AGENT_PROVIDERS = ['codex', 'claude-code'];
export const AGENT_TIERS = ['high_performance', 'implementation', 'execution', 'low_performance'];
export const AGENT_KEYS = [...AGENT_TIERS.flatMap((tier) => [`${tier}_model`, `${tier}_reasoning_effort`]), 'default_model'];

export const activeAgentProvider = (config) => config?.agents?.provider || 'codex';

// The only place a tier is turned into settings: agents.<provider>.<tier>_model and agents.<provider>.<tier>_reasoning_effort.
export const tierSettingKeys = (tier) => {
  if (!AGENT_TIERS.includes(tier)) throw new Error(`Unknown model tier: ${tier}`);
  return { model: `${tier}_model`, reasoning_effort: `${tier}_reasoning_effort` };
};

// The active (or named) provider's settings, e.g. { high_performance_model, low_performance_reasoning_effort, ... }.
export function providerAgents(config, provider = activeAgentProvider(config)) {
  const section = config?.agents?.[provider];
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

// Model keys written directly under `agents:` by older versions.
export const legacyAgentKeys = (config) => AGENT_KEYS.filter((key) => config?.agents && Object.hasOwn(config.agents, key));

const indentOf = (line) => line.length - line.trimStart().length;

// Moves the flat model keys under `agents:` into the active provider's section in the YAML text, keeping everything else.
export function migrateAgentsText(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^agents:\s*$/.test(line));
  if (start === -1) return { text, moved: [] };
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || lines[end].trim().startsWith('#') || indentOf(lines[end]) > 0)) end += 1;
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  const block = lines.slice(start + 1, end);
  const provider = block.map((line) => /^ {2}provider:\s*"?([A-Za-z-]+)"?\s*(#.*)?$/.exec(line)?.[1]).find(Boolean) || 'codex';
  const flat = new Map();
  const kept = [];
  for (const line of block) {
    const match = /^ {2}([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (match && AGENT_KEYS.includes(match[1])) flat.set(match[1], match[2]);
    else kept.push(line);
  }
  if (!flat.size) return { text, moved: [] };
  if (kept.some((line) => new RegExp(`^ {2}${provider}:`).test(line))) throw new Error(`agents.${provider} already exists next to flat model keys; move ${[...flat.keys()].join(', ')} into it by hand`);
  const cleaned = kept.filter((line, index) => !(line.trim() === '' && (kept[index - 1]?.trim() === '' || index === kept.length - 1)));
  const section = [`  ${provider}:`, ...AGENT_KEYS.filter((key) => flat.has(key)).map((key) => `    ${key}: ${flat.get(key)}`)];
  return { text: [...lines.slice(0, start + 1), ...cleaned, ...section, ...lines.slice(end)].join('\n'), moved: [...flat.keys()], provider };
}
