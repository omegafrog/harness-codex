export function identifyQuestions(executionId, questions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId) || !Array.isArray(questions)) throw new Error('Invalid question batch');
  return questions.map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question) || Object.hasOwn(question, 'question_id')) throw new Error('Invalid question');
    return { ...question, question_id: `${executionId}:${index + 1}` };
  });
}

export function mergeAnswers(questions, previous, incoming) {
  if (!Array.isArray(questions) || !Array.isArray(previous) || !Array.isArray(incoming)) throw new Error('Invalid answers');
  const ids = new Set(questions.map((question) => question.question_id));
  if (ids.size !== questions.length || ids.has(undefined)) throw new Error('Invalid question IDs');
  const answers = new Map();
  for (const entry of [...previous, ...incoming]) {
    if (!entry || !ids.has(entry.question_id) || answers.has(entry.question_id) || typeof entry.answer !== 'string' || !entry.answer.trim()) throw new Error('Invalid, duplicate, or stale answer');
    answers.set(entry.question_id, entry.answer);
  }
  return { answers: [...answers].map(([question_id, answer]) => ({ question_id, answer })), complete: answers.size === ids.size };
}
