#!/usr/bin/env node
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillInput, validateSkillReturn } = await import(new URL('skill-execution.mjs', installed));
const { identifyQuestions } = await import(new URL('questions.mjs', installed));
const { cliSession } = await import(new URL('cli-session.mjs', installed));
const { assertWorkspaceTarget } = await import(new URL('../eval/case-workspace.mjs', installed));
const { parseWorktreeRecord, specArtifactPath } = await import(new URL('worktrees.mjs', installed));
const { stageExecutionPaths } = await import(new URL('session-output.mjs', installed));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'return', 'source'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || Boolean(opts.return) === Boolean(opts.source)) throw new Error('Absolute root, execution-id and exactly one of return or source are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Valid execution-id is required');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  if (input.session_directory !== session) throw new Error('Input session directory does not match caller session');
  await validateSkillInput({ root: opts.root, input });
  const paths = stageExecutionPaths(opts.root, input.execution_id);
  if (paths.session !== session) throw new Error('Execution session does not match workspace');
  const prefix = `runtime/executions/${input.execution_id}`;
  const returnPath = paths.refs.returned;
  const sourcePath = opts.source || opts.return;
  if (opts.source && opts.source !== paths.refs.raw) throw new Error('Source must be the raw Codex message for the requested execution');
  if (opts.return && opts.return !== returnPath) throw new Error('Return must belong to the requested execution');
  const envelope = await readSkillSessionJson({ root: opts.root, session_directory: session, path: sourcePath });
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('Structured result is required');
  if (opts.source) envelope.result_ref = envelope.status === 'failed' && envelope.code === 'ARTIFACT_WRITE_FAILED' ? null : paths.refs.result;
  if (envelope.result_ref === null && !(envelope.status === 'failed' && envelope.code === 'ARTIFACT_WRITE_FAILED')) envelope.result_ref = paths.refs.result;
  if (envelope.result_ref) {
    if (envelope.result_ref !== paths.refs.result) throw new Error('Result must belong to the requested execution');
    try { envelope.result = await readSkillSessionJson({ root: opts.root, session_directory: session, path: envelope.result_ref }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (input.skill !== 'workflow-compose' && !Object.hasOwn(envelope.result, 'review_request')) envelope.result.review_request = null;
  if (input.skill === 'spec-me' && input.context?.worktree_ref && Array.isArray(envelope.result.artifacts)) {
    const record = parseWorktreeRecord(await readFile(input.context.worktree_ref, 'utf8'));
    if (await realpath(opts.root) !== await realpath(record.workspace)) throw new Error('Workspace does not match worktree.json');
    const slug = record.plan_set_id?.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, '');
    for (const artifact of envelope.result.artifacts) {
      if (artifact.base !== 'workspace' || typeof artifact.path !== 'string') continue;
      const match = /^docs\/specs\/([^/]+)\/(.+)$/.exec(artifact.path);
      const candidateSlug = match?.[1].replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, '');
      if (match && slug && slug !== record.plan_set_id && candidateSlug === slug) {
        const canonical = specArtifactPath(record.plan_set_id, match[2]);
        if (match[1] !== record.plan_set_id) {
          const exists = await lstat(join(opts.root, artifact.path)).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
          if (!exists) artifact.path = canonical;
        }
      }
    }
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
  if (envelope.result.questions?.length) {
    if (!['USER_DECISION_REQUIRED', 'REVIEW_REQUIRED'].includes(envelope.code)) throw new Error('Questions require a waiting decision or review');
    const withoutId = ({ question_id, ...question }) => question;
    const questions = (envelope.result.questions || []).map(withoutId);
    if (questions.some((question, index) => questions.slice(0, index).some((prior) => isDeepStrictEqual(prior, question)))) throw new Error('Duplicate questions in batch');
    envelope.result.questions = identifyQuestions(input.execution_id, questions);
  }
  if (envelope.result.review_request && (!Object.hasOwn(envelope.result.review_request, 'agent_profile') || Object.hasOwn(envelope.result.review_request, 'role'))) throw new Error('Review requests require agent_profile');
  // The runner, not the model, fingerprints returned artifacts; a model-typed hash can be wrong.
  for (const artifact of Array.isArray(envelope.result.artifacts) ? envelope.result.artifacts : []) {
    if (!artifact || typeof artifact.path !== 'string' || isAbsolute(artifact.path)) continue;
    const base = artifact.base === 'workspace' ? opts.root : artifact.base === 'session' ? session : artifact.base === 'control_session' ? (input.context?.control_session_directory || session) : null;
    if (!base) continue;
    await assertWorkspaceTarget(base, artifact.path);
    const info = await lstat(join(base, artifact.path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isFile() && !info.isSymbolicLink()) artifact.sha256 = createHash('sha256').update(await readFile(join(base, artifact.path))).digest('hex');
    else if (info?.isDirectory()) artifact.sha256 = null;
  }
  await validateSkillReturn({ root: opts.root, input, envelope });
  if (envelope.result_ref) {
    const path = join(session, envelope.result_ref);
    await writeFile(path, JSON.stringify(envelope.result, null, 2) + '\n', { mode: 0o600 });
  }
  await writeFile(join(session, returnPath), JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
