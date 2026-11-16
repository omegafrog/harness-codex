import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { identifyQuestions, mergeAnswers } from '../.harness/src/workflow/questions.mjs';
import { collectAnswers } from '../.harness/src/workflow/stage-input.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const PREFIX = 'runtime/executions/ask';
const questions = identifyQuestions('ask', [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
const [q1, q2, q3] = questions.map((question) => question.question_id);
const reply = (question_id, answer) => ({ question_id, answer });
const rejection = /Invalid, duplicate, or stale answer/;

async function session(t) {
  await mkdir(resolve(sourceRoot, '.io'), { recursive: true });
  const directory = await mkdtemp(resolve(sourceRoot, '.io/answer-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, PREFIX), { recursive: true });
  return directory;
}
const json = async (directory, file) => JSON.parse(await readFile(join(directory, PREFIX, file), 'utf8'));
const send = (collect, directory, entries, deferred) => collect(directory, PREFIX, questions, JSON.stringify(entries), deferred);

test('mergeAnswers replaces a stored answer only while the batch is open and never accepts a repeated ID in one batch', () => {
  const stored = [reply(q1, 'one'), reply(q2, 'two')];
  assert.throws(() => mergeAnswers(questions, stored, [reply(q2, 'changed')]), rejection, 'a stored answer is final by default');

  const corrected = mergeAnswers(questions, stored, [reply(q2, 'changed')], { revisePending: true });
  assert.deepEqual(corrected, { answers: [reply(q1, 'one'), reply(q2, 'changed')], complete: false });

  const finished = mergeAnswers(questions, stored, [reply(q1, 'first again'), reply(q3, 'three')], { revisePending: true });
  assert.deepEqual(finished, { answers: [reply(q1, 'first again'), reply(q2, 'two'), reply(q3, 'three')], complete: true });

  for (const options of [{}, { revisePending: true }]) {
    assert.throws(() => mergeAnswers(questions, [], [reply(q1, 'a'), reply(q1, 'b')], options), rejection, 'the same ID twice in one batch');
    assert.throws(() => mergeAnswers(questions, stored, [reply(q3, 'a'), reply(q3, 'a')], options), rejection, 'an identical repeat is still a repeat');
    assert.throws(() => mergeAnswers(questions, [], [reply('ask:99', 'a')], options), rejection, 'unknown question');
    assert.throws(() => mergeAnswers(questions, [], [reply(q1, '  ')], options), rejection, 'empty answer');
    assert.throws(() => mergeAnswers(questions, [], [reply(q1, 7)], options), rejection, 'non-string answer');
    assert.throws(() => mergeAnswers(questions, [reply(q1, 'a'), reply(q1, 'b')], [], options), rejection, 'a corrupt stored batch');
  }
  assert.throws(() => mergeAnswers(questions, stored, [reply(q2, '')], { revisePending: true }), rejection, 'a correction cannot blank an answer');
});

test('a pending answer can be corrected before the batch completes and the corrected value is the one recorded', async (t) => {
  const directory = await session(t);
  const partial = await send(collectAnswers, directory, [reply(q1, 'one'), reply(q2, 'two')]);
  assert.equal(partial.complete, false);

  const corrected = await send(collectAnswers, directory, [reply(q2, 'two, corrected')]);
  assert.equal(corrected.complete, false);
  assert.deepEqual(corrected.answers, [reply(q1, 'one'), reply(q2, 'two, corrected')]);
  assert.deepEqual(await json(directory, 'pending-answers.json'), corrected.answers);
  await assert.rejects(readFile(join(directory, PREFIX, 'decision-answers.json')), { code: 'ENOENT' }, 'no decision before the last answer');

  const done = await send(collectAnswers, directory, [reply(q3, 'three')]);
  assert.equal(done.complete, true);
  const expected = [reply(q1, 'one'), reply(q2, 'two, corrected'), reply(q3, 'three')];
  assert.deepEqual(done.answers, expected);
  assert.deepEqual(await json(directory, 'decision-answers.json'), expected);
  assert.deepEqual(await json(directory, 'pending-answers.json'), expected);
});

test('a correction may arrive in the same call that completes the batch', async (t) => {
  const directory = await session(t);
  await send(collectAnswers, directory, [reply(q1, 'one'), reply(q2, 'two')]);
  const done = await send(collectAnswers, directory, [reply(q1, 'one, corrected'), reply(q3, 'three')]);
  assert.equal(done.complete, true);
  assert.deepEqual(await json(directory, 'decision-answers.json'), [reply(q1, 'one, corrected'), reply(q2, 'two'), reply(q3, 'three')]);
});

test('one answer batch never repeats a question ID, and unknown or empty answers are still rejected while it is open', async (t) => {
  const directory = await session(t);
  await send(collectAnswers, directory, [reply(q1, 'one')]);
  for (const entries of [
    [reply(q2, 'a'), reply(q2, 'b')],
    [reply(q1, 'one'), reply(q1, 'one')],
    [reply(q1, 'changed'), reply(q1, 'changed again')],
    [reply('ask:99', 'stale')],
    [reply(q2, '')],
    [null],
  ]) await assert.rejects(send(collectAnswers, directory, entries), rejection, JSON.stringify(entries));
  await assert.rejects(collectAnswers(directory, PREFIX, questions, 'not json'), /Answers must be a JSON array/);
  assert.deepEqual(await json(directory, 'pending-answers.json'), [reply(q1, 'one')], 'a rejected batch changes nothing');
});

test('once the decision is recorded, a differing answer is rejected and the decision stays as recorded', async (t) => {
  const directory = await session(t);
  const complete = [reply(q1, 'one'), reply(q2, 'two'), reply(q3, 'three')];
  await send(collectAnswers, directory, complete);
  const decision = await readFile(join(directory, PREFIX, 'decision-answers.json'), 'utf8');

  for (const entries of [[reply(q2, 'changed')], [reply(q1, 'one'), reply(q3, 'changed')]]) {
    await assert.rejects(send(collectAnswers, directory, entries), rejection, JSON.stringify(entries));
  }
  assert.equal(await readFile(join(directory, PREFIX, 'decision-answers.json'), 'utf8'), decision);
  assert.deepEqual(await json(directory, 'pending-answers.json'), complete);

  // Sending the recorded answers again is not a revision.
  const again = await send(collectAnswers, directory, complete);
  assert.equal(again.complete, true);
  assert.equal(await readFile(join(directory, PREFIX, 'decision-answers.json'), 'utf8'), decision);
});

test('answers queued while the stage ran fill unanswered questions, are corrected by a later answer and never undo a correction', async (t) => {
  const directory = await session(t);
  const queued = [reply(q1, 'queued one'), reply(q2, 'queued two')];

  const first = await collectAnswers(directory, PREFIX, questions, null, queued);
  assert.deepEqual(first.answers, queued);
  assert.equal(first.complete, false);

  // The user corrects a queued answer: the correction wins even though the queue file still holds the old value.
  const corrected = await send(collectAnswers, directory, [reply(q2, 'corrected two')], queued);
  assert.deepEqual(corrected.answers, [reply(q1, 'queued one'), reply(q2, 'corrected two')]);

  // The stale queue entry must not revert it when the last answer arrives.
  const done = await send(collectAnswers, directory, [reply(q3, 'three')], queued);
  assert.equal(done.complete, true);
  assert.deepEqual(await json(directory, 'decision-answers.json'), [reply(q1, 'queued one'), reply(q2, 'corrected two'), reply(q3, 'three')]);

  // After the decision a queued answer that differs from it is a conflict, as before.
  await assert.rejects(send(collectAnswers, directory, [reply(q2, 'again')], queued), /Conflicting deferred answer/);
  await assert.rejects(collectAnswers(directory, PREFIX, questions, null, [reply(q1, 'late queue')]), rejection);
});

test('a queued answer is replaced by an answer for the same question sent before any stored answer exists', async (t) => {
  const directory = await session(t);
  const result = await send(collectAnswers, directory, [reply(q1, 'sent one')], [reply(q1, 'queued one'), reply(q2, 'queued two')]);
  assert.deepEqual(result.answers, [reply(q2, 'queued two'), reply(q1, 'sent one')]);
  await assert.rejects(send(collectAnswers, directory, [reply(q3, 'a'), reply(q3, 'b')], [reply(q1, 'queued one')]), rejection);
});

test('an installed consumer revises a pending answer through the managed files and keeps Git status clean of Harness files', async (t) => {
  await mkdir(resolve(sourceRoot, '.io'), { recursive: true });
  const root = await mkdtemp(resolve(sourceRoot, '.io/answer-revision-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'app.txt'), 'original application\n');
  git('add', 'app.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'app.txt'), 'ongoing application change\n');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });

  for (const path of ['.harness/src/workflow/questions.mjs', '.harness/src/workflow/stage-input.mjs']) {
    assert.equal(await readFile(join(root, path), 'utf8'), await readFile(join(sourceRoot, path), 'utf8'), `installed: ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
  }
  const installed = await import(pathToFileURL(join(root, '.harness/src/workflow/stage-input.mjs')));
  const directory = join(root, '.io/answers-session');
  await mkdir(join(directory, PREFIX), { recursive: true });

  await send(installed.collectAnswers, directory, [reply(q1, 'one'), reply(q2, 'two')]);
  const corrected = await send(installed.collectAnswers, directory, [reply(q1, 'one, corrected')]);
  assert.deepEqual(corrected.answers, [reply(q1, 'one, corrected'), reply(q2, 'two')]);
  const done = await send(installed.collectAnswers, directory, [reply(q3, 'three')]);
  assert.equal(done.complete, true);
  assert.deepEqual(await json(directory, 'decision-answers.json'), [reply(q1, 'one, corrected'), reply(q2, 'two'), reply(q3, 'three')]);
  await assert.rejects(send(installed.collectAnswers, directory, [reply(q2, 'changed')]), rejection);

  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /^ M app\.txt$/m, 'application changes stay visible and untouched');
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, 'Harness-managed and generated files stay out of commits');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'ongoing application change\n');
});
