import { spawn } from 'node:child_process';

export async function runCodexProcess({ root, args, env, prompt, onStart, onThread }) {
  // Codex를 시작하고 thread 이벤트를 저장한 뒤 종료 코드·오류·session ID를 반환한다.
  // buffer는 아직 줄바꿈이 오지 않은 JSON 조각, threadId는 재개에 쓰는 실제 Codex session이다.
  let stderr = '', buffer = '', threadId = null, sessionSave = Promise.resolve();
  const errors = [];
  // JSONL 출력에서 실행 상태와 재개에 필요한 thread ID만 추출한다.
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
  // onStart가 프로세스 소유권을 기록할 때까지 입력을 보내지 않도록 시작 신호로 잠근다.
  const child = spawn('sh', ['-c', 'IFS= read -r ready && [ "$ready" = HARNESS_START ] && exec "$@"', 'harness-launch', 'codex', ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.end(`HARNESS_START\n${prompt}`);
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
