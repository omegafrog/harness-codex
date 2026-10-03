import { resolve } from "node:path";
import { JsonlEventWriter, projectCheckpoint, recoverEventStream, replayEventStream } from "./journal.mjs";
import { ensureDir, isWithin } from "./util.mjs";

function safePlanId(planId) {
  if (typeof planId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId)) throw new TypeError(`Unsafe plan id: ${planId}`);
  return planId;
}

export function planRuntimePaths({ root = process.cwd(), planId, runtimeRoot = "docs/plans/.runtime" } = {}) {
  const safeId = safePlanId(planId);
  const repositoryRoot = resolve(root);
  const runtimeDirectory = resolve(repositoryRoot, runtimeRoot);
  const canonicalRuntimeDirectory = resolve(repositoryRoot, "docs/plans/.runtime");
  if (!isWithin(repositoryRoot, runtimeDirectory) || runtimeDirectory !== canonicalRuntimeDirectory) throw new TypeError("Plan runtime root must be docs/plans/.runtime");
  const planDirectory = resolve(runtimeDirectory, safeId);
  return {
    root: repositoryRoot,
    runtime_directory: runtimeDirectory,
    plan_directory: planDirectory,
    events_path: resolve(planDirectory, "events.jsonl"),
    checkpoint_path: resolve(planDirectory, "checkpoint.md"),
  };
}

export async function openPlanJournal({ root = process.cwd(), planId, runtimeRoot = "docs/plans/.runtime", streamId = null } = {}) {
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
