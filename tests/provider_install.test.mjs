import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const CLAUDE = ['.claude/harness/providers/claude-code.mjs', '.claude/harness/scripts/harness-claude-orchestrator.mjs', '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs', '.claude/harness/installer/claude-orchestrator-hook.mjs', '.claude/skills/orchestrator/SKILL.md', '.claude/agents/implementation_agent.md'];
const CODEX = ['.agents/skills/orchestrator/SKILL.md', '.codex/hooks.json', '.harness/src/workflow/providers/codex.mjs'];
const SHARED = ['.codex/internal-skills/implement/GUIDE.md', '.codex/scripts/harness-agent-run.mjs', '.codex/agents/implementation_agent.toml', '.codex/agents/pr_author.toml', '.github/PULL_REQUEST_TEMPLATE/plan-set.md', '.harness/src/workflow/providers/index.mjs'];

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
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  codex:\n    low_performance_model: gpt-6.1-sol\n    low_performance_reasoning_effort: medium\n    high_performance_model: gpt-6.1-sol\n    high_performance_reasoning_effort: high\n');
    assert.match(await readFile(join(root, '.codex/workflows/to-ticket.yaml'), 'utf8'), /id: plan-pr[\s\S]*skill: gh-open-pr/);
    assert.match(await readFile(join(root, '.codex/workflows/implement-wrapper.yaml'), 'utf8'), /id: integration-pr[\s\S]*skill: gh-open-pr/);
    const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
    assert.equal(Object.keys(lock.files).some((path) => path.startsWith('.claude/')), false);
    const { loadProvider } = await import(`file://${join(root, '.harness/src/workflow/providers/index.mjs')}`);
    await assert.rejects(loadProvider('claude-code'), /claude-code provider is not installed/);
    assert.equal((await loadProvider('codex')).id, 'codex');
    const { resolveAgentSandbox, resolveSkillBinding, resolveWorkflowStage } = await import(`file://${join(root, '.harness/src/workflow/skill-execution.mjs')}`);
    const { resolveStageSkill } = await import(`file://${join(root, '.harness/src/workflow/stage-input.mjs')}`);
    for (const [stageId, workflow] of [['plan-pr', 'to-ticket'], ['integration-pr', 'implement-wrapper']]) {
      assert.equal((await resolveStageSkill({ root, stageId })).skill, 'gh-open-pr');
      const input = { skill: 'gh-open-pr', context: { stage_id: stageId } };
      const binding = await resolveWorkflowStage({ root, input });
      assert.deepEqual(binding, { workflow, stage: stageId });
      assert.deepEqual(await resolveAgentSandbox({ root, input, ...binding }), { profile: 'pr_author', sandbox: 'workspace-write' });
      assert.equal((await resolveSkillBinding({ root, skill: input.skill, ...binding })).model_tier, 'low_performance');
    }
    assert.equal((await resolveStageSkill({ root, stageId: 'tracker-publish' })).skill, 'tracker-publish');
    const duplicateManifest = join(root, '.codex/workflows/implement-wrapper-copy.yaml');
    const originalManifest = await readFile(join(root, '.codex/workflows/implement-wrapper.yaml'), 'utf8');
    await writeFile(duplicateManifest, originalManifest.replace('id: implement-wrapper\n', 'id: implement-wrapper-copy\n'));
    await assert.rejects(resolveStageSkill({ root, stageId: 'integration-pr' }), /Workflow stage is ambiguous: integration-pr/);
    await rm(duplicateManifest);
    assert.deepEqual(await resolveAgentSandbox({ root, input: { skill: 'gh-open-pr', context: { agent_profile: 'pr_author' } }, workflow: 'to-ticket', stage: 'plan-pr' }), { profile: 'pr_author', sandbox: 'workspace-write' });
    await assert.rejects(resolveAgentSandbox({ root, input: { skill: 'gh-open-pr', context: { agent_profile: 'pr_author' } } }), /only at its gated/);
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
    const { codexUserOrchestratorHookInstalled } = await import('../.harness/src/workflow/providers/codex.mjs');
    const expectedCodex = await codexUserOrchestratorHookInstalled() ? CODEX.filter((path) => path !== '.codex/hooks.json') : CODEX;
    assert.deepEqual(present(root, expectedCodex), expectedCodex);
    const doctor = await runDoctor({ root, sourceRoot });
    assert.deepEqual(doctor.diagnostics.filter((item) => item.code === 'installer_stale_lock_entry' || item.code === 'execution_asset_missing' || item.code.startsWith('plan_pr_template_')), [], 'Doctor recognizes the PR author profile and managed plan template');
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

test('install and update never install Wake and Doctor checks only the configured Codex provider', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'harness-wake-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), bin = join(base, 'bin'), log = join(base, 'calls'), state = join(base, 'state');
  await mkdir(root); await mkdir(bin);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'user-file.txt'), 'preserve');
  const codex = join(bin, 'codex');
  await writeFile(codex, `#!/usr/bin/env node\nconst fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n'); if(a.join(' ')==='plugin list --json') console.log(JSON.stringify({installed:[{pluginId:'ponytail@ponytail',enabled:true}]})); else if(a.join(' ')==='plugin marketplace list --json') console.log(JSON.stringify({marketplaces:[{name:'ponytail',marketplaceSource:{source:'https://github.com/DietrichGebert/ponytail.git'}}]})); else if(a.join(' ')==='mcp get codex-wake --json') console.log(JSON.stringify({enabled:!process.env.WAKE_TEST_DISABLED,transport:{type:'stdio',command:process.execPath,cwd:process.cwd()}}));\n`);
  await chmod(codex, 0o755);
  const bd = join(bin, 'bd'); await writeFile(bd, '#!/bin/sh\necho test\n'); await chmod(bd, 0o755);
  const cli = join(sourceRoot, 'bin/harness-install.mjs');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const command of ['install', 'update']) {
    const result = spawnSync(process.execPath, [cli, command, '--project', root, '--provider', 'codex'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args.some((arg) => /codex-wake/.test(arg))), false);
  assert.equal(await readFile(join(root, 'user-file.txt'), 'utf8'), 'preserve');
  const status = execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' });
  assert.match(status, /user-file\.txt/);
  assert.doesNotMatch(status, /stage-result-events/);
  await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  provider: codex\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
  const doctor = (doctorEnv) => {
    const result = spawnSync(process.execPath, [join(sourceRoot, 'bin/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8', env: doctorEnv });
    return JSON.parse(result.stdout).diagnostics;
  };
  assert.equal(doctor(env).some((item) => item.code === 'codex_wake_unavailable'), false);
  assert.equal(doctor({ ...env, WAKE_TEST_DISABLED: '1' }).some((item) => item.code === 'codex_wake_unavailable'), true);
  for (const command of ['install', 'update']) {
    const result = spawnSync(process.execPath, [cli, command, '--project', root, '--provider', 'claude-code'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  provider: claude-code\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
  assert.equal(doctor({ ...env, WAKE_TEST_DISABLED: '1' }).some((item) => item.code === 'codex_wake_unavailable'), false);
  assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((args) => args[0] === 'mcp' && args[1] === 'get').length, 2);
  assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).some((args) => args[0] === 'plugin' && args.some((arg) => /codex-wake/.test(arg))), false);
  execFileSync('git', ['-C', root, 'check-ignore', '-v', '.harness/src/workflow/stage-result-events.mjs']);
  assert.equal(await readFile(join(root, 'user-file.txt'), 'utf8'), 'preserve');
});
