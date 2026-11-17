import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { readPlanSetTicketStatuses } from '../tracker/lifecycle.mjs';
import { planDependencies as indexDependencies } from '../tracker/publication.mjs';
import { readExecutionInput, readSkillSessionJson } from './skill-execution.mjs';

const git = async (root, ...args) => (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();

// The published plan set's tickets, one `docs/plans/<plan-set-id>/<ticket>.md` per ticket next to the `plans.md` index.
export async function ticketIds({ root, planSetId }) {
  await assertWorkspaceTarget(root, `docs/plans/${planSetId}`);
  return (await readdir(join(root, 'docs/plans', planSetId), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'plans.md')
    .map((entry) => entry.name.slice(0, -3)).sort();
}

// A ticket's prerequisites: the dependency column of the plan index and the prerequisite sentences ("선행 ...") of the
// ticket's own `## 의존성` section, as backticked ticket IDs of the same plan set.
export async function ticketDependencies({ root, planSetId, planIds }) {
  const dependencies = new Map([...await indexDependencies(root, planSetId, planIds)].map(([id, needs]) => [id, new Set(needs)]));
  for (const id of planIds) {
    const text = await readFile(join(root, 'docs/plans', planSetId, `${id}.md`), 'utf8');
    const section = /^##\s+의존성[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text)?.[1] ?? '';
    const prerequisite = section.split(/(?<=[.。])\s+|\n+/).filter((sentence) => sentence.includes('선행')).join(' ');
    for (const [, named] of prerequisite.matchAll(/`([A-Za-z0-9][A-Za-z0-9._-]*)`/g)) if (named !== id && planIds.includes(named)) dependencies.get(id).add(named);
  }
  return new Map([...dependencies].map(([id, needs]) => [id, [...needs].sort()]));
}

// Each ticket with its tracker status and whether it can start: not completed, and every prerequisite completed.
export async function ticketReadiness({ root, planSetId, run }) {
  const planIds = await ticketIds({ root, planSetId });
  const statuses = new Map((await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: planSetId, plan_ids: planIds, ...(run ? { run } : {}) })).map((ticket) => [ticket.plan_id, ticket.status]));
  const dependencies = await ticketDependencies({ root, planSetId, planIds });
  return planIds.map((id) => {
    const incomplete = dependencies.get(id).filter((need) => statuses.get(need) !== 'completed');
    return { plan_id: id, status: statuses.get(id), depends_on: dependencies.get(id), incomplete, ready: statuses.get(id) !== 'completed' && !incomplete.length };
  });
}

// tactical-code implements one ticket per execution, in dependency order. A ticket that is already completed is only
// reopened by an explicit continuation (`resume`: the stage's own feedback or answer).
export async function assertTicketStartable({ root, planSetId, planId, resume = false, run }) {
  const tickets = await ticketReadiness({ root, planSetId, run });
  const ticket = tickets.find((item) => item.plan_id === planId);
  if (!ticket) throw new Error(`Ticket ${planId} is not part of plan set ${planSetId}`);
  if (ticket.incomplete.length) throw new Error(`tactical-code ${planId} cannot start before its prerequisite ticket${ticket.incomplete.length > 1 ? 's' : ''} ${ticket.incomplete.join(', ')} ${ticket.incomplete.length > 1 ? 'are' : 'is'} completed; ready tickets: ${tickets.filter((item) => item.ready).map((item) => item.plan_id).join(', ') || 'none'}`);
  if (ticket.status === 'completed' && !resume) throw new Error(`Ticket ${planId} is already completed; ready tickets: ${tickets.filter((item) => item.ready).map((item) => item.plan_id).join(', ') || 'none'}`);
  return ticket;
}

// The tickets whose tactical-code execution finished completed/OK with a commit that HEAD contains, read from the
// workflow state and the stored executions only.
export async function implementedTickets({ root, session }) {
  const state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const entry = state?.stages?.['tactical-code'];
  const done = new Map();
  for (const attempt of [...(entry?.attempts || []), ...(entry ? [entry] : [])]) {
    if (attempt.status !== 'completed' || attempt.code !== 'OK' || !attempt.result_ref) continue;
    const input = await readExecutionInput({ root, execution_id: attempt.execution_id });
    const result = await readSkillSessionJson({ root, session_directory: session, path: attempt.result_ref });
    if (input.context?.plan_id && /^[0-9a-f]{40}$/.test(result.commit_sha || '')) {
      const reachable = await git(root, 'merge-base', '--is-ancestor', result.commit_sha, 'HEAD').then(() => true, () => false);
      if (reachable) done.set(input.context.plan_id, result.commit_sha);
    }
  }
  return done;
}

// Final tactical-to-code outcome: every ticket is completed in the tracker and was implemented by a tactical-code run.
export async function deriveTacticalOutcome({ root, planSetId, session, run }) {
  const pass = (reason, details) => ({ status: 'pass', reason, violations: [], ...(details ? { details } : {}) });
  const blocked = (reason, details) => ({ status: 'blocked', reason, violations: [], details });
  if (!planSetId) return blocked('tactical_outcome_plan_set_missing');
  const tickets = await ticketReadiness({ root, planSetId, run });
  if (!tickets.length) return blocked('tickets_missing');
  const open = tickets.filter((ticket) => ticket.status !== 'completed').map((ticket) => ticket.plan_id);
  if (open.length) return blocked('tickets_not_completed', { open_tickets: open });
  const implemented = await implementedTickets({ root, session });
  const missing = tickets.filter((ticket) => !implemented.has(ticket.plan_id)).map((ticket) => ticket.plan_id);
  if (missing.length) return blocked('tickets_without_implementation_commit', { missing_tickets: missing });
  return pass('every_ticket_implemented', { tickets: tickets.map((ticket) => ({ plan_id: ticket.plan_id, commit: implemented.get(ticket.plan_id) })) });
}
