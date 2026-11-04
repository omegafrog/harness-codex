import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

test('installed Claude runner dispatches a settled writer request and resumes the parent', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'spec-writer-runner-'));
  const primary = join(parent, 'project'), root = join(parent, 'worktree'), bin = join(parent, 'bin');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    await mkdir(primary); await mkdir(bin);
    git(primary, 'init', '-q');
    await writeFile(join(primary, 'app.txt'), 'project-owned\n');
    git(primary, 'add', 'app.txt'); git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'init');
    git(primary, 'worktree', 'add', '-qb', 'spec-test', root);
    const source = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, source);
    await updateProject({ sourceRoot: source, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot: source, targetRoot: root });
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  provider: claude-code\n  high_performance_model: parent-model\n  high_performance_reasoning_effort: low\n  low_performance_model: writer-model\n  low_performance_reasoning_effort: low\n');
    const session = join(root, '.io'), ref = join(session, 'worktree.json'), id = 'spec-me-runner-test';
    await mkdir(join(session, 'runtime/executions', id), { recursive: true });
    await writeFile(ref, JSON.stringify({ schema_version: 1, worktree_id: 'a77aaa03-329c-4d59-b4c5-269746a893f2', workspace: root, common: await realpath(join(primary, '.git')), git_dir: await realpath(git(root, 'rev-parse', '--absolute-git-dir')), return_root: primary, session_directory: session, branch: 'spec-test', state: 'active', plan_set_id: 'example' }));
    await mkdir(join(root, 'docs/specs/example'), { recursive: true });
    await writeFile(join(root, 'docs/specs/example/request.md'), '사용자 요구\n');
    const priorSpec = '# 기존 승인 대상\n';
    await writeFile(join(root, 'docs/specs/example/product-spec.md'), priorSpec);
    const topics = await readFile(join(root, '.codex/internal-skills/product-spec/references/topics.md'), 'utf8');
    const coverage = [...topics.matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gm)].map((match) => ({ topic: match[1], status: 'settled', reason: '사용자 결정' }));
    await mkdir(join(session, 'runtime/writer-input'), { recursive: true });
    const requestPath = 'runtime/writer-input/product.json';
    await writeFile(join(session, requestPath), JSON.stringify({ schema_version: 1, request_id: 'product-runner', axis: 'product', plan_set_id: 'example', decisions: [{ id: 'REQ-1', decision: '계산기', evidence: ['docs/specs/example/request.md'] }], coverage, diagram_inventory: [], overwrite_authorized: false }));
    const { writeExecutionInput } = await import(`file://${join(root, '.harness/src/workflow/execution-input.mjs')}`);
    await writeExecutionInput(root, { schema_version: 1, execution_id: id, skill: 'spec-me', scope: '계산기', input_refs: [], context: { worktree_ref: ref, stage_id: 'spec-me', provider: 'claude-code', approved_spec_overwrites: { product: createHash('sha256').update(priorSpec).digest('hex') } } }, 'example');
    await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
    const productMarkdown = ['문제와 맥락', '목표와 기대 효과', '사용자와 행위자', '유비쿼터스 언어와 용어', '핵심 유스케이스', '업무 규칙과 불변 조건', '상태와 상태 전이', '실패 예외 및 경계 조건', '입력과 출력', '범위와 비목표', '우선순위와 트레이드오프', '성공 조건과 수용 기준'].map((heading) => `## ${heading}\n확정된 내용\n`).join('\n');
    const fake = `#!/usr/bin/env node
const fs=require('fs');const args=process.argv.slice(2);const sid='a77aaa03-329c-4d59-b4c5-269746a893f2';
fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
const emit=x=>console.log(JSON.stringify(x));emit({type:'system',subtype:'init',session_id:sid});
if(args.includes('--agent')){emit({type:'result',subtype:'success',structured_output:{status:'completed',summary:'완료',content:${JSON.stringify(productMarkdown)}}})}
else {const resumed=args.includes('--resume');if(!resumed){emit({type:'assistant',message:{content:[{type:'tool_use',id:'skill-call',name:'Skill',input:{skill:'spec-me'}}]}});emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'skill-call'}]}})}
const q={question_id:'question',title:'계속할까요?',options:[{id:'yes',label:'예',consequence:'계속'},{id:'no',label:'아니요',consequence:'대기'}],recommended_option_id:'yes',rationale:'결정 필요'};
const request={skill:'product-spec',agent_profile:'spec_document_writer',purpose:'문서 작성',context_path:'runtime/writer-input/product.json'};
const result={schema_version:1,execution_id:'${id}',skill:'spec-me',status:'action_required',code:resumed?'USER_DECISION_REQUIRED':'REVIEW_REQUIRED',summary:'진행 중',artifacts:[],questions:resumed?[q]:[],review_request:resumed?null:request};
emit({type:'result',subtype:'success',structured_output:{schema_version:1,execution_id:'${id}',skill:'spec-me',status:'action_required',code:result.code,result_ref:null,result}})}
`;
    await writeFile(join(bin, 'claude'), fake); await chmod(join(bin, 'claude'), 0o755);
    const calls = join(session, 'calls.jsonl');
    const run = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-agent-run.mjs'), '--worktree-ref', ref, '--execution-id', id], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls }, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, run.stderr);
    const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.length, 3);
    assert.ok(commands[1].includes('--agent') && commands[1].includes('spec_document_writer'));
    assert.ok(commands[2].includes('--resume') && commands[2].includes('a77aaa03-329c-4d59-b4c5-269746a893f2'));
    const returned = JSON.parse(await readFile(join(session, 'runtime/executions', id, 'return.json'), 'utf8'));
    assert.equal(returned.code, 'USER_DECISION_REQUIRED');
    assert.equal(await readFile(join(root, 'docs/specs/example/product-spec.md'), 'utf8'), productMarkdown);
    const status = git(root, 'status', '--short', '--untracked-files=all');
    assert.match(status, /docs\/specs\/example\/product-spec.md/);
    assert.doesNotMatch(status, /\.harness\/src\/workflow\/spec-writer/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
