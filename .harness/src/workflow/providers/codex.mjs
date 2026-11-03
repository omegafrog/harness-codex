import { dirname, join, resolve } from 'node:path';
import { realpath, readdir } from 'node:fs/promises';
import { runCodexProcess } from '../codex-process.mjs';

export const id = 'codex';

export async function resumeWriteDirs(sessionId, env) {
  const home = resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'));
  const sessionRoot = join(home, 'sessions');
  const dirs = new Set();
  async function findSession(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await findSession(path);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) return dirname(path);
    }
    return null;
  }
  const sessionDir = await findSession(await realpath(sessionRoot));
  if (!sessionDir) throw new Error(`Codex resume session file not found under ${sessionRoot}: ${sessionId}`);
  dirs.add(await realpath(sessionDir));
  for (const path of ['thread-writer-locks', 'shell_snapshots', 'tmp/arg0', 'tmp/arg0-linux']) {
    try { dirs.add(await realpath(join(home, path))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...dirs];
}

export function buildCommand({ root, sandbox, resumeWriteDirs: dirs, binding, schemaPath, output, resume }) {
  return ['exec', '--sandbox', sandbox, ...dirs.flatMap((path) => ['--add-dir', path]), '--cd', root, '--model', binding.model,
    '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--enable', 'multi_agent', '--json',
    '--output-schema', schemaPath, '--output-last-message', output, ...(resume ? ['resume', resume, '-'] : ['-'])];
}

export async function run({ root, args, prompt, env, onStart, onSession }) {
  const result = await runCodexProcess({ root, args, prompt, env, onStart, onThread: onSession });
  return { ...result, sessionId: result.threadId };
}
