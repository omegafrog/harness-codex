import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { validateSpecContent } from '../.harness/src/workflow/spec-writer.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const productHeadings = ['문제와 맥락', '목표와 기대 효과', '사용자와 행위자', '유비쿼터스 언어와 용어', '핵심 유스케이스', '업무 규칙과 불변 조건', '상태와 상태 전이', '실패 예외 및 경계 조건', '입력과 출력', '범위와 비목표', '우선순위와 트레이드오프', '성공 조건과 수용 기준'];
const architectureHeadings = ['설계 범위와 현재 모델', 'Domain', 'Aggregate', 'Application Service', 'Bounded Context', 'Technical Architecture', 'Runtime Design', 'Error Handling and Recovery', 'Security', 'Observability', 'Change Boundaries', 'Verification Requirements', 'Alternatives and Trade-offs', 'Risks and Open Questions'];
const contentFor = (axis) => (axis === 'product' ? productHeadings : architectureHeadings).map((heading, i) => `## ${i + 1}. ${heading}\n\n결정된 내용입니다.\n`).join('\n');

test('writer output rejects missing, empty and incorrectly ordered required sections', () => {
  assert.equal(validateSpecContent(contentFor('product'), 'product'), true);
  assert.equal(validateSpecContent(contentFor('architecture'), 'architecture'), true);
  assert.throws(() => validateSpecContent(contentFor('product').replace('## 7. 상태와 상태 전이', '## 다른 제목'), 'product'), /missing an ordered section/);
  assert.throws(() => validateSpecContent(contentFor('architecture').replace('## 3. Aggregate\n\n결정된 내용입니다.', '## 3. Aggregate\n'), 'architecture'), /section has no content/);
  const swapped = [architectureHeadings[0], architectureHeadings[2], architectureHeadings[1], ...architectureHeadings.slice(3)].map((heading) => `## ${heading}\n\n내용\n`).join('\n');
  assert.throws(() => validateSpecContent(swapped, 'architecture'), /missing an ordered section/);
});

async function fixture(provider) {
  const parent = await mkdtemp(join(tmpdir(), 'spec-writer-'));
  const primary = join(parent, 'project'), root = join(parent, 'worktree'), bin = join(parent, 'bin');
  await mkdir(primary); await mkdir(bin);
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  git(primary, 'init', '-q');
  await writeFile(join(primary, 'app.txt'), 'project-owned\n');
  git(primary, 'add', 'app.txt'); git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'init');
  git(primary, 'worktree', 'add', '-qb', 'spec-test', root);
  await protectLocalInstallArtifacts(root, source);
  await updateProject({ sourceRoot: source, targetRoot: root, initialize: true });
  await updateProject({ sourceRoot: source, targetRoot: root });
  await writeFile(join(root, '.codex/harness.yaml'), `agents:\n  provider: ${provider}\n  low_performance_model: test-writer\n  low_performance_reasoning_effort: low\n`);
  const session = join(root, '.io'); await mkdir(session, { recursive: true });
  const common = await realpath(join(primary, '.git'));
  const worktreeRef = join(session, 'worktree.json');
  await writeFile(worktreeRef, JSON.stringify({ schema_version: 1, worktree_id: 'a77aaa03-329c-4d59-b4c5-269746a893f2', workspace: root, common, return_root: primary, session_directory: session, branch: 'spec-test', state: 'active', plan_set_id: 'example' }));
  const specDir = join(root, 'docs/specs/example'); await mkdir(specDir, { recursive: true });
  await writeFile(join(specDir, 'request.md'), '사용자 승인 요구사항\n');
  const fake = `#!/usr/bin/env node\nconst fs=require('fs'); const args=process.argv.slice(2); let input=''; process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>{fs.appendFileSync(process.env.WRITER_CALLS,JSON.stringify({args,input})+'\\n');const answer=JSON.parse(process.env.WRITER_RESULT);if(process.env.WRITER_FAIL){process.exit(17)};if(process.env.WRITER_MUTATE)fs.writeFileSync(process.env.WRITER_MUTATE,'changed');if(args[0]==='exec'){const out=args[args.indexOf('--output-last-message')+1]; fs.writeFileSync(out,JSON.stringify(answer));console.log(JSON.stringify({type:'thread.started',thread_id:'a77aaa03-329c-4d59-b4c5-269746a893f2'}));}else{console.log(JSON.stringify({type:'system',subtype:'init',session_id:'a77aaa03-329c-4d59-b4c5-269746a893f2'}));console.log(JSON.stringify({type:'result',subtype:'success',structured_output:answer}));}});\n`;
  for (const name of ['codex', 'claude']) { await writeFile(join(bin, name), fake); await chmod(join(bin, name), 0o755); }
  const calls = join(session, 'writer-calls.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WRITER_CALLS: calls, WRITER_RESULT: JSON.stringify({ status: 'completed', summary: '작성 완료', content: '# 작성된 Spec\n' }) };
  return { parent, primary, root, session, worktreeRef, calls, env };
}

async function request(f, axis, id, options = {}) {
  const path = `runtime/writer-input/${id}.json`;
  await mkdir(join(f.session, 'runtime/writer-input'), { recursive: true });
  const topicsPath = join(f.root, '.codex/internal-skills', axis === 'product' ? 'product-spec' : 'architecture-spec', 'references/topics.md');
  const topics = [...(await readFile(topicsPath, 'utf8')).matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gm)].map((match) => match[1]);
  await writeFile(join(f.session, path), JSON.stringify({ schema_version: 1, request_id: id, axis, plan_set_id: 'example', decisions: [{ id: 'REQ-1', decision: '결정된 요구', evidence: ['docs/specs/example/request.md'] }], coverage: topics.map((topic) => ({ topic, status: 'settled', reason: '사용자 결정' })), diagram_inventory: [], overwrite_authorized: false, ...options }));
  return path;
}

function dispatch(f, axis, requestPath, extraEnv = {}) {
  return spawnSync(process.execPath, [join(f.root, '.codex/scripts/harness-spec-writer.mjs'), '--worktree-ref', f.worktreeRef, '--execution-id', 'spec-me-test', '--request', requestPath, '--axis', axis, '--provider', f.env.WRITER_PROVIDER], { cwd: f.root, env: { ...f.env, WRITER_RESULT: JSON.stringify({ status: 'completed', summary: '작성 완료', content: contentFor(axis) }), ...extraEnv }, encoding: 'utf8' });
}

for (const provider of ['codex', 'claude-code']) test(`installed ${provider} writer receives settled context and records fresh output`, async () => {
  const f = await fixture(provider); f.env.WRITER_PROVIDER = provider;
  try {
    for (const axis of ['product', 'architecture']) {
      const ref = await request(f, axis, `${axis}-one`);
      const run = dispatch(f, axis, ref);
      if (run.status !== 0) {
        const log = await readFile(join(f.session, 'runtime/spec-writers/example', axis, `${axis}-one`, 'stderr.log'), 'utf8').catch(() => '');
        assert.fail(`${run.stderr}\n${log}`);
      }
      const receipt = JSON.parse(run.stdout);
      assert.equal(receipt.provider, provider); assert.equal(receipt.model, 'test-writer');
      assert.equal(receipt.output_path, `docs/specs/example/${axis}-spec.md`);
      assert.equal(await readFile(join(f.root, receipt.output_path), 'utf8'), contentFor(axis));
      await unlink(join(f.session, receipt.receipt_ref));
      if (axis === 'product') {
        await unlink(join(f.root, receipt.output_path));
        const staleLock = join(f.session, 'runtime/spec-writers/example/product.lock');
        await mkdir(staleLock);
        await writeFile(join(staleLock, 'owner.json'), JSON.stringify({ pid: 2147483647, boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), start: 'stopped' }));
      }
      if (axis === 'product') {
        const args = [join(f.root, '.codex/scripts/harness-spec-writer.mjs'), '--worktree-ref', f.worktreeRef, '--execution-id', 'spec-me-test', '--request', ref, '--axis', axis, '--provider', provider];
        const runConcurrent = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, args, { cwd: f.root, env: f.env }); let stdout = '', stderr = ''; child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; }); child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr })); });
        const attempts = await Promise.all([runConcurrent(), runConcurrent()]);
        assert.ok(attempts.some((item) => item.status === 0), JSON.stringify(attempts));
      }
      const retry = dispatch(f, axis, ref); assert.equal(retry.status, 0, retry.stderr);
      assert.equal(await readFile(join(f.root, receipt.output_path), 'utf8'), contentFor(axis));
      assert.equal(JSON.parse(retry.stdout).session_id, receipt.session_id);
    }
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2, 'idempotent retries must not launch a writer again');
    assert.ok(calls.every(({ args }) => args.includes('test-writer')));
    if (provider === 'claude-code') assert.ok(calls.every(({ args }) => args.includes('--agent') && args.includes('spec_document_writer')));
    const prompts = calls.map(({ args, input }) => provider === 'codex' ? input : args.at(-1));
    assert.ok(prompts.every((prompt) => prompt.includes('settled decision bundle') && prompt.includes('references/template.md')));
    const { requireCurrentSpecWriters } = await import(`file://${join(f.root, '.harness/src/workflow/spec-writer.mjs')}`);
    assert.equal((await requireCurrentSpecWriters({ root: f.root, ticketId: 'example' })).status, 'pass');
    const canonical = join(f.session, 'runtime/spec-writers/example/product.json');
    const savedReceipt = await readFile(canonical, 'utf8');
    await writeFile(canonical, JSON.stringify({ ...JSON.parse(savedReceipt), summary: '변조' }));
    await assert.rejects(requireCurrentSpecWriters({ root: f.root, ticketId: 'example' }), /incomplete or inconsistent/);
    await writeFile(canonical, savedReceipt);
    const exitPath = join(f.session, 'runtime/spec-writers/example/product/product-one/exit.json');
    const exit = await readFile(exitPath, 'utf8');
    await writeFile(exitPath, JSON.stringify({ ...JSON.parse(exit), exit_code: 1 }));
    await assert.rejects(requireCurrentSpecWriters({ root: f.root, ticketId: 'example' }), /incomplete or inconsistent/);
    await writeFile(exitPath, exit);
    const revision = await request(f, 'product', 'product-revision', { overwrite_authorized: false });
    const revisionRun = dispatch(f, 'product', revision); assert.equal(revisionRun.status, 0, revisionRun.stderr);
    const evidence = join(f.root, 'docs/specs/example/request.md');
    await writeFile(evidence, '변경된 요구사항\n');
    await assert.rejects(requireCurrentSpecWriters({ root: f.root, ticketId: 'example' }), /evidence is stale/);
    await writeFile(evidence, '사용자 승인 요구사항\n');
    await writeFile(join(f.root, 'docs/specs/example/product-spec.md'), '# 외부 수정\n');
    await assert.rejects(requireCurrentSpecWriters({ root: f.root, ticketId: 'example' }), /stale/);
    const status = git(f.root, 'status', '--short', '--untracked-files=all');
    assert.match(status, /docs\/specs\/example\/product-spec.md/);
    assert.doesNotMatch(status, /\.harness\/src\/workflow\/spec-writer/);
    assert.match(git(f.root, 'check-ignore', '-v', '.harness/src/workflow/spec-writer.mjs'), /\.harness/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('writer rejects unresolved decisions and preserves a failed attempt', async () => {
  const f = await fixture('codex'); f.env.WRITER_PROVIDER = 'codex';
  try {
    const unresolved = await request(f, 'product', 'unresolved', { coverage: [{ topic: 'scope', status: 'partial', reason: '미결정' }] });
    assert.match(dispatch(f, 'product', unresolved).stderr, /coverage/);
    const ref = await request(f, 'product', 'failed');
    const failed = dispatch(f, 'product', ref, { WRITER_FAIL: '1' }); assert.notEqual(failed.status, 0);
    const retry = dispatch(f, 'product', ref); assert.match(retry.stderr, /already started without a receipt/);
    await assert.rejects(readFile(join(f.root, 'docs/specs/example/product-spec.md')), { code: 'ENOENT' });
    await writeFile(join(f.root, 'docs/specs/example/product-spec.md'), '사용자 기존 문서\n');
    const unowned = await request(f, 'product', 'unowned', { overwrite_authorized: true });
    const refused = dispatch(f, 'product', unowned); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /current writer receipt/);
    assert.equal(await readFile(join(f.root, 'docs/specs/example/product-spec.md'), 'utf8'), '사용자 기존 문서\n');
    await unlink(join(f.root, 'docs/specs/example/product-spec.md'));
    const changing = await request(f, 'product', 'changing');
    const changed = dispatch(f, 'product', changing, { WRITER_MUTATE: join(f.root, 'docs/specs/example/request.md') });
    assert.notEqual(changed.status, 0); assert.match(changed.stderr, /evidence changed/);
    await assert.rejects(readFile(join(f.root, 'docs/specs/example/product-spec.md')), { code: 'ENOENT' });
    await writeFile(join(f.root, 'docs/specs/example/request.md'), '사용자 승인 요구사항\n');
    const incomplete = await request(f, 'product', 'incomplete');
    const historical = productHeadings.slice(0, 7).map((heading) => `## ${heading}\n\n내용\n`).join('\n');
    const rejected = dispatch(f, 'product', incomplete, { WRITER_RESULT: JSON.stringify({ status: 'completed', summary: '작성 완료', content: historical }) });
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /missing an ordered section/);
    await assert.rejects(readFile(join(f.root, 'docs/specs/example/product-spec.md')), { code: 'ENOENT' });
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});
