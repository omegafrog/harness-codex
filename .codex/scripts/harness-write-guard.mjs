#!/usr/bin/env node
// PreToolUse hook for Codex and Claude Code: the orchestrator's main session does not write product code, tests or
// contracts itself. Those files belong to the stage that owns them (implement-wrapper, sync-contracts, spec-me, ...), and
// an orchestrator edit bypasses that stage's review and completion gates.
//
// The rule applies only to the main session of an active workflow worktree (`.io/worktree.json` with state "active"):
//   - stage runners set HARNESS_SKILL_EXECUTION_ID in the environment their hooks inherit, so a stage and the sub-agents it
//     starts are never guarded;
//   - a payload that carries `agent_id` came from a sub-agent. Claude Code documents the field for PreToolUse. Codex does not
//     document it there, but codex-cli 0.167.1 sends `agent_id` and `agent_type` with a sub-agent's PreToolUse (observed), so a
//     Codex build that stops sending it would guard the orchestrator's own sub-agents like the main session;
// Only paths inside the worktree are guarded. `.io/**` (session and runtime files) and the few project documents the
// orchestrator records on the user's behalf stay writable.
//
// What it can see (payloads observed on codex-cli 0.167.1 and Claude Code): Codex `apply_patch` with the patch text in
// tool_input.command (also when the model reaches it through code mode, where the nested call is hooked as apply_patch/Bash),
// Claude Code Write/Edit with tool_input.file_path (MultiEdit and NotebookEdit's notebook_path are read the same way but were not
// exercised) and, for the Bash tool (tool_input.command), redirections, tee, sed -i, perl -i, cp/mv/install/ln, truncate, dd of=,
// touch and `sh -c` scripts whose target is a literal path. It cannot see what a script, interpreter or tool writes
// (`node x.js`, `python -c`, formatters, `git apply`, `patch`, MCP file tools) or a target built from variables.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FILE_TOOLS = ['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Project documents the orchestrator records itself: user guidance, the execution contract and E2E lessons.
export const ORCHESTRATOR_DOCUMENTS = ['docs/agents/implementation-guidance.md', 'docs/agents/testing-guidance.md', 'docs/agents/EXEC.md', 'docs/agents/execution.json', 'docs/verification/e2e-lessons.md'];

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'builtin', 'time', 'nohup', 'nice', 'env', 'stdbuf']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const CONTROL = new Set([';', '&&', '||', '|', '|&', '&', '(', ')', '\n']);
const REDIRECT_OUT = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const REDIRECT_IN = new Set(['<', '<<', '<<<', '<<-', '<&']);

// ---- shell command text -------------------------------------------------------------------------------------------

// Splits a shell script into word and operator tokens. A word is literal unless it contains an expansion ($, backtick).
function tokenize(script) {
  const tokens = [], heredocs = [];
  let word = null, i = 0;
  const flush = () => { if (word) { tokens.push({ type: 'word', ...word }); word = null; } };
  const append = (text, literal = true) => { word ??= { text: '', literal: true, digits: true }; word.text += text; word.literal &&= literal; };
  const skipBalanced = (open, close) => {
    let depth = 0;
    for (; i < script.length; i++) {
      if (script[i] === open) depth++;
      else if (script[i] === close && --depth === 0) { i++; return; }
    }
  };
  while (i < script.length) {
    const c = script[i];
    if (c === '\\') { if (script[i + 1] === '\n') { i += 2; continue; } append(script[i + 1] ?? ''); i += 2; continue; }
    if (c === "'") { const end = script.indexOf("'", i + 1); append(end < 0 ? script.slice(i + 1) : script.slice(i + 1, end)); word.digits = false; i = end < 0 ? script.length : end + 1; continue; }
    if (c === '"') {
      i++; append('');
      while (i < script.length && script[i] !== '"') {
        if (script[i] === '\\' && i + 1 < script.length) { append(script[i + 1]); i += 2; }
        else if (script[i] === '$' || script[i] === '`') { word.literal = false; if (script[i] === '`') { const end = script.indexOf('`', i + 1); i = end < 0 ? script.length : end + 1; } else { append('$', false); i++; if (script[i] === '(') skipBalanced('(', ')'); else if (script[i] === '{') skipBalanced('{', '}'); } }
        else { append(script[i]); i++; }
      }
      word.digits = false; i++; continue;
    }
    if (c === '$') {
      append('$', false); word.digits = false; i++;
      if (script[i] === '(') skipBalanced('(', ')'); else if (script[i] === '{') skipBalanced('{', '}');
      continue;
    }
    if (c === '`') { append('`', false); word.digits = false; const end = script.indexOf('`', i + 1); i = end < 0 ? script.length : end + 1; continue; }
    if (c === '\n') {
      flush(); tokens.push({ type: 'op', text: '\n' }); i++;
      // The body of a here-document is data, not commands.
      for (const heredoc of heredocs.splice(0)) {
        while (i < script.length) {
          const end = script.indexOf('\n', i), line = script.slice(i, end < 0 ? script.length : end);
          i = end < 0 ? script.length : end + 1;
          if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '#' && !word) { while (i < script.length && script[i] !== '\n') i++; continue; }
    const redirect = /^(&>>|&>|>>|>\||>&|<>|<<<|<<-|<<|<&|>|<)/.exec(script.slice(i));
    if (redirect) {
      // `2>file`: digits right before the operator name a file descriptor, not an argument.
      if (word?.digits && word.text) word = null; else flush();
      tokens.push({ type: 'op', text: redirect[1] });
      i += redirect[1].length;
      if (redirect[1] === '<<' || redirect[1] === '<<-') {
        const next = /^[ \t]*(['"]?)([^\s'"]+)\1/.exec(script.slice(i));
        if (next) heredocs.push({ delimiter: next[2], strip: redirect[1] === '<<-' });
      }
      continue;
    }
    const control = /^(&&|\|\||\|&|[;|&()])/.exec(script.slice(i));
    if (control) { flush(); tokens.push({ type: 'op', text: control[1] }); i += control[1].length; continue; }
    append(c, true); if (!/[0-9]/.test(c)) word.digits = false; i++;
  }
  flush();
  return tokens;
}

function commandsOf(tokens) {
  const commands = [];
  let current = { words: [], redirects: [] };
  const end = () => { if (current.words.length || current.redirects.length) commands.push(current); current = { words: [], redirects: [] }; };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'op' && CONTROL.has(token.text)) { end(); continue; }
    if (token.type === 'op') {
      const target = tokens[index + 1]?.type === 'word' ? tokens[++index] : null;
      if (!target) continue;
      if (REDIRECT_OUT.has(token.text)) current.redirects.push(target);
      // `>&2`, `>&-`: file descriptor duplication, not a file. `>&file` is the bash spelling of `&>file`.
      else if (token.text === '>&' && !/^(\d+|-)$/.test(target.text)) current.redirects.push(target);
      else if (!REDIRECT_IN.has(token.text) && token.text !== '>&') continue;
      continue;
    }
    current.words.push(token);
  }
  end();
  return commands;
}

const isOption = (word) => /^-./.test(word.text);

// The words of one simple command that name files it writes, after stripping env assignments and wrappers.
function writtenOperands(words) {
  let rest = words.slice();
  while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].text)) rest.shift();
  while (rest.length && WRAPPERS.has(rest[0].text.split('/').pop())) {
    rest.shift();
    while (rest.length && (isOption(rest[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].text))) rest.shift();
  }
  if (!rest.length) return { name: null, files: [] };
  const name = rest[0].text.split('/').pop(), args = rest.slice(1);
  const operands = args.filter((word) => !isOption(word));
  switch (name) {
    case 'tee': return { name, files: operands };
    case 'touch': return { name, files: operands };
    case 'mv': return { name, files: operands };
    case 'cp': case 'install': case 'ln': {
      const directory = args.findIndex((word) => word.text === '-t' || word.text === '--target-directory');
      return { name, files: directory >= 0 && args[directory + 1] ? [args[directory + 1]] : operands.slice(-1) };
    }
    case 'sed': {
      const inPlace = args.some((word) => word.text === '--in-place' || word.text.startsWith('--in-place=') || /^-[A-Za-z]*i/.test(word.text) && !word.text.startsWith('--'));
      if (!inPlace) return { name, files: [] };
      const scripted = args.some((word) => word.text === '-e' || word.text === '-f' || /^-[A-Za-z]*[ef]$/.test(word.text));
      const skipped = new Set(args.flatMap((word, index) => (word.text === '-e' || word.text === '-f') && args[index + 1] ? [args[index + 1]] : []));
      const files = operands.filter((word) => !skipped.has(word));
      return { name, files: scripted ? files : files.slice(1) };
    }
    case 'perl': {
      const inPlace = args.some((word) => /^-[A-Za-z]*i/.test(word.text));
      if (!inPlace) return { name, files: [] };
      const skipped = new Set(args.flatMap((word, index) => /^-[A-Za-z]*[eE]$/.test(word.text) && args[index + 1] ? [args[index + 1]] : []));
      return { name, files: operands.filter((word) => !skipped.has(word)) };
    }
    case 'truncate': {
      const skipped = new Set(args.flatMap((word, index) => (word.text === '-s' || word.text === '-r') && args[index + 1] ? [args[index + 1]] : []));
      return { name, files: operands.filter((word) => !skipped.has(word)) };
    }
    case 'dd': return { name, files: args.filter((word) => word.text.startsWith('of=')).map((word) => ({ ...word, text: word.text.slice(3) })) };
    default: return { name, files: [], script: SHELLS.has(name) ? shellScript(args) : null, args };
  }
}

// `sh -c 'script'`, `bash -lc "script"`: the script is parsed as commands in turn.
function shellScript(args) {
  for (let index = 0; index < args.length; index++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[index].text) && args[index + 1]) return args[index + 1].literal ? args[index + 1].text : null;
  }
  return null;
}

// Every file a shell command writes that can be read from its text, as { raw, cwd } with the directory it was written
// from (`cd dir && ...` is followed when dir is a literal).
export function shellWrites(command, { cwd, depth = 0 } = {}) {
  const writes = [];
  let here = cwd;
  for (const { words, redirects } of commandsOf(tokenize(String(command)))) {
    for (const target of redirects) if (target.literal) writes.push({ raw: target.text, cwd: here, how: 'redirection' });
    const { name, files, script } = writtenOperands(words);
    if (name === 'cd' || name === 'pushd') {
      const target = words.find((word, index) => index > 0 && !isOption(word));
      here = !target ? homedir() : target.literal && target.text !== '-' && here ? resolveHome(target.text, here) : null;
      continue;
    }
    for (const file of files) if (file.literal) writes.push({ raw: file.text, cwd: here, how: name });
    if (script && depth < 3) writes.push(...shellWrites(script, { cwd: here, depth: depth + 1 }));
  }
  return writes;
}

const resolveHome = (path, cwd) => resolve(cwd, path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

// ---- patches -------------------------------------------------------------------------------------------------------

// The files named by an apply_patch document (also when it travels inside a shell here-document).
export function patchFiles(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line);
    return match ? [match[1]] : [];
  });
}

// ---- decision ------------------------------------------------------------------------------------------------------

// Real path of the nearest existing ancestor plus the rest, so a symlink cannot hide a path inside the worktree.
function canonical(path) {
  const rest = [];
  let current = resolve(path);
  for (;;) {
    try { return join(realpathSync(current), ...rest.reverse()); }
    catch { const parent = dirname(current); if (parent === current) return resolve(path); rest.push(current.slice(parent.length + 1)); current = parent; }
  }
}

function activeWorkflows(cwd, sessionId) {
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return []; }
  let roots = [root];
  try { roots = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9)); } catch { /* keep local guard */ }
  const workflows = [];
  let ownsWorkflow = false;
  for (const workspace of roots) {
    try {
      const record = JSON.parse(readFileSync(join(workspace, '.io/worktree.json'), 'utf8'));
      if (record.state !== 'active') continue;
      const real = realpathSync(workspace);
      workflows.push({ root: real, session: join(real, '.io') });
      if (sessionId && record.agent_sessions?.orchestrator?.session_id === sessionId) ownsWorkflow = true;
    } catch { /* no managed workflow in this checkout */ }
  }
  if (ownsWorkflow && !workflows.some((item) => item.root === realpathSync(root))) workflows.push({ root: realpathSync(root), session: join(realpathSync(root), '.io') });
  return workflows;
}

const inside = (directory, path) => { const rel = relative(directory, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

function message(path, root, how) {
  return `Harness: the orchestrator main session does not write ${relative(root, path) || path} (${how}). Product code, tests, plans, Specs and docs/contracts are written by the stage that owns them. Dispatch that stage with harness-prepare-input.mjs and harness-agent-run.mjs --background true instead: implement-wrapper (add --feedback for a fix, including E2E test files), sync-contracts for docs/contracts, spec-me for Specs, to-ticket for plans. Only files under .io/ and the project guidance documents (docs/agents/implementation-guidance.md, docs/agents/testing-guidance.md, docs/agents/EXEC.md, docs/agents/execution.json, docs/verification/e2e-lessons.md) are written from this session.`;
}

// Returns the deny reason, or null when the call is allowed.
export function writeGuardDecision(event, env = process.env) {
  if (event?.hook_event_name !== 'PreToolUse' || env.HARNESS_SKILL_EXECUTION_ID || event.agent_id) return null;
  const tool = event.tool_name, input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const isFileTool = FILE_TOOLS.includes(tool);
  if (!isFileTool && !['Bash', 'exec_command', 'shell_command'].includes(tool)) return null;
  const cwd = typeof event.cwd === 'string' && isAbsolute(event.cwd) ? event.cwd : process.cwd();
  const workflows = activeWorkflows(cwd, event.session_id);
  if (!workflows.length) return null;
  const executionCwd = typeof (input.workdir ?? input.cwd) === 'string' ? resolve(cwd, input.workdir ?? input.cwd) : cwd;
  const writes = [];
  if (tool === 'apply_patch') {
    for (const raw of patchFiles(input.command)) writes.push({ raw, cwd, how: 'apply_patch' });
  } else if (isFileTool) {
    for (const raw of [input.file_path, input.notebook_path]) if (typeof raw === 'string' && raw) writes.push({ raw, cwd, how: tool });
  } else if (typeof (input.command ?? input.cmd) === 'string') {
    const command = input.command ?? input.cmd;
    writes.push(...shellWrites(command, { cwd: executionCwd }));
    // `apply_patch <<'EOF' ... EOF` run through the shell tool names its files the same way.
    for (const raw of patchFiles(command)) writes.push({ raw, cwd: executionCwd, how: 'apply_patch' });
  }
  for (const { raw, cwd: base, how } of writes) {
    if (!base && !isAbsolute(raw)) continue;
    const path = canonical(resolveHome(raw, base || cwd));
    const workflow = workflows.find((item) => inside(item.root, path));
    if (!workflow || inside(workflow.session, path)) continue;
    if (ORCHESTRATOR_DOCUMENTS.some((document) => path === join(workflow.root, document))) continue;
    return message(path, workflow.root, how);
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const reason = writeGuardDecision(JSON.parse(text));
    if (reason) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); }
}
