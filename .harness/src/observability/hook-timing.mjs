// Opt-in timing of Harness PreToolUse hook scripts (HARNESS_HOOK_TIMING=1). Measurement only: it never changes a hook
// decision, and any failure to record is swallowed. The hook command strings stay as installed; the node script calls
// this at its start, and the record is appended synchronously when the process exits, so `process.exit()` paths count.
// One JSON line per invocation goes to <workspace>/.io/runtime/hooks/pretooluse-timing.jsonl. Invocations that the
// installed shell wrapper filters out before node starts (for example a non-spawn tool for the fresh-agent hook) are
// not measured here; `node_uptime_ms` includes Node's own startup, `duration_ms` only the script after this call.
import { appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export const HOOK_TIMING_LOG = 'runtime/hooks/pretooluse-timing.jsonl';

function workspaceRoot(env) {
  if (isAbsolute(env.HARNESS_WORKSPACE_ROOT || '')) return env.HARNESS_WORKSPACE_ROOT;
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null; }
  catch { return null; }
}

export async function startHookTiming(hook, { env = process.env } = {}) {
  if (env.HARNESS_HOOK_TIMING !== '1') return null;
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let sessionOutputPath;
  try { ({ sessionOutputPath } = await import('../workflow/session-output.mjs')); } catch { return null; }
  let written = false;
  const finish = () => {
    if (written) return;
    written = true;
    const duration = performance.now() - started;
    try {
      const root = workspaceRoot(env);
      // Only a Harness workspace gets a log; a hook running in some other repository leaves no file behind.
      if (!root || !existsSync(join(root, '.harness'))) return;
      const path = sessionOutputPath(root, HOOK_TIMING_LOG);
      appendFileSync(path, `${JSON.stringify({
        hook, started_at: startedAt, duration_ms: Math.round(duration * 1000) / 1000, node_uptime_ms: Math.round(process.uptime() * 1000),
        exit_code: typeof process.exitCode === 'number' ? process.exitCode : 0, pid: process.pid,
        stage_execution_id: env.HARNESS_STAGE_EXECUTION_ID || null,
      })}\n`, { mode: 0o600 });
    } catch { /* Measurement must never affect the hook. */ }
  };
  process.once('exit', finish);
  return finish;
}

// Summary per hook for E2E telemetry: invocations and total/mean/max duration, optionally since a start time.
export function summarizeHookTiming(rows, since = null) {
  const hooks = {};
  for (const row of rows) {
    if (typeof row?.hook !== 'string' || !Number.isFinite(row.duration_ms)) continue;
    if (since !== null && !(Date.parse(row.started_at) >= since)) continue;
    const item = hooks[row.hook] ||= { invocations: 0, total_ms: 0, max_ms: 0, max_node_uptime_ms: 0 };
    item.invocations += 1;
    item.total_ms += row.duration_ms;
    item.max_ms = Math.max(item.max_ms, row.duration_ms);
    if (Number.isFinite(row.node_uptime_ms)) item.max_node_uptime_ms = Math.max(item.max_node_uptime_ms, row.node_uptime_ms);
  }
  for (const item of Object.values(hooks)) { item.total_ms = Math.round(item.total_ms * 1000) / 1000; item.mean_ms = Math.round((item.total_ms / item.invocations) * 1000) / 1000; }
  return hooks;
}
