import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryForwardReview } from '../.harness/src/wrapper/review-input.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
const entry = (role, sha, state, findings) => ({ role, context_id: `${role}-agent`, independent: true, fresh_context: true, implementation_commit_sha: sha, state, report: { findings }, review_input: { fixed_point: 'fp' } });

async function setup({ standardsFindings = [], specEvidence = 'app/rules.py:12', change = ['app/rules.py'] }) {
  const root = await mkdtemp(join(tmpdir(), 'harness-carry-'));
  git(root, 'init', '-q');
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, '.io/runtime/reviews'), { recursive: true });
  await writeFile(join(root, 'app/rules.py'), 'a\n'); await writeFile(join(root, 'app/other.py'), 'a\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'one');
  const first = git(root, 'rev-parse', 'HEAD');
  for (const file of change) await writeFile(join(root, file), 'b\n');
  git(root, 'commit', '-aqm', 'two');
  const second = git(root, 'rev-parse', 'HEAD');
  const previous = {
    review_input: { fixed_point: 'fp', implementation_commit_sha: first },
    reviews: [entry('standards', first, standardsFindings.length ? 'failed' : 'passed', standardsFindings),
      entry('spec', first, 'failed', [{ id: 'S1', kind: 'implementation_defect', severity: 'blocker', summary: 'x', evidence: specEvidence }])],
  };
  await writeFile(join(root, '.io/runtime/reviews/implementation-P-1-evidence.json'), JSON.stringify(previous));
  return { root, first, second };
}
const input = (second) => ({ fixed_point: 'fp', implementation_commit_sha: second });

test('a clean pass is carried forward when the repair only touched files the other axis cited', async () => {
  const { root, first, second } = await setup({});
  try {
    const carried = await carryForwardReview({ root, planId: 'P-1', role: 'standards', reviewInput: input(second) });
    assert.equal(carried.state, 'passed');
    assert.equal(carried.context_id, 'standards-agent');
    assert.equal(carried.implementation_commit_sha, second);
    assert.deepEqual(carried.carried_forward, { from_commit: first, delta_files: ['app/rules.py'], reason: 'repair stayed within files the other axis cited' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the carry-forward is refused when the repair touched other files, the axis had findings, or nothing changed', async () => {
  const outside = await setup({ change: ['app/rules.py', 'app/other.py'] });
  const dirty = await setup({ standardsFindings: [{ id: 'A', kind: 'implementation_defect', severity: 'major', summary: 'y', evidence: 'app/other.py:1' }] });
  try {
    await assert.rejects(carryForwardReview({ root: outside.root, planId: 'P-1', role: 'standards', reviewInput: input(outside.second) }), /also changed files the other axis did not cite: app\/other\.py/);
    await assert.rejects(carryForwardReview({ root: dirty.root, planId: 'P-1', role: 'standards', reviewInput: input(dirty.second) }), /did not pass cleanly/);
    await assert.rejects(carryForwardReview({ root: outside.root, planId: 'P-1', role: 'standards', reviewInput: input(outside.first) }), /did not change/);
    await assert.rejects(carryForwardReview({ root: outside.root, planId: 'P-1', role: 'spec', reviewInput: input(outside.second) }), /did not pass cleanly/);
  } finally { await rm(outside.root, { recursive: true, force: true }); await rm(dirty.root, { recursive: true, force: true }); }
});
