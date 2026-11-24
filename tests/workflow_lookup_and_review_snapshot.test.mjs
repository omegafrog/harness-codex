import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { upstreamStageRefs } from '../.harness/src/workflow/stage-input.mjs';
import { inspectPlanSet, updatePlanReview, snapshotPlanSet, validatePlanReviewAdmission } from '../.harness/src/workflow/plan-review.mjs';
import { updateReviewAttempt } from '../.harness/src/workflow/review-attempts.mjs';
import { documentDraftRoot, resolveStageSessionDocument } from '../.harness/src/workflow/stage-documents.mjs';
import { markInterruptedReviews, writeGuardDecision } from '../.harness/scripts/harness-write-guard.mjs';
import { composeReviewDraft } from './support/composed-review-draft.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

// The orchestrator found the compose arguments by searching .harness and reading the CLI source after a failing --help.
test('installed workflow CLIs print usage for --help without side effects, and the compose GUIDE carries the complete command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cli-help-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const status = () => execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    const before = status();
    const sessionBefore = existsSync(join(root, '.io')) ? execFileSync('find', ['.io'], { cwd: root, encoding: 'utf8' }) : '';
    for (const [script, pattern] of [
      ['harness-compose-workspace.mjs', /--root <absolute workspace> --execution-id .*--plan-set-id .*--request .*--orchestrator-provider .*--orchestrator-session-id/s],
      ['harness-context.mjs', /Usage: node \.harness\/scripts\/harness-context\.mjs \[--entry/],
      ['harness-native-stage.mjs', /Usage: harness-native-stage\.mjs launch --stage-id STAGE/],
      ['harness-prepare-input.mjs', /--stage-id STAGE .*--answer .*--feedback/s],
    ]) {
      for (const flag of ['--help', '-h']) {
        const run = spawnSync(process.execPath, [join(root, '.harness/scripts', script), flag], { cwd: root, encoding: 'utf8' });
        assert.equal(run.status, 0, `${script} ${flag}: ${run.stderr}`);
        assert.match(run.stdout, pattern, script);
        assert.equal(run.stderr, '');
      }
    }
    // A wrong argument still fails and points at --help.
    const wrong = spawnSync(process.execPath, [join(root, '.harness/scripts/harness-compose-workspace.mjs'), '--bogus', 'x'], { cwd: root, encoding: 'utf8' });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /see --help/);
    assert.equal(status(), before, 'help leaves the consumer Git status unchanged');
    assert.equal(existsSync(join(root, '.io')) ? execFileSync('find', ['.io'], { cwd: root, encoding: 'utf8' }) : '', sessionBefore, 'help writes no session files');

    const guide = await readFile(join(root, '.harness/internal-skills/workflow-compose/GUIDE.md'), 'utf8');
    assert.match(guide, /node \.harness\/scripts\/harness-compose-workspace\.mjs --root "\$PWD" --execution-id <execution-id> --plan-set-id <feature-slug> --request '<사용자 요청 원문>' --orchestrator-provider <provider> --orchestrator-session-id <session-id>/);
    assert.match(guide, /`\.harness`를 검색하거나 CLI 소스를 읽지 않는다/);
    const input = await readFile(join(root, '.codex/skills/orchestrator/references/input.md'), 'utf8');
    assert.match(input, /--request '<사용자 요청 원문>' --orchestrator-provider <provider> --orchestrator-session-id <session_id>/);
    // A root document listed next to plan-set documents is named as the repository-root file.
    for (const skill of ['requirements-fix', 'event-storming', 'ubiquitous-language']) {
      const text = await readFile(join(root, `.harness/internal-skills/${skill}/GUIDE.md`), 'utf8');
      assert.match(text, /repository-root `<workspace_root>\/CONTEXT\.md`/, skill);
      assert.doesNotMatch(text, /`stakeholder-analysis\.md`[^\n]*, and `CONTEXT\.md`/, skill);
      assert.match(text, /`context\.upstream`/, skill);
    }
    assert.match(await readFile(join(root, '.codex/agents/workflow_stage.toml'), 'utf8'), /never search `\.io` or the session directory for earlier results or answers/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Requirements workers searched .io for the answers of earlier stages.
test('a requirements stage input lists every current earlier stage with its canonical result and confirmed answer records', async () => {
  const session = await mkdtemp(join(tmpdir(), 'harness-upstream-'));
  try {
    const answered = 'runtime/executions/stakeholder-analysis-a/decision-answers.json';
    await mkdir(join(session, 'runtime/executions/stakeholder-analysis-a'), { recursive: true });
    await writeFile(join(session, answered), '[{"question_id":"q","answer":"a"}]\n');
    const state = { stages: {
      'workflow-compose': { status: 'completed', code: 'OK', execution_id: 'compose-1', result_ref: 'runtime/executions/compose-1/result.json' },
      'stakeholder-analysis': { status: 'completed', code: 'OK', execution_id: 'stakeholder-analysis-b', result_ref: 'runtime/executions/stakeholder-analysis-b/result.json',
        attempts: [{ status: 'waiting', code: 'USER_DECISION_REQUIRED', execution_id: 'stakeholder-analysis-a', result_ref: 'runtime/executions/stakeholder-analysis-a/result.json' }] },
      'subdomain-candidates': { status: 'completed', code: 'OK', execution_id: 'subdomain-candidates-c', result_ref: 'runtime/executions/subdomain-candidates-c/result.json' },
      // A stale result is not current evidence; the rerun order brings it back.
      'ubiquitous-language': { status: 'completed', code: 'OK', execution_id: 'ubiquitous-language-d', result_ref: 'runtime/executions/ubiquitous-language-d/result.json', stale: { owner_stage: 'subdomain-candidates' } },
    } };
    assert.deepEqual(await upstreamStageRefs({ root: session, session, state, stageId: 'event-storming' }), [
      { stage_id: 'stakeholder-analysis', execution_id: 'stakeholder-analysis-b', result_ref: 'runtime/executions/stakeholder-analysis-b/result.json', answers_refs: [answered] },
      { stage_id: 'subdomain-candidates', execution_id: 'subdomain-candidates-c', result_ref: 'runtime/executions/subdomain-candidates-c/result.json' },
    ]);
    assert.deepEqual(await upstreamStageRefs({ root: session, session, state, stageId: 'stakeholder-analysis' }), []);
    assert.deepEqual(await upstreamStageRefs({ root: session, session, state, stageId: 'tracker-publish' }), [], 'only the ordered requirements and tactical design flow');
    // The input schema accepts the field and existing inputs without it stay valid.
    const schema = JSON.parse(await readFile(join(sourceRoot, '.harness/schemas/input.schema.json'), 'utf8'));
    const item = schema.properties.context.properties.upstream.items;
    assert.deepEqual(item.required, ['stage_id', 'execution_id', 'result_ref']);
    assert.equal(schema.properties.context.required, undefined);
  } finally { await rm(session, { recursive: true, force: true }); }
});

async function planSet() {
  const root = await mkdtemp(join(tmpdir(), 'harness-review-launch-'));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'docs/plans/set'), { recursive: true });
  await mkdir(join(root, 'docs/specs/set'), { recursive: true });
  await mkdir(join(root, '.io'), { recursive: true });
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), '# tactical design\n');
  await writeFile(join(root, 'docs/plans/set/plans.md'), '# Plans\n\n| [first](first.md) | 없음 |\n');
  await writeFile(join(root, 'docs/plans/set/first.md'), '---\nstatus: planned\n---\n# first\n\n검증: 단위 테스트\n');
  return root;
}
const withStageEnv = async (root, run, executionId = 'to-ticket-author') => {
  const saved = { HARNESS_STAGE_EXECUTION_ID: process.env.HARNESS_STAGE_EXECUTION_ID, HARNESS_WORKSPACE_ROOT: process.env.HARNESS_WORKSPACE_ROOT };
  process.env.HARNESS_STAGE_EXECUTION_ID = executionId;
  process.env.HARNESS_WORKSPACE_ROOT = root;
  try { return await run(); } finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; }
};
const reviewerEvent = (root, event) => {
  const run = spawnSync(process.execPath, [join(sourceRoot, '.harness/scripts/harness-agent-event.mjs')], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ session_id: 'author-session', agent_type: 'plan_reviewer', ...event }),
    env: { ...process.env, HARNESS_SESSION_DIR: join(root, '.io'), HARNESS_STAGE_EXECUTION_ID: 'to-ticket-author', HARNESS_REVIEW_EXECUTION_ID: 'to-ticket-author', HARNESS_REVIEW_TICKET_ID: 'set' },
  });
  assert.equal(run.status, 0, run.stderr);
};

// A plan review was aborted because the plan wording was corrected after `begin` had captured the snapshot.
test('the plan review snapshot is captured when the reviewer starts, and the reviewed files cannot be written while it runs', async () => {
  const root = await planSet();
  try {
    const attempt = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
    const admissionPath = join(root, '.io', attempt.reviewer_input_ref);
    const ticket = join(root, 'docs/plans/set/first.md');
    const write = (extra = {}, env = {}) => writeGuardDecision({ hook_event_name: 'PreToolUse', session_id: 'main', cwd: root, tool_name: 'Write', tool_input: { file_path: ticket }, ...extra }, env);
    // Before the reviewer starts, the author may still finish its wording.
    assert.equal(write({}, { HARNESS_STAGE_EXECUTION_ID: 'to-ticket-author' }), null);
    await writeFile(ticket, '---\nstatus: planned\n---\n# first\n\n검증: 단위 테스트와 경계 검사\n');

    reviewerEvent(root, { hook_event_name: 'SubagentStart', agent_id: 'reviewer-1' });
    const history = JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-set.json'), 'utf8'));
    const active = history.attempts.at(-1);
    const current = await snapshotPlanSet({ root, planSetId: 'set' });
    assert.equal(active.status, 'active');
    assert.equal(active.native_review.agent_id, 'reviewer-1');
    assert.deepEqual(active.inputs, current.inputs, 'the attempt holds the snapshot taken at launch');
    assert.ok(active.inputs_captured_at_launch);
    const admission = JSON.parse(await readFile(admissionPath, 'utf8'));
    assert.deepEqual(admission.inputs, current.inputs);
    assert.ok(admission.files.find(({ path }) => path === 'docs/plans/set/first.md').content.includes('경계 검사'), 'the reviewer reads the launched contents');

    // While the review runs, the orchestrator, the author stage and sub-agents are all denied, with the way out named.
    for (const [extra, env] of [[{}, {}], [{}, { HARNESS_STAGE_EXECUTION_ID: 'to-ticket-author' }], [{ agent_id: 'child' }, {}]]) {
      const reason = write(extra, env);
      assert.match(reason ?? '', /docs\/plans\/set\/first\.md is under a running plan review \(plan set set, attempt [0-9a-f-]+\)/);
      assert.match(reason, /harness-plan-review\.mjs record --plan-set set --attempt/);
    }
    assert.match(writeGuardDecision({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' docs/specs/set/tactical-design.md" } }, { HARNESS_STAGE_EXECUTION_ID: 'x' }) ?? '', /tactical-design\.md is under a running plan review/);
    // Files outside the review stay writable for the stage.
    assert.equal(writeGuardDecision({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, 'src/app.js') } }, { HARNESS_STAGE_EXECUTION_ID: 'x' }), null);

    reviewerEvent(root, { hook_event_name: 'SubagentStop', agent_id: 'reviewer-1', last_assistant_message: JSON.stringify({ verdict: 'pass', findings: [] }) });
    const recorded = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'record', attemptId: attempt.attempt_id, review: { schema_version: 1, attempt_id: attempt.attempt_id, plan_set_id: 'set' }, requireNative: true }));
    assert.equal(recorded.reason, 'pass', 'the review covers the launched snapshot and is current');
    assert.equal(write({}, { HARNESS_STAGE_EXECUTION_ID: 'to-ticket-author' }), null, 'recorded reviews release the files');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the launch capture never changes an attempt whose reviewer is already bound', async () => {
  const root = await planSet();
  try {
    const attempt = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
    reviewerEvent(root, { hook_event_name: 'SubagentStart', agent_id: 'reviewer-1' });
    const bound = JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-set.json'), 'utf8')).attempts.at(-1).inputs;
    await assert.rejects(updateReviewAttempt({ root, scope: 'plan-set', action: 'refresh-inputs', attemptId: attempt.attempt_id, inputs: { other: 'x' } }), /before its reviewer is bound/);
    assert.deepEqual(JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-set.json'), 'utf8')).attempts.at(-1).inputs, bound);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plan review uses the composed additions, deletions and revisions under canonical paths', async () => {
  const root = await planSet();
  try {
    const executionId = 'to-ticket-author';
    const draft = documentDraftRoot(root, executionId);
    const index = 'docs/plans/set/plans.md';
    const removed = 'docs/plans/set/first.md';
    const added = 'docs/plans/set/replacement.md';
    const issueDrafts = ['parent', 'replacement'].map((id) => `runtime/to-ticket/drafts/${id}.md`);
    const deletion = join(draft, '..', 'deleted', removed);
    await mkdir(dirname(join(draft, added)), { recursive: true });
    await mkdir(dirname(deletion), { recursive: true });
    await writeFile(deletion, '');
    await writeFile(join(draft, index), '# Plans\n\n| [replacement](replacement.md) | 없음 |\n');
    await writeFile(join(draft, added), '---\nstatus: planned\n---\n# Replacement\n\n## Verification\nUnit test.\n');
    for (const path of issueDrafts) {
      const proposal = join(draft, '..', 'session', path);
      await mkdir(dirname(proposal), { recursive: true });
      await writeFile(proposal, '# Issue proposal\n');
    }
    assert.deepEqual((await snapshotPlanSet({ root, planSetId: 'set', executionId })).plans.map(({ path }) => path), [added]);
    assert.deepEqual((await snapshotPlanSet({ root, planSetId: 'set' })).plans.map(({ path }) => path), [removed]);

    await assert.rejects(withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' })), /document writer/);
    const composedBody = '---\nstatus: planned\n---\n# Replacement\n\n## Verification\nUnit test and boundary check.\n';
    await composeReviewDraft({ root, executionId, skill: 'to-ticket', planSetId: 'set', documents: { [added]: composedBody }, github: true });
    const planning = await snapshotPlanSet({ root, planSetId: 'set', executionId });
    const started = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
    assert.deepEqual(started.inputs, planning.inputs);
    assert.equal(await validatePlanReviewAdmission({ root, planSetId: 'set', admission: started, requireActive: false }), started);
    reviewerEvent(root, { hook_event_name: 'SubagentStart', agent_id: 'draft-reviewer' });
    const admission = JSON.parse(await readFile(join(root, '.io', started.reviewer_input_ref), 'utf8'));
    assert.deepEqual(admission.files.find(({ path }) => path === added), {
      path: added, content: composedBody, sha256: admission.inputs[added], normalization: 'frontmatter-status-excluded-v1',
    });
    assert.ok(!admission.files.some(({ path }) => path === removed || path.startsWith('.io/')));
    reviewerEvent(root, { hook_event_name: 'SubagentStop', agent_id: 'draft-reviewer', last_assistant_message: JSON.stringify({ verdict: 'pass', findings: [] }) });
    await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'record', attemptId: started.attempt_id, requireNative: true }));
    assert.equal((await inspectPlanSet({ root, planSetId: 'set', phase: 'planning', executionId })).status, 'pass');
    assert.equal((await inspectPlanSet({ root, planSetId: 'set', phase: 'dispatch', planId: 'replacement', executionId })).status, 'blocked');

    for (const path of issueDrafts) {
      const canonical = join(root, '.io', path);
      assert.equal(existsSync(canonical), false);
      await mkdir(dirname(canonical), { recursive: true });
      await copyFile(await resolveStageSessionDocument(root, path, executionId), canonical);
    }
    await rm(join(root, removed));
    await copyFile(join(draft, index), join(root, index));
    await writeFile(join(root, added), composedBody);
    assert.equal((await inspectPlanSet({ root, planSetId: 'set', phase: 'dispatch', planId: 'replacement' })).details.canonical_plan.reference, added);

    const nextId = 'to-ticket-second';
    const nextDraft = join(documentDraftRoot(root, nextId), added);
    await mkdir(dirname(nextDraft), { recursive: true });
    await writeFile(nextDraft, composedBody.replace('boundary check', 'edge check'));
    await composeReviewDraft({ root, executionId: nextId, skill: 'to-ticket', planSetId: 'set', github: true });
    const next = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }), nextId);
    assert.deepEqual(next.review_delta.changed, [{
      path: added, scope: 'sections',
      sections: [{ heading: '## Verification', before: '## Verification\nUnit test and boundary check.\n', after: '## Verification\nUnit test and edge check.\n' }],
    }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Claude Code dispatches the reviewer through a PreToolUse admission instead of a SubagentStart claim.
test('the Claude reviewer admission captures the plan snapshot at dispatch, so a wording fix after begin is reviewed', async () => {
  const root = await planSet();
  try {
    const attempt = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
    const ticket = join(root, 'docs/plans/set/first.md');
    await writeFile(ticket, '---\nstatus: planned\n---\n# first\n\n검증: 단위 테스트와 경계 검사\n');
    const admit = spawnSync(process.execPath, [join(sourceRoot, '.claude/harness/scripts/harness-agent-admission.mjs')], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, HARNESS_SESSION_DIR: join(root, '.io'), HARNESS_CONTROL_SESSION_DIR: join(root, '.io'), HARNESS_STAGE_EXECUTION_ID: 'to-ticket-author', HARNESS_REVIEW_EXECUTION_ID: 'to-ticket-author', HARNESS_REVIEW_TICKET_ID: 'set', HARNESS_WORKSPACE_ROOT: root, HARNESS_PROVIDER_ID: 'claude-code' },
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'author-session', cwd: root, tool_name: 'Agent', tool_use_id: 'dispatch-plan', tool_input: { subagent_type: 'plan_reviewer', prompt: 'Review the plans.' } }),
    });
    assert.equal(admit.status, 0, admit.stderr);
    const decision = JSON.parse(admit.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'allow', decision.permissionDecisionReason);
    const active = JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-set.json'), 'utf8')).attempts.at(-1);
    assert.deepEqual(active.inputs, (await snapshotPlanSet({ root, planSetId: 'set' })).inputs);
    const admission = JSON.parse(await readFile(join(root, '.io', attempt.reviewer_input_ref), 'utf8'));
    assert.ok(admission.files.find(({ path }) => path === 'docs/plans/set/first.md').content.includes('경계 검사'));
    // The claim made at dispatch locks the admitted files before the reviewer's own start event.
    assert.match(writeGuardDecision({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Write', tool_input: { file_path: ticket } }, {}) ?? '', /under a running plan review/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A reviewer that crashed or was killed left its attempt active and the plan files locked until someone ran record or abort by hand.
const historyFile = (root) => join(root, '.io/runtime/reviews/plan-set.json');
const readHistory = async (root) => JSON.parse(await readFile(historyFile(root), 'utf8'));
const editAttempt = async (root, edit) => { const history = await readHistory(root); edit(history.attempts.at(-1)); await writeFile(historyFile(root), `${JSON.stringify(history, null, 2)}\n`); };
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const setExecutionStatus = async (root, status) => {
  await mkdir(join(root, '.io/runtime/orchestrator'), { recursive: true });
  await writeFile(join(root, '.io/runtime/orchestrator/state.json'), `${JSON.stringify({ schema_version: 1, stages: { 'to-ticket': { status, execution_id: 'to-ticket-author', native_managed: true } } }, null, 2)}\n`);
};
const guardEvent = (root, file = 'docs/plans/set/first.md') => ({ hook_event_name: 'PreToolUse', session_id: 'main', cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, file) } });
// The write of a stage (or any other session) to a reviewed plan file; `interrupted` receives the reviews whose lock was released.
const lockedWrite = (root, interrupted = []) => writeGuardDecision(guardEvent(root), { HARNESS_STAGE_EXECUTION_ID: 'to-ticket-author' }, { interrupted });
const startReview = async (root, transcript) => {
  const attempt = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
  reviewerEvent(root, { hook_event_name: 'SubagentStart', agent_id: 'reviewer-1', ...(transcript ? { agent_transcript_path: transcript } : {}) });
  return attempt;
};
const stopReviewer = (root, verdict = 'pass') => reviewerEvent(root, { hook_event_name: 'SubagentStop', agent_id: 'reviewer-1', last_assistant_message: JSON.stringify({ verdict, findings: [] }) });
const recordReview = (root, attempt) => withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'record', attemptId: attempt.attempt_id, review: { schema_version: 1, attempt_id: attempt.attempt_id, plan_set_id: 'set' }, requireNative: true }));

test('a live plan reviewer keeps the lock and its message names how the lock releases', async () => {
  const root = await planSet();
  try {
    await startReview(root);
    const interrupted = [];
    const reason = lockedWrite(root, interrupted);
    assert.match(reason ?? '', /docs\/plans\/set\/first\.md is under a running plan review/);
    assert.match(reason, /releases by itself if the reviewer stops, its stage execution ends, or it shows no activity for 30 minutes/);
    assert.deepEqual(interrupted, []);
    // A recorded stage execution that is still running does not release it, and nothing is marked.
    await setExecutionStatus(root, 'running');
    assert.match(lockedWrite(root) ?? '', /under a running plan review/);
    await setExecutionStatus(root, 'waiting');
    assert.match(lockedWrite(root) ?? '', /under a running plan review/);
    assert.equal((await readHistory(root)).attempts.at(-1).interrupted, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the lock is released once the reviewer stopped, and an edit afterwards makes the recorded review stale instead of passing', async () => {
  const root = await planSet();
  try {
    const attempt = await startReview(root);
    assert.match(lockedWrite(root) ?? '', /under a running plan review/);
    stopReviewer(root);
    const interrupted = [];
    assert.equal(lockedWrite(root, interrupted), null, 'the SubagentStop released the files');
    assert.deepEqual(interrupted, [], 'a reviewer that stopped normally is not an interruption');
    await writeFile(join(root, 'docs/plans/set/first.md'), '---\nstatus: planned\n---\n# first\n\n검증: 단위 테스트 수정\n');
    const recorded = await recordReview(root, attempt);
    assert.equal(recorded.reason, 'stale', 'the review covers the admitted snapshot, not the edit made after the stop');
    assert.notEqual(recorded.status, 'pass');
    assert.equal((await readHistory(root)).attempts.at(-1).interrupted, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const status of ['failed', 'cancelled', 'blocked', 'completed']) {
  test(`a ${status} stage execution releases the plan review lock and marks its reviewer interrupted`, async () => {
    const root = await planSet();
    try {
      const attempt = await startReview(root);
      await setExecutionStatus(root, status);
      const interrupted = [];
      assert.equal(lockedWrite(root, interrupted), null);
      assert.equal(interrupted.length, 1);
      assert.deepEqual({ planSetId: interrupted[0].planSetId, attemptId: interrupted[0].attemptId, state: interrupted[0].state }, { planSetId: 'set', attemptId: attempt.attempt_id, state: 'execution_terminal' });
      assert.match(interrupted[0].detail, new RegExp(`to-ticket-author is ${status}`));
      await markInterruptedReviews(interrupted);
      const marked = (await readHistory(root)).attempts.at(-1);
      assert.equal(marked.status, 'active', 'the attempt stays open until it is settled');
      assert.equal(marked.interrupted.reason, 'execution_terminal');
      assert.equal(marked.interrupted.detected_by, 'write-guard');
      assert.ok(Date.parse(marked.interrupted.detected_at));

      // The interrupted attempt is never recorded as a review; the next review settles it as an aborted round and starts.
      await assert.rejects(recordReview(root, attempt), /marked interrupted \(its stage execution to-ticket-author is .*\); its result cannot be accepted/);
      // Without the mark (a release that was never marked), the reviewer's absence alone refuses the record.
      await editAttempt(root, (last) => { delete last.interrupted; });
      await assert.rejects(updatePlanReview({ root, planSetId: 'set', action: 'record', attemptId: attempt.attempt_id, review: { schema_version: 1, attempt_id: attempt.attempt_id, plan_set_id: 'set' } }), /plan reviewer was interrupted before it returned a result \(its stage execution to-ticket-author is /);
      await markInterruptedReviews(interrupted);
      const next = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
      assert.equal(next.round, 2);
      const history = await readHistory(root);
      assert.equal(history.attempts[0].status, 'aborted');
      assert.match(history.attempts[0].reason, /^interrupted: its stage execution to-ticket-author is /);
      assert.equal(history.attempts[0].interrupted.reason, 'execution_terminal');
      assert.equal(history.attempts[1].status, 'active');
      assert.equal(history.attempts[1].native_review, undefined, 'the new attempt starts without a claimed reviewer');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('a reviewer without activity for the staleness window releases the lock; its transcript is the activity signal', async () => {
  const root = await planSet();
  try {
    const transcript = join(root, 'reviewer-transcript.jsonl');
    await writeFile(transcript, '{}\n');
    await startReview(root, transcript);
    const started = (await readHistory(root)).attempts.at(-1).native_review;
    assert.equal(started.transcript_path, transcript, 'the hook records the reviewer transcript at its start');
    assert.ok(Date.parse(started.claimed_at) && Date.parse(started.started_at));
    const age = async (minutes, transcriptMinutes) => {
      await editAttempt(root, (last) => { last.native_review.claimed_at = minutesAgo(minutes); last.native_review.started_at = minutesAgo(minutes); });
      const time = new Date(Date.now() - transcriptMinutes * 60_000);
      await utimes(transcript, time, time);
    };
    await age(29, 29);
    assert.match(lockedWrite(root) ?? '', /under a running plan review/, 'inside the 30 minute window');
    await age(31, 31);
    const interrupted = [];
    assert.equal(lockedWrite(root, interrupted), null, 'past the window with a silent transcript');
    assert.equal(interrupted[0].state, 'stale');
    assert.match(interrupted[0].detail, /no reviewer activity since .* \(more than 30 minutes\)/);
    await age(90, 2);
    assert.match(lockedWrite(root) ?? '', /under a running plan review/, 'a transcript written two minutes ago shows a working reviewer');
    await age(90, 45);
    assert.equal(lockedWrite(root), null, 'an old transcript does not keep it');
    // Histories from before the timestamps existed are judged by the history file itself, which every claim, bind and stop rewrites.
    await editAttempt(root, (last) => { delete last.native_review.claimed_at; delete last.native_review.started_at; delete last.native_review.transcript_path; });
    assert.match(lockedWrite(root) ?? '', /under a running plan review/, 'a history that was just written is fresh');
    const old = new Date(Date.now() - 40 * 60_000);
    await utimes(historyFile(root), old, old);
    assert.equal(lockedWrite(root), null, 'a history untouched for 40 minutes is stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a claimed reviewer that never reports its start releases the lock after the short bind grace', async () => {
  const root = await planSet();
  try {
    const attempt = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
    await updateReviewAttempt({ root, scope: 'plan-set', action: 'claim', attemptId: attempt.attempt_id, reviewerId: 'claude-to-ticket-author-1', nativeAgentId: 'pending-tool', parentSessionId: 'author-session', executionId: 'to-ticket-author' });
    assert.match(lockedWrite(root) ?? '', /under a running plan review/, 'the claim locks the files at dispatch');
    await editAttempt(root, (last) => { last.native_review.claimed_at = minutesAgo(4); });
    assert.match(lockedWrite(root) ?? '', /under a running plan review/);
    await editAttempt(root, (last) => { last.native_review.claimed_at = minutesAgo(6); });
    const interrupted = [];
    assert.equal(lockedWrite(root, interrupted), null);
    assert.equal(interrupted[0].state, 'unbound_stale');
    assert.match(interrupted[0].detail, /never started/);
    await markInterruptedReviews(interrupted);
    assert.equal((await readHistory(root)).attempts.at(-1).interrupted.reason, 'unbound_stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the write guard hook process marks an interrupted review once and leaves a live one untouched', async () => {
  const root = await planSet();
  try {
    await startReview(root);
    const hook = () => spawnSync(process.execPath, [join(sourceRoot, '.harness/scripts/harness-write-guard.mjs')], { cwd: root, encoding: 'utf8', input: JSON.stringify(guardEvent(root)), env: { ...process.env, HARNESS_STAGE_EXECUTION_ID: 'to-ticket-author' } });
    const live = hook();
    assert.equal(live.status, 0, live.stderr);
    assert.equal(JSON.parse(live.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await readHistory(root)).attempts.at(-1).interrupted, undefined, 'a deny marks nothing');
    await setExecutionStatus(root, 'failed');
    const released = hook();
    assert.equal(released.status, 0, released.stderr);
    assert.equal(released.stdout, '', 'a released lock allows the write');
    const first = (await readHistory(root)).attempts.at(-1).interrupted;
    assert.equal(first.reason, 'execution_terminal');
    assert.equal(first.detected_by, 'write-guard');
    assert.equal(hook().stdout, '');
    assert.deepEqual((await readHistory(root)).attempts.at(-1).interrupted, first, 'a second release keeps the first detection');
    // The marked attempt is shown by the review inspection too.
    const { inspectReviewHistory } = await import('../.harness/src/workflow/review-attempts.mjs');
    assert.equal((await inspectReviewHistory({ root, scope: 'plan-set' })).interrupted.reason, 'execution_terminal');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a result that arrives after the interruption mark is refused, never recorded as a pass', async () => {
  const root = await planSet();
  try {
    const attempt = await startReview(root);
    await setExecutionStatus(root, 'failed');
    const interrupted = [];
    assert.equal(lockedWrite(root, interrupted), null);
    await markInterruptedReviews(interrupted);
    // The reviewer that was judged gone still returns a valid pass for the unchanged snapshot.
    await setExecutionStatus(root, 'waiting');
    stopReviewer(root);
    assert.equal(lockedWrite(root), null, 'the mark keeps the lock released');
    await assert.rejects(recordReview(root, attempt), /marked interrupted .*result cannot be accepted/);
    await assert.rejects(updatePlanReview({ root, planSetId: 'set', action: 'record', attemptId: attempt.attempt_id, review: { schema_version: 1, attempt_id: attempt.attempt_id, plan_set_id: 'set' } }), /marked interrupted/, 'the main session record path refuses it as well');
    assert.equal((await readHistory(root)).attempts.at(-1).status, 'active');
    // The next review does not settle that late result as a pass either; it ends the attempt as an interrupted abort.
    const next = await withStageEnv(root, () => updatePlanReview({ root, planSetId: 'set', action: 'begin' }));
    const history = await readHistory(root);
    assert.equal(next.round, 2);
    assert.equal(history.attempts[0].status, 'aborted');
    assert.equal(history.attempts[0].settled_after_interruption, undefined);
    assert.equal(history.attempts[0].review, undefined);
    assert.match(history.attempts[0].reason, /^interrupted: /);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable reviewer transcript gets one extra grace window before the lock is released', async () => {
  const root = await planSet();
  try {
    await startReview(root, join(root, 'not-yet-written-transcript.jsonl'));
    const age = (minutes) => editAttempt(root, (last) => { last.native_review.claimed_at = minutesAgo(minutes); last.native_review.started_at = minutesAgo(minutes); });
    await age(33);
    assert.match(lockedWrite(root) ?? '', /under a running plan review/, 'past 30 minutes, but the transcript has not shown up yet');
    await age(36);
    const interrupted = [];
    assert.equal(lockedWrite(root, interrupted), null);
    assert.equal(interrupted[0].state, 'stale');
    assert.match(interrupted[0].detail, /more than 35 minutes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
