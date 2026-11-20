#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { findRollout } from '../../../../../.harness/src/workflow/providers/codex.mjs';
import { sessionOutputPath } from '../../../../../.harness/src/workflow/session-output.mjs';

const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CALL = new Set(['function_call', 'custom_tool_call', 'web_search_call', 'computer_call']);
const OUTPUT = new Set(['function_call_output', 'custom_tool_call_output', 'computer_call_output']);
const TOKEN_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const JS_LITERAL = /(?:\x60([^\x60]*)\x60|"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)')/g;
const JS_COMMAND = new RegExp(/(?:\bcmd\s*:\s*|\b(?:const|let)\s+cmd\s*=\s*)/.source + JS_LITERAL.source, 'g');
const SHELL_CATEGORIES = {
  search: /^(?:rg|grep|find|fd|git\s+(?:ls-files|grep))\b/,
  read: /^(?:cat|sed|head|tail|less)\b/,
  test: /^(?:npm\s+(?:test|run\s+(?:test|e2e))|(?:pnpm|yarn)\s+test|npx\s+(?:vitest|playwright\s+test)|node\s+(?:(?:--\S+(?:\s+(?!--)\S+)?)\s+)*--test|pytest|go\s+test|cargo\s+test|python\S*\s+-m\s+unittest|node\s+\S*harness-exec\.mjs)\b/,
};
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shellSegments = /"(?:\\.|[^"\\])*"|'[^']*'|\\.|`[^`]*`|(&&|\|\||[;\n|])/g;

function commandStarts(command) {
  const starts = [];
  let start = 0;
  for (const match of command.matchAll(shellSegments)) {
    if (!match[1]) continue;
    starts.push(command.slice(start, match.index));
    start = match.index + match[1].length;
  }
  starts.push(command.slice(start));
  return starts.map((segment) => segment.trim().replace(/^(?:env\s+)?(?:[A-Za-z_][\w]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/, ''));
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function shellCommands(item) {
  if (item.name === 'exec_command' || item.name === 'shell') {
    const command = parseJson(item.arguments)?.cmd;
    return typeof command === 'string' ? [command] : [];
  }
  if (item.name !== 'exec' || typeof item.input !== 'string') return [];
  const commands = [];
  for (const match of item.input.matchAll(JS_COMMAND)) commands.push(match.slice(1, 4).find((text) => text !== undefined));
  for (const [, array] of item.input.matchAll(/\b(?:const|let)\s+cmds\s*=\s*\[([\s\S]*?)\]/g)) {
    for (const match of array.matchAll(JS_LITERAL)) commands.push(match.slice(1, 4).find((text) => text !== undefined));
  }
  return commands;
}

function tally(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function addTokens(total, entry) {
  for (const key of TOKEN_KEYS) {
    if (Number.isSafeInteger(entry[key]) && entry[key] >= 0) total[key] = (total[key] || 0) + entry[key];
  }
}

function label(value, fallback = null) {
  return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,160}$/.test(value) ? value : fallback;
}

function toolCall({ line, turn, name, commands, identity }) {
  const starts = commands.flatMap(commandStarts);
  return {
    line, turn_id: turn, tool: name,
    categories: Object.entries(SHELL_CATEGORIES).filter(([, pattern]) => starts.some((command) => pattern.test(command))).map(([key]) => key),
    ...(identity ? { identity } : {}), commandDigests: commands.map(fingerprint),
  };
}

function addOutput(call, line, output) {
  call.output_line = line;
  call.output_bytes = Buffer.byteLength(output);
  if (/\b(?:non-zero exit|exited with code [1-9]\d*)\b/i.test(output)) call.categories.push('failed_command');
  if (call.categories.some((category) => category === 'read' || category === 'search')
      && /\b(?:No such file or directory|cannot find the path specified|ENOENT)\b/i.test(output)) call.categories.push('missing_path');
  if (call.tool === 'list_agents') call.outputDigest = fingerprint(output);
}

async function* transcriptLines(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let stream;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe transcript');
    stream = file.createReadStream({ autoClose: false });
    yield* createInterface({ input: stream, crlfDelay: Infinity });
  } finally {
    stream?.destroy();
    await file.close();
  }
}

async function inspectRollout(path, id, parent, since) {
  const record = { thread_id: id, parent_thread_id: parent, rollout: path, role: null, tokens: {}, calls: [], compactions: [], children: [], invalid_lines: 0 };
  const responses = new Set(), calls = new Map(), callIdentities = new Set(), compactionsSeen = new Set();
  let metadata = false, fallback = null, lineNumber = 0, turn = null;
  for await (const line of transcriptLines(path)) {
    lineNumber += 1;
    const entry = parseJson(line), item = entry?.payload;
    if (lineNumber === 1) {
      const spawn = item?.source?.subagent?.thread_spawn;
      const declaredParent = item?.parent_thread_id || spawn?.parent_thread_id || null;
      if (entry?.type !== 'session_meta' || item?.id !== id || (parent && declaredParent !== parent)) throw new Error('Transcript identity mismatch');
      if (THREAD_ID.test(declaredParent || '')) record.parent_thread_id = declaredParent;
      record.role = label(spawn?.agent_role);
      metadata = true;
      continue;
    }
    if (!entry) { record.invalid_lines += 1; continue; }
    if (entry.type === 'turn_context') turn = label(item?.turn_id);
    if (!item || (since !== null && !(Date.parse(entry.timestamp) >= since))) continue;
    if (entry.type === 'token_usage_record' && item.thread_id === id && item.response_id && item.usage && !responses.has(item.response_id)) {
      responses.add(item.response_id);
      addTokens(record.tokens, item.usage);
    }
    if (entry.type === 'event_msg' && item.type === 'token_count') fallback = item.info?.total_token_usage || fallback;
    if (entry.type === 'event_msg' && item.type === 'item_completed') {
      const activity = item.item;
      if (activity?.type === 'SubAgentActivity' && (!item.thread_id || item.thread_id === id)
          && ['started', 'interacted', 'completed'].includes(activity.kind) && THREAD_ID.test(activity.agent_thread_id || '')) {
        record.children.push(activity.agent_thread_id);
      }
      // The paired `compacted` record carries summary text, and a history fork can copy a parent's events.
      if (activity?.type === 'ContextCompaction' && item.thread_id === id && typeof activity.id === 'string' && !compactionsSeen.has(activity.id)) {
        compactionsSeen.add(activity.id);
        record.compactions.push({ line: lineNumber, turn_id: label(item.turn_id), at: entry.timestamp });
      }
    }
    if (entry.type !== 'response_item') continue;
    if (CALL.has(item.type)) {
      const id = item.call_id || item.id;
      const identity = id ? fingerprint([id, item.type, item.name, item.arguments, item.input, item.action]) : null;
      if (!identity || !callIdentities.has(identity)) {
        const call = toolCall({ line: lineNumber, turn, name: label(item.name, item.type), commands: shellCommands(item), identity });
        if (id) { calls.set(id, call); callIdentities.add(identity); }
        record.calls.push(call);
      }
    }
    if (OUTPUT.has(item.type) && calls.has(item.call_id)) {
      const call = calls.get(item.call_id);
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      addOutput(call, lineNumber, output);
    }
  }
  if (!metadata) throw new Error('Transcript is empty');
  if (!responses.size && fallback && since === null) addTokens(record.tokens, fallback);
  record.token_source = responses.size ? 'token_usage_record' : Object.keys(record.tokens).length ? 'token_count' : null;
  return record;
}

async function measure(roots, since) {
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const queue = [...new Set(roots)].map((id) => ({ id, parent: null, near: null }));
  const seen = new Set(), threads = [], missing = [], tokens = {};
  for (const { id, parent, near } of queue) {
    if (seen.has(id)) continue;
    seen.add(id);
    const path = (near && await findRollout(near, id))
      || await findRollout(join(home, 'sessions'), id)
      || await findRollout(join(home, 'archived_sessions'), id);
    if (!path) { missing.push({ thread_id: id, reason: 'rollout_missing' }); continue; }
    let thread;
    try { thread = await inspectRollout(path, id, parent, since); }
    catch { missing.push({ thread_id: id, reason: 'rollout_unreadable_or_mismatched' }); continue; }
    for (const child of thread.children) queue.push({ id: child, parent: id, near: dirname(path) });
    threads.push(thread);
    addTokens(tokens, thread.tokens);
  }
  const status = !threads.length ? 'unavailable' : missing.length || threads.some((thread) => !thread.token_source || thread.invalid_lines) ? 'partial' : 'complete';
  const compactions = threads.reduce((count, thread) => count + thread.compactions.length, 0);
  return { status, since: since === null ? null : new Date(since).toISOString(), tokens, missing, compactions, threads };
}

async function inspectClaude(path, session, agent, since, usageSeen) {
  const id = agent ? `${session}/${agent}` : session;
  const record = { thread_id: id, parent_thread_id: agent ? session : null, rollout: path, role: agent ? 'Agent' : null,
    tokens: {}, calls: [], compactions: [], invalid_lines: 0, token_source: null };
  const requests = new Map(), calls = new Map(), compactions = new Set();
  let line = 0, verified = false;
  for await (const text of transcriptLines(path)) {
    line += 1;
    const entry = parseJson(text);
    if (!entry) { record.invalid_lines += 1; continue; }
    if (entry.sessionId !== session || (entry.agentId ?? null) !== agent) continue;
    verified = true;
    if (since !== null && !(Date.parse(entry.timestamp) >= since)) continue;
    const message = entry.message;
    if (entry.type === 'assistant' && message?.usage && typeof message.id === 'string') {
      // Claude can emit several blocks for one assistant message. Later blocks carry the final usage.
      requests.set(message.id, { ...requests.get(message.id), ...message.usage });
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.uuid && !compactions.has(entry.uuid)) {
      compactions.add(entry.uuid);
      record.compactions.push({ line, turn_id: null, at: entry.timestamp });
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (entry.type === 'assistant' && block.type === 'tool_use') {
        const identity = block.id ? fingerprint([block.id, block.name, block.input]) : null;
        if (identity && calls.get(block.id)?.identity === identity) continue;
        const commands = block.name === 'Bash' && typeof block.input?.command === 'string' ? [block.input.command] : [];
        const call = toolCall({ line, turn: label(message.id), name: label(block.name, 'tool_use'), commands, identity });
        if (['Glob', 'Grep'].includes(block.name)) call.categories.push('search');
        if (block.name === 'Read') call.categories.push('read');
        if (block.id) calls.set(block.id, call);
        record.calls.push(call);
      }
      if (entry.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id);
        const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        addOutput(call, line, output);
        if (block.is_error && call.tool === 'Bash') call.categories.push('failed_command');
      }
    }
  }
  if (!verified) throw new Error('Transcript identity mismatch');
  for (const [messageId, usage] of requests) {
    if (usageSeen.has(messageId)) continue;
    usageSeen.add(messageId);
    const { input_tokens, cache_read_input_tokens = 0, cache_creation_input_tokens = 0, output_tokens } = usage;
    addTokens(record.tokens, { input_tokens: input_tokens + cache_read_input_tokens + cache_creation_input_tokens,
      cached_input_tokens: cache_read_input_tokens, cache_creation_input_tokens, output_tokens });
  }
  if (requests.size) record.token_source = 'assistant_usage';
  return record;
}

async function measureClaude(roots, since) {
  const home = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const dirs = async (path) => readdir(path, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const directories = (await dirs(home)).filter((entry) => entry.isDirectory());
  const missing = [], threads = [], tokens = {}, usageSeen = new Set();
  const collect = async (path, session, agent) => {
    try {
      const record = await inspectClaude(path, session, agent, since, usageSeen);
      if (!agent || since === null || record.token_source || record.calls.length || record.compactions.length || record.invalid_lines) {
        threads.push(record);
        addTokens(tokens, record.tokens);
      }
    } catch { missing.push({ thread_id: agent ? `${session}/${agent}` : session, reason: 'transcript_unreadable_or_mismatched' }); }
  };
  for (const session of new Set(roots)) {
    const paths = await Promise.all(directories.map(async (entry) => {
      const path = join(home, entry.name, `${session}.jsonl`);
      return await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }) ? path : null;
    }));
    const matches = paths.filter(Boolean);
    if (matches.length !== 1) { missing.push({ thread_id: session, reason: matches.length ? 'transcript_ambiguous' : 'transcript_missing' }); continue; }
    const [path] = matches;
    const count = threads.length;
    await collect(path, session, null);
    if (threads.length === count) continue;
    const directory = join(dirname(path), session);
    const subagents = join(directory, 'subagents');
    const realDirectory = async (path) => (await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }))?.isDirectory();
    if (!await realDirectory(directory) || !await realDirectory(subagents)) continue;
    for (const entry of await dirs(subagents)) {
      const agent = /^agent-([a-z0-9_-]+)\.jsonl$/i.exec(entry.name)?.[1];
      if (agent) await collect(join(subagents, entry.name), session, agent);
    }
  }
  return {
    status: !threads.length ? 'unavailable' : missing.length || threads.some((thread) => !thread.token_source || thread.invalid_lines) ? 'partial' : 'complete',
    since: since === null ? null : new Date(since).toISOString(), tokens, missing, threads,
    compactions: threads.reduce((sum, thread) => sum + thread.compactions.length, 0),
  };
}

function countCalls(report) {
  const { threads } = report;
  const tools = Object.create(null), candidates = Object.create(null);
  const byThread = new Map(threads.map((thread) => [thread.thread_id, thread]));
  const original = new Set();
  let copied = 0;
  const countThread = (thread) => {
    if (!thread || !byThread.delete(thread.thread_id)) return;
    countThread(byThread.get(thread.parent_thread_id));
    const commandsSeen = new Set(), listingsSeen = new Set();
    thread.calls = thread.calls.filter(({ identity }) => {
      if (!identity) return true;
      if (original.has(identity)) { copied += 1; return false; }
      original.add(identity);
      return true;
    }).map(({ identity, commandDigests, outputDigest, ...call }) => {
      if (commandDigests.some((key) => commandsSeen.has(key))) call.categories.push('repeated_command');
      for (const key of commandDigests) commandsSeen.add(key);
      if (outputDigest && listingsSeen.has(outputDigest)) call.categories.push('unchanged_agent_list');
      if (outputDigest) listingsSeen.add(outputDigest);
      tally(tools, call.tool);
      for (const category of new Set(call.categories)) tally(candidates, category);
      return call;
    });
  };
  for (const thread of threads) countThread(thread);
  return { tools, candidates, copied_calls_excluded: copied, calls: threads.reduce((sum, thread) => sum + thread.calls.length, 0) };
}

function markdown(report) {
  const { status, tokens, threads, calls, tools, candidates, missing, compactions } = report;
  const format = (value) => value === undefined ? '수집 불가' : value.toLocaleString('ko-KR');
  const uncached = tokens.input_tokens !== undefined && tokens.cached_input_tokens !== undefined
    ? tokens.input_tokens - tokens.cached_input_tokens : undefined;
  return [
    '# E2E 사용량과 도구 호출',
    '',
    '- 수집 상태 ' + status + ' · 확인한 스레드 ' + threads.length + '개 · 누락 ' + missing.length + '개',
    '- 입력 ' + format(tokens.input_tokens) + ' · 캐시 입력 ' + format(tokens.cached_input_tokens) + ' · 출력 ' + format(tokens.output_tokens) + ' · 추론 출력 ' + format(tokens.reasoning_output_tokens),
    '- 캐시 제외 입력 ' + format(uncached),
    ...(report.provider === 'claude-code' ? ['- 캐시 기록 입력 ' + format(tokens.cache_creation_input_tokens) + ' · 캐시 제외 입력에 포함'] : []),
    '- 모델 도구 호출 ' + (threads.length ? format(calls) + '회' : '수집 불가'),
    '- 복사된 도구 호출 제외 ' + format(report.copied_calls_excluded) + '회',
    '- 컨텍스트 압축 관측 ' + (threads.length ? format(compactions) + '회' : '수집 불가'),
    ...Object.entries(tools).map(([key, count]) => '  - ' + key + ' ' + count + '회'),
    ...Object.entries(candidates).map(([key, count]) => '- 검토 후보 ' + key + ' ' + count + '회'),
    '',
    ...threads.length ? [
      '| 스레드 | 역할 | 입력 | 캐시 입력 | 출력 | 도구 호출 | 압축 관측 |',
      '|---|---|---:|---:|---:|---:|---:|',
      ...threads.map((thread) => [thread.thread_id, thread.role || '상위', format(thread.tokens.input_tokens),
        format(thread.tokens.cached_input_tokens), format(thread.tokens.output_tokens), thread.calls.length, thread.compactions.length].join(' | ')).map((row) => '| ' + row + ' |'),
      '',
    ] : [],
    '캐시 입력은 전체 입력에 포함된다. 후보 유형은 같은 호출에서 겹칠 수 있다.',
    '스레드별 집계와 원본 줄 번호는 [telemetry.json](telemetry.json)에 있다. 호출 후보의 필요 여부는 당시 입력과 지침을 대조하여 판단한다.',
    '',
  ].join('\n');
}

async function save(root, relative, content) {
  const path = sessionOutputPath(root, relative);
  const temporary = sessionOutputPath(root, relative + '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  return path;
}

async function main() {
  const enabled = process.env.HARNESS_E2E_TELEMETRY ?? '0';
  if (enabled === '0') return { status: 'disabled' };
  if (enabled !== '1') throw new Error('HARNESS_E2E_TELEMETRY must be 0 or 1');
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, 'run-id': { type: 'string' },
    thread: { type: 'string', multiple: true, default: [] }, since: { type: 'string' }, provider: { type: 'string', default: 'codex' },
  } });
  const since = values.since === undefined ? null : Date.parse(values.since);
  if (!isAbsolute(values.root || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(values['run-id'] || '')
      || values.thread.some((id) => !THREAD_ID.test(id)) || Number.isNaN(since) || !['codex', 'claude-code'].includes(values.provider)) {
    throw new Error('Expected --root <absolute-path> --run-id <run-id> [--provider codex|claude-code] [--thread <uuid>]... [--since <ISO-8601 UTC>]');
  }
  const report = await (values.provider === 'claude-code' ? measureClaude : measure)(values.thread, since);
  report.provider = values.provider;
  Object.assign(report, countCalls(report));
  const base = 'runtime/e2e/' + values['run-id'] + '/';
  const json = await save(values.root, base + 'telemetry.json', JSON.stringify(report, null, 2) + '\n');
  const summary = await save(values.root, base + 'telemetry.md', markdown(report));
  return { status: report.status, json, summary, threads: report.threads.length };
}

try { process.stdout.write(JSON.stringify(await main()) + '\n'); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
