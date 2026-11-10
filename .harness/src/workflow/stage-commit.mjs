import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const git = async (root, ...args) => (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
const PROTECTED_PATH = /^(?:\.git|\.io)(?:\/|$)/;

function validPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.startsWith(':')
    && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') && !PROTECTED_PATH.test(path);
}

// Codex sandbox는 어떤 설정으로도 .git 쓰기를 허용하지 않으므로 구현 커밋은 sandbox 밖의 실행기가 맡는다.
export async function commitStageRequest({ root, rawPath }) {
  const envelope = JSON.parse(await readFile(rawPath, 'utf8'));
  const result = envelope.result;
  const request = result?.commit_request;
  if (!request) return null;
  if (typeof request.message !== 'string' || !request.message.trim()) throw new Error('Commit request needs a message');
  if (!Array.isArray(request.paths) || !request.paths.length || !request.paths.every(validPath)) throw new Error('Commit request paths must be workspace-relative source paths');
  await git(root, 'add', '--', ...request.paths);
  const staged = (await git(root, 'diff', '--cached', '--name-only')).split('\n').filter(Boolean);
  const unrequested = staged.filter((path) => !request.paths.some((item) => path === item || path.startsWith(`${item}/`)));
  if (unrequested.length) throw new Error(`Index already holds files outside the commit request: ${unrequested.join(', ')}`);
  if (!staged.length) throw new Error('Commit request has no changes to commit');
  await git(root, 'commit', '-m', request.message);
  result.commit_sha = await git(root, 'rev-parse', 'HEAD');
  await writeFile(rawPath, JSON.stringify(envelope));
  return result.commit_sha;
}

// Specs and plans are the review basis of the implementation, so they are committed when the stage that owns them
// completes; reviewers then read them in the history like the code, and no stage or orchestrator stages them by hand.
// Other staged files are left as they are: the commit names only the stage's own paths.
const WORKFLOW_DOCUMENTS = {
  'spec-me': (id) => [`docs/specs/${id}`, 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/architecture', 'knowledge'],
  'to-ticket': (id) => [`docs/plans/${id}`],
};

export async function commitWorkflowDocuments({ root, input, rawPath }) {
  const owned = WORKFLOW_DOCUMENTS[input?.skill];
  const planSetId = input?.context?.plan_set_id;
  if (!owned || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planSetId || '')) return null;
  const envelope = JSON.parse(await readFile(rawPath, 'utf8'));
  if (envelope.status !== 'completed') return null;
  const paths = owned(planSetId);
  const changed = (await git(root, 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths)).split('\0').filter(Boolean);
  if (!changed.length) return null;
  const present = [];
  for (const path of paths) if (existsSync(join(root, path)) || await git(root, 'ls-files', '--', path)) present.push(path);
  await git(root, 'add', '-A', '--', ...present);
  // A pathspec commit takes only these documents; anything else in the index stays staged for its owner.
  await git(root, 'commit', '-m', `${input.skill}: ${planSetId}`, '--', ...present);
  return git(root, 'rev-parse', 'HEAD');
}
