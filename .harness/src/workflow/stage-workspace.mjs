// What every stage used to look up by itself: the workspace check, the fixed document paths of its plan set with whether they
// exist, and what tracked source there is. The runner puts it in the input as `context.workspace`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWorkspace } from '../../scripts/workspace-preflight-core.mjs';

const SPEC_DOCUMENTS = ['stakeholder-analysis.md', 'requirements.md', 'domain-links.json', 'tactical-design.md'];
const IMPLEMENTATION_DOCUMENTS = ['technology.md', 'ui-handoff.md', 'api.md', 'data.md'];
const PROJECT_DOCUMENTS = ['CONTEXT.md', 'CONTEXT-MAP.md', 'docs/architecture/domain-model.md', '.harness/agents/EXEC.md'];
const NOT_SOURCE = /^(\.|docs\/|CONTEXT(-MAP)?\.md$|AGENTS\.md$|CLAUDE\.md$|README)/;

export async function stageWorkspace(root, planSetId) {
  const git = (...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
  const { valid, reason } = await inspectWorkspace({ workspaceRoot: root, cwd: root });
  const paths = [
    ...(planSetId ? [...SPEC_DOCUMENTS.map((name) => `docs/specs/${planSetId}/${name}`), ...IMPLEMENTATION_DOCUMENTS.map((name) => `docs/implementation/${planSetId}/${name}`)] : []),
    ...PROJECT_DOCUMENTS,
  ];
  const adr = join(root, 'docs/adr');
  const adrs = existsSync(adr) ? readdirSync(adr).filter((name) => name.endsWith('.md')).sort().map((name) => `docs/adr/${name}`) : [];
  const source = git('ls-files', '-z').split('\0').filter((path) => path && !NOT_SOURCE.test(path));
  const areas = {};
  for (const path of source) {
    const parts = path.split('/');
    const area = parts.length === 1 ? '(root)' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
    areas[area] = (areas[area] || 0) + 1;
  }
  const largest = Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 20);
  return {
    preflight: { valid, ...(valid ? {} : { reason }) },
    head: git('rev-parse', 'HEAD').trim() || null,
    documents: { existing: paths.filter((path) => existsSync(join(root, path))), absent: paths.filter((path) => !existsSync(join(root, path))), adrs },
    source: { tracked_files: source.length, areas: Object.fromEntries(largest) },
  };
}
