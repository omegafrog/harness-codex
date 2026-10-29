import { test } from 'node:test';
import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { identifyQuestions, mergeAnswers } from '../src/workflow/questions.mjs';

test('question IDs are deterministic and answers must match the current batch', () => {
  const batch = identifyQuestions('run-123', [{ question: 'A' }, { question: 'B' }]);
  deepStrictEqual(batch.map((item) => item.question_id), ['run-123:1', 'run-123:2']);
  const partial = mergeAnswers(batch, [], [{ question_id: 'run-123:2', answer: 'yes' }]);
  equal(partial.complete, false);
  equal(mergeAnswers(batch, partial.answers, [{ question_id: 'run-123:1', answer: 'no' }]).complete, true);
  throws(() => mergeAnswers(batch, partial.answers, [{ question_id: 'run-123:2', answer: 'again' }]));
  throws(() => mergeAnswers(batch, [], [{ question_id: 'old:1', answer: 'yes' }]));
  throws(() => identifyQuestions('run-123', [{ question_id: 'made-by-agent' }]));
});
