import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sessionDirectory, sessionOutputPath } from '../workflow/session-output.mjs';
import { updateDomainIndexes } from './index.mjs';
import { loadDomainSnapshot } from './search.mjs';
import { assertDomainSyncCurrent } from './sync.mjs';

const DOMAIN_PATHS = ['docs/domain', 'docs/specs', 'CONTEXT.md', 'CONTEXT-MAP.md'];
const DOMAIN_FILE = /^(?:docs\/domain\/.*\.md|docs\/specs\/[^/]+\/(?:requirements\.md|domain-links\.json)|CONTEXT(?:-MAP)?\.md)$/;
const GENERATED = /^docs\/domain\/(?:contexts\/[a-z][a-z0-9-]*\/)?INDEX\.md$/;
const DEFINITION = /^docs\/domain\/(?!stakeholders\/).*\.md$/;
const normalized = (value) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

export async function checkDomainMerge(root, { base, head, reviewed, merged, structuralOnly = false } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd();
  const commit = (ref) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  const baseSha = commit(base), headSha = commit(head || 'HEAD'), ancestor = git('merge-base', baseSha, headSha);
  const result = (status, details = {}) => ({ status, ancestor, base: baseSha, head: headSha, ...details });
  const changed = (from, to) => git('diff', '--name-only', '--no-renames', '-z', from, to, '--', ...DOMAIN_PATHS).split('\0').filter((path) => DOMAIN_FILE.test(path));
  const headChanges = changed(ancestor, headSha), baseChanges = changed(ancestor, baseSha);
  if (reviewed && reviewed.base !== baseSha) return result('STALE_BASE');
  const headDifferences = new Set(changed(baseSha, headSha));
  const overlap = headChanges.filter((path) => baseChanges.includes(path) && !GENERATED.test(path) && headDifferences.has(path));
  const ownerOverlap = overlap.filter((path) => DEFINITION.test(path));
  const reviewMatches = reviewed?.base === baseSha && reviewed?.head === headSha && reviewed?.verdict === 'pass' && typeof reviewed.evidence === 'string' && reviewed.evidence.trim();
  if (ownerOverlap.length && !(merged && reviewMatches)) return result('REVIEW_REQUIRED', { paths: ownerOverlap, reason: 'Both branches changed the same definition; review an integrated commit' });
  const merge = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '-z', baseSha, headSha], { cwd: root, encoding: 'utf8' });
  const [tree, ...rest] = (merge.stdout || '').split('\0');
  if (![0, 1].includes(merge.status) || !/^[a-f0-9]{40,64}$/.test(tree)) throw new Error(merge.stderr || 'Cannot construct the candidate merge tree');
  const conflicts = merge.status === 1 ? rest.slice(0, rest.indexOf('')) : [];
  if (!merged && conflicts.some((path) => !GENERATED.test(path))) return result('STRUCTURAL_CONFLICT', { paths: conflicts });
  const candidate = merged ? commit(merged) : tree;
  if (merged && ![baseSha, headSha].every((sha) => spawnSync('git', ['merge-base', '--is-ancestor', sha, candidate], { cwd: root }).status === 0)) return result('STALE_BASE');
  sessionOutputPath(root, 'tmp/domain-merge');
  const temp = await mkdtemp(join(sessionDirectory(root), 'tmp/domain-merge-'));
  try {
    const paths = [];
    for (const record of git('ls-tree', '-rz', candidate, '--', ...DOMAIN_PATHS).split('\0').filter(Boolean)) {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
      if (!match || !DOMAIN_FILE.test(match[3]) || conflicts.includes(match[3]) && !merged) continue;
      const [, mode, hash, path] = match;
      if (!/^100(?:644|755)$/.test(mode) || path.split('/').some((part) => !part || part === '..' || part === '.')) return result('STRUCTURAL_CONFLICT', { paths: [path] });
      await mkdir(dirname(join(temp, path)), { recursive: true });
      await writeFile(join(temp, path), execFileSync('git', ['cat-file', 'blob', hash], { cwd: root }));
      paths.push(path);
    }
    const snapshot = await loadDomainSnapshot(temp);
    const names = new Map();
    for (const { metadata, path } of snapshot.documents) {
      if (metadata.status === 'retired' || metadata.kind === 'stakeholder') continue;
      const key = JSON.stringify([metadata.owner_context, metadata.kind, normalized(metadata.name)]);
      if (names.has(key)) return result('SEMANTIC_CONFLICT', { paths: [names.get(key), path], reason: 'Duplicate active name within its owner and kind' });
      names.set(key, path);
    }
    if (conflicts.length && !merged) {
      await updateDomainIndexes(temp, snapshot);
      return result('STRUCTURAL_CONFLICT', { paths: conflicts, reason: 'Resolve generated index conflicts by regenerating indexes on the merged definitions' });
    }
    await updateDomainIndexes(temp, snapshot, { check: true });
    for (const path of paths.filter((path) => path.endsWith('/domain-links.json'))) await assertDomainSyncCurrent(temp, path.split('/')[2]);
    const altered = headChanges.filter((path) => DEFINITION.test(path) && !GENERATED.test(path));
    if (!structuralOnly && altered.length && !reviewMatches) {
      return result('REVIEW_REQUIRED', { paths: altered, reason: 'Review the meaning and downstream references for the exact base and head' });
    }
    return result('PASS');
  } catch (error) {
    return result(/unknown Context ID|owner_context/.test(error.message) ? 'OWNERSHIP_CONFLICT' : 'STRUCTURAL_CONFLICT', { reason: error.message });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
