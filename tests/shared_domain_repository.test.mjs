import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { readDomainRepository, writeDomainDocument } from '../.harness/src/domain/repository.mjs';
import { parseDomainDocument, formatDomainDocument } from '../.harness/src/domain/schema.mjs';
import { validateDomainRepository } from '../.harness/src/domain/validation.mjs';

const metadata = {
  schema_version: 1, id: 'order.rule.cancel-eligibility', kind: 'rule', owner_context: 'order',
  name: '주문 취소 조건', statement: '출고 전 취소할 수 있다', condition: '출고 전',
  violation_result: '취소 거부', status: 'accepted-target', aliases: ['취소 조건'],
  source_refs: ['docs/specs/order/requirements.md#BIZ-01'], references: [],
};
const body = '\n# 취소 조건\r\n\r\n근거와 설명.\n';
const contextMap = '| Bounded Context | Context ID | 책임 |\n|---|---|---|\n| 주문 관리 | `order` | 주문 상태 |\n';

test('domain frontmatter is strict and preserves original Markdown body', () => {
  const source = formatDomainDocument({ metadata, body });
  assert.equal(parseDomainDocument(source).body, body);
  assert.throws(() => parseDomainDocument(source.replace('---\n', '---\nname: "duplicate"\n')), /duplicate/);
  assert.throws(() => formatDomainDocument({ metadata: { ...metadata, owner_context: '../outside' }, body }), /owner_context/);
  assert.throws(() => formatDomainDocument({ metadata: { ...metadata, status: 'implemented' }, body }), /implementation_refs/);
});

test('installed repository round trips definitions, validates references and preserves project Git visibility', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-shared-domain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('git', ['init', '-q']);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const cli = () => JSON.parse(run(process.execPath, ['.codex/scripts/harness-domain.mjs', 'validate']));
  assert.deepEqual(cli(), { valid: true, definitions: 0, contexts: 0 });
  await writeFile(join(root, 'CONTEXT-MAP.md'), contextMap);
  const path = await writeDomainDocument(root, { metadata, body });
  const gitStatus = () => run('git', ['status', '--short', '--untracked-files=all']);
  const before = gitStatus();
  assert.ok(before.includes(path));
  assert.ok(before.includes('CONTEXT-MAP.md'));
  run('git', ['check-ignore', '-v', '.codex/scripts/harness-domain.mjs', '.harness/src/domain/repository.mjs']);
  const managedCli = '.codex/scripts/harness-domain.mjs';
  await rm(join(root, managedCli));
  assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path === join(root, managedCli)));
  await updateProject({ sourceRoot, targetRoot: root });
  assert.deepEqual(cli(), { valid: true, definitions: 1, contexts: 1 });
  assert.equal(gitStatus(), before);
  assert.equal(await readFile(join(root, 'CONTEXT-MAP.md'), 'utf8'), contextMap);
  assert.equal((await readDomainRepository(root))[0].body, body);
  const domain = (...args) => JSON.parse(run(process.execPath, ['.codex/scripts/harness-domain.mjs', ...args]));
  const exact = domain('search', '취소 조건').candidates[0];
  assert.equal(exact.id, metadata.id);
  assert.ok(exact.evidence.includes('name_or_alias'));
  const expanded = domain('discover', '주문취소', '--context', 'another');
  assert.equal(expanded.expanded, true);
  assert.deepEqual(expanded.contexts, ['order']);
  assert.equal(domain('get', metadata.id).definitions[0].body, body);
  await writeFile(join(root, '.io/cases.json'), JSON.stringify([{ query: '취소 조건', expected: [metadata.id] }]));
  const measured = domain('benchmark', '.io/cases.json');
  assert.equal(measured.recall_at_5, 1);
  assert.equal(measured.cases[0].discover_calls + measured.cases[0].batch_get_calls, 2);

  assert.equal(domain('index').paths.length, 2);
  assert.deepEqual(domain('index', '--check').paths, domain('index').paths);
  const { prepareDomainContextPack } = await import(`file://${join(root, '.harness/src/domain/context-pack.mjs')}`);
  const request = { root, stage: 'requirements-fix', request: '주문 취소' };
  const firstPack = await prepareDomainContextPack(request);
  assert.deepEqual(await prepareDomainContextPack(request), firstPack);
  await writeDomainDocument(root, { metadata: { ...metadata, statement: '결제 완료 전에 주문을 취소한다' }, body });
  assert.notEqual((await prepareDomainContextPack(request)).path, firstPack.path);
  const indexPath = 'docs/domain/contexts/order/INDEX.md';
  assert.ok(gitStatus().includes(indexPath));
  await rm(join(root, indexPath));
  assert.throws(() => domain('index', '--check'), /out of date/);
  domain('index');
  assert.doesNotMatch(gitStatus(), /\.io\/|\.codex\/|\.harness\/(?!agents\/)/);

  assert.ok(!(await runDoctor({ root, sourceRoot })).diagnostics.some(({ code }) => code === 'execution_asset_missing'));
  await writeDomainDocument(root, { metadata: { ...metadata, references: ['order.event.unknown'] }, body });
  await assert.rejects(validateDomainRepository(root), /unknown reference order.event.unknown/);
  await writeFile(join(root, 'CONTEXT-MAP.md'), contextMap.replace('`order`', '`shipping`'));
  await assert.rejects(validateDomainRepository(root), /unknown Context ID order/);
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'docs/domain/actors'));
  await assert.rejects(readDomainRepository(root), /Unsafe domain path/);
});

test('sync rejects stale plans and rolls back every file on a failed commit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-domain-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { planDomainSync, applyDomainSync } = await import('../.harness/src/domain/sync.mjs');
  const { bootstrapDomainReport } = await import('../.harness/src/domain/bootstrap.mjs');
  const requirements = join(root, 'docs/specs/orders/requirements.md');
  await mkdir(join(root, 'docs/specs/orders'), { recursive: true });
  const fixed = '# 요구사항 명세\n- 상태: fixed\n- INV-01 주문 취소 조건\n';
  await writeFile(requirements, fixed);
  await writeFile(join(root, 'CONTEXT-MAP.md'), contextMap);
  const report = await bootstrapDomainReport(root);
  assert.equal(report.candidates[0].evidence, 'docs/specs/orders/requirements.md:3');
  assert.equal(report.candidates[0].needs_review, true);
  const proposal = { schema_version: 1, links: { 'INV-01': metadata.id },
    changes: [{ operation: 'create', id: metadata.id, reason: '확정된 요구사항', document: { metadata, body } }] };
  const plan = await planDomainSync(root, 'orders', proposal);
  await writeFile(requirements, fixed + '\n추가 설명\n');
  await assert.rejects(applyDomainSync(root, plan), /stale/);
  assert.equal((await readDomainRepository(root)).length, 0);
  await writeFile(requirements, fixed);
  await assert.rejects(applyDomainSync(root, plan, { commit: () => { throw new Error('commit rejected'); } }), /commit rejected/);
  assert.equal((await readDomainRepository(root)).length, 0);
  await assert.rejects(readFile(join(root, 'docs/specs/orders/domain-links.json')), { code: 'ENOENT' });
  assert.equal((await applyDomainSync(root, plan)).length, 4);
  assert.equal((await validateDomainRepository(root)).definitions, 1);
});

test('three-way domain validation distinguishes independent changes, semantic duplicates and stale review', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-domain-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { checkDomainMerge } = await import('../.harness/src/domain/merge-check.mjs');
  const { updateDomainIndexes } = await import('../.harness/src/domain/index.mjs');
  const { loadDomainSnapshot } = await import('../.harness/src/domain/search.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const save = (message) => { git('add', '--', 'CONTEXT-MAP.md', 'docs'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Harness tests');
  git('config', 'user.email', 'harness@example.test');
  git('config', 'user.signingkey', '');
  git('config', 'commit.gpgSign', 'false');
  await writeFile(join(root, 'CONTEXT-MAP.md'), contextMap);
  const left = { ...metadata, id: 'order.rule.cancel-left', name: '왼쪽 규칙' };
  const right = { ...metadata, id: 'order.rule.cancel-right', name: '오른쪽 규칙' };
  await writeDomainDocument(root, { metadata: left, body });
  await writeDomainDocument(root, { metadata: right, body });
  await updateDomainIndexes(root, await loadDomainSnapshot(root));
  const initial = save('initial domain');
  git('switch', '-qc', 'feature');
  await writeDomainDocument(root, { metadata: { ...left, statement: '왼쪽 규칙 변경' }, body });
  const head = save('feature edits left');
  git('switch', '-q', 'main');
  await writeDomainDocument(root, { metadata: { ...right, statement: '오른쪽 규칙 변경' }, body });
  const base = save('main edits right');
  assert.equal((await checkDomainMerge(root, { base, head })).status, 'REVIEW_REQUIRED');
  assert.equal((await checkDomainMerge(root, { base, head, reviewed: { base, head, verdict: 'pass', evidence: '독립 검토' } })).status, 'PASS');
  assert.equal((await checkDomainMerge(root, { base, head, reviewed: { base: initial, head } })).status, 'STALE_BASE');
  await writeDomainDocument(root, { metadata: { ...right, name: left.name }, body });
  await updateDomainIndexes(root, await loadDomainSnapshot(root));
  const conflictingBase = save('duplicate definition name');
  assert.equal((await checkDomainMerge(root, { base: conflictingBase, head })).status, 'SEMANTIC_CONFLICT');
});
