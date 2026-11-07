import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

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
