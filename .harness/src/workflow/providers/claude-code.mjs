import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const id = 'claude-code';

export function prepareOutputSchema(schema) {
  const description = 'Keep status and code paired: completed=OK; action_required=REVIEW_REQUIRED|SPEC_REVISION_REQUIRED|PLAN_REVISION_REQUIRED|IMPLEMENTATION_REVISION_REQUIRED|USER_DECISION_REQUIRED; blocked=ENVIRONMENT_UNAVAILABLE|PERMISSION_REQUIRED|DEPENDENCY_INCOMPLETE|INPUT_MISSING|MODEL_BINDING_UNAVAILABLE; failed=EXECUTION_ERROR|INVALID_INPUT|ARTIFACT_WRITE_FAILED; cancelled=CANCELLED. Envelope and result status/code must match.';
  schema.properties.status.description = description;
  schema.properties.code.description = description;
  schema.properties.result.properties.status.description = description;
  schema.properties.result.properties.code.description = description;
  return schema;
}

export function buildCommand({ root, sandbox, binding, schema, resume }) {
  const agentEventHook = { type: 'command', command: `node "${join(root, '.codex/scripts/harness-agent-event.mjs')}"` };
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      ...(sandbox === 'read-only' ? { filesystem: { denyWrite: [root] } } : {}),
      ...(sandbox === 'danger-full-access' ? { network: { allowedDomains: ['api.github.com', 'github.com'] } } : {}),
    },
    hooks: {
      SubagentStart: [{ hooks: [agentEventHook] }],
      SubagentStop: [{ hooks: [agentEventHook] }],
    },
  };
  const permissionMode = sandbox === 'read-only' ? 'plan' : sandbox === 'danger-full-access' ? 'bypassPermissions' : 'acceptEdits';
  return ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema), '--model', binding.model, '--effort', binding.reasoning_effort,
    '--permission-mode', permissionMode, '--settings', JSON.stringify(settings), ...(resume ? ['--resume', resume] : [])];
}

export async function run({ root, args, prompt, env, output, onStart, onSession, onEvent, onStdout, onStderr, onCodexError }) {
  let stderr = '', buffer = '', sessionId = null, sessionSave = Promise.resolve(), result = null;
  const errors = [];
  const consume = (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        sessionId = event.session_id;
        if (onSession) sessionSave = sessionSave.then(() => onSession(sessionId));
      }
      onEvent?.({ event: 'provider_event', provider: id, type: event.type });
      if (event.type === 'error' || event.type === 'result' && event.subtype !== 'success') { errors.push(event); onCodexError?.(event); }
      if (event.type === 'result') result = event;
    } catch { errors.push({ message: 'Claude Code emitted invalid stream-json output' }); }
  };
  const child = spawn('sh', ['-c', 'IFS= read -r ready && [ "$ready" = HARNESS_START ] && exec "$@"', 'harness-launch', 'claude', ...args, prompt], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  child.stderr.on('data', (data) => { stderr += data; onStderr?.(data); });
  child.stdout.on('data', (data) => {
    onStdout?.(data);
    buffer += data;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) consume(line);
  });
  child.stdin.on('error', () => {});
  const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  try {
    await onStart(child.pid);
    onEvent?.({ event: 'child_started', provider: id, pid: child.pid });
    child.stdin.end('HARNESS_START\n');
    const { code, signal } = await completion;
    onEvent?.({ event: 'child_closed', code, signal });
    if (buffer) consume(buffer);
    await sessionSave;
    onEvent?.({ event: 'session_observed', provider: id, present: Boolean(sessionId) });
    if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Claude Code session ID invalid');
    if (code === 0 && !sessionId) throw new Error('Claude Code session ID missing');
    if (code === 0) {
      if (result?.subtype !== 'success' || !result.structured_output) throw new Error('Claude Code did not return successful structured output');
      await writeFile(output, `${JSON.stringify(result.structured_output)}\n`, { flag: 'wx', mode: 0o600 });
    }
    return { code, signal, stderr, errors, sessionId };
  } catch (error) {
    child.kill('SIGTERM'); await completion.catch(() => {}); throw error;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
