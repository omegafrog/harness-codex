import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { sessionDirectory } from './session-output.mjs';
import { parseWorktreeRecord, recordWorkflowSession } from './worktrees.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { findExecutionInput } from './execution-input.mjs';
import { WORKTREE_STAGE } from './worktree-stages.mjs';

const exec = promisify(execFile);
const git = async (root, args) => (await exec('git', args, { cwd: root, encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const ACTIVE = new Set(['created', 'running', 'waiting', 'blocked']);
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

async function observedProcessStatus(entry) {
  if (entry?.status !== 'running') return null;
  const identities = [entry.owner, ...(entry.runner_managed && !entry.child ? [] : [entry.child])];
  if (identities.some((item) => !item?.pid || !item.boot || !item.start)) return 'unknown';
  const { processIdentity } = await import('./execution-state.mjs');
  let current;
  try { current = await Promise.all(identities.map((item) => processIdentity(item.pid))); }
  catch { return 'unknown'; }
  if (current.some((item) => !item)) return 'unknown';
  return current.some((item, index) => item.boot === identities[index].boot && item.start === identities[index].start && item.state !== 'Z') ? 'running' : 'stopped';
}

async function readJson(directory, file) {
  await assertWorkspaceTarget(directory, file);
  const path = join(directory, file);
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.nlink > 1 || info.size > 2 * 1024 * 1024) throw new Error('Unsafe or oversized startup record');
  return JSON.parse(await readFile(path, 'utf8'));
}

function gitWorktrees(text) {
  const rows = [];
  for (const token of text.split('\0')) {
    if (token.startsWith('worktree ')) rows.push({ workspace: resolve(token.slice(9)), branch: null });
    else if (token.startsWith('branch ') && rows.length) rows.at(-1).branch = token.slice(7).replace(/^refs\/heads\//, '');
  }
  return rows;
}

// The active worktree owns its orchestration; the primary checkout only creates worktrees.
export async function bindOrchestratorSession({ root, provider, sessionId }) {
  if (!sessionId || !['codex', 'claude-code'].includes(provider)) return null;
  const path = join(root, '.io/worktree.json');
  let record;
  try { record = parseWorktreeRecord(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (record.state !== 'active' || await realpath(record.workspace) !== await realpath(root)) return null;
  const current = record.agent_sessions?.orchestrator;
  if (current?.session_id === sessionId && current?.provider === provider) return current;
  return recordWorkflowSession({ workspace_root: root, repository_root: record.return_root, key: 'orchestrator', session_id: sessionId, execution_id: 'orchestrator-prompt', provider });
}

// A conversation keeps its earlier conclusions after Harness is updated. When the installed files changed since this
// session last prompted, tell the orchestrator to re-read the guides before trusting what it decided earlier.
export async function harnessUpdateNotice({ root, sessionId }) {
  if (!sessionId) return null;
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile, rename } = await import('node:fs/promises');
  let lock;
  try { lock = await readFile(join(root, '.codex/harness-lock.json')); } catch { return null; }
  const current = createHash('sha256').update(lock).digest('hex').slice(0, 12);
  let session;
  try { session = sessionDirectory(root, { create: false }); } catch { return null; }
  const path = 'runtime/orchestrator/harness-seen.json';
  let seen = {};
  try { seen = JSON.parse(await readFile(join(session, path), 'utf8')); } catch { seen = {}; }
  if (seen[sessionId] === current) return null;
  await assertWorkspaceTarget(session, path);
  await mkdir(join(session, 'runtime/orchestrator'), { recursive: true, mode: 0o700 });
  const temporary = join(session, `${path}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...seen, [sessionId]: current }), { mode: 0o600 });
  await rename(temporary, join(session, path));
  return seen[sessionId] ? `Harness was updated since this conversation last ran (installed files ${seen[sessionId]} -> ${current}). Conclusions you reached earlier about what Harness can or cannot do may be outdated: re-read the relevant GUIDE or reference before relying on them.` : null;
}

export async function inspectStartupState({ workspaceRoot, sessionId = null, provider = 'codex', codexSessionId = null }) {
  sessionId ||= codexSessionId;
  const root = await realpath(workspaceRoot);
  const [commonText, listing] = await Promise.all([git(root, ['rev-parse', '--git-common-dir']), git(root, ['worktree', 'list', '--porcelain', '-z'])]);
  const common = await realpath(resolve(root, commonText.trim()));
  const registered = gitWorktrees(listing);
  const current = registered.find((entry) => entry.workspace === root);
  const currentSession = sessionDirectory(root, { create: false });
  const legacySession = null;
  const directories = registered.map((entry) => entry.workspace);
  const entries = await Promise.all(registered.map(async ({ workspace }) => {
    const session = join(workspace, '.io');
    const info = await lstat(session).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    return info ? { session, info } : null;
  }));
  const records = [], states = [], issues = [];
  let currentOrphan = false, currentForeign = false;
  for (const { session, info } of entries.filter(Boolean)) {
    if (!info.isDirectory() || await realpath(session) !== session) { issues.push({ path: session, reason: 'unsafe_session_directory' }); continue; }
    let sessionRecord = null;
    try {
      const record = await readJson(session, 'worktree.json');
      if (!record) {
        const legacy = await readJson(session, 'receipt.json');
        if (legacy?.worktree_id) issues.push({ path: join(session, 'receipt.json'), reason: 'legacy_worktree_record_requires_recovery' });
      }
      if (record) {
        parseWorktreeRecord(JSON.stringify(record));
        sessionRecord = record;
        if (record.common !== common || record.session_directory !== session || sessionDirectory(record.workspace, { repositoryRoot: root, create: false }) !== session) throw new Error('Worktree record ownership mismatch');
        const actual = registered.find((item) => item.workspace === resolve(record.workspace));
        const present = await lstat(record.workspace).then((info) => info.isDirectory(), (error) => { if (error.code === 'ENOENT') return false; throw error; });
        const matches = Boolean(actual && actual.branch === record.branch);
        const status = record.state === 'active' && present && matches ? 'verified_active' : record.state === 'removed' && !present && !actual ? 'closed' : 'recovery_required';
        records.push({ record_path: join(session, 'worktree.json'), workspace_root: record.workspace, worktree_id: record.worktree_id, plan_set_id: record.plan_set_id || null, branch: record.branch, orchestrator: record.agent_sessions?.orchestrator || null, record_state: record.state, outcome: record.outcome || null, git_registered: Boolean(actual), path_exists: present, branch_matches: matches, current: resolve(record.workspace) === root, status });
      }
    } catch (error) { issues.push({ path: join(session, 'worktree.json'), reason: error.message }); }
    try {
      const document = await readJson(session, 'runtime/orchestrator/workflow.json');
      const state = document?.state || await readJson(session, 'runtime/orchestrator/state.json');
      if (!state) {
        if ([currentSession, legacySession].includes(session) && await readJson(session, 'runtime/orchestrator/workflow.json')) currentOrphan = true;
        continue;
      }
      if (![currentSession, legacySession].includes(session) && !records.some((record) => dirname(record.record_path) === session)) {
        issues.push({ path: join(session, 'runtime/orchestrator/workflow.json'), reason: 'workflow_without_worktree_record' });
        continue;
      }
      const orchestratorSession = sessionRecord?.agent_sessions?.orchestrator;
      const ownerSessionId = orchestratorSession?.session_id || state.orchestrator_session_id || state.codex_session_id;
      const ownerProvider = orchestratorSession?.provider || state.orchestrator_provider || (state.codex_session_id ? 'codex' : null);
      if ([currentSession, legacySession].includes(session) && ownerSessionId && sessionId && (ownerSessionId !== sessionId || ownerProvider && ownerProvider !== provider)) currentForeign = true;
      if (state.schema_version !== 1 || (!ACTIVE.has(state.status) && !TERMINAL.has(state.status))) throw new Error('Invalid orchestrator state');
      const ref = state.workflow_ref;
      if (ref === null && (ACTIVE.has(state.status) || TERMINAL.has(state.status))) {
        const processStatus = await observedProcessStatus(state.stages?.[state.current_stage]);
        states.push({ path: join(session, 'runtime/orchestrator/state.json'), session_directory: session, workflow_path: null, status: state.status === 'running' && processStatus !== null ? processStatus : state.status, recorded_status: state.status, process_status: processStatus, current_stage: state.current_stage, composition_pending: state.stages?.[WORKTREE_STAGE.WORKFLOW_COMPOSE]?.status !== 'completed', orchestrator_session_id: sessionRecord?.agent_sessions?.orchestrator?.session_id || state.codex_session_id || null, agent_sessions: sessionRecord?.agent_sessions || {} });
        continue;
      }
      if (typeof ref !== 'string' || isAbsolute(ref) || win32.isAbsolute(ref) || ref.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid workflow reference');
      const workflow = document || await readJson(session, ref);
      if (!workflow || workflow.schema_version !== 1 || !Array.isArray(workflow.stages) || !workflow.stages.length) throw new Error('Workflow file missing or invalid');
      let agentSessions = sessionRecord?.agent_sessions || {};
      if (!Object.keys(agentSessions).length) {
        for (const stage of Object.values(state.stages || {})) {
          const taskSession = stage.result_session_directory;
          if (typeof taskSession !== 'string' || !isAbsolute(taskSession) || taskSession.split(/[\\/]/).at(-1) !== '.io' || !directories.includes(dirname(taskSession))) continue;
          let recordSession = taskSession;
          let taskRecord = await readJson(taskSession, 'worktree.json');
          if (!taskRecord && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(stage.execution_id || '')) {
            const input = await findExecutionInput(root, stage.execution_id).then((found) => found.input, (error) => { if (error.code === 'ENOENT') return null; throw error; });
            const reference = input?.context?.worktree_ref;
            const candidate = typeof reference === 'string' && isAbsolute(reference) && reference.endsWith('/worktree.json') ? dirname(reference) : null;
            if (candidate && candidate.split(/[\\/]/).at(-1) === '.io' && directories.includes(dirname(candidate))) {
              taskRecord = await readJson(candidate, 'worktree.json');
              recordSession = candidate;
            }
          }
          if (!taskRecord) continue;
          parseWorktreeRecord(JSON.stringify(taskRecord));
          if (taskRecord.common !== common || taskRecord.session_directory !== recordSession) throw new Error('Agent session worktree record ownership mismatch');
          const actual = registered.find((item) => item.workspace === resolve(taskRecord.workspace));
          const present = await lstat(taskRecord.workspace).then((info) => info.isDirectory(), (error) => { if (error.code === 'ENOENT') return false; throw error; });
          if (taskRecord.state !== 'active' || !present || actual?.branch !== taskRecord.branch) throw new Error('Agent session worktree is not verified active');
          agentSessions = taskRecord.agent_sessions || {};
          if (Object.keys(agentSessions).length) break;
        }
      }
      const processStatus = await observedProcessStatus(state.stages?.[state.current_stage]);
      states.push({ path: join(session, 'runtime/orchestrator/workflow.json'), session_directory: session, workflow_path: join(session, ref), status: state.status === 'running' && processStatus !== null ? processStatus : state.status, recorded_status: state.status, process_status: processStatus, current_stage: state.current_stage || null, orchestrator_session_id: agentSessions.orchestrator?.session_id || state.codex_session_id || null, agent_sessions: agentSessions });
    } catch (error) { issues.push({ path: join(session, 'runtime/orchestrator/workflow.json'), reason: error.message }); }
  }
  const currentRecord = records.find((record) => record.current);
  const activeStates = states.filter((state) => ACTIVE.has(state.recorded_status || state.status));
  const worktreeCandidates = [];
  for (const state of activeStates) {
    const record = records.find((item) => dirname(item.record_path) === state.session_directory && item.status === 'verified_active');
    if (!record) continue;
    const ledger = (await readJson(state.session_directory, 'runtime/orchestrator/workflow.json'))?.state || await readJson(state.session_directory, 'runtime/orchestrator/state.json');
    const executionId = ledger?.stages?.[WORKTREE_STAGE.WORKFLOW_COMPOSE]?.execution_id;
    let request = null;
    if (executionId) {
      try {
        const { input } = await findExecutionInput(record.workspace_root, executionId);
        if (input.skill === 'workflow-compose' && input.context?.worktree_ref === record.record_path && typeof input.scope === 'string') request = input.scope.slice(0, 2000);
      } catch (error) { if (error.code !== 'ENOENT') issues.push({ path: record.record_path, reason: `compose_input_invalid: ${error.message}` }); }
    }
    worktreeCandidates.push({ workspace_root: record.workspace_root, worktree_ref: record.record_path, request, status: state.status, current_stage: state.current_stage });
  }
  for (const state of states) {
    const record = records.find((item) => dirname(item.record_path) === state.session_directory);
    state.worktree_ref = record?.record_path || null;
    state.workspace_root = record?.workspace_root || null;
  }
  for (const record of records.filter((item) => !item.current && item.status === 'verified_active')) {
    if (!worktreeCandidates.some((candidate) => candidate.worktree_ref === record.record_path)) {
      worktreeCandidates.push({ workspace_root: record.workspace_root, worktree_ref: record.record_path, request: null, status: 'active', current_stage: null });
    }
  }
  const localStates = states.filter((state) => state.session_directory === currentSession);
  const relevantActive = localStates.filter((state) => ACTIVE.has(state.recorded_status || state.status));
  const selectedStates = localStates;
  const associatedRecord = selectedStates.length === 1 ? records.find((record) => dirname(record.record_path) === selectedStates[0].session_directory) : null;
  const relevantIssues = issues.filter((issue) => issue.path.startsWith(`${currentSession}/`) || issue.reason !== 'unassigned_codex_session');
  let hint = 'compose_candidate', reason = 'No active workflow in the current repository';
  if (!current || relevantIssues.length || currentRecord?.status === 'recovery_required' || (relevantActive.length === 1 && associatedRecord && associatedRecord.status !== 'verified_active') || (registered[0]?.workspace !== root && !currentRecord)) {
    hint = 'inspect_required'; reason = 'Workflow state, records or Git registration require inspection';
  } else if (registered[0]?.workspace === root && records.some((record) => !record.current && record.status === 'verified_active')) {
    hint = 'worktree_required'; reason = 'A linked worktree is active; change directory to that worktree before invoking the orchestrator';
  } else if (relevantActive.length) {
    hint = 'resume_candidate'; reason = 'The current worktree has a persisted active workflow';
  } else if (registered[0]?.workspace === root && activeStates.length) {
    hint = 'worktree_required'; reason = 'An active workflow exists in a linked worktree; change directory to that worktree before invoking the orchestrator';
  } else if (currentRecord?.status === 'verified_active' || currentOrphan || registered[0]?.workspace !== root) {
    hint = 'inspect_required'; reason = 'Existing or unowned worktree/workflow must be associated before composition';
  } else if (states.length === 1) reason = `Matching ${provider} session workflow is terminal`;
  return {
    schema_version: 1, provider, session_id: sessionId || null, ...(provider === 'codex' ? { codex_session_id: sessionId || null } : {}), workspace_root: root,
    git: { common_dir: common, current_registered: Boolean(current), is_primary: registered[0]?.workspace === root, branch: current?.branch || null, registered_worktree_count: registered.length },
    matching_workflows: selectedStates.slice(0, 8), matching_workflow_count: selectedStates.length, omitted_workflow_count: Math.max(0, selectedStates.length - 8), current_workspace_has_other_session_state: currentForeign, worktree_record_count: records.length, worktrees: [...records].sort((a, b) => Number(b.current) - Number(a.current)).slice(0, 8), omitted_worktree_count: Math.max(0, records.length - 8),
    session_worktrees: currentRecord?.status === 'verified_active' ? [currentRecord] : [],
    worktree_candidates: worktreeCandidates.slice(0, 8), omitted_worktree_candidate_count: Math.max(0, worktreeCandidates.length - 8),
    issues: issues.slice(0, 8), omitted_issue_count: Math.max(0, issues.length - 8), decision_hint: hint, reason,
  };
}

// Inputs belong only to the worktree whose directory is the current workspace.
export function orchestratorInputTarget(observed) {
  if (observed.issues?.length) return null;
  return (observed.session_worktrees || []).find((record) => record.workspace_root === observed.workspace_root) || null;
}

// Progress is a projection of orchestrator decisions, never a workflow transition.
export async function refreshWorkflowProgress(observed, event) {
  if (observed.matching_workflow_count > 1 && !observed.issues.length) {
    const workflows = await Promise.all(observed.matching_workflows.map((workflow) => refreshWorkflowProgress({ matching_workflow_count: 1, matching_workflows: [workflow], issues: [] }, event)));
    return { workflows };
  }
  if (observed.matching_workflow_count !== 1 || observed.issues.length) return null;
  const match = observed.matching_workflows[0];
  const session = match.session_directory;
  const workflow = await readJson(session, 'runtime/orchestrator/workflow.json');
  const state = workflow?.state || await readJson(session, 'runtime/orchestrator/state.json');
  if (!state) return null;
  const statuses = new Set(['pending', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled', 'skipped']);
  const definitions = workflow?.stages || Object.keys(state.stages || {}).map((id) => ({ id }));
  const stages = await Promise.all(definitions.map(async ({ id, needs = [] }) => {
    const entry = state.stages?.[id];
    if (entry && !statuses.has(entry.status)) throw new Error(`Invalid stage status: ${id}`);
    const processStatus = await observedProcessStatus(entry);
    return { id, needs, status: processStatus === 'stopped' ? 'stopped' : processStatus === 'unknown' ? 'unknown' : entry?.status || 'pending', recorded_status: entry?.status || 'pending', process_status: processStatus, execution_id: entry?.execution_id || null, result_ref: entry?.result_ref || null, reason: entry?.reason || null };
  }));
  statuses.add('stopped'); statuses.add('unknown');
  const counts = Object.fromEntries([...statuses].map((status) => [status, stages.filter((stage) => stage.status === status).length]));
  const record = await readJson(session, 'worktree.json');
  let request = null;
  const composeId = state.stages?.[WORKTREE_STAGE.WORKFLOW_COMPOSE]?.execution_id;
  if (record && composeId && record.workspace === dirname(session) && record.session_directory === session) {
    parseWorktreeRecord(JSON.stringify(record));
    const { input } = await findExecutionInput(record.workspace, composeId).catch((error) => {
      if (error.code === 'ENOENT') return { input: null };
      throw error;
    });
    if (input?.skill === WORKTREE_STAGE.WORKFLOW_COMPOSE && input.context?.worktree_ref === join(session, 'worktree.json') && typeof input.scope === 'string') request = input.scope.slice(0, 2000);
  }
  const current = stages.find((item) => item.id === state.current_stage);
  const status = state.status === 'running' && ['stopped', 'unknown'].includes(current?.status) ? current.status : state.status;
  const orchestratorSessionId = record?.agent_sessions?.orchestrator?.session_id || state.orchestrator_session_id || state.codex_session_id || null;
  const progress = { schema_version: 1, orchestrator_provider: record?.agent_sessions?.orchestrator?.provider || state.orchestrator_provider || (state.codex_session_id ? 'codex' : null), orchestrator_session_id: orchestratorSessionId, codex_session_id: state.codex_session_id || (state.orchestrator_provider === 'codex' ? orchestratorSessionId : null), workspace_root: record?.workspace || null, worktree_ref: record ? join(session, 'worktree.json') : null, request, workflow_id: workflow?.workflow_id || null, status, recorded_status: state.status, current_stage: state.current_stage, updated_at: new Date().toISOString(), observed_event: event, measurement: workflow ? 'completed_stages / total_stages; not effort or time' : 'recorded stages only; future stages are unknown', total_stages: workflow ? stages.length : null, counts, completion_percent: workflow && stages.length ? Math.floor(counts.completed * 100 / stages.length) : null, stages, issues: workflow && state.status === 'completed' && counts.completed + counts.skipped !== stages.length ? ['Workflow completion disagrees with stage ledger'] : [] };
  const path = 'runtime/orchestrator/progress.json';
  await assertWorkspaceTarget(session, path);
  const { randomUUID } = await import('node:crypto');
  const { writeFile, rename, unlink } = await import('node:fs/promises');
  const temporary = join(session, `runtime/orchestrator/.progress-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(session, path));
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  return progress;
}
