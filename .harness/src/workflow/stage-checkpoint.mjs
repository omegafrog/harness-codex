import { PlanCheckpointStore } from '../wrapper/checkpoint.mjs';

export async function writeImplementationCheckpoint({ input, status, code, envelope, verified, reason, error }) {
  let checkpoint;
  try {
    checkpoint = new PlanCheckpointStore({ root: input.workspace_root, planId: input.context.plan_id });
    if (input.context.checkpoint_path && input.context.checkpoint_path !== checkpoint.paths.checkpoint_path) throw new Error('Implementation checkpoint path does not match the runner-owned plan path');
    const previous = await checkpoint.read();
    const recorded = previous?.lifecycle_evidence?.stage_result;
    if (recorded?.execution_id !== input.execution_id || recorded.status !== status || recorded.code !== code) {
      const handoff = !verified || status !== 'completed' || code !== 'OK';
      const result = verified ? envelope.result : null;
      const artifacts = (result?.artifacts || []).map(({ base, path, kind, sha256 }) => ({ base, path, kind, ...(sha256 ? { sha256 } : {}) }));
      const changedFiles = [...new Set([...(previous?.changed_files || []), ...artifacts.filter((item) => item.base === 'workspace').map((item) => item.path)])];
      const stageResult = { execution_id: input.execution_id, status, code, result_ref: verified ? envelope.result_ref : null };
      const history = Array.isArray(previous?.lifecycle_evidence?.stage_results) ? previous.lifecycle_evidence.stage_results : [];
      await checkpoint.write({
        orchestration_state: handoff ? 'handoff-required' : 'running',
        last_completed_step: `stage-${status}-${code}`,
        changed_files: changedFiles,
        ...(!previous?.tests || previous.tests.status === 'not-run' ? { tests: { ...previous?.tests, status: 'unknown', result_ref: verified ? envelope.result_ref : null } } : {}),
        lifecycle_evidence: { ...(previous?.lifecycle_evidence || {}), stage_results: [...history, stageResult], stage_result: { ...stageResult, ...(result ? { summary: result.summary, artifacts } : {}) } },
        blocker: ['blocked', 'failed', 'cancelled'].includes(status) ? { kind: code, summary: (result?.summary || reason || error?.message || code).slice(0, 1200), unblock_condition: 'Continue from the stage result and its recovery route' } : null,
        handoff_reason: handoff ? (status === 'action_required' ? 'milestone' : 'retry') : null,
        next_action: handoff ? `Route ${code} from the stage result` : 'Continue the implementation workflow',
      });
    }
    await checkpoint.close(); checkpoint = null;
  } catch (cause) {
    throw Object.assign(new Error(`Cannot persist the implementation checkpoint: ${cause.message}`, { cause }), { checkpointFailure: true });
  } finally { if (checkpoint) await checkpoint.close().catch(() => {}); }
}

