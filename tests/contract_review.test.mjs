import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const PLAN_SET = 'sample';
const STAGE = 'sync-contracts-1';
const SCOPE = `contracts-${PLAN_SET}`;
const manifest = { schema_version: 1, features: [], components: [], diagrams: [{ kind: 'ddd', reason: 'fixture has no domain model' }, { kind: 'class', reason: 'fixture has no domain model' }], source_roots: [], empty_project_reason: 'fixture has no domain model' };
const finding = (description, severity = 'major') => ({ severity, description, evidence: `docs/contracts/architecture.md#orders; src/orders/OrderService.java:42 (${description})` });

// An installed consumer whose integrated contract is sealed, driven through the real CLIs and the real subagent hook.
async function consumer() {
  const root = await mkdtemp(join(tmpdir(), 'contract-review-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Contract');
  git('config', 'user.email', 'contract@example.test');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const write = async (path, content) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); };
  await write('CONTEXT.md', '# Context\n');
  await write('CONTEXT-MAP.md', '# Context map\n');
  for (const name of ['request', 'product-spec', 'architecture-spec']) await write(`docs/specs/${PLAN_SET}/${name}.md`, `# ${name}\n`);
  await write(`docs/plans/${PLAN_SET}/plans.md`, '# Plans\n');
  await write('docs/contracts/product.md', '# Product\n');
  await write('docs/contracts/architecture.md', '# Architecture\n');
  await write('docs/contracts/manifest.json', JSON.stringify(manifest));
  git('add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs', '.harness/contracts.mjs');
  git('commit', '-q', '-m', 'Baseline');
  const env = { ...process.env, HARNESS_WORKSPACE_ROOT: root, HARNESS_SKILL_EXECUTION_ID: STAGE, HARNESS_SESSION_DIR: join(root, '.io'), HARNESS_REVIEW_TICKET_ID: PLAN_SET, HARNESS_REVIEW_EXECUTION_ID: STAGE };
  const json = (run) => ({ status: run.status, stderr: run.stderr, json: run.stdout ? JSON.parse(run.stdout) : null });
  const c = {
    root, git, write, env,
    cli: (...args) => json(spawnSync(process.execPath, [join(root, '.codex/scripts/harness-contract-review.mjs'), ...args, '--root', root, '--plan-set', PLAN_SET], { cwd: root, encoding: 'utf8', env })),
    seal: (summary = 'a contract change') => { const run = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-contracts.mjs'), 'seal', '--root', root, '--summary', summary], { cwd: root, encoding: 'utf8' }); assert.equal(run.status, 0, run.stdout + run.stderr); },
    hook: (event) => spawnSync(process.execPath, [join(root, '.codex/scripts/harness-agent-event.mjs')], { cwd: root, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'sync-contracts-thread', agent_type: 'contract_reviewer', ...event }) }),
    revision: async () => JSON.parse(await readFile(join(root, 'docs/contracts/manifest.json'), 'utf8')).revision,
    history: async () => JSON.parse(await readFile(join(root, `.io/runtime/reviews/${SCOPE}.json`), 'utf8')),
    // begin -> a native reviewer the hook binds -> record, the way the stage does it.
    round: async (agentId, verdict, findings = []) => {
      const begin = c.cli('begin');
      assert.equal(begin.status, 0, begin.stderr);
      assert.equal(c.hook({ hook_event_name: 'SubagentStart', agent_id: agentId }).status, 0);
      assert.equal(c.hook({ hook_event_name: 'SubagentStop', agent_id: agentId, last_assistant_message: JSON.stringify({ verdict, findings }) }).status, 0);
      return { begin: begin.json, record: c.cli('record', '--attempt', begin.json.attempt_id) };
    },
    // The stage fixes the contract and seals the new revision.
    fix: async (note) => { await appendFile(join(root, 'docs/contracts/product.md'), `\n${note}\n`); c.seal(note); },
  };
  c.seal('first seal');
  return c;
}

test('the review needs a sealed contract, binds the hook-recorded reviewer to its revision and is read back by check', async () => {
  const c = await consumer();
  try {
    await appendFile(join(c.root, 'docs/contracts/product.md'), '\nedited after the seal\n');
    const unsealed = c.cli('begin');
    assert.notEqual(unsealed.status, 0);
    assert.match(unsealed.stderr, /pass harness-contracts\.mjs check and be sealed/);
    c.seal('second seal');

    const begin = c.cli('begin');
    assert.equal(begin.status, 0, begin.stderr);
    assert.equal(begin.json.round, 1);
    assert.equal(begin.json.contract_revision, await c.revision());
    assert.deepEqual(begin.json.brief.contract_files.slice(0, 3), ['docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json']);
    assert.equal(begin.json.brief.spec_directory, `docs/specs/${PLAN_SET}`);
    assert.equal(c.cli('check').json.reason, 'contract_review_missing');
    // The stage names only the attempt; with no hook-bound reviewer there is nothing to record.
    const early = c.cli('record', '--attempt', begin.json.attempt_id);
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /stopped native reviewer bound to this attempt by the subagent hook/);
    // Typing an identity or a verdict is not possible.
    assert.notEqual(c.cli('record', '--attempt', begin.json.attempt_id, '--reviews', 'x.json').status, 0);

    // A reviewer forked from the author's conversation is logged but never bound.
    const forked = join(c.root, '.io/forked-rollout.jsonl');
    await writeFile(forked, `${JSON.stringify({ type: 'session_meta', payload: { id: 'forked-reviewer', forked_from_id: 'sync-contracts-thread' } })}\n`);
    c.hook({ hook_event_name: 'SubagentStart', agent_id: 'forked-reviewer', agent_transcript_path: forked });
    c.hook({ hook_event_name: 'SubagentStop', agent_id: 'forked-reviewer', agent_transcript_path: forked, last_assistant_message: JSON.stringify({ verdict: 'pass', findings: [] }) });
    assert.notEqual(c.cli('record', '--attempt', begin.json.attempt_id).status, 0, 'a forked reviewer cannot pass the review');
    assert.equal(c.cli('check').json.status, 'blocked');

    c.hook({ hook_event_name: 'SubagentStart', agent_id: 'native-contract-reviewer-1' });
    c.hook({ hook_event_name: 'SubagentStop', agent_id: 'native-contract-reviewer-1', last_assistant_message: JSON.stringify({ verdict: 'pass', findings: [] }) });
    const recorded = c.cli('record', '--attempt', begin.json.attempt_id);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(recorded.json.reason, 'pass');

    const attempt = (await c.history()).attempts.at(-1);
    assert.deepEqual({ reviewer_id: attempt.review.reviewer_id, author_ids: attempt.review.author_ids, fork_turns: attempt.review.fork_turns, verdict: attempt.review.verdict }, { reviewer_id: 'native-contract-reviewer-1', author_ids: ['sync-contracts-thread'], fork_turns: 'none', verdict: 'pass' });
    assert.equal(attempt.inputs.revision, String(await c.revision()));
    const events = (await readFile(join(c.root, `.io/runtime/executions/${STAGE}/subagents.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((item) => [item.agent_id, item.event, item.admitted ?? true, item.forked ?? false, item.review_scope]), [
      ['forked-reviewer', 'SubagentStart', false, true, SCOPE],
      ['forked-reviewer', 'SubagentStop', false, true, SCOPE],
      ['native-contract-reviewer-1', 'SubagentStart', true, false, SCOPE],
      ['native-contract-reviewer-1', 'SubagentStop', true, false, SCOPE],
    ]);
    const check = c.cli('check');
    assert.equal(check.status, 0, JSON.stringify(check.json));
    assert.deepEqual([check.json.reason, check.json.details.contract_revision, check.json.details.native_agent_id, check.json.details.round], ['contract_review_current', await c.revision(), 'native-contract-reviewer-1', 1]);
    // The same sealed contract is not reviewed twice.
    assert.match(c.cli('begin').stderr, /Review inputs are unchanged/);
    // Changing the contract makes the earlier pass stale.
    await c.fix('a later contract change');
    assert.equal(c.cli('check').json.reason, 'contract_review_stale');
  } finally { await rm(c.root, { recursive: true, force: true }); }
});

test('a finding that comes back after a fix stops the loop and asks the user, who resolves it before another review', async () => {
  const c = await consumer();
  try {
    const owner = finding('Order cancellation rules live in the controller, not the Order aggregate');
    const first = await c.round('reviewer-1', 'revise', [owner]);
    assert.equal(first.record.json.reason, 'revise');
    assert.equal(first.record.json.findings.length, 1);
    await c.fix('Moved the cancellation rule to the Order aggregate');
    const second = await c.round('reviewer-2', 'revise', [{ ...owner, evidence: `${owner.evidence}; still in OrderController.java:88` }, finding('A minor wording point', 'minor')]);
    assert.equal(second.begin.round, 2);
    assert.equal(second.record.json.reason, 'revise');
    await c.fix('Rewrote the cancellation section');

    const refused = c.cli('begin');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /The same contract review finding came back after a fix .*Order cancellation rules live in the controller/);
    const { inspectReviewHistory } = await import(`file://${join(c.root, '.harness/src/workflow/review-attempts.mjs')}`);
    const state = await inspectReviewHistory({ root: c.root, scope: SCOPE });
    assert.equal(state.next_admission_requires_resolution, true);
    assert.equal(state.repeated_findings.length, 1);
    assert.equal(state.budget.limit, 5);
    // The stage returns USER_DECISION_REQUIRED; only the recorded user decision lets it review again, from round 1.
    assert.notEqual(c.cli('resolve').status, 0, 'a resolution needs the user decision text');
    assert.equal(c.cli('resolve', '--reason', 'User: the controller keeps the cancellation rule for now').status, 0);
    const third = await c.round('reviewer-3', 'pass');
    assert.equal(third.begin.round, 1);
    assert.equal(third.record.json.reason, 'pass');
    assert.equal(c.cli('check').json.status, 'pass');
  } finally { await rm(c.root, { recursive: true, force: true }); }
});

test('different findings are repaired for five rounds, then the sixth review is refused until the user decides', async () => {
  const c = await consumer();
  try {
    for (let round = 1; round <= 5; round += 1) {
      const result = await c.round(`round-${round}`, 'revise', [finding(`Distinct contract mismatch number ${round}`)]);
      assert.equal(result.begin.round, round);
      assert.equal(result.record.json.reason, 'revise');
      await c.fix(`Fix ${round}`);
    }
    const refused = c.cli('begin');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Review retry budget exhausted \(5 rounds\)/);
    const { inspectReviewHistory } = await import(`file://${join(c.root, '.harness/src/workflow/review-attempts.mjs')}`);
    assert.deepEqual((await inspectReviewHistory({ root: c.root, scope: SCOPE })).budget, { used: 5, limit: 5, remaining: 0 });
    assert.equal(c.cli('resolve', '--reason', 'User: accept the remaining mismatches as follow-up work').status, 0);
    assert.equal((await c.round('after-resolution', 'pass')).begin.round, 1);
    // Spec and plan reviews keep their three-round budget; only the contract scope uses five.
    const history = await c.history();
    assert.equal(history.attempts.length, 6);
    assert.equal(history.resolution.after, 5);
  } finally { await rm(c.root, { recursive: true, force: true }); }
});

test('Claude Code admits only the active contract attempt, claims it before dispatch and the hook then records the same review', async () => {
  const c = await consumer();
  try {
    const admission = (input) => JSON.parse(execFileSync(process.execPath, [join(c.root, '.codex/scripts/harness-agent-admission.mjs')], { cwd: c.root, env: c.env, input: JSON.stringify(input), encoding: 'utf8' }));
    const dispatch = { hook_event_name: 'PreToolUse', session_id: 'claude-session', tool_name: 'Agent', tool_use_id: 'dispatch-1', tool_input: { subagent_type: 'contract_reviewer', prompt: 'Review the contract.' } };
    assert.equal(admission(dispatch).hookSpecificOutput.permissionDecision, 'deny', 'no active attempt');
    const begin = c.cli('begin');
    const allowed = admission(dispatch);
    assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(allowed.hookSpecificOutput.updatedInput.prompt, new RegExp(`plan_set_id=${PLAN_SET}; contract_revision=${await c.revision()}; attempt_id=${begin.json.attempt_id}; reviewer_id=claude-${STAGE}-${begin.json.attempt_id}`));
    assert.equal(admission(dispatch).hookSpecificOutput.permissionDecision, 'deny', 'the attempt is claimed once');
    assert.equal(admission({ ...dispatch, tool_input: { subagent_type: 'general-purpose', prompt: 'x' } }).hookSpecificOutput.permissionDecision, 'deny');
    for (const event of [{ hook_event_name: 'SubagentStart' }, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify({ verdict: 'pass', findings: [] }) }]) {
      const run = c.hook({ session_id: 'claude-session', agent_id: 'native-claude-agent', ...event });
      assert.equal(run.status, 0, run.stderr);
    }
    const recorded = c.cli('record', '--attempt', begin.json.attempt_id);
    assert.equal(recorded.json.reason, 'pass', recorded.stderr);
    assert.equal(c.cli('check').json.details.native_agent_id, 'native-claude-agent');
  } finally { await rm(c.root, { recursive: true, force: true }); }
});

test('installed consumer: the reviewer profile, GUIDE, CLI and hook handling ship, resolve the skill binding and stay out of commits', async () => {
  const c = await consumer();
  try {
    for (const path of ['.codex/agents/contract_reviewer.toml', '.claude/agents/contract_reviewer.md', '.codex/internal-skills/contract-review/GUIDE.md', '.codex/scripts/harness-contract-review.mjs', '.harness/src/workflow/contract-review.mjs']) {
      assert.ok((await readdir(join(c.root, path, '..'))).includes(path.split('/').at(-1)), path);
      assert.match(c.git('check-ignore', '-v', path), /\.git\/info\/exclude/, `${path} is Harness-owned and ignored`);
    }
    const profile = await readFile(join(c.root, '.claude/agents/contract_reviewer.md'), 'utf8');
    assert.match(profile, /permissionMode: plan/);
    assert.match(profile, /contract-review\/GUIDE\.md/);
    await writeFile(join(c.root, '.codex/harness.yaml'), 'agents:\n  provider: codex\n  codex:\n    high_performance_model: codex-high\n    high_performance_reasoning_effort: high\n    implementation_model: codex-implementation\n    implementation_reasoning_effort: medium\n    execution_model: codex-execution\n    execution_reasoning_effort: low\n    low_performance_model: codex-light\n    low_performance_reasoning_effort: minimal\n');
    const binding = JSON.parse(execFileSync(process.execPath, [join(c.root, '.codex/scripts/harness-skill-execution.mjs'), 'binding', '--root', c.root, '--skill', 'contract-review'], { cwd: c.root, encoding: 'utf8' }));
    assert.deepEqual([binding.model_tier, binding.model, binding.reasoning_effort], ['high_performance', 'codex-high', 'high']);
    // Harness-generated files stay out of git status; the application-owned files stay visible.
    await mkdir(join(c.root, 'src'), { recursive: true });
    await writeFile(join(c.root, 'src/app.js'), 'export const app = true;\n');
    const status = c.git('status', '--short', '--untracked-files=all');
    assert.match(status, /src\/app\.js/);
    assert.doesNotMatch(status, /\.io\/|\.harness\/src|\.codex\/|\.claude\//);
    // The installed Doctor knows the new assets.
    const doctor = await runDoctor({ root: c.root, sourceRoot });
    assert.deepEqual(doctor.diagnostics.filter((item) => item.code === 'execution_asset_missing' && /contract-review/.test(item.message)), []);
    await rm(join(c.root, '.codex/scripts/harness-contract-review.mjs'));
    const missing = await runDoctor({ root: c.root, sourceRoot });
    assert.ok(missing.diagnostics.some((item) => item.code === 'execution_asset_missing' && /harness-contract-review\.mjs/.test(item.message)));
  } finally { await rm(c.root, { recursive: true, force: true }); }
});
