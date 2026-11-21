import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../.harness/scripts/harness-context.mjs', import.meta.url));

test('entry reports setup and rejects a session whose transcript belongs to another workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const home = join(root, 'codex-home');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const id = '11111111-1111-1111-1111-111111111111';
  await writeFile(join(home, 'sessions', `rollout-test-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/other/worktree' } }) + '\n');
  const output = execFileSync(process.execPath, [cli, '--entry'], { cwd: root, env: { ...process.env, CODEX_HOME: home, CODEX_THREAD_ID: id }, encoding: 'utf8' });
  const context = JSON.parse(output);
  assert.equal(context.session_verified, false);
  assert.equal(context.decision_hint, 'setup_candidate');
  assert.match(context.next, /setup/);
});

test('approval proof accepts only the bound provider transcript and actual user or form replies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'codex');
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const id = '11111111-1111-1111-1111-111111111111';
  await mkdir(join(root, '.io'), { recursive: true });
  await mkdir(join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
  await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ agent_sessions: { orchestrator: { session_id: id, provider: 'codex' } } }));
  const at = '2026-01-02T00:00:00.000Z';
  const rows = [
    { type: 'session_meta', payload: { id, cwd: root } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fake approval' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] } } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'model approval' }] } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '$orchestrator real approval' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'form' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'form', output: '{"answers":{"decision":{"answers":["form approval"]}}}' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'other', output: 'fake form' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', arguments: '{"questions":[{}]}', call_id: 'async' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'async', output: '{"accepted":true}' } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<send_user_message_question_reply>' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'async', 0]), answer: 'async approval', question: 'question-only text' }]) + '</send_user_message_question_reply>' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
  ];
  const path = join(process.env.CODEX_HOME, 'sessions', `rollout-test-${id}.jsonl`);
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n');
  const { userSaidAfter } = await import('../.harness/src/workflow/user-inputs.mjs');
  const proof = (text, since = '2026-01-01T00:00:00Z') => userSaidAfter({ root, text, since });
  assert.equal(await proof('real approval'), true);
  rows.push({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'another request' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n' + '{"partial":');
  assert.equal(await proof('another request'), false);
  assert.equal(await proof('real approval'), true);
  assert.equal(await proof('form approval'), true);
  assert.equal(await proof('async approval'), true);
  assert.equal(await proof('question-only text'), false);
  assert.equal(await proof('fake approval'), false);
  assert.equal(await proof('model approval'), false);
  assert.equal(await proof('fake form'), false);
  assert.equal(await proof('real approval', '2026-01-03T00:00:00Z'), false);
  const { lastOrchestratorTurn } = await import('../.harness/src/workflow/cli-context.mjs');
  rows.push({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Awaiting your answer?' }] } });
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n');
  assert.equal((await lastOrchestratorTurn(root)).message, 'Awaiting your answer?');
  rows.push({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '$orchestrator confirmed' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n');
  assert.equal(await lastOrchestratorTurn(root), null);
  await mkdir(join(root, '.io/runtime/orchestrator'), { recursive: true });
  await writeFile(join(root, '.io/runtime/orchestrator/last-turn.txt'), 'Delivered question?');
  assert.equal((await lastOrchestratorTurn(root)).message, 'Delivered question?');
  rows.at(-1).timestamp = '2099-01-01T00:00:00.000Z';
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n');
  assert.equal(await lastOrchestratorTurn(root), null);
  assert.equal(await proof('confirmed'), true);
  rows[0].payload.source = { subagent: { thread_spawn: {} } };
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n');
  assert.equal(await proof('real approval'), false);
  delete rows[0].payload.source;
  rows[0].payload.cwd = '/another/worktree';
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n');
  assert.equal(await proof('real approval'), false);
});

test('Claude approval proof excludes sidechains and unrelated tool outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-claude-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const id = '22222222-2222-2222-2222-222222222222';
  await mkdir(join(root, '.io'), { recursive: true });
  await mkdir(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'project'), { recursive: true });
  await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ agent_sessions: { orchestrator: { session_id: id, provider: 'claude-code' } } }));
  const base = { timestamp: '2026-01-02T00:00:00.000Z', sessionId: id, cwd: root, isSidechain: false };
  const rows = [
    { ...base, type: 'user', message: { role: 'user', content: '<command-name>/orchestrator</command-name><command-args>real approval</command-args>' } },
    { ...base, type: 'user', isSidechain: true, message: { role: 'user', content: '/orchestrator side approval' } },
    { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'form' }] } },
    { ...base, type: 'user', toolUseResult: { answers: { question: 'form approval' } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'form', content: 'form approval' }] } },
    { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other', content: 'fake approval' }] } },
  ];
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'project', `${id}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n');
  const { userSaidAfter } = await import('../.harness/src/workflow/user-inputs.mjs');
  for (const [text, expected] of [['real approval', true], ['form approval', true], ['side approval', false], ['fake approval', false]]) assert.equal(await userSaidAfter({ root, text }), expected, text);
});

test('entry routes an uninitialized directory to setup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-uninitialized-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [cli, '--entry'], { cwd: root, env: { ...process.env, CODEX_THREAD_ID: '' }, encoding: 'utf8' });
  assert.equal(JSON.parse(output).decision_hint, 'setup_candidate');
});

test('Claude entry verifies the live ancestor registry and rejects altered process identity', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux process registry');
  const root = await mkdtemp(join(tmpdir(), 'harness-claude-ancestor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { symlink } = await import('node:fs/promises');
  const fakeClaude = join(root, 'claude');
  await symlink(process.execPath, fakeClaude);
  const config = join(root, 'config');
  await mkdir(join(config, 'sessions'), { recursive: true });
  const parent = join(root, 'parent.cjs');
  await writeFile(parent, `
process.title = 'claude';
const fs = require('node:fs'), cp = require('node:child_process');
const stat = fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ');
const machine = fs.readFileSync('/etc/machine-id', 'utf8').trim();
const domain = 'linux:' + machine + ':' + fs.readlinkSync('/proc/self/ns/pid');
const entry = { pid: process.pid, procStart: process.argv[2] === 'wrong' ? '0' : stat[19], pidDomain: process.argv[2] === 'wrong-domain' ? domain + '-other' : domain, cwd: process.cwd(), sessionId: '33333333-3333-3333-3333-333333333333' };
fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/sessions/' + process.pid + '.json', JSON.stringify(entry));
process.stdout.write(cp.execFileSync(process.execPath, [process.env.ENTRY_CLI, '--entry'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' }));
`);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDECODE: '1', ENTRY_CLI: cli, CODEX_THREAD_ID: '' };
  const run = (mode) => JSON.parse(execFileSync(fakeClaude, [parent, mode], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(run('correct').session_id, '33333333-3333-3333-3333-333333333333');
  assert.equal(run('wrong').session_id, null);
  assert.equal(run('wrong-domain').session_id, null);
});
