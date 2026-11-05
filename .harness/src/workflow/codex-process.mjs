import { spawn } from 'node:child_process';

export async function runCodexProcess({ root, args, env, prompt, onStart, onThread, onEvent = () => {}, onStderr = () => {}, onCodexError = () => {} }) {
  // Codex를 시작하고 thread 이벤트를 저장한 뒤 종료 코드·오류·session ID를 반환한다.
  // buffer는 아직 줄바꿈이 오지 않은 JSON 조각, threadId는 재개에 쓰는 실제 Codex session이다.
  let stderr = '', buffer = '', threadId = null, sessionSave = Promise.resolve();
  const errors = [];
  // JSONL 출력에서 실행 상태와 재개에 필요한 thread ID만 추출한다.
  const consume = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event && typeof event === 'object') {
      if (typeof event.type === 'string') onEvent({ event: 'codex_event', type: event.type, ...(typeof event.item?.type === 'string' ? { item_type: event.item.type } : {}), ...(typeof event.subtype === 'string' ? { subtype: event.subtype } : {}), ...(event.type === 'thread.started' && /^[0-9a-f-]{36}$/i.test(event.thread_id || '') ? { thread_id: event.thread_id } : {}) });
      if (event.type === 'error' || event.type === 'turn.failed') { errors.push(event); onCodexError(event); }
      if (event.type === 'thread.started') {
        threadId = event.thread_id;
        if (onThread) sessionSave = sessionSave.then(() => onThread(threadId));
      }
    }
  };
  // onStart가 프로세스 소유권을 기록할 때까지 입력을 보내지 않도록 시작 신호로 잠근다.
  const child = spawn('sh', ['-c', 'IFS= read -r ready && [ "$ready" = HARNESS_START ] && exec "$@"', 'harness-launch', 'codex', ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stopTerm = () => { onEvent({ event: 'runner_signal', signal: 'SIGTERM' }); child.kill('SIGTERM'); };
  const stopInt = () => { onEvent({ event: 'runner_signal', signal: 'SIGINT' }); child.kill('SIGTERM'); };
  process.once('SIGTERM', stopTerm);
  process.once('SIGINT', stopInt);
  child.stderr.on('data', (data) => { stderr += data; onStderr(data); });
  child.stdout.on('data', (data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) consume(line);
  });
  child.stdin.on('error', () => {});
  const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  try {
    await onStart(child.pid);
    onEvent({ event: 'child_started', pid: child.pid });
    child.stdin.end(`HARNESS_START\n${prompt}`);
    const { code, signal } = await completion;
    onEvent({ event: 'child_exited', code, signal });
    if (buffer) consume(buffer);
    await sessionSave;
    if (threadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Invalid Codex session ID');
    return { code, signal, stderr, errors, threadId };
  } catch (error) {
    onEvent({ event: 'runner_error', message: error.message });
    child.kill('SIGTERM');
    await completion.catch(() => {});
    throw error;
  } finally {
    process.removeListener('SIGTERM', stopTerm);
    process.removeListener('SIGINT', stopInt);
  }
}
