import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';

const normalized = (text) => text.replace(/\s+/g, ' ').trim();

export function setupAnswerStatus(document) {
  const batch = document.batch;
  const missing = batch?.questions.filter(({ id }) => !Object.hasOwn(batch.received, id)).map(({ id }) => id) || [];
  const active = !['cancelled', 'configured'].includes(document.status);
  const ready = active && Boolean(batch?.call_id) && missing.length === 0;
  return { setup_id: document.setup_id, batch_id: batch?.id || null, status: active ? ready ? 'ready' : 'waiting' : document.status, missing_question_ids: missing, can_continue: ready };
}

export function publishSetupBatch(document, questions) {
  if (!document.batch || !isDeepStrictEqual(document.batch.questions, questions)) {
    document.batch = {
      id: randomUUID(), created_at: new Date().toISOString(), questions, call_id: null, received: {},
      ui_questions: questions.map((question) => ({
        title: [question.prompt, question.type === 'text' && question.current ? `현재 값: ${question.current}` : '', question.context].filter(Boolean).join('\n'),
        ...(question.options ? { options: question.options.map(({ label }) => label) } : {}),
      })),
    };
  }
  return { status: 'needs_input', setup_id: document.setup_id, batch_id: document.batch.id, pending: questions[0], questions, ui_questions: document.batch.ui_questions };
}

// The async tool returns only acceptance. Bind to the actual accepted call in this session's rollout,
// never to a guessed call ID or the first arriving reply (which could belong to an older form).
export function bindSetupUi(document, transcript, root) {
  if (['cancelled', 'configured'].includes(document.status)) return setupAnswerStatus(document);
  const batch = document.batch;
  if (!batch) throw new Error('No setup batch to bind');
  const events = transcript.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const meta = events.find(({ type }) => type === 'session_meta')?.payload;
  if (!meta || resolve(meta.cwd || '') !== root || (document.session_id && (meta.id || meta.session_id) !== document.session_id)) throw new Error('UI transcript does not match this setup session/workspace');
  const calls = events.filter(({ timestamp, type, payload }) => type === 'response_item' && payload.type === 'function_call'
    && /(?:^|\.)request_user_input_async$/.test(payload.name) && Date.parse(timestamp) >= Date.parse(batch.created_at)
    && isDeepStrictEqual(JSON.parse(payload.arguments), { questions: batch.ui_questions }));
  const accepted = calls.filter(({ payload: call }) => events.some(({ type, payload }) => type === 'response_item'
    && payload.type === 'function_call_output' && payload.call_id === call.call_id && JSON.parse(payload.output).accepted === true));
  if (accepted.length !== 1) throw new Error('Expected exactly one accepted UI call for this setup batch; do not guess or redisplay it');
  const callId = accepted[0].payload.call_id;
  if (typeof callId !== 'string' || !callId || (batch.call_id && batch.call_id !== callId)) throw new Error('UI call ID does not match the bound setup batch');
  batch.call_id = callId;
  batch.ui_items = batch.questions.map(({ id }, index) => ({ question_id: id, questionItemId: JSON.stringify(['request_user_input_async', callId, index]), title: batch.ui_questions[index].title }));
  return setupAnswerStatus(document);
}

export function recordSetupReplies(document, input) {
  if (['cancelled', 'configured'].includes(document.status)) return { ...setupAnswerStatus(document), ignored: true };
  const batch = document.batch;
  if (!batch?.call_id) throw new Error('Bind the accepted UI call before recording replies');
  const text = input.trim();
  const replies = JSON.parse(text.startsWith('<send_user_message_question_reply>')
    ? text.replace(/^<send_user_message_question_reply>\s*/, '').replace(/\s*<\/send_user_message_question_reply>$/, '') : text);
  if (!Array.isArray(replies) || !replies.length) throw new Error('Expected actual UI reply items, not a tool acceptance');
  const received = { ...batch.received };
  let ignored = 0;
  for (const reply of replies) {
    const identity = JSON.parse(reply.questionItemId);
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== 'request_user_input_async' || typeof identity[1] !== 'string' || !Number.isInteger(identity[2]) || identity[2] < 0) throw new Error('Invalid UI questionItemId');
    if (identity[1] !== batch.call_id) { ignored += 1; continue; }
    const item = batch.ui_items[identity[2]], question = batch.questions[identity[2]];
    if (!item || typeof reply.question !== 'string' || normalized(reply.question) !== normalized(item.title) || typeof reply.answer !== 'string') throw new Error('Reply does not match the displayed setup question');
    const value = question.options ? question.options.find(({ label }) => label === reply.answer)?.value : reply.answer;
    if (value === undefined) throw new Error(`Answer is not an offered label for ${question.id}; address the user message before continuing setup`);
    if (Object.hasOwn(received, question.id) && received[question.id] !== value) throw new Error(`Conflicting duplicate answer for ${question.id}`);
    received[question.id] = value;
  }
  batch.received = received;
  Object.assign(document.answers, received);
  return { ...setupAnswerStatus(document), ignored };
}
