import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readSkillSessionJson, readStageResult, resolveSkillBinding, readExecutionInput, resolveSkillSession, validateSkillInput, validateSkillReturn } from './stage-runtime.mjs';
import { parseWorktreeRecord, resolveExecutionWorkspace } from './worktrees.mjs';
import { preparePublicationDrafts } from '../tracker/publication.mjs';
import { answerConflictMessage, isQuestionResponse, mergeAnswers } from './questions.mjs';
import { findExecutionInput, writeExecutionInput } from './execution-input.mjs';
import { assertExecutionStopped, processIdentity, recordExecutionState } from './execution-state.mjs';
import { parseYaml } from '../eval/yaml.mjs';
import { configuredProvider } from './providers/index.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { planRuntimePaths } from '../eval/plan-journal.mjs';
import { stageExecutionPaths } from './session-output.mjs';
import { loadNamedWorkflow } from './loader.mjs';
import { replayJsonlStream } from '../eval/journal.mjs';
import { PRE_SPEC_STAGES, REQUIREMENTS_REVISION_STAGES, TACTICAL_DESIGN_STAGES, currentTacticalDesignPath, isCurrentStage, preSpecOrderViolation, tacticalImplementationOrderViolation } from './worktree-stages.mjs';
import { markRequirementsRevision, resolveReopen, staleFeedback } from './stage-reopen.mjs';
import { migrateLegacyTacticalDesign } from './stage-commit.mjs';
import { assertTicketStartable } from './tactical-tickets.mjs';
import { approvalRefusal, assertRequirementsApproval, describeReplySearch, inspectUserReply, userSaidAfter } from './user-inputs.mjs';

// 완료된 계획 산출물을 사용자가 고치라고 지시한 경우에만 같은 session으로 다시 연다.
const USER_REVISION_STAGES = new Set([...REQUIREMENTS_REVISION_STAGES, ...TACTICAL_DESIGN_STAGES, 'to-ticket', 'implement-wrapper']);
// The stages that run once per plan of the published plan set.
const PLAN_STAGES = new Set(['implement-wrapper', 'tactical-code', 'frontend-implementation', 'frontend-visual-review']);

export async function assertFrontendTicketOrder({ root, session, state, stageId, planSetId, planId }) {
  if (!planId || !planSetId || !['tactical-code', 'frontend-implementation', 'frontend-visual-review'].includes(stageId)) return;
  const ticket = await readFile(join(root, 'docs/plans', planSetId, `${planId}.md`), 'utf8');
  const frontmatter = /^---\s*\n([\s\S]*?)^---\s*$/m.exec(ticket)?.[1] || '';
  const frontend = /^frontend:\s*true\s*$/m.test(frontmatter);
  if (!frontend && stageId === 'tactical-code') return;
  if (!frontend) throw new Error(`Ticket ${planId} is not a frontend ticket`);
  if (state.stages?.['tracker-publish']?.status !== 'completed' || state.stages['tracker-publish'].code !== 'OK') throw new Error('Frontend implementation requires completed tracker publication');
  const required = stageId === 'frontend-implementation' ? 'frontend-design-brief' : stageId === 'frontend-visual-review' ? 'frontend-implementation' : 'frontend-visual-review';
  const previous = state.stages?.[required];
  if (previous?.status !== 'completed' || previous.code !== 'OK' || !previous.result_ref) throw new Error(`Frontend ticket requires completed/OK ${required} before ${stageId}`);
  if (required !== 'frontend-design-brief') {
    const input = await readExecutionInput({ root, execution_id: previous.execution_id });
    if (input.context?.plan_id !== planId) throw new Error(`Frontend ${required} belongs to a different ticket`);
    if (required === 'frontend-visual-review' && !await visualReviewCoversImplementation({ root, reviewInput: input, planId, implementationRef: state.stages?.['frontend-implementation']?.result_ref })) throw new Error('Frontend visual review does not cover the current implementation');
  }
}

async function unrelatedCodeReviewBlock({ root, session, state, stageId, userRevision, target, lastStage, last, planSetId }) {
  if (!userRevision || stageId !== 'to-ticket' || target?.status !== 'completed' || target.code !== 'OK'
    || lastStage !== 'code-review' || last?.status !== 'blocked' || last.code !== 'INPUT_MISSING'
    || state.stages?.['tracker-publish']?.status !== 'completed' || state.stages?.['tracker-publish']?.code !== 'OK'
    || state.stages?.['tactical-code']?.status !== 'completed' || state.stages?.['tactical-code']?.code !== 'OK') return null;
  const planSet = planSetId || parseWorktreeRecord(await readFile(join(session, 'worktree.json'), 'utf8')).plan_set_id;
  if (!planSet) return null;
  const input = await readExecutionInput({ root, execution_id: last.execution_id }).catch(() => null);
  if (input?.skill !== 'code-review' || input.context?.plan_set_id !== planSet) return null;
  const result = await readSkillSessionJson({ root, session_directory: session, path: last.result_ref }).catch(() => null);
  const expectedSpec = `docs/specs/${planSet}/architecture-spec.md`;
  if (!result?.summary?.includes(expectedSpec)) return null;
  const [tactical, legacyCodeReview] = await Promise.all([
    loadNamedWorkflow('tactical-to-code.yaml', { root }),
    loadNamedWorkflow('code-review.yaml', { root }),
  ]);
  if (tactical.stages.some((stage) => stage.id === 'code-review') || !tactical.stages.some((stage) => stage.id === 'to-ticket')
    || legacyCodeReview.id !== 'code-review') return null;
  const existingSpec = await lstat(join(root, expectedSpec)).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  const tacticalDesign = `docs/specs/${planSet}/tactical-design.md`;
  const hasTacticalDesign = await lstat(join(root, tacticalDesign)).then((info) => info.isFile() && !info.isSymbolicLink(), (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (existingSpec || !hasTacticalDesign) return null;
  return { stage_id: lastStage, execution_id: last.execution_id, result_ref: last.result_ref, reason: 'out_of_workflow_review_stage' };
}

async function visualReviewCoversImplementation({ root, reviewInput, planId, implementationRef }) {
  if (!implementationRef) return false;
  const visited = new Set();
  let input = reviewInput;
  for (let depth = 0; depth < 32; depth += 1) {
    if (input.skill !== 'frontend-visual-review' || input.context?.plan_id !== planId) return false;
    const transition = input.context?.transition;
    if (transition) return transition.from_stage === 'frontend-implementation' && transition.code === 'OK' && transition.result_ref === implementationRef;
    const previousRef = input.context?.previous_result_ref;
    const match = /^runtime\/executions\/([A-Za-z0-9_.-]+)\/result\.json$/.exec(previousRef || '');
    if (!match || visited.has(match[1])) return false;
    visited.add(match[1]);
    try { input = await readExecutionInput({ root, execution_id: match[1] }); }
    catch { return false; }
  }
  return false;
}
const REVISION_TARGETS = { SPEC_REVISION_REQUIRED: 'requirements-fix', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' };

async function recordedTacticalUiFlowDecision({ root, session, entry }) {
  const attempts = [...(Array.isArray(entry?.attempts) ? entry.attempts : []), entry].filter((attempt, index, all) =>
    attempt && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(attempt.execution_id || '')
    && all.findIndex((item) => item?.execution_id === attempt.execution_id) === index);
  const decisions = [];
  for (const attempt of attempts) {
    const attemptSession = attempt.result_session_directory ? await resolveSkillSession(root, attempt.result_session_directory) : session;
    if (attemptSession !== session || typeof attempt.result_ref !== 'string') continue;
    const result = await readSkillSessionJson({ root, session_directory: attemptSession, path: attempt.result_ref }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!Array.isArray(result?.questions) || !result.questions.length) continue;
    const answerPath = `runtime/executions/${attempt.execution_id}/decision-answers.json`;
    const answers = await readSkillSessionJson({ root, session_directory: attemptSession, path: answerPath }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!Array.isArray(answers)) continue;
    for (const question of result.questions) {
      if (typeof question?.question_id !== 'string' || !question.question_id.trim()) continue;
      const matches = answers.filter((item) => item?.question_id === question.question_id && typeof item.answer === 'string' && item.answer.trim());
      if (matches.length === 1) decisions.push({ execution_id: attempt.execution_id, question_id: question.question_id, answer: matches[0].answer });
    }
  }
  return decisions.length === 1 ? decisions[0] : null;
}
// A stage relaunched after a block or a stop reads the previous result as the record of that attempt. The gate errors and
// blockers in it were true when it ended, and Harness, the documents or the gate may have changed since, so it is no verdict.
export const PREVIOUS_RESULT_NOTE = 'The previous result is evidence of an earlier attempt: its blockers, gate errors and check verdicts were true when that attempt ended, and Harness, the documents or the gate may have changed since. Re-run the check on the current files before relying on any of them or blocking on them again.';

// The requirements and tactical design stages run in a fixed order and each reads the decisions of the stages before it.
// The runner hands every current (completed/OK, not stale) earlier stage's canonical result and confirmed answer records to
// the worker, so it does not have to search the session for them. Answers live in the execution that asked the questions.
export async function upstreamStageRefs({ root, session, state, stageId }) {
  const index = PRE_SPEC_STAGES.indexOf(stageId);
  if (index <= 0) return [];
  const upstream = [];
  for (const id of PRE_SPEC_STAGES.slice(0, index)) {
    const entry = state.stages?.[id];
    if (!isCurrentStage(entry) || !entry.result_ref || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.execution_id || '')) continue;
    const entrySession = entry.result_session_directory ? await resolveSkillSession(root, entry.result_session_directory) : session;
    if (entrySession !== session) continue;
    const answers_refs = [];
    for (const attempt of [...(entry.attempts || []), entry]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(attempt?.execution_id || '')) continue;
      const path = `runtime/executions/${attempt.execution_id}/decision-answers.json`;
      const info = await lstat(join(session, path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info?.isFile() && !info.isSymbolicLink() && !answers_refs.includes(path)) answers_refs.push(path);
    }
    upstream.push({ stage_id: id, execution_id: entry.execution_id, result_ref: entry.result_ref, ...(answers_refs.length ? { answers_refs } : {}) });
  }
  return upstream;
}

async function hasPassingImplementationGate(root) {
  const directory = join(root, '.io/runtime/workflow-completion');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (const name of await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const match = /^implement-wrapper-([a-f0-9]{40})\.jsonl$/.exec(name);
    if (!match) continue;
    const stream = await replayJsonlStream(join(directory, name), { streamId: `implement-wrapper:${match[1]}` });
    if (!stream.valid) continue;
    if (stream.events.some((event) => event.type === 'workflow_completion' && event.payload?.workflow_id === 'implement-wrapper' && event.payload?.completion_kind === 'feature_implemented' && event.payload?.state === 'completed' && event.payload?.final_workflow === false && event.payload?.head === head)) return true;
  }
  return false;
}

export async function assertEveryPlanCompleted({ root, planSetId, planIds }) {
  const { readPlanSetTicketStatuses } = await import('../tracker/lifecycle.mjs');
  const open = (await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: planSetId, plan_ids: planIds })).filter((ticket) => ticket.status !== 'completed').map((ticket) => ticket.plan_id);
  if (open.length) throw new Error(`sync-contracts starts only after every plan is completed in the tracker; still open: ${open.join(', ')}`);
}

export async function assertPrStageReadiness({ root, state, stageId }) {
  if (!['plan-pr', 'integration-pr'].includes(stageId)) return;
  const trackerMode = parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')).tracker?.mode;
  if (trackerMode !== 'github') throw new Error('Pull request authoring requires GitHub tracker mode');
  if (stageId === 'plan-pr' && (state.stages?.['tracker-publish']?.status !== 'completed' || state.stages?.['tracker-publish']?.code !== 'OK')) throw new Error('Plan PR requires completed approved tracker publication');
  if (stageId === 'integration-pr' && (state.stages?.['implement-wrapper']?.status !== 'completed' || state.stages?.['implement-wrapper']?.code !== 'OK' || state.stages?.['sync-contracts']?.status !== 'completed' || state.stages?.['sync-contracts']?.code !== 'OK' || !(await hasPassingImplementationGate(root)))) throw new Error('Integration PR requires passing non-final implementation and contract completion gates');
}

export async function resolveStageSkill({ root, stageId }) {
  if (stageId === 'spec-me') throw new Error('spec-me has been removed; continue from context-boundary with tactical-to-code');
  const workflows = await readdir(join(root, '.harness/workflows'), { withFileTypes: true });
  const matches = [];
  for (const file of workflows) {
    if (!file.isFile() || !/\.ya?ml$/i.test(file.name)) continue;
    const manifest = await loadNamedWorkflow(file.name, { root });
    matches.push(...manifest.stages.filter((stage) => stage.id === stageId && (stage.role === 'pr_author' || ['frontend-design-brief', 'frontend-implementation', 'frontend-visual-review'].includes(stageId))));
  }
  if (matches.length > 1) throw new Error(`Workflow stage is ambiguous: ${stageId}`);
  return matches[0] || { id: stageId, skill: stageId };
}

async function archiveToTicket({ root, session, planSetId, previousExecutionId, restartExecutionId }) {
  const restartRoot = join(session, 'runtime/restarts');
  await mkdir(restartRoot, { recursive: true });
  const lock = join(restartRoot, `${planSetId}.lock`);
  await mkdir(lock).catch((error) => { if (error.code === 'EEXIST') throw new Error('A to-ticket restart is already being prepared'); throw error; });
  try {
    const prefix = `${planSetId}-${previousExecutionId}-`;
    const names = await readdir(restartRoot);
    const pendingNames = names.filter((name) => name.startsWith(prefix) && name.endsWith('.pending'));
    for (const name of pendingNames) {
      const pending = join(restartRoot, name);
      const pendingInfo = await lstat(pending);
      if (!pendingInfo.isDirectory() || pendingInfo.isSymbolicLink()) throw new Error(`Invalid interrupted restart archive: ${pending}`);
      const destinations = { plans: join(root, 'docs/plans', planSetId), 'plan-review.json': join(session, 'runtime/reviews', `plan-${planSetId}.json`), 'to-ticket': join(session, 'runtime/to-ticket') };
      for (const item of await readdir(pending)) {
        if (item === 'restart.json') { await rm(join(pending, item), { force: true }); continue; }
        if (!destinations[item]) throw new Error(`Unknown interrupted restart archive item: ${item}`);
        const itemPath = join(pending, item), itemInfo = await lstat(itemPath);
        if ((!itemInfo.isDirectory() && !itemInfo.isFile()) || itemInfo.isSymbolicLink()) throw new Error(`Invalid interrupted restart item: ${itemPath}`);
        const target = destinations[item];
        if (await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error(`Cannot recover interrupted restart; original path exists: ${target}`);
        await mkdir(join(target, '..'), { recursive: true });
        await rename(join(pending, item), target);
      }
      await rm(pending, { recursive: true, force: true });
    }
    if (names.some((name) => name.startsWith(prefix) && !name.endsWith('.pending'))) throw new Error('This waiting to-ticket execution has already been restarted');
    const archive = join(restartRoot, `${prefix}${randomUUID()}`);
    const sources = [
      { path: join(root, 'docs/plans', planSetId), name: 'plans' },
      { path: join(session, 'runtime/reviews', `plan-${planSetId}.json`), name: 'plan-review.json' },
      { path: join(session, 'runtime/to-ticket'), name: 'to-ticket' },
    ];
    const moving = [];
    for (const source of sources) {
      const info = await lstat(source.path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info?.isSymbolicLink() || (info && !info.isDirectory() && !info.isFile())) throw new Error(`Cannot archive invalid restart input: ${source.path}`);
      if (info) moving.push(source);
    }
    const pending = `${archive}.pending`;
    await mkdir(pending);
    try {
      for (const item of moving) {
        await mkdir(join(pending, item.name, '..'), { recursive: true });
        await rename(item.path, join(pending, item.name));
      }
      await writeFile(join(pending, 'restart.json'), `${JSON.stringify({ previous_execution_id: previousExecutionId, restart_execution_id: restartExecutionId }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(pending, archive);
    } catch (error) {
      await rm(join(pending, 'restart.json'), { force: true });
      for (const item of moving.toReversed()) {
        const from = join(pending, item.name);
        if (await lstat(from).catch((readError) => readError.code === 'ENOENT' ? null : Promise.reject(readError))) await rename(from, item.path);
      }
      await rm(pending, { recursive: true, force: true });
      throw error;
    }
    return archive;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function existingRestartInput({ root, session, planSetId, previousExecutionId, worktreeRef }) {
  const restartRoot = join(session, 'runtime/restarts');
  const prefix = `${planSetId}-${previousExecutionId}-`;
  const matches = (await readdir(restartRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter((name) => name.startsWith(prefix) && !name.endsWith('.pending'));
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('Multiple restart archives match the waiting to-ticket execution');
  const marker = JSON.parse(await readFile(join(restartRoot, matches[0], 'restart.json'), 'utf8'));
  if (marker.previous_execution_id !== previousExecutionId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(marker.restart_execution_id || '')) throw new Error('Restart archive identity is invalid');
  const found = await findExecutionInput(root, marker.restart_execution_id);
  const input = await readExecutionInput({ root, execution_id: marker.restart_execution_id });
  if (input.skill !== 'to-ticket' || input.context?.stage_id !== 'to-ticket' || input.context?.plan_set_id !== planSetId || input.context?.worktree_ref !== worktreeRef) throw new Error('Archived restart input does not match this worktree stage');
  await validateSkillInput({ root, input });
  const paths = stageExecutionPaths(root, marker.restart_execution_id);
  if (paths.session !== session) throw new Error('Restart input session does not match active worktree');
  return { input, path: found.path, session_directory: session, execution_directory: paths.directory };
}

const PERSONA_STAGES = ['stakeholder-analysis', 'event-storming'];

function storedStageInput(input) {
  if (!input.context?.worktree_ref || ![...PRE_SPEC_STAGES, 'to-ticket', 'tracker-publish'].includes(input.skill)) return input;
  const { workspace_root, shared_guidance_root, session_directory, ...rest } = input;
  const { plan_set_id, ...context } = rest.context;
  return { ...rest, context };
}

// An incoming response replaces the pending response for the same question. Clarifications stay in the pending file.
// `decision-answers.json` is written once all questions have answers, and is final: after that differing replies are rejected.
// `deferred` holds answers queued while the stage ran. They only fill questions not answered since, because a
// queued answer is older than any answer stored or sent after the questions were asked.
export async function collectAnswers(session, prefix, questions, answer, deferred = []) {
  let incoming;
  if (answer === null) incoming = [];
  else {
    try { incoming = JSON.parse(answer); } catch { incoming = questions.length === 1 ? [{ question_id: questions[0].question_id, answer }] : null; }
    if (!Array.isArray(incoming) && questions.length === 1 && typeof incoming === 'string') incoming = [{ question_id: questions[0].question_id, answer: incoming }];
  }
  const path = join(session, prefix, 'pending-answers.json');
  await assertWorkspaceTarget(session, path);
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)) throw new Error('Pending answers must be a regular unshared file');
  let previous = [];
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(incoming)) throw new Error('Answers must be a JSON array');
  const decisionPath = join(session, prefix, 'decision-answers.json');
  await assertWorkspaceTarget(session, decisionPath);
  const decisionInfo = await lstat(decisionPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (decisionInfo && (!decisionInfo.isFile() || decisionInfo.isSymbolicLink() || decisionInfo.nlink > 1)) throw new Error('Recorded decision answers differ or are not a regular unshared file');
  if (decisionInfo && Array.isArray(previous) && previous.some((entry) => entry && Object.hasOwn(entry, 'clarification'))) {
    // A previous attempt may have recorded the decision before it could refresh the pending file.
    previous = JSON.parse(await readFile(decisionPath, 'utf8'));
  }
  const revisePending = decisionInfo === null;
  if (incoming.some((entry) => !isQuestionResponse(entry)) || new Set(incoming.map((entry) => entry.question_id)).size !== incoming.length) throw new Error('Invalid, duplicate, or stale answer');
  if (!revisePending && incoming.some((entry) => Object.hasOwn(entry, 'clarification'))) throw new Error('Invalid, duplicate, or stale answer');
  if (revisePending) {
    const responded = new Set([...previous, ...incoming].map((entry) => entry?.question_id));
    incoming = [...deferred.filter((item) => !responded.has(item.question_id)), ...incoming];
  } else {
    if (deferred.length) {
      const queued = new Map(deferred.map((item) => [item.question_id, item.answer]));
      for (const item of incoming) {
        if (queued.has(item.question_id) && queued.get(item.question_id) !== item.answer) throw new Error('Conflicting deferred answer');
        queued.set(item.question_id, item.answer);
      }
      incoming = [...queued].map(([question_id, value]) => ({ question_id, answer: value }));
    }
    if (previous.length) incoming = incoming.filter((entry) => !previous.some((item) => item?.question_id === entry.question_id && item.answer === entry.answer));
  }
  // Two chosen options that cannot both hold (`excludes`): record nothing, the caller asks the user to change one.
  const replaced = new Set(incoming.map((entry) => entry.question_id));
  const conflict = answerConflictMessage(questions, [...previous.filter((entry) => Object.hasOwn(entry ?? {}, 'answer') && !(revisePending && replaced.has(entry.question_id))), ...incoming.filter((entry) => Object.hasOwn(entry, 'answer'))]);
  if (conflict) return { conflict };
  const merged = mergeAnswers(questions, previous, incoming, { revisePending });
  if (merged.complete) {
    const contents = JSON.stringify(merged.answers, null, 2) + '\n';
    await assertWorkspaceTarget(session, decisionPath);
    try { await writeFile(decisionPath, contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(decisionPath);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) throw new Error('Recorded decision answers differ or are not a regular unshared file');
      const recorded = await readFile(decisionPath, 'utf8');
      if (recorded !== contents) {
        let inputAnswers = null;
        try { inputAnswers = JSON.parse(await readFile(join(session, prefix, 'answers.json'), 'utf8')); }
        catch (readError) { if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError; }
        if (!Array.isArray(inputAnswers) || !isDeepStrictEqual(JSON.parse(recorded), inputAnswers)) throw new Error('Recorded decision answers differ or are not a regular unshared file');
        await writeFile(decisionPath, contents, { mode: 0o600 });
      }
    }
  }
  const pending = [...merged.answers, ...(merged.clarifications ?? [])];
  await writeFile(path, JSON.stringify(pending, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

async function queueRunningAnswers(session, executionId, answer) {
  let incoming;
  try { incoming = JSON.parse(answer); } catch { throw new Error('Answers for a running stage must include question IDs'); }
  if (!Array.isArray(incoming) || !incoming.length || incoming.some((entry) => !entry || Object.keys(entry).sort().join(',') !== 'answer,question_id' || typeof entry.question_id !== 'string' || !entry.question_id.trim() || typeof entry.answer !== 'string' || !entry.answer.trim())) throw new Error('Answers for a running stage must include question IDs');
  const directory = join(session, 'runtime/executions', executionId);
  const path = join(directory, 'deferred-answers.json');
  await assertWorkspaceTarget(session, path);
  const lock = join(directory, '.deferred-answers.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lockInfo = await lstat(lock);
    if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) throw new Error('Unsafe deferred answers lock');
    const owner = await readFile(join(lock, 'owner.json'), 'utf8').then(JSON.parse, () => null);
    const current = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? await processIdentity(owner.pid) : null;
    const stale = owner?.boot && owner?.start && current && (current.boot !== owner.boot || current.start !== owner.start || current.state === 'Z') || !owner && Date.now() - lockInfo.mtimeMs > 5_000;
    if (!stale) throw new Error('Deferred answers are being recorded; retry after the current operation ends');
    await rm(lock, { recursive: true });
    await mkdir(lock);
  }
  try {
    const owner = await processIdentity(process.pid);
    if (!owner?.boot || !owner?.start) throw new Error('Cannot establish deferred answers lock owner');
    await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Deferred answers must be a regular unshared file');
    const previous = info ? JSON.parse(await readFile(path, 'utf8')) : [];
    if (!Array.isArray(previous) || previous.some((entry) => !entry || Object.keys(entry).sort().join(',') !== 'answer,question_id' || typeof entry.question_id !== 'string' || !entry.question_id.trim() || typeof entry.answer !== 'string' || !entry.answer.trim()) || new Set(previous.map((entry) => entry.question_id)).size !== previous.length) throw new Error('Invalid deferred answers');
    const answers = new Map(previous.map((item) => [item.question_id, item.answer]));
    // No decision exists for a running stage, so a queued answer stays open: a later answer for the same question corrects it.
    if (new Set(incoming.map((item) => item.question_id)).size !== incoming.length) throw new Error('Duplicate question ID in one answer batch');
    for (const item of incoming) answers.set(item.question_id, item.answer);
    const temporary = join(directory, `.deferred-${randomUUID()}.json`);
    try {
      await writeFile(temporary, JSON.stringify([...answers].map(([question_id, value]) => ({ question_id, answer: value })), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return [...answers.keys()];
  } finally { await rm(lock, { recursive: true }); }
}

export async function prepareStageInput({ root, session, worktreeRef = null, workflowRef, stageId, codexSessionId, orchestratorSession = null, answer = null, feedback = null, reviewAdmissionRef = null, publicationApproved = false, requirementsApproved = false, restart = false, userRevision = false, planId = null, repairReceipt = null, approvalAnswer = null, e2eRequest = null, testDefectFailure = null, reopenFor = null, requestedStageBinding = null }) {
  if (stageId === 'e2e-test' && !e2eRequest) throw new Error('E2E stage requires an approved request');
  if (stageId !== 'e2e-test' && e2eRequest) throw new Error('E2E request applies only to e2e-test');
  if (userRevision && (feedback === null || !USER_REVISION_STAGES.has(stageId))) throw new Error('User revision requires feedback for a requirements revision stage, a tactical design stage, to-ticket or implement-wrapper');
  if (userRevision && stageId === 'implement-wrapper' && (!planId || !repairReceipt || !approvalAnswer)) throw new Error('Implementation revision requires a plan, failure receipt and approval answer');
  if (requirementsApproved && stageId !== TACTICAL_DESIGN_STAGES[0]) throw new Error(`Requirements approval is only valid for ${TACTICAL_DESIGN_STAGES[0]}`);
  if ((repairReceipt || (approvalAnswer && !['tracker-publish', 'frontend-design-brief'].includes(stageId) && !requirementsApproved)) && !(userRevision && stageId === 'implement-wrapper' && repairReceipt && approvalAnswer)) throw new Error('Repair receipt and approval answer require an implementation user revision');
  if (testDefectFailure && !(userRevision && stageId === 'implement-wrapper' && repairReceipt && approvalAnswer)) throw new Error('Test defect evidence requires an implementation revision');
  // implement-wrapper builds one plan and tactical-code one ticket, which the orchestrator assigns; neither chooses it itself.
  if (planId !== null && !PLAN_STAGES.has(stageId)) throw new Error('--plan applies only to implementation and frontend ticket stages');
  if (stageId === 'implement-wrapper' && planId === null && feedback === null && answer === null) throw new Error('implement-wrapper needs --plan <plan-id>: the orchestrator assigns the next ready plan');
  if (planId !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId)) throw new Error('Invalid plan ID');
  if (answer !== null && (typeof answer !== 'string' || !answer.trim())) throw new Error('User answer must not be empty');
  if (feedback !== null && (typeof feedback !== 'string' || !feedback.trim() || answer !== null || reviewAdmissionRef)) throw new Error('Invalid execution feedback');
  let provider = orchestratorSession?.provider || configuredProvider(parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')));
  let workflowBinding = null;
  let historicalBinding = null;
  let state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
  if (state.schema_version !== 1 || state.stages?.['workflow-compose']?.status !== 'completed') throw new Error('Worktree preparation is incomplete');
  if (stageId === 'spec-me') throw new Error('spec-me has been removed; continue from context-boundary with tactical-to-code');
  // Forward rewind: the owner named by a later stage's blocked / DEPENDENCY_INCOMPLETE result is relaunched with that gap as its
  // feedback. The state claim marks downstream results stale in the same transaction that starts the owner.
  let reopenPlan = null;
  if (reopenFor !== null) {
    if (feedback !== null || answer !== null || restart || userRevision || planId !== null || reviewAdmissionRef || publicationApproved || requirementsApproved) throw Object.assign(new Error('Reopen refused: --reopen-for must be requested with --stage-id only'), { explained: { error: 'Reopen refused: --reopen-for must be requested with --stage-id only', code: 'REOPEN_REFUSED', why: 'The gap text comes from the blocked result, so no feedback, answer, restart or user revision can be combined with it.', next: [`node .harness/scripts/harness-native-stage.mjs launch --stage-id ${stageId} --reopen-for ${reopenFor}`] } });
    reopenPlan = await resolveReopen({ root, session, state, ownerStage: stageId, blockedExecutionId: reopenFor });
    feedback = reopenPlan.feedback;
  }
  // A stage marked stale by a rewind is re-run with a note that its upstream changed.
  const staleMark = reopenPlan || restart || userRevision ? null : state.stages?.[stageId]?.stale ?? null;
  if (staleMark && answer !== null) throw new Error('Invalid, duplicate, or stale answer: relaunch the stage to revalidate its previous questions');
  if (staleMark && feedback === null && answer === null) feedback = staleFeedback(stageId, staleMark);
  // The requirements and tactical design flow runs in order. This is the one place that decides it, so a stale orchestrator cannot skip a stage.
  const orderViolation = preSpecOrderViolation(state.stages, stageId);
  if (orderViolation) throw new Error(orderViolation);
  const tacticalImplementationViolation = tacticalImplementationOrderViolation(state.stages, stageId);
  if (tacticalImplementationViolation) throw new Error(tacticalImplementationViolation);
  if (stageId === 'tactical-code' && planId === null && feedback === null && answer === null) throw new Error('tactical-code needs --plan <ticket-id>: the orchestrator assigns the next ready ticket (ready_tickets in harness-context.mjs)');
  if (stageId === 'tracker-publish' && (!publicationApproved || !isCurrentStage(state.stages?.['to-ticket']))) throw new Error('Completed to-ticket and user publication approval are required');
  // The provider transcript must contain the user's reply after the reviewed plan set finished.
  if (stageId === 'tracker-publish') {
    const publication = await inspectUserReply({ root, text: typeof approvalAnswer === 'string' ? approvalAnswer : '', since: state.stages['to-ticket'].finished_at ?? '1970-01-01T00:00:00.000Z', allowExplicitPublicationReply: true });
    if (!publication.matched) throw approvalRefusal('Publication approval answer was not recorded', describeReplySearch(publication.search, { gate: 'the reviewed plan set finished' }), publication.search);
  }
  await assertPrStageReadiness({ root, state, stageId });
  if (publicationApproved && stageId !== 'tracker-publish') throw new Error('Publication approval is only valid for tracker-publish');
  // The shared contract describes the integrated result, so it is written only after every plan is implemented.
  if (stageId === 'sync-contracts' && (state.stages?.['implement-wrapper']?.status !== 'completed' || state.stages?.['implement-wrapper']?.code !== 'OK')) throw new Error('sync-contracts starts only after implement-wrapper completed every plan and the final E2E passed');
  if (restart && (stageId !== 'to-ticket' || answer !== null || feedback !== null)) throw new Error('Restart applies only to to-ticket without an answer or feedback');
  const running = state.stages?.[stageId];
  if (running?.status === 'running' && !running.result_ref) {
    if (running.native_managed && answer !== null) {
      const questionIds = await queueRunningAnswers(session, running.execution_id, answer);
      return { waiting_for_running_stage: true, execution_id: running.execution_id, agent_id: running.native_agent_id || null, deferred_question_ids: questionIds };
    }
    // A running native stage can be prepared again only after its subagent reported the end.
    await assertExecutionStopped(running);
  }
  const prepared = await readExecutionInput({ root, execution_id: state.stages['workflow-compose'].execution_id });
  const stage = { ...await resolveStageSkill({ root, stageId }), scope: prepared.scope, needs: [], inputs: [], outputs: [], conditions: [], gates: [] };
  const input_refs = [];
  const producer_result_refs = {};
  let lastStage = state.current_stage;
  let last = lastStage && lastStage !== 'workflow-compose' ? state.stages?.[lastStage] : null;
  // A premature implementation dispatch can only be unblocked by publishing the reviewed plan.
  if (((stageId === 'tracker-publish' && publicationApproved) || (stageId === 'to-ticket' && userRevision)) && lastStage === 'implement-wrapper' && last?.status === 'blocked' && last.code === 'DEPENDENCY_INCOMPLETE' && !state.stages?.['tracker-publish']) {
    const blockedInput = await readExecutionInput({ root, execution_id: last.execution_id });
    const blockedReturn = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${last.execution_id}/return.json` });
    await validateSkillReturn({ root, input: blockedInput, envelope: blockedReturn });
    if (blockedReturn.status !== 'blocked' || blockedReturn.code !== last.code || blockedReturn.result_ref !== last.result_ref) throw new Error('Blocked implementation result does not match stage state');
    lastStage = 'to-ticket';
    last = state.stages[lastStage];
  }
  if (last?.code === 'SUBTASK_REQUIRED') throw new Error('Legacy SUBTASK_REQUIRED execution cannot be resumed: the pending subagent identity and result are not recorded; in-place recovery is unsupported. Preserve the session artifacts and report this limitation.');
  let transition;
  // 사용자 수정은 뒤 stage의 현재성을 요구하지 않는다. 그 stage가 고칠 Spec에 의존하므로 재검증하면 교착된다.
  // The user may also revise a completed Spec or plan while a later stage waits on a question: the revision replaces
  // that question (the later stage restarts from the revised plan), so it must not have to be answered first.
  const target = state.stages?.[stageId];
  const outOfWorkflowStage = await unrelatedCodeReviewBlock({ root, session, state, stageId, userRevision, target, lastStage, last, planSetId: state.stages?.['workflow-compose']?.plan_set_id });
  // A tactical design stage blocked on missing or invalidated earlier work lets the user revise the earlier, completed stage.
  const blockedByEarlierFlowStage = last?.status === 'blocked' && TACTICAL_DESIGN_STAGES.includes(lastStage) && PRE_SPEC_STAGES.indexOf(stageId) >= 0 && PRE_SPEC_STAGES.indexOf(stageId) < PRE_SPEC_STAGES.indexOf(lastStage);
  const frontendDesignHandoff = stageId === 'frontend-design-brief' && lastStage === 'tactical-ui' && last?.status === 'blocked' && last.code === 'DEPENDENCY_INCOMPLETE' && last.result_ref;
  const tacticalUiFlowDecision = frontendDesignHandoff ? await recordedTacticalUiFlowDecision({ root, session, entry: last }) : null;
  const transcriptDirectionRecorded = frontendDesignHandoff && await userSaidAfter({ root, text: approvalAnswer, since: state.stages['workflow-compose'].started_at || state.stages['workflow-compose'].finished_at });
  const tacticalUiDirectionRecorded = tacticalUiFlowDecision && approvalAnswer === tacticalUiFlowDecision.answer;
  if (frontendDesignHandoff && !transcriptDirectionRecorded && !tacticalUiDirectionRecorded) {
    const error = 'Frontend direction answer was not recorded';
    throw Object.assign(new Error(error), { explained: { error, code: 'USER_DECISION_REQUIRED', why: 'A UI handoff needs the user’s recorded decision on the screens and flow.', user_decision: 'Agree on the screens and flow with the user, then pass the actual reply via --approval-answer. If UI is deferred, resume tactical-ui with the user’s reply via --feedback.' } });
  }
  const deferredFrontend = stageId === 'tactical-ui' && lastStage === 'frontend-design-brief'
    && ['failed', 'cancelled', 'completed'].includes(last?.status)
    && target?.status === 'blocked' && !target.stale && target.code === 'DEPENDENCY_INCOMPLETE' && target.result_ref
    && feedback !== null && await userSaidAfter({ root, text: feedback, since: target.finished_at });
  if (deferredFrontend) await assertExecutionStopped(last);
  const frontendCorrection = stageId === 'frontend-implementation' && lastStage === 'frontend-visual-review' && last?.status === 'blocked' && last.code === 'DEPENDENCY_INCOMPLETE' && last.result_ref;
  if (frontendCorrection) {
    const reviewInput = await readExecutionInput({ root, execution_id: last.execution_id });
    if (reviewInput.context?.plan_id !== planId) throw new Error('Frontend review belongs to a different ticket');
    input_refs.push({ base: 'session', path: last.result_ref, kind: 'frontend_review_feedback' });
  }
  // A tactical workflow has no implement-wrapper E2E plan to reopen.
  // A caller may resubmit the same approved run after a committed test-only correction.
  let standaloneE2eRetry = false;
  if (stageId === 'e2e-test' && lastStage === stageId && last.status === 'waiting'
      && last.code === 'IMPLEMENTATION_REVISION_REQUIRED' && last.result_ref
      && state.stages?.['tactical-code']?.code === 'OK' && !state.stages?.['implement-wrapper']
      && feedback && /^runtime\/e2e\/requests\/[A-Za-z0-9._-]+\.json$/.test(e2eRequest || '')) {
    const oldInput = await readExecutionInput({ root, execution_id: last.execution_id });
    const originalRefs = oldInput.input_refs.filter((ref) => ref.kind === 'approved_e2e_request' && ref.base === 'session');
    if (originalRefs.length === 1) {
      const before = await readSkillSessionJson({ root, session_directory: session, path: originalRefs[0].path });
      const after = await readSkillSessionJson({ root, session_directory: session, path: e2eRequest });
      const { target_commit: beforeHead, ...beforeConditions } = before;
      const { target_commit: afterHead, ...afterConditions } = after;
      if (/^[a-f0-9]{40}$/.test(beforeHead) && /^[a-f0-9]{40}$/.test(afterHead) && isDeepStrictEqual(beforeConditions, afterConditions)) {
        const diff = execFileSync('git', ['-C', root, 'diff', '--name-only', '-z', beforeHead, afterHead, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean);
        standaloneE2eRetry = diff.length > 0 && diff.every((path) => path.startsWith('scripts/e2e/'));
      }
    }
  }
  const requirementsRevision = userRevision && REQUIREMENTS_REVISION_STAGES.includes(stageId);
  const reopensCompletedWork = userRevision && target?.result_ref
    && (requirementsRevision && !(last?.code === 'ENVIRONMENT_UNAVAILABLE' || last?.code === 'DEPENDENCY_INCOMPLETE')
      || target.status === 'completed' && target.code === 'OK' && (last?.status === 'completed' && last.code === 'OK' || last?.status === 'waiting' && lastStage !== stageId || blockedByEarlierFlowStage || Boolean(outOfWorkflowStage) || stageId === 'implement-wrapper' && lastStage === 'e2e-test' && ['failed', 'blocked', 'waiting'].includes(last?.status)));
  if (!reopenPlan && !frontendDesignHandoff && !deferredFrontend && !frontendCorrection && !reopensCompletedWork && !standaloneE2eRetry && last && (lastStage !== stageId || Object.hasOwn(REVISION_TARGETS, last.code))) {
    if (!last.result_ref || !['completed', 'waiting'].includes(last.status)) throw new Error(`Previous stage has no usable result: ${lastStage} is ${last.status}${last.code ? `/${last.code}` : ''}${last.result_ref ? '' : ' without a recorded result'}`);
    const allowed = REVISION_TARGETS;
    if (allowed[last.code] && allowed[last.code] !== stageId) throw new Error(`Revision must return to ${allowed[last.code]}`);
    if (!allowed[last.code] && last.code !== 'OK') throw new Error(`Resolve the previous stage before selecting another: ${lastStage} returned ${last.status}/${last.code}`);
    const priorInput = await readExecutionInput({ root, execution_id: last.execution_id });
    const priorReturn = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${last.execution_id}/return.json` });
    await validateSkillReturn({ root, input: priorInput, envelope: priorReturn });
    const priorResult = priorReturn.result || await readSkillSessionJson({ root, session_directory: session, path: last.result_ref });
    if (allowed[last.code]) {
      const signature = (result) => JSON.stringify([result.code, result.summary, result.artifacts.map(({ kind, sha256 }) => [kind, sha256])]);
      const matching = [];
      for (const attempt of last.attempts || []) {
        if (attempt.code !== last.code || !attempt.result_ref) continue;
        const result = await readSkillSessionJson({ root, session_directory: session, path: attempt.result_ref });
        if (signature(result) === signature(priorResult)) matching.push(attempt.execution_id);
      }
      if (matching.length >= 2) throw new Error('Revision repeated without changed evidence; inspect and report before retrying');
    }
    const planSetId = priorInput.context?.plan_set_id;
    input_refs.push(...priorResult.artifacts.filter((artifact) => !(stageId === 'to-ticket' && planSetId && artifact.base === 'workspace' && artifact.path?.startsWith(`docs/plans/${planSetId}/`))));
    producer_result_refs[lastStage] = { base: 'session', path: last.result_ref };
    transition = { from_stage: lastStage, code: last.code, result_ref: last.result_ref, summary: priorResult.summary };
  }
  const composer = state.stages?.['workflow-compose'];
  let worktree_ref;
  if (composer?.result_ref) {
    const result = await readSkillSessionJson({ root, session_directory: session, path: composer.result_ref });
    const preparedInput = await readExecutionInput({ root, execution_id: composer.execution_id });
    worktree_ref = preparedInput.context?.worktree_ref || result.worktree_ref;
  }
  if (worktreeRef && worktree_ref !== worktreeRef) throw new Error('Worktree reference does not match workflow');
  let taskSession = session;
  let executionWorkspace;
  let publicationDrafts;
  let plan_set_id;
  const requirementsApproval = requirementsApproved ? { execution_id: state.stages?.['bounded-context']?.execution_id, answer: approvalAnswer } : null;
  if (worktree_ref) {
    if (!worktree_ref.endsWith('/worktree.json')) throw new Error('Invalid canonical worktree reference');
    const directory = worktree_ref.slice(0, -'/worktree.json'.length);
    const record = parseWorktreeRecord(await readFile(worktree_ref, 'utf8'));
    if (record.session_directory !== directory) throw new Error('Canonical worktree record/session mismatch');
    if (await realpath(record.workspace) !== await realpath(root)) throw new Error('Stage workspace must be the prepared worktree');
    taskSession = await resolveSkillSession(root, record.session_directory);
    plan_set_id = record.plan_set_id;
    executionWorkspace = await resolveExecutionWorkspace(root, plan_set_id || null);
    historicalBinding = record.workflow_binding || null;
    if (['to-ticket', 'plan-review', 'implement', 'implement-wrapper', 'sync-contracts'].includes(stage.skill) && !plan_set_id) throw new Error(`${stage.skill} requires plan_set_id in worktree.json`);
    await assertRequirementsApproval({ root, state, stage: stageId, planSetId: plan_set_id, approval: requirementsApproval });
    if (stageId === 'sync-contracts') {
      // implement-wrapper reads completed/OK after every single plan, so the plan set's own tracker decides when it is done.
      const { snapshotPlanSet } = await import('./plan-review.mjs');
      await assertEveryPlanCompleted({ root, planSetId: plan_set_id, planIds: (await snapshotPlanSet({ root, planSetId: plan_set_id })).plans.map((plan) => plan.id) });
    }
  }
  if (restart) {
    if (!worktree_ref || state.current_stage !== 'to-ticket' || !['waiting', 'failed'].includes(state.stages?.['to-ticket']?.status)) throw new Error('Restart requires a waiting or failed to-ticket stage in its active worktree');
    await assertExecutionStopped(state.stages['to-ticket']);
    if (state.stages?.['tracker-publish']?.execution_id) throw new Error('Cannot restart after tracker-publish has started');
    const historyPath = join(taskSession, `runtime/reviews/plan-${plan_set_id}.json`);
    try {
      const history = JSON.parse(await readFile(historyPath, 'utf8'));
      if (history.attempts?.at(-1)?.status === 'active') throw new Error('Cannot restart while a plan review is active');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Fresh or stale planning needs the current freeze checks. A validated restart of a previously dispatched stage
  // can keep the prior technology format. Requirements traceability and any structured coverage still apply.
  const ticketEntry = state.stages?.['to-ticket'];
  if (stage.skill === 'to-ticket' && plan_set_id && (!(ticketEntry?.result_ref || ticketEntry?.attempts?.some((attempt) => attempt?.result_ref)) || ticketEntry.stale)) {
    const { designNotFrozen } = await import('./design-freeze-gate.mjs');
    const notFrozen = await designNotFrozen({ root, planSetId: plan_set_id, allowLegacyTechnology: restart && !ticketEntry.stale });
    if (notFrozen) throw new Error(notFrozen);
  }
  if (restart) {
    const recovered = await existingRestartInput({ root, session: taskSession, planSetId: plan_set_id, previousExecutionId: ticketEntry.execution_id, worktreeRef });
    if (recovered) return recovered;
  }
  let review_admission;
  if (stage.skill === 'spec-review') {
    if (!reviewAdmissionRef) throw new Error('Spec review requires an admitted snapshot');
    const { validateSpecReviewAdmission } = await import('./spec-review.mjs');
    review_admission = await validateSpecReviewAdmission({ root, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  } else if (stage.skill !== 'plan-review' && reviewAdmissionRef) throw new Error('Review admission applies only to Spec or plan review');
  for (const dependency of stage.needs) if (!['completed', 'skipped'].includes(state.stages?.[dependency]?.status)) throw new Error(`Dependency incomplete: ${dependency}`);
  if (stageId === 'implement-wrapper') {
    // A worktree that an older Harness ran through spec-me still records that completed result; implementation reads its
    // Spec artifacts as before. No new spec-me result can appear, so a worktree without one simply has none to read.
    for (const producerStage of ['to-ticket', 'spec-me']) {
      const producer = state.stages?.[producerStage];
      if (producerStage === 'spec-me' && producer?.status !== 'completed') continue;
      if (producer?.status !== 'completed' || !producer.result_ref) throw new Error(`Completed ${producerStage} result is required for implementation`);
      const producerSession = await resolveSkillSession(root, producer.result_session_directory || session);
      const producerInput = await readExecutionInput({ root, execution_id: producer.execution_id });
      if (producerInput.workspace_root !== root) throw new Error('Planning workspace differs from implementation workspace');
      // A 0-byte return.json (killed host) leaves nothing to validate; the recorded result is then read from result.json or output.json.
      const envelope = await readSkillSessionJson({ root, session_directory: producerSession, path: `runtime/executions/${producer.execution_id}/return.json` }).catch((error) => { if (error.empty) return null; throw error; });
      if (envelope) await validateSkillReturn({ root, input: producerInput, envelope });
      const result = envelope?.result || await readStageResult({ root, session_directory: producerSession, executionId: producer.execution_id, resultRef: producer.result_ref });
      if (producerSession !== taskSession && result.artifacts.some((artifact) => artifact.base === 'session')) throw new Error('Producer session artifact differs from the current worktree session');
      input_refs.push(...result.artifacts);
      producer_result_refs[producerStage] = { base: producerSession === taskSession ? 'session' : 'control_session', path: producer.result_ref };
    }
  }
  for (const reference of stage.inputs) {
    if (!reference.from_stage) {
      input_refs.push(reference.base === 'session' ? { ...reference, base: 'control_session' } : reference);
      continue;
    }
    const producer = state.stages?.[reference.from_stage];
    if (producer?.status !== 'completed' || !producer.result_ref) throw new Error(`Producer result unavailable: ${reference.from_stage}`);
    const producerSession = await resolveSkillSession(root, producer.result_session_directory || session);
    const producerInput = await readExecutionInput({ root, execution_id: producer.execution_id });
    const envelope = await readSkillSessionJson({ root, session_directory: producerSession, path: `runtime/executions/${producer.execution_id}/return.json` });
    await validateSkillReturn({ root: producerInput.workspace_root, input: producerInput, envelope });
    const result = await readSkillSessionJson({ root, session_directory: producerSession, path: producer.result_ref });
    producer_result_refs[reference.from_stage] = { base: producerSession === taskSession ? 'session' : 'control_session', path: producer.result_ref };
    const matches = result.artifacts.filter((artifact) => artifact.kind === reference.artifact);
    if (matches.length !== 1) throw new Error(`Producer must return one artifact with kind=${reference.artifact}`);
    if (matches[0].base === 'workspace' && producerInput.workspace_root !== root) throw new Error('Producer workspace differs; integrate artifact before dispatch');
    if (matches[0].base === 'session' && producerSession !== taskSession) throw new Error('Producer session artifact differs from the current worktree session');
    input_refs.push(matches[0]);
  }
  // A question a stage asked before an upstream stage (to-ticket, tracker-publish) was completed again is
  // superseded by that revision: the stage starts over from the new plan instead of waiting for the old answer.
  const upstreamRevisedAfter = (entry) => ['to-ticket', 'tracker-publish'].filter((id) => id !== stageId)
    .some((id) => Date.parse(state.stages?.[id]?.finished_at || 0) > Date.parse(entry?.updated_at || 0));
  const supersededQuestion = !restart && answer === null && feedback === null && state.stages?.[stageId]?.status === 'waiting'
    && state.stages[stageId].code === 'USER_DECISION_REQUIRED' && upstreamRevisedAfter(state.stages[stageId]);
  const previous = restart || supersededQuestion ? null : state.stages?.[stageId];
  // The user may also redirect a stage that is waiting on its own question: the instruction replaces that question,
  // and the stage resumes in the same conversation with it instead of an answer.
  const userRevisionWaiting = userRevision && previous?.result_ref && (previous.status === 'completed' && previous.code === 'OK' || previous.status === 'waiting' && previous.code === 'USER_DECISION_REQUIRED');
  if (userRevision && !userRevisionWaiting) throw new Error('User revision requires a completed stage or one waiting on its question');
  if (userRevision && Object.values(state.stages).some((item) => item?.status === 'running')) throw new Error('User revision cannot start while another stage is running');
  if (requirementsRevision) markRequirementsRevision(structuredClone(state), stageId, previous.execution_id, null, null);
  let conversation = {};
  let interruptedAnswers;
  // The owner of a gap, or a stage a rewind marked stale, is a finished stage that is edited forward from its own result.
  const reopenedForward = Boolean(reopenPlan) || Boolean(staleMark && previous?.result_ref && (previous.status === 'completed' && previous.code === 'OK' || previous.status === 'waiting' && previous.code === 'USER_DECISION_REQUIRED'));
  const crossStageRevision = transition && lastStage !== stageId && REVISION_TARGETS[transition.code] === stageId;
  if (reopenedForward) {
    const prefix = `runtime/executions/${previous.execution_id}`;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    if (previousInput.skill !== stage.skill || previousInput.context?.stage_id !== stageId || previousInput.workspace_root !== root || previousInput.session_directory !== taskSession || previousInput.context?.worktree_ref !== worktreeRef) throw new Error('Feedback target does not match stage state');
    const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
    await validateSkillReturn({ root, input: previousInput, envelope: previousReturn, reopening: true });
    if (previousReturn.result_ref !== previous.result_ref || previousReturn.code !== previous.code) throw new Error('Feedback target does not match stage state');
    const previousPath = (await findExecutionInput(root, previous.execution_id)).path;
    input_refs.push(...previousInput.input_refs, { base: 'session', path: previousPath.slice('.io/'.length), kind: 'previous_execution_input' }, { base: 'session', path: previous.result_ref, kind: 'previous_execution_result' });
    if (reopenPlan) {
      const blockedPath = (await findExecutionInput(root, reopenPlan.blocked_execution_id)).path;
      input_refs.push({ base: 'session', path: blockedPath.slice('.io/'.length), kind: 'dependency_gap_input' }, { base: reopenPlan.blocked_result_base, path: reopenPlan.blocked_result_ref, kind: 'dependency_gap_result' });
      const answers = `runtime/executions/${reopenPlan.blocked_execution_id}/answers.json`;
      const blockedSession = reopenPlan.blocked_result_base === 'session' ? taskSession : session;
      if (await lstat(join(blockedSession, answers)).then((info) => info.isFile(), (error) => { if (error.code === 'ENOENT') return false; throw error; })) input_refs.push({ base: reopenPlan.blocked_result_base, path: answers, kind: 'dependency_gap_answers' });
    }
    conversation = {
      previous_result_ref: previous.result_ref,
      reopen: reopenPlan
        ? { reason: 'dependency_gap', owner_stage: reopenPlan.owner_stage, blocked_stage: reopenPlan.blocked_stage, blocked_execution_id: reopenPlan.blocked_execution_id, rerun_order: reopenPlan.stale.rerun_order }
        : { reason: 'upstream_changed', owner_stage: staleMark.owner_stage, blocked_stage: staleMark.blocked_stage, blocked_execution_id: staleMark.reopened_for, rerun_order: staleMark.rerun_order },
    };
  } else if (feedback !== null && crossStageRevision && !previous) {
    conversation = { previous_result_ref: transition.result_ref };
  } else if (feedback !== null) {
    if (!previous) throw new Error('Feedback requires a review, matching revision or blocked stage, or a confirmed interrupted stage');
    const prefix = `runtime/executions/${previous.execution_id}`;
    // A host killed while it wrote the input leaves a 0-byte input.json. Only an interrupted run can resume without it: the
    // plan comes from --plan and the earlier input references are not carried over.
    let lostInput = null;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id }).catch((error) => { if (error.code === 'ENOENT' && error.empty) { lostInput = error; return null; } throw error; });
    if (userRevision && stageId === 'implement-wrapper') {
      if (previous.status !== 'completed' || previous.code !== 'OK') throw new Error('E2E repair requires a completed implementation');
      if (previousInput.context?.plan_id !== planId) throw new Error('Implementation revision plan must match the completed stage');
      if (!/^runtime\/execution\/[A-Za-z0-9._-]+\/receipt\.json$/.test(repairReceipt)) throw new Error('Invalid E2E failure receipt reference');
      const receipt = await readSkillSessionJson({ root, session_directory: taskSession, path: repairReceipt });
      if (lastStage === 'e2e-test') {
        if (!last?.result_ref || !['failed', 'blocked', 'waiting'].includes(last.status)) throw new Error('E2E repair requires a validated failed stage result');
        const e2eInput = await readExecutionInput({ root, execution_id: last.execution_id });
        const e2eReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/executions/${last.execution_id}/return.json` });
        await validateSkillReturn({ root, input: e2eInput, envelope: e2eReturn });
        if (e2eReturn.result_ref !== last.result_ref || !e2eReturn.result?.artifacts?.some((item) => item.base === 'session' && item.path === repairReceipt && item.kind === 'e2e_receipt')) throw new Error('Repair receipt is not owned by the failed E2E stage');
        if (testDefectFailure && !e2eReturn.result.artifacts.some((item) => item.base === 'session' && item.path === testDefectFailure && item.kind === 'e2e_failure')) throw new Error('Test defect evidence is not owned by the failed E2E stage');
      }
      if (!['failed', 'blocked', 'interrupted'].includes(receipt.status) || !receipt.profile_id || !receipt.finished_at) throw new Error('E2E failure receipt is not a finished failure');
      if (!/^[a-f0-9]{64}$/.test(receipt.config_hashes?.['.harness/agents/execution.json'] || '')) throw new Error('E2E failure receipt lacks profile evidence');
      const review = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/reviews/implementation-${planId}-evidence.json` });
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (review.review_input?.implementation_commit_sha !== head || (receipt.head && receipt.head !== head)) throw new Error('E2E failure target commit is stale');
      const plan = await readFile(join(root, 'docs/plans', plan_set_id, `${planId}.md`), 'utf8');
      if (!plan.includes(`\`${receipt.profile_id}\``)) throw new Error('E2E failure profile does not match the plan');
      const orchestratorId = orchestratorSession?.session_id || codexSessionId;
      if (testDefectFailure) {
        if (!/^runtime\/e2e\/[A-Za-z0-9._-]+\/failure\.json$/.test(testDefectFailure)) throw new Error('Invalid test defect evidence reference');
        const failure = await readSkillSessionJson({ root, session_directory: taskSession, path: testDefectFailure });
        const copy = await readSkillSessionJson({ root, session_directory: taskSession, path: testDefectFailure.replace(/failure\.json$/, 'receipt.json') });
        if (receipt.status !== 'failed' || receipt.phase !== 'command' || failure.status !== 'failed' || failure.profile_id !== receipt.profile_id || failure.target_commit !== head || !Array.isArray(failure.failures) || !failure.failures.length || !isDeepStrictEqual(copy, receipt)) throw new Error('Test defect evidence does not match the failed E2E run');
      }
      if (!orchestratorId || !await userSaidAfter({ root, text: approvalAnswer, sessionId: orchestratorId, provider, ...(testDefectFailure ? { until: receipt.started_at } : { since: new Date(Date.parse(receipt.finished_at) + 1).toISOString() }) })) throw new Error('E2E repair approval was not recorded for this failure');
      for (const [path, hash] of Object.entries(receipt.config_hashes || {})) {
        await assertWorkspaceTarget(root, path);
        if (createHash('sha256').update(await readFile(join(root, path))).digest('hex') !== hash) throw new Error(`E2E failure receipt is stale: ${path}`);
      }
    }
    if (PLAN_STAGES.has(stageId) && planId === null) planId = previousInput?.context?.plan_id ?? null;
    // A stage the user cancelled (for example to update Harness) resumes like a failed one: same conversation,
    // after checking that its processes are gone.
    let interrupted = ['failed', 'cancelled'].includes(previous?.status);
    if (interrupted) await assertExecutionStopped(previous);
    if (!interrupted && previous?.status === 'running' && !previous.result_ref) {
      await assertExecutionStopped(previous);
      interrupted = true;
    }
    const reviewWaiting = previous?.status === 'waiting' && previous.code === 'REVIEW_REQUIRED' && previous.result_ref;
    const revisionWaiting = previous?.status === 'waiting' && previous.result_ref && REVISION_TARGETS[previous.code] === stageId;
    if (!interrupted && !(reviewWaiting || revisionWaiting || userRevisionWaiting || crossStageRevision || standaloneE2eRetry || frontendCorrection || (previous?.status === 'blocked' && previous.result_ref))) throw new Error('Feedback requires a failed, cancelled, review, matching revision, blocked, or confirmed interrupted stage');
    if (lostInput && !interrupted) throw lostInput;
    if (lostInput && PLAN_STAGES.has(stageId) && planId === null) throw new Error(`${lostInput.message}; pass --plan <ticket-id> to resume ${stageId}`);
    if (previousInput && (previousInput.skill !== stage.skill || previousInput.context?.stage_id !== stageId || previousInput.workspace_root !== root || previousInput.session_directory !== taskSession || previousInput.context?.worktree_ref !== worktreeRef)) throw new Error('Feedback target does not match stage state');
    if (!interrupted) {
      const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
      if (previousSession !== taskSession) throw new Error('Feedback target belongs to a different worktree session');
      const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
      await validateSkillReturn({ root, input: previousInput, envelope: previousReturn, reopening: Boolean(userRevisionWaiting || (crossStageRevision && previous.status === 'completed' && previous.code === 'OK')) });
      if (previousReturn.result_ref !== previous.result_ref || previousReturn.code !== previous.code || ((reviewWaiting || revisionWaiting) && previousReturn.status !== 'action_required')) throw new Error('Feedback target does not match stage state');
    }
    if (interrupted) {
      interruptedAnswers = join(taskSession, prefix, 'answers.json');
      const deferredPath = `${prefix}/deferred-answers.json`;
      const deferred = await readSkillSessionJson({ root, session_directory: taskSession, path: deferredPath }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (deferred) {
        if (!Array.isArray(deferred)) throw new Error('Invalid deferred answers');
        input_refs.push({ base: 'session', path: deferredPath, kind: 'deferred_user_answers_unverified' });
      }
    }
    const priorResult = crossStageRevision ? transition.result_ref : previous.result_ref || (interrupted ? previousInput?.context?.previous_result_ref : null);
    if (previousInput) {
      const previousPath = (await findExecutionInput(root, previous.execution_id)).path;
      input_refs.push(...previousInput.input_refs, { base: 'session', path: previousPath.slice('.io/'.length), kind: 'previous_execution_input' });
    }
    if (priorResult) input_refs.push({ base: 'session', path: priorResult, kind: 'previous_execution_result' });
    conversation = { ...(userRevision ? { user_revision: true } : {}), ...(outOfWorkflowStage ? { out_of_workflow_stage: outOfWorkflowStage } : {}), ...(priorResult && (interrupted || previous?.status === 'blocked') ? { previous_result_note: PREVIOUS_RESULT_NOTE } : {}), ...(repairReceipt ? { e2e_failure_receipt: repairReceipt, e2e_repair_approval: approvalAnswer } : {}), ...(testDefectFailure ? { e2e_test_defect_failure: testDefectFailure } : {}), ...(priorResult ? { previous_result_ref: priorResult } : {}) };
  }
  let deferredAnswers = null;
  if (!userRevision && !staleMark && previous?.status === 'waiting' && previous.code === 'USER_DECISION_REQUIRED') {
    deferredAnswers = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/executions/${previous.execution_id}/deferred-answers.json` }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (deferredAnswers && (!Array.isArray(deferredAnswers) || deferredAnswers.some((entry) => !entry || Object.keys(entry).sort().join(',') !== 'answer,question_id' || typeof entry.question_id !== 'string' || !entry.question_id.trim() || typeof entry.answer !== 'string' || !entry.answer.trim()) || new Set(deferredAnswers.map((entry) => entry.question_id)).size !== deferredAnswers.length)) throw new Error('Invalid deferred answers');
  }
  if ((previous?.code === 'USER_DECISION_REQUIRED' && !userRevisionWaiting && !staleMark) || answer !== null) {
    if (answer === null && !deferredAnswers) throw new Error('User answer required before resuming this stage');
    if (previous?.status !== 'waiting') throw new Error('Stage is not waiting for a response');
    const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
    if (previousSession !== taskSession) throw new Error('Pending decision belongs to a different worktree session');
    const prefix = `runtime/executions/${previous.execution_id}`;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    if (PLAN_STAGES.has(stageId) && planId === null) planId = previousInput.context?.plan_id ?? null;
    const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
    await validateSkillReturn({ root, input: previousInput, envelope: previousReturn });
    if (previousReturn.status !== 'action_required' || previousReturn.code !== previous.code || previousReturn.result_ref !== previous.result_ref || previousInput.skill !== stage.skill) throw new Error('Pending response does not match stage state');
    const result = previousReturn.result || await readSkillSessionJson({ root, session_directory: previousSession, path: previous.result_ref });
    {
      const previousPath = (await findExecutionInput(root, previous.execution_id)).path;
      input_refs.push(...previousInput.input_refs, { base: 'session', path: previousPath.slice('.io/'.length), kind: 'previous_execution_input' }, { base: 'session', path: previous.result_ref, kind: 'previous_execution_result' });
    }
    let deferred = [];
    if (deferredAnswers) {
      const ids = new Set(result.questions.map((question) => question.question_id));
      deferred = deferredAnswers.filter((item) => ids.has(item.question_id));
      if (deferred.length !== deferredAnswers.length) input_refs.push({ base: 'session', path: `${prefix}/deferred-answers.json`, kind: 'deferred_user_answers_unverified' });
    }
    const batchAnswers = await collectAnswers(taskSession, prefix, result.questions, answer, deferred);
    if (batchAnswers.conflict) return { status: 'clarification_needed', stage_id: stageId, message: batchAnswers.conflict, next: 'Ask the user in Korean to change one of the two choices, then pass their new reply verbatim with the same answer command. Nothing was recorded.' };
    if (!batchAnswers.complete) {
      const answered = new Set(batchAnswers.answers.map(({ question_id }) => question_id));
      const questions = result.questions.filter(({ question_id }) => !answered.has(question_id));
      return { waiting_for_answers: true, questions, answers: batchAnswers.answers, ...(batchAnswers.clarifications ? { clarifications: batchAnswers.clarifications } : {}) };
    }
    answer = batchAnswers.answers;
    conversation = { previous_result_ref: previous.result_ref };
  }
  workflowBinding = historicalBinding?.provider === provider ? historicalBinding : null;
  if (e2eRequest) {
    if (!/^runtime\/e2e\/requests\/[A-Za-z0-9._-]+\.json$/.test(e2eRequest)) throw new Error('Invalid E2E request reference');
    const request = await readSkillSessionJson({ root, session_directory: taskSession, path: e2eRequest });
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (request.target_commit !== head || !Array.isArray(request.scenarios) || !request.scenarios.length || !request.scenarios.every((item) => typeof item === 'string' && item.trim()) || !request.approval_answer || !request.profile_id || !Number.isInteger(request.timeout_ms) || request.timeout_ms <= 0) throw new Error('E2E request target, scenarios, approval or timeout is invalid');
    const manifestText = await readFile(join(root, '.harness/agents/execution.json'));
    if (request.manifest_sha256 !== createHash('sha256').update(manifestText).digest('hex')) throw new Error('E2E request execution profile has changed');
    const manifest = JSON.parse(manifestText);
    const profile = manifest.profiles?.[request.profile_id];
    if (profile?.purpose !== 'e2e' || profile.timeout_ms !== request.timeout_ms) throw new Error('E2E request does not match the execution profile');
    const orchestratorId = orchestratorSession?.session_id || codexSessionId;
    if (!orchestratorId || !await userSaidAfter({ root, text: request.approval_answer, sessionId: orchestratorId, provider })) throw new Error('E2E request approval was not recorded');
    // The current request supersedes any approval reference inherited during a retry.
    // The previous execution input remains available as historical evidence.
    for (let index = input_refs.length - 1; index >= 0; index -= 1) {
      if (input_refs[index].kind === 'approved_e2e_request') input_refs.splice(index, 1);
    }
    input_refs.push({ base: 'session', path: e2eRequest, kind: 'approved_e2e_request', sha256: createHash('sha256').update(await readFile(join(taskSession, e2eRequest))).digest('hex') });
  }
  let plan_review_admission;
  if (stage.skill === 'plan-review') {
    if (!reviewAdmissionRef) throw new Error('Plan review requires an admitted snapshot');
    const { validatePlanReviewAdmission } = await import('./plan-review.mjs');
    plan_review_admission = await validatePlanReviewAdmission({ root, planSetId: plan_set_id, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  }
  const execution_id = `${stage.id}-${randomUUID()}`;
  if (review_admission || plan_review_admission) input_refs.push({ base: 'control_session', path: reviewAdmissionRef });
  if (stage.skill === 'tracker-publish') publicationDrafts = await preparePublicationDrafts({ root, planSetId: plan_set_id });
  if (stageId === 'to-ticket' && plan_set_id) {
    const { planDesignPaths } = await import('./plan-review.mjs');
    for (const path of await planDesignPaths({ root, planSetId: plan_set_id })) {
      if (!input_refs.some((reference) => reference.base === 'workspace' && reference.path === path)) input_refs.push({ base: 'workspace', path });
    }
    const ui = state.stages?.['tactical-ui'];
    if (ui?.status === 'completed' && ui.code === 'OK' && ui.result_ref) {
      const result = await readSkillSessionJson({ root, session_directory: taskSession, path: ui.result_ref });
      input_refs.push(...result.artifacts.filter((item) => item.kind === 'frontend_design_brief'));
    }
  }
  if (PLAN_STAGES.has(stageId) && !planId && (!stageId.startsWith('frontend-') || state.stages?.['tactical-ui'])) throw new Error(`${stageId} needs the assigned ticket or plan`);
  if (planId !== null) {
    if (!plan_set_id) throw new Error('--plan needs a worktree plan set');
    await readFile(join(root, 'docs/plans', plan_set_id, `${planId}.md`)).catch(() => { throw new Error(`Plan ${planId} is not part of plan set ${plan_set_id}`); });
    // tactical-code builds one published ticket per execution, after the tickets it depends on, and reads that ticket's file.
    if (['tactical-code', 'frontend-implementation', 'frontend-visual-review'].includes(stageId)) {
      await assertTicketStartable({ root, planSetId: plan_set_id, planId, resume: feedback !== null || answer !== null });
      input_refs.push({ base: 'workspace', path: `docs/plans/${plan_set_id}/${planId}.md`, kind: 'ticket' });
      await assertFrontendTicketOrder({ root, session: taskSession, state, stageId, planSetId: plan_set_id, planId });
      const ui = state.stages?.['tactical-ui'];
      if (ui?.status === 'completed' && ui.code === 'OK' && ui.result_ref) {
        const result = await readSkillSessionJson({ root, session_directory: taskSession, path: ui.result_ref });
        input_refs.push(...result.artifacts.filter((item) => item.kind === 'frontend_design_brief'));
      }
    }
  }
  const checkpointPath = stageId === 'implement-wrapper' && planId ? planRuntimePaths({ root, planId }).checkpoint_path : null;
  // A plan set that an earlier Harness started holds its tactical design under the legacy name domain-model.md. The stage
  // must find it as tactical-design.md, so the runner renames it here, before the stage runs; the stage commit takes it.
  // The artifacts of finished stages that the stage reads are listed under the current name once the legacy file is gone.
  if (plan_set_id && TACTICAL_DESIGN_STAGES.includes(stage.skill)) {
    await migrateLegacyTacticalDesign({ root, planSetId: plan_set_id });
    for (const reference of input_refs) {
      const renamed = reference.base === 'workspace' ? currentTacticalDesignPath(reference.path) : reference.path;
      if (renamed !== reference.path && !await lstat(join(root, reference.path)).then(() => true, () => false)) reference.path = renamed;
    }
  }
  const { prepareDomainContextPack } = await import('../domain/context-pack.mjs');
  for (let i = input_refs.length - 1; i >= 0; i--) {
    if (input_refs[i].kind === 'domain_context_pack') input_refs.splice(i, 1);
  }
  const domainPack = await prepareDomainContextPack({ root, stage: stageId, request: prepared.scope, feedback, answers: Array.isArray(answer) ? answer : [] });
  if (domainPack) input_refs.push(domainPack);
  const upstream = await upstreamStageRefs({ root, session: taskSession, state, stageId });
  const input = { schema_version: 1, execution_id, skill: stage.skill, workspace_root: root, session_directory: taskSession, scope: stage.scope, input_refs, context: { ...(codexSessionId ? { codex_session_id: codexSessionId } : {}), ...(orchestratorSession ? { orchestrator_session_id: orchestratorSession.session_id, orchestrator_provider: orchestratorSession.provider } : {}), provider, ...(executionWorkspace ? { execution_workspace: executionWorkspace } : {}), ...(publicationDrafts ? { publication_drafts: publicationDrafts } : {}), ...(workflowBinding ? { workflow_binding: workflowBinding } : {}), ...(requestedStageBinding ? { requested_stage_binding: requestedStageBinding } : {}), stage_id: stage.id, control_session_directory: session, workflow_ref: workflowRef, ...conversation, ...(transition ? { transition } : {}), ...(upstream.length ? { upstream } : {}), ...(Object.keys(producer_result_refs).length ? { producer_result_refs } : {}), ...(worktree_ref ? { worktree_ref } : {}), ...(planId ? { plan_id: planId } : {}), ...(plan_set_id ? { plan_set_id } : {}), ...(checkpointPath ? { checkpoint_path: checkpointPath } : {}), ...(publicationApproved ? { publication_approved: true } : {}), ...(review_admission ? { review_admission } : {}), ...(plan_review_admission ? { plan_review_admission } : {}), conditions: stage.conditions, gates: stage.gates, outputs: stage.outputs } };
  if (e2eRequest) input.context.agent_profile = 'e2e_test_runner';
  else if (['frontend-design-brief', 'frontend-implementation', 'frontend-visual-review'].includes(stageId)) input.context.agent_profile = stage.role;
  if (requirementsApproval?.execution_id && requirementsApproval.answer) input.context.requirements_approval = requirementsApproval;
  if (frontendDesignHandoff) input.context.frontend_direction_approval = tacticalUiDirectionRecorded
    ? { answer: approvalAnswer, source: { stage_id: 'tactical-ui', execution_id: tacticalUiFlowDecision.execution_id, question_id: tacticalUiFlowDecision.question_id } }
    : { answer: approvalAnswer, source: { stage_id: 'orchestrator_transcript' } };
  if (requirementsRevision) input.context.requirements_revision_from = previous.execution_id;
  if (staleMark) {
    input.context.revalidation_mark = staleMark.reopened_for;
    if (staleMark.reason === 'user_revision') input_refs.push({ base: 'session', path: `runtime/executions/${staleMark.reopened_for}/feedback.json`, kind: 'upstream_user_revision' });
  }
  input.input_refs = input.input_refs.filter((item, index, refs) => refs.findIndex((other) => item.base === other.base && item.path === other.path && item.kind === other.kind && item.sha256 === other.sha256) === index);
  const { stageWorkspace } = await import('./stage-workspace.mjs');
  input.context.workspace = await stageWorkspace(root, plan_set_id);
  // The persona binding the GUIDE would otherwise look up with one command; left out when it cannot be resolved.
  if (PERSONA_STAGES.includes(input.skill)) {
    try {
      const { model, reasoning_effort } = await resolveSkillBinding({ root, skill: 'stakeholder-persona', executionProvider: provider });
      input.context.workspace.persona_binding = { skill: 'stakeholder-persona', provider, model, reasoning_effort };
    } catch { /* the GUIDE falls back to the binding command */ }
  }
  // The binding of the independent gap reviewer that requirements-fix starts once; same fallback as the persona.
  if (input.skill === 'requirements-fix') {
    try {
      const { model, reasoning_effort } = await resolveSkillBinding({ root, skill: 'requirements-gap-review', executionProvider: provider });
      input.context.workspace.gap_reviewer_binding = { skill: 'requirements-gap-review', provider, model, reasoning_effort };
    } catch { /* the GUIDE falls back to the binding command */ }
  }
  await validateSkillInput({ root, input });
  const path = await writeExecutionInput(root, storedStageInput(input), plan_set_id);
  if (restart) await archiveToTicket({ root, session: taskSession, planSetId: plan_set_id, previousExecutionId: state.stages['to-ticket'].execution_id, restartExecutionId: execution_id });
  const paths = stageExecutionPaths(root, execution_id);
  if (paths.session !== taskSession) throw new Error('Execution session does not match workspace');
  await mkdir(paths.directory, { recursive: true });
  if (Array.isArray(answer)) await writeFile(paths.files.answers, JSON.stringify(answer, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (interruptedAnswers) await copyFile(interruptedAnswers, paths.files.answers).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (feedback !== null) await writeFile(paths.files.feedback, JSON.stringify({ feedback }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const storedInput = storedStageInput(input);
  return { input: storedInput, path, session_directory: taskSession, execution_directory: paths.directory, ...(answer !== null ? { answer } : {}) };
}
