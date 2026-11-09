import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const CLAUDE = ['.claude/harness/providers/claude-code.mjs', '.claude/harness/scripts/harness-claude-orchestrator.mjs', '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs', '.claude/harness/installer/claude-orchestrator-hook.mjs', '.claude/skills/orchestrator/SKILL.md', '.claude/agents/implementation_agent.md'];
const CODEX = ['.agents/skills/orchestrator/SKILL.md', '.codex/hooks.json', '.harness/src/workflow/providers/codex.mjs'];
const SHARED = ['.codex/internal-skills/implement/GUIDE.md', '.codex/scripts/harness-agent-run.mjs', '.codex/agents/implementation_agent.toml', '.harness/src/workflow/providers/index.mjs'];

async function install(provider) {
  const root = await mkdtemp(join(tmpdir(), `harness-provider-${provider || 'default'}-`));
  execFileSync('git', ['init', '-q', root]);
  await protectLocalInstallArtifacts(root, sourceRoot);
  const result = await updateProject({ sourceRoot, targetRoot: root, initialize: true, ...(provider ? { provider } : {}) });
  return { root, result };
}
const present = (root, paths) => paths.filter((path) => existsSync(join(root, path)));

test('install --provider codex carries no Claude Code files and the Claude provider reports it is missing', async () => {
  const { root } = await install('codex');
  try {
    assert.deepEqual(present(root, CLAUDE), []);
    assert.deepEqual(present(root, [...CODEX.filter((path) => path !== '.codex/hooks.json'), ...SHARED]), [...CODEX.filter((path) => path !== '.codex/hooks.json'), ...SHARED]);
    const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
    assert.equal(Object.keys(lock.files).some((path) => path.startsWith('.claude/')), false);
    const { loadProvider } = await import(`file://${join(root, '.harness/src/workflow/providers/index.mjs')}`);
    await assert.rejects(loadProvider('claude-code'), /claude-code provider is not installed/);
    assert.equal((await loadProvider('codex')).id, 'codex');
    // A plain update keeps what is installed instead of adding the other provider.
    await updateProject({ sourceRoot, targetRoot: root });
    assert.deepEqual(present(root, CLAUDE), []);
    assert.equal(execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' }), '?? .harness/contracts.mjs\n', 'only the intentionally visible contract runner is untracked');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('install --provider claude-code carries no Codex skill root and registers the Claude hooks', async () => {
  const { root } = await install('claude-code');
  try {
    assert.deepEqual(present(root, CLAUDE), CLAUDE);
    assert.deepEqual(present(root, ['.agents/skills/orchestrator/SKILL.md', '.harness/src/workflow/providers/codex.mjs'].slice(0, 1)), []);
    assert.deepEqual(present(root, SHARED), SHARED);
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']) assert.equal(settings.hooks[event].length, 1, event);
    assert.match(settings.hooks.SubagentStart[0].hooks[0].command, /harness-agent-event\.mjs/);
    assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /\.claude\/harness\/scripts\/harness-claude-orchestrator-hook\.mjs/);
    assert.equal(existsSync(join(root, '.codex/hooks.json')), false, 'no Codex hook file for a Claude-only install');
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '.claude/harness/providers/claude-code.mjs']);
    const { loadProvider } = await import(`file://${join(root, '.harness/src/workflow/providers/index.mjs')}`);
    assert.equal((await loadProvider('claude-code')).id, 'claude-code');
    await updateProject({ sourceRoot, targetRoot: root });
    assert.deepEqual(present(root, ['.agents/skills/orchestrator/SKILL.md']), []);
    assert.equal(execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' }), '?? .harness/contracts.mjs\n', 'only the intentionally visible contract runner is untracked');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the default install carries both providers and an explicit provider on update switches the installation', async () => {
  const { root } = await install(null);
  try {
    assert.deepEqual(present(root, CLAUDE), CLAUDE);
    assert.deepEqual(present(root, CODEX), CODEX);
    const result = await updateProject({ sourceRoot, targetRoot: root, provider: 'codex' });
    assert.ok(result.retired.some((path) => path.startsWith('.claude/')), 'Claude files are retired when the provider is switched');
    assert.deepEqual(present(root, CLAUDE), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the install CLI accepts --provider and rejects unknown values', () => {
  const cli = join(sourceRoot, 'bin/harness-install.mjs');
  const bad = spawnSync(process.execPath, [cli, 'install', '--provider', 'gemini', '--project', tmpdir()], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--provider must be codex, claude-code or all/);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /--provider <codex\|claude-code\|all>/);
});
