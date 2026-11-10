import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpecCoverage, extractSpecContractItems } from '../.harness/src/wrapper/spec-items.mjs';
import { assembleReviews } from '../.harness/src/wrapper/review-input.mjs';

const SPEC = `# Architecture Spec

## 6.5 API Contracts

| Path | Method | Access | Behaviour |
| --- | --- | --- | --- |
| \`/calculator\` | GET/POST | Public | calculator |
| \`/posts/{postId}\` | POST (edit) | Member | edit own post |

## 6.6 Asynchronous Communication

| a | b |
| - | - |
| not | listed |

## 9.1 Authentication and Authorization

- Writes require an authenticated member
- Reads are public
  - nested detail is not an item

### Notes

- still in 9.1

# 10. Observability

- not a contract item
`;

// A Spec review answers each contract item of the Architecture Spec instead of reporting the first mismatch it notices.
test('contract sections of the Architecture Spec are listed item by item', () => {
  const items = extractSpecContractItems(SPEC);
  assert.deepEqual(items.map((item) => item.id), ['S6.5-1', 'S6.5-2', 'S9.1-1', 'S9.1-2', 'S9.1-3']);
  assert.match(items[1].text, /\/posts\/\{postId\}/);
  assert.equal(items[0].line, 7);
  assert.deepEqual(extractSpecContractItems('# Nothing\n\ntext\n'), []);
});

test('a Spec review that skips an item, lacks evidence or leaves a mismatch without a finding is refused', () => {
  const items = extractSpecContractItems(SPEC);
  const entry = (id, verdict = 'match') => ({ id, verdict, evidence: 'src/App.java:1' });
  const all = items.map((item) => entry(item.id));
  assert.doesNotThrow(() => assertSpecCoverage(items, { findings: [], checked: all }));
  assert.doesNotThrow(() => assertSpecCoverage([], { findings: [] }));
  assert.throws(() => assertSpecCoverage(items, { findings: [] }), /must return report\.checked/);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: all.slice(1) }), /did not answer 1 of 5 Spec items \(S6\.5-1\)/);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: [...all, entry('S9.9-1')] }), /not a listed Spec item/);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: all.map((item, index) => index ? item : { ...item, evidence: ' ' }) }), /needs evidence/);
  const mismatch = all.map((item, index) => index === 1 ? entry(item.id, 'mismatch') : item);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: mismatch }), /no finding that lists them in spec_items: S6\.5-2/);
  assert.doesNotThrow(() => assertSpecCoverage(items, { findings: [{ id: 'F', spec_items: ['S6.5-2'] }], checked: mismatch }));
});

test('assembling reviews applies the coverage rule to the Spec reviewer only', () => {
  const items = extractSpecContractItems(SPEC);
  const reviewInput = { implementation_commit_sha: 'c1' };
  const raw = (report) => JSON.stringify({ state: 'passed', report });
  const standards = { contextId: 'std-1', raw: raw({ findings: [] }) };
  assert.throws(() => assembleReviews({ reviewInput, standards, spec: { contextId: 'spec-1', raw: raw({ findings: [] }) }, specItems: items }), /must return report\.checked/);
  const checked = items.map((item) => ({ id: item.id, verdict: 'match', evidence: 'x:1' }));
  const evidence = assembleReviews({ reviewInput, standards, spec: { contextId: 'spec-1', raw: raw({ findings: [], checked }) }, specItems: items });
  assert.equal(evidence.reviews.length, 2);
});
