export function identifyQuestions(executionId, questions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId) || !Array.isArray(questions)) throw new Error('Invalid question batch');
  return questions.map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question) || Object.hasOwn(question, 'question_id')) throw new Error('Invalid question');
    return { ...question, question_id: `${executionId}:${index + 1}` };
  });
}

// `previous` holds answers already stored for the batch; `incoming` is one call's answers. While the batch is still
// open (`revisePending`), an incoming answer for a question that already has a stored one corrects it. Otherwise a stored
// answer is final and an incoming answer for the same question is rejected. Unknown, empty and repeated IDs inside one
// incoming batch are always rejected.
export function mergeAnswers(questions, previous, incoming, { revisePending = false } = {}) {
  if (!Array.isArray(questions) || !Array.isArray(previous) || !Array.isArray(incoming)) throw new Error('Invalid answers');
  const ids = new Set(questions.map((question) => question.question_id));
  if (ids.size !== questions.length || ids.has(undefined)) throw new Error('Invalid question IDs');
  const answers = new Map();
  const usable = (entry) => entry && ids.has(entry.question_id) && typeof entry.answer === 'string' && entry.answer.trim();
  for (const entry of previous) {
    if (!usable(entry) || answers.has(entry.question_id)) throw new Error('Invalid, duplicate, or stale answer');
    answers.set(entry.question_id, entry.answer);
  }
  const batch = new Set();
  for (const entry of incoming) {
    if (!usable(entry) || batch.has(entry.question_id) || (answers.has(entry.question_id) && !revisePending)) throw new Error('Invalid, duplicate, or stale answer');
    batch.add(entry.question_id);
    answers.set(entry.question_id, entry.answer);
  }
  return { answers: [...answers].map(([question_id, answer]) => ({ question_id, answer })), complete: answers.size === ids.size };
}
