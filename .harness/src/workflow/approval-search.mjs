// What a refused approval says about the provider transcript it searched. Pure text and data, no file access, so the
// runner's error explanations can use it without loading the transcript reader.
export const clip = (value, size = 120) => { const text = String(value ?? ''); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };

const PROBLEMS = {
  sent_before_gate: 'it was sent before the gate it must follow',
  sent_after_window: 'it was sent after the allowed window',
  other_workspace: 'it was sent while the conversation worked in another directory',
};
const article = (noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
const FORMS = { plain_user_message: 'plain user message', orchestrator_request: 'orchestrator request', form_reply: 'form reply' };

// One English sentence for the refusal: where the search looked, what it found and why the nearest candidate failed.
export function describeReplySearch(search, { gate = 'the gate' } = {}) {
  const owner = search.owner ? `${search.owner.provider} session ${search.owner.session_id}` : 'no registered owner conversation';
  const target = `the ${search.provider || 'provider'} owner conversation transcript${search.transcript ? ` ${search.transcript}` : ''}${search.session_id ? ` (session ${search.session_id})` : ''}`;
  const looked = `a user message sent after ${gate} (${search.since}${search.until ? ` until ${search.until}` : ''}) whose text is exactly ${JSON.stringify(search.wanted)}`;
  switch (search.outcome) {
    case 'empty_answer': return 'no approval answer text was passed, and a bare flag is not approval';
    case 'invalid_window': return `the search window is invalid (since ${search.since}${search.until ? `, until ${search.until}` : ''})`;
    case 'no_worktree_record': return 'the worktree record `.io/worktree.json` is missing or unreadable, so the owner conversation is unknown';
    case 'no_owner_session': return 'the worktree record registers no orchestrator conversation to read the reply from';
    case 'not_owner_session': return `this conversation (${search.provider} session ${search.session_id}) is not the registered owner (${owner}); only the owner conversation's transcript is read`;
    case 'invalid_session_id': return `the owner session id ${JSON.stringify(search.session_id)} is not a valid conversation id`;
    case 'no_transcript': return `searched for ${target} to find ${looked}, but no transcript file exists for that session`;
    case 'unreadable_transcript': return `searched ${target} for ${looked}, but the file cannot be read as a plain single-link transcript`;
    case 'not_root_session': return `searched ${target} for ${looked}, but it is not the root transcript of that session (a subagent or foreign conversation)`;
    case 'matched': return `found ${looked}`;
    default: {
      const found = (search.candidates || []).map((candidate) => `${article(FORMS[candidate.form] || candidate.form)} at ${candidate.at} with exactly that text, but ${candidate.problems.map((problem) => PROBLEMS[problem] || problem).join(' and ')}`);
      const { orchestrator_requests: requests = 0, plain_user_messages: plain = 0, form_replies: forms = 0 } = search.counts || {};
      return `searched ${target} for ${looked}; ${found.length ? `found ${found.join('; ')}` : `found no message with that text. In that window the user sent ${requests} orchestrator request(s), ${plain} plain message(s) and ${forms} form reply(ies), none equal to it`}`;
    }
  }
}

const SHORT_PROBLEMS = { sent_before_gate: 'predates the gate', sent_after_window: 'is outside the allowed window', other_workspace: 'was sent from another directory' };

// The same finding in one short clause, for the `why` of a refusal that already carries the full description.
export function summarizeReplySearch(search) {
  if (search.outcome !== 'no_matching_message') return describeReplySearch(search);
  const found = (search.candidates || []).map((candidate) => `${article(FORMS[candidate.form] || candidate.form)} at ${candidate.at} with exactly that text ${candidate.problems.map((problem) => SHORT_PROBLEMS[problem] || problem).join(' and ')}`);
  const { orchestrator_requests: requests = 0, plain_user_messages: plain = 0, form_replies: forms = 0 } = search.counts || {};
  return found.length ? found.join('; ') : `no user message in the window equals the reply passed (${requests} orchestrator request(s), ${plain} plain message(s), ${forms} form reply(ies))`;
}

export function approvalRefusal(prefix, reason, search = null) {
  return Object.assign(new Error(`${prefix}: ${reason}`), search ? { approval_search: search } : {});
}
