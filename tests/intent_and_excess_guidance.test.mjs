import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('spec-me asks the reason behind each requirement with candidate intents', async () => {
  const guide = await read('.codex/internal-skills/product-spec/GUIDE.md');
  assert.match(guide, /Intent question rule/);
  assert.match(guide, /이 요구로 무엇을 지키거나 얻으려고 하나요\?/);
  assert.match(guide, /each with the sufficient level it implies/);
  assert.match(await read('.codex/internal-skills/product-spec/references/topics.md'), /Restating the feature .* is not an intent/);
});

test('the Architecture Spec review looks for excess as well as gaps', async () => {
  assert.match(await read('.codex/internal-skills/spec-review/references/review-criteria.md'), /과한 설계: .*근거하지 않은 결정·규칙·구성요소/);
  assert.match(await read('.codex/internal-skills/spec-review/GUIDE.md'), /충분한 수준을 넘는 과한 설계를 확인한다/);
  assert.match(await read('.codex/internal-skills/architecture-spec/GUIDE.md'), /의도가 요구하지 않는 동시성 제어·재시도·복구 절차·보안 강화/);
});

test('implementation review findings are limited to Spec, repository standards and unbacked additions, with DDD standards as a basis', async () => {
  const guide = await read('.codex/internal-skills/code-review/GUIDE.md');
  assert.match(guide, /지적은 세 가지뿐이다/);
  assert.match(guide, /그 밖의 구조 제안이나 더 나은 설계 의견은 지적하지 않는다/);
  assert.match(guide, /`intent_ref`는 Product Spec의 INT·BR ID나 BASELINE ID만 쓴다/);
  assert.match(await read('.harness/src/wrapper/repair.mjs'), /"\.codex\/internal-skills\/ddd-design\/",/);
});

test('the final E2E conditions are prepared once after all plans, derived by the agent, not asked during a plan', async () => {
  assert.match(await read('.codex/internal-skills/implement-wrapper/GUIDE.md'), /plan 구현 중에는 최종 E2E의 실행 조건이나 환경을 사용자에게 묻거나 정하지 않는다/);
  assert.match(await read('.codex/internal-skills/implement/GUIDE.md'), /plan 구현 단계에서는 최종 E2E 조건을 사용자에게 묻지 않는다/);
  assert.match(await read('.codex/skills/orchestrator/references/implementation.md'), /시나리오는 Spec에서 확정됐으므로 다시 작성하거나 실행 조건을 묻지 않는다/);
});

test('the final E2E is specified in spec-me and planned as the last plan, run once after approval', async () => {
  assert.match(await read('.codex/internal-skills/product-spec/references/template.md'), /13\. \*\*End-user Scenarios\*\*/);
  assert.match(await read('.codex/internal-skills/product-spec/references/topics.md'), /13\. \*\*End-user Scenarios\*\*/);
  assert.match(await read('.codex/internal-skills/architecture-spec/references/template.md'), /## 12\.7 End-to-End Execution Environment/);
  assert.match(await read('.codex/internal-skills/spec-review/references/review-criteria.md'), /Product Spec 13절 사용자 시나리오/);
  assert.match(await read('.codex/internal-skills/to-ticket/references/split.md'), /마지막 child로 `e2e` plan을 하나 둔다/);
  assert.match(await read('.codex/internal-skills/plan-review/GUIDE.md'), /마지막 `e2e` plan이 모든 기능 plan에 의존/);
  const orchestration = await read('.codex/skills/orchestrator/references/implementation.md');
  assert.match(orchestration, /마지막 `e2e` plan을 다른 plan과 같은 방식/);
  assert.match(orchestration, /사용자에게 실행 승인만 묻는다/);
  assert.doesNotMatch(orchestration, /에이전트가 승인 Product\/Architecture Specs와 parent test contract를 읽고/);
});

test('implementation never asks the user: the output schema and the result validator refuse questions', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeOutputSchema } = await import('../.harness/src/workflow/output-schema.mjs');
  const root = new URL('../', import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), 'impl-schema-'));
  try {
    const path = join(dir, 'schema.json');
    await writeOutputSchema({ root, input: { execution_id: 'implement-wrapper-1', skill: 'implement-wrapper' }, prefix: '', path });
    const schema = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(!schema.properties.code.enum.includes('USER_DECISION_REQUIRED'));
    assert.ok(!schema.properties.result.properties.code.enum.includes('USER_DECISION_REQUIRED'));
    assert.equal(schema.properties.result.properties.questions.maxItems, 0);
    const other = join(dir, 'spec-me.json');
    await writeOutputSchema({ root, input: { execution_id: 'spec-me-1', skill: 'spec-me' }, prefix: '', path: other });
    assert.ok(JSON.parse(await readFile(other, 'utf8')).properties.code.enum.includes('USER_DECISION_REQUIRED'), 'spec-me still asks');
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.match(await read('.harness/src/workflow/skill-execution.mjs'), /Implementation does not ask the user/);
  assert.match(await read('.codex/internal-skills/implement-wrapper/GUIDE.md'), /사용자에게 질문하지 않는다/);
});
