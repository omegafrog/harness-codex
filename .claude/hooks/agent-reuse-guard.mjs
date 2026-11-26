// PreToolUse(SendMessage): refuses to resume a sub-agent whose last request exceeded 120K tokens. Anything unreadable is allowed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const LIMIT = 120000;
try {
  const event = JSON.parse(readFileSync(0, 'utf8'));
  const to = String(event.tool_input?.to ?? '').replace(/ \[.*\]$/, '');
  const dir = join(event.transcript_path.replace(/\/subagents\/[^/]+\.jsonl$/, '').replace(/\.jsonl$/, ''), 'subagents');
  const id = readdirSync(dir).filter((f) => f.endsWith('.meta.json')).find((f) => {
    if (f === `agent-${to}.meta.json`) return true;
    try { const m = JSON.parse(readFileSync(join(dir, f), 'utf8')); return Boolean(to) && m.name === to; } catch { return false; }
  });
  if (id) {
    let tokens = 0;
    for (const line of readFileSync(join(dir, id.replace('.meta.json', '.jsonl')), 'utf8').split('\n')) {
      try {
        const u = JSON.parse(line).message?.usage;
        if (u) tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) || tokens;
      } catch {}
    }
    if (tokens > LIMIT) console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `This agent's context is ${tokens} tokens (limit ${LIMIT}). Launch a new harness-dev agent with the task, the file list and the current diff instead.`,
    } }));
  }
} catch {}
