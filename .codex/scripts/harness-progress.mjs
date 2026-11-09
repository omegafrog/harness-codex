#!/usr/bin/env node
// Read-only workflow progress view. No agent is involved: it reads the files the runner already keeps up to date.
//   node .codex/scripts/harness-progress.mjs [--session <dir>] [--watch [seconds]]
// Without --session it uses ./.io, or the most recently updated worktree session of this project.
import { readFile, readdir, stat } from 'node:fs/promises';
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
  for (const parent of parents) {
    for (const entry of await readdir(parent).catch(() => [])) {
      const dir = await has(join(parent, entry, '.io'));
      if (!dir) continue;
      const info = await stat(join(dir, 'runtime/orchestrator/state.json'));
      if (!best || info.mtimeMs > best.mtime) best = { dir, mtime: info.mtimeMs };
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
  }
  lines.push(`기록된 단계 ${counts.completed}/${counts.total} 완료 (앞으로의 단계는 알 수 없음)`, ...rows);
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
