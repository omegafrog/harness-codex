import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const CLAUDE = ['.claude/harness/providers/claude-code.mjs', '.claude/harness/scripts/harness-claude-orchestrator.mjs', '.claude/harness/installer/claude-orchestrator-hook.mjs', '.claude/skills/orchestrator/SKILL.md', '.claude/agents/implementation_agent.md'];
const CODEX = ['.agents/skills/orchestrator/SKILL.md', '.harness/src/workflow/providers/codex.mjs'];
const SHARED = ['.codex/internal-skills/implement/GUIDE.md', '.codex/scripts/harness-native-stage.mjs', '.codex/agents/implementation_agent.toml', '.codex/agents/pr_author.toml', '.github/PULL_REQUEST_TEMPLATE/plan-set.md', '.harness/src/workflow/providers/index.mjs'];

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
    assert.deepEqual(present(root, [...CODEX, ...SHARED]), [...CODEX, ...SHARED]);
    await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'agents:\n  codex:\n    low_performance_model: gpt-6.1-sol\n    low_performance_reasoning_effort: medium\n    high_performance_model: gpt-6.1-sol\n    high_performance_reasoning_effort: high\n');
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
    assert.equal(execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' }), '', 'no Harness-managed path, including the contract runner, shows up in git status');
    assert.match(execFileSync('git', ['-C', root, 'check-ignore', '-v', '.harness/contracts.mjs'], { encoding: 'utf8' }), /\.git\/info\/exclude:\d+:\/\.harness\/contracts\.mjs\t\.harness\/contracts\.mjs/, 'the contract runner is excluded like every other managed file');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('install --provider claude-code carries no Codex skill root and registers the Claude hooks', async () => {
  const { root } = await install('claude-code');
  try {
    assert.deepEqual(present(root, CLAUDE), CLAUDE);
    assert.deepEqual(present(root, ['.agents/skills/orchestrator/SKILL.md', '.harness/src/workflow/providers/codex.mjs'].slice(0, 1)), []);
    assert.deepEqual(present(root, SHARED), SHARED);
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    for (const event of ['SubagentStart', 'SubagentStop']) assert.equal(settings.hooks[event].length, 1, event);
    assert.match(settings.hooks.SubagentStart[0].hooks[0].command, /harness-agent-event\.mjs/);
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) assert.equal(settings.hooks[event], undefined);
    const admission = settings.hooks.PreToolUse.find((entry) => entry.matcher === 'Agent').hooks[0].command;
    const agent = (tool_input) => spawnSync('sh', ['-c', admission], {
      cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8',
      input: JSON.stringify({ cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input }),
    });
    assert.equal(JSON.parse(agent({ subagent_type: 'workflow_stage', resume: 'old-agent' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(JSON.parse(agent({ subagent_type: 'code_researcher', fork_context: true }).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(agent({ subagent_type: 'workflow_stage', prompt: 'Use the assigned input' }).stdout, '');
    assert.equal(existsSync(join(root, '.codex/hooks.json')), false, 'no Codex hook file for a Claude-only install');
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '.claude/harness/providers/claude-code.mjs']);
    const { loadProvider } = await import(`file://${join(root, '.harness/src/workflow/providers/index.mjs')}`);
    assert.equal((await loadProvider('claude-code')).id, 'claude-code');
    await writeFile(join(root, 'app.txt'), 'application change\n');
    await rm(join(root, '.codex/scripts/harness-agent-admission.mjs'));
    assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith('harness-agent-admission.mjs')));
    await updateProject({ sourceRoot, targetRoot: root });
    assert.deepEqual(present(root, ['.agents/skills/orchestrator/SKILL.md']), []);
    assert.equal(execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' }), '?? app.txt\n');
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'application change\n');
    assert.match(await readFile(join(root, '.claude/skills/orchestrator/references/dispatch.md'), 'utf8'), /새 native 작업자/);
    assert.equal(JSON.parse(agent({ subagent_type: 'workflow_stage', resume: 'old-agent' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(execFileSync('git', ['-C', root, 'check-ignore', '-v', '.harness/contracts.mjs'], { encoding: 'utf8' }), /\.git\/info\/exclude:\d+:\/\.harness\/contracts\.mjs\t\.harness\/contracts\.mjs/, 'the contract runner is excluded like every other managed file');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the default install carries both providers and an explicit provider on update switches the installation', async () => {
  const { root } = await install(null);
  try {
    assert.deepEqual(present(root, CLAUDE), CLAUDE);
    assert.deepEqual(present(root, CODEX), CODEX);
    assert.equal(existsSync(join(root, '.codex/hooks.json')), false);
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

test('install and update preserve user plugins and Doctor reports the legacy Ponytail setting for Codex', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'harness-wake-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), bin = join(base, 'bin'), log = join(base, 'calls'), codexHome = join(base, 'codex-home');
  await mkdir(root); await mkdir(bin); await mkdir(codexHome);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'user-file.txt'), 'preserve');
  await writeFile(log, '');
  const userConfig = join(codexHome, 'config.toml');
  const legacyConfig = '[plugins."ponytail@ponytail"]\nenabled = true\n';
  await writeFile(userConfig, legacyConfig);
  const codex = join(bin, 'codex');
  await writeFile(codex, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exitCode = 1;\n`);
  await chmod(codex, 0o755);
  const cli = join(sourceRoot, 'bin/harness-install.mjs');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: codexHome };
  for (const command of ['install', 'update']) {
    if (command === 'update') {
      const oldDoctor = join(root, '.harness/src/doctor/doctor.mjs');
      await writeFile(oldDoctor, 'export const obsolete = "codex_wake_unavailable: use harness-stage-listen";\n');
    }
    const result = spawnSync(process.execPath, [cli, command, '--project', root, '--provider', 'codex'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated .codex\/harness-lock\.json|Harness update complete/);
  }
  for (const path of ['.harness/src/doctor/doctor.mjs', '.agents/skills/setup/references/initial-setup.md', '.agents/skills/orchestrator/SKILL.md']) {
    assert.doesNotMatch(await readFile(join(root, path), 'utf8'), /harness-stage-listen|codex_wake_unavailable/);
  }
  await assert.rejects(readFile(join(root, '.codex/scripts/harness-stage-listen.mjs')), { code: 'ENOENT' });
  const maintenance = await readFile(join(root, '.codex/internal-skills/harness-maintenance/GUIDE.md'), 'utf8');
  assert.match(maintenance, /harness-doctor\.mjs --project <repository-root> --json/);
  assert.match(maintenance, /only the diagnostics returned by that invocation/);
  assert.match(maintenance, /Do not report unrequested actions that were not performed, including contract synchronization or sealing/);
  const installedReport = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { cwd: root, encoding: 'utf8', env });
  assert.ok(JSON.parse(installedReport.stdout).diagnostics.every(({ code, message }) => !/wake/i.test(code) && !/harness-stage-listen/i.test(message)));
  assert.equal(await readFile(join(root, 'user-file.txt'), 'utf8'), 'preserve');
  const status = execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' });
  assert.match(status, /user-file\.txt/);
  assert.doesNotMatch(status, /stage-result-events/);
  await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
  await writeFile(join(root, '.harness/harness.yaml'), 'agents:\n  provider: codex\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
  const doctor = (doctorEnv = env) => {
    const result = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8', env: doctorEnv });
    return JSON.parse(result.stdout).diagnostics;
  };
  const ponytailWarning = ({ code, path }) => code === 'codex_ponytail_plugin_enabled' && path === userConfig;
  assert.ok(doctor().some(ponytailWarning));
  assert.equal(await readFile(userConfig, 'utf8'), legacyConfig);
  await writeFile(userConfig, legacyConfig.replace('true', 'false'));
  assert.equal(doctor().some(ponytailWarning), false);
  await writeFile(userConfig, legacyConfig);
  for (const command of ['install', 'update']) {
    const result = spawnSync(process.execPath, [cli, command, '--project', root, '--provider', 'claude-code'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
  await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
  await writeFile(join(root, '.harness/harness.yaml'), 'agents:\n  provider: claude-code\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
  assert.equal(doctor({ ...env, HARNESS_PROVIDER_ID: 'claude-code' }).some(ponytailWarning), false);
  assert.equal(await readFile(log, 'utf8'), '', 'install, update, and Doctor need no Codex plugin or MCP commands');
  assert.equal(await readFile(userConfig, 'utf8'), legacyConfig);
  execFileSync('git', ['-C', root, 'check-ignore', '-v', '.harness/src/workflow/stage-checkpoint.mjs']);
  assert.equal(await readFile(join(root, 'user-file.txt'), 'utf8'), 'preserve');
});

test('Doctor preserves tracked project files and no longer checks Wake', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-no-wake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.codex/scripts'), { recursive: true });
  const monitor = '.codex/scripts/codex-monitor.mjs';
  await writeFile(join(root, monitor), 'project owned');
  execFileSync('git', ['-C', root, 'add', monitor]);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await writeFile(join(root, monitor), 'project edit');
  const result = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(result.stdout).diagnostics.some(({ code }) => code === 'codex_wake_unavailable'), false);
  assert.equal(await readFile(join(root, monitor), 'utf8'), 'project edit');
  assert.match(execFileSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' }), /codex-monitor/);
  await assert.rejects(readFile(join(root, '.harness/src/workflow/codex-wake.mjs')), { code: 'ENOENT' });
});

// A user can start a Harness update from either CLI: the public skill reaches both provider skill roots, points at the
// maintenance procedure that exists in the consumer, and stays out of commits like every other managed asset.
test('installed consumer exposes the harness-update skill to Codex and Claude Code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-update-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  for (const directory of ['.agents/skills', '.claude/skills']) {
    const skill = await readFile(join(root, directory, 'harness-update/SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: harness-update\n/);
    assert.match(skill, /harness-maintenance\/GUIDE\.md/);
    assert.ok(await readFile(join(root, '.codex/internal-skills/harness-maintenance/GUIDE.md'), 'utf8'), 'the linked procedure exists');
    execFileSync('git', ['check-ignore', '-q', `${directory}/harness-update/SKILL.md`], { cwd: root });
  }
  assert.match(await readFile(join(root, '.agents/skills/harness-update/agents/openai.yaml'), 'utf8'), /display_name: "Harness Update"/);
  // Doctor reports setup as still missing here; only the skill-exposure and skill-declaration checks matter.
  const doctor = JSON.parse(spawnSync(process.execPath, [join(sourceRoot, 'bin/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(doctor.diagnostics.some(({ code }) => /skill_exposed|skill_declaration/.test(code)), false);
  const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(status, /harness-update|\.agents\/|\.claude\//);
});
