import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertQuestionPreviews } from '../.harness/src/workflow/questions.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { captureStyleOptions } from '../.harness/internal-skills/frontend-design/scripts/capture-style-options.mjs';
import { codexUserPrompt } from './support/codex-user-prompt.mjs';
import { consumerWorkflow, sourceRoot } from './support/consumer-workflow.mjs';
import { withDecisionContext } from './support/decision-question.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ff0000000049454e44ae426082', 'hex');
const SCRIPT = '.harness/internal-skills/frontend-design/scripts/capture-style-options.mjs';

async function sampleSession(session, directory, ids = ['calm', 'bold']) {
  for (const id of ids) {
    await mkdir(join(session, directory, id), { recursive: true });
    for (const viewport of ['desktop', 'mobile']) await writeFile(join(session, directory, id, `${viewport}.png`), PNG);
  }
  await writeFile(join(session, directory, 'index.html'), '<!doctype html><title>비교</title>\n');
}

const option = (directory, id, previews = ['desktop', 'mobile']) => ({ id, label: id, consequence: `${id} 스타일`, evidence: [], previews: previews.map((viewport) => ({ path: `${directory}/${id}/${viewport}.png`, viewport, caption: `${id} ${viewport}` })) });
const visualQuestion = (directory, options, title = `어떤 시각 스타일로 진행할까요? 비교 페이지: .io/${directory}/index.html`) => withDecisionContext({ title, decision_kind: 'visual_direction', options, recommended_option_id: options[0].id, rationale: '핵심 화면의 밀도에 맞는다' });

test('a visual direction question needs a real desktop image inside the session and a comparison page', async (t) => {
  const session = await mkdtemp(join(tmpdir(), 'style-previews-'));
  t.after(() => rm(session, { recursive: true, force: true }));
  const directory = 'runtime/executions/brief/style-options';
  await sampleSession(session, directory);
  const valid = visualQuestion(directory, [option(directory, 'calm'), option(directory, 'bold')]);
  await assertQuestionPreviews({ session, question: valid });
  await assertQuestionPreviews({ session, question: { ...valid, title: `비교: ${join(session, directory, 'index.html')}` } });
  // A workspace path with a space still names the session's comparison page.
  await assertQuestionPreviews({ session, question: { ...valid, title: `비교 페이지: /home/me/my project/.io/${directory}/index.html` } });

  const reject = (question, pattern) => assert.rejects(assertQuestionPreviews({ session, question }), pattern);
  await reject(visualQuestion(directory, [option(directory, 'calm'), { ...option(directory, 'bold'), previews: [] }]), /option bold needs preview screenshots/);
  await reject(visualQuestion(directory, [option(directory, 'calm'), (({ previews, ...rest }) => rest)(option(directory, 'bold'))]), /option bold needs preview screenshots/);
  await assertQuestionPreviews({ session, question: visualQuestion(directory, [option(directory, 'calm', ['desktop']), option(directory, 'bold', ['desktop'])]) });
  await reject(visualQuestion(directory, [option(directory, 'calm'), option(directory, 'bold', ['mobile'])]), /needs a desktop preview/);
  await reject(visualQuestion(directory, [option(directory, 'calm'), option(directory, 'gone')]), /does not exist/);
  const escape = { ...option(directory, 'bold'), previews: [{ path: '../outside.png', viewport: 'desktop', caption: 'x' }, { path: join(tmpdir(), 'outside.png'), viewport: 'mobile', caption: 'x' }] };
  await reject(visualQuestion(directory, [option(directory, 'calm'), escape]), /outside the session/);
  const outside = await mkdtemp(join(tmpdir(), 'style-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'real.png'), PNG);
  await mkdir(join(session, directory, 'linked'), { recursive: true });
  await symlink(join(outside, 'real.png'), join(session, directory, 'linked/desktop.png'));
  await writeFile(join(session, directory, 'linked/mobile.png'), PNG);
  await reject(visualQuestion(directory, [option(directory, 'calm'), option(directory, 'linked')]), /regular session file/);
  await mkdir(join(session, directory, 'text'), { recursive: true });
  await writeFile(join(session, directory, 'text/desktop.png'), 'not an image');
  await writeFile(join(session, directory, 'text/mobile.png'), PNG);
  await reject(visualQuestion(directory, [option(directory, 'calm'), option(directory, 'text')]), /not a PNG, JPEG or WebP image/);
  await writeFile(join(session, directory, 'calm/desktop.svg'), '<svg/>');
  await reject(visualQuestion(directory, [option(directory, 'calm'), { ...option(directory, 'bold'), previews: [{ path: `${directory}/calm/desktop.svg`, viewport: 'desktop', caption: 'x' }, option(directory, 'bold').previews[1]] }]), /not a PNG, JPEG or WebP image/);
  await reject({ ...valid, title: '어떤 시각 스타일로 진행할까요?' }, /must name the comparison page/);
  await reject({ ...valid, title: `비교: .io/${directory}/missing.html` }, /Comparison page .* does not exist/);

  // Other questions are unchanged: no previews required, and an empty list is accepted.
  const plain = { title: '범위는?', decision_kind: null, recommended_option_id: 'a', rationale: 'r', options: [{ id: 'a', label: 'A', consequence: 'a', evidence: [] }, { id: 'b', label: 'B', consequence: 'b', evidence: [], previews: [] }] };
  await assertQuestionPreviews({ session, question: plain });
});

test('the capture script refuses mocks without a device-width viewport before launching a browser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'style-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const help = spawnSync(process.execPath, [join(sourceRoot, SCRIPT), '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--root <workspace_root> --execution-id <execution_id>/);
  assert.equal(existsSync(join(root, '.io')), false, 'help creates no session directory');
  const directory = join(root, '.io/runtime/executions/brief/style-options');
  for (const id of ['calm', 'bold']) {
    await mkdir(join(directory, id), { recursive: true });
    await writeFile(join(directory, id, 'mock.html'), '<!doctype html><html><body>글쓰기</body></html>');
  }
  await writeFile(join(directory, 'options.json'), JSON.stringify({ screen: '게시글 작성', options: [{ id: 'calm', label: '차분한', summary: '' }, { id: 'bold', label: '선명한', summary: '' }] }));
  const chromium = { launch: () => assert.fail('no browser for an invalid mock') };
  await assert.rejects(captureStyleOptions({ root, executionId: 'brief', chromium }), /needs <meta name="viewport"/);
  await writeFile(join(directory, 'options.json'), JSON.stringify({ screen: '게시글 작성', options: [{ id: 'calm', label: '차분한', summary: '' }] }));
  await assert.rejects(captureStyleOptions({ root, executionId: 'brief', chromium }), /at least two options/);
});

const playwrightAvailable = (() => {
  try { execFileSync(process.execPath, ['-e', `require(require('child_process').execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim()+'/playwright')`], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

test('the capture script renders every option at desktop and mobile size and writes the comparison page', { skip: !playwrightAvailable && 'Playwright is not installed globally' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'style-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relativeDirectory = 'runtime/executions/brief/style-options';
  const directory = join(root, '.io', relativeDirectory);
  const options = [{ id: 'calm', label: '차분한 업무형', summary: '낮은 대비' }, { id: 'bold', label: '선명한 강조형', summary: '강한 대비' }];
  for (const [index, { id }] of options.entries()) {
    await mkdir(join(directory, id), { recursive: true });
    await writeFile(join(directory, id, 'mock.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:${index ? '#111' : '#eef'}"><main style="padding:24px"><h1>글쓰기</h1><img src="https://example.invalid/x.png" alt=""><button>등록</button></main></body></html>`);
  }
  await writeFile(join(directory, 'options.json'), JSON.stringify({ screen: '게시글 작성', options }));
  const output = spawnSync(process.execPath, [join(sourceRoot, SCRIPT), '--root', root, '--execution-id', 'brief'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(output.status, 0, output.stderr);
  const captured = JSON.parse(output.stdout);
  assert.equal(captured.comparison_page.path, `${relativeDirectory}/index.html`);
  assert.deepEqual(captured.options.map((item) => item.previews.map(({ viewport }) => viewport)), [['desktop'], ['desktop']]);
  await writeFile(join(directory, 'options.json'), JSON.stringify({ screen: '게시글 작성', options, viewports: ['desktop', 'mobile'] }));
  const mobileOutput = spawnSync(process.execPath, [join(sourceRoot, SCRIPT), '--root', root, '--execution-id', 'brief'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(mobileOutput.status, 0, mobileOutput.stderr);
  const mobileCaptured = JSON.parse(mobileOutput.stdout);
  const page = await readFile(captured.comparison_page.absolute_path, 'utf8');
  for (const { id } of options) for (const viewport of ['desktop', 'mobile']) assert.match(page, new RegExp(`src="${id}/${viewport}\\.png"`));
  assert.deepEqual(mobileCaptured.options.map((item) => item.previews.map(({ viewport }) => viewport)), [['desktop', 'mobile'], ['desktop', 'mobile']]);
  const mobile = await readFile(join(root, '.io', mobileCaptured.options[0].previews[1].path));
  assert.equal(mobile.readUInt32BE(16), 390, 'the mobile sample is laid out at device width');
  const question = { title: `어떤 시각 스타일로 진행할까요? 비교 페이지: ${captured.comparison_page.absolute_path}`, decision_kind: 'visual_direction', recommended_option_id: 'calm', rationale: 'r', options: captured.options.map(({ id, label, previews }) => ({ id, label, consequence: label, evidence: [], previews })) };
  await assertQuestionPreviews({ session: join(root, '.io'), question });
});

test('the installed frontend-design-brief stage returns the style question only with session image samples', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 작성 화면을 만든다');
  const primaryGit = (...args) => execFileSync('git', ['-C', flow.primary, ...args], { encoding: 'utf8' }).trim();
  const lock = JSON.parse(await readFile(join(flow.primary, '.harness/harness-lock.json'), 'utf8'));
  assert.ok(lock.files[SCRIPT], 'the capture script is a managed asset');
  assert.match(primaryGit('check-ignore', '-v', SCRIPT), /info\/exclude/);
  const installedScript = join(flow.primary, SCRIPT);
  const saved = await readFile(installedScript);
  await rm(installedScript);
  assert.ok((await runDoctor({ root: flow.primary, sourceRoot })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path?.endsWith('capture-style-options.mjs')));
  await writeFile(installedScript, saved);

  const statePath = join(flow.workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const { TACTICAL_DESIGN_STAGES } = await import('../.harness/src/workflow/worktree-stages.mjs');
  for (const stage of TACTICAL_DESIGN_STAGES) state.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  Object.assign(state.stages['context-boundary'], { execution_id: 'boundary-approved', finished_at: '2026-01-01T00:00:00.000Z' });
  state.stages['tactical-technology'] = { status: 'failed', execution_id: 'previous-attempt', design_approval: { stage_id: 'context-boundary', execution_id: 'boundary-approved' } };
  state.current_stage = 'workflow-compose';
  await writeFile(statePath, JSON.stringify(state));
  await flow.runStage('tactical-technology', { files: { [`docs/implementation/${flow.planSetId}/technology.md`]: 'Node\n' } });
  await flow.runStage('tactical-ui', { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '화면 설계 필요', expectCommit: false });
  const direction = '게시글 작성 화면의 입력·오류·등록 흐름 승인';
  await codexUserPrompt(flow.workspace, direction);
  const prepared = flow.invoke(flow.workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'frontend-design-brief', '--approval-answer', direction]);
  const executionId = prepared.input.execution_id;
  const base = ['--root', flow.workspace, '--worktree-ref', flow.tree.worktree_ref, '--execution-id', executionId];
  const started = flow.invoke(flow.workspace, 'harness-native-stage.mjs', ['start', ...base, '--verbose']);
  assert.equal(started.sandbox, 'workspace-write');
  const schema = JSON.parse(await readFile(started.schema_path, 'utf8'));
  const questionSchema = schema.properties.result.properties.questions.items;
  assert.ok(questionSchema.properties.decision_kind.enum.includes('visual_direction'));
  assert.ok(questionSchema.properties.options.items.properties.previews && !questionSchema.properties.options.items.required.includes('previews'), 'previews stay optional so other questions are unchanged');
  flow.invoke(flow.workspace, 'harness-native-stage.mjs', ['bind', ...base, '--agent-id', 'designer']);

  const directory = `runtime/executions/${executionId}/style-options`;
  const session = join(flow.workspace, '.io');
  await sampleSession(session, directory);
  const submit = async (question) => {
    const result = { schema_version: 1, skill: 'frontend-design', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '시각 스타일 선택 필요', artifacts: [], questions: [{ question_id: 'style', ...question }], review_request: null, owner_stage: null, dependency_gap: null };
    await writeFile(started.output_path, JSON.stringify({ schema_version: 1, skill: 'frontend-design', status: result.status, code: result.code, result }));
    return spawnSync(process.execPath, [join(flow.workspace, '.harness/scripts/harness-native-stage.mjs'), 'finish', ...base, '--verbose'], { cwd: flow.workspace, encoding: 'utf8' });
  };
  const missing = await submit(visualQuestion(directory, [option(directory, 'calm'), { ...option(directory, 'bold'), previews: [] }]));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /option bold needs preview screenshots/);
  const absent = await submit(visualQuestion(directory, [option(directory, 'calm'), option(directory, 'absent')]));
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr + absent.stdout, /does not exist/);

  const accepted = await submit(visualQuestion(directory, [option(directory, 'calm'), option(directory, 'bold')]));
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const finished = JSON.parse(accepted.stdout);
  assert.equal(finished.code, 'USER_DECISION_REQUIRED');
  const [question] = finished.result.questions;
  assert.equal(question.question_id, `${executionId}:1`);
  assert.equal(question.decision_kind, 'visual_direction');
  assert.deepEqual(question.options.map(({ previews }) => previews.map(({ viewport }) => viewport)), [['desktop', 'mobile'], ['desktop', 'mobile']]);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).stages['frontend-design-brief'].status, 'waiting');
  assert.equal(flow.treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'samples stay in the ignored session');

  // The user's choice resumes the same stage; the new designer run receives the answer to write the brief from.
  await codexUserPrompt(flow.workspace, 'calm으로 진행');
  const resumed = flow.invoke(flow.workspace, 'harness-native-stage.mjs', ['launch', '--stage-id', 'frontend-design-brief', '--answer', JSON.stringify([{ question_id: question.question_id, answer: 'calm' }])]);
  assert.equal(resumed.answered, true);
  const answers = JSON.parse(await readFile(join(session, `runtime/executions/${resumed.execution_id}/answers.json`), 'utf8'));
  assert.match(JSON.stringify(answers), /calm/);
});
