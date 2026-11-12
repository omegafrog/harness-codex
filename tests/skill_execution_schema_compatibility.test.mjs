import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateProject, discoverManagedAssetPaths } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { join } from 'node:path';
import test from 'node:test';
import { writeOutputSchema } from '../.harness/src/workflow/output-schema.mjs';

const schemas = '.codex/internal-skills/skill-execution/schemas';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('flow schemas expose only the questions array', async () => {
  const files = await readdir(join(schemas, 'flows'));
  for (const file of files.filter((name) => name.endsWith('.schema.json'))) {
    const schema = await readJson(join(schemas, 'flows', file));
    assert.equal(Object.hasOwn(schema.properties, 'question'), false, file);
    assert.ok(schema.properties.questions);
    assert.ok(schema.required.includes('questions'));
    const item = schema.properties.questions.items;
    assert.ok(item.required.includes('title'), file);
    assert.equal(Object.hasOwn(item.properties, 'question'), false, file);
  }
});

test('generated output schemas expose questions without a singular result field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-output-schema-'));
  try {
    for (const skill of ['spec-me', 'workflow-compose']) {
      const path = join(directory, `${skill}.schema.json`);
      await writeOutputSchema({ root: process.cwd(), input: { execution_id: 'check', skill }, prefix: 'runtime/executions/check', path });
      const schema = await readJson(path);
      assert.equal(Object.hasOwn(schema.properties, 'execution_id'), false);
      assert.equal(Object.hasOwn(schema.properties.result.properties, 'execution_id'), false);
      assert.equal(Object.hasOwn(schema, 'anyOf'), false);
      assert.equal(Object.hasOwn(schema.properties.status, 'description'), false);
      assert.equal(Object.hasOwn(schema.properties.result.properties, 'question'), false);
      assert.equal(schema.properties.result.required.includes('question'), false);
      assert.ok(Object.hasOwn(schema.properties.result.properties, 'questions'));
      assert.ok(schema.properties.result.required.includes('questions'));
      const item = schema.properties.result.properties.questions.items;
      assert.ok(item.required.includes('title'));
      assert.equal(Object.hasOwn(item.properties, 'question'), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('implementation stages must declare unplanned additions in their structured result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-unplanned-schema-'));
  try {
    const generate = async (skill) => {
      const path = join(directory, `${skill}.schema.json`);
      await writeOutputSchema({ root: process.cwd(), input: { execution_id: 'check', skill }, prefix: 'runtime/executions/check', path });
      return (await readJson(path)).properties.result;
    };
    for (const skill of ['implement', 'implement-wrapper']) {
      const result = await generate(skill);
      assert.ok(result.required.includes('unplanned_additions'), skill);
      assert.deepEqual(result.properties.unplanned_additions.items.required, ['id', 'summary', 'evidence', 'benefit', 'cost', 'rule_impact', 'plain_explanation']);
      assert.ok(result.required.includes('commit_request'), skill);
      assert.equal(Object.hasOwn(result.properties, 'commit_sha'), false);
    }
    const other = await generate('to-ticket');
    assert.equal(Object.hasOwn(other.properties, 'unplanned_additions'), false);
    assert.equal(other.required.includes('unplanned_additions'), false);
    assert.equal(Object.hasOwn(other.properties, 'commit_request'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider output schemas keep Claude hints out of the Codex contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-provider-schema-'));
  try {
    const input = { execution_id: 'provider-check', skill: 'spec-me' };
    for (const provider of ['codex', 'claude-code']) await writeOutputSchema({ root: process.cwd(), input, prefix: 'runtime/executions/provider-check', path: join(directory, `${provider}.json`), provider });
    const codex = await readJson(join(directory, 'codex.json'));
    const claude = await readJson(join(directory, 'claude-code.json'));
    assert.equal(Object.hasOwn(codex.properties.status, 'description'), false);
    assert.match(claude.properties.status.description, /Keep status and code paired/);
    assert.equal(Object.hasOwn(claude, 'anyOf'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('input context types canonical and legacy profile keys', async () => {
  const schema = await readJson(join(schemas, 'input.schema.json'));
  for (const key of ['agent_profile', 'role']) {
    assert.equal(schema.properties.context.properties[key].type, 'string');
    assert.match('spec_document_writer', new RegExp(schema.properties.context.properties[key].pattern));
  }
});

test('installed stage accepts changed documents while preserving review snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-mutable-artifact-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    const managedAssets = await discoverManagedAssetPaths(sourceRoot);
    assert.ok(managedAssets.includes('.codex/agents/tracker_publisher.toml'));
    assert.ok(managedAssets.includes('.codex/scripts/harness-agent-run.mjs'));
    assert.ok(managedAssets.includes('.claude/harness/scripts/harness-claude-orchestrator.mjs'));
    assert.ok(managedAssets.includes('.codex/scripts/harness-output-schema.mjs'));
    assert.ok(managedAssets.includes('.codex/internal-skills/skill-execution/references/stage-return.md'));
    assert.ok(managedAssets.includes('.harness/src/workflow/providers/index.mjs'));
    assert.ok(managedAssets.includes('.harness/src/workflow/providers/codex.mjs'));
    assert.ok(managedAssets.includes('.claude/harness/providers/claude-code.mjs'));
    assert.ok(managedAssets.includes('.claude/agents/spec_reviewer.md'));
    assert.ok(managedAssets.includes('.claude/skills/orchestrator/SKILL.md'));
    assert.ok(managedAssets.includes('.codex/internal-skills/tracker-publish/GUIDE.md'));
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    for (const path of ['.codex/internal-skills/technology-selection/GUIDE.md', '.codex/internal-skills/skill-execution/references/workflow-map.md']) {
      assert.ok((await readFile(join(root, path), 'utf8')).length > 0);
      execFileSync('git', ['check-ignore', '-v', path], { cwd: root });
    }
    for (const provider of ['.agents', '.claude']) {
      await assert.rejects(readFile(join(root, provider, 'skills/technology-selection/SKILL.md')), { code: 'ENOENT' });
      assert.match(await readFile(join(root, provider, 'skills/orchestrator/SKILL.md'), 'utf8'), /workflow-map\.md/);
      assert.ok((await readFile(join(root, provider, 'skills/orchestrator/../../../.codex/internal-skills/skill-execution/references/workflow-map.md'), 'utf8')).length > 0);
      assert.ok((await readFile(join(root, provider, 'skills/spec-me/references/../../../../.codex/internal-skills/technology-selection/GUIDE.md'), 'utf8')).length > 0);
    }
    const { validateSkillInput, validateSkillReturn } = await import(`file://${join(root, '.harness/src/workflow/skill-execution.mjs')}`);
    const { inspectClaudeOrchestratorHook } = await import(`file://${join(root, '.claude/harness/installer/claude-orchestrator-hook.mjs')}`);
    const codex = await import(`file://${join(root, '.harness/src/workflow/providers/codex.mjs')}`);
    await writeFile(join(root, 'app.txt'), 'application');
    execFileSync('git', ['add', 'app.txt'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: root });
    const linked = join(root, '.io/linked');
    await mkdir(join(root, '.io'), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-qb', 'linked', linked], { cwd: root });
    await mkdir(join(root, '.beads'), { recursive: true });
    await mkdir(join(linked, '.beads'), { recursive: true });
    await mkdir(join(linked, '.codex'), { recursive: true });
    await writeFile(join(linked, '.codex/harness.yaml'), 'beads:\n  enabled: true\ntracker:\n  mode: github\n');
    const stageOptions = { root: linked, resumeWriteDirs: [], binding: { model: 'model', reasoning_effort: 'medium' }, schemaPath: '/schema', output: '/output', skill: 'implement-wrapper', env: { HOME: root } };
    const writableArgs = await codex.buildCommand({ ...stageOptions, sandbox: 'workspace-write' });
    assert.ok(writableArgs.some((arg, index) => arg === '--add-dir' && writableArgs[index + 1] === root));
    const commonGitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: linked, encoding: 'utf8' }).trim();
    assert.ok(writableArgs.some((arg, index) => arg === '--add-dir' && writableArgs[index + 1] === commonGitDir));
    const readonlyArgs = await codex.buildCommand({ ...stageOptions, sandbox: 'read-only' });
    assert.ok(!readonlyArgs.includes('--add-dir'));
    await writeFile(join(linked, 'app.txt'), 'application change');
    const linkedStatus = execFileSync('git', ['status', '--short'], { cwd: linked, encoding: 'utf8' });
    assert.match(linkedStatus, /app\.txt/);
    assert.doesNotMatch(linkedStatus, /\.codex/);
    execFileSync('git', ['check-ignore', '.codex/harness.yaml'], { cwd: linked });
    const claude = await import(`file://${join(root, '.claude/harness/providers/claude-code.mjs')}`);
    const providers = await import(`file://${join(root, '.harness/src/workflow/providers/index.mjs')}`);
    const { writeOutputSchema: writeInstalledOutputSchema } = await import(`file://${join(root, '.harness/src/workflow/output-schema.mjs')}`);
    assert.equal(providers.configuredProvider({ agents: { provider: 'claude-code' } }), 'claude-code');
    assert.equal((await providers.loadProvider('claude-code')).id, 'claude-code');
    const installedSchemaPath = join(root, '.io/runtime/executions/installed-claude/return.schema.json');
    await writeInstalledOutputSchema({ root, input: { execution_id: 'installed-claude', skill: 'spec-me' }, prefix: 'runtime/executions/installed-claude', path: installedSchemaPath, provider: 'claude-code' });
    const installedSchema = await readJson(installedSchemaPath);
    assert.match(installedSchema.properties.status.description, /Keep status and code paired/);
    const reviewSchema = installedSchema.properties.result.properties.review_request.anyOf.find((item) => item.type === 'object');
    assert.ok(!reviewSchema.properties.skill.enum.includes('spec-review'));
    assert.ok(reviewSchema.properties.skill.enum.includes('architecture-review'));
    assert.match(reviewSchema.properties.context_path.description, /session-relative JSON/);
    assert.equal(codex.id, 'codex');
    const codexHome = join(root, '.io/codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.victorialogs]\ncommand = "victorialogs-mcp"\n\n[mcp_servers.figwright]\ncommand = "figwright"\n');
    const resumeWriteDir = join(root, '.io/resume-write');
    const codexArgs = await codex.buildCommand({ root, sandbox: 'workspace-write', resumeWriteDirs: [resumeWriteDir], binding: { model: 'model', reasoning_effort: 'medium' }, schemaPath: '/session/schema.json', output: '/session/return.json', resume: 'resume-session', role: 'frontend_designer', skill: 'frontend-design', env: { HOME: root, CODEX_HOME: codexHome } });
    const hasPair = (flag, value) => codexArgs.some((arg, index) => arg === flag && codexArgs[index + 1] === value);
    for (const [flag, value] of [['--sandbox', 'workspace-write'], ['--add-dir', resumeWriteDir], ['--cd', root], ['--model', 'model'], ['-c', 'model_reasoning_effort="medium"'], ['-c', 'approval_policy="never"'], ['-c', 'features.image_generation=true'], ['-c', 'features.view_image=true'], ['-c', 'web_search="live"'], ['--output-schema', '/session/schema.json'], ['--output-last-message', '/session/return.json'], ['resume', 'resume-session']]) {
      assert.ok(hasPair(flag, value), `Codex args include ${flag} ${value}`);
    }
    const modelInstructions = codexArgs[codexArgs.indexOf('-c', codexArgs.indexOf('web_search="live"')) + 1];
    assert.match(modelInstructions, /^model_instructions_file=/);
    assert.ok(modelInstructions.includes('.codex/internal-skills/skill-execution/worker-base.md'));
    const mcpConfig = codexArgs.filter((arg) => arg.startsWith('mcp_servers='));
    assert.deepEqual(mcpConfig, ['mcp_servers={"victorialogs"={enabled=false}}']);
    assert.ok(codexArgs.includes('multi_agent'));
    assert.equal(codexArgs.at(-1), '-');
    assert.equal(claude.id, 'claude-code');
    assert.match(claude.skillPrompt('spec-me', 'Read input.json.'), /spec-me.*Skill tool.*Read input\.json\./);
    const claudeAgent = await readFile(join(root, '.claude/agents/spec_reviewer.md'), 'utf8');
    assert.match(claudeAgent, /^---\nname: spec_reviewer\n/);
    assert.match(claudeAgent, /permissionMode: plan/);
    assert.match(claudeAgent, /tools: Read, Grep, Glob, WebSearch, WebFetch/);
    assert.match(claudeAgent, /You are the spec_reviewer agent/);
    assert.equal((await inspectClaudeOrchestratorHook(root)).valid, true);
    const claudeHook = JSON.parse(execFileSync(process.execPath, [join(root, '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs')], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: '123e4567-e89b-12d3-a456-426614174000' }), encoding: 'utf8' }));
    assert.match(claudeHook.hookSpecificOutput.additionalContext, /"provider":"claude-code"/);
    const claudeArgs = claude.buildCommand({ root, sandbox: 'workspace-write', binding: { model: 'sonnet', reasoning_effort: 'medium' }, schema: { type: 'object' }, resume: null });
    assert.ok(claudeArgs.includes('--json-schema'));
    const settings = JSON.parse(claudeArgs[claudeArgs.indexOf('--settings') + 1]);
    assert.deepEqual(settings.sandbox, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    assert.equal(settings.hooks.SubagentStart.length, 1);
    assert.equal(settings.hooks.SubagentStop.length, 1);
    assert.equal(claudeArgs[claudeArgs.indexOf('--permission-mode') + 1], 'acceptEdits');
    const fakeBin = join(root, '.io/fake-bin');
    await mkdir(fakeBin, { recursive: true });
    const fakeClaude = join(fakeBin, 'claude');
    const fakeSession = '123e4567-e89b-12d3-a456-426614174000';
    await writeFile(fakeClaude, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
    await chmod(fakeClaude, 0o755);
    const launcher = join(root, '.claude/harness/scripts/harness-claude-orchestrator.mjs');
    for (const args of [['continue'], ['--resume', fakeSession, 'continue']]) {
      const forwarded = JSON.parse(execFileSync(process.execPath, [launcher, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }));
      assert.deepEqual(forwarded, ['-p', '--permission-mode', 'bypassPermissions', ...args]);
    }
    const conflictingMode = spawnSync(process.execPath, [launcher, '--permission-mode', 'acceptEdits', 'continue'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
    assert.equal(conflictingMode.status, 2);
    await writeFile(fakeClaude, `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${fakeSession}"}' '{"type":"result","subtype":"success","session_id":"${fakeSession}","structured_output":{"ok":true}}'\n`);
    await chmod(fakeClaude, 0o755);
    const claudeOutput = join(root, '.io/claude-result.json');
    let capturedSession;
    const claudeResult = await claude.run({ root, args: [], prompt: 'prompt', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, output: claudeOutput, onStart: async () => {}, onSession: async (id) => { capturedSession = id; } });
    assert.equal(claudeResult.code, 0);
    assert.equal(claudeResult.sessionId, fakeSession);
    assert.equal(capturedSession, fakeSession);
    assert.deepEqual(await readJson(claudeOutput), { ok: true });
    await assert.rejects(claude.run({ root, args: [], prompt: 'prompt', requiredSkill: 'spec-me', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, output: join(root, '.io/no-skill.json'), onStart: async () => {} }), /Claude did not invoke the required skill: spec-me/);
    await writeFile(fakeClaude, `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${fakeSession}"}' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call-1","name":"Skill","input":{"skill":"spec-me"}}]}}' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1"}]}}' '{"type":"result","subtype":"success","session_id":"${fakeSession}","structured_output":{"ok":true}}'\n`);
    const skillEvents = [];
    await claude.run({ root, args: [], prompt: 'prompt', requiredSkill: 'spec-me', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, output: join(root, '.io/skill.json'), onStart: async () => {}, onEvent: (event) => skillEvents.push(event) });
    assert.ok(skillEvents.some((event) => event.event === 'skill_invoked' && event.skill === 'spec-me'));
    await writeFile(fakeClaude, `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${fakeSession}"}' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call-1","name":"Skill","input":{"skill":"spec-me"}}]}}' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","is_error":true}]}}' '{"type":"result","subtype":"success","session_id":"${fakeSession}","structured_output":{"ok":true}}'\n`);
    await assert.rejects(claude.run({ root, args: [], prompt: 'prompt', requiredSkill: 'spec-me', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, output: join(root, '.io/failed-skill.json'), onStart: async () => {} }), /Claude did not invoke the required skill: spec-me/);
    await writeFile(fakeClaude, "#!/bin/sh\nprintf 'startup failure on stdout\\n'\nexit 1\n");
    let rawStdout = '';
    const events = [];
    const failedClaude = await claude.run({ root, args: [], prompt: 'prompt', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, output: claudeOutput, onStart: async () => {}, onStdout: (data) => { rawStdout += data; }, onEvent: (event) => events.push(event) });
    assert.equal(failedClaude.code, 1);
    assert.equal(failedClaude.sessionId, null);
    assert.match(rawStdout, /startup failure on stdout/);
    assert.ok(events.some((event) => event.event === 'session_observed' && !event.present));
    await writeFile(fakeClaude, `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${fakeSession}"}' '{"type":"result","subtype":"success","session_id":"${fakeSession}","permission_denials":[{"tool_name":"Read","tool_input":{"file_path":"${root}/../other/input.json"}}],"structured_output":{"ok":true}}'\n`);
    const deniedEvents = [];
    await claude.run({ root, args: [], prompt: 'prompt', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, output: join(root, '.io/denial.json'), onStart: async () => {}, onEvent: (event) => deniedEvents.push(event) });
    assert.ok(deniedEvents.some((event) => event.event === 'permission_denied' && event.within_workspace === false && event.workspace === root));
    const session = join(root, '.io');
    await mkdir(session, { recursive: true });
    execFileSync(process.execPath, [join(root, '.codex/scripts/harness-agent-event.mjs')], { cwd: root, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_SKILL_EXECUTION_ID: 'claude-stage' }, input: JSON.stringify({ hook_event_name: 'SubagentStart', session_id: fakeSession, agent_id: 'agent-review-1', agent_type: 'spec_reviewer' }) });
    execFileSync(process.execPath, [join(root, '.codex/scripts/harness-agent-event.mjs')], { cwd: root, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_SKILL_EXECUTION_ID: 'claude-stage' }, input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: fakeSession, agent_id: 'agent-review-1', agent_type: 'spec_reviewer', last_assistant_message: 'Review passed' }) });
    const agentEvents = (await readFile(join(session, 'runtime/executions/claude-stage/subagents.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(agentEvents.map(({ event, agent_id, result }) => ({ event, agent_id, result })), [
      { event: 'SubagentStart', agent_id: 'agent-review-1', result: undefined },
      { event: 'SubagentStop', agent_id: 'agent-review-1', result: 'Review passed' },
    ]);
    const path = 'product-spec.md';
    const originalHash = createHash('sha256').update('original').digest('hex');
    await writeFile(join(root, path), 'revised');
    const reference = { base: 'workspace', path, kind: 'product-spec', sha256: originalHash };
    const input = { schema_version: 1, execution_id: 'stage-1', skill: 'spec-me', workspace_root: root, session_directory: session, scope: 'calculator', input_refs: [reference] };
    const result = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', summary: 'Updated', artifacts: [reference], questions: [], review_request: null };
    const envelope = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', result_ref: 'runtime/executions/stage-1/result.json', result };
    await validateSkillInput({ root, input });
    assert.equal((await validateSkillReturn({ root, input, envelope })).valid, true);
    const revision = { ...result, status: 'action_required', code: 'SPEC_REVISION_REQUIRED' };
    assert.equal((await validateSkillReturn({ root, input, envelope: { ...envelope, status: revision.status, code: revision.code, result: revision } })).valid, true);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, status: 'blocked', code: revision.code, result: { ...revision, status: 'blocked' } } }), /Return status\/code mismatch/);
    const premature = { ...result, status: 'action_required', code: 'REVIEW_REQUIRED', review_request: { skill: 'spec-review', agent_profile: 'spec_adversarial_reviewer', purpose: 'Review', context_path: 'docs/specs/example/' } };
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, status: premature.status, code: premature.code, result: premature } }), /spec-me must perform spec-review internally/);
    const badContext = { ...premature, review_request: { ...premature.review_request, skill: 'architecture-review', agent_profile: 'default' } };
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, status: badContext.status, code: badContext.code, result: badContext } }), /Review context must be an existing session-relative JSON file/);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, status: 'action_required' } }), /Return status\/code mismatch/);
    await rm(join(root, path));
    await assert.rejects(validateSkillInput({ root, input }), { code: 'ENOENT' });
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'consumer owned');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.harness\/src\/|\.codex\//);
    assert.doesNotMatch(status, /\.claude\//);
    execFileSync('git', ['check-ignore', '-v', '.harness/src/workflow/providers/codex.mjs'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.claude/harness/scripts/harness-claude-orchestrator.mjs'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.claude/harness/providers/claude-code.mjs'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.claude/agents/spec_reviewer.md'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.claude/skills/orchestrator/SKILL.md'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.claude/settings.local.json'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.harness/src/workflow/skill-execution.mjs'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.harness/src/workflow/execution-context.mjs'], { cwd: root });
    assert.equal((await readFile(join(root, '.harness/src/workflow/execution-context.mjs'), 'utf8')).includes('buildStagePrompt'), true);
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    const returnContractPath = join(root, '.codex/internal-skills/skill-execution/references/stage-return.md');
    const returnContract = await readFile(returnContractPath, 'utf8');
    assert.match(returnContract, /`action_required` \/ `SPEC_REVISION_REQUIRED`/);
    execFileSync('git', ['check-ignore', '-v', returnContractPath], { cwd: root });
    await rm(returnContractPath);
    const missingReturnContract = await runDoctor({ root, sourceRoot });
    assert.ok(missingReturnContract.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith('/stage-return.md')));
    await writeFile(returnContractPath, returnContract);
    await rm(join(root, '.harness/src/workflow/execution-context.mjs'));
    const missingExecutionContext = await runDoctor({ root, sourceRoot });
    assert.ok(missingExecutionContext.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith('/execution-context.mjs')));
    await rm(join(root, '.harness/src/workflow/startup-state.mjs'));
    const missingStartup = await runDoctor({ root, sourceRoot });
    assert.ok(missingStartup.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith('/startup-state.mjs')));
    await rm(join(root, '.harness/src/workflow/providers/codex.mjs'));
    const missingProvider = await runDoctor({ root, sourceRoot });
    assert.ok(missingProvider.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith('/providers/codex.mjs')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed execution input resolves to the linked worktree, not the source checkout', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'harness-path-boundary-'));
  const root = join(parent, 'source'), tree = join(parent, 'linked');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    await mkdir(root);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial']);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'test-path', tree]);
    const { writeExecutionInput, executionInputAbsolutePath } = await import(`file://${join(root, '.harness/src/workflow/execution-input.mjs')}`);
    const input = { execution_id: 'execution-1', skill: 'spec-me' };
    const relativePath = await writeExecutionInput(tree, input, 'plan-1');
    await writeExecutionInput(root, input, 'plan-1');
    assert.equal(await executionInputAbsolutePath(tree, input.execution_id), join(tree, relativePath));
    assert.notEqual(await executionInputAbsolutePath(tree, input.execution_id), join(root, relativePath));
    const { inspectWorkspace } = await import(`file://${join(root, '.harness/src/eval/workspace-preflight.mjs')}`);
    assert.equal((await inspectWorkspace({ workspaceRoot: tree, cwd: tree })).valid, true);
    assert.equal((await inspectWorkspace({ workspaceRoot: tree, cwd: root })).reason, 'cwd_mismatch');
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'application-owned');
    assert.match(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), /docs\/agents\/EXEC\.md/);
    execFileSync('git', ['check-ignore', '-q', '.harness/src/workflow/execution-input.mjs'], { cwd: root });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('installed result validation accepts safe directory artifacts and keeps consumer changes visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-directory-artifact-'));
  let outside;
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    await mkdir(join(root, '.io'), { recursive: true });
    await mkdir(join(root, 'docs/specs/example/architecture-decisions'), { recursive: true });
    await writeFile(join(root, 'docs/specs/example/architecture-decisions/DEC-01.yaml'), 'decision: accepted\n');
    outside = await mkdtemp(join(tmpdir(), 'harness-outside-artifact-'));
    await symlink(outside, join(root, 'outside-artifacts'));
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'consumer-owned guidance\n');

    const { validateSkillInput, validateSkillReturn } = await import(`file://${join(root, '.harness/src/workflow/skill-execution.mjs')}`);
    const reference = { base: 'workspace', path: 'docs/specs/example/architecture-decisions/', kind: 'architecture-decisions', sha256: null };
    const input = { schema_version: 1, execution_id: 'spec-1', skill: 'spec-me', workspace_root: root, session_directory: join(root, '.io'), scope: 'calculator', input_refs: [reference] };
    const result = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', summary: 'Specs ready', artifacts: [reference], questions: [], review_request: null };
    const envelope = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', result_ref: 'runtime/executions/spec-1/result.json', result };

    await validateSkillInput({ root, input });
    assert.equal((await validateSkillReturn({ root, input, envelope })).valid, true);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, result: { ...result, artifacts: [{ ...reference, path: '../outside' }] } } }), /relative without traversal/);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, result: { ...result, artifacts: [{ ...reference, path: 'outside-artifacts/' }] } } }), /workspace|outside|escape/i);

    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.harness\/src\/|\.codex\//);
    execFileSync('git', ['check-ignore', '-q', '.harness/src/workflow/skill-execution.mjs'], { cwd: root });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  }
});


test('installed plan review abort uses its requested attempt ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-review-abort-install-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const { updateReviewAttempt } = await import(`file://${join(root, '.harness/src/workflow/review-attempts.mjs')}`);
    const first = await updateReviewAttempt({ root, scope: 'plan-sample', action: 'begin', inputs: { plan: 'hash' } });
    const cli = join(root, '.codex/scripts/harness-plan-review.mjs');
    const result = JSON.parse(execFileSync(process.execPath, [cli, 'abort', '--root', root, '--plan-set', 'sample', '--attempt', first.attempt_id, '--reason', 'review interrupted'], { cwd: root, encoding: 'utf8' }));
    assert.equal(result.reason, 'aborted');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(status, /\.harness\/src\/workflow\/review-attempts|\.codex\/scripts\/harness-plan-review|\.io\/runtime\/reviews/);
    assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fresh install and update use consolidated flow schemas and Doctor inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-schema-install-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    const managed = await discoverManagedAssetPaths(sourceRoot);
    const flowSchemas = managed.filter((path) => path.startsWith('.codex/internal-skills/skill-execution/schemas/flows/'));
    assert.deepEqual(flowSchemas.map((path) => path.split('/').at(-1)).sort(), ['common.schema.json', 'plan-review.schema.json', 'spec-review.schema.json']);

    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const oldSchema = '.codex/internal-skills/skill-execution/schemas/flows/eli5.schema.json';
    const oldContent = 'legacy managed flow schema';
    await mkdir(join(root, oldSchema, '..'), { recursive: true });
    await writeFile(join(root, oldSchema), oldContent);
    const lockPath = join(root, '.codex/harness-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const hash = createHash('sha256').update(oldContent).digest('hex');
    lock.files[oldSchema] = { installed_sha256: hash, upstream_sha256: hash, source_path: oldSchema };
    await writeFile(lockPath, JSON.stringify(lock));

    const updated = await updateProject({ sourceRoot, targetRoot: root });
    assert.ok(updated.retired.includes(oldSchema));
    await assert.rejects(readFile(join(root, oldSchema)), { code: 'ENOENT' });
    assert.equal(await readFile(join(updated.backup_directory, oldSchema), 'utf8'), oldContent);
    for (const name of ['common.schema.json', 'plan-review.schema.json', 'spec-review.schema.json']) {
      const schema = await readJson(join(root, '.codex/internal-skills/skill-execution/schemas/flows', name));
      assert.equal(Object.hasOwn(schema.properties, 'question'), false);
      assert.ok(schema.required.includes('questions'));
    }
    // The stage return contract owns the question format; skills no longer restate it.
    const returnContractText = await readFile(join(root, '.codex/internal-skills/skill-execution/references/stage-return.md'), 'utf8');
    assert.match(returnContractText, /`result\.questions`에 \[질문 스키마\]/);
    assert.match(returnContractText, /질문이 하나여도 배열에 담고 질문 문장은 `title`에 쓴다/);
    for (const skill of ['grilling', 'spec-me']) {
      const instructions = await readFile(join(root, '.codex/internal-skills', skill, 'GUIDE.md'), 'utf8');
      assert.match(instructions, /stage (return contract|반환 계약)/);
      assert.doesNotMatch(instructions, /결과의 `question`에/);
    }
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'project owned');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.harness\/src\//);
    execFileSync('git', ['check-ignore', '-v', '.codex/internal-skills/skill-execution/schemas/flows/common.schema.json'], { cwd: root });
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed to-ticket uses skill binding and records a fresh review against the full current snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-to-ticket-install-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  codex:\n    high_performance_model: gpt-6.1-sol\n    high_performance_reasoning_effort: high\n');

    const installedRuntime = `file://${join(root, '.harness/src/workflow')}`;
    const { loadNamedWorkflow } = await import(`${installedRuntime}/loader.mjs`);
    const { resolveSkillBinding, resolveWorkflowStage, resolveAgentSandbox, validateSkillInput } = await import(`${installedRuntime}/skill-execution.mjs`);
    const session = join(root, '.io');
    await mkdir(session, { recursive: true });
    const publishInput = { schema_version: 1, execution_id: 'publish-1', skill: 'tracker-publish', scope: 'publish', input_refs: [], workspace_root: root, session_directory: session, context: {} };
    await assert.rejects(validateSkillInput({ root, input: publishInput }), /User publication approval is required/);
    await assert.rejects(validateSkillInput({ root, input: { ...publishInput, context: { publication_approved: false } } }), /User publication approval is required/);
    await validateSkillInput({ root, input: { ...publishInput, context: { publication_approved: true } } });
    const { prepareStageInput } = await import(`${installedRuntime}/stage-input.mjs`);
    await mkdir(join(session, 'runtime/orchestrator'), { recursive: true });
    const statePath = join(session, 'runtime/orchestrator/state.json');
    await writeFile(statePath, JSON.stringify({ schema_version: 1, stages: { 'workflow-compose': { status: 'completed' }, 'to-ticket': { status: 'running' } } }));
    await assert.rejects(prepareStageInput({ root, session, stageId: 'tracker-publish' }), /user publication approval are required/);
    await assert.rejects(prepareStageInput({ root, session, stageId: 'tracker-publish', publicationApproved: true }), /Completed to-ticket/);
    const workflow = await loadNamedWorkflow('to-ticket', { root });
    assert.deepEqual(workflow.stages.map(({ id }) => id), ['to-ticket', 'tracker-publish', 'plan-pr']);
    assert.deepEqual(workflow.stages[1].needs, ['to-ticket']);
    assert.ok(workflow.stages.every((stage) => !Object.hasOwn(stage, 'model_tier')));
    assert.equal((await resolveSkillBinding({ root, skill: 'to-ticket', workflow: 'to-ticket', stage: 'to-ticket' })).model_tier, 'high_performance');
    assert.equal((await resolveSkillBinding({ root, skill: 'tracker-publish', workflow: 'to-ticket', stage: 'tracker-publish' })).model_tier, 'high_performance');
    const publisherProfile = await readFile(join(root, '.codex/agents/tracker_publisher.toml'), 'utf8');
    assert.match(publisherProfile, /dedicated tracker publisher/);
    assert.match(publisherProfile, /sandbox_mode = "danger-full-access"/);
    assert.deepEqual(await resolveAgentSandbox({ root, input: { skill: 'to-ticket' }, workflow: 'to-ticket', stage: 'to-ticket' }), { profile: 'to_ticket', sandbox: 'workspace-write' });
    assert.deepEqual(await resolveAgentSandbox({ root, input: { skill: 'tracker-publish' }, workflow: 'to-ticket', stage: 'tracker-publish' }), { profile: 'tracker_publisher', sandbox: 'danger-full-access' });
    const inferredStage = await resolveWorkflowStage({ root, input: { skill: 'tracker-publish', context: { stage_id: 'tracker-publish' } } });
    assert.deepEqual(inferredStage, { workflow: 'to-ticket', stage: 'tracker-publish' });
    await assert.rejects(resolveWorkflowStage({ root, input: { skill: 'tracker-publish', context: { stage_id: 'to-ticket' } }, workflow: 'to-ticket', stage: 'tracker-publish' }), /does not match the execution input/);
    assert.equal((await resolveSkillBinding({ root, skill: 'tracker-publish', ...inferredStage })).model_tier, 'high_performance');
    assert.deepEqual(await resolveAgentSandbox({ root, input: { skill: 'tracker-publish' }, ...inferredStage }), { profile: 'tracker_publisher', sandbox: 'danger-full-access' });
    await assert.rejects(resolveWorkflowStage({ root, input: { skill: 'tracker-publish', context: { stage_id: 'missing-stage' } } }).then((stage) => resolveAgentSandbox({ root, input: { skill: 'tracker-publish' }, ...stage })), /only as the to-ticket workflow stage/);
    const workflowDir = join(root, '.codex/workflows');
    const duplicateWorkflow = join(workflowDir, 'to-ticket-copy.yaml');
    const toTicketManifest = await readFile(join(workflowDir, 'to-ticket.yaml'), 'utf8');
    await writeFile(duplicateWorkflow, toTicketManifest.replace('id: to-ticket\n', 'id: to-ticket-copy\n'));
    await assert.rejects(resolveWorkflowStage({ root, input: { skill: 'tracker-publish', context: { stage_id: 'tracker-publish' } } }), /Workflow stage is ambiguous/);
    await rm(duplicateWorkflow);
    const toTicketInstructions = await readFile(join(root, '.codex/internal-skills/to-ticket/GUIDE.md'), 'utf8');
    assert.match(toTicketInstructions, /separate `tracker-publish` workflow stage/);
    const publisherInstructions = await readFile(join(root, '.codex/internal-skills/tracker-publish/GUIDE.md'), 'utf8');
    assert.match(publisherInstructions, /dedicated workflow executor stage/);
    assert.match(publisherInstructions, /publication journal/);
    const publishInstructions = await readFile(join(root, '.codex/internal-skills/to-ticket/references/github-batch-publish.md'), 'utf8');
    assert.match(publishInstructions, /별도 `tracker-publish` workflow stage/);
    const installedReviewSchema = await readJson(join(root, '.codex/internal-skills/plan-review/review-record.schema.json'));
    assert.deepEqual(installedReviewSchema.required, ['schema_version', 'attempt_id', 'plan_set_id', 'reviewer_id', 'author_ids', 'fork_turns', 'verdict', 'findings']);

    const planRoot = join(root, 'docs/plans/sample');
    const specRoot = join(root, 'docs/specs/sample');
    await mkdir(planRoot, { recursive: true });
    await mkdir(join(specRoot, 'diagrams'), { recursive: true });
    await writeFile(join(planRoot, 'plans.md'), '- Product Spec: `docs/specs/sample/product-spec.md`\n- Architecture Spec: `docs/specs/sample/architecture-spec.md`\n- [plan](slice.md)\n');
    await writeFile(join(planRoot, 'slice.md'), '---\nstatus: planned\n---\n# Slice\n');
    await writeFile(join(specRoot, 'product-spec.md'), '![diagram](diagrams/flow.svg)\n');
    await writeFile(join(specRoot, 'architecture-spec.md'), '# Architecture\n');
    await writeFile(join(specRoot, 'diagrams/flow.svg'), '<svg>reviewed</svg>\n');

    const cli = join(root, '.codex/scripts/harness-plan-review.mjs');
    const begin = JSON.parse(execFileSync(process.execPath, [cli, 'begin', '--root', root, '--plan-set', 'sample'], { cwd: root, encoding: 'utf8' }));
    assert.equal(begin.inputs['docs/specs/sample/diagrams/flow.svg'], undefined);
    const reviewsDirectory = join(root, '.io/runtime/reviews');
    await mkdir(reviewsDirectory, { recursive: true });
    const reviewPath = join(reviewsDirectory, 'result.json');
    await writeFile(reviewPath, JSON.stringify({
      schema_version: 1,
      attempt_id: begin.attempt_id,
      plan_set_id: 'sample',
      reviewer_id: 'native-plan-reviewer-1',
      author_ids: ['plan-split-execution-1'],
      fork_turns: 'none',
      verdict: 'pass',
      findings: [],
    }));
    const recorded = JSON.parse(execFileSync(process.execPath, [cli, 'record', '--root', root, '--plan-set', 'sample', '--attempt', begin.attempt_id, '--reviews', 'runtime/reviews/result.json'], { cwd: root, encoding: 'utf8' }));
    assert.equal(recorded.status, 'pass');
    const currentReview = JSON.parse(execFileSync(process.execPath, [cli, 'check', '--root', root, '--plan-set', 'sample', '--phase', 'planning'], { cwd: root, encoding: 'utf8' }));
    assert.equal(currentReview.status, 'pass');
    assert.equal(currentReview.details.review_attempt_id, begin.attempt_id);
    await writeFile(join(root, '.codex/harness.yaml'), 'tracker:\n  mode: github\n  github:\n    project_owner: owner\n    project_number: 1\n    status_field: Workflow Status\n');
    const { updatePublication, verifyDraftPublication } = await import(`${installedRuntime}/../tracker/publication.mjs`);
    assert.equal((await updatePublication({ root, planSetId: 'sample', planId: '@parent', action: 'begin' })).status, 'pending');
    await updatePublication({ root, planSetId: 'sample', planId: '@parent', action: 'record', itemId: 'parent' });
    assert.equal((await updatePublication({ root, planSetId: 'sample', planId: '@parent', action: 'begin' })).status, 'already_created');
    await updatePublication({ root, planSetId: 'sample', planId: 'slice', action: 'begin' });
    await assert.rejects(updatePublication({ root, planSetId: 'sample', planId: 'slice', action: 'begin' }), /ambiguous/);
    await updatePublication({ root, planSetId: 'sample', planId: 'slice', action: 'record', itemId: 'child' });
    const run = async (args) => {
      if (args[1] === 'view') return JSON.stringify({ id: 'project' });
      if (args[1] === 'field-list') return JSON.stringify({ fields: [{ id: 'field', name: 'Workflow Status', type: 'ProjectV2SingleSelectField' }] });
      return JSON.stringify({ data: { nodes: ['parent', 'child'].map((id, index) => ({ id, project: { id: 'project' }, content: { __typename: 'DraftIssue', title: index ? 'slice' : 'sample', body: '' }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'Planned', field: { id: 'field' } }] } })) } });
    };
    await verifyDraftPublication({ root, planSetId: 'sample', run });
    await assert.rejects(verifyDraftPublication({ root, planSetId: 'sample', run: async (args) => args[0] === 'api' ? JSON.stringify({ errors: [{ message: 'missing' }] }) : run(args) }), /Incomplete draft verification/);

    await writeFile(join(specRoot, 'diagrams/flow.svg'), '<svg>changed</svg>\n');
    await writeFile(join(planRoot, 'slice.md'), '---\nstatus: in-progress\n---\n# Slice\n');
    assert.equal(JSON.parse(execFileSync(process.execPath, [cli, 'check', '--root', root, '--plan-set', 'sample', '--phase', 'planning'], { cwd: root, encoding: 'utf8' })).status, 'pass');
    execFileSync('git', ['check-ignore', '-v', '.harness/src/workflow/plan-review.mjs'], { cwd: root });
    const reviewStatus = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(reviewStatus, /docs\/plans\/sample\/slice.md/);
    assert.doesNotMatch(reviewStatus, /\.harness\/src\//);
    await writeFile(join(specRoot, 'architecture-spec.md'), '# Architecture changed\n');
    let stale;
    try {
      execFileSync(process.execPath, [cli, 'check', '--root', root, '--plan-set', 'sample', '--phase', 'planning'], { cwd: root, encoding: 'utf8' });
      assert.fail('stale plan review should be blocked');
    } catch (error) {
      assert.equal(error.status, 1);
      stale = JSON.parse(error.stdout.toString());
    }
    assert.equal(stale.status, 'blocked');

    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    assert.equal(doctor.diagnostics.some((item) => ['dangerous_sandbox_scope', 'tracker_publisher_stage_missing', 'tracker_publisher_sandbox'].includes(item.code)), false);
    const toTicketProfilePath = join(root, '.codex/agents/to_ticket.toml');
    const toTicketProfile = await readFile(toTicketProfilePath, 'utf8');
    await writeFile(toTicketProfilePath, toTicketProfile.replace('sandbox_mode = "workspace-write"', 'sandbox_mode = "danger-full-access"'));
    const unsafeDoctor = await runDoctor({ root, sourceRoot });
    assert.ok(unsafeDoctor.diagnostics.some((item) => item.code === 'dangerous_sandbox_scope'));
    await writeFile(toTicketProfilePath, toTicketProfile);
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'consumer-owned setup\n');
    await mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/application-note.md'), 'consumer-owned\n');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.match(status, /\.harness\/application-note\.md/);
    assert.doesNotMatch(status, /\.codex\/agents\/tracker_publisher\.toml|\.codex\/internal-skills\/(to-ticket|tracker-publish)\/|\.codex\/scripts\/harness-plan-review\.mjs|\.harness\/src\/workflow\/plan-review\.mjs|\.io\/runtime\/reviews/);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.codex/agents/tracker_publisher.toml'], { cwd: root, encoding: 'utf8' }), /\.codex/);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.codex/internal-skills/tracker-publish/GUIDE.md'], { cwd: root, encoding: 'utf8' }), /\.codex\/internal-skills/);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.io/runtime/reviews/result.json'], { cwd: root, encoding: 'utf8' }), /\.io/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
