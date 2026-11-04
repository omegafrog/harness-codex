import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { sessionDirectory } from './session-output.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';
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
        records.push({ record_path: join(session, 'worktree.json'), workspace_root: record.workspace, record_state: record.state, outcome: record.outcome || null, git_registered: Boolean(actual), path_exists: present, branch_matches: matches, current: resolve(record.workspace) === root, status });
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
  const selectedStates = activeStates.length ? activeStates : states.slice(-1);
  const associatedRecord = selectedStates.length === 1 ? records.find((record) => dirname(record.record_path) === selectedStates[0].session_directory) : null;
  const relevantIssues = issues.filter((issue) => issue.path.startsWith(`${currentSession}/`) || issue.reason !== 'unassigned_codex_session');
  let hint = 'compose_candidate', reason = 'No active workflow in the current repository';
  if (!current || relevantIssues.length || activeStates.length > 1 || currentRecord?.status === 'recovery_required' || (activeStates.length === 1 && associatedRecord && associatedRecord.status !== 'verified_active') || (registered[0]?.workspace !== root && !currentRecord)) {
    hint = 'inspect_required'; reason = 'Workflow state, records or Git registration require inspection';
  } else if (activeStates.length === 1) {
    hint = 'resume_candidate'; reason = 'Current repository has a persisted active workflow';
  } else if (currentRecord?.status === 'verified_active' || currentOrphan || registered[0]?.workspace !== root) {
    hint = 'inspect_required'; reason = 'Existing or unowned worktree/workflow must be associated before composition';
  } else if (states.length === 1) reason = `Matching ${provider} session workflow is terminal`;
  return {
    schema_version: 1, provider, session_id: sessionId || null, ...(provider === 'codex' ? { codex_session_id: sessionId || null } : {}), workspace_root: root,
    git: { common_dir: common, current_registered: Boolean(current), is_primary: registered[0]?.workspace === root, branch: current?.branch || null, registered_worktree_count: registered.length },
    matching_workflows: selectedStates.slice(0, 8), matching_workflow_count: selectedStates.length, omitted_workflow_count: Math.max(0, selectedStates.length - 8), current_workspace_has_other_session_state: currentForeign, worktree_record_count: records.length, worktrees: [...records].sort((a, b) => Number(b.current) - Number(a.current)).slice(0, 8), omitted_worktree_count: Math.max(0, records.length - 8),
    worktree_candidates: worktreeCandidates.slice(0, 8), omitted_worktree_candidate_count: Math.max(0, worktreeCandidates.length - 8),
    issues: issues.slice(0, 8), omitted_issue_count: Math.max(0, issues.length - 8), decision_hint: hint, reason,
  };
}

// Progress is a projection of orchestrator decisions, never a workflow transition.
export async function refreshWorkflowProgress(observed, event) {
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
