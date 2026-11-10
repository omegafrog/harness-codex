import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeClaim, writeSource } from '../.harness/src/knowledge/registry.mjs';
import { assertTechnologyQuestionEvidence } from '../.harness/src/workflow/skill-execution.mjs';
import { validateArchitectureDecision } from '../.harness/src/decision/validation.mjs';

const source = (id, tier) => ({ schema_version: 1, id, title: id, uri: `https://example.test/${id}`, publisher: 'Example', tier, authority: 'Example', independent_authority_id: id, recency: 'high', relevance: 'high', commercial_bias: 'low', primary_source: tier !== 'community', preference: 'preferred', domain_metadata: {}, discovered_at: '2026-11-10T00:00:00Z', collection_status: 'not_collected' });
const claim = (id, sourceId) => ({ schema_version: 1, id, source_id: sourceId, statement: 'INCR is atomic', locator: { section: 'INCR', excerpt: 'atomic' }, retrieved_at: '2026-11-10T00:00:00Z', context: 'cache counter', qualifiers: [] });
const evidence = (claimId) => [{ criterion: 'atomic increment', result: 'met', claim_id: claimId, source_title: 'Redis INCR', url: 'https://redis.io/docs/latest/commands/incr/', checked_at: '2026-11-10' }];
const question = (options) => ({ question_id: 'x:1', title: '캐시 저장소를 무엇으로 할까요?', decision_kind: 'technology', options, recommended_option_id: 'redis', rationale: 'r' });

// A technology question offers sourced candidates; every option cites a stored Claim that is not community-only.
test('technology questions need stored, non-community evidence on every option', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tech-evidence-'));
  try {
    await writeSource({ root, source: source('redis-docs', 'primary_technical') });
    await writeSource({ root, source: source('blog', 'community') });
    await writeClaim({ root, claim: claim('redis-incr-atomic', 'redis-docs') });
    await writeClaim({ root, claim: claim('blog-says', 'blog') });
    await assertTechnologyQuestionEvidence(root, question([{ id: 'redis', label: 'Redis', consequence: 'c', evidence: evidence('redis-incr-atomic') }, { id: 'memcached', label: 'Memcached', consequence: 'c', evidence: evidence('redis-incr-atomic') }]));
    await assert.rejects(assertTechnologyQuestionEvidence(root, question([{ id: 'redis', label: 'Redis', consequence: 'c', evidence: [] }, { id: 'b', label: 'B', consequence: 'c', evidence: evidence('redis-incr-atomic') }])), /needs evidence/);
    await assert.rejects(assertTechnologyQuestionEvidence(root, question([{ id: 'redis', label: 'Redis', consequence: 'c', evidence: evidence('missing') }, { id: 'b', label: 'B', consequence: 'c', evidence: evidence('redis-incr-atomic') }])), /not in knowledge\/claims/);
    await assert.rejects(assertTechnologyQuestionEvidence(root, question([{ id: 'redis', label: 'Redis', consequence: 'c', evidence: evidence('blog-says') }, { id: 'b', label: 'B', consequence: 'c', evidence: evidence('redis-incr-atomic') }])), /community sources/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a documented decision evaluation cites the stored Claims it rests on', () => {
  const evaluation = { option_id: 'redis', criterion_id: 'C1', result: 'met', reason: 'INCR is atomic', evidence_kind: 'documented', source: 'https://redis.io/docs/latest/commands/incr/', condition: 'Redis 7', checked_at: '2026-11-10T00:00:00Z' };
  const problems = (entry) => JSON.stringify(validateArchitectureDecision({ requirement_ids: ['R1'], options: [{ id: 'redis', description: 'Redis' }], criteria: [{ id: 'C1', requirement_id: 'R1', condition: 'atomic increment', kind: 'required', priority: 'high' }], evaluations: [entry] }, {}, { checkApproval: false }).errors);
  assert.match(problems(evaluation), /claim_ids must list the stored knowledge Claims/);
  assert.doesNotMatch(problems({ ...evaluation, claim_ids: ['redis-incr-atomic'] }), /claim_ids must list/);
});
