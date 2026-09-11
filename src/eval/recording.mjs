import { open, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { EvalInconclusiveError, EvalPolicyViolationError } from "./errors.mjs";
import { SCHEMA_VERSION } from "./contracts.mjs";
import { canonicalJson, ensureDir, redact } from "./util.mjs";

const MUTATING_OPERATIONS = new Set([
  "create_issue",
  "update_issue",
  "create_pull_request",
  "update_pull_request",
  "merge_pull_request",
  "close_issue",
  "set_status",
  "delete",
  "write",
  "send",
]);
const READ_ONLY_OPERATIONS = new Set([
  "read_issue",
  "read_pull_request",
  "read_context",
  "read_file",
  "get_status",
  "list_issues",
  "list_pull_requests",
  "search_issues",
  "search_pull_requests",
]);

export function normalizeRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("External request must be an object");
  const normalized = {
    system: request.system,
    operation: request.operation,
    target: request.target || {},
    intent: request.intent || request.operation,
    payload: request.payload || {},
  };
  const inferredMutation = MUTATING_OPERATIONS.has(request.operation) || !READ_ONLY_OPERATIONS.has(request.operation);
  normalized.mutation = inferredMutation || request.mutation === true;
  if (typeof normalized.system !== "string" || typeof normalized.operation !== "string") throw new TypeError("External request needs system and operation");
  return redact(normalized);
}

function key(value) {
  return JSON.stringify(canonicalJson(value));
}

function isNormalizedJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isNormalizedJson);
  if (value && typeof value === "object") return Object.values(value).every(isNormalizedJson);
  return false;
}

function normalizeResponse(response, context) {
  if (!isNormalizedJson(response)) throw new EvalInconclusiveError("corrupted_external_response", `External response is not normalized JSON: ${context}`);
  return redact(response);
}

function matchesTarget(policyTarget, requestTarget) {
  if (!policyTarget || typeof policyTarget !== "object" || Array.isArray(policyTarget)
    || !requestTarget || typeof requestTarget !== "object" || Array.isArray(requestTarget)) return false;
  return Object.entries(policyTarget).every(([key, value]) => {
    if (!(key in requestTarget)) return false;
    if (value && typeof value === "object" && !Array.isArray(value)) return matchesTarget(value, requestTarget[key]);
    return requestTarget[key] === value;
  });
}

function isDedicatedIntegrationRequest(request, resource) {
  return resource?.dedicated === true
    && typeof resource.system === "string"
    && typeof resource.resource_id === "string"
    && resource.resource_id.length > 0
    && request.system === resource.system
    && matchesTarget(resource.target, request.target);
}

async function loadRecordings(path) {
  const records = [];
  try {
    const content = await readFile(path, "utf8");
    let expectedSeq = 1;
    let streamId = null;
    for (const [index, line] of content.split("\n").entries()) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new EvalInconclusiveError("corrupted_fixture", `Malformed recording line ${index + 1}`, { path, cause: error });
      }
      if (record.schema_version !== SCHEMA_VERSION || !record.stream_id || !Number.isInteger(record.seq) || record.seq !== expectedSeq || !record.request || record.response === undefined) {
        const reason = record.seq === expectedSeq ? "corrupted_fixture" : "corrupted_recording_sequence";
        throw new EvalInconclusiveError(reason, `Invalid recording line ${index + 1}`, { path, expected_seq: expectedSeq, actual_seq: record.seq });
      }
      if (streamId && record.stream_id !== streamId) throw new EvalInconclusiveError("corrupted_recording_stream", `Recording stream mismatch at line ${index + 1}`, { path, stream_id: record.stream_id, expected_stream_id: streamId });
      streamId ||= record.stream_id;
      let normalizedRequest;
      try {
        normalizedRequest = normalizeRequest(record.request);
      } catch (error) {
        throw new EvalInconclusiveError("corrupted_fixture", `Invalid recording request at line ${index + 1}`, { path, cause: error });
      }
      records.push({ request: normalizedRequest, response: normalizeResponse(record.response, `recording line ${index + 1}`) });
      expectedSeq += 1;
    }
  } catch (error) {
    if (error.code === "ENOENT") throw new EvalInconclusiveError("missing_external_recording", `Recording not found: ${path}`, { path });
    throw error;
  }
  return records;
}

export async function validateRecordingFixture(path) {
  await loadRecordings(path);
  return true;
}

export class ExternalSystemPort {
  constructor({ mode = "none", fixture = null, runtimePath = null, integration = false, integrationResource = null, liveAdapter = null, onEvent = () => {} } = {}) {
    if (!["none", "replay", "live"].includes(mode)) throw new TypeError(`Invalid recording mode: ${mode}`);
    if (mode === "live" && !integration) throw new EvalInconclusiveError("invalid_case_manifest", "Live external adapter requires explicit integration");
    if (mode === "live" && integration && (!integrationResource || integrationResource.dedicated !== true || typeof integrationResource.resource_id !== "string" || !integrationResource.resource_id || typeof integrationResource.system !== "string" || !integrationResource.system || !integrationResource.target || typeof integrationResource.target !== "object" || Array.isArray(integrationResource.target) || Object.keys(integrationResource.target).length === 0)) throw new EvalInconclusiveError("invalid_case_manifest", "Live integration requires a dedicated integration resource");
    this.mode = mode;
    this.fixture = fixture;
    this.runtimePath = runtimePath;
    this.integration = integration;
    this.integrationResource = integrationResource;
    this.liveAdapter = liveAdapter;
    this.onEvent = onEvent;
    this.records = null;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.descriptor = { mode, fixture, mutation: "deny-by-default", integration, integration_resource: integrationResource };
  }

  async init() {
    if (this.mode === "replay") this.records = await loadRecordings(this.fixture);
    if (this.runtimePath) await ensureDir(dirname(this.runtimePath));
    return this;
  }

  record(request, response) {
    this.queue = this.queue.then(async () => {
      const normalizedRequest = normalizeRequest(request);
      const record = { schema_version: SCHEMA_VERSION, stream_id: "recording", seq: ++this.sequence, timestamp: new Date().toISOString(), request: normalizedRequest, response: normalizeResponse(response, `${normalizedRequest.system}.${normalizedRequest.operation}`) };
      if (this.runtimePath) {
        const handle = await open(this.runtimePath, "a");
        try {
          await handle.write(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const directory = await open(dirname(this.runtimePath), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return record;
    });
    return this.queue;
  }

  async replay(request) {
    const normalizedRequest = normalizeRequest(request);
    const found = this.records?.find((record) => key(record.request) === key(normalizedRequest));
    if (!found) {
      await this.onEvent({ type: "external_port_error", payload: { request: normalizedRequest, reason: "missing_external_recording" }, mode: "continue" });
      throw new EvalInconclusiveError("missing_external_recording", `Recording mismatch for ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest });
    }
    await this.onEvent({ type: "external_replay", payload: { request: normalizedRequest, response: found.response } });
    await this.record(normalizedRequest, found.response);
    return found.response;
  }

  async execute(request) {
    const normalizedRequest = normalizeRequest(request);
    const liveResourceRequest = this.mode !== "live"
      || !this.integration
      || isDedicatedIntegrationRequest(normalizedRequest, this.integrationResource);
    if (!liveResourceRequest) {
      const reason = normalizedRequest.mutation ? "unauthorized_external_mutation" : "security_boundary_violation";
      await this.onEvent({ type: "unauthorized_external_access", payload: { request: normalizedRequest, reason }, mode: "fail_fast" });
      throw new EvalPolicyViolationError(reason, `External request is outside the dedicated integration resource: ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest });
    }
    if (normalizedRequest.mutation && !(this.mode === "live" && this.integration)) {
      await this.onEvent({ type: "unauthorized_external_mutation", payload: { request: normalizedRequest }, mode: "fail_fast" });
      throw new EvalPolicyViolationError("unauthorized_external_mutation", `External mutation denied: ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest });
    }
    if (this.mode === "replay") return this.replay(normalizedRequest);
    if (this.mode === "live") {
      if (!this.integration || typeof this.liveAdapter !== "function") {
        await this.onEvent({ type: "external_port_error", payload: { request: normalizedRequest, reason: "missing_external_recording" }, mode: "continue" });
        throw new EvalInconclusiveError("missing_external_recording", "Live adapter is not configured");
      }
      try {
        const response = await this.liveAdapter(normalizedRequest);
        return this.record(normalizedRequest, response).then((record) => record.response);
      } catch (error) {
        await this.onEvent({ type: "external_port_error", payload: { request: normalizedRequest, reason: "external_provider_error" }, mode: "continue" });
        throw new EvalInconclusiveError("external_provider_error", `External provider failed for ${normalizedRequest.system}.${normalizedRequest.operation}`, { request: normalizedRequest, cause: error });
      }
    }
    const response = { ok: true, mode: "stub", system: normalizedRequest.system, operation: normalizedRequest.operation };
    await this.onEvent({ type: "external_stub", payload: { request: normalizedRequest, response } });
    const record = await this.record(normalizedRequest, response);
    return record.response;
  }
}

class SystemScopedAdapter extends ExternalSystemPort {
  constructor(system, options = {}) {
    super(options);
    this.system = system;
  }

  normalizeSystemRequest(request) {
    const normalized = normalizeRequest(request);
    if (normalized.system !== this.system) throw new EvalInconclusiveError("external_system_mismatch", `Adapter ${this.system} cannot handle ${normalized.system}`);
    return normalized;
  }

  async execute(request) {
    return super.execute(this.normalizeSystemRequest(request));
  }

  async record(request, response) {
    return super.record(this.normalizeSystemRequest(request), response);
  }

  async replay(request) {
    return super.replay(this.normalizeSystemRequest(request));
  }
}

export class GitHubStub extends SystemScopedAdapter {
  constructor(options = {}) {
    super("github", { ...options, mode: "none" });
  }
}

export class MCPStub extends SystemScopedAdapter {
  constructor(options = {}) {
    super("mcp", { ...options, mode: "none" });
  }
}

export class GitHubRecordingAdapter extends SystemScopedAdapter {
  constructor(options = {}) {
    super("github", options);
  }
}

export class MCPRecordingAdapter extends SystemScopedAdapter {
  constructor(options = {}) {
    super("mcp", options);
  }
}

export class ExplicitIntegrationAdapter extends SystemScopedAdapter {
  constructor(options = {}) {
    const system = options.system || options.integrationResource?.system;
    if (typeof system !== "string" || !system) throw new TypeError("Explicit integration adapter requires a system");
    super(system, { ...options, mode: "live", integration: true });
  }
}

export class RoutedExternalSystemPort extends ExternalSystemPort {
  constructor(options = {}) {
    super(options);
    const adapterOptions = { ...options, runtimePath: null };
    if (options.mode === "live") {
      this.adapters = new Map([[options.integrationResource?.system, new ExplicitIntegrationAdapter(adapterOptions)]]);
    } else {
      const Adapter = options.mode === "none" ? GitHubStub : GitHubRecordingAdapter;
      const MpcAdapter = options.mode === "none" ? MCPStub : MCPRecordingAdapter;
      this.adapters = new Map([
        ["github", new Adapter(adapterOptions)],
        ["mcp", new MpcAdapter(adapterOptions)],
      ]);
    }
    this.descriptor = { ...this.descriptor, routed_adapters: [...this.adapters.keys()] };
  }

  async init() {
    await super.init();
    for (const adapter of this.adapters.values()) adapter.records = this.records;
    return this;
  }

  adapterFor(request) {
    return this.adapters.get(request.system) || null;
  }

  async execute(request) {
    const normalized = normalizeRequest(request);
    const adapter = this.adapterFor(normalized);
    if (!adapter) return super.execute(normalized);
    const response = await adapter.execute(normalized);
    await super.record(normalized, response);
    return response;
  }

  async replay(request) {
    const normalized = normalizeRequest(request);
    const adapter = this.adapterFor(normalized);
    if (!adapter) return super.replay(normalized);
    const response = await adapter.replay(normalized);
    await super.record(normalized, response);
    return response;
  }
}

export class ExternalPortSubprocess {
  constructor({ command, cwd = process.cwd(), env = {}, mode = "none", fixture = null, integration = false, integrationResource = null, startupTimeoutMs = 5000, requestTimeoutMs = 10000, closeGraceMs = 1000 } = {}) {
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) throw new TypeError("External port command must be a non-empty string array");
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.mode = mode;
    this.fixture = fixture;
    this.integration = integration;
    this.integrationResource = integrationResource;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeGraceMs = closeGraceMs;
    this.pending = new Map();
    this.buffer = "";
    this.child = null;
    this.closed = false;
    this.expectedClose = false;
    this.unexpectedExit = null;
    this.ready = false;
    this.startupResolve = null;
    this.startupReject = null;
    this.closePromise = null;
    this.descriptor = { mode, fixture, mutation: "deny-by-default", integration, integration_resource: integrationResource, transport: "subprocess", command };
  }

  async init() {
    const startup = new Promise((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    this.child = spawn(this.command[0], this.command.slice(1), { cwd: this.cwd, env: this.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.resume();
    const processError = (error) => new EvalInconclusiveError("external_provider_error", `External port process failed: ${error.message}`, { cause: error });
    this.child.once("error", (error) => {
      const classified = processError(error);
      if (!this.ready) {
        this.startupReject?.(classified);
        this.startupReject = null;
      }
      this.failPending(classified);
    });
    this.child.once("close", (code, signal) => {
      this.closed = true;
      const classified = new EvalInconclusiveError("external_provider_error", `External port process exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`);
      if (!this.expectedClose && this.ready) this.unexpectedExit = classified;
      if (!this.ready) {
        this.startupReject?.(classified);
        this.startupReject = null;
      }
      this.failPending(classified);
    });
    this.startupTimer = setTimeout(() => {
      const classified = new EvalInconclusiveError("external_provider_error", "External port process did not become ready");
      this.startupReject?.(classified);
      this.startupReject = null;
      void this.close();
    }, this.startupTimeoutMs).unref();
    return startup.finally(() => {
      clearTimeout(this.startupTimer);
      this.startupResolve = null;
      this.startupReject = null;
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        const classified = new EvalInconclusiveError("corrupted_external_response", "External port returned malformed JSON", { cause: error });
        if (!this.ready) {
          this.startupReject?.(classified);
          this.startupReject = null;
        }
        this.failPending(classified);
        continue;
      }
      if (response.type === "ready") {
        this.ready = true;
        this.startupResolve?.(this);
        this.startupResolve = null;
        continue;
      }
      const requestId = response.request_id || this.pending.keys().next().value;
      const pending = this.pending.get(requestId);
      if (!pending) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      if (response.ok === true) pending.resolve(response.response);
      else {
        const reason = response.reason || "external_provider_error";
        const ErrorType = ["unauthorized_external_mutation", "security_boundary_violation"].includes(reason) ? EvalPolicyViolationError : EvalInconclusiveError;
        pending.reject(new ErrorType(reason, response.message || reason));
      }
    }
  }

  failPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  execute(request) {
    if (this.unexpectedExit) return Promise.reject(this.unexpectedExit);
    if (!this.ready || this.closed || !this.child || this.child.stdin.destroyed) return Promise.reject(new EvalInconclusiveError("external_provider_error", "External port process is unavailable"));
    const requestId = `external-${randomUUID()}`;
    const normalizedRequest = normalizeRequest(request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        reject(new EvalInconclusiveError("external_provider_error", "External port request timed out"));
      }, this.requestTimeoutMs).unref();
      this.pending.set(requestId, { resolve, reject, timer });
      const line = `${JSON.stringify({ request_id: requestId, request: normalizedRequest })}\n`;
      this.child.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new EvalInconclusiveError("external_provider_error", `Unable to send external request: ${error.message}`, { cause: error }));
      });
    });
  }

  async record() {}

  replay(request) {
    return this.execute(request);
  }

  async close() {
    if (!this.child) return;
    if (this.closed) {
      if (this.unexpectedExit) throw this.unexpectedExit;
      return;
    }
    if (this.closePromise) return this.closePromise;
    this.expectedClose = true;
    this.closePromise = new Promise((resolve, reject) => {
      let terminateTimer;
      let killTimer;
      let timeoutTimer;
      const finish = () => {
        clearTimeout(terminateTimer);
        clearTimeout(killTimer);
        clearTimeout(timeoutTimer);
        this.closed = true;
        resolve();
      };
      this.child.once("close", finish);
      this.child.stdin.end();
      terminateTimer = setTimeout(() => {
        try { this.child.kill("SIGTERM"); } catch { /* The process may have exited between EOF and cleanup. */ }
        killTimer = setTimeout(() => {
          if (this.closed) return;
          try { this.child.kill("SIGKILL"); } catch { /* Preserve cleanup completion when the process is already gone. */ }
          timeoutTimer = setTimeout(() => {
            if (this.closed) return;
            reject(new EvalInconclusiveError("external_provider_error", "External port process did not terminate after SIGKILL"));
          }, this.closeGraceMs).unref();
        }, this.closeGraceMs).unref();
      }, this.closeGraceMs).unref();
    });
    return this.closePromise;
  }
}

export function createExternalSystemPort(options = {}) {
  if (options.subprocessCommand) return new ExternalPortSubprocess({ ...options, command: options.subprocessCommand, cwd: options.subprocessCwd, env: options.subprocessEnv });
  if (options.mode === "live") return new ExplicitIntegrationAdapter(options);
  if (options.system === "github") return options.mode === "none" ? new GitHubStub(options) : new GitHubRecordingAdapter(options);
  if (options.system === "mcp") return options.mode === "none" ? new MCPStub(options) : new MCPRecordingAdapter(options);
  return new RoutedExternalSystemPort(options);
}
