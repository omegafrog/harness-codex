#!/usr/bin/env node
// PreToolUse hook for Codex and Claude Code: the orchestrator's main session does not write product code, tests or
// contracts itself. Those files belong to the stage that owns them (implement-wrapper, tactical-code, sync-contracts, ...), and
// an orchestrator edit bypasses that stage's review and completion gates.
//
// The rule applies only to the main session of an active workflow worktree (`.io/worktree.json` with state "active"):
//   - stage runners set HARNESS_STAGE_EXECUTION_ID in the environment their hooks inherit, which exempts them from the
//     orchestrator write restriction;
//   - a payload that carries `agent_id` came from a sub-agent. Claude Code documents the field for PreToolUse. Codex does not
//     document it there, but codex-cli 0.167.1 sends `agent_id` and `agent_type` with a sub-agent's PreToolUse (observed), so a
//     Codex build that stops sending it would guard the orchestrator's own sub-agents like the main session;
// While a plan review runs (its attempt is active and its claimed reviewer is live), every session, including stages and
// sub-agents, is denied writes to the files admitted to that review: the snapshot was taken when the reviewer started, and
// an edit now would only make the review stale. The lock releases itself when the reviewer is gone: its SubagentStop was
// recorded, the stage execution that owns the review ended, or it showed no activity for a bounded time (the signals and the
// window are in src/workflow/review-liveness.mjs). A release caused by a vanished reviewer also marks the attempt interrupted
// in the review history, so a later `record` fails and the next `begin` settles it instead of passing it silently.
// The document writer has its own exact-path rule, including under `.io/`. The orchestrator restriction otherwise covers
// only worktree paths and permits session files and the few project documents it records on the user's behalf.
//
// What it can see (payloads observed on codex-cli 0.167.1 and Claude Code): Codex `apply_patch` with the patch text in
// tool_input.command (also when the model reaches it through code mode, where the nested call is hooked as apply_patch/Bash),
// Claude Code Write/Edit with tool_input.file_path (MultiEdit and NotebookEdit's notebook_path are read the same way but were not
// exercised) and, for the Bash tool (tool_input.command), redirections, tee, sed -i, perl -i, cp/mv/install/ln, truncate, dd of=,
// touch and `sh -c` scripts whose target is a literal path. It cannot see what a script, interpreter or tool writes
// (`node x.js`, `python -c`, formatters, `git apply`, `patch`, MCP file tools) or a target built from variables.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Without the liveness module (a partial install) every claimed reviewer counts as live, which keeps the lock as it was.
const liveness = await import('../src/workflow/review-liveness.mjs').catch(() => null);
const documents = await import('../src/workflow/stage-documents.mjs').catch(() => null);

export const FILE_TOOLS = ['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'exec_command', 'shell_command'];
const DOCUMENT_WRITER = 'stage_document_writer';
const WRITER_COMMAND = /^node \.harness\/scripts\/harness-native-stage\.mjs write-documents --execution-id ([A-Za-z0-9][A-Za-z0-9_-]*) --agent-id '([A-Za-z0-9_/-]+)'$/;
const COMPOSITION_PATH = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/document-drafts\/composition\/(workspace|session)\/(.+)$/;
const WRITER_OWNED_PATH = /\/\.io\/runtime\/executions\/[A-Za-z0-9][A-Za-z0-9_-]*\/document-drafts\/(?:composition(?:\/|$)|(?:batch|writer|writer-brief|composed|tool-admission|written|rollback)\.json$)/;
const WRITER_SHELL_READ = /^[ \t]*cat[ \t]+(?:--[ \t]+)?(?:[A-Za-z0-9_./-]+|'[^'\r\n]+'|"[A-Za-z0-9_./ -]+")[ \t]*$/;
// Project documents the orchestrator records itself: user guidance, the execution contract and E2E lessons.
export const ORCHESTRATOR_DOCUMENTS = ['.harness/agents/implementation-guidance.md', '.harness/agents/testing-guidance.md', '.harness/agents/EXEC.md', '.harness/agents/execution.json', 'docs/verification/e2e-lessons.md'];

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

// The workspace whose review history covers a path: the nearest ancestor with `.io/runtime/reviews`.
function reviewRootOf(path) {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.io/runtime/reviews'))) return directory;
    if (dirname(directory) === directory) return null;
  }
}

// Active plan reviews with a claimed reviewer, with the absolute paths of their admitted files. Whether that reviewer is
// still alive is decided per matched review, not here.
function claimedPlanReviews(root) {
  const directory = join(root, '.io/runtime/reviews');
  let names = [];
  try { names = readdirSync(directory).filter((name) => /^plan-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)); } catch { return []; }
  const reviews = [];
  for (const name of names) {
    try {
      const last = JSON.parse(readFileSync(join(directory, name), 'utf8')).attempts?.at(-1);
      if (last?.status !== 'active' || !last.native_review || !last.inputs || typeof last.inputs !== 'object') continue;
      let historyMtimeMs = null;
      try { historyMtimeMs = statSync(join(directory, name)).mtimeMs; } catch { /* the history was just read */ }
      const paths = new Set();
      const draft = last.admission_execution_id ? documents?.documentDraftRoot(root, last.admission_execution_id) : null;
      for (const key of Object.keys(last.inputs)) {
        const logical = key.replace(/#canonical$/, '');
        paths.add(canonical(join(root, logical)));
        if (draft) for (const view of [draft, join(draft, '../deleted'), join(draft, '../composition/workspace')]) paths.add(canonical(join(view, logical)));
      }
      reviews.push({ planSetId: name.slice('plan-'.length, -'.json'.length), attemptId: last.id, attempt: last, historyMtimeMs, paths });
    } catch { /* an unreadable history is not a running review */ }
  }
  return reviews;
}

function reviewMessage(path, root, how, review) {
  return `Harness: ${relative(root, path) || path} is under a running plan review (plan set ${review.planSetId}, attempt ${review.attemptId}) and cannot be written now (${how}). The review snapshot was captured when the reviewer started; an edit would make that review stale. Wait for the reviewer to finish and record it with node .harness/scripts/harness-plan-review.mjs record --plan-set ${review.planSetId} --attempt ${review.attemptId} (or abort it with --reason), then revise the files and begin a new review. The lock releases by itself if the reviewer stops, its stage execution ends, or it shows no activity for ${(liveness?.REVIEWER_STALE_AFTER_MS ?? 30 * 60 * 1000) / 60000} minutes.`;
}

// The lock holds only while the claimed reviewer is live. A reviewer that vanished (stage ended, no activity) releases it and
// is reported in `interrupted` for the hook to mark; a reviewer that stopped normally releases it without a mark.
function reviewLockDecision(targets, { now = Date.now(), interrupted = [] } = {}) {
  const cache = new Map();
  for (const { path, how } of targets) {
    const root = reviewRootOf(path);
    if (!root) continue;
    if (!cache.has(root)) cache.set(root, claimedPlanReviews(root));
    const review = cache.get(root).find((item) => item.paths.has(path));
    if (!review) continue;
    review.liveness ??= liveness ? liveness.reviewerLiveness({ root, attempt: review.attempt, now, historyMtimeMs: review.historyMtimeMs }) : { live: true, state: 'live' };
    if (review.liveness.live) return reviewMessage(path, root, how, review);
    if (liveness.isInterruption(review.liveness) && !interrupted.some((item) => item.root === root && item.attemptId === review.attemptId)) interrupted.push({ root, planSetId: review.planSetId, attemptId: review.attemptId, state: review.liveness.state, detail: review.liveness.detail });
  }
  return null;
}

function message(path, root, how) {
  return `Harness: the orchestrator main session does not write ${relative(root, path) || path} (${how}). Product code, tests, plans, Specs and docs/contracts are written by the stage that owns them. Dispatch that stage with harness-native-stage.mjs launch --stage-id <stage>, then invoke a native subagent instead: implement-wrapper (add --feedback for a fix, including E2E test files), tactical-code for new-feature code, sync-contracts for docs/contracts, requirements-fix or the tactical design stage that owns the document for Specs, to-ticket for plans. Only files under .io/ and the project guidance documents (.harness/agents/implementation-guidance.md, .harness/agents/testing-guidance.md, .harness/agents/EXEC.md, .harness/agents/execution.json, docs/verification/e2e-lessons.md) are written from this session.`;
}

function documentDraftDecision(root, targets, executionId) {
  if (!root || !documents) return null;
  let record, state;
  try {
    record = JSON.parse(readFileSync(join(root, '.io/worktree.json'), 'utf8'));
    if (record.state !== 'active') return null;
    const manifest = join(root, '.io/runtime/orchestrator/workflow.json');
    const document = JSON.parse(readFileSync(existsSync(manifest) ? manifest : join(root, '.io/runtime/orchestrator/state.json'), 'utf8'));
    state = document.state || document;
  } catch { return null; }
  for (const [stageId, stage] of Object.entries(state.stages || {})) {
    if (stage.status !== 'running' || !stage.native_managed || !stage.execution_id || executionId && stage.execution_id !== executionId) continue;
    const draft = documents.documentDraftRoot(root, stage.execution_id);
    if (!existsSync(draft)) continue;
    for (const { path } of targets) {
      if (!inside(root, path)) continue;
      const logical = relative(root, path);
      if (stageId === 'to-ticket' && /^\.io\/runtime\/to-ticket\/drafts\/[^/]+\.md$/.test(logical)) {
        return `Harness: save the Issue brief at ${join(draft, '../session', logical.slice('.io/'.length))}. The assigned document writer will publish the batch after review.`;
      }
      if (inside(join(root, '.io'), path)) continue;
      if (!documents.isStageDocumentTarget(stage.skill || stageId, record.plan_set_id, logical)) continue;
      return `Harness: save this stage's document draft at ${join(draft, logical)}. The bound stage document writer will publish the whole batch at finish.`;
    }
  }
  return null;
}

function toolContext(event) {
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const cwd = typeof event.cwd === 'string' && isAbsolute(event.cwd) ? event.cwd : process.cwd();
  const command = input.command ?? input.cmd;
  const workdir = input.workdir ?? input.cwd;
  const executionCwd = typeof workdir === 'string' ? resolve(cwd, workdir) : cwd;
  return { cwd, executionCwd, command, input };
}

function directWritePaths(tool, input) {
  if (tool === 'apply_patch') return patchFiles(input.command);
  return [input.file_path, input.notebook_path].filter((path) => typeof path === 'string' && path);
}

function writerWorkspace(cwd, workspace) {
  for (let root = canonical(workspace || cwd); ; root = dirname(root)) {
    if (existsSync(join(root, '.io/runtime/executions'))) return root;
    if (dirname(root) === root) throw new Error('No workspace for the stage document writer');
  }
}

async function writerAssignment(root, id, event, env) {
  const batch = await documents.readWriterBatch(root, id);
  const assignment = await documents.readWriterAssignment(root, id);
  if (!assignment || assignment.execution_id !== id || assignment.batch_id !== batch.batch_id
      || typeof assignment.agent_id !== 'string' || event.agent_type !== DOCUMENT_WRITER) {
    throw new Error('This tool call belongs to the bound stage document writer');
  }
  if (batch.binding.provider === 'claude-code') {
    if (event.agent_id !== assignment.agent_id || event.session_id !== assignment.parent_session_id) {
      throw new Error('This tool call belongs to the bound Claude stage document writer');
    }
  } else if (batch.binding.provider === 'codex') {
    const { verifyCodexDocumentWriter } = await import('../src/workflow/native-context.mjs');
    const threadIds = [...new Set([event.agent_id, event.session_id, env.CODEX_THREAD_ID])]
      .filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) && id !== assignment.parent_session_id);
    const expectedPath = assignment.agent_id.startsWith('/') ? assignment.agent_id : `${assignment.parent_agent_path || '/root'}/${assignment.agent_id}`;
    if (![assignment.agent_id, expectedPath, ...threadIds].includes(event.agent_id)) {
      throw new Error('This tool call belongs to the bound Codex stage document writer');
    }
    for (const threadId of threadIds) {
      try {
        await verifyCodexDocumentWriter({ root, assignment, batch, threadId });
        return { batch, assignment };
      } catch { /* The payload can carry a parent session ID as well as a child identity. */ }
    }
    throw new Error('Could not verify the bound Codex stage document writer transcript');
  } else throw new Error('Unsupported stage document writer provider');
  return { batch, assignment };
}

async function writerToolDecision(event, env, options) {
  const tool = event.tool_name;
  const { cwd, executionCwd, command, input } = toolContext(event);
  try {
    if (SHELL_TOOLS.includes(tool)) {
      if (typeof command === 'string' && WRITER_SHELL_READ.test(command)) return {};
      const match = typeof command === 'string' && WRITER_COMMAND.exec(command);
      if (!match || match[0] !== command) throw new Error('Use a direct file tool for the assigned outputs and run the exact supplied write-documents command');
      const [, id, agentId] = match;
      const root = writerWorkspace(cwd, env.HARNESS_WORKSPACE_ROOT);
      if (canonical(executionCwd) !== root) throw new Error('Run the bound write-documents command from its workspace');
      const { batch, assignment } = await writerAssignment(root, id, event, env);
      if (assignment.agent_id !== agentId) throw new Error('The write-documents command must name the bound writer');
      if (batch.binding.provider === 'claude-code') {
        if (tool !== 'Bash' || input.command !== command) throw new Error('Run the bound Claude write-documents command with Bash');
        const proof = await documents.admitClaudeDocumentWriterTool({ root, id, agentId, event });
        return { updatedInput: { ...input, command: `HARNESS_STAGE_WRITER_PROOF='${proof}' ${command}` } };
      }
      return {};
    }

    const root = writerWorkspace(cwd, env.HARNESS_WORKSPACE_ROOT);
    const executionRoot = join(root, '.io/runtime/executions');
    const paths = directWritePaths(tool, input);
    const targets = paths.map((raw) => {
      const path = resolve(cwd, raw);
      const match = COMPOSITION_PATH.exec(relative(executionRoot, path));
      if (!match || raw.split('/').includes('..')) throw new Error(`Only assigned document composition outputs are writable: ${raw}`);
      const [, id, base, logical] = match;
      return { id, base, logical, path, how: tool };
    });
    const id = targets[0]?.id;
    if (!id || targets.some((target) => target.id !== id)) throw new Error('A write must target the assigned document composition batch');
    const { batch } = await writerAssignment(root, id, event, env);
    const { sessionOutputPath } = await import('../src/workflow/session-output.mjs');
    const ref = `runtime/executions/${id}/document-drafts`;
    const outputPath = (name) => sessionOutputPath(root, `${ref}/${name}`, { create: false });
    if (existsSync(outputPath('composed.json'))) throw new Error('The stage document writer batch has already been submitted');
    const brief = JSON.parse(readFileSync(outputPath('writer-brief.json'), 'utf8'));
    if (brief.execution_id !== id || !Array.isArray(brief.files)) throw new Error('Invalid stage document writer brief');
    for (const { base, logical, path } of targets) {
      if (!batch.entries.some((entry) => entry.author === true && entry.base === base && entry.path === logical)
          || !brief.files.some((file) => file.base === base && file.path === logical && file.output === path)
          || outputPath(`composition/${base}/${logical}`) !== path || canonical(path) !== path
          || (existsSync(path) && !lstatSync(path).isFile())) {
        throw new Error(`Only assigned document composition outputs are writable: ${path}`);
      }
    }
    return { reason: reviewLockDecision(targets, options) };
  } catch (error) {
    return { reason: `Harness stage document writer: ${error.message}` };
  }
}

// Returns the deny reason, or null when the call is allowed. `options.now` fixes the clock for the reviewer liveness check and
// `options.interrupted` receives the plan reviews whose lock was released because their reviewer vanished.
export function writeGuardDecision(event, env = process.env, options = {}) {
  if (event?.hook_event_name !== 'PreToolUse') return null;
  const tool = event.tool_name;
  const isFileTool = FILE_TOOLS.includes(tool);
  if (!isFileTool && !SHELL_TOOLS.includes(tool)) return null;
  if (event.agent_type === DOCUMENT_WRITER) return 'Harness: stage document writer calls require provider authorization';
  const { cwd, executionCwd, command, input } = toolContext(event);
  const writes = [];
  if (isFileTool) {
    for (const raw of directWritePaths(tool, input)) writes.push({ raw, cwd, how: tool });
  } else if (typeof command === 'string') {
    writes.push(...shellWrites(command, { cwd: executionCwd }));
    // `apply_patch <<'EOF' ... EOF` run through the shell tool names its files the same way.
    for (const raw of patchFiles(command)) writes.push({ raw, cwd: executionCwd, how: 'apply_patch' });
  }
  const targets = writes.filter(({ raw, cwd: base }) => base || isAbsolute(raw)).map(({ raw, cwd: base, how }) => {
    const resolved = resolveHome(raw, base || cwd);
    return { path: canonical(resolved), resolved, how };
  });
  if (!targets.length) return null;
  const locked = reviewLockDecision(targets, options);
  if (locked) return locked;
  if (targets.some(({ path, resolved }) => WRITER_OWNED_PATH.test(path) || WRITER_OWNED_PATH.test(resolved))) {
    return 'Harness: stage document composition and its metadata are owned by the bound writer and native runner';
  }
  if (env.HARNESS_STAGE_EXECUTION_ID || event.agent_id) {
    let root = canonical(env.HARNESS_WORKSPACE_ROOT || cwd);
    while (!existsSync(join(root, '.io/worktree.json'))) {
      const parent = dirname(root);
      if (parent === root) return null;
      root = parent;
    }
    return documentDraftDecision(root, targets, env.HARNESS_STAGE_EXECUTION_ID);
  }
  const workflows = activeWorkflows(cwd, event.session_id);
  if (!workflows.length) return null;
  for (const { path, how } of targets) {
    const workflow = workflows.find((item) => inside(item.root, path));
    if (!workflow || inside(workflow.session, path)) continue;
    if (ORCHESTRATOR_DOCUMENTS.some((document) => path === join(workflow.root, document))) continue;
    return message(path, workflow.root, how);
  }
  return null;
}

// Best effort: the history judges the reviewer again under its own lock, and a busy or unwritable history is retried by the next
// write that reaches the same lock, so a failure here never blocks or changes the tool call.
export async function markInterruptedReviews(interrupted) {
  if (!interrupted.length) return;
  const { updateReviewAttempt } = await import('../src/workflow/review-attempts.mjs');
  for (const { root, planSetId, attemptId } of interrupted) {
    try { await updateReviewAttempt({ root, scope: `plan-${planSetId}`, action: 'mark-interrupted', attemptId, interruptedBy: 'write-guard' }); } catch { /* retried by the next guarded write */ }
  }
}

export async function runWriteGuardHook() {
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const interrupted = [];
    const event = JSON.parse(text);
    const guardedWriter = event?.hook_event_name === 'PreToolUse' && event.agent_type === DOCUMENT_WRITER
      && (FILE_TOOLS.includes(event.tool_name) || SHELL_TOOLS.includes(event.tool_name));
    const { reason, updatedInput } = guardedWriter
      ? await writerToolDecision(event, process.env, { interrupted })
      : { reason: writeGuardDecision(event, process.env, { interrupted }) };
    if (reason || updatedInput) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...(reason ? { permissionDecision: 'deny', permissionDecisionReason: reason } : { updatedInput }) } })}\n`);
    await markInterruptedReviews(interrupted);
  } catch (error) { process.stderr.write(`${error.message}\n`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { await import('../src/observability/hook-timing.mjs').then((module) => module.startHookTiming('write-guard'), () => null); await runWriteGuardHook(); }
