import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseYaml } from '../../eval/yaml.mjs';

export const id = 'claude-code';

export function skillPrompt(skill, instructions) {
  return `Invoke the ${skill} skill using the Skill tool before doing any work. ${instructions}`;
}

export function prepareOutputSchema(schema) {
  const description = 'Keep status and code paired: completed=OK; action_required=REVIEW_REQUIRED|SPEC_REVISION_REQUIRED|PLAN_REVISION_REQUIRED|IMPLEMENTATION_REVISION_REQUIRED|USER_DECISION_REQUIRED; blocked=ENVIRONMENT_UNAVAILABLE|PERMISSION_REQUIRED|DEPENDENCY_INCOMPLETE|INPUT_MISSING|MODEL_BINDING_UNAVAILABLE; failed=EXECUTION_ERROR|INVALID_INPUT|ARTIFACT_WRITE_FAILED; cancelled=CANCELLED. Envelope and result status/code must match.';
  schema.properties.status.description = description;
  schema.properties.code.description = description;
  schema.properties.result.properties.status.description = description;
  schema.properties.result.properties.code.description = description;
  return schema;
}

const RESEARCH_ROLES = new Set(['spec_document_writer', 'code_researcher', 'architecture_review_lead', 'spec_adversarial_reviewer', 'knowledge_source_researcher', 'knowledge_principle_synthesizer', 'frontend_designer']);
const LEAF_ROLES = new Set(['code_researcher', 'knowledge_source_researcher', 'architecture_review_lead', 'spec_adversarial_reviewer', 'plan_reviewer']);

export function allowedToolsForRole(role, skill = null, requiredSkill = null) {
  if (['frontend_designer', 'frontend_implementation_agent', 'frontend_visual_reviewer'].includes(role) || skill === 'frontend-design') return null;
  const tools = ['Read', 'Glob', 'Grep', 'Bash'];
  if (!LEAF_ROLES.has(role)) tools.push('Agent');
  if (!['code_researcher', 'knowledge_source_researcher', 'architecture_review_lead', 'spec_adversarial_reviewer', 'plan_reviewer'].includes(role)) tools.push('Write', 'Edit');
  if (RESEARCH_ROLES.has(role) || skill === 'spec-me') tools.push('WebSearch', 'WebFetch');
  if (requiredSkill) tools.push('Skill');
  return tools;
}

export function buildCommand({ root, sandbox, binding, schema, resume, role, skill, requiredSkill, workerBase }) {
  const githubTracker = skill === 'implement-wrapper' && parseYaml(readFileSync(join(root, '.codex/harness.yaml'), 'utf8')).tracker?.mode === 'github';
  const agentEventHook = { type: 'command', command: `node "${join(root, '.codex/scripts/harness-agent-event.mjs')}"` };
  const admissionScript = join(root, '.codex/scripts/harness-agent-admission.mjs');
  const agentAdmissionHook = { type: 'command', command: `node "${admissionScript}" || printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Harness admission hook failed"}}'` };
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      ...(sandbox === 'read-only' ? { filesystem: { denyWrite: [root] } } : {}),
      ...(sandbox === 'danger-full-access' || githubTracker ? { network: { allowedDomains: ['api.github.com', 'github.com'] } } : {}),
    },
    hooks: {
      PreToolUse: [{ matcher: 'Agent', hooks: [agentAdmissionHook] }],
      SubagentStart: [{ hooks: [agentEventHook] }],
      SubagentStop: [{ hooks: [agentEventHook] }],
    },
  };
  const permissionMode = sandbox === 'read-only' ? 'plan' : sandbox === 'danger-full-access' ? 'bypassPermissions' : 'acceptEdits';
  return ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema), '--model', binding.model, '--effort', binding.reasoning_effort,
    ...(workerBase ? ['--system-prompt', `${workerBase}\n\nHarness execution rules: Follow the task instructions and required skill in the user prompt. Keep all logs and temporary files under the supplied session directory. Do not weaken workspace permissions or skip required independent review. Return only the requested structured result.`, '--system-prompt-snapshot', 'off'] : []),
    '--permission-mode', permissionMode, ...(!requiredSkill ? ['--disable-slash-commands'] : []), ...(allowedToolsForRole(role, skill, requiredSkill) ? ['--tools', allowedToolsForRole(role, skill, requiredSkill).join(',')] : []), '--settings', JSON.stringify(settings), ...(resume ? ['--resume', resume] : [])];
}

export async function run({ root, args, prompt, env, output, requiredSkill, onStart, onSession, onEvent, onStdout, onStderr, onCodexError }) {
  let stderr = '', buffer = '', sessionId = null, sessionSave = Promise.resolve(), result = null;
  let skillCall = null, skillInvoked = false;
  const errors = [];
  const consume = (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        sessionId = event.session_id;
        if (onSession) sessionSave = sessionSave.then(() => onSession(sessionId));
      }
      if (requiredSkill && event.type === 'assistant' && !event.parent_tool_use_id) {
        for (const item of event.message?.content || []) if (item.type === 'tool_use' && item.name === 'Skill' && item.input?.skill === requiredSkill) skillCall = item.id;
      }
      if (skillCall && event.type === 'user') {
        for (const item of event.message?.content || []) if (item.type === 'tool_result' && item.tool_use_id === skillCall && !item.is_error) {
          skillInvoked = true; onEvent?.({ event: 'skill_invoked', provider: id, skill: requiredSkill }); skillCall = null;
        }
      }
      onEvent?.({ event: 'provider_event', provider: id, type: event.type, ...(event.subtype ? { subtype: event.subtype } : {}) });
      if (event.type === 'result' && Array.isArray(event.permission_denials)) for (const denial of event.permission_denials) {
        const requested = denial.tool_input?.file_path;
        if (typeof requested !== 'string') continue;
        const path = resolve(root, requested), within = relative(root, path);
        onEvent?.({ event: 'permission_denied', provider: id, tool: denial.tool_name, path, workspace: root, within_workspace: within === '' || (!isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`)) });
      }
      if (event.type === 'error' || event.type === 'result' && event.subtype !== 'success') { errors.push(event); onCodexError?.(event); }
      if (event.type === 'result') result = event;
    } catch { errors.push({ message: 'Claude Code emitted invalid stream-json output' }); }
  };
  const child = spawn('sh', ['-c', 'IFS= read -r ready && [ "$ready" = HARNESS_START ] && exec "$@"', 'harness-launch', 'claude', ...args, prompt], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stop = (signal) => { onEvent?.({ event: 'runner_signal', signal }); child.kill('SIGTERM'); };
  const stopTerm = () => stop('SIGTERM'), stopInt = () => stop('SIGINT');
  process.once('SIGTERM', stopTerm); process.once('SIGINT', stopInt);
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
      if (requiredSkill && !skillInvoked) throw new Error(`Claude did not invoke the required skill: ${requiredSkill}`);
      if (result?.subtype !== 'success' || !result.structured_output) throw new Error('Claude Code did not return successful structured output');
      await writeFile(output, `${JSON.stringify(result.structured_output)}\n`, { flag: 'wx', mode: 0o600 });
    }
    return { code, signal, stderr, errors, sessionId };
  } catch (error) {
    child.kill('SIGTERM'); await completion.catch(() => {}); throw error;
  } finally {
    process.removeListener('SIGTERM', stopTerm); process.removeListener('SIGINT', stopInt);
  }
}
