import { resolve } from "node:path";
import { JsonlEventWriter, projectCheckpoint, replayEventStream } from "./journal.mjs";
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
  const journal = await new JsonlEventWriter(paths.events_path, { streamId: streamId || `plan-${planId}` }).init();
  return {
    ...paths,
    stream_id: streamId || `plan-${planId}`,
    append: (type, payload = {}, options = {}) => journal.append(type, payload, options),
    replay: () => replayEventStream(paths.events_path, { streamId: streamId || `plan-${planId}` }),
    checkpoint: async (options = {}) => {
      const replay = await replayEventStream(paths.events_path, { streamId: streamId || `plan-${planId}` });
      if (replay.corruption) throw new Error(`Cannot project corrupt plan journal: ${replay.corruption.kind}`);
      return projectCheckpoint(replay.events, paths.checkpoint_path, { streamId: streamId || `plan-${planId}`, ...options });
    },
    close: async () => {
      await journal.close();
      return projectCheckpoint(await journalReplay(paths.events_path, streamId || `plan-${planId}`), paths.checkpoint_path, { streamId: streamId || `plan-${planId}` });
    },
  };
}

async function journalReplay(path, streamId) {
  const replay = await replayEventStream(path, { streamId });
  if (replay.corruption) throw new Error(`Cannot project corrupt plan journal: ${replay.corruption.kind}`);
  return replay.events;
}
