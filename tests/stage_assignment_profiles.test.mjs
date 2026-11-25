import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSourceContent } from '../.harness/src/installer/transforms.mjs';
import { STAGE_CONTRACT } from '../.harness/src/installer/stage-contract.mjs';
import { FRESH_AGENT_TYPES, freshAgentDecision, helperBinding } from '../.harness/scripts/harness-fresh-agent.mjs';
import { SOLO_STAGE_SKILLS, stageAgentProfile } from '../.harness/src/workflow/stage-runtime.mjs';
import { buildAssignment, writeAssignmentFile } from '../.harness/src/workflow/stage-assignment.mjs';
import { spawnInstruction } from '../.harness/src/workflow/stage-cli.mjs';
import { consumerWorkflow, sourceRoot } from './support/consumer-workflow.mjs';

const read = (path) => readFile(join(sourceRoot, path), 'utf8');
const scratch = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'harness-assign-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('solo stages run on the profile without Agent, only for Claude Code, and only with the profile installed', async (t) => {
  const root = await scratch(t);
  assert.equal(await stageAgentProfile({ root, profile: null, skill: 'bounded-context', provider: 'claude-code' }), 'workflow_stage', 'an install without the solo profile keeps workflow_stage');
  await mkdir(join(root, '.codex/agents'), { recursive: true });
  await writeFile(join(root, '.codex/agents/workflow_stage_solo.toml'), 'name = "workflow_stage_solo"\n');
  for (const skill of SOLO_STAGE_SKILLS) assert.equal(await stageAgentProfile({ root, profile: null, skill, provider: 'claude-code' }), 'workflow_stage_solo', skill);
  for (const skill of SOLO_STAGE_SKILLS) assert.equal(await stageAgentProfile({ root, profile: null, skill, provider: 'codex' }), 'workflow_stage', `${skill} on Codex`);
  for (const skill of ['stakeholder-analysis', 'event-storming', 'domain-model', 'tactical-technology']) assert.equal(await stageAgentProfile({ root, profile: null, skill, provider: 'claude-code' }), 'workflow_stage', skill);
  assert.equal(await stageAgentProfile({ root, profile: 'to_ticket', skill: 'bounded-context', provider: 'claude-code' }), 'to_ticket', 'a declared role is kept');
});

test('no solo stage GUIDE delegates to a helper agent', async () => {
  for (const skill of SOLO_STAGE_SKILLS) {
    const text = await read(`.harness/internal-skills/${skill}/GUIDE.md`);
    assert.doesNotMatch(text, /code_researcher|diagram_creator|stakeholder_persona|code-research/, `${skill} delegates`);
  }
});

test('the solo profile differs from workflow_stage only by name and by the Agent tool', async () => {
  const stage = await read('.codex/agents/workflow_stage.toml'), solo = await read('.codex/agents/workflow_stage_solo.toml');
  assert.equal(solo.replaceAll('workflow_stage_solo', 'workflow_stage').replace(/^description = .*$/m, ''), stage.replace(/^description = .*$/m, ''));
  assert.match(solo, /^sandbox_mode = "workspace-write"$/m);
  assert.match(solo, /\[skills\]\ninclude_instructions = false/);
  const withAgent = transformSourceContent(Buffer.from(stage), 'claude-agent-v1'), without = transformSourceContent(Buffer.from(solo), 'claude-agent-v1');
  assert.match(withAgent, /^tools: Bash, Read, Edit, Write, Agent$/m);
  assert.match(without, /^tools: Bash, Read, Edit, Write$/m);
  assert.match(without, /^name: workflow_stage_solo$/m);
  assert.ok(without.includes(STAGE_CONTRACT.slice(0, 200)), 'the stage contract is injected');
  for (const type of ['workflow_stage', 'workflow_stage_solo']) assert.ok(FRESH_AGENT_TYPES.includes(type));
  assert.match(await read('.harness/src/workflow/execution-audit.mjs'), /'workflow_stage', 'workflow_stage_solo'/);
});

test('the stage contract delegates code research only to a worker that has Agent and points at the assignment file', () => {
  assert.match(STAGE_CONTRACT, /Code research: when you have the Agent tool and need facts/);
  assert.match(STAGE_CONTRACT, /Without the Agent tool you cannot delegate:.*`blocked`\/`DEPENDENCY_INCOMPLETE`/);
  assert.match(STAGE_CONTRACT, /when the caller gives an `assignment_path`, read only that file/);
});

test('a Codex start writes one 0600 assignment file with the Claude worker content and the Codex submission rules', async (t) => {
  const { workspace } = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const run = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-native-stage.mjs'), 'launch', '--stage-id', 'stakeholder-analysis'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const launched = JSON.parse(run.stdout);
  assert.equal(launched.assignment_path, join(workspace, '.io/runtime/executions', launched.execution_id, 'assignment.md'));
  assert.equal((await stat(launched.assignment_path)).mode & 0o777, 0o600);
  const text = await readFile(launched.assignment_path, 'utf8');
  for (const part of ['<guide>', '<input>', '<schema>', '<reference path=']) assert.ok(text.includes(part), part);
  assert.ok(text.includes(`- execution_id: ${launched.execution_id}`));
  assert.match(text, /exact `receive_command` the caller gave you/);
  assert.doesNotMatch(text, /there is no receive command/);
  assert.match(launched.next.spawn, /only assignment_path .*receive_command/);
  // The Claude prompt is built from the same content: only the submission paragraphs differ.
  const claude = buildAssignment(workspace, { ...launched, stage_id: 'stakeholder-analysis' }, { provider: 'claude-code' });
  assert.ok(claude.includes('there is no receive command'));
  const body = (value) => value.slice(value.indexOf('<guide>'), value.lastIndexOf('\n\n'));
  assert.equal(body(claude), body(text));
  // An older execution has no file: the launch fields still carry the paths.
  assert.ok(launched.guide && launched.input_path && launched.schema_path);
  assert.doesNotMatch(spawnInstruction({ agent_profile: 'workflow_stage', binding: { provider: 'codex' } }), /assignment_path/);
});

test('the assignment file is never written through a link', async (t) => {
  const root = await scratch(t);
  const session = join(root, '.io'), directory = join(session, 'runtime/executions/e1');
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'target.txt'), 'keep');
  await symlink(join(root, 'target.txt'), join(directory, 'assignment.md'));
  await assert.rejects(writeAssignmentFile({ session, executionId: 'e1', directory, text: 'x' }));
  assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'keep');
});

test('a helper agent of a workflow worktree must start with the configured low-tier model and effort', async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, '.io'), { recursive: true });
  await writeFile(join(root, '.io/worktree.json'), '{}');
  await mkdir(join(root, '.harness/internal-skills/code-research'), { recursive: true });
  await mkdir(join(root, '.harness/internal-skills/stakeholder-persona'), { recursive: true });
  for (const skill of ['code-research', 'stakeholder-persona']) await writeFile(join(root, `.harness/internal-skills/${skill}/GUIDE.md`), '---\nmodel_tier: low_performance\n---\n# x\n');
  const yaml = (model) => `agents:\n  provider: codex\n  claude-code:\n    low_performance_model: other\n    low_performance_reasoning_effort: high\n  codex:\n    low_performance_model: ${model} # cheap\n    low_performance_reasoning_effort: "low"\n`;
  await writeFile(join(root, '.harness/harness.yaml'), yaml('gpt-6-luna'));
  const spawn = (agent_type, extra = {}, cwd = root) => freshAgentDecision({ hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', cwd, tool_input: { agent_type, fork_turns: 'none', ...extra } });
  assert.deepEqual(helperBinding('code_researcher', root), { model: 'gpt-6-luna', reasoning_effort: 'low' });
  for (const type of ['code_researcher', 'stakeholder_persona']) {
    assert.match(spawn(type), /model "gpt-6-luna" and reasoning_effort "low"/);
    assert.match(spawn(type, { model: 'gpt-6.1-sol', reasoning_effort: 'low' }), /received model gpt-6.1-sol/);
    assert.equal(spawn(type, { model: 'gpt-6-luna', reasoning_effort: 'low' }), null);
  }
  await mkdir(join(root, 'sub/dir'), { recursive: true });
  assert.equal(spawn('code_researcher', { model: 'gpt-6-luna', reasoning_effort: 'low' }, join(root, 'sub/dir')), null, 'a subdirectory resolves the worktree');
  assert.match(spawn('code_researcher', {}, join(root, 'sub/dir')), /gpt-6-luna/);
  assert.equal(spawn('plan_reviewer'), null, 'other fresh types are not bound');
  assert.match(spawn('plan_reviewer', { fork_turns: 'all' }), /fresh context/);
  assert.match(spawn('code_researcher', { fork_turns: undefined }), /fresh context/);
  // Anything unreadable allows the start.
  assert.equal(spawn('code_researcher', {}, tmpdir()), null, 'outside a workflow worktree');
  await writeFile(join(root, '.harness/harness.yaml'), 'agents: [');
  assert.equal(spawn('code_researcher'), null, 'no configured binding');
  await rm(join(root, '.harness/harness.yaml'));
  assert.equal(spawn('code_researcher'), null, 'config missing');
  await writeFile(join(root, '.harness/harness.yaml'), yaml('changed-model'));
  assert.match(spawn('code_researcher', { model: 'gpt-6-luna', reasoning_effort: 'low' }), /changed-model/, 'a later setup change applies at once');
});
