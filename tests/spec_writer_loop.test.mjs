import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runSpecWriterLoop } from '../.harness/src/workflow/spec-writer-loop.mjs';

test('runner dispatches each settled writer and resumes the same parent session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-writer-loop-'));
  try {
    const session = join(root, '.io'), prefix = join(session, 'runtime/executions/example');
    await mkdir(prefix, { recursive: true });
    const output = join(prefix, 'codex-last-message.json');
    const input = { skill: 'spec-me', execution_id: 'example', context: { worktree_ref: join(session, 'worktree.json'), plan_set_id: 'plan', provider: 'claude-code' } };
    const calls = [], events = [];
    const runParent = async (args) => {
      calls.push(args);
      const index = calls.length - 1;
      const request = index < 2 ? { skill: index ? 'architecture-spec' : 'product-spec', agent_profile: 'spec_document_writer', purpose: 'write', context_path: `runtime/input-${index}.json` } : null;
      const status = request ? 'action_required' : 'completed', code = request ? 'REVIEW_REQUIRED' : 'OK';
      await writeFile(output, JSON.stringify({ status, code, result_ref: null, result: { review_request: request } }));
      return { code: 0, sessionId: 'parent-session' };
    };
    const dispatched = [];
    const result = await runSpecWriterLoop({ root, session, input, output, prompt: 'start', runParent,
      readRequest: async ({ path }) => ({ axis: path.includes('input-0') ? 'product' : 'architecture', plan_set_id: 'plan' }),
      validateRequest: async () => {}, dispatchWriter: async (request) => { dispatched.push(request); return { status: 'completed', receipt_ref: `runtime/${request.expectedAxis}.json` }; },
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.code, 0);
    assert.deepEqual(dispatched.map((item) => item.expectedAxis), ['product', 'architecture']);
    assert.ok(dispatched.every((item) => item.expectedProvider === 'claude-code'));
    assert.equal(calls[1].resume, 'parent-session');
    assert.match(calls[1].prompt, /runtime\/product\.json/);
    assert.equal(calls[2].resume, 'parent-session');
    assert.equal(events.filter((event) => event.event === 'spec_writer_completed').length, 2);
    assert.equal(JSON.parse(await readFile(join(prefix, 'writer-request-1.json'), 'utf8')).code, 'REVIEW_REQUIRED');
    assert.equal(JSON.parse(await readFile(output, 'utf8')).code, 'OK');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner stops before dispatch when the writer request targets a different axis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-writer-mismatch-'));
  try {
    const session = join(root, '.io'), prefix = join(session, 'runtime/executions/example');
    await mkdir(prefix, { recursive: true });
    const output = join(prefix, 'codex-last-message.json');
    let dispatched = false;
    await assert.rejects(runSpecWriterLoop({ root, session, output, prompt: 'start', input: { skill: 'spec-me', execution_id: 'example', context: { plan_set_id: 'plan' } },
      runParent: async () => { await writeFile(output, JSON.stringify({ status: 'action_required', code: 'REVIEW_REQUIRED', result: { review_request: { skill: 'product-spec', agent_profile: 'spec_document_writer', context_path: 'runtime/input.json' } } })); return { code: 0, sessionId: 'parent-session' }; },
      readRequest: async () => ({ axis: 'architecture', plan_set_id: 'plan' }), validateRequest: async () => {}, dispatchWriter: async () => { dispatched = true; },
    }), /does not match/);
    assert.equal(dispatched, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner does not resume or report success after writer failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-writer-failed-'));
  try {
    const session = join(root, '.io'), prefix = join(session, 'runtime/executions/example');
    await mkdir(prefix, { recursive: true });
    const output = join(prefix, 'codex-last-message.json');
    let calls = 0;
    await assert.rejects(runSpecWriterLoop({ root, session, output, prompt: 'start', input: { skill: 'spec-me', execution_id: 'example', context: { plan_set_id: 'plan' } },
      runParent: async () => { calls++; await writeFile(output, JSON.stringify({ status: 'action_required', code: 'REVIEW_REQUIRED', result: { review_request: { skill: 'product-spec', agent_profile: 'spec_document_writer', context_path: 'runtime/input.json' } } })); return { code: 0, sessionId: 'parent-session' }; },
      readRequest: async () => ({ axis: 'product', plan_set_id: 'plan' }), validateRequest: async () => {}, dispatchWriter: async () => { throw new Error('writer failed'); },
    }), /writer failed/);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(join(prefix, 'writer-request-1.json'), 'utf8')).code, 'REVIEW_REQUIRED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted writer handoff reuses the previous attempt before resuming the parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-writer-resume-'));
  try {
    const session = join(root, '.io'), old = join(session, 'runtime/executions/previous'), current = join(session, 'runtime/executions/current');
    await mkdir(old, { recursive: true }); await mkdir(current, { recursive: true });
    const packet = { axis: 'product', plan_set_id: 'plan' };
    await writeFile(join(old, 'writer-pending.json'), JSON.stringify({ phase: 'requested', parent_session_id: 'parent-session', axis: 'product', request_path: 'runtime/writer-input/product.json', request_sha256: createHash('sha256').update(JSON.stringify(packet)).digest('hex'), provider: 'codex' }));
    const output = join(current, 'codex-last-message.json');
    let dispatched, resumed;
    await runSpecWriterLoop({ root, session, output, prompt: 'resume', resume: 'parent-session', input: { skill: 'spec-me', execution_id: 'current', context: { interrupted_execution_id: 'previous', plan_set_id: 'plan', provider: 'codex' } },
      readRequest: async () => packet, dispatchWriter: async (args) => { dispatched = args; return { status: 'completed', receipt_ref: 'runtime/receipt.json' }; },
      runParent: async (args) => { resumed = args; await writeFile(output, JSON.stringify({ status: 'action_required', code: 'USER_DECISION_REQUIRED', result: {} })); return { code: 0, sessionId: 'parent-session' }; },
    });
    assert.equal(dispatched.executionId, 'previous');
    assert.equal(resumed.resume, 'parent-session');
    assert.match(resumed.prompt, /runtime\/receipt\.json/);
    assert.equal(JSON.parse(await readFile(join(current, 'writer-pending.json'), 'utf8')).phase, 'delivered');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed parent resume retains writer completion for recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-writer-parent-failed-'));
  try {
    const session = join(root, '.io'), prefix = join(session, 'runtime/executions/example');
    await mkdir(prefix, { recursive: true });
    const output = join(prefix, 'codex-last-message.json'); let calls = 0;
    await assert.rejects(runSpecWriterLoop({ root, session, output, prompt: 'start', input: { skill: 'spec-me', execution_id: 'example', context: { plan_set_id: 'plan', provider: 'codex' } },
      runParent: async () => { if (++calls > 1) throw new Error('parent failed'); await writeFile(output, JSON.stringify({ status: 'action_required', code: 'REVIEW_REQUIRED', result: { review_request: { skill: 'product-spec', agent_profile: 'spec_document_writer', context_path: 'runtime/input.json' } } })); return { code: 0, sessionId: 'parent-session' }; },
      readRequest: async () => ({ axis: 'product', plan_set_id: 'plan' }), validateRequest: async () => {}, dispatchWriter: async () => ({ status: 'completed', receipt_ref: 'runtime/receipt.json' }),
    }), /parent failed/);
    assert.equal(JSON.parse(await readFile(join(prefix, 'writer-pending.json'), 'utf8')).phase, 'writer_completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
