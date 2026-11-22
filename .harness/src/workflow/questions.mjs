export function identifyQuestions(executionId, questions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId) || !Array.isArray(questions)) throw new Error('Invalid question batch');
  return questions.map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question) || Object.hasOwn(question, 'question_id')) throw new Error('Invalid question');
    return { ...question, question_id: `${executionId}:${index + 1}` };
  });
}

export function isQuestionResponse(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2) return false;
  return Object.hasOwn(entry, 'question_id') && typeof entry.question_id === 'string' && Boolean(entry.question_id.trim())
    && ['answer', 'clarification'].some((key) => Object.hasOwn(entry, key) && typeof entry[key] === 'string' && entry[key].trim());
}

// An open batch keeps one response per question. A clarification leaves that decision pending until an answer
// replaces it. A finalized batch accepts only answers. Unknown, empty and repeated IDs in a batch are rejected.
export function mergeAnswers(questions, previous, incoming, { revisePending = false } = {}) {
  if (!Array.isArray(questions) || !Array.isArray(previous) || !Array.isArray(incoming)) throw new Error('Invalid answers');
  const ids = new Set(questions.map((question) => question.question_id));
  if (ids.size !== questions.length || ids.has(undefined)) throw new Error('Invalid question IDs');
  const responses = new Map();
  const usable = (entry) => isQuestionResponse(entry) && ids.has(entry.question_id) && (revisePending || Object.hasOwn(entry, 'answer'));
  for (const entry of previous) {
    if (!usable(entry) || responses.has(entry.question_id)) throw new Error('Invalid, duplicate, or stale answer');
    responses.set(entry.question_id, entry);
  }
  const batch = new Set();
  for (const entry of incoming) {
    if (!usable(entry) || batch.has(entry.question_id) || (responses.has(entry.question_id) && !revisePending)) throw new Error('Invalid, duplicate, or stale answer');
    batch.add(entry.question_id);
    responses.set(entry.question_id, entry);
  }
  const answers = [...responses.values()].filter((entry) => Object.hasOwn(entry, 'answer')).map(({ question_id, answer }) => ({ question_id, answer }));
  const clarifications = [...responses.values()].filter((entry) => Object.hasOwn(entry, 'clarification')).map(({ question_id, clarification }) => ({ question_id, clarification }));
  return { answers, complete: answers.length === ids.size, ...(clarifications.length ? { clarifications } : {}) };
}
