#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillInput, validateSkillReturn } = await import(new URL('skill-execution.mjs', installed));
const { identifyQuestions } = await import(new URL('questions.mjs', installed));
const { cliSession } = await import(new URL('cli-session.mjs', installed));
const { assertWorkspaceTarget } = await import(new URL('../eval/case-workspace.mjs', installed));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'return'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !opts.return) throw new Error('Absolute root, execution-id and return are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Valid execution-id is required');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  if (input.session_directory !== session) throw new Error('Input session directory does not match caller session');
  await validateSkillInput({ root: opts.root, input });
  const envelope = await readSkillSessionJson({ root: opts.root, session_directory: session, path: opts.return });
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('Structured result is required');
  const prefix = `runtime/executions/${input.execution_id}`;
  if (opts.return !== `${prefix}/return.json`) throw new Error('Return must belong to the requested execution');
  if (envelope.result_ref === null && !(envelope.status === 'failed' && envelope.code === 'ARTIFACT_WRITE_FAILED')) envelope.result_ref = `${prefix}/result.json`;
  if (envelope.result_ref) {
    if (envelope.result_ref !== `${prefix}/result.json`) throw new Error('Result must belong to the requested execution');
    try { envelope.result = await readSkillSessionJson({ root: opts.root, session_directory: session, path: envelope.result_ref }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (Object.hasOwn(envelope.result, 'artifact_contents')) {
    const profile = input.context?.agent_profile || input.context?.role;
    if (!profile || !/^sandbox_mode\s*=\s*"read-only"\s*$/m.test(await readFile(join(opts.root, '.codex/agents', `${profile}.toml`), 'utf8'))) throw new Error('Inline artifacts require a read-only agent profile');
    const items = envelope.result.artifact_contents;
    if (!Array.isArray(items) || items.length > 32) throw new Error('Invalid inline artifacts');
    const names = new Set();
    for (const item of items) {
      if (!item || Object.keys(item).sort().join(',') !== 'content,kind,name' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name || '') || item.name === '.' || item.name === '..' || names.has(item.name) || typeof item.kind !== 'string' || !item.kind.trim() || typeof item.content !== 'string' || Buffer.byteLength(item.content) > 1024 * 1024) throw new Error('Invalid inline artifact');
      names.add(item.name);
    }
    for (const item of items) {
      const relative = `${prefix}/artifacts/${item.name}`;
      await assertWorkspaceTarget(session, relative);
      await mkdir(join(session, prefix, 'artifacts'), { recursive: true, mode: 0o700 });
      await assertWorkspaceTarget(session, relative);
      await writeFile(join(session, relative), item.content, { flag: 'wx', mode: 0o600 });
      envelope.result.artifacts.push({ base: 'session', path: relative, kind: item.kind, sha256: null });
    }
    delete envelope.result.artifact_contents;
  }
  if (envelope.result.question || envelope.result.questions?.length) {
    if (!['USER_DECISION_REQUIRED', 'REVIEW_REQUIRED'].includes(envelope.code)) throw new Error('Questions require a waiting decision or review');
    const withoutId = ({ question_id, ...question }) => question;
    const questions = (envelope.result.questions || []).map(withoutId);
    if (questions.some((question, index) => questions.slice(0, index).some((prior) => isDeepStrictEqual(prior, question)))) throw new Error('Duplicate questions in batch');
    if (envelope.result.question) {
      const single = withoutId(envelope.result.question);
      if (questions.length && !questions.some((question) => isDeepStrictEqual(question, single))) throw new Error('Single question conflicts with question batch');
      if (!questions.length) questions.push(single);
    }
    envelope.result.questions = identifyQuestions(input.execution_id, questions);
    envelope.result.question = null;
  }
  if (envelope.result.review_request && (!Object.hasOwn(envelope.result.review_request, 'agent_profile') || Object.hasOwn(envelope.result.review_request, 'role'))) throw new Error('Review requests require agent_profile');
  await validateSkillReturn({ root: opts.root, input, envelope });
  if (envelope.result_ref) {
    const path = join(session, envelope.result_ref);
    await writeFile(path, JSON.stringify(envelope.result, null, 2) + '\n', { mode: 0o600 });
  }
  await writeFile(join(session, opts.return), JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
