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
  const server = join(bin, 'wake.cjs');
  await writeFile(server, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{tools:[{name:'queue_thread'}]}}));});`);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await chmod(join(bin, 'systemctl'), 0o755);
  const codex = join(bin, 'codex');
  await writeFile(codex, `#!/usr/bin/env node\nconst fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n'); if(a.join(' ')==='plugin list --json') console.log(JSON.stringify({installed:[{pluginId:'ponytail@ponytail',enabled:true}]})); else if(a.join(' ')==='plugin marketplace list --json') console.log(JSON.stringify({marketplaces:[{name:'ponytail',marketplaceSource:{source:'https://github.com/DietrichGebert/ponytail.git'}}]})); else if(a.join(' ')==='mcp get codex-wake --json') console.log(JSON.stringify({enabled:!process.env.WAKE_TEST_DISABLED,transport:{type:'stdio',command:process.execPath,args:[${JSON.stringify(server)}],cwd:process.cwd()}}));\n`);
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
  assert.equal(doctor({ ...env, HARNESS_PROVIDER_ID: 'claude-code', WAKE_TEST_DISABLED: '1' }).some((item) => item.code === 'codex_wake_unavailable'), false);
  assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((args) => args[0] === 'mcp' && args[1] === 'get').length, 2);
  assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).some((args) => args[0] === 'plugin' && args.some((arg) => /codex-wake/.test(arg))), false);
  execFileSync('git', ['-C', root, 'check-ignore', '-v', '.harness/src/workflow/stage-result-events.mjs']);
  assert.equal(await readFile(join(root, 'user-file.txt'), 'utf8'), 'preserve');
});

test('installed Doctor preserves tracked project scripts and resolves an enabled local Wake package', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'harness-wake-local-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'codex-home'), bin = join(base, 'bin'), plugin = join(base, 'wake');
  for (const path of [root, home, bin, join(plugin, '.codex-plugin'), join(plugin, 'bin')]) await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.codex/scripts'), { recursive: true });
  const monitor = '.codex/scripts/codex-monitor.mjs';
  await writeFile(join(root, monitor), 'export const projectMonitor = true;\n');
  execFileSync('git', ['-C', root, 'add', monitor]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'project monitor']);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true, provider: 'codex' });
  await updateProject({ sourceRoot, targetRoot: root });
  await writeFile(join(root, monitor), 'export const projectMonitor = false;\n');
  await writeFile(join(root, '.codex/scripts/harness-unregistered.mjs'), 'export {};\n');
  await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  provider: codex\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
  await writeFile(join(home, 'config.toml'), '[plugins."codex-wake@local"]\nenabled = true\n');
  await writeFile(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'codex-wake', mcpServers: './mcp.json' }));
  await writeFile(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { 'codex-wake': { type: 'stdio', command: 'sh', args: ['scripts/run-mcp.sh'], cwd: '.' } } }));
  await mkdir(join(plugin, 'scripts'));
  await writeFile(join(plugin, 'scripts/run-mcp.sh'), `#!/bin/sh\nexec node -e "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{tools:[{name:'queue_thread'}]}}));})"\n`);
  await writeFile(join(plugin, 'bin/codex-wake'), 'existing binary');
  await writeFile(join(plugin, 'bin/codex-wake.sha256'), `${createHash('sha256').update('existing binary').digest('hex')}  codex-wake\n`);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await chmod(join(bin, 'systemctl'), 0o755);
  const log = join(base, 'calls');
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='mcp')process.exit(1);if(a[1]==='marketplace')console.log(JSON.stringify({marketplaces:[{name:'local',root:${JSON.stringify(plugin)},marketplaceSource:{sourceType:'local'}}]}));else console.log(JSON.stringify({installed:[]}));\n`);
  await chmod(join(bin, 'codex'), 0o755);
  const env = { ...process.env, CODEX_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const doctor = () => {
    const result = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8', env });
    return JSON.parse(result.stdout).diagnostics;
  };
  let diagnostics = doctor();
  assert.equal(diagnostics.some((item) => item.code === 'installer_unlocked_file' && item.path.endsWith(monitor)), false);
  assert.equal(diagnostics.some((item) => item.code === 'installer_unlocked_file' && item.path.endsWith('harness-unregistered.mjs')), true);
  assert.equal(diagnostics.some((item) => item.code === 'codex_wake_unavailable'), false);
  const checkWake = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {existingCodexWake} from ${JSON.stringify(new URL('../.harness/src/workflow/codex-wake.mjs', import.meta.url).href)}; console.log(JSON.stringify(await existingCodexWake(process.cwd())))`], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(checkWake().cwd, plugin);
  await writeFile(join(home, 'config.toml'), '[plugins."codex-wake@local"]\nenabled = false\n');
  assert.equal(checkWake(), null);
  assert.equal(doctor().some((item) => item.code === 'codex_wake_unavailable'), true);
  await writeFile(join(home, 'config.toml'), '[plugins."codex-wake@local"]\nenabled = true\n');
  await writeFile(join(plugin, 'bin/codex-wake.sha256'), `${'0'.repeat(64)}  codex-wake\n`);
  assert.equal(checkWake(), null, 'a corrupt binary or checksum must not be used');
  await rm(join(plugin, 'bin/codex-wake'));
  assert.equal(checkWake(), null, 'a missing binary must not trigger automatic installation');
  assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).some((args) => args.includes('add')), false);
  const status = execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' });
  assert.match(status, / M .codex\/scripts\/codex-monitor\.mjs/);
  execFileSync('git', ['-C', root, 'check-ignore', '-q', '.harness/src/workflow/codex-wake.mjs']);
  assert.equal(await readFile(join(root, monitor), 'utf8'), 'export const projectMonitor = false;\n');
});

test('installed setup checks existing Wake in the active Codex home without installing or sending a message', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'wake-setup-health-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'account-home'), bin = join(base, 'bin'), log = join(base, 'rpc.jsonl');
  for (const path of [root, home, bin]) await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await updateProject({ sourceRoot, targetRoot: root });
  await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  provider: codex\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
  await writeFile(join(root, 'app.mjs'), 'application owned\n');
  await mkdir(join(root, 'docs/contracts'), { recursive: true });
  await writeFile(join(root, 'docs/contracts/project.md'), 'project owned\n');
  const server = join(bin, 'wake.cjs');
  await writeFile(server, `const readline=require('node:readline'),fs=require('node:fs');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,home:process.env.CODEX_HOME})+'\\n');if(process.env.WAKE_CLOSED)process.exit(0);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'queue_thread'}]}}));});`);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\n[ -n "$WAKE_SERVICE_HOME" ] || exit 1\nprintf "CODEX_HOME=%s CODEX_WAKE_PLUGIN_BASE=%s\\n" "$WAKE_SERVICE_HOME" "${WAKE_PLUGIN_BASE:-$WAKE_SERVICE_HOME}"\n');
  await chmod(join(bin, 'systemctl'), 0o755);
  const codex = join(bin, 'codex');
  await writeFile(codex, `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.join(' ')==='mcp get codex-wake --json'&&!process.env.WAKE_ABSENT)console.log(JSON.stringify({enabled:true,transport:{type:'stdio',command:process.env.WAKE_WRAPPER?'sh':process.execPath,args:[process.env.WAKE_WRAPPER?'scripts/run-mcp.sh':${JSON.stringify(server)}],cwd:${JSON.stringify(root)},env:process.env.WAKE_NULL_ENV?null:{CODEX_HOME:'/wrong/shared/home'}}}));else process.exit(1);\n`);
  await chmod(codex, 0o755);
  const env = { ...process.env, CODEX_HOME: home, HARNESS_PROVIDER_ID: 'codex', PATH: `${bin}:${process.env.PATH}` };
  const call = (extra = {}) => JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-setup.mjs'), '--root', root, '--check-wake'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(call(), { status: 'available', reason: 'queue_thread_available', codex_home: home, service_check: 'not_detected' });
  const messages = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.map(({ method }) => method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(messages.every(({ home: actual }) => actual === home));
  assert.equal(call({ WAKE_NULL_ENV: '1' }).status, 'available');
  assert.equal(call({ WAKE_SERVICE_HOME: home }).service_check, 'matched');
  assert.deepEqual(call({ WAKE_SERVICE_HOME: '/wrong/shared/home' }), { status: 'unavailable', reason: 'service_codex_home_mismatch', codex_home: home, service_codex_home: '/wrong/shared/home' });
  assert.equal(call({ WAKE_ABSENT: '1' }).reason, 'not_configured_for_active_codex_home');
  assert.equal(call({ WAKE_CLOSED: '1' }).reason, 'mcp_closed');
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/run-mcp.sh'), `#!/bin/sh\ntouch '${join(base, 'must-not-run')}'\n`);
  assert.equal(call({ WAKE_WRAPPER: '1' }).reason, 'existing_wake_binary_missing_or_invalid');
  const loader = `import {existingCodexWake} from ${JSON.stringify(new URL('../.harness/src/workflow/codex-wake.mjs', import.meta.url).href)}; console.log(JSON.stringify(await existingCodexWake(process.cwd())))`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', loader], { cwd: root, env: { ...env, WAKE_WRAPPER: '1' }, encoding: 'utf8' }).trim(), 'null');
  assert.equal(await readFile(join(base, 'must-not-run'), 'utf8').then(() => true, () => false), false);

  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin/codex-wake'), 'verified binary');
  await writeFile(join(root, 'bin/codex-wake.sha256'), `${createHash('sha256').update('verified binary').digest('hex')}  codex-wake\n`);
  await writeFile(join(root, 'scripts/run-mcp.sh'), `#!/bin/sh\nexec '${process.execPath}' '${server}'\n`);
  const mismatched = call({ WAKE_WRAPPER: '1', WAKE_SERVICE_HOME: home, WAKE_PLUGIN_BASE: '/wrong/shared/plugin' });
  assert.equal(mismatched.reason, 'service_plugin_path_mismatch');
  assert.equal(mismatched.plugin_path, root);

  const doctor = (extra = {}) => JSON.parse(spawnSync(process.execPath, [join(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }).stdout).diagnostics;
  assert.equal(doctor().some(({ code }) => code === 'codex_wake_unavailable'), false);
  assert.match(doctor({ WAKE_SERVICE_HOME: '/wrong/shared/home' }).find(({ code }) => code === 'codex_wake_unavailable').message, /service_codex_home_mismatch/);
  const closed = doctor({ WAKE_CLOSED: '1' }).find(({ code }) => code === 'codex_wake_unavailable');
  assert.match(closed.message, /mcp_closed/);
  assert.ok(closed.message.includes(home));
  assert.deepEqual(call({ HARNESS_PROVIDER_ID: 'claude-code' }), { status: 'skipped', reason: 'not_codex' });
  assert.equal(await readFile(join(root, 'app.mjs'), 'utf8'), 'application owned\n');
  const status = execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' });
  assert.match(status, /app\.mjs/);
  assert.match(status, /docs\/contracts\/project\.md/);
  assert.doesNotMatch(status, /codex-wake\.mjs/);
  execFileSync('git', ['-C', root, 'check-ignore', '-q', '.harness/src/workflow/codex-wake.mjs']);
});
