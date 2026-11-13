import { isAbsolute, join } from 'node:path';
import { AGENT_TIERS, activeAgentProvider, legacyAgentKeys, providerAgents } from './agent-config.mjs';
import { readFile, stat } from 'node:fs/promises';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { parseYaml } from '../eval/yaml.mjs';

export function hasTrackerConfiguration(tracker) {
  if (tracker?.mode === 'github') {
    const gh = tracker.github;
    return Boolean(/^[\w.-]+\/[\w.-]+$/.test(gh?.repository || '') && typeof gh?.project_owner === 'string' && gh.project_owner.trim() && Number.isSafeInteger(gh?.project_number) && gh.project_number > 0 && typeof gh?.status_field === 'string' && gh.status_field.trim());
  }
  const directory = tracker?.local_markdown?.directory;
  return tracker?.mode === 'local-markdown' && typeof directory === 'string' && Boolean(directory.trim()) && !isAbsolute(directory) && !directory.split(/[\\/]/).some((part) => !part || part === '.' || part === '..');
}

export async function inspectSetupConfiguration({ workspace_root: root, provider: requestedProvider = null } = {}) {
  if (!isAbsolute(root || '')) throw new Error('Absolute workspace_root is required');
  const violations = [];
  let config = {};
  try {
    config = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration');
  }
  catch (error) { if (error.code && error.code !== 'ENOENT') throw error; config = {}; violations.push('Missing or invalid .codex/harness.yaml'); }
  if (config.worktrees?.directory !== undefined && (typeof config.worktrees.directory !== 'string' || !isAbsolute(config.worktrees.directory) || config.worktrees.directory.includes('\0'))) violations.push('Invalid worktrees.directory');
  if (config.agents?.provider !== undefined && !['codex', 'claude-code'].includes(config.agents.provider)) violations.push('Invalid agents.provider');
  const provider = requestedProvider || activeAgentProvider(config), agents = providerAgents(config, provider);
  for (const flat of legacyAgentKeys(config)) violations.push(`agents.${flat} must move under agents.${provider} (run harness-codex update)`);
  for (const tier of AGENT_TIERS) {
    for (const suffix of ['model', 'reasoning_effort']) {
      const key = `${tier}_${suffix}`;
      if (typeof agents[key] !== 'string' || !agents[key].trim() || agents[key].startsWith('agents.')) violations.push(`Missing agents.${provider}.${key}`);
      else if (suffix === 'reasoning_effort' && !(provider === 'claude-code' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).includes(agents[key])) violations.push(`Invalid agents.${provider}.${key}`);
    }
  }
  if (!hasTrackerConfiguration(config.tracker)) violations.push('Missing or invalid tracker configuration');
  if (typeof config.beads?.enabled !== 'boolean') violations.push('Missing beads.enabled');
  if (typeof config.observability?.victorialogs?.local?.enabled !== 'boolean') violations.push('Missing observability.victorialogs.local.enabled');
  try {
    const { validateContextBudget } = await import('./skill-execution.mjs');
    validateContextBudget(JSON.parse(await readFile(join(root, '.codex/context-budget.json'), 'utf8')));
  } catch (error) { if (error.code && error.code !== 'ENOENT') throw error; violations.push(`Invalid context budget: ${error.message}`); }
  for (const path of ['CONTEXT.md', 'CONTEXT-MAP.md']) {
    try { if (!(await stat(join(root, path))).isFile()) throw new Error('Not a file'); }
    catch (error) { if (error.code && error.code !== 'ENOENT') throw error; violations.push(`Missing or invalid ${path}`); }
  }
  return { status: violations.length ? 'setup_required' : 'configured', violations };
}

export async function inspectProjectReadiness({ workspace_root } = {}) {
  const paths = ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html'];
  const violations = [];
  if (!isAbsolute(workspace_root || '')) violations.push('Absolute workspace_root is required');
  else for (const path of paths) {
    try { await assertWorkspaceTarget(workspace_root, path); if (!(await stat(join(workspace_root, path))).isFile()) throw new Error('Not a file'); }
    catch { violations.push(`Missing or invalid file: ${path}`); }
  }
  return { status: violations.length ? 'blocked' : 'pass', reason: violations.length ? 'project_preparation_required' : 'project_ready', violations };
}
