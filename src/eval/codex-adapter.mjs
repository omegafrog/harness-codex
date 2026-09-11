import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { TARGET_PATH_FIELDS, workspaceTargetCandidates } from "./case-workspace.mjs";
import { ManifestValidationError } from "./errors.mjs";
import { redact, expandCommand } from "./util.mjs";

const STRUCTURED_KINDS = new Set(["message", "tool_call", "tool_result", "process_event"]);
const STATUSES = new Set(["success", "error", "denied", "cancelled"]);
const INHERITED_ENVIRONMENT = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"];
const CODEX_AUTHENTICATION_FAILURE_PATTERNS = [
  /\b401\s+Unauthorized\b/i,
  /\bMissing bearer\b/i,
  /\b(?:authentication|credentials?)\s+(?:missing|invalid|failed|unauthorized)\b/i,
];
const CODEX_PROVIDER_UNAVAILABLE_PATTERNS = [
  /failed to lookup address information/i,
  /stream disconnected before completion/i,
  /failed to connect to websocket/i,
];

function detectInconclusiveReason({ exitCode, stdout, stderr }) {
  const output = `${stdout}\n${stderr}`;
  if (exitCode !== 0 && CODEX_AUTHENTICATION_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) {
    return "codex_authentication_unavailable";
  }
  if (CODEX_PROVIDER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(output))) {
    return "codex_provider_unavailable";
  }
  return null;
}

function inferCommandAction(command) {
  const text = String(command || "");
  if (/\bgit\s+push\b/i.test(text)) return "git_push";
  if (/\bgh\s+(issue|pr)\s+(create|edit|close|comment|merge|reopen)\b/i.test(text)) return "external_mutation";
  if (/(^|[;&|]\s*)(rm|rmdir|unlink)\b/i.test(text)) return "delete";
  const outputRedirect = text.match(/(?:^|[\s;&|])(?:\d+)?>>?\s*([^\s;&|]+)/);
  if (/(^|[;&|]\s*)(tee|touch|mkdir|cp|mv|install|dd)\b/i.test(text)
    || (outputRedirect && !outputRedirect[1].startsWith("&") && !outputRedirect[1].startsWith("/dev/null"))) return "write_file";
  if (/(^|[;&|]\s*)(cat|head|tail|sed|awk|grep|rg|find|ls|tree|stat)\b/i.test(text) || /\bgit\s+(show|diff|status|log)\b/i.test(text)) return "read_file";
  if (/\b(?:write_text|writeFile|write_bytes)\s*\(/i.test(text) && /\.eval-output\//.test(text)) return "write_file";
  return null;
}

function fileChangeTarget(item) {
  if (!Array.isArray(item?.changes)) return undefined;
  return item.changes.flatMap((change) => workspaceTargetCandidates(change)).find((path) => typeof path === "string");
}

function normalizeFileChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) return change;
  return Object.fromEntries([
    ...TARGET_PATH_FIELDS.filter((field) => typeof change[field] === "string").map((field) => [field, change[field]]),
    ...(typeof change.kind === "string" ? [["kind", change.kind]] : []),
  ]);
}

function inferCommandTargets(command) {
  const text = String(command || "");
  const matches = [...text.matchAll(/(?:^|[\s"'`])((?:\/|\.\.\/|\.\/)(?:[A-Za-z0-9._~@%+,-]+\/?)+|(?:src|tests|docs|\.codex|\.eval-output)(?:\/[A-Za-z0-9._-]+)+)/g)]
    .map((match) => match[1]);
  if (!matches.length) return [];
  const executable = text.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executableToken = executable?.[1] || executable?.[2] || executable?.[3];
  return [...new Set(matches.filter((target) => target !== executableToken))];
}

function inferCommandTarget(command) {
  return inferCommandTargets(command)[0];
}

function normalizeWorkspacePath(value, cwd) {
  if (typeof value !== "string" || !cwd || !isAbsolute(value)) return value;
  const relativePath = relative(resolve(cwd), resolve(value)).replaceAll("\\", "/");
  if (relativePath === "" || (!relativePath.startsWith("../") && relativePath !== "..")) return relativePath || ".";
  return value;
}

function normalizeWorkspaceRecord(record, cwd) {
  const normalized = { ...record };
  if (typeof normalized.target === "string") normalized.target = normalizeWorkspacePath(normalized.target, cwd);
  else if (normalized.target && typeof normalized.target === "object" && !Array.isArray(normalized.target)) {
    normalized.target = { ...normalized.target };
    for (const field of TARGET_PATH_FIELDS) {
      if (typeof normalized.target[field] === "string") normalized.target[field] = normalizeWorkspacePath(normalized.target[field], cwd);
    }
  }
  if (normalized.payload && typeof normalized.payload === "object" && !Array.isArray(normalized.payload)) {
    normalized.payload = { ...normalized.payload };
    if (Array.isArray(normalized.payload.targets)) {
      normalized.payload.targets = normalized.payload.targets.map((target) => normalizeWorkspacePath(target, cwd));
    }
    if (Array.isArray(normalized.payload.changes)) {
      normalized.payload.changes = normalized.payload.changes.map((change) => {
        if (!change || typeof change !== "object" || Array.isArray(change)) return change;
        const normalizedChange = { ...change };
        for (const field of TARGET_PATH_FIELDS) {
          if (typeof normalizedChange[field] === "string") normalizedChange[field] = normalizeWorkspacePath(normalizedChange[field], cwd);
        }
        return normalizedChange;
      });
    }
  }
  return normalized;
}

function normalizeStructured(value) {
  const item = value.item && typeof value.item === "object" ? value.item : {};
  const providerType = String(value.type || "");
  const itemType = String(item.type || "");
  const isFileChange = itemType === "file_change" || itemType.endsWith("_file_change");
  const isCommand = itemType.includes("command_execution") || itemType.includes("tool");
  const kind = isFileChange
    ? (providerType.endsWith("completed") ? "tool_result" : "tool_call")
    : STRUCTURED_KINDS.has(value.kind)
    ? value.kind
    : STRUCTURED_KINDS.has(value.type)
      ? value.type
      : isCommand
        ? (providerType.endsWith("completed") ? "tool_result" : "tool_call")
        : itemType.includes("message") || itemType.includes("reasoning") || providerType.includes("message")
          ? "message"
          : "process_event";
  const itemStatus = item.status
    || (isFileChange && providerType.endsWith("completed") ? "success" : undefined)
    || (isFileChange && ["completed", "applied", "done"].includes(String(item.status || "").toLowerCase()) ? "success" : undefined)
    || (item.exit_code === 0 ? "success" : item.exit_code !== undefined ? "error" : undefined);
  const status = STATUSES.has(value.status)
    ? value.status
    : STATUSES.has(itemStatus)
      ? itemStatus
      : isFileChange && kind === "tool_result"
        ? "success"
        : undefined;
  const itemText = typeof item.text === "string" ? item.text : Array.isArray(item.content) ? item.content.map((part) => typeof part === "string" ? part : part?.text || part?.value || "").join("") : undefined;
  const inferredTargets = inferCommandTargets(item.command);
  const payload = value.payload ?? value.data ?? value.message ?? (itemText ? { text: itemText } : isFileChange ? { changes: item.changes.map(normalizeFileChange) } : {});
  const usage = value.usage || item.usage;
  const tokenCount = usage
    ? usage.total_tokens ?? usage.totalTokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))
    : undefined;
  const record = {
    actor: ["codex", "harness", "external"].includes(value.actor) ? value.actor : "codex",
    kind,
    payload: redact({ ...(typeof payload === "object" && !Array.isArray(payload) ? payload : { text: payload }), ...(item.command ? { command: item.command } : {}), ...(inferredTargets.length > 1 ? { targets: inferredTargets } : {}), ...(item.exit_code !== undefined ? { exit_code: item.exit_code } : {}), ...(tokenCount !== undefined ? { tokens: tokenCount } : {}) }),
    source: "structured_event",
  };
  for (const key of ["correlation_id", "action", "target"]) if (value[key] !== undefined) record[key] = redact(value[key]);
  if (!record.correlation_id && (value.id || item.id)) record.correlation_id = redact(value.id || item.id);
  if (!record.action && (isFileChange || item.action || inferCommandAction(item.command) || item.type || providerType)) record.action = redact(isFileChange ? "write_file" : item.action || inferCommandAction(item.command) || item.type || providerType);
  if (!record.target && (item.target || fileChangeTarget(item) || inferCommandTarget(item.command))) record.target = redact(item.target || fileChangeTarget(item) || inferCommandTarget(item.command));
  if (status) record.status = status;
  return record;
}

function redactCommand(command) {
  const sensitiveFlag = /^--?(?:api[-_]?key|access[-_]?token|auth(?:entication)?[-_]?token|token|password|secret|credential|authorization|private[-_]?key)$/i;
  const sensitiveAssignment = /^(--?(?:api[-_]?key|access[-_]?token|auth(?:entication)?[-_]?token|token|password|secret|credential|authorization|private[-_]?key))=(.*)$/i;
  const redacted = [];
  let redactNext = false;
  for (const part of command) {
    const value = String(part);
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const assignment = value.match(sensitiveAssignment);
    if (assignment) {
      redacted.push(`${assignment[1]}=[REDACTED]`);
      continue;
    }
    redacted.push(redact(value));
    if (sensitiveFlag.test(value)) redactNext = true;
  }
  return redacted;
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

  async run({ command, cwd, env = {}, stdin = null, timeoutMs = null, trajectory, onRecord = async () => {}, onEvent = async () => {}, onTerminate = async () => {}, caseId = "unknown", workflow = null, permissionProfile = null, environmentProfile = null }) {
    const expandedCommand = expandCommand(command, { case_id: caseId });
    const safeCommand = redactCommand(expandedCommand);
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
        record = normalizeWorkspaceRecord(normalizeStructured(parsed), cwd);
      } catch {
        record = { actor: "codex", kind: "message", payload: { text: redact(line), stream }, source: "stdout_fallback" };
      }
      const normalized = await trajectory.append(record);
      records.push(normalized);
      await onRecord(normalized, { terminate });
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
      void Promise.resolve().then(() => onTerminate()).catch(() => {});
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
    await emitProcessEvent({ type: "process_started", payload: { command: safeCommand, cwd, workflow: workflow || env.HARNESS_EVAL_WORKFLOW || null }, timestamp: this.clock() });
    const result = await resultPromise;
    if (timeout) clearTimeout(timeout);
    await outputQueue;
    if (stdoutBuffer) await recordLine(stdoutBuffer, "stdout", "stdout");
    if (stderrBuffer) await recordLine(stderrBuffer, "stderr", "stderr");
    const durationMs = Date.now() - startedAt;
    const status = timedOut ? "cancelled" : result.processError ? "error" : result.exitCode === 0 ? "success" : "error";
    await emitProcessEvent({ type: "process_exited", payload: { exit_code: result.exitCode, signal: result.signal, status, duration_ms: durationMs }, timestamp: this.clock() });
    const inconclusiveReason = detectInconclusiveReason({ exitCode: result.exitCode, stdout, stderr });
    return {
      command: safeCommand,
      cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      processError: result.processError,
      timedOut,
      durationMs,
      inconclusiveReason,
      stdout: redact(stdout),
      stderr: redact(stderr),
      finalOutput: redact(records.filter((record) => record.kind === "message").map((record) => record.payload?.text || record.payload).join("\n") || stdout),
      records,
      snapshot: {
        command: safeCommand,
        cwd,
        model: env.HARNESS_EVAL_MODEL || null,
        model_config: env.HARNESS_EVAL_MODEL_CONFIG || null,
        workflow: workflow || env.HARNESS_EVAL_WORKFLOW || null,
        permission_profile: permissionProfile || env.HARNESS_EVAL_PERMISSION_PROFILE || null,
        native_sandbox: env.HARNESS_EVAL_NATIVE_SANDBOX || null,
        environment_profile: environmentProfile || env.HARNESS_EVAL_ENVIRONMENT_PROFILE || null,
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
