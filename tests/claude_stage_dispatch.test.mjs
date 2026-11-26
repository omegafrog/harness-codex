import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { explainError, finishNext, withDispatchHint } from '../.harness/src/workflow/stage-cli.mjs';
import { extractSubmission, inlineSchema, parseStageCall, shellSplit } from '../.harness/src/workflow/claude-stage-dispatch.mjs';
import { parseYaml } from '../.harness/src/eval/yaml.mjs';
import { consumerWorkflow, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { PRE_SPEC_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { withDecisionContext } from './support/decision-question.mjs';

const REQUEST = '게시글 삭제 기능을 추가해줘';
const SKIPPED = (analysis) => ({ files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: `생략: stakeholder-analysis 판정 생략 (${analysis})\n둘째 줄\n셋째 줄\n넷째 줄` });

// The orchestrator's Agent call, and the Claude Code hook events around it, as the hooks receive them on stdin.
async function claudeFlow(t) {
  const flow = await consumerWorkflow(t, REQUEST, { provider: 'claude-code' });
  const { workspace } = flow;
  const { session_id: session } = JSON.parse(await readFile(join(workspace, '.io/worktree.json'), 'utf8')).agent_sessions.orchestrator;
  const run = (script, event, env = {}) => spawnSync(process.execPath, [join(workspace, script)], { cwd: workspace, input: JSON.stringify({ session_id: session, cwd: workspace, ...event }), encoding: 'utf8', env: { ...process.env, ...env } });
  const json = (result) => result.stdout.trim() ? JSON.parse(result.stdout) : null;
  let counter = 0;
  const hooks = {
    // PreToolUse(Agent): what the admission hook answers for one Agent call.
    admit: (prompt, extra = {}) => {
      const toolUseId = `toolu_${++counter}`;
      const result = run('.claude/harness/scripts/harness-agent-admission.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: toolUseId, tool_input: { subagent_type: 'workflow_stage', description: 'stage', prompt }, ...extra }, { HARNESS_NATIVE_ADMISSION: '1' });
      assert.equal(result.status, 0, result.stderr);
      const out = json(result);
      return { toolUseId, out, decision: out?.hookSpecificOutput?.permissionDecision, reason: out?.hookSpecificOutput?.permissionDecisionReason, updated: out?.hookSpecificOutput?.updatedInput };
    },
    start: (agentId, agentType = 'workflow_stage') => run('.harness/scripts/harness-agent-event.mjs', { hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: agentType }),
    stop: (agentId, message, extra = {}) => run('.harness/scripts/harness-agent-event.mjs', { hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'workflow_stage', stop_hook_active: false, ...(message === undefined ? {} : { last_assistant_message: message }), ...extra }),
    result: (toolUseId, text = 'the worker\'s whole final message', extra = {}) => {
      const result = run('.claude/harness/scripts/harness-agent-result.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: toolUseId, tool_input: {}, tool_response: { status: 'completed', agentId: 'x', content: [{ type: 'text', text }], usage: { input_tokens: 1 } }, ...extra });
      assert.equal(result.status, 0, result.stderr);
      return json(result)?.hookSpecificOutput?.updatedToolOutput ?? null;
    },
  };
  const state = async () => JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  const outputPath = (executionId) => join(workspace, '.io/runtime/executions', executionId, 'output.json');
  // What the worker's final message is: the result JSON its stage would write (the shared helper writes it to the output file).
  const finalMessage = async (stage, executionId, result) => {
    await flow.submitStage({ stage, started: { output_path: outputPath(executionId) } }, result);
    const text = await readFile(outputPath(executionId), 'utf8');
    await writeFile(outputPath(executionId), '');
    return text;
  };
  return { ...flow, session, hooks, state, outputPath, finalMessage };
}
const executionOf = (prompt) => /execution_id: (\S+)/.exec(prompt)[1];

test('the stage call line is parsed: stage and options, @body for long text, answer for the reply', () => {
  assert.deepEqual(shellSplit(`a --b 'c d' "e \\"f\\""`), ['a', '--b', 'c d', 'e "f"']);
  assert.deepEqual(parseStageCall('harness-stage: tactical-code --plan T-1').args, ['--stage-id', 'tactical-code', '--plan', 'T-1']);
  assert.deepEqual(parseStageCall('harness-stage: requirements-fix --feedback @body\n수정: "경계"는 \'그대로\'\n둘째 줄').args, ['--stage-id', 'requirements-fix', '--feedback', '수정: "경계"는 \'그대로\'\n둘째 줄']);
  assert.deepEqual(parseStageCall('harness-stage: answer\n1번 A, 2번 B').args, ['--answer-text', '1번 A, 2번 B']);
  assert.deepEqual(parseStageCall('harness-stage: revise requirements-fix\n신고 규칙 문구를 바꿔 주세요').args, ['--revise-text', '신고 규칙 문구를 바꿔 주세요', '--revise-stage', 'requirements-fix']);
  assert.deepEqual(parseStageCall('harness-stage: revise\n신고 규칙 문구를 바꿔 주세요').args, ['--revise-text', '신고 규칙 문구를 바꿔 주세요']);
  assert.deepEqual(parseStageCall('harness-stage: answer\n[{"question_id":"q","option_id":"a"}]\n첫째').args, ['--answer-text', '첫째', '--choices', '[{"question_id":"q","option_id":"a"}]']);
  assert.throws(() => parseStageCall('harness-stage: answer\n[{"question_id":"q","option_id":"a"}]'), /reply/);
  assert.deepEqual(parseStageCall('harness-stage: approve\n좋아 가자').args, ['--answer-text', '좋아 가자', '--intent', 'approve']);
  assert.deepEqual(parseStageCall('harness-stage: recommended\n다 추천대로 해').args, ['--answer-text', '다 추천대로 해', '--intent', 'recommended']);
  assert.throws(() => parseStageCall('harness-stage: approve'), /needs the user's reply/);
  assert.throws(() => parseStageCall('harness-stage: revise'), /needs the user's change request/);
  assert.equal(parseStageCall('Run the stage please'), null);
  assert.equal(parseStageCall(undefined), null);
  assert.throws(() => parseStageCall('harness-stage: answer'), /needs the user's reply/);
  assert.throws(() => parseStageCall('harness-stage: Not A Stage'), /first line/);
  assert.throws(() => parseStageCall("harness-stage: x --feedback 'open"), /Unclosed quote/);
  assert.equal(extractSubmission('{"a":1}'), '{"a":1}');
  assert.equal(extractSubmission('다음이 결과입니다.\n```json\n{"a":1}\n```\n끝'), '{"a":1}');
  assert.equal(extractSubmission('결과 없음'), null);
  assert.equal(extractSubmission('[1,2]'), null);
});

test('one Agent call runs a stage: the hooks launch, bind, record the final message and hand back a compact envelope', async (t) => {
  const flow = await claudeFlow(t);
  const { workspace, hooks, treeGit, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const head = treeGit('rev-parse', 'HEAD').trim();

  // PreToolUse(Agent): launch ran and the call became the stage worker with its binding and paths; the orchestrator named only the stage.
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  assert.equal(call.decision, 'allow', call.reason);
  assert.equal(call.updated.subagent_type, 'workflow_stage');
  assert.equal(call.updated.model, 'sonnet');
  assert.equal(call.updated.effort, 'medium');
  assert.equal(call.updated.run_in_background, false);
  const id = executionOf(call.updated.prompt);
  for (const part of [`workspace_root: ${workspace}`, 'guide: ', 'input_path: ', 'schema_path: ', 'document_draft_root: ', 'There is no receive command']) assert.match(call.updated.prompt, new RegExp(part.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&').replace('There is', 'there is')), part);
  assert.doesNotMatch(call.updated.prompt, /receive_command:/);
  assert.match(call.updated.prompt, /<reference path="\.harness\/internal-skills\/stakeholder-analysis\/references\/output-template\.md">/, 'the stage template is inlined');
  assert.match(call.updated.prompt, /references included below must not be read again/);
  assert.match(call.updated.prompt.split('\n').at(-1), /^After your last document write, your next output is the final JSON text itself, with no tool call in between/, 'the no-op sentence is the last line');
  // What the launch fixes is in the prompt: the guide, the input with the workspace facts, and the schema without its rarely used shapes.
  const block = (name) => new RegExp(`\\n<${name}>\\n([\\s\\S]*)\\n</${name}>`).exec(call.updated.prompt)[1];
  assert.match(block('guide'), /context\.workspace\.preflight/);
  assert.doesNotMatch(block('guide'), /model_tier/);
  const { workspace: facts } = JSON.parse(block('input')).context;
  assert.equal(facts.preflight.valid, true);
  assert.equal(facts.head, head);
  assert.equal(facts.persona_binding.skill, 'stakeholder-persona', 'the persona binding is in the input, so the GUIDE runs no binding command');
  assert.ok(facts.persona_binding.model && facts.persona_binding.reasoning_effort);
  assert.ok([...facts.documents.existing, ...facts.documents.absent].includes(analysis));
  const schemaPath = /schema_path: (\S+)/.exec(call.updated.prompt)[1];
  const full = await readFile(schemaPath, 'utf8'), inlined = block('schema');
  assert.equal(full.trim(), JSON.stringify(JSON.parse(full)), 'the stored schema is compact');
  // stakeholder-analysis asks by design: its question items stay inline so the worker needs no extra read; review_request is stripped.
  const inlinedSchema = JSON.parse(inlined);
  assert.ok(inlinedSchema.properties.result.properties.questions.items.properties.options, 'question items are inline');
  assert.equal(inlinedSchema.properties.result.properties.review_request.properties, undefined, 'review_request is stripped');
  assert.ok(inlined.length < full.length, `${inlined.length} of ${full.length}`);
  assert.ok(JSON.parse(full).properties.result.properties.questions.items, 'the stored schema keeps the question shape');
  assert.deepEqual(JSON.parse(inlined), inlineSchema(JSON.parse(full)));
  let stage = (await flow.state()).stages['stakeholder-analysis'];
  assert.equal(stage.status, 'running');
  assert.equal(stage.native_managed, true);
  assert.equal(stage.native_agent_id, undefined, 'the real agent id is not known before the worker starts');

  // SubagentStart: bound to the agent id of the event, which the worker is told.
  const started = hooks.start('agent-real-1');
  assert.equal(started.status, 0, started.stderr);
  const context = JSON.parse(started.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, 'SubagentStart');
  assert.match(context.additionalContext, new RegExp(`agent_id agent-real-1`));
  assert.match(context.additionalContext, /harness-native-command\.mjs --root .* --agent-id agent-real-1 --/);
  stage = (await flow.state()).stages['stakeholder-analysis'];
  assert.equal(stage.native_agent_id, 'agent-real-1');
  assert.equal(stage.execution_id, id);
  // The worker's code research runs on the configured low tier in the foreground; the same call from the main session is not rewritten.
  const research = (extra) => hooks.admit('Find the owners of posts', { tool_input: { subagent_type: 'code_researcher', description: 'research', prompt: 'Find the owners of posts' }, ...extra });
  const { updated: researcher } = research({ agent_id: 'agent-real-1', agent_type: 'workflow_stage' });
  const lowTier = parseYaml(await readFile(join(workspace, '.harness/harness.yaml'), 'utf8')).agents['claude-code'];
  assert.equal(researcher.model, lowTier.low_performance_model);
  assert.equal(researcher.run_in_background, false);
  assert.equal(researcher.prompt, 'Find the owners of posts');
  assert.equal(research({}).updated, undefined);
  const persona = (extra, model) => hooks.admit('Interview as persona', { tool_input: { subagent_type: 'stakeholder_persona', description: 'persona', prompt: 'Interview as persona', ...(model ? { model } : {}) }, ...extra });
  assert.equal(persona({ agent_id: 'agent-real-1', agent_type: 'workflow_stage' }).updated.model, lowTier.low_performance_model);
  const overridden = persona({ agent_id: 'agent-real-1', agent_type: 'workflow_stage' }, 'sonnet').updated;
  assert.equal(overridden.model, lowTier.low_performance_model, 'the configured binding overrides a passed model');
  assert.equal(overridden.run_in_background, false);
  assert.equal(research({ agent_id: 'agent-real-1', agent_type: 'workflow_stage' }).updated.model, lowTier.low_performance_model);
  assert.equal(persona({}, 'sonnet').updated, undefined, 'a main-session call is not rewritten');
  const gapReview = (extra, model) => hooks.admit('Review the requirements', { tool_input: { subagent_type: 'requirements_gap_reviewer', description: 'gap review', prompt: 'Review the requirements', ...(model ? { model } : {}) }, ...extra });
  const reviewed = gapReview({ agent_id: 'agent-real-1', agent_type: 'workflow_stage' }, 'opus').updated;
  assert.equal(reviewed.model, lowTier.implementation_model, 'the gap reviewer runs on the configured Claude Code tier whatever model is passed');
  assert.equal(reviewed.run_in_background, false);
  assert.equal(gapReview({}, 'opus').updated, undefined, 'a main-session call is not rewritten');
  // A second start of the same profile has no reserved execution left and binds nothing.
  assert.equal(hooks.start('agent-intruder').stdout, '');
  assert.equal((await flow.state()).stages['stakeholder-analysis'].native_agent_id, 'agent-real-1');

  // SubagentStop: the final message is received and finished by the hook; the worker is not sent back.
  const message = await flow.finalMessage('stakeholder-analysis', id, SKIPPED(analysis));
  const stopped = hooks.stop('agent-real-1', message);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '', 'a recorded result lets the worker stop');
  stage = (await flow.state()).stages['stakeholder-analysis'];
  assert.equal(stage.status, 'completed');
  assert.equal(stage.code, 'OK');
  assert.equal(stage.native_finished, true);
  assert.notEqual(treeGit('rev-parse', 'HEAD').trim(), head, 'the runner committed the stage documents');

  // PostToolUse(Agent): the orchestrator receives Harness's envelope, not the worker's message.
  const output = hooks.result(call.toolUseId, message);
  const text = output.content[0].text;
  assert.ok(Buffer.byteLength(text) <= 900, `the envelope is ${Buffer.byteLength(text)} bytes`);
  const envelope = JSON.parse(text);
  assert.equal(envelope.status, 'completed');
  assert.equal(envelope.code, 'OK');
  assert.equal(envelope.stage_id, 'stakeholder-analysis');
  assert.equal(envelope.execution_id, id);
  assert.ok(envelope.summary.length <= 6, 'the summary is at most six lines');
  assert.deepEqual(envelope.artifacts, [analysis]);
  assert.match(envelope.next, /^Next stage: Agent\(subagent_type: "workflow_stage", prompt: "harness-stage: subdomain-candidates"\)$/);
  for (const key of Object.keys(envelope)) assert.ok(['status', 'code', 'stage_id', 'execution_id', 'summary', 'artifacts', 'next'].includes(key), key);
  assert.equal(output.status, 'completed', 'the rest of the Agent response is kept');
  assert.equal(output.usage.input_tokens, 1);
  assert.equal(hooks.result('toolu_unknown'), null, 'an Agent call that was not a stage dispatch is left alone');
  const records = await readdir(join(workspace, '.io/runtime/claude-dispatch'));
  assert.ok(records.some((name) => name === `${call.toolUseId}.json`));
});

test('a format or gate error goes back to the same worker, which answers again; a transcript recovers a lost final message', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  const id = executionOf(call.updated.prompt);
  hooks.start('agent-fix-1');

  // Not the schema's shape: the hook answers with `block` and the errors, so the worker continues in the same Agent call.
  const bad = hooks.stop('agent-fix-1', JSON.stringify({ schema_version: 1, skill: 'stakeholder-analysis', status: 'completed', code: 'OK' }));
  assert.equal(bad.status, 0, bad.stderr);
  const block = JSON.parse(bad.stdout);
  assert.equal(block.decision, 'block');
  assert.match(block.reason, /format_error/);
  assert.match(block.reason, /\$\.result: required/);
  assert.match(block.reason, /return\.schema\.json/);
  assert.equal((await flow.state()).stages['stakeholder-analysis'].status, 'running', 'nothing was recorded');
  // The same message delivered twice (project and stage settings) is handled once; a different message is a new attempt.
  assert.equal(hooks.stop('agent-fix-1', JSON.stringify({ schema_version: 1, skill: 'stakeholder-analysis', status: 'completed', code: 'OK' })).stdout, '');

  // No JSON in the message: asked again, and the final message is then read from the worker's own transcript.
  const prose = hooks.stop('agent-fix-1', '작업을 마쳤습니다.');
  assert.match(JSON.parse(prose.stdout).reason, /holds no JSON object/);
  const message = await flow.finalMessage('stakeholder-analysis', id, SKIPPED(analysis));
  const transcript = join(flow.workspace, '.io/runtime', 'agent-fix-1.jsonl');
  await mkdir(join(transcript, '..'), { recursive: true });
  await writeFile(transcript, [
    { type: 'user', message: { role: 'user', content: 'run the stage' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `다음이 결과입니다.\n\`\`\`json\n${message}\n\`\`\`` }] } },
  ].map((row) => JSON.stringify(row)).join('\n'));
  const recovered = hooks.stop('agent-fix-1', undefined, { agent_transcript_path: transcript, stop_hook_active: true });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, '');
  assert.equal((await flow.state()).stages['stakeholder-analysis'].status, 'completed');
  assert.equal(JSON.parse(hooks.result(call.toolUseId).content[0].text).code, 'OK');
});

test('a worker that keeps failing is stopped after three repairs and the orchestrator gets the way out', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks } = flow;
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  const id = executionOf(call.updated.prompt);
  hooks.start('agent-stuck');
  for (let attempt = 1; attempt <= 3; attempt += 1) assert.equal(JSON.parse(hooks.stop('agent-stuck', `{"attempt":${attempt}}`).stdout).decision, 'block', `repair ${attempt}`);
  assert.equal(hooks.stop('agent-stuck', '{"attempt":4}').stdout, '', 'the fourth failure lets the worker stop');
  const envelope = JSON.parse(hooks.result(call.toolUseId).content[0].text);
  assert.equal(envelope.status, 'repair_exhausted');
  assert.match(envelope.next, /Report it to the user and stop; do not edit documents or record completion yourself/);
  assert.match(envelope.next, new RegExp(`fail --execution-id ${id}`));
  assert.equal((await flow.state()).stages['stakeholder-analysis'].status, 'running');
});

test('a worker that ends without a recorded result is reported with the recovery command', async (t) => {
  const flow = await claudeFlow(t);
  const call = flow.hooks.admit('harness-stage: stakeholder-analysis');
  const id = executionOf(call.updated.prompt);
  const envelope = JSON.parse(flow.hooks.result(call.toolUseId).content[0].text);
  assert.equal(envelope.status, 'no_result');
  assert.match(envelope.next, new RegExp(`inspect --execution-id ${id}`));
  assert.match(envelope.next, new RegExp(`fail --execution-id ${id} --reason`));
});

test('questions come back compact in the envelope and a raw reply answers them in one Agent call', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const question = (id, title, recommended) => withDecisionContext({
    question_id: id, title, recommended_option_id: recommended, rationale: '근거', decision_kind: null,
    options: [{ id: 'a', label: '핀 하나씩', consequence: '핀마다', effect: '핀마다 공개 범위가 있다', example: '핀 두 개 중 하나만 공개' }, { id: 'b', label: '소유자 묶음', consequence: '소유자마다', effect: '소유자 전체가 같은 공개 범위를 갖는다', example: '핀 두 개가 같은 범위' }].map((option) => ({ ...option, evidence: [] })),
  });
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  const id = executionOf(call.updated.prompt);
  hooks.start('agent-ask');
  const message = await flow.finalMessage('stakeholder-analysis', id, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문 둘', files: { [analysis]: stakeholderAnalysisDocument(REQUEST) }, questions: [question('q1', '공개 단위는?', 'a'), question('q2', '삭제 권한은?', 'b')] });
  assert.equal(hooks.stop('agent-ask', message).stdout, '');
  const envelope = JSON.parse(hooks.result(call.toolUseId).content[0].text);
  assert.equal(envelope.code, 'USER_DECISION_REQUIRED');
  assert.equal(envelope.questions.length, 2);
  assert.deepEqual(Object.keys(envelope.questions[0]), ['question_id', 'title', 'context', 'reason', 'options']);
  assert.deepEqual(envelope.questions[0].options.map(({ id, label, recommended }) => [id, label, recommended]), [['a', '핀 하나씩', true], ['b', '소유자 묶음', undefined]]);
  assert.equal(JSON.stringify(envelope).includes('questions_path'), false);
  assert.ok(envelope.questions[0].options.every((option) => option.example && option.effect), 'each option shows its effect and example');
  assert.equal(JSON.stringify(envelope).includes('consequence'), false, 'consequence stays in the result file');
  assert.match(envelope.next, /harness-stage: answer/);
  assert.match(envelope.next, /without opening any file/);

  // An undeclared reply starts nothing and lists what can be declared.
  const unclear = hooks.admit('harness-stage: answer\n2번 B');
  assert.equal(unclear.decision, 'deny');
  assert.match(unclear.reason, /Nothing was started/);
  assert.match(unclear.reason, /clarification_needed/);
  assert.match(unclear.reason, /Declare which question/);
  // A choice for one question is stored, the other is shown again compactly.
  const second = envelope.questions[1].question_id;
  const partial = hooks.admit(`harness-stage: answer\n${JSON.stringify([{ question_id: second, option_id: 'b' }])}\n두 번째는 b`);
  assert.equal(partial.decision, 'deny');
  assert.match(partial.reason, /waiting_for_answers/);
  assert.match(partial.reason, /공개 단위는\?/);
  // An approval does not answer a question.
  assert.match(hooks.admit('harness-stage: approve\n좋아 가자').reason, /waiting for answers/);
  // The declared intent answers the rest in any wording and the stage is dispatched again with its answers.
  const answered = hooks.admit('harness-stage: recommended\n다 추천대로 해');
  assert.equal(answered.decision, 'allow', answered.reason);
  assert.equal(answered.updated.subagent_type, 'workflow_stage');
  assert.match(answered.updated.prompt, /answers_path: \S+answers\.json/);
  const answers = JSON.parse(await readFile(/answers_path: (\S+)/.exec(answered.updated.prompt)[1], 'utf8'));
  assert.deepEqual(answers.map(({ answer }) => answer).sort(), ['소유자 묶음 (b)', '핀 하나씩 (a)']);
});

test('revise needs an owning stage that has run, and an undeclared reply starts nothing', async (t) => {
  const { hooks } = await claudeFlow(t);
  for (const prompt of ['harness-stage: revise\n승인합니다', 'harness-stage: revise requirements-fix\n신고 규칙 문구를 바꿔 주세요', 'harness-stage: answer\n승인합니다']) {
    const refused = hooks.admit(prompt);
    assert.equal(refused.decision, 'deny', prompt);
    assert.match(refused.reason, /Nothing was started/);
    assert.match(refused.reason, /clarification_needed/);
    assert.match(refused.reason, /none yet/);
  }
  assert.match(hooks.admit('harness-stage: approve\n좋아 가자').reason, /ANSWER_REFUSED|No stage is waiting/);
  assert.match(hooks.admit('harness-stage: recommended\n좋아 가자').reason, /ANSWER_REFUSED|No stage is waiting/);
});

test('the admission hook refuses what it cannot launch and leaves other Agent calls alone', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks } = flow;
  // Out of order: nothing starts and the reason names the stage that has to come first.
  const early = hooks.admit('harness-stage: aggregate-design');
  assert.equal(early.decision, 'deny');
  assert.match(early.reason, /Nothing was started\. .*STAGE_ORDER/);
  assert.match(early.reason, /Next: /);
  // A bad call line.
  assert.match(hooks.admit('harness-stage: Not A Stage').reason, /Stage dispatch refused: The first line/);
  // Only the main orchestrator dispatches: a worker's own Agent call is refused.
  assert.match(hooks.admit('harness-stage: stakeholder-analysis', { agent_id: 'agent-x' }).reason, /Only the main orchestrator/);
  // A stage that is already running is not started twice.
  const first = hooks.admit('harness-stage: stakeholder-analysis');
  assert.equal(first.decision, 'allow', first.reason);
  const again = hooks.admit('harness-stage: stakeholder-analysis');
  assert.equal(again.decision, 'deny');
  assert.match(again.reason, /Nothing was started/);
  // An Agent call that is not a stage dispatch goes through the existing admission rules untouched.
  const other = hooks.admit('Summarize the README');
  assert.equal(other.out, null);
  // Directory without a workflow: no launch is attempted.
  const outside = spawnSync(process.execPath, [join(flow.workspace, '.claude/harness/scripts/harness-agent-admission.mjs')], { cwd: flow.workspace, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: flow.session, cwd: join(flow.workspace, '.io'), tool_use_id: 'toolu_x', tool_input: { subagent_type: 'workflow_stage', prompt: 'harness-stage: stakeholder-analysis' } }) });
  assert.match(JSON.parse(outside.stdout).hookSpecificOutput.permissionDecisionReason, /not a Harness workflow worktree/);
});

test('domain sync is the stage worker\'s own step: the refusal is addressed to the worker and nothing asks the parent to run it', async () => {
  const missing = explainError(new Error('Fixed requirements with domain IDs require a domain sync plan'), { stageId: 'bounded-context', executionId: 'bounded-context-9' });
  assert.equal(missing.code, 'DOMAIN_SYNC_MISSING');
  const text = JSON.stringify(missing);
  assert.match(text, /runtime\/executions\/bounded-context-9\/domain-sync-proposal\.json/);
  assert.match(text, /HARNESS_STAGE_EXECUTION_ID=bounded-context-9 node \.harness\/scripts\/harness-domain\.mjs sync plan/);
  assert.doesNotMatch(text, /Send this to the same subagent/);
  assert.match(missing.why, /worker writes the proposal itself; the caller never runs it/);
  const guide = await readFile(join(process.cwd(), '.harness/internal-skills/bounded-context/GUIDE.md'), 'utf8');
  assert.match(guide, /domain-sync-proposal\.json`에 항상 직접 저장한다/);
  assert.match(guide, /이 stage가 직접 실행하며, 호출자에게 부탁하지 않는다/);
  assert.match(guide, /`result\.summary`는 사용자 승인 요약으로 쓴다\(12줄 이하/);
  assert.match(await readFile(join(process.cwd(), '.harness/internal-skills/to-ticket/GUIDE.md'), 'utf8'), /result\.summary`는 사용자 발행 승인 요약으로 쓴다\(12줄 이하/);
});

test('a Claude orchestrator is told once to dispatch launch commands as Agent calls, and finish names its next step in that form', () => {
  const refusal = { error: 'x', code: 'STAGE_ORDER', why: 'y', next: ["node .harness/scripts/harness-native-stage.mjs launch --stage-id requirements-fix --feedback '<why>'"] };
  assert.match(withDispatchHint(refusal, 'claude-code').dispatch, /one Agent call \(subagent_type "workflow_stage"\).*"harness-stage: <stage> <the launch options>"/);
  assert.deepEqual(withDispatchHint(refusal, 'codex'), refusal, 'Codex keeps its launch commands');
  assert.equal(withDispatchHint({ error: 'x', next: ['wait'] }, 'claude-code').dispatch, undefined, 'only an output that names a launch gets the hint');
  const next = (provider) => finishNext({ status: 'completed', code: 'OK', stageId: 'requirements-fix', executionId: 'e-1', provider });
  assert.equal(next('claude-code'), 'Next stage: Agent(subagent_type: "workflow_stage", prompt: "harness-stage: bounded-context")');
  assert.equal(next('codex'), 'Next stage: node .harness/scripts/harness-native-stage.mjs launch --stage-id bounded-context');
  const approval = finishNext({ status: 'completed', code: 'OK', stageId: 'bounded-context', executionId: 'e-1', provider: 'claude-code' });
  assert.match(approval, /Show the user result\.summary \(the approval summary\) and the requirements\.md path from artifacts, in Korean\. Open requirements\.md once and list its business rules \(INV-\*\) and exceptions \(EX-\*\) in the approval request under the heading "승인할 규칙"/);
  assert.match(approval, /Only after the user's own approval, in any wording, pass their reply verbatim as an approval: Agent\(subagent_type: "workflow_stage", prompt: "harness-stage: approve\n/);
  assert.match(finishNext({ status: 'action_required', code: 'USER_DECISION_REQUIRED', stageId: 'event-storming', executionId: 'e-1', provider: 'claude-code' }), /harness-stage: answer\n[\s\S]*"question_id"[\s\S]*<the user's reply verbatim>/);
});

// ---- a worker that ended on an API error ------------------------------------------------------------------------------------

const API_ERROR_ROW = { type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your limit · resets 9pm (Asia/Seoul)" }] } };
const NORMAL_ROW = { type: 'assistant', message: { model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: '문서를 쓰는 중입니다.' }] } };

// The worker transcript of a dispatch record, under a projects directory that the hook events point at with `transcript_path`.
async function workerTranscript(flow, agentId, rows, { ageMs = 5 * 60 * 1000 } = {}) {
  const projects = join(flow.workspace, '.io/runtime/claude-projects');
  const file = join(projects, flow.session, 'subagents', `agent-${agentId}.jsonl`);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const at = new Date(Date.now() - ageMs);
  await utimes(file, at, at);
  return { file, hook: { transcript_path: join(projects, 'other-session.jsonl'), session_id: 'other-session' } };
}
const dispatchRecord = async (flow, toolUseId) => JSON.parse(await readFile(join(flow.workspace, '.io/runtime/claude-dispatch', `${toolUseId}.json`), 'utf8'));

test('a stage whose worker ended on an API error is failed and dispatched again by the next admission', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks } = flow;
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  const id = executionOf(call.updated.prompt);
  hooks.start('agent-limit');
  const { hook } = await workerTranscript(flow, 'agent-limit', [{ type: 'user', message: { role: 'user', content: 'run' } }, NORMAL_ROW, API_ERROR_ROW, { type: 'attachment', attachment: { type: 'hook_success' } }]);
  const again = hooks.admit('harness-stage: stakeholder-analysis', hook);
  assert.equal(again.decision, 'allow', again.reason);
  const next = executionOf(again.updated.prompt);
  assert.notEqual(next, id, 'a fresh execution');
  assert.match(JSON.parse(await readFile(join(flow.workspace, '.io/runtime/executions', next, 'feedback.json'), 'utf8')).feedback, /ended on an API error/, 'the standard feedback reached the worker');
  const stage = (await flow.state()).stages['stakeholder-analysis'];
  assert.equal(stage.status, 'running');
  assert.equal(stage.execution_id, next);
  assert.ok((stage.attempts || []).some((attempt) => attempt.execution_id === id && attempt.status === 'failed'), 'the dead execution is recorded as failed');
  const record = await dispatchRecord(flow, call.toolUseId);
  assert.equal(record.status, 'failed');
  assert.equal(record.envelope.code, 'WORKER_API_ERROR');
});

test('a worker that may be alive keeps today\'s refusal: current session, normal end, missing or recent transcript', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks } = flow;
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  const id = executionOf(call.updated.prompt);
  hooks.start('agent-live');
  const refused = (result, why) => {
    assert.equal(result.decision, 'deny', why);
    assert.match(result.reason, /Nothing was started/, why);
    assert.match(result.reason, /STAGE_RUNNING|not confirmed|running/i, why);
  };
  // The dispatching session is the current one and its Agent call has not returned.
  const same = await workerTranscript(flow, 'agent-live', [NORMAL_ROW, API_ERROR_ROW]);
  refused(hooks.admit('harness-stage: stakeholder-analysis', { transcript_path: same.hook.transcript_path }), 'current session');
  // Another session, but no API error at the end of the transcript.
  const normal = await workerTranscript(flow, 'agent-live', [API_ERROR_ROW, NORMAL_ROW]);
  refused(hooks.admit('harness-stage: stakeholder-analysis', normal.hook), 'normal last message');
  // Another session and an API error, but the transcript changed within the last minute.
  const recent = await workerTranscript(flow, 'agent-live', [NORMAL_ROW, API_ERROR_ROW], { ageMs: 10 * 1000 });
  refused(hooks.admit('harness-stage: stakeholder-analysis', recent.hook), 'recent transcript');
  // No transcript at all.
  const { rm } = await import('node:fs/promises');
  await rm(recent.file);
  refused(hooks.admit('harness-stage: stakeholder-analysis', recent.hook), 'missing transcript');
  const stage = (await flow.state()).stages['stakeholder-analysis'];
  assert.equal(stage.status, 'running');
  assert.equal(stage.execution_id, id);
  assert.equal((await dispatchRecord(flow, call.toolUseId)).status, 'bound');
});

test('a worker that stopped on an API error is failed by the hook and is never sent a repair', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks } = flow;
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  const id = executionOf(call.updated.prompt);
  hooks.start('agent-quota');
  const { file } = await workerTranscript(flow, 'agent-quota', [NORMAL_ROW, API_ERROR_ROW]);
  const stopped = hooks.stop('agent-quota', "You've hit your 5-hour limit", { agent_transcript_path: file });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '', 'no repair request: the worker cannot answer');
  const stage = (await flow.state()).stages['stakeholder-analysis'];
  assert.equal(stage.status, 'failed');
  assert.equal(stage.execution_id, id);
  const record = await dispatchRecord(flow, call.toolUseId);
  assert.equal(record.status, 'failed');
  assert.equal(record.repairs, 0);
  const envelope = JSON.parse(hooks.result(call.toolUseId).content[0].text);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.code, 'WORKER_API_ERROR');
  assert.equal(envelope.next, 'Dispatch the same stage again after the limit resets');
  // The failed stage is dispatched again like any failed one.
  assert.equal(hooks.admit('harness-stage: stakeholder-analysis --feedback x').decision, 'allow');
});

test('a final message that is only an API error text, without a transcript, is not repaired either', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks } = flow;
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  hooks.start('agent-text');
  assert.equal(hooks.stop('agent-text', "You've hit your 5-hour limit").stdout, '');
  assert.equal((await flow.state()).stages['stakeholder-analysis'].status, 'failed');
  assert.equal(JSON.parse(hooks.result(call.toolUseId).content[0].text).code, 'WORKER_API_ERROR');
  // Ordinary prose that is not an API error still gets the repair request.
  const other = hooks.admit('harness-stage: stakeholder-analysis --feedback x');
  assert.equal(other.decision, 'allow');
  hooks.start('agent-prose');
  assert.match(JSON.parse(hooks.stop('agent-prose', '작업을 마쳤습니다.').stdout).reason, /holds no JSON object/);
});

test('the Agent result of a bound worker without an envelope reports and records an API error at the transcript end', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks } = flow;
  const call = hooks.admit('harness-stage: stakeholder-analysis');
  hooks.start('agent-gone');
  const { hook } = await workerTranscript(flow, 'agent-gone', [NORMAL_ROW, API_ERROR_ROW]);
  const envelope = JSON.parse(hooks.result(call.toolUseId, undefined, { transcript_path: hook.transcript_path }).content[0].text);
  assert.equal(envelope.code, 'WORKER_API_ERROR');
  assert.equal((await dispatchRecord(flow, call.toolUseId)).status, 'failed');
  assert.equal((await flow.state()).stages['stakeholder-analysis'].status, 'failed');
});

test('the context names plain re-dispatch for a stage whose worker ended on an API error', async (t) => {
  const flow = await claudeFlow(t);
  const { hooks, workspace } = flow;
  hooks.admit('harness-stage: stakeholder-analysis');
  hooks.start('agent-ctx');
  await workerTranscript(flow, 'agent-ctx', [NORMAL_ROW, API_ERROR_ROW]);
  const { deadWorkerOfStage } = await import('../.harness/src/workflow/claude-stage-dispatch.mjs');
  const state = await flow.state();
  const at = (id, extra = {}) => deadWorkerOfStage({ root: workspace, state, stage: 'stakeholder-analysis', currentSessionId: id, ...extra });
  const projects = join(workspace, '.io/runtime/claude-projects');
  assert.equal(at('other-session'), null, 'no projects directory is known without the hook event');
  assert.equal(at('other-session', { transcriptPath: join(projects, 'x.jsonl') })?.record.agent_id, 'agent-ctx');
  assert.equal(at(flow.session, { transcriptPath: join(projects, 'x.jsonl') }), null, 'the dispatching session keeps waiting for its Agent call');
});

test('while a design approval waits, resume asks for it and the dispatch hook refuses the unapproved next stage', async (t) => {
  const flow = await claudeFlow(t);
  const { workspace, hooks, invoke, runStage, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  await runStage('stakeholder-analysis', SKIPPED(analysis));
  const skipped = { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false };
  for (const stage of PRE_SPEC_STAGES.slice(1, PRE_SPEC_STAGES.indexOf('domain-model') + 1)) await runStage(stage, skipped);

  const { next } = invoke(workspace, 'harness-context.mjs', []);
  assert.match(next, /Do not start aggregate-design yet/);
  assert.match(next, /harness-stage: approve/);

  const call = hooks.admit('harness-stage: aggregate-design');
  assert.equal(call.decision, 'deny', JSON.stringify(call.out));
  assert.match(call.reason, /Design approval answer was not recorded/);
  assert.equal((await flow.state()).stages['aggregate-design'], undefined, 'nothing was started');
});
