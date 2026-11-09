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
  assert.match(await read('.codex/skills/orchestrator/references/implementation.md'), /이 조건을 사용자에게 작성해 달라고 묻지 않는다/);
});
