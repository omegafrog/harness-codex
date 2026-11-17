import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readSkillSessionJson, resolveSkillSession } from './skill-execution.mjs';
import { REWIND_STAGES, TACTICAL_DESIGN_STAGES, TACTICAL_IMPLEMENTATION_STAGES, WORKTREE_STAGE, isCurrentStage } from './worktree-stages.mjs';
import { launchCommand } from './stage-cli.mjs';

// Forward rewind. A stage that returns blocked / DEPENDENCY_INCOMPLETE names the earlier stage that owns the gap
// (`result.owner_stage`). The runner reopens that owner without rolling anything back: documents and artifacts stay, the owner
// edits its own output forward, and every stage between the owner and the blocked stage that already finished is marked
// `stale` in the orchestrator state. A stale stage no longer counts as completed/OK for the order guards (`isCurrentStage`), so
// the stages must be re-run in order up to the blocked one. `--restart-requirements` is the separate, destructive rollback.

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Stages after to-ticket never rewind: publication and implementation have already used the plan set.
const PUBLICATION_STAGES = TACTICAL_IMPLEMENTATION_STAGES.slice(TACTICAL_IMPLEMENTATION_STAGES.indexOf(WORKTREE_STAGE.TO_TICKET) + 1);

const refusal = (message, why, next, userDecision) => Object.assign(new Error(message), {
  explained: { error: message, code: 'REOPEN_REFUSED', why, ...(next?.length ? { next } : {}), ...(userDecision ? { user_decision: userDecision } : {}) },
});
const describe = (entry) => entry ? `${entry.status}${entry.code ? `/${entry.code}` : ''}${entry.stale ? ' (stale)' : ''}` : 'not started';

// The note a reopened owner receives as its feedback. It is internal agent input, so it is English.
export const reopenFeedback = ({ ownerStage, blockedStage, blockedExecutionId, gap, rerunOrder }) => [
  `Upstream rewind: ${blockedStage} (execution ${blockedExecutionId}) returned blocked / DEPENDENCY_INCOMPLETE naming ${ownerStage} as the owner of a gap.`,
  `Gap: ${gap}`,
  `Its result is listed in the input as dependency_gap_result; read it, but re-check the gap against the current documents before acting on it.`,
  `Your earlier output and every committed document stay in place. Edit your own section, decisions and artifacts forward to close the gap: keep every decision the gap does not touch, do not start from scratch and do not delete earlier work.`,
  `Close only the gap. A business decision that the requirements do not settle is not yours to make: return the question or INPUT_MISSING as your guide says.`,
  `After you complete, the stages ${rerunOrder.slice(1).join(' → ')} are re-run in order to pick up your change.`,
].join(' ');

// The note a stale stage receives when it is re-run because an upstream stage changed.
export const staleFeedback = (stage, stale) => `Upstream changed: ${stale.owner_stage} was reopened for ${stale.blocked_stage} and has been completed again, so your previous result is stale. Read the current upstream documents and results, then update your existing output forward: keep every decision that still holds, change only what the upstream change requires, and do not start from scratch. Return completed/OK only when your output matches the current upstream; if it needs a decision the upstream does not settle, return the block or question your guide specifies.`;

// A blocked result that must name its owner: the stages whose DEPENDENCY_INCOMPLETE can mean "an earlier stage's output is
// missing or insufficient". tactical-ui is excluded: its DEPENDENCY_INCOMPLETE also hands off to frontend-design-brief.
// to-ticket is excluded too: it splits a frozen design and never rewinds to a design stage; a design defect it finds is reported
// as blocked / INPUT_MISSING (DESIGN_NOT_FROZEN) to the user, and a DEPENDENCY_INCOMPLETE from it is refused (dependencyOwnerErrors).
export const OWNER_REQUIRED_STAGES = Object.freeze([...TACTICAL_DESIGN_STAGES, WORKTREE_STAGE.TACTICAL_TECHNOLOGY, WORKTREE_STAGE.TACTICAL_API, WORKTREE_STAGE.TACTICAL_DATA]);

// Format errors for a finish whose blocked / DEPENDENCY_INCOMPLETE result does not name a valid earlier owner; null otherwise.
export function dependencyOwnerErrors({ skill, raw }) {
  if (skill === WORKTREE_STAGE.TO_TICKET && raw?.status === 'blocked' && raw?.code === 'DEPENDENCY_INCOMPLETE') {
    return [{ path: '$.code', rule: 'enum', expected: 'to-ticket never rewinds to a design stage: it returns blocked / INPUT_MISSING with a summary starting `DESIGN_NOT_FROZEN:` that names the defect and its document, and owner_stage and dependency_gap stay null', value: raw.code }];
  }
  if (!OWNER_REQUIRED_STAGES.includes(skill) || raw?.status !== 'blocked' || raw?.code !== 'DEPENDENCY_INCOMPLETE') return null;
  const owner = raw.result?.owner_stage;
  const earlier = REWIND_STAGES.slice(0, REWIND_STAGES.indexOf(skill));
  const expected = `an earlier stage id (${earlier.join(', ')}) naming the earliest stage that owns the gap, plus dependency_gap describing what is missing`;
  if (typeof owner === 'string' && earlier.includes(owner)) {
    if (typeof raw.result.dependency_gap === 'string' && raw.result.dependency_gap.trim()) return null;
    return [{ path: '$.result.dependency_gap', rule: 'required', expected: 'a non-empty description of the gap: what the owner stage must add or change', value: raw.result.dependency_gap ?? null, ...(raw.result.dependency_gap === undefined ? { missing: true } : {}) }];
  }
  return [{ path: '$.result.owner_stage', rule: 'required', expected, value: owner ?? null, ...(owner === undefined ? { missing: true } : {}) }];
}

// Read-only: decide whether `ownerStage` may be reopened for the blocked execution, and what that does.
export async function resolveReopen({ root, session, state, ownerStage, blockedExecutionId }) {
  const stages = state.stages || {};
  if (!SAFE_ID.test(blockedExecutionId || '')) throw refusal('Reopen refused: invalid blocked execution id', '--reopen-for takes the execution_id of the blocked stage result that names this stage as owner.', ['node .codex/scripts/harness-context.mjs shows the blocked stage and its execution_id']);
  const ownerIndex = REWIND_STAGES.indexOf(ownerStage);
  if (ownerIndex < 0) throw refusal(`Reopen refused: ${ownerStage} cannot be reopened`, `Only the requirements, tactical design and tactical implementation stages up to to-ticket can be reopened forward (${REWIND_STAGES.join(' → ')}).`, ['node .codex/scripts/harness-context.mjs'], 'Report that the blocked result names a stage that cannot be reopened, and wait for the user.');
  const found = Object.entries(stages).find(([, entry]) => entry?.execution_id === blockedExecutionId);
  if (!found) throw refusal(`Reopen refused: no stage has execution ${blockedExecutionId} as its latest result`, 'The blocked execution was replaced by a newer one, or the id is mistyped.', ['node .codex/scripts/harness-context.mjs shows the current blocked stage and its execution_id']);
  const [blockedStage, blocked] = found;
  const blockedIndex = REWIND_STAGES.indexOf(blockedStage);
  if (blockedIndex <= ownerIndex) throw refusal(`Reopen refused: ${blockedStage} does not come after ${ownerStage}`, `A stage is reopened only for a later stage that is blocked on it; ${blockedStage} is ${blockedIndex < 0 ? 'outside the rewindable flow' : 'not later in the flow'}.`, ['node .codex/scripts/harness-context.mjs']);
  if (state.current_stage !== blockedStage || blocked.status !== 'blocked' || blocked.code !== 'DEPENDENCY_INCOMPLETE' || !blocked.result_ref) {
    throw refusal(`Reopen refused: ${blockedStage} is ${describe(blocked)}, not its latest blocked / DEPENDENCY_INCOMPLETE result`, 'The order guard allows a reopen only while the latest result of a later stage is blocked / DEPENDENCY_INCOMPLETE naming this owner.', ['node .codex/scripts/harness-context.mjs']);
  }
  const running = Object.entries(stages).find(([, entry]) => entry?.status === 'running');
  if (running) throw refusal(`Reopen refused: ${running[0]} is still running`, 'A stage cannot be reopened while another stage runs.', [`Wait for its native subagent, then run finish for ${running[1].execution_id}`]);
  // A to-ticket record that is stale or not completed (blocked, failed, cancelled; typically left from before an earlier rewind)
  // produced no plan set, so it does not count as started; a current completed to-ticket and any later stage do.
  const counts = (id) => id === WORKTREE_STAGE.TO_TICKET ? stages[id]?.status === 'completed' && !stages[id].stale : Boolean(stages[id]);
  const started = [...REWIND_STAGES.slice(blockedIndex + 1), ...PUBLICATION_STAGES].find(counts);
  if (started) throw refusal(`Reopen refused: ${started} has already started`, `Tickets were published or implemented from the plan set (${started} is ${describe(stages[started])}); a forward rewind cannot change what they were built from.`, [], 'Report the gap to the user: changing the design now needs their instruction (--user-revision) or a restart they request.');
  const resultSession = await resolveSkillSession(root, blocked.result_session_directory || session);
  const result = await readSkillSessionJson({ root, session_directory: resultSession, path: blocked.result_ref });
  const named = result.owner_stage;
  if (typeof named !== 'string' || !REWIND_STAGES.includes(named)) {
    throw refusal(`Reopen refused: the ${blockedStage} result names no owner_stage`, `A blocked / DEPENDENCY_INCOMPLETE result must name the earliest stage that owns the gap in result.owner_stage; ${blockedStage} (execution ${blockedExecutionId}) did not.`, [launchCommand(blockedStage, "--feedback 'Return blocked / DEPENDENCY_INCOMPLETE again, naming the earliest upstream stage that owns the gap in result.owner_stage and the gap in result.dependency_gap.'")], 'If the stage still names no owner, report the block to the user.');
  }
  if (named !== ownerStage) throw refusal(`Reopen refused: ${blockedStage} names ${named} as the owner, not ${ownerStage}`, 'Only the stage that the blocked result names may be reopened for it.', [launchCommand(named, `--reopen-for ${blockedExecutionId}`)]);
  if (!isCurrentStage(stages[ownerStage])) throw refusal(`Reopen refused: ${ownerStage} is ${describe(stages[ownerStage])}`, 'The owner is reopened from a finished, current result. A stage that is stale or unfinished is run through the normal order instead.', [launchCommand(ownerStage)]);
  const between = REWIND_STAGES.slice(ownerIndex + 1, blockedIndex);
  const mark = between.filter((id) => stages[id]?.status === 'completed' && stages[id].code === 'OK');
  const rerunOrder = [ownerStage, ...between.filter((id) => stages[id]), blockedStage];
  const gap = (typeof result.dependency_gap === 'string' && result.dependency_gap.trim()) || result.summary;
  const stale = { owner_stage: ownerStage, blocked_stage: blockedStage, reopened_for: blockedExecutionId, rerun_order: rerunOrder, marked_at: new Date().toISOString() };
  return { owner_stage: ownerStage, blocked_stage: blockedStage, blocked_execution_id: blockedExecutionId, blocked_result_ref: blocked.result_ref, blocked_result_base: resultSession === session ? 'session' : 'control_session', mark: [...mark, blockedStage], stale, feedback: reopenFeedback({ ownerStage, blockedStage, blockedExecutionId, gap, rerunOrder }) };
}

// Record the stale marks. Runs after the owner's input is prepared, under the state lock, and is idempotent for the same blocked
// execution; the marks are removed when a stage starts a new execution (recordExecutionState).
export async function markStagesStale({ session, plan }) {
  const directory = join(session, 'runtime/orchestrator');
  const lock = join(directory, '.state.lock');
  await mkdir(lock);
  try {
    const statePath = join(directory, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const blocked = state.stages?.[plan.blocked_stage];
    if (blocked?.execution_id !== plan.blocked_execution_id || blocked.status !== 'blocked') throw new Error('Reopen refused: the blocked stage changed while the reopen was prepared');
    for (const id of plan.mark) if (state.stages[id]) state.stages[id] = { ...state.stages[id], stale: plan.stale };
    state.updated_at = new Date().toISOString();
    const temporary = join(directory, `.workflow-${randomUUID()}.json`);
    try { await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, statePath); }
    finally { await rm(temporary, { force: true }); }
  } finally { await rm(lock, { recursive: true }); }
}

// The stale stages of a state, in flow order; empty when nothing is stale.
export const staleStages = (state) => REWIND_STAGES.filter((id) => state?.stages?.[id]?.stale);
