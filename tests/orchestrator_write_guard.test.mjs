import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGuardDecision, shellWrites, patchFiles, ORCHESTRATOR_DOCUMENTS } from '../.codex/scripts/harness-write-guard.mjs';
import { codexWriteGuardHook, codexHookTrustHash, inspectCodexHookTrust, syncCodexSubagentHook } from '../.harness/src/workflow/providers/codex.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { inspectClaudeOrchestratorHook, syncClaudeOrchestratorHook } from '../.claude/harness/installer/claude-orchestrator-hook.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const guardScript = join(sourceRoot, '.codex/scripts/harness-write-guard.mjs');
const patch = (...lines) => `*** Begin Patch\n${lines.join('\n')}\n*** End Patch`;
const noStage = { ...process.env };
delete noStage.HARNESS_SKILL_EXECUTION_ID;

// A workspace the way the compose step leaves it: a git worktree with an active canonical record.
async function workflowWorkspace({ state = 'active', record = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'write-guard-'));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.io'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  if (record) await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ schema_version: 1, state, workspace: root, session_directory: join(root, '.io') }));
  return root;
}
const pre = (root, tool, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's-1', cwd: root, tool_name: tool, tool_use_id: 'call-1', tool_input, ...extra });
const decide = (root, tool, input, env = noStage, extra = {}) => writeGuardDecision(pre(root, tool, input, extra), env);

test('Codex apply_patch writes to product code, tests and contracts are denied with the owning stage named', async () => {
  const root = await workflowWorkspace();
  try {
    // The three real violations: the E2E spec (twice, once absolute), a contract file, and product code.
    for (const lines of [
      [`*** Update File: ${root}/e2e/community.spec.js`, '@@', "-  await expect(owner.getByText(post)).toBeVisible();", "+  await expect(owner.getByRole('paragraph')).toBeVisible();"],
      ['*** Update File: e2e/community.spec.js', '@@', '-a', '+b'],
      ['*** Add File: docs/contracts/product.md', '+# Product'],
      ['*** Add File: docs/contracts/diagrams/ddd.puml', '+@startuml'],
      ['*** Update File: src/main/java/App.java', '@@', '-a', '+b'],
      ['*** Delete File: src/old.js'],
      ['*** Update File: src/a.js', '*** Move to: src/b.js'],
      ['*** Add File: docs/architecture/domain-model.md', '+# Model'],
      ['*** Update File: .codex/scripts/harness-agent-run.mjs', '@@', '-a', '+b'],
      // One allowed file does not excuse a protected one in the same patch.
      ['*** Add File: .io/runtime/plans/p/checkpoint.md', '+ok', '*** Add File: src/sneaky.js', '+x'],
    ]) {
      const reason = decide(root, 'apply_patch', { command: patch(...lines) });
      assert.match(reason ?? '', /orchestrator main session does not write/, lines[0]);
      assert.match(reason, /implement-wrapper/);
      assert.match(reason, /sync-contracts/);
    }
    assert.match(decide(root, 'apply_patch', { command: patch('*** Update File: e2e/community.spec.js', '@@', '-a', '+b') }), /does not write e2e\/community\.spec\.js \(apply_patch\)/);
    // A relative path is resolved from the session's cwd, which may be a subdirectory.
    assert.match(decide(root, 'apply_patch', { command: patch('*** Update File: a.js', '@@', '-a', '+b') }, noStage, { cwd: join(root, 'src') }), /does not write src\/a\.js/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('files under .io, the project guidance documents and paths outside the workspace stay writable', async () => {
  const root = await workflowWorkspace();
  const outside = await mkdtemp(join(tmpdir(), 'write-guard-outside-'));
  try {
    for (const path of [
      '.io/runtime/plans/calc/e2e/checkpoint.md', `${root}/.io/runtime/orchestrator/note.md`, '.io/tmp/anything.txt',
      ...ORCHESTRATOR_DOCUMENTS, `${outside}/notes.md`, '/tmp/scratch.txt',
    ]) {
      assert.equal(decide(root, 'apply_patch', { command: patch(`*** Add File: ${path}`, '+x') }), null, path);
    }
    assert.equal(decide(root, 'apply_patch', { command: patch('*** Add File: ../.io/runtime/x.md', '+x') }, noStage, { cwd: join(root, 'src') }), null, 'a relative path from a subdirectory into .io');
    assert.equal(decide(root, 'apply_patch', { command: patch('*** Add File: ../outside.md', '+x') }, noStage, { cwd: join(root, 'src') }) === null, false, '.. back into the workspace root is still guarded');
    // A symlink inside .io that points at product code cannot hide a write.
    await symlink(join(root, 'src'), join(root, '.io/shortcut'));
    assert.match(decide(root, 'apply_patch', { command: patch('*** Add File: .io/shortcut/App.js', '+x') }) ?? '', /does not write src\/App\.js/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('Claude Code Edit, Write, MultiEdit and NotebookEdit follow the same rule', async () => {
  const root = await workflowWorkspace();
  try {
    for (const [tool, input] of [
      ['Edit', { file_path: `${root}/src/App.java`, old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: `${root}/docs/contracts/architecture.md`, content: 'x' }],
      ['Write', { file_path: 'e2e/community.spec.js', content: 'x' }],
      ['MultiEdit', { file_path: `${root}/src/App.java`, edits: [] }],
      ['NotebookEdit', { notebook_path: `${root}/analysis.ipynb`, new_source: 'x' }],
    ]) assert.match(decide(root, tool, input) ?? '', /orchestrator main session does not write/, `${tool} ${JSON.stringify(input).slice(0, 60)}`);
    for (const [tool, input] of [
      ['Write', { file_path: `${root}/.io/runtime/orchestrator/plan-note.md`, content: 'x' }],
      ['Edit', { file_path: `${root}/docs/agents/testing-guidance.md`, old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: '/tmp/outside-note.md', content: 'x' }],
    ]) assert.equal(decide(root, tool, input), null, `${tool} ${input.file_path}`);
    // Reads and other tools are never guarded.
    for (const tool of ['Read', 'Grep', 'Glob', 'Agent', 'Skill', 'update_plan', 'spawn_agent']) assert.equal(decide(root, tool, { file_path: `${root}/src/App.java` }), null, tool);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shell commands: clearly identifiable writes to protected paths are denied, everything else is left alone', async () => {
  const root = await workflowWorkspace();
  try {
    const denied = [
      'echo "export {}" > e2e/community.spec.js', 'cat >> docs/contracts/product.md <<\'EOF\'\n# More\nEOF', 'printf x | tee src/App.java', 'sed -i "s/a/b/" src/App.java',
      "sed -i.bak -e 's/a/b/' src/a.js src/b.js", 'perl -pi -e "s/a/b/" docs/contracts/architecture.md', 'cp /tmp/new.js src/new.js', 'mv /tmp/new.js e2e/new.js', 'install -m 644 a.txt src/a.txt',
      'dd if=/dev/zero of=src/blob bs=1 count=1', 'truncate -s 0 src/App.java', 'touch src/new.js', 'cd src && echo x > a.js', '/bin/zsh -lc \'echo x > src/a.js\'', 'bash -c "cat file | tee docs/contracts/product.md"',
      'FOO=1 env BAR=2 tee -a src/log.txt', 'node build.mjs 2>&1 > src/out.js', 'apply_patch <<\'PATCH\'\n*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch\nPATCH',
    ];
    for (const command of denied) assert.match(decide(root, 'Bash', { command }) ?? '', /orchestrator main session does not write/, command);
    const allowed = [
      'git status --short', 'node .codex/scripts/harness-context.mjs', 'node .codex/scripts/harness-agent-run.mjs --background true > .io/runtime/run.log 2>&1 &', 'echo hi | tee .io/runtime/x.log',
      'ls src > /dev/null', 'npm test 2>&1 | tail -20', 'echo "a > src/not-a-redirect.js"', "echo 'x > docs/contracts/product.md'", 'cat <<EOF\n> src/inside-a-heredoc.js\nEOF', 'git diff > /tmp/review.diff',
      'sed -n "1,20p" src/App.java', 'sed "s/a/b/" src/App.java', 'cp src/App.java /tmp/App.java', 'echo x > "$OUTPUT"', 'echo x > $(mktemp)', 'cd .io && echo x > note.md', 'tee docs/agents/testing-guidance.md < /tmp/t',
      'cat docs/contracts/product.md', 'ls -la docs/contracts', 'node --test tests/*.test.mjs',
    ];
    for (const command of allowed) assert.equal(decide(root, 'Bash', { command }), null, command);
    // The parser is a pure function of the command text.
    assert.deepEqual(shellWrites('cd src && echo x > a.js; echo y > /tmp/b', { cwd: '/w' }).map((write) => [write.raw, write.cwd]), [['a.js', '/w/src'], ['/tmp/b', '/w/src']]);
    assert.deepEqual(patchFiles(patch('*** Add File: a', '+x', '*** Move to: b')), ['a', 'b']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the guard does not interfere inside stage runners, sub-agents, other workspaces or when switched off', async () => {
  const root = await workflowWorkspace();
  const plain = await workflowWorkspace({ record: false });
  const finished = await workflowWorkspace({ state: 'completed' });
  const write = { command: patch('*** Update File: src/App.java', '@@', '-a', '+b') };
  try {
    assert.match(decide(root, 'apply_patch', write) ?? '', /does not write src\/App\.java/, 'the baseline is denied');
    // A stage runner (and the sub-agents it starts) inherits HARNESS_SKILL_EXECUTION_ID from the runner.
    assert.equal(decide(root, 'apply_patch', write, { ...noStage, HARNESS_SKILL_EXECUTION_ID: 'implement-wrapper-1', HARNESS_WORKSPACE_ROOT: root }), null);
    assert.equal(decide(root, 'Write', { file_path: `${root}/src/App.java`, content: 'x' }, { ...noStage, HARNESS_SKILL_EXECUTION_ID: 'implement-wrapper-1' }), null);
    assert.equal(decide(root, 'Bash', { command: 'echo x > src/App.java' }, { ...noStage, HARNESS_SKILL_EXECUTION_ID: 'implement-wrapper-1' }), null);
    // A payload from a sub-agent carries agent_id (documented for Claude Code PreToolUse).
    assert.equal(decide(root, 'Write', { file_path: `${root}/src/App.java`, content: 'x' }, noStage, { agent_id: 'agent-7', agent_type: 'general-purpose' }), null);
    // No active workflow in the workspace: ordinary use of Codex or Claude Code is untouched.
    assert.equal(decide(plain, 'apply_patch', write), null);
    assert.equal(decide(finished, 'apply_patch', write), null);
    assert.equal(decide(tmpdir(), 'apply_patch', write), null, 'not a git repository');
    // The user can switch the guard off for a session they launch themselves.
    // There is no switch that turns the guard off for the main session.
    assert.equal(decide(root, 'apply_patch', write, { ...noStage, HARNESS_ORCHESTRATOR_WRITE_GUARD: 'off' }) === null, false);
    // Other events and malformed payloads are ignored.
    assert.equal(writeGuardDecision({ ...pre(root, 'apply_patch', write), hook_event_name: 'PostToolUse' }, noStage), null);
    assert.equal(decide(root, 'apply_patch', { command: 42 }), null);
    assert.equal(decide(root, 'apply_patch', null), null);
    assert.equal(writeGuardDecision(null, noStage), null);
  } finally { for (const path of [root, plain, finished]) await rm(path, { recursive: true, force: true }); }
});

test('the script prints the PreToolUse deny decision and stays silent for allowed calls', async () => {
  const root = await workflowWorkspace();
  try {
    const run = (event, env = noStage) => spawnSync(process.execPath, [guardScript], { input: JSON.stringify(event), encoding: 'utf8', env });
    const denied = run(pre(root, 'apply_patch', { command: patch('*** Add File: docs/contracts/product.md', '+x') }));
    assert.equal(denied.status, 0);
    const output = JSON.parse(denied.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /sync-contracts/);
    assert.equal(run(pre(root, 'apply_patch', { command: patch('*** Add File: .io/note.md', '+x') })).stdout, '');
    assert.equal(run(pre(root, 'apply_patch', { command: patch('*** Add File: src/a.js', '+x') }), { ...noStage, HARNESS_SKILL_EXECUTION_ID: 'stage-1' }).stdout, '');
    const garbage = spawnSync(process.execPath, [guardScript], { input: 'not json', encoding: 'utf8', env: noStage });
    assert.equal(garbage.stdout, '');
    assert.equal(garbage.status, 0, 'a hook that cannot read its input must not break the session');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the Codex user hook runs the script only for the main session of an active workflow worktree', async () => {
  const root = await workflowWorkspace();
  const plain = await workflowWorkspace({ record: false });
  try {
    for (const workspace of [root, plain]) {
      await mkdir(join(workspace, '.codex/scripts'), { recursive: true });
      await copyFile(guardScript, join(workspace, '.codex/scripts/harness-write-guard.mjs'));
    }
    const command = codexWriteGuardHook().command;
    const run = (cwd, event, env = noStage) => spawnSync('sh', ['-c', command], { cwd, input: JSON.stringify(event), encoding: 'utf8', env });
    const write = { command: patch('*** Update File: src/App.java', '@@', '-a', '+b') };
    const denied = run(join(root, 'src'), pre(root, 'apply_patch', write));
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny', 'runs from a subdirectory of the worktree');
    assert.equal(JSON.parse(run(root, pre(root, 'Bash', { command: 'echo x > src/App.java' })).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(run(root, pre(root, 'apply_patch', { command: patch('*** Add File: .io/x.md', '+x') })).stdout, '');
    assert.equal(run(root, pre(root, 'update_plan', { plan: [] })).stdout, '', 'tools that cannot write files never reach node');
    assert.equal(run(root, pre(root, 'apply_patch', write), { ...noStage, HARNESS_SKILL_EXECUTION_ID: 'stage-1' }).stdout, '', 'a stage runner is never guarded');
    assert.equal(run(plain, pre(plain, 'apply_patch', write)).stdout, '', 'a workspace without an active workflow');
    assert.equal(run(tmpdir(), pre(tmpdir(), 'apply_patch', write)).stdout, '', 'outside a repository');
    assert.equal(run(tmpdir(), pre(tmpdir(), 'apply_patch', write)).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); await rm(plain, { recursive: true, force: true }); }
});

async function installConsumer(config) {
  const root = await mkdtemp(join(tmpdir(), 'write-guard-consumer-'));
  execFileSync('git', ['init', '-q', root]);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
  await writeFile(join(root, '.harness/harness.yaml'), config);
  return root;
}
const agents = (provider) => `agents:\n  provider: ${provider}\n  ${provider}:\n    high_performance_model: ${provider === 'codex' ? 'gpt-6.1-sol' : 'opus'}\n    high_performance_reasoning_effort: high\n    implementation_model: ${provider === 'codex' ? 'gpt-6-luna' : 'sonnet'}\n    implementation_reasoning_effort: medium\n    execution_model: ${provider === 'codex' ? 'gpt-6-luna' : 'sonnet'}\n    execution_reasoning_effort: low\n    low_performance_model: ${provider === 'codex' ? 'gpt-6-luna' : 'haiku'}\n    low_performance_reasoning_effort: low\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n`;

test('installed Claude consumer registers the guard, Doctor sees a missing or stale registration and update restores it', async () => {
  const root = await installConsumer(agents('claude-code'));
  try {
    const settingsPath = join(root, '.claude/settings.local.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.codex/scripts/harness-write-guard.mjs"', timeout: 10 }] }, { matcher: 'Agent', hooks: [{ type: 'command', command: 'HARNESS_NATIVE_ADMISSION=1 node "${CLAUDE_PROJECT_DIR}/.codex/scripts/harness-agent-admission.mjs"', timeout: 10 }] }]);
    assert.equal((await inspectClaudeOrchestratorHook(root)).valid, true);
    const codes = async () => (await runDoctor({ root, sourceRoot })).diagnostics.map((item) => item.code);
    assert.equal((await codes()).includes('claude_orchestrator_hook_missing'), false);

    // A consumer installed before this release has the other hooks but no PreToolUse guard.
    delete settings.hooks.PreToolUse;
    await writeFile(settingsPath, JSON.stringify(settings));
    assert.equal((await inspectClaudeOrchestratorHook(root)).valid, false);
    assert.equal((await codes()).includes('claude_orchestrator_hook_missing'), true, 'Doctor reports the missing guard');
    await updateProject({ sourceRoot, targetRoot: root });
    assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash', 'update restores it');
    assert.equal((await codes()).includes('claude_orchestrator_hook_missing'), false);

    // A guard registered for the wrong tools is stale, and sync repairs it while keeping other PreToolUse hooks.
    const stale = JSON.parse(await readFile(settingsPath, 'utf8'));
    stale.hooks.PreToolUse[0].matcher = 'Bash';
    stale.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command: 'echo user hook' }] });
    await writeFile(settingsPath, JSON.stringify(stale));
    assert.equal((await inspectClaudeOrchestratorHook(root)).valid, false);
    await syncClaudeOrchestratorHook(root, { noBackup: true });
    const repaired = JSON.parse(await readFile(settingsPath, 'utf8')).hooks.PreToolUse;
    assert.equal((await inspectClaudeOrchestratorHook(root)).valid, true);
    assert.deepEqual(repaired.map((group) => group.matcher), ['Read', 'Edit|Write|MultiEdit|NotebookEdit|Bash', 'Agent'], 'the user hook is preserved');

    // The installed script blocks the orchestrator session of an active worktree, and nothing Harness owns shows in git status.
    await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ schema_version: 1, state: 'active', workspace: root, session_directory: join(root, '.io') }));
    const installed = join(root, '.codex/scripts/harness-write-guard.mjs');
    const run = (event, env = noStage) => spawnSync(process.execPath, [installed], { cwd: root, input: JSON.stringify(event), encoding: 'utf8', env });
    assert.equal(JSON.parse(run(pre(root, 'Write', { file_path: `${root}/src/app.js`, content: 'x' })).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(run(pre(root, 'Write', { file_path: `${root}/.io/note.md`, content: 'x' })).stdout, '');
    assert.equal(run(pre(root, 'Write', { file_path: `${root}/src/app.js`, content: 'x' }), { ...noStage, HARNESS_SKILL_EXECUTION_ID: 'stage-1' }).stdout, '');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/app.js'), 'export const app = true;\n');
    const status = execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });
    assert.match(status, /src\/app\.js/, 'application-owned files stay visible');
    assert.doesNotMatch(status, /\.io\/|\.harness\/src|\.codex\/|\.claude\//, 'Harness-generated files stay out');
    for (const path of ['.codex/scripts/harness-write-guard.mjs', '.claude/settings.local.json']) assert.match(execFileSync('git', ['-C', root, 'check-ignore', '-v', path], { encoding: 'utf8' }), /\.git\/info\/exclude/, path);
    // Doctor lists the guard script among the required execution assets.
    await rm(installed);
    assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing' && /harness-write-guard\.mjs/.test(item.message)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed Codex consumer: Doctor reports the user-level write guard as missing, untrusted, then trusted, and update says so', async () => {
  const root = await installConsumer(agents('codex'));
  const home = await mkdtemp(join(tmpdir(), 'write-guard-codex-home-'));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.ok(await readFile(join(root, '.codex/scripts/harness-write-guard.mjs'), 'utf8').then((text) => text.includes('writeGuardDecision')), 'the script is a managed asset');
    assert.match(execFileSync('git', ['-C', root, 'check-ignore', '-v', '.codex/scripts/harness-write-guard.mjs'], { encoding: 'utf8' }), /\.git\/info\/exclude/);
    const guardDiagnostic = async () => (await runDoctor({ root, sourceRoot })).diagnostics.find((item) => item.code === 'codex_write_guard_hook_untrusted');
    assert.match((await guardDiagnostic()).message, /missing from the Codex user hooks; run setup/);

    // Setup registers the hook in ~/.codex/hooks.json; Codex runs it only after the user trusts it in /hooks.
    assert.equal((await syncCodexSubagentHook({ CODEX_HOME: home })).changed, true);
    const hooks = JSON.parse(await readFile(join(home, 'hooks.json'), 'utf8')).hooks;
    assert.deepEqual(hooks.PreToolUse.flatMap((group) => group.hooks).map((hook) => hook.statusMessage), ['Checking Harness fresh agent', 'Guarding Harness orchestrator writes']);
    assert.match((await guardDiagnostic()).message, /not trusted; run \/hooks in Codex and trust "Guarding Harness orchestrator writes"/);
    const trusted = ['subagent_start', 'subagent_stop'].map((event) => `[hooks.state."${join(home, 'hooks.json')}:${event}:0:0"]\ntrusted_hash = "sha256:${codexHookTrustHash(event, hooks.SubagentStart.at(-1).hooks[0])}"\n`).join('\n');
    await writeFile(join(home, 'config.toml'), `${trusted}\n[hooks.state."${join(home, 'hooks.json')}:pre_tool_use:1:0"]\ntrusted_hash = "sha256:${codexHookTrustHash('pre_tool_use', codexWriteGuardHook())}"\n`);
    assert.equal((await inspectCodexHookTrust({ CODEX_HOME: home })).write_guard, 'trusted');
    assert.equal(await guardDiagnostic(), undefined, 'a trusted guard raises no diagnostic');

    // The update command cannot edit ~/.codex, so it tells the user what is left to do.
    await rm(join(home, 'config.toml'));
    const update = spawnSync(process.execPath, [join(sourceRoot, 'bin/harness-install.mjs'), 'update', '--project', root], { cwd: sourceRoot, encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /Codex user hook "Guarding Harness orchestrator writes" is untrusted: run \$setup/);
  } finally {
    previousHome === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
