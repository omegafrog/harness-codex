import { spawn } from 'node:child_process';

export async function runCodexProcess({ root, args, env, prompt, onStart, onThread }) {
  let stderr = '', buffer = '', threadId = null, sessionSave = Promise.resolve();
  const errors = [];
  const consume = (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'error' || event.type === 'turn.failed') errors.push(event);
      if (event.type === 'thread.started') {
        threadId = event.thread_id;
        if (onThread) sessionSave = sessionSave.then(() => onThread(threadId));
      }
    } catch {}
  };
  const child = spawn('codex', args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.on('data', (data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) consume(line);
  });
  child.stdin.on('error', () => {});
  const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  try {
    await onStart(child.pid);
    child.stdin.end(prompt);
    const code = await completion;
    if (buffer) consume(buffer);
    await sessionSave;
    if (threadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Invalid Codex session ID');
    return { code, stderr, errors, threadId };
  } catch (error) {
    child.kill('SIGTERM');
    await completion.catch(() => {});
    throw error;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
