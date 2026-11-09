#!/usr/bin/env node
// Read-only workflow progress view. No agent is involved: it reads the files the runner already keeps up to date.
//   node .codex/scripts/harness-progress.mjs [--session <dir>] [--watch [seconds]]
// Without --session it uses ./.io, or the most recently updated worktree session of this project.
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const installed = new URL('../../.harness/src/workflow/execution-state.mjs', import.meta.url);
const { processIdentity } = await import(installed.href);

const SYMBOL = { completed: '✓', running: '▶', waiting: '⏸', blocked: '■', failed: '✗', cancelled: '–', skipped: '–', pending: '·', stopped: '✗', unknown: '?' };
const LABEL = { completed: '완료', running: '실행 중', waiting: '대기', blocked: '막힘', failed: '실패', cancelled: '취소', skipped: '건너뜀', pending: '예정', stopped: '정지됨', unknown: '확인 불가' };
const CODE = {
  USER_DECISION_REQUIRED: '사용자 답변 필요', REVIEW_REQUIRED: '독립 리뷰 필요', SPEC_REVISION_REQUIRED: 'Spec 수정 필요',
  PLAN_REVISION_REQUIRED: '계획 수정 필요', IMPLEMENTATION_REVISION_REQUIRED: '구현 수정 필요',
};

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

async function findSession(explicit) {
  const has = async (dir) => (await stat(join(dir, 'runtime/orchestrator/state.json')).catch(() => null)) ? dir : null;
  if (explicit) return (await has(resolve(explicit))) || (await has(join(resolve(explicit), '.io'))) || null;
  const cwd = process.cwd();
  const local = await has(join(cwd, '.io'));
  if (local) return local;
  const parents = [join(dirname(cwd), '.harness-worktrees', basename(cwd)), join(homedir(), 'workspace/.harness-worktrees', basename(cwd))];
  let best = null;
  // Not inside a project that owns worktrees: fall back to the most recent session of any project beside it.
  for (const base of [join(dirname(cwd), '.harness-worktrees'), join(homedir(), 'workspace/.harness-worktrees')]) {
    for (const project of await readdir(base).catch(() => [])) if (!parents.includes(join(base, project))) parents.push(join(base, project));
  }
  const preferred = parents.slice(0, 2);
  for (const parent of parents) {
    for (const entry of await readdir(parent).catch(() => [])) {
      const dir = await has(join(parent, entry, '.io'));
      if (!dir) continue;
      const info = await stat(join(dir, 'runtime/orchestrator/state.json'));
      const rank = info.mtimeMs + (preferred.includes(parent) ? 1e13 : 0);
      if (!best || rank > best.mtime) best = { dir, mtime: rank };
    }
  }
  return best?.dir || null;
}

const duration = (from, to = Date.now()) => {
  const seconds = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  return Number.isFinite(seconds) ? `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : '';
};

async function alive(identity) {
  if (!identity?.pid) return null;
  const now = await processIdentity(identity.pid).catch(() => null);
  return Boolean(now && now.start && now.boot === identity.boot && now.start === identity.start && now.state !== 'Z');
}


const oneLine = (text, max = 110) => { const line = String(text).replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

// Codex keeps each conversation as a rollout file named after its thread id; the runner records that id.
async function rolloutFor(threadId) {
  const base = join(homedir(), '.codex/sessions');
  for (let back = 0; back < 3; back++) {
    const day = new Date(Date.now() - back * 86400000);
    const dir = join(base, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    const name = (await readdir(dir).catch(() => [])).find((file) => file.endsWith(`${threadId}.jsonl`));
    if (name) return join(dir, name);
  }
  return null;
}

async function tailLines(path, bytes = 98304) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').slice(size > length ? 1 : 0).filter(Boolean);
  } finally { await handle.close(); }
}

function describe(event) {
  const payload = event.payload || {};
  if (event.type === 'response_item') {
    if (payload.type === 'custom_tool_call') {
      const input = String(payload.input || '');
      const cmd = input.match(/cmd:\s*(["'`])((?:\\.|(?!\1).)*)\1/s)?.[2];
      return `▸ ${oneLine((cmd ?? input).replace(/\\(["'])/g, '$1'))}`;
    }
    if (payload.type === 'function_call') {
      let args = {};
      try { args = JSON.parse(payload.arguments || '{}'); } catch { /* keep raw */ }
      return `▸ ${oneLine(args.cmd || args.command || `${payload.name} ${payload.arguments || ''}`)}`;
    }
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = (payload.content || []).map((part) => part.text || '').join(' ');
      if (text.trim()) return `💬 ${oneLine(text)}`;
    }
  }
  if (event.type === 'event_msg' && payload.type === 'agent_message' && payload.message) return `💬 ${oneLine(payload.message)}`;
  return null;
}

async function latestActivity(session, entry) {
  if (!entry?.execution_id) return null;
  const directory = join(session, 'runtime/executions', entry.execution_id);
  const log = await readFile(join(directory, 'runner.stderr.log'), 'utf8').catch(() => '');
  const threadId = log.match(/"thread_id":"([^"]+)"/)?.[1];
  if (!threadId) return null;
  const activity = await threadActivity(threadId);
  return activity ? `${activity.text}  (${ago(activity.age)})` : null;
}

const ago = (seconds) => seconds < 120 ? `${seconds}초 전` : seconds < 7200 ? `${Math.round(seconds / 60)}분 전` : `${Math.round(seconds / 3600)}시간 전`;

async function threadActivity(threadId) {
  const rollout = await rolloutFor(threadId);
  if (!rollout) return null;
  const info = await stat(rollout);
  for (const line of (await tailLines(rollout)).reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const text = describe(event);
    if (text) return { text, age: Math.max(0, Math.round((Date.now() - (Date.parse(event.timestamp) || info.mtimeMs)) / 1000)) };
  }
  return null;
}

// A provider process resuming this conversation names its session ID on the command line. Its log can stay silent
// for minutes while it waits on a subagent or a long command, so the process, not the log age, says it is working.
async function conversationProcessAlive(id) {
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (args.includes(id)) return true;
  }
  return false;
}

// The main orchestrator works between stages (independent reviews, repair, tracker checks); show it too.
async function orchestratorRows(session, state, progress) {
  const id = progress?.orchestrator_session_id || state.orchestrator_session_id;
  const rows = [];
  const activity = id ? await threadActivity(id).catch(() => null) : null;
  const active = Boolean(id && (await conversationProcessAlive(id) || (activity && activity.age < 90)));
  rows.push(`  ${active ? '▶' : '·'} ${'orchestrator'.padEnd(18)} ${active ? '진행 중' : '대기'}${activity && !active ? ` · 마지막 활동 ${ago(activity.age)}` : ''}`);
  const reviewers = await activeSubagents(session, null, 'runtime/orchestrator/subagents.jsonl');
  if (reviewers.length) rows.push(`      └ 하위 agent: ${reviewers.join(', ')}`);
  if (active && activity) rows.push(`      └ ${activity.text}  (${ago(activity.age)})`);
  return rows;
}

// Reviewers a stage has started and not yet stopped.
async function activeSubagents(session, entry, path = null) {
  const text = await readFile(path ? join(session, path) : join(session, 'runtime/executions', entry?.execution_id || '-', 'subagents.jsonl'), 'utf8').catch(() => '');
  const open = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (e.event === 'SubagentStart') open.set(e.agent_id, e.agent_type); else if (e.event === 'SubagentStop') open.delete(e.agent_id); } catch { /* skip */ }
  }
  return [...open.values()];
}

export async function render(session) {
  const state = await readJson(join(session, 'runtime/orchestrator/state.json'));
  const progress = await readJson(join(session, 'runtime/orchestrator/progress.json'));
  const worktree = await readJson(join(session, 'worktree.json'));
  const lines = [];
  const request = progress?.request || worktree?.request || '';
  lines.push(`workflow ${state.status}${request ? ` — ${request.slice(0, 70)}` : ''}`);
  const counts = { completed: 0, total: 0 };
  const rows = [];
  for (const [id, entry] of Object.entries(state.stages || {})) {
    if (!entry) continue;
    let status = entry.status;
    let note = CODE[entry.code] || (entry.code && entry.code !== 'OK' ? entry.code : '');
    if (status === 'running') {
      const states = await Promise.all([alive(entry.owner), alive(entry.child)]);
      if (states.includes(false)) { status = 'stopped'; note = '실행기 프로세스가 없음 — 정지된 것으로 보임'; }
    }
    counts.total += 1;
    if (status === 'completed') counts.completed += 1;
    const time = status === 'running' ? duration(entry.started_at) : entry.started_at && entry.finished_at ? duration(entry.started_at, Date.parse(entry.finished_at)) : '';
    const attempts = (entry.attempts || []).length;
    rows.push(`  ${SYMBOL[status] || '?'} ${id.padEnd(18)} ${LABEL[status] || status}${time ? ` ${time}` : ''}${attempts > 1 ? ` · ${attempts}회차` : ''}${note ? ` · ${note}` : ''}`);
    if (status === 'running') {
      const agents = await activeSubagents(session, entry);
      const activity = await latestActivity(session, entry).catch(() => null);
      if (agents.length) rows.push(`      └ 하위 agent: ${agents.join(', ')}`);
      if (activity) rows.push(`      └ ${activity}`);
    }
  }
  lines.push(`기록된 단계 ${counts.completed}/${counts.total} 완료 (앞으로의 단계는 알 수 없음)`, ...rows);
  lines.push(...await orchestratorRows(session, state, progress));
  lines.push(`갱신 ${state.updated_at || '-'}`);
  return lines.join('\n');
}

try {
  const args = process.argv.slice(2);
  let session = null, watch = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session') session = args[++i];
    else if (args[i] === '--watch') watch = /^\d+$/.test(args[i + 1] || '') ? Number(args[++i]) : 3;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const dir = await findSession(session);
  if (!dir) throw new Error('No workflow session found; run inside the worktree or pass --session <dir>');
  if (watch === null) { process.stdout.write(`${await render(dir)}\n`); }
  else for (;;) {
    const text = await render(dir).catch((error) => `읽을 수 없음: ${error.message}`);
    process.stdout.write(`\x1b[2J\x1b[H${text}\n\n(${watch}초마다 갱신, Ctrl+C로 종료)\n`);
    await new Promise((done) => setTimeout(done, watch * 1000));
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
