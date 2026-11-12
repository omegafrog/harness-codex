import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { writeGuardDecision } from '../.codex/scripts/harness-write-guard.mjs';
import { orchestratorInputTarget } from '../.harness/src/workflow/startup-state.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const waitFor = async (path, predicate = () => true) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const value = await json(path); if (predicate(value)) return value; } catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${path}`);
};

test('installed main conversation runs isolated A/B workflows without changing the user cwd', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'main-workflows-'));
  const primary = join(directory, 'main'), bin = join(directory, 'bin');
  const runnerGates = [];
  const sessionId = randomUUID();
  await mkdir(primary); await mkdir(bin);
  t.after(async () => {
    await Promise.all(runnerGates.map((gate) => writeFile(gate, 'release').catch(() => {})));
    if (runnerGates.length) await new Promise((resolve) => setTimeout(resolve, 2000));
    await rm(directory, { recursive: true, force: true });
  });
  git(primary, 'init', '-q', '-b', 'main');
  git(primary, 'config', 'user.name', 'Workflow test'); git(primary, 'config', 'user.email', 'test@example.test');
  await protectLocalInstallArtifacts(primary, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: primary, initialize: true });
  await writeFile(join(primary, '.codex/harness.yaml'), 'agents:\n  provider: codex\n  codex:\n    high_performance_model: example\n    high_performance_reasoning_effort: medium\n    low_performance_model: example\n    low_performance_reasoning_effort: medium\n');
  await writeFile(join(primary, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":10000,"max_plan_tokens":6000,"handoff_reserve_tokens":2000}\n');
  for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html']) {
    await mkdir(join(primary, path, '..'), { recursive: true }); await writeFile(join(primary, path), '');
  }
  await writeFile(join(primary, 'app.txt'), 'baseline\n');
  git(primary, 'add', 'app.txt', 'docs', 'CONTEXT.md', 'CONTEXT-MAP.md', '.harness/contracts.mjs');
  git(primary, 'commit', '-qm', 'baseline');
  const run = (script, args = [], { cwd = primary, env = {} } = {}) => {
    const result = spawnSync(process.execPath, [join(primary, '.codex/scripts', script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const compose = (slug) => run('harness-compose-workspace.mjs', ['--root', primary, '--execution-id', `compose-${slug}`, '--plan-set-id', slug, '--request', `${slug} 기능`, '--orchestrator-provider', 'codex', '--orchestrator-session-id', sessionId]);
  const a = compose('alpha'), b = compose('beta');
  const hook = (prompt, provider = 'codex') => {
    const script = provider === 'codex' ? '.codex/scripts/harness-orchestrator-hook.mjs' : '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs';
    const result = spawnSync(process.execPath, [join(primary, script)], { cwd: primary, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: primary, session_id: sessionId, prompt }) });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    return JSON.parse(context.match(/Observed state(?: \(.*?\))?: (\{.*?\})\. Progress snapshot:/)[1]);
  };
  const log = (tree) => join(tree.session_directory, 'runtime/orchestrator/user-inputs.jsonl');

  await t.test('compose binds the main session and compact recovery needs only existing records', async () => {
    for (const tree of [a, b]) {
      const record = await json(tree.worktree_ref);
      assert.equal(record.agent_sessions.orchestrator.session_id, sessionId);
      const ctx = run('harness-context.mjs', ['--worktree-ref', tree.worktree_ref]);
      assert.equal(ctx.workspace_root, tree.workspace);
      assert.equal(ctx.plan_set_id, tree.plan_set_id);
    }
    const inventory = run('harness-context.mjs', [], { env: { CODEX_THREAD_ID: sessionId } });
    assert.deepEqual(new Set(inventory.session_worktrees.map(item => item.record_path)), new Set([a.worktree_ref, b.worktree_ref]));
    assert.equal(inventory.workflows.length, 2, 'main recovers both workflows with no remembered worktree path or new prompt hook');
    const observed = hook('승인');
    assert.equal(observed.decision_hint, 'resume_candidate');
    assert.equal(observed.matching_workflow_count, 2);
    assert.equal(observed.input_routing, 'ambiguous');
    assert.equal(existsSync(log(a)), false);
    assert.equal(existsSync(log(b)), false);
    const scoped = hook(`${a.plan_set_id} 승인`);
    assert.equal(scoped.input_worktree_ref, a.worktree_ref);
    assert.match(await readFile(log(a), 'utf8'), /승인/);
    assert.equal(existsSync(log(b)), false, 'an approval is never broadcast');
    // A fresh process reads the same records with no retained model context.
    assert.equal(hook(`${b.worktree_id} 진행`).input_worktree_ref, b.worktree_ref);
    assert.match(await readFile(log(b), 'utf8'), /진행/);
    assert.equal(existsSync(join(primary, '.io/worktree.json')), false);
    assert.equal(existsSync(join(primary, '.git/harness/sessions')), false);
  });

  await t.test('generic input selects one live workflow despite retained completed worktrees', () => {
    const old = { record_path: '/repo/old/.io/worktree.json', workspace_root: '/repo/old', worktree_id: 'old', branch: 'old' };
    const live = { record_path: '/repo/live/.io/worktree.json', workspace_root: '/repo/live', worktree_id: 'live', branch: 'live' };
    const observed = { workspace_root: '/repo/main', session_worktrees: [old, live], matching_workflows: [{ worktree_ref: live.record_path, status: 'running' }] };
    assert.equal(orchestratorInputTarget(observed, { prompt: '승인' }), live);
    assert.equal(orchestratorInputTarget(observed, { prompt: 'old 승인' }), old, 'explicit references can address a retained workflow');
    observed.matching_workflows.push({ worktree_ref: old.record_path, status: 'waiting' });
    assert.equal(orchestratorInputTarget(observed, { prompt: '승인' }), null, 'multiple live workflows remain ambiguous');
  });

  await t.test('main write protection also covers sibling worktrees and an explicit command workdir', () => {
    const env = { ...process.env }; delete env.HARNESS_SKILL_EXECUTION_ID;
    for (const [tool_name, tool_input] of [
      ['apply_patch', { command: `*** Begin Patch\n*** Add File: ${a.workspace}/src/bypass.js\n+x\n*** End Patch` }],
      ['Bash', { command: 'echo x > src/bypass.js', workdir: b.workspace }],
      ['exec_command', { cmd: 'echo x > app.txt', workdir: primary }],
    ]) assert.match(writeGuardDecision({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: primary, tool_name, tool_input }, env) || '', /orchestrator main session does not write/);
  });

  const inputs = [];
  await t.test('prepares both first stages from main and rejects cross-worktree/foreign selectors', async () => {
    for (const tree of [a, b]) {
      const prepared = run('harness-prepare-input.mjs', ['--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me']);
      assert.equal(prepared.session_directory, tree.session_directory);
      assert.equal(prepared.input.context.worktree_ref, tree.worktree_ref);
      assert.equal(prepared.input.context.orchestrator_session_id, sessionId);
      inputs.push(prepared.input);
    }
    const mismatch = spawnSync(process.execPath, [join(primary, '.codex/scripts/harness-context.mjs'), '--worktree-ref', b.worktree_ref], { cwd: a.workspace, encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /does not match the current worktree/);
    const foreign = join(directory, 'foreign'); await mkdir(foreign);
    git(foreign, 'init', '-q', '-b', 'main'); git(foreign, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-qm', 'base');
    await mkdir(join(foreign, '.io'));
    await writeFile(join(foreign, '.io/worktree.json'), JSON.stringify({ ...await json(a.worktree_ref), workspace: foreign, common: join(foreign, '.git'), session_directory: join(foreign, '.io'), branch: 'main' }));
    const refused = spawnSync(process.execPath, [join(primary, '.codex/scripts/harness-context.mjs'), '--worktree-ref', join(foreign, '.io/worktree.json')], { cwd: primary, encoding: 'utf8' });
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /registered worktree in this repository/);
  });

  await t.test('background A/B runners execute in their own cwd and return reversed results to the same chat', async () => {
    const wakeLog = join(directory, 'wake.jsonl'), wake = join(bin, 'wake.cjs');
    await writeFile(wake, `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}));if(m.id===2){fs.appendFileSync(${JSON.stringify(wakeLog)},JSON.stringify(m.params.arguments)+'\\n');console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{structuredContent:{state:'queued'}}}));}});`);
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2);
if(a[0]==='mcp'){console.log(JSON.stringify({enabled:true,transport:{type:'stdio',command:process.execPath,args:[${JSON.stringify(wake)}],cwd:${JSON.stringify(bin)}}}));process.exit(0);}
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
 const id=process.env.HARNESS_SKILL_EXECUTION_ID,dir=p.dirname(a[a.indexOf('--output-schema')+1]);
 fs.writeFileSync(p.join(dir,'actual-cwd.json'),JSON.stringify({cwd:process.cwd(),args:a}));
 console.log(JSON.stringify({type:'thread.started',thread_id:process.env.TEST_THREAD}));
 console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));
 let timer;const fallback=setTimeout(()=>{clearInterval(timer);process.exit(1);},30000);fallback.unref();timer=setInterval(()=>{if(!fs.existsSync(process.env.TEST_GATE))return;clearInterval(timer);clearTimeout(fallback);
 const result={schema_version:1,execution_id:id,skill:'spec-me',status:'action_required',code:'USER_DECISION_REQUIRED',summary:'범위 확인',artifacts:[],questions:[{question_id:'scope',title:'범위를 선택하세요',options:[{id:'yes',label:'기본',consequence:'기본 범위'},{id:'no',label:'추가',consequence:'추가 범위'}],recommended_option_id:'yes',rationale:'범위 확인'}],review_request:null};
 fs.writeFileSync(p.join(dir,'result.json'),JSON.stringify(result));
 fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({schema_version:1,execution_id:id,skill:'spec-me',status:result.status,code:result.code,result}));
 },20);
});
`);
    await chmod(join(bin, 'codex'), 0o755);
    const gates = [join(directory, 'a-ready'), join(directory, 'b-ready')];
    runnerGates.push(...gates);
    for (let i=0; i<2; i++) {
      const tree=[a,b][i], input=inputs[i];
      const launched=run('harness-agent-run.mjs', ['--worktree-ref',tree.worktree_ref,'--execution-id',input.execution_id,'--background','true'], {env:{PATH:`${bin}:${process.env.PATH}`,TEST_GATE:gates[i],TEST_THREAD:randomUUID()}});
      assert.equal(launched.status,'started');
      const actual=await waitFor(join(tree.session_directory,'runtime/executions',input.execution_id,'actual-cwd.json'));
      assert.equal(actual.cwd,tree.workspace);
      assert.equal(actual.args[actual.args.indexOf('--cd')+1],tree.workspace);
    }
    const eventPath=(tree,input)=>join(tree.session_directory,'runtime/orchestrator/stage-results',`${input.execution_id}.json`);
    await writeFile(gates[1],'go');
    const bEvent=await waitFor(eventPath(b,inputs[1]),value=>value.delivery.status==='sent');
    assert.equal(bEvent.worktree_ref,b.worktree_ref);
    assert.equal(existsSync(eventPath(a,inputs[0])),false);
    await writeFile(gates[0],'go');
    const aEvent=await waitFor(eventPath(a,inputs[0]),value=>value.delivery.status==='sent');
    assert.equal(aEvent.worktree_ref,a.worktree_ref);
    const delivered=(await readFile(wakeLog,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(delivered.map(item=>item.thread),[sessionId,sessionId]);
    assert.ok(delivered[0].message_template.includes(b.worktree_ref));
    assert.ok(delivered[1].message_template.includes(a.worktree_ref));
    const ctxA=run('harness-context.mjs',['--worktree-ref',a.worktree_ref]);
    const ctxB=run('harness-context.mjs',['--worktree-ref',b.worktree_ref]);
    assert.equal(ctxA.stages['spec-me'].execution_id,inputs[0].execution_id);
    assert.equal(ctxB.stages['spec-me'].execution_id,inputs[1].execution_id);
    assert.equal(ctxA.stages['spec-me'].status,'waiting'); assert.equal(ctxB.stages['spec-me'].status,'waiting');
    assert.equal(git(primary,'status','--short'),'', 'workflow runtime never dirties main');
  });

  await t.test('consumer update, both provider guides, Doctor and Git ownership preserve the behavior', async () => {
    await writeFile(join(primary,'app.txt'),'application change\n');
    await writeFile(join(primary,'docs/agents/EXEC.md'),'project execution notes\n');
    await mkdir(join(primary,'docs/contracts'),{recursive:true});
    await writeFile(join(primary,'docs/contracts/project-notes.md'),'project-owned\n');
    const managed='.harness/src/workflow/cli-context.mjs';
    const lockPath=join(primary,'.codex/harness-lock.json'),lock=await json(lockPath);
    const old='export const previousVersion = true;\n',hash=createHash('sha256').update(old).digest('hex');
    await writeFile(join(primary,managed),old);
    lock.files[managed]={...lock.files[managed],installed_sha256:hash,upstream_sha256:hash};
    await writeFile(lockPath,JSON.stringify(lock));
    await updateProject({sourceRoot,targetRoot:primary});
    assert.equal(await readFile(join(primary,managed),'utf8'),await readFile(join(sourceRoot,managed),'utf8'));
    for(const path of ['.agents/skills/orchestrator/SKILL.md','.claude/skills/orchestrator/SKILL.md']) assert.match(await readFile(join(primary,path),'utf8'),/input_routing/);
    assert.equal(run('harness-context.mjs',['--worktree-ref',a.worktree_ref]).workspace_root,a.workspace);
    assert.equal(await readFile(join(primary,'app.txt'),'utf8'),'application change\n');
    assert.equal(await readFile(join(primary,'docs/agents/EXEC.md'),'utf8'),'project execution notes\n');
    assert.equal((await runDoctor({root:primary,sourceRoot})).diagnostics.some(item=>item.code==='execution_asset_missing'),false);
    const runtime=await readFile(join(primary,managed)); await unlink(join(primary,managed));
    assert.ok((await runDoctor({root:primary,sourceRoot})).diagnostics.some(item=>item.code==='execution_asset_missing'&&item.path.endsWith(managed)));
    await writeFile(join(primary,managed),runtime);
    const status=git(primary,'status','--short','--untracked-files=all');
    assert.match(status,/app\.txt/); assert.match(status,/docs\/agents\/EXEC\.md/); assert.match(status,/docs\/contracts\/project-notes\.md/);
    assert.doesNotMatch(status,/\.io\/|\.codex\/|\.harness\/src\/|\.claude\/skills\//);
    for(const path of [managed,'.codex/scripts/harness-context.mjs','.io/runtime/orchestrator/progress.json']) git(primary,'check-ignore','-v',path);
    assert.equal((await json(a.worktree_ref)).agent_sessions.orchestrator.session_id,sessionId);
    // The Claude hook uses the same scoped routing, not a provider-specific active-worktree file.
    for(const tree of [a,b]) run('harness-workflow-session.mjs',['--workspace-root',tree.workspace,'--repository-root',primary,'--key','orchestrator','--session-id',sessionId,'--execution-id','orchestrator-prompt','--provider','claude-code']);
    assert.equal(hook(`${b.plan_set_id} 승인`,'claude-code').input_worktree_ref,b.worktree_ref);
    const installed=await import(pathToFileURL(join(primary,'.harness/src/workflow/startup-state.mjs')));
    const observed=await installed.inspectStartupState({workspaceRoot:primary,sessionId,provider:'claude-code'});
    assert.equal(observed.matching_workflow_count,2);
    assert.equal(installed.orchestratorInputTarget(observed,{prompt:'승인'}),null);
  });
});
