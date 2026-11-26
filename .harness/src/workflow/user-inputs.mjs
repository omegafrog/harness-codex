import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planSetDocument } from './domain-model-gate.mjs';
import { isHarnessUpdateRequest, orchestratorRequest } from './request-routing.mjs';
import { designApprovalCovers, designApprovalSource, isCurrentStage, TACTICAL_DESIGN_STAGES } from './worktree-stages.mjs';
import { approvalRefusal, clip, describeReplySearch } from './approval-search.mjs';
import { recheckRequirementsBeforeApproval } from './requirements-document-gate.mjs';

export { approvalRefusal, describeReplySearch, summarizeReplySearch } from './approval-search.mjs';

// Approval evidence is read from the provider's own transcript, never from an assistant-written argument. Only a message
// the user sent as an orchestrator request (`$orchestrator <reply>`, `/orchestrator <reply>`) or as a reply to a form this
// conversation asked counts; with allowPlainReply (publication on Codex) any user message counts. The words are never judged:
// the orchestrator decides what they mean. The result also says what was searched and why the closest candidates failed.
export async function userSaidAfter(options) { return (await inspectUserReply(options)).matched; }

export async function inspectUserReply({ root, text, since = '1970-01-01T00:00:00Z', until = null, sessionId = null, provider = null, allowHistoricalOwner = false, allowPlainReply = false }) {
  const wanted = String(text || '').trim();
  const search = { wanted: clip(wanted), since, ...(until ? { until } : {}), provider: provider || null, session_id: sessionId || null, transcript: null, workspace: null, counts: { orchestrator_requests: 0, plain_user_messages: 0, form_replies: 0 }, candidates: [], outcome: 'no_matching_message' };
  const refuse = (outcome, extra = {}) => ({ matched: false, search: { ...search, ...extra, outcome } });
  if (!wanted) return refuse('empty_answer');
  if (!Number.isFinite(Date.parse(since)) || (until && !Number.isFinite(Date.parse(until)))) return refuse('invalid_window');
  let record;
  try { record = JSON.parse(await readFile(join(root, '.io/worktree.json'), 'utf8')); } catch { return refuse('no_worktree_record'); }
  const owner = record.agent_sessions?.orchestrator;
  const ownerIdentity = owner?.session_id ? { owner: { provider: owner.provider || 'codex', session_id: owner.session_id } } : {};
  sessionId ||= owner?.session_id;
  provider ||= owner?.provider || 'codex';
  search.provider = provider; search.session_id = sessionId || null; Object.assign(search, ownerIdentity);
  if (!sessionId) return refuse('no_owner_session');
  if (!allowHistoricalOwner && (owner?.session_id !== sessionId || (owner?.provider || 'codex') !== provider)) return refuse('not_owner_session');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return refuse('invalid_session_id');
  const { realpath, open } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  let path;
  if (provider === 'codex') {
    const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
    path = await findRollout(join(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'), 'sessions'), sessionId);
  } else if (provider === 'claude-code') {
    const { readdir } = await import('node:fs/promises');
    const projects = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || '', '.claude'), 'projects');
    const dirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
    const paths = dirs.filter((entry) => entry.isDirectory()).map((entry) => join(projects, entry.name, `${sessionId}.jsonl`)).filter(existsSync);
    if (paths.length === 1) path = paths[0];
  }
  if (!path) return refuse('no_transcript');
  search.transcript = path;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return refuse('unreadable_transcript');
  let rows;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) return refuse('unreadable_transcript');
    const lines = (await handle.readFile('utf8')).split('\n');
    lines.pop(); // A concurrent writer may still be appending the last record.
    rows = lines.filter(Boolean).map((line) => JSON.parse(line));
  } catch { return refuse('unreadable_transcript'); } finally { await handle.close(); }
  const workspace = await realpath(root);
  search.workspace = workspace;
  const calls = new Set(), asyncCalls = new Map(), accepted = new Set();
  if (provider === 'codex') {
    const meta = rows[0];
    if (meta?.type !== 'session_meta' || meta.payload?.id !== sessionId || meta.payload?.parent_thread_id || meta.payload?.source?.subagent) return refuse('not_root_session');
  }
  let codexCwd = rows[0]?.payload?.cwd;
  for (const row of rows) {
    if (provider === 'codex' && row.type === 'turn_context' && typeof row.payload?.cwd === 'string') { if (codexCwd !== row.payload.cwd) { calls.clear(); asyncCalls.clear(); accepted.clear(); } codexCwd = row.payload.cwd; }
    const at = Date.parse(row.timestamp);
    const p = row.payload || {};
    if (provider === 'codex' && codexCwd === workspace && row.type === 'response_item' && p.type === 'function_call' && /^(?:functions\.)?request_user_input$/.test(p.name || '')) calls.add(p.call_id);
    if (provider === 'codex' && codexCwd === workspace && row.type === 'response_item' && p.type === 'function_call' && /^(?:functions\.)?request_user_input_async$/.test(p.name || '')) { try { const questions = JSON.parse(p.arguments).questions; if (Array.isArray(questions)) asyncCalls.set(p.call_id, questions.length); } catch { /* Invalid calls cannot own replies. */ } }
    if (provider === 'codex' && row.type === 'response_item' && p.type === 'function_call_output' && asyncCalls.has(p.call_id)) { try { if (JSON.parse(p.output).accepted === true) accepted.add(p.call_id); } catch { /* Ignore invalid acknowledgements. */ } }
    if (provider === 'claude-code' && row.type === 'assistant' && row.sessionId === sessionId && row.cwd === workspace && !row.isSidechain) {
      for (const item of row.message?.content || []) if (item.type === 'tool_use' && item.name === 'AskUserQuestion') calls.add(item.id);
    }
    if (!Number.isFinite(at) || at < Date.parse(since) || (until && at > Date.parse(until))) continue;
    let texts = [];
    if (provider === 'codex' && codexCwd === workspace && row.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') {
        const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
        if (Array.isArray(kinds)) {
          for (const [index, item] of (p.content || []).entries()) {
            if (kinds[index] !== 'user.text' || item.type !== 'input_text' || typeof item.text !== 'string') continue;
            if (!item.text.trim().startsWith('<send_user_message_question_reply>')) {
              const request = orchestratorRequest(item.text);
              if (request && !isHarnessUpdateRequest(request)) texts.push(request);
              else if (allowPlainReply && !request) texts.push(item.text);
              continue;
            }
            try {
              const wrapped = item.text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
              const replies = JSON.parse(wrapped?.[1] || 'null');
              for (const reply of replies) { const id = JSON.parse(reply.questionItemId); if (Array.isArray(id) && id[0] === 'request_user_input_async' && accepted.has(id[1]) && Number.isInteger(id[2]) && id[2] >= 0 && id[2] < asyncCalls.get(id[1]) && typeof reply.answer === 'string') texts.push(reply.answer); }
            } catch { /* Malformed form replies are not approval evidence. */ }
          }
        }
      } else if (p.type === 'function_call_output' && calls.has(p.call_id)) {
        try { texts = Object.values(JSON.parse(p.output).answers || {}).flatMap((item) => Array.isArray(item?.answers) ? item.answers : []); } catch { /* An invalid result cannot prove a decision. */ }
      }
    } else if (provider === 'claude-code' && row.type === 'user' && row.sessionId === sessionId && row.cwd === workspace && !row.isSidechain && !row.isMeta) {
      const content = row.message?.content;
      if (typeof content === 'string') {
        const command = content.match(/<command-name>([^<]*)<\/command-name>/);
        const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
        const request = command ? (command[1] === '/orchestrator' ? args?.[1] : null) : orchestratorRequest(content);
        if (request && !isHarnessUpdateRequest(request)) texts = [request];
      }
      else if (Array.isArray(content) && content.some((item) => item.type === 'tool_result' && calls.has(item.tool_use_id) && !item.is_error)) texts = Object.values(row.toolUseResult?.answers || {}).filter((item) => typeof item === 'string');
    }
    if (texts.some((value) => typeof value === 'string' && value.trim() === wanted)) return { matched: true, search: { ...search, outcome: 'matched' } };
  }
  return refuse('no_matching_message', surveyTranscript({ rows, provider, sessionId, workspace, wanted, since, until, allowPlainReply }));
}

// Read-only survey of a transcript that held no qualifying reply: what the user did send, and why the messages equal to
// the answer do not count. It never decides acceptance; the loop above does.
function surveyTranscript({ rows, provider, sessionId, workspace, wanted, since, until, allowPlainReply = false }) {
  const counts = { orchestrator_requests: 0, plain_user_messages: 0, form_replies: 0 };
  const candidates = [];
  const from = Date.parse(since), to = until ? Date.parse(until) : Infinity;
  let cwd = rows[0]?.payload?.cwd;
  const note = (row, at, form, text, here) => {
    const inWindow = Number.isFinite(at) && at >= from && at <= to;
    if (here && inWindow) counts[form === 'orchestrator_request' ? 'orchestrator_requests' : form === 'form_reply' ? 'form_replies' : 'plain_user_messages'] += 1;
    if (text.trim() !== wanted) return;
    const problems = [
      form === 'plain_user_message' && !(allowPlainReply && provider === 'codex') && 'missing_orchestrator_prefix',
      Number.isFinite(at) && at < from && 'sent_before_gate',
      Number.isFinite(at) && at > to && 'sent_after_window',
      !here && 'other_workspace',
    ].filter(Boolean);
    if (problems.length) candidates.push({ at: row.timestamp, form, problems, ...(!here ? { cwd: clip(cwd, 200) } : {}) });
  };
  for (const row of rows) {
    const at = Date.parse(row.timestamp);
    if (provider === 'codex') {
      if (row.type === 'turn_context' && typeof row.payload?.cwd === 'string') cwd = row.payload.cwd;
      const p = row.payload || {};
      if (row.type !== 'response_item' || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.internal_chat_message_metadata_passthrough?.content_item_kinds)) continue;
      for (const [index, item] of (p.content || []).entries()) {
        if (p.internal_chat_message_metadata_passthrough.content_item_kinds[index] !== 'user.text' || item.type !== 'input_text' || typeof item.text !== 'string') continue;
        if (item.text.trim().startsWith('<send_user_message_question_reply>')) {
          try { for (const reply of JSON.parse(item.text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/)?.[1] || 'null')) if (typeof reply.answer === 'string') note(row, at, 'form_reply', reply.answer, cwd === workspace); } catch { /* A malformed form reply is not a candidate. */ }
          continue;
        }
        const request = orchestratorRequest(item.text);
        if (request !== null && isHarnessUpdateRequest(request)) continue;
        note(row, at, request !== null ? 'orchestrator_request' : 'plain_user_message', request ?? item.text, cwd === workspace);
      }
    } else if (provider === 'claude-code' && row.type === 'user' && row.sessionId === sessionId && !row.isSidechain && !row.isMeta && typeof row.message?.content === 'string') {
      const content = row.message.content;
      const command = content.match(/<command-name>([^<]*)<\/command-name>/);
      const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
      const request = command ? (command[1] === '/orchestrator' ? args?.[1] ?? '' : null) : orchestratorRequest(content);
      if (command && request === null) continue;
      if (request !== null && isHarnessUpdateRequest(request)) continue;
      cwd = row.cwd;
      note(row, at, request !== null ? 'orchestrator_request' : 'plain_user_message', request ?? content, row.cwd === workspace);
    }
  }
  return { counts, candidates: candidates.slice(-3) };
}

const REQUIREMENTS_REFUSAL = 'Requirements approval answer was not recorded';

const DESIGN_REFUSAL = 'Design approval answer was not recorded';

export async function assertDesignApproval({ root, state, stage, planSetId, approval = null }) {
  const sourceId = designApprovalSource(stage);
  if (!planSetId || !sourceId) return;
  const source = state.stages?.[sourceId];
  const entry = state.stages?.[stage];
  const current = isCurrentStage(source) && source.execution_id && source.finished_at;
  // A retry, resume or takeover of the same stage for the same predecessor execution reuses the recorded approval.
  if (current && designApprovalCovers(state.stages, stage) && (!approval || approval.answer === entry.design_approval?.answer)) return;
  const refuse = (reason, search) => Object.assign(approvalRefusal(DESIGN_REFUSAL, reason, search), { design_stage: stage });
  if (!current) {
    const sourceState = source ? `${source.status}${source.code ? `/${source.code}` : ''}${source.stale ? ', stale' : ''}` : 'never run';
    throw refuse(`${sourceId} has no current completed/OK result (${sourceState}), so there is nothing to approve yet`);
  }
  if (!approval) throw refuse(`no --approval-answer was passed; ${stage} starts only after the user approved ${sourceId} ${source.execution_id}. Ask the user`);
  if (approval.stage_id !== sourceId || approval.execution_id !== source.execution_id) throw refuse(`the approval names ${approval.stage_id} ${approval.execution_id ?? 'none'} but the current result comes from ${sourceId} ${source.execution_id}; ask the user to approve the current result`);
  if (typeof approval.answer !== 'string') throw refuse('the passed --approval-answer is empty or not text');
  const { matched, search } = await inspectUserReply({ root, text: approval.answer, since: source.finished_at });
  if (!matched) throw refuse(describeReplySearch(search, { gate: `${sourceId} ${source.execution_id} finished` }), search);
}

export async function assertRequirementsApproval({ root, state, stage, planSetId, approval = null }) {
  if (!planSetId || !TACTICAL_DESIGN_STAGES.includes(stage)) return;
  const fixed = state.stages?.['bounded-context'];
  const design = state.stages?.['domain-model'];
  const { text } = await planSetDocument(root, planSetId, 'requirements.md');
  if (text === null) return; // stakeholder-analysis skipped the requirements flow.
  // A fixed document that today's requirements-fix rules would refuse is reopened before it is approved; the approval is not recorded.
  if (stage === 'domain-model' && (!design?.execution_id || design.stale)) {
    const recheck = recheckRequirementsBeforeApproval({ root, state, planSetId });
    if (recheck.applies && !recheck.ok) throw Object.assign(new Error(`Requirements recheck required before approval: bounded-context ${recheck.blocked_execution_id} fixed a requirements.md that no longer passes the current requirements-fix rules (${recheck.errors.length} error(s)), so the approval was not recorded and domain-model did not start. Reopen requirements-fix first: --stage-id requirements-fix --reopen-for ${recheck.blocked_execution_id}. ${recheck.reason}`), { requirements_recheck: recheck });
  }
  const current = isCurrentStage(fixed) && fixed.execution_id && fixed.finished_at;
  if (current && !design?.stale && !approval) {
    if (design?.requirements_approval === fixed.execution_id) return;
    // Older versions did not record the approval receipt. Their first domain-model launch enforced the user reply.
    if (!design?.requirements_approval && !fixed.attempts?.length && Date.parse(design?.started_at || design?.finished_at) >= Date.parse(fixed.finished_at)) return;
  }
  if (current && stage === 'domain-model' && approval?.execution_id === fixed.execution_id && typeof approval.answer === 'string') {
    const { matched, search } = await inspectUserReply({ root, text: approval.answer, since: fixed.finished_at });
    if (matched) return;
    throw approvalRefusal(REQUIREMENTS_REFUSAL, describeReplySearch(search, { gate: `bounded-context ${fixed.execution_id} finished` }), search);
  }
  const fixedState = fixed ? `${fixed.status}${fixed.code ? `/${fixed.code}` : ''}${fixed.stale ? ', stale' : ''}` : 'never run';
  if (!current) throw approvalRefusal(REQUIREMENTS_REFUSAL, `bounded-context has not fixed the current requirements (${fixedState}), so there is nothing to approve yet`);
  if (!approval) throw approvalRefusal(REQUIREMENTS_REFUSAL, design?.stale ? 'domain-model is stale after an upstream change and needs a new user approval of the fixed requirements; no --approval-answer was passed' : stage === 'domain-model' ? 'no --approval-answer was passed; a bare --requirements-approved flag is not approval' : `domain-model records no approval receipt for bounded-context ${fixed.execution_id}; start domain-model with the user's approval first`);
  if (stage !== 'domain-model') throw approvalRefusal(REQUIREMENTS_REFUSAL, `${stage} cannot carry the approval; only the domain-model launch records it`);
  if (approval.execution_id !== fixed.execution_id) throw approvalRefusal(REQUIREMENTS_REFUSAL, `the approval names bounded-context ${approval.execution_id ?? 'none'} but the current fixed requirements come from ${fixed.execution_id}; ask the user to approve the current requirements`);
  throw approvalRefusal(REQUIREMENTS_REFUSAL, 'the passed --approval-answer is empty or not text');
}
