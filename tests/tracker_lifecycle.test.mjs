import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { inspectTrackerSync, syncTrackerStatus } from "../src/tracker/lifecycle.mjs";
import { sessionDirectory } from "../src/workflow/session-output.mjs";

const ref = "owner/repo#7";
const execFileAsync = promisify(execFile);
async function fixture(mode = "local-markdown") {
  const root = await mkdtemp(join(tmpdir(), "tracker-lifecycle-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  await mkdir(join(root, ".beads"), { recursive: true });
  await mkdir(sessionDirectory(root), { recursive: true });
  const config = mode === "local-markdown"
    ? "tracker:\n  mode: local-markdown\n  local_markdown:\n    directory: tickets\n"
    : "tracker:\n  mode: github\n  github:\n    repository: owner/repo\n    project_owner: owner\n    project_number: 4\n    status_field: Workflow Status\n";
  await writeFile(join(root, ".codex/harness.yaml"), config);
  await mkdir(join(root, "tickets"), { recursive: true });
  await writeFile(join(root, "tickets/7.md"), "---\nstatus: planned\ntitle: Keep this body\n---\nBody stays here.\n");
  let canonicalStatus = "Planned", issueState = "OPEN";
  const ticketRef = mode === "local-markdown" ? "tickets/7.md" : ref;
  const bead = { id: "bd-7", external_ref: ticketRef, status: "open", metadata: { harness_tracker_version: 1, harness_phase: "implementation", harness_classification: "committed" } };
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "gh") {
      if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "project-4" });
      if (args[0] === "project" && args[1] === "field-list") return JSON.stringify({ fields: [{ id: "workflow", name: "Workflow Status", type: "ProjectV2SingleSelectField", options: ["Planned", "In Progress", "Blocked", "Done"].map((name) => ({ id: name, name })) }, { id: "default", name: "Status", type: "ProjectV2SingleSelectField", options: [{ id: "closed", name: "Closed" }] }] });
      if (args[0] === "api") return JSON.stringify({ data: { repository: { issue: { state: issueState, projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "item-7", project: { id: "project-4" }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: canonicalStatus, field: { id: "workflow" } }] } }] } } } } });
      if (args[0] === "project" && args[1] === "item-edit") { canonicalStatus = args[args.indexOf("--single-select-option-id") + 1]; return ""; }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    }
    if (command !== "bd") throw new Error(`Unexpected command ${command}`);
    if (args[0] === "list") return JSON.stringify(args.includes("--external-ref") ? [bead] : [bead]);
    if (args[0] === "update" || args[0] === "close") {
      if (args.includes("--status")) bead.status = args[args.indexOf("--status") + 1];
      if (args[0] === "close") bead.status = "closed";
      for (const value of args.filter((arg) => arg.startsWith("harness_"))) { const [key, v] = value.split("="); bead.metadata[key] = v; }
      return "";
    }
    if (args[0] === "show") return JSON.stringify([structuredClone(bead)]);
    throw new Error(`Unexpected bd call: ${args.join(" ")}`);
  };
  return { root, ref: ticketRef, calls, bead, run, cleanup: () => rm(root, { recursive: true, force: true }), setIssueState: (value) => { issueState = value; }, get canonicalStatus() { return mode === "local-markdown" ? "planned" : canonicalStatus; }, set canonicalStatus(value) { canonicalStatus = value; } };
}

test("sync updates only configured canonical status, verifies it, then mirrors and keeps phase metadata separate", async () => {
  const f = await fixture();
  try {
    const result = await syncTrackerStatus({ workspace_root: f.root, ticket_ref: f.ref, status: "in-progress", phase: "test", classification: "committed", run: f.run });
    assert.equal(result.status, "pass");
    assert.match(await readFile(join(f.root, "tickets/7.md"), "utf8"), /status: in-progress\ntitle: Keep this body/);
    assert.equal(f.bead.status, "in_progress");
    assert.equal(f.bead.metadata.harness_phase, "test");
    assert.equal(f.bead.metadata.harness_classification, "committed");
    assert.equal((await inspectTrackerSync({ workspace_root: f.root, ticket_refs: [f.ref], run: f.run })).status, "pass");
  } finally { await f.cleanup(); }
});

test("backlog metadata is valid while planned but blocks starting execution", async () => {
  const f = await fixture();
  f.bead.metadata.harness_classification = "backlog";
  try {
    const blocked = await syncTrackerStatus({ workspace_root: f.root, ticket_ref: f.ref, status: "in-progress", run: f.run });
    assert.equal(blocked.status, "fail");
    assert.match(blocked.violations[0], /Commit backlog classification/);
    assert.equal(await readFile(join(f.root, "tickets/7.md"), "utf8"), "---\nstatus: planned\ntitle: Keep this body\n---\nBody stays here.\n");
    assert.equal((await inspectTrackerSync({ workspace_root: f.root, ticket_refs: [f.ref], run: f.run })).status, "pass");
  } finally { await f.cleanup(); }
});

test("GitHub sync uses the configured Workflow Status field and leaves Issue state and default Status alone", async () => {
  const f = await fixture("github");
  try {
    const result = await syncTrackerStatus({ workspace_root: f.root, ticket_ref: ref, status: "completed", run: f.run });
    assert.equal(result.status, "pass");
    assert.equal(f.bead.status, "closed");
    assert.equal(f.calls.some(([cmd, args]) => cmd === "gh" && args.includes("--field-id") && args[args.indexOf("--field-id") + 1] === "default"), false);
    assert.equal(f.calls.some(([cmd, args]) => cmd === "gh" && args[0] === "issue"), false);
  } finally { await f.cleanup(); }
});

test("check rejects duplicate or missing exact Beads references before any write", async () => {
  const f = await fixture();
  try {
    const duplicateRun = async (cmd, args, cwd) => args[0] === "list" && args.includes("--external-ref") ? JSON.stringify([f.bead, f.bead]) : f.run(cmd, args, cwd);
    await assert.rejects(syncTrackerStatus({ workspace_root: f.root, ticket_ref: f.ref, status: "blocked", run: duplicateRun }), /exactly one match/);
    assert.equal(f.calls.some(([, args]) => args[0] === "update" || args[0] === "close"), false);
    const missingRun = async (cmd, args, cwd) => args[0] === "list" && args.includes("--external-ref") ? "[]" : f.run(cmd, args, cwd);
    await assert.rejects(syncTrackerStatus({ workspace_root: f.root, ticket_ref: f.ref, run: missingRun }), /exactly one match/);
  } finally { await f.cleanup(); }
});

test("failed mirror leaves canonical update in place and retry without status mirrors that canonical value", async () => {
  const f = await fixture();
  try {
    const failMirror = async (cmd, args, cwd) => { if (cmd === "bd" && (args[0] === "update" || args[0] === "close")) throw new Error("temporary Beads outage"); return f.run(cmd, args, cwd); };
    const failed = await syncTrackerStatus({ workspace_root: f.root, ticket_ref: f.ref, status: "blocked", phase: "review", classification: "committed", run: failMirror });
    assert.equal(failed.status, "fail");
    assert.equal(failed.phase, "review");
    assert.equal(failed.classification, "committed");
    assert.match(failed.retry, /preserving recorded --phase\/--classification/);
    assert.match(await readFile(join(f.root, "tickets/7.md"), "utf8"), /status: blocked/);
    assert.equal(f.bead.status, "open");
    const retry = await syncTrackerStatus({ workspace_root: f.root, ticket_ref: f.ref, phase: failed.phase, classification: failed.classification, run: f.run });
    assert.equal(retry.status, "pass");
    assert.equal(retry.canonical_status, "blocked");
    assert.equal(retry.tracker_updated, false);
    assert.equal(f.bead.metadata.harness_phase, "review");
    assert.equal(f.bead.metadata.harness_classification, "committed");
  } finally { await f.cleanup(); }
});

test("legacy Beads are excluded from automatic checks; a managed mirror without external_ref fails", async () => {
  const f = await fixture();
  try {
    const noManaged = await inspectTrackerSync({ workspace_root: f.root, run: async (cmd, args) => { if (args[0] === "list") return "[]"; return f.run(cmd, args); } });
    assert.equal(noManaged.reason, "no_managed_tracker_tickets");
    const broken = await inspectTrackerSync({ workspace_root: f.root, run: async (cmd, args) => { if (args[0] === "list") return JSON.stringify([{ ...f.bead, external_ref: null }]); return f.run(cmd, args); } });
    assert.equal(broken.status, "fail");
  } finally { await f.cleanup(); }
});

test("a linked worktree discovers its shared Beads board", async () => {
  const main = await mkdtemp(join(tmpdir(), "tracker-main-worktree-"));
  const linked = join(main, "linked");
  try {
    await mkdir(join(main, ".beads"));
    await writeFile(join(main, "seed.txt"), "seed\n");
    await execFileAsync("git", ["init", "-q", main]);
    await execFileAsync("git", ["-C", main, "config", "user.email", "test@example.invalid"]);
    await execFileAsync("git", ["-C", main, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", main, "add", "seed.txt"]);
    await execFileAsync("git", ["-C", main, "commit", "-q", "-m", "seed"]);
    await execFileAsync("git", ["-C", main, "worktree", "add", "-q", "-b", "linked-test", linked]);
    let queriedBeads = false;
    const run = async (command, args, cwd) => {
      if (command === "git") return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
      if (command === "bd" && args[0] === "list") {
        queriedBeads = true;
        return JSON.stringify([{ id: "bd-1", external_ref: null, metadata: { harness_tracker_version: 1 } }]);
      }
      throw new Error(`Unexpected ${command} ${args.join(" ")}`);
    };
    const result = await inspectTrackerSync({ workspace_root: linked, run });
    assert.equal(result.status, "fail");
    assert.match(result.violations[0], /missing external_ref/);
    assert.equal(queriedBeads, true);
  } finally { await rm(main, { recursive: true, force: true }); }
});

test("GitHub lifecycle check rejects incomplete or ambiguous configured items before mutation", async () => {
  const f = await fixture("github");
  try {
    const bad = async (cmd, args, cwd) => {
      if (cmd === "gh" && args[0] === "api") return JSON.stringify({ data: { repository: { issue: { state: "OPEN", projectItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
      return f.run(cmd, args, cwd);
    };
    await assert.rejects(syncTrackerStatus({ workspace_root: f.root, ticket_ref: ref, status: "completed", run: bad }), /exactly one match/);
    assert.equal(f.calls.some(([, args]) => args[0] === "close" || args[0] === "update"), false);
  } finally { await f.cleanup(); }
});

test("lifecycle v1 requires phase and classification metadata", async () => {
  const f = await fixture();
  delete f.bead.metadata.harness_phase;
  try {
    const check = await inspectTrackerSync({ workspace_root: f.root, ticket_refs: [f.ref], run: f.run });
    assert.equal(check.status, "fail");
    assert.match(check.violations[0], /harness_phase/);
    await assert.rejects(syncTrackerStatus({ workspace_root: f.root, ticket_ref: f.ref, run: f.run }), /harness_phase/);
    assert.equal(f.calls.some(([, args]) => args[0] === "update" || args[0] === "close"), false);
  } finally { await f.cleanup(); }
});

test("closed GitHub issue cannot move to an unfinished canonical status", async () => {
  const f = await fixture("github");
  f.setIssueState("CLOSED");
  try {
    await assert.rejects(syncTrackerStatus({ workspace_root: f.root, ticket_ref: ref, status: "in-progress", run: f.run }), /closed GitHub issue/);
    assert.equal(f.bead.status, "open");
    assert.equal(f.calls.some(([cmd, args]) => cmd === "gh" && args[0] === "project" && args[1] === "item-edit"), false);
  } finally { await f.cleanup(); }
});
