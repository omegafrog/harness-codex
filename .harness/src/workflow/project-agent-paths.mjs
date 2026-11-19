export const PROJECT_AGENT_DIRECTORY = '.harness/agents';
export const LEGACY_PROJECT_AGENT_DIRECTORY = 'docs/agents';
export const PROJECT_AGENT_FILES = Object.freeze([
  'EXEC.md', 'execution.json', 'implementation-guidance.md', 'testing-guidance.md',
  'domain.md', 'issue-tracker.md', 'plan-status.md',
]);
export const EXECUTION_MANIFEST = `${PROJECT_AGENT_DIRECTORY}/execution.json`;
export const LEGACY_EXECUTION_MANIFEST = `${LEGACY_PROJECT_AGENT_DIRECTORY}/execution.json`;

export function currentProjectAgentPath(path) {
  const prefix = `${LEGACY_PROJECT_AGENT_DIRECTORY}/`;
  return path.startsWith(prefix) && PROJECT_AGENT_FILES.includes(path.slice(prefix.length))
    ? `${PROJECT_AGENT_DIRECTORY}/${path.slice(prefix.length)}`
    : path;
}

export function executionManifestDigest(receipt) {
  return receipt.config_hashes?.[EXECUTION_MANIFEST] ?? receipt.config_hashes?.[LEGACY_EXECUTION_MANIFEST];
}
