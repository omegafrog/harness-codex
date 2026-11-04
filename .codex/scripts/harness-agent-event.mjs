#!/usr/bin/env node
import { appendFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertWorkspaceTarget } from '../../.harness/src/eval/case-workspace.mjs';

try {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (text.length > 1024 * 1024) throw new Error('Subagent event is too large');
  const event = JSON.parse(text);
  if (!['SubagentStart', 'SubagentStop'].includes(event.hook_event_name) || typeof event.session_id !== 'string' || typeof event.agent_id !== 'string' || !event.agent_id || typeof event.agent_type !== 'string') throw new Error('Invalid Claude subagent event');
  const session = process.env.HARNESS_SESSION_DIR, executionId = process.env.HARNESS_SKILL_EXECUTION_ID;
  if (!session || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '')) throw new Error('Harness execution session is unavailable');
  const relative = `runtime/executions/${executionId}/subagents.jsonl`;
  await assertWorkspaceTarget(session, relative);
  const path = join(session, relative);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const prior = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (prior && (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1)) throw new Error('Unsafe subagent event log');
  const record = {
    event: event.hook_event_name,
    session_id: event.session_id,
    agent_id: event.agent_id,
    agent_type: event.agent_type,
    ...(event.agent_transcript_path ? { transcript_path: event.agent_transcript_path } : {}),
    ...(event.hook_event_name === 'SubagentStop' && typeof event.last_assistant_message === 'string' ? { result: event.last_assistant_message } : {}),
    recorded_at: new Date().toISOString(),
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, { flag: 'a', mode: 0o600 });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
