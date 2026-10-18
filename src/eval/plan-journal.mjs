import { sessionDirectory, sessionOutputPath } from "../workflow/session-output.mjs";
import { resolve } from "node:path";
import { JsonlEventWriter, projectCheckpoint, recoverEventStream, replayEventStream } from "./journal.mjs";
import { ensureDir } from "./util.mjs";

function safePlanId(planId) {
  if (typeof planId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId)) throw new TypeError(`Unsafe plan id: ${planId}`);
  return planId;
}

export function planRuntimePaths({ root = process.cwd(), planId, runtimeRoot = null } = {}) {
  const safeId = safePlanId(planId);
  const repositoryRoot = resolve(root);
  const runtimeDirectory = sessionOutputPath(repositoryRoot, "runtime/plans");
  if (runtimeRoot !== null && resolve(runtimeRoot) !== runtimeDirectory) throw new TypeError("Plan runtime root must remain inside the session directory");
  const planDirectory = sessionOutputPath(repositoryRoot, `runtime/plans/${safeId}`);
  return {
    root: repositoryRoot,
    session_directory: sessionDirectory(repositoryRoot),
    runtime_directory: runtimeDirectory,
    plan_directory: planDirectory,
    events_path: resolve(planDirectory, "events.jsonl"),
    checkpoint_path: resolve(planDirectory, "checkpoint.md"),
  };
}

export async function openPlanJournal({ root = process.cwd(), planId, runtimeRoot = null, streamId = null } = {}) {
  const paths = planRuntimePaths({ root, planId, runtimeRoot });
  await ensureDir(paths.plan_directory);
  const resolvedStreamId = streamId || `plan-${planId}`;
  const initialReplay = await replayEventStream(paths.events_path, { streamId: resolvedStreamId });
  let recoveryEvidence = initialReplay.corruption;
  const journal = await new JsonlEventWriter(paths.events_path, { streamId: resolvedStreamId }).init();
  return {
    ...paths,
    stream_id: resolvedStreamId,
    append: (type, payload = {}, options = {}) => journal.append(type, payload, options),
    replay: () => replayEventStream(paths.events_path, { streamId: resolvedStreamId }),
    checkpoint: async (options = {}) => {
      const replay = await replayEventStream(paths.events_path, { streamId: resolvedStreamId });
      recoveryEvidence ||= replay.corruption;
      return projectCheckpoint(replay.events, paths.checkpoint_path, { streamId: resolvedStreamId, corruption: recoveryEvidence, ...options });
    },
    close: async () => {
      await journal.close();
      const replay = await replayEventStream(paths.events_path, { streamId: resolvedStreamId });
      recoveryEvidence ||= replay.corruption;
      const recovered = replay.corruption
        ? await recoverEventStream(paths.events_path, { streamId: resolvedStreamId })
        : replay;
      await projectCheckpoint(recovered.events, paths.checkpoint_path, { streamId: resolvedStreamId, corruption: recoveryEvidence });
      return recovered.events;
    },
  };
}
