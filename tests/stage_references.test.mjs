import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_INLINED_REFERENCE_BYTES, STAGE_REFERENCES, extractSections, referenceBlocks } from '../.harness/src/workflow/stage-references.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = '# T\n\nintro\n\n## A\n\na body\n\n### A1\n\na1 body\n\n## B\n\nb body\n\n```\n## C in fence\n```\n';

test('extractSections keeps a section up to the next heading of the same or a higher level', () => {
  assert.equal(extractSections(doc, ['^## A']), '## A\n\na body\n\n### A1\n\na1 body');
  assert.equal(extractSections(doc, ['^### A1']), '### A1\n\na1 body');
  assert.equal(extractSections(doc, ['^## A', '^## B']), '## A\n\na body\n\n### A1\n\na1 body\n\n## B\n\nb body\n\n```');
  assert.equal(extractSections(doc, [{ heading: '^## A', shallow: true }]), '## A\n\na body');
  assert.equal(extractSections(doc, ['^## C in fence']), '## C in fence\n```', 'headings in a fence count');
});

test('a section pattern that matches nothing keeps the whole file; omit drops sections', () => {
  assert.equal(extractSections(doc, ['^## Nope']), doc.trim());
  assert.equal(extractSections(doc), doc.trim());
  assert.ok(!extractSections(doc, [], ['^## B']).includes('b body'));
  assert.ok(extractSections(doc, [], ['^## B']).includes('a1 body'));
});

test('event-storming and domain-model prompts carry their always-needed references within the cap', () => {
  const events = referenceBlocks(repo, 'event-storming').join('\n');
  assert.match(events, /<reference path="\.harness\/internal-skills\/requirements-fix\/references\/template\.md">/);
  assert.match(events, /이벤트 흐름/);
  assert.match(events, /## 4\. 서브도메인 간 이벤트/);
  assert.match(events, /## 5\. hotspot/);
  assert.match(events, /<reference path="\.harness\/internal-skills\/event-storming\/references\/diagrams\.md">/);
  assert.doesNotMatch(events, /## 6\. 공통/, 'only the sections the stage fills');
  const fix = referenceBlocks(repo, 'requirements-fix').join('\n');
  assert.match(fix, /### 6\.5 조회·표시 점검/, 'requirements-fix carries the display coverage table without a read');
  assert.match(fix, /조회·표시 점검 \| `### 6\.5`/, 'and its checklist row');
  const model = referenceBlocks(repo, 'domain-model').join('\n');
  assert.match(model, /deepening\.md">/);
  assert.match(model, /## 작성 기준/);
  assert.doesNotMatch(model, /## 구형 문서/);
  assert.doesNotMatch(model, /legacy-template/);
  for (const stage of Object.keys(STAGE_REFERENCES)) {
    const blocks = referenceBlocks(repo, stage);
    assert.ok(blocks.length, `${stage} is inlined`);
    assert.ok(Buffer.byteLength(blocks.join('\n')) <= MAX_INLINED_REFERENCE_BYTES + 1024, stage);
  }
});

test('over the cap keeps only the path, a missing file is skipped, and an unlisted stage has none', async (t) => {
  assert.deepEqual(referenceBlocks(repo, 'event-storming', { limit: 100 }), []);
  assert.deepEqual(referenceBlocks(repo, 'tactical-code'), []);
  const root = await mkdtemp(join(tmpdir(), 'refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(referenceBlocks(root, 'event-storming'), [], 'no file, no block');
  const diagrams = '.harness/internal-skills/event-storming/references/diagrams.md';
  await mkdir(dirname(join(root, diagrams)), { recursive: true });
  await writeFile(join(root, diagrams), '# D\n\nbody\n');
  assert.deepEqual(referenceBlocks(root, 'event-storming'), [`<reference path="${diagrams}">`, '# D\n\nbody', '</reference>']);
});
