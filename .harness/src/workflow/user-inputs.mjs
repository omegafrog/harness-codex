import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionOutputPath } from './session-output.mjs';

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
