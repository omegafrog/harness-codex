import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SCHEMA_VERSION } from "./contracts.mjs";
import { redact } from "./util.mjs";

const activeWriters = new Set();

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
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const content = await readFile(this.path, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.stream_id === this.streamId && Number.isInteger(event.seq)) this.sequence = Math.max(this.sequence, event.seq);
        } catch {
          // Recovery and corruption classification belongs to the replay slice.
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  append(type, payload = {}, { critical = false, extra = {} } = {}) {
    if (this.closed) return Promise.reject(new Error("Event writer is closed"));
    this.queue = this.queue.then(async () => {
      this.sequence += 1;
      const event = {
        schema_version: this.schemaVersion,
        stream_id: this.streamId,
        seq: this.sequence,
        timestamp: this.clock(),
        type,
        payload: redact(payload),
        ...extra,
      };
      const line = `${JSON.stringify(event)}\n`;
      const handle = await open(this.path, "a");
      try {
        await handle.write(line, "utf8");
        if (critical) await handle.sync();
      } finally {
        await handle.close();
      }
      return event;
    });
    return this.queue;
  }

  async close() {
    await this.queue;
    this.closed = true;
    activeWriters.delete(this.path);
  }
}

export function normalizeTrajectoryRecord(record, { streamId, seq, timestamp = new Date().toISOString() } = {}) {
  if (!streamId) throw new TypeError("streamId is required");
  const normalized = {
    schema_version: SCHEMA_VERSION,
    stream_id: streamId,
    seq,
    timestamp,
    actor: record.actor || "codex",
    kind: record.kind || "message",
  };
  for (const key of ["correlation_id", "action", "target", "status"]) {
    if (record[key] !== undefined) normalized[key] = redact(record[key]);
  }
  normalized.payload = redact(record.payload ?? {});
  normalized.source = record.source || "structured_event";
  return normalized;
}

export class TrajectoryWriter {
  constructor(path, { streamId, clock = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.streamId = streamId;
    this.clock = clock;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const content = await readFile(this.path, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.stream_id === this.streamId && Number.isInteger(record.seq)) this.sequence = Math.max(this.sequence, record.seq);
        } catch {
          // The replay slice classifies malformed tails.
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  append(record) {
    if (this.closed) return Promise.reject(new Error("Trajectory writer is closed"));
    this.queue = this.queue.then(async () => {
      this.sequence += 1;
      const normalized = normalizeTrajectoryRecord(record, { streamId: this.streamId, seq: this.sequence, timestamp: this.clock() });
      await appendFile(this.path, `${JSON.stringify(normalized)}\n`, "utf8");
      return normalized;
    });
    return this.queue;
  }

  async close() {
    await this.queue;
    this.closed = true;
  }
}
