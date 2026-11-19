import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function codexTranscript(root, sessionId) {
  const id = sessionId || JSON.parse(await readFile(join(root, '.io/worktree.json'), 'utf8')).agent_sessions.orchestrator.session_id;
  const directory = join(process.env.CODEX_HOME, 'sessions');
  const path = join(directory, `rollout-fixture-${id}.jsonl`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n', { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return path;
}

export async function codexUserPrompt(root, text, { at = new Date().toISOString(), sessionId } = {}) {
  const path = await codexTranscript(root, sessionId);
  await appendFile(path, JSON.stringify({
    timestamp: at, type: 'response_item',
    payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: `$orchestrator ${text}` }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
    },
  }) + '\n');
  return path;
}
