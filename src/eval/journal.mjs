import { mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "./contracts.mjs";
import { redact } from "./util.mjs";

const activeWriters = new Set();
const activeTrajectoryWriters = new Set();
const TRAJECTORY_ACTORS = new Set(["codex", "harness", "external"]);
const TRAJECTORY_KINDS = new Set(["message", "tool_call", "tool_result", "process_event"]);
const TRAJECTORY_STATUSES = new Set(["success", "error", "denied", "cancelled"]);
const TRAJECTORY_SOURCES = new Set(["structured_event", "stdout_fallback"]);

export class JournalCorruptionError extends Error {
  constructor(kind, message, { events = [], line = null, fragment = null } = {}) {
    super(message);
    this.name = "JournalCorruptionError";
    this.kind = kind;
    this.events = events;
    this.line = line;
    this.fragment = fragment;
  }
}

function validateEnvelope(value, { streamId, kind = "event", expectedSeq }) {
  if (!value || typeof value !== "object" || value.schema_version !== SCHEMA_VERSION) return "schema_mismatch";
  if (streamId && value.stream_id !== streamId) return "stream_mismatch";
  if (!Number.isInteger(value.seq)) return "invalid_sequence";
  if (expectedSeq !== undefined && value.seq !== expectedSeq) return value.seq < expectedSeq ? "duplicate_sequence" : "sequence_gap";
  if (kind === "event" && (typeof value.type !== "string" || value.payload === undefined)) return "schema_mismatch";
  if (kind === "trajectory" && (!TRAJECTORY_ACTORS.has(value.actor) || !TRAJECTORY_KINDS.has(value.kind) || value.payload === undefined || (value.status !== undefined && !TRAJECTORY_STATUSES.has(value.status)) || !TRAJECTORY_SOURCES.has(value.source))) return "schema_mismatch";
  return null;
}

async function writeExclusiveDurable(path, content) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function quarantine(path, raw, { line, kind, message = null }) {
  const quarantineDir = `${path}.corrupt`;
  await mkdir(quarantineDir, { recursive: true });
  await syncDirectory(dirname(quarantineDir));
  const name = `${String(line).padStart(6, "0")}-${randomUUID()}.jsonl`;
  const fragmentPath = join(quarantineDir, name);
  const metadataPath = join(quarantineDir, `${name}.json`);
  await writeExclusiveDurable(fragmentPath, raw);
  await writeExclusiveDurable(metadataPath, `${JSON.stringify({ path, line, kind, ...(message ? { message } : {}), quarantined_at: new Date().toISOString() }, null, 2)}\n`);
  await syncDirectory(quarantineDir);
  return { fragment: fragmentPath, metadata: metadataPath };
}

async function rewriteValidPrefix(path, events) {
  const temporary = `${path}.recovered-${randomUUID()}`;
  await writeExclusiveDurable(temporary, events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "");
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function replayJsonlStream(path, { streamId = null, kind = "event", quarantineMalformedFinal = true } = {}) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], valid: true, corruption: null, recovered: false };
    throw error;
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events = [];
  let expectedSeq = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      const isFinal = index === lines.length - 1;
      if (isFinal && quarantineMalformedFinal) {
        const quarantineEvidence = await quarantine(path, raw, { line: index + 1, kind: "malformed_final_line", message: error.message });
        return { events, valid: false, recovered: true, corruption: { kind: "malformed_final_line", line: index + 1, ...quarantineEvidence, message: error.message } };
      }
      const quarantineEvidence = await quarantine(path, raw, { line: index + 1, kind: "malformed_line", message: error.message });
      return { events, valid: false, recovered: false, corruption: { kind: "malformed_line", line: index + 1, ...quarantineEvidence, message: error.message } };
    }
    const errorKind = validateEnvelope(value, { streamId, kind, expectedSeq });
    if (errorKind) {
      const quarantineEvidence = await quarantine(path, raw, { line: index + 1, kind: errorKind });
      return { events, valid: false, recovered: false, corruption: { kind: errorKind, line: index + 1, ...quarantineEvidence, event: value } };
    }
    events.push(value);
    expectedSeq += 1;
  }
  return { events, valid: true, recovered: false, corruption: null };
}

export const replayEventStream = (path, options = {}) => replayJsonlStream(path, { ...options, kind: "event" });
export const replayTrajectoryStream = (path, options = {}) => replayJsonlStream(path, { ...options, kind: "trajectory" });

export async function recoverEventStream(path, { streamId, checkpointPath = null } = {}) {
  const replay = await replayEventStream(path, { streamId });
  let events = replay.events;
  if (replay.corruption) {
    await rewriteValidPrefix(path, events);
    const writer = await new JsonlEventWriter(path, { streamId }).init();
    await writer.append("journal_recovered", { corruption: replay.corruption }, { critical: true });
    await writer.close();
    const repaired = await replayEventStream(path, { streamId });
    if (repaired.corruption) throw new JournalCorruptionError(repaired.corruption.kind, `Cannot recover journal: ${path}`, { events: repaired.events, line: repaired.corruption.line, fragment: repaired.corruption.fragment });
    events = repaired.events;
  }
  if (checkpointPath) await projectCheckpoint(events, checkpointPath, { streamId, corruption: replay.corruption });
  return { ...replay, events, recovered: replay.recovered || Boolean(replay.corruption) };
}

export async function recoverTrajectoryStream(path, { streamId } = {}) {
  const replay = await replayTrajectoryStream(path, { streamId });
  let events = replay.events;
  if (replay.corruption) {
    await rewriteValidPrefix(path, events);
    const writer = await new TrajectoryWriter(path, { streamId }).init();
    await writer.append({ actor: "harness", kind: "process_event", action: "trajectory_recovered", payload: { corruption: replay.corruption }, source: "structured_event" });
    await writer.close();
    const repaired = await replayTrajectoryStream(path, { streamId });
    if (repaired.corruption) throw new JournalCorruptionError(repaired.corruption.kind, `Cannot recover trajectory: ${path}`, { events: repaired.events, line: repaired.corruption.line, fragment: repaired.corruption.fragment });
    events = repaired.events;
  }
  return { ...replay, events, recovered: replay.recovered || Boolean(replay.corruption) };
}

export async function projectCheckpoint(events, checkpointPath, { streamId = null, corruption = null } = {}) {
  const last = events.at(-1);
  const body = [
    "# Checkpoint",
    "",
    `- stream_id: ${streamId || last?.stream_id || "unknown"}`,
    `- last_seq: ${last?.seq || 0}`,
    `- last_event: ${last?.type || "none"}`,
    `- recovery: ${corruption ? corruption.kind : "none"}`,
    "",
    "## Resume Projection",
    "",
    last ? `\`payload\`: ${JSON.stringify(redact(last.payload))}` : "아직 기록된 event가 없습니다.",
    "",
  ].join("\n");
  await mkdir(dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.tmp-${randomUUID()}`;
  await writeExclusiveDurable(temporary, body);
  await rename(temporary, checkpointPath);
  await syncDirectory(dirname(checkpointPath));
  return checkpointPath;
}

export class JsonlEventWriter {
  constructor(path, { streamId, schemaVersion = SCHEMA_VERSION, clock = () => new Date().toISOString() } = {}) {
    if (!streamId) throw new TypeError("streamId is required");
    if (activeWriters.has(path)) throw new Error(`A writer is already active for ${path}`);
    activeWriters.add(path);
    this.path = path;
    this.streamId = streamId;
    this.schemaVersion = schemaVersion;
    this.clock = clock;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.closed = false;
    this.needsSeparator = false;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      let content = "";
      try {
        content = await readFile(this.path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      this.needsSeparator = content.length > 0 && !content.endsWith("\n");
      const replay = await replayEventStream(this.path, { streamId: this.streamId });
      if (replay.corruption) {
        await rewriteValidPrefix(this.path, replay.events);
        this.needsSeparator = false;
      }
      this.sequence = replay.events.at(-1)?.seq || 0;
      if (replay.corruption) await this.append("journal_recovered", { corruption: replay.corruption }, { critical: true });
    } catch (error) {
      activeWriters.delete(this.path);
      throw error;
    }
    return this;
  }

  append(type, payload = {}, { critical = false, extra = {} } = {}) {
    if (this.closed) return Promise.reject(new Error("Event writer is closed"));
    this.queue = this.queue.then(async () => {
      this.sequence += 1;
      const event = { schema_version: this.schemaVersion, stream_id: this.streamId, seq: this.sequence, timestamp: this.clock(), type, payload: redact(payload), ...extra };
      const line = `${JSON.stringify(event)}\n`;
      const handle = await open(this.path, "a");
      try {
        if (this.needsSeparator) {
          await handle.write("\n", "utf8");
          this.needsSeparator = false;
        }
        await handle.write(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(this.path));
      return event;
    });
    return this.queue;
  }

  async close() {
    try {
      await this.queue;
    } finally {
      this.closed = true;
      activeWriters.delete(this.path);
    }
  }
}

export function normalizeTrajectoryRecord(record, { streamId, seq, timestamp = new Date().toISOString() } = {}) {
  if (!streamId) throw new TypeError("streamId is required");
  const normalized = { schema_version: SCHEMA_VERSION, stream_id: streamId, seq, timestamp, actor: record.actor || "codex", kind: record.kind || "message" };
  for (const key of ["correlation_id", "action", "target", "status"]) if (record[key] !== undefined) normalized[key] = redact(record[key]);
  normalized.payload = redact(record.payload ?? {});
  normalized.source = record.source || "structured_event";
  const error = validateEnvelope(normalized, { streamId, kind: "trajectory", expectedSeq: seq });
  if (error) throw new JournalCorruptionError(error, `Invalid trajectory record: ${error}`);
  return normalized;
}

export class TrajectoryWriter {
  constructor(path, { streamId, clock = () => new Date().toISOString() } = {}) {
    if (activeTrajectoryWriters.has(path)) throw new Error(`A trajectory writer is already active for ${path}`);
    activeTrajectoryWriters.add(path);
    this.path = path;
    this.streamId = streamId;
    this.clock = clock;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.closed = false;
    this.needsSeparator = false;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      let content = "";
      try {
        content = await readFile(this.path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      this.needsSeparator = content.length > 0 && !content.endsWith("\n");
      const replay = await replayTrajectoryStream(this.path, { streamId: this.streamId });
      if (replay.corruption) {
        await rewriteValidPrefix(this.path, replay.events);
        this.needsSeparator = false;
      }
      this.sequence = replay.events.at(-1)?.seq || 0;
      if (replay.corruption) {
        await this.append({ actor: "harness", kind: "process_event", action: "trajectory_recovered", payload: { corruption: replay.corruption }, source: "structured_event" });
      }
    } catch (error) {
      activeTrajectoryWriters.delete(this.path);
      throw error;
    }
    return this;
  }

  append(record) {
    if (this.closed) return Promise.reject(new Error("Trajectory writer is closed"));
    this.queue = this.queue.then(async () => {
      this.sequence += 1;
      const normalized = normalizeTrajectoryRecord(record, { streamId: this.streamId, seq: this.sequence, timestamp: this.clock() });
      const handle = await open(this.path, "a");
      try {
        await handle.write(`${this.needsSeparator ? "\n" : ""}${JSON.stringify(normalized)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(this.path));
      this.needsSeparator = false;
      return normalized;
    });
    return this.queue;
  }

  async close() {
    try {
      await this.queue;
    } finally {
      this.closed = true;
      activeTrajectoryWriters.delete(this.path);
    }
  }
}
