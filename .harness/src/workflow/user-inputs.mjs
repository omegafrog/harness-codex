import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionOutputPath } from './session-output.mjs';
import { planSetDocument } from './domain-model-gate.mjs';
import { isCurrentStage, TACTICAL_DESIGN_STAGES } from './worktree-stages.mjs';

// The orchestrator's own words cannot prove that the user decided something. The provider runs these hooks with the
// user's actual input, so the session keeps a log of it: prompts (UserPromptSubmit) and answers to the provider's
// question tool (PostToolUse of AskUserQuestion / request_user_input). Decisions are checked against this log.
const LOG = 'runtime/orchestrator/user-inputs.jsonl';
const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input)$/i;

export function userInputText(event) {
  if (event?.hook_event_name === 'UserPromptSubmit' && typeof event.prompt === 'string') return { source: 'prompt', text: event.prompt };
  if (event?.hook_event_name === 'PostToolUse' && QUESTION_TOOLS.test(event.tool_name || '')) return { source: 'question_tool', text: JSON.stringify(event.tool_response ?? event.tool_output ?? '') };
  return null;
}

export async function recordUserInput({ root, event, now = new Date() }) {
  const input = userInputText(event);
  if (!input || !input.text.trim() || !existsSync(join(root, '.io/worktree.json'))) return false;
  await appendFile(sessionOutputPath(root, LOG), `${JSON.stringify({ at: now.toISOString(), session_id: event.session_id || null, ...input })}\n`, { mode: 0o600 });
  return true;
}

export async function userSaidAfter({ root, text, since }) {
  const wanted = String(text || '').trim();
  if (!wanted) return false;
  let log;
  try { log = await readFile(sessionOutputPath(root, LOG, { create: false }), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const after = Date.parse(since);
  return log.split('\n').filter(Boolean).some((line) => {
    try { const entry = JSON.parse(line); return Date.parse(entry.at) >= after && String(entry.text).includes(wanted); } catch { return false; }
  });
}

export async function assertRequirementsApproval({ root, state, stage, planSetId, approval = null }) {
  if (!planSetId || !TACTICAL_DESIGN_STAGES.includes(stage)) return;
  const fixed = state.stages?.['bounded-context'];
  const design = state.stages?.['domain-model'];
  const { text } = await planSetDocument(root, planSetId, 'requirements.md');
  if (text === null) return; // stakeholder-analysis skipped the requirements flow.
  const current = isCurrentStage(fixed) && fixed.execution_id && fixed.finished_at;
  if (current && !design?.stale && !approval) {
    if (design?.requirements_approval === fixed.execution_id) return;
    // Older versions did not record the approval receipt. Their first domain-model launch enforced the user reply.
    if (!design?.requirements_approval && !fixed.attempts?.length && Date.parse(design?.started_at || design?.finished_at) >= Date.parse(fixed.finished_at)) return;
  }
  if (current && stage === 'domain-model' && approval?.execution_id === fixed.execution_id && typeof approval.answer === 'string' && await userSaidAfter({ root, text: approval.answer, since: fixed.finished_at })) return;
  throw new Error('Requirements approval answer was not recorded: show the fixed requirements.md to the user and pass their reply after bounded-context finished');
}
