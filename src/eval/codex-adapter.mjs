import { spawn } from "node:child_process";
import { ManifestValidationError } from "./errors.mjs";
import { redact, expandCommand } from "./util.mjs";

const STRUCTURED_KINDS = new Set(["message", "tool_call", "tool_result", "process_event"]);
const STATUSES = new Set(["success", "error", "denied", "cancelled"]);
const INHERITED_ENVIRONMENT = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"];

function inferCommandAction(command) {
  const text = String(command || "");
  if (/\bgit\s+push\b/i.test(text)) return "git_push";
  if (/\bgh\s+(issue|pr)\s+(create|edit|close|comment|merge|reopen)\b/i.test(text)) return "external_mutation";
  if (/(^|[;&|]\s*)(rm|rmdir|unlink)\b/i.test(text)) return "delete";
  if (/(^|[;&|]\s*)(tee|touch|mkdir|cp|mv|install|dd)\b/i.test(text) || />>?\s*[^>]/.test(text)) return "write_file";
  if (/(^|[;&|]\s*)(cat|head|tail|sed|awk|grep|rg|find|ls|tree|stat)\b/i.test(text) || /\bgit\s+(show|diff|status|log)\b/i.test(text)) return "read_file";
  return null;
}

function inferCommandTarget(command) {
  const match = String(command || "").match(/(?:^|[\s"'`])((?:\/|\.\.\/|\.\/)(?:[A-Za-z0-9._~@%+,-]+\/?)+|(?:src|tests|docs|\.codex)(?:\/[A-Za-z0-9._-]+)+)/);
  return match?.[1] || undefined;
}

function normalizeStructured(value) {
  const item = value.item && typeof value.item === "object" ? value.item : {};
  const providerType = String(value.type || "");
  const itemType = String(item.type || "");
  const isCommand = itemType.includes("command_execution") || itemType.includes("tool");
  const kind = STRUCTURED_KINDS.has(value.kind)
    ? value.kind
    : STRUCTURED_KINDS.has(value.type)
      ? value.type
      : isCommand
        ? (providerType.endsWith("completed") ? "tool_result" : "tool_call")
        : itemType.includes("message") || itemType.includes("reasoning") || providerType.includes("message")
          ? "message"
          : "process_event";
  const itemStatus = item.status || (item.exit_code === 0 ? "success" : item.exit_code !== undefined ? "error" : undefined);
  const status = STATUSES.has(value.status) ? value.status : STATUSES.has(itemStatus) ? itemStatus : undefined;
  const itemText = typeof item.text === "string" ? item.text : Array.isArray(item.content) ? item.content.map((part) => typeof part === "string" ? part : part?.text || part?.value || "").join("") : undefined;
  const payload = value.payload ?? value.data ?? value.message ?? (itemText ? { text: itemText } : {});
  const usage = value.usage || item.usage;
  const tokenCount = usage
    ? usage.total_tokens ?? usage.totalTokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))
    : undefined;
  const record = {
    actor: ["codex", "harness", "external"].includes(value.actor) ? value.actor : "codex",
    kind,
    payload: redact({ ...(typeof payload === "object" && !Array.isArray(payload) ? payload : { text: payload }), ...(item.command ? { command: item.command } : {}), ...(item.exit_code !== undefined ? { exit_code: item.exit_code } : {}), ...(tokenCount !== undefined ? { tokens: tokenCount } : {}) }),
    source: "structured_event",
  };
  for (const key of ["correlation_id", "action", "target"]) if (value[key] !== undefined) record[key] = redact(value[key]);
  if (!record.correlation_id && (value.id || item.id)) record.correlation_id = redact(value.id || item.id);
  if (!record.action && (item.action || inferCommandAction(item.command) || item.type || providerType)) record.action = redact(item.action || inferCommandAction(item.command) || item.type || providerType);
  if (!record.target && (item.target || inferCommandTarget(item.command))) record.target = redact(item.target || inferCommandTarget(item.command));
  if (status) record.status = status;
  return record;
}

function splitLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  return { lines: lines.slice(0, -1), remainder: lines.at(-1) || "" };
}

export class CodexProcessAdapter {
  constructor({ clock = () => new Date().toISOString(), killGraceMs = 500, inheritedEnvironment = INHERITED_ENVIRONMENT } = {}) {
    this.clock = clock;
    this.killGraceMs = killGraceMs;
    this.inheritedEnvironment = inheritedEnvironment;
  }

  async run({ command, cwd, env = {}, stdin = null, timeoutMs = null, trajectory, onRecord = async () => {}, onEvent = async () => {}, onExternalError = async () => {}, onTerminate = () => {}, caseId = "unknown", externalPort = null, permissionProfile = null, environmentProfile = null }) {
    const expandedCommand = expandCommand(command, { case_id: caseId });
    const startedAt = Date.now();
    const child = spawn(expandedCommand[0], expandedCommand.slice(1), {
      cwd,
      env: Object.fromEntries([...this.inheritedEnvironment, ...Object.keys(env)].filter((key) => process.env[key] !== undefined || env[key] !== undefined).map((key) => [key, env[key] ?? process.env[key]])),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let settled = false;
    let outputQueue = Promise.resolve();
    const records = [];
    const recordLine = async (line, source, stream) => {
      if (!line) return;
      let record;
      try {
        const parsed = JSON.parse(line);
        record = normalizeStructured(parsed);
      } catch {
        record = { actor: "codex", kind: "message", payload: { text: redact(line), stream }, source: "stdout_fallback" };
      }
      const normalized = await trajectory.append(record);
      records.push(normalized);
      await onRecord(normalized, { terminate });
      if (externalPort && normalized.action === "external_request" && normalized.payload?.request) {
        let externalRecord;
        let externalError = null;
        try {
          const response = await externalPort.execute(normalized.payload.request);
          externalRecord = await trajectory.append({
            actor: "external",
            kind: "tool_result",
            correlation_id: normalized.correlation_id,
            action: normalized.action,
            target: normalized.target ?? normalized.payload.request.target,
            status: "success",
            payload: { response, external_operation: normalized.payload.request.operation },
            source: "structured_event",
          });
        } catch (error) {
          externalError = error;
          externalRecord = await trajectory.append({
            actor: "external",
            kind: "tool_result",
            correlation_id: normalized.correlation_id,
            action: normalized.action,
            target: normalized.target ?? normalized.payload.request.target,
            status: error.reason === "unauthorized_external_mutation" ? "denied" : "error",
            payload: { reason: error.reason || "external_port_error" },
            source: "structured_event",
          });
        }
        records.push(externalRecord);
        await onRecord(externalRecord, { terminate });
        if (externalRecord.status === "error" || externalRecord.status === "denied") {
          try {
            await onExternalError(externalError || Object.assign(new Error(externalRecord.payload?.reason || "external_port_error"), { reason: externalRecord.payload?.reason || "external_port_error" }), normalized.payload.request, { terminate });
          } catch {
            // The runner owns error classification; preserve the observed external result.
          }
        }
      }
    };
    const processOutput = async (chunk, source, stream) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      const split = splitLines(source === "stdout" ? stdoutBuffer + text : stderrBuffer + text);
      if (source === "stdout") stdoutBuffer = split.remainder;
      else stderrBuffer = split.remainder;
      for (const line of split.lines) await recordLine(line, source, stream);
    };
    const terminate = () => {
      if (settled) return;
      void onTerminate();
      const signal = (name) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
          else child.kill(name);
        } catch { /* The process may have exited between observation and signalling. */ }
      };
      signal("SIGTERM");
      setTimeout(() => { if (!settled) signal("SIGKILL"); }, this.killGraceMs).unref();
    };
    const emitProcessEvent = async (event) => {
      await trajectory.append({ actor: "harness", kind: "process_event", action: event.type, payload: event.payload, source: "structured_event" });
      await onEvent(event);
    };
    const resultPromise = new Promise((resolve) => {
      let processError = null;
      child.once("error", (error) => { processError = error; });
      child.once("close", (exitCode, signal) => {
        settled = true;
        resolve({ exitCode, signal, processError });
      });
    });
    child.stdout.on("data", (chunk) => { outputQueue = outputQueue.then(() => processOutput(chunk, "stdout", "stdout")).catch(() => terminate()); });
    child.stderr.on("data", (chunk) => { outputQueue = outputQueue.then(() => processOutput(chunk, "stderr", "stderr")).catch(() => terminate()); });
    if (stdin !== null && stdin !== undefined) child.stdin.write(`${stdin}\n`);
    child.stdin.end();
    let timeout;
    if (timeoutMs) timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    await emitProcessEvent({ type: "process_started", payload: { command: expandedCommand, cwd }, timestamp: this.clock() });
    const result = await resultPromise;
    if (timeout) clearTimeout(timeout);
    await outputQueue;
    if (stdoutBuffer) await recordLine(stdoutBuffer, "stdout", "stdout");
    if (stderrBuffer) await recordLine(stderrBuffer, "stderr", "stderr");
    const durationMs = Date.now() - startedAt;
    const status = timedOut ? "cancelled" : result.processError ? "error" : result.exitCode === 0 ? "success" : "error";
    await emitProcessEvent({ type: "process_exited", payload: { exit_code: result.exitCode, signal: result.signal, status, duration_ms: durationMs }, timestamp: this.clock() });
    return {
      command: expandedCommand,
      cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      processError: result.processError,
      timedOut,
      durationMs,
      stdout: redact(stdout),
      stderr: redact(stderr),
      finalOutput: redact(records.filter((record) => record.kind === "message").map((record) => record.payload?.text || record.payload).join("\n") || stdout),
      records,
      snapshot: {
        command: expandedCommand,
        cwd,
        model: env.HARNESS_EVAL_MODEL || null,
        model_config: env.HARNESS_EVAL_MODEL_CONFIG || null,
        permission_profile: permissionProfile || env.HARNESS_EVAL_PERMISSION_PROFILE || null,
        native_sandbox: env.HARNESS_EVAL_NATIVE_SANDBOX || null,
        environment_profile: environmentProfile || env.HARNESS_EVAL_ENVIRONMENT_PROFILE || null,
        external_port: externalPort?.descriptor || null,
      },
    };
  }
}

export function resolveCodexCommand({ caseSpec, config, commandOverride = null }) {
  const command = commandOverride || caseSpec.environment?.codex?.command || config.eval.codex?.command || ["codex", "exec", "--json"];
  const profile = config.eval.environment_profiles?.[caseSpec.environment_profile];
  const sandbox = profile?.sandbox;
  if (!sandbox) throw new ManifestValidationError(`Missing native sandbox for environment profile: ${caseSpec.environment_profile}`);
  const executable = command[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!commandOverride && !["codex", "codex.exe"].includes(executable)) throw new ManifestValidationError("Eval command must invoke the Codex CLI");
  if (command.includes("--dangerously-bypass-approvals-and-sandbox")) throw new ManifestValidationError("Codex command cannot bypass native sandbox");
  const sanitized = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === "--sandbox") {
      index += 1;
      continue;
    }
    if (typeof command[index] === "string" && command[index].startsWith("--sandbox=")) continue;
    sanitized.push(command[index]);
  }
  const nativeCommand = [...sanitized, "--sandbox", sandbox];
  if (profile.network === "restricted" || profile.network === "disabled") return [...nativeCommand, "--config", "sandbox_workspace_write.network_access=false"];
  return nativeCommand;
}
