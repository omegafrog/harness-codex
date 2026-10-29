import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { inspectTrackerSync, readTrackerStatus, syncTrackerStatus } from "../src/tracker/lifecycle.mjs";
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
      if (args[0] === "api") return JSON.stringify({ data: { repository: { issue_0: { state: issueState, projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "item-7", project: { id: "project-4" }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: canonicalStatus, field: { id: "workflow" } }] } }] } } } } });
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
    assert.equal(f.calls.filter(([cmd, args]) => cmd === "gh" && args[0] === "project" && args[1] === "view").length, 1);
    assert.equal(f.calls.filter(([cmd, args]) => cmd === "gh" && args[0] === "project" && args[1] === "field-list").length, 1);
    assert.equal(f.calls.filter(([cmd, args]) => cmd === "gh" && args[0] === "api").length, 3);
    assert.equal(f.calls.some(([cmd, args]) => cmd === "gh" && args.includes("--field-id") && args[args.indexOf("--field-id") + 1] === "default"), false);
    assert.equal(f.calls.some(([cmd, args]) => cmd === "gh" && args[0] === "issue"), false);
  } finally { await f.cleanup(); }
});

test("GitHub-only completion checks every configured ticket without Beads", async () => {
  const f = await fixture("github");
  try {
    await writeFile(join(f.root, '.codex/harness.yaml'), (await readFile(join(f.root, '.codex/harness.yaml'), 'utf8')) + '\nbeads:\n  enabled: false\n');
    let state = 'OPEN';
    const run = async (cmd, args, cwd) => {
      if (cmd === 'bd') throw new Error('Beads must not be invoked');
      if (cmd === 'gh' && args[0] === 'api') return JSON.stringify({ data: { repository: { issue_0: { state, projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'item-7', project: { id: 'project-4' }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'Planned', field: { id: 'workflow' } }] } }] } } } } });
      return f.run(cmd, args, cwd);
    };
    const pass = await inspectTrackerSync({ workspace_root: f.root, ticket_refs: [ref], run });
    assert.equal(pass.status, 'pass');
    assert.equal(pass.reason, 'tracker_tickets_current');
    state = 'CLOSED';
    assert.equal((await inspectTrackerSync({ workspace_root: f.root, ticket_refs: [ref], run })).status, 'fail');
    assert.equal((await inspectTrackerSync({ workspace_root: f.root, run })).reason, 'no_managed_tracker_tickets');
  } finally { await f.cleanup(); }
});

test("read-only tracker lookup resolves exact issue beyond the default board page without requiring Beads", async () => {
  const f = await fixture("github");
  try {
    const result = await readTrackerStatus({ workspace_root: f.root, ticket_ref: ref, run: async (cmd, args, cwd) => {
      if (cmd === "bd") throw new Error("read-only lookup must not call Beads");
      if (cmd === "gh" && args[0] === "project" && args[1] === "item-list") throw new Error("read-only lookup must not scan capped board pages");
      return f.run(cmd, args, cwd);
    } });
    assert.equal(result.status, "pass");
    assert.equal(result.canonical_status, "planned");
    assert.equal(result.ticket_ref, ref);
    assert.ok(result.item_id);
  } finally { await f.cleanup(); }
});

test("read-only GitHub lookup distinguishes incomplete pagination from a missing project item", async () => {
  const f = await fixture("github");
  const run = async (cmd, args, cwd) => {
    if (cmd === "gh" && args[0] === "api") return JSON.stringify({ data: { repository: { issue_0: { state: "OPEN", projectItems: { pageInfo: { hasNextPage: true }, nodes: [] } } } } });
    return f.run(cmd, args, cwd);
  };
  try {
    const incomplete = await readTrackerStatus({ workspace_root: f.root, ticket_ref: ref, run });
    assert.match(incomplete.violations[0], /incomplete project item pagination/);
    const absent = await readTrackerStatus({ workspace_root: f.root, ticket_ref: ref, run: async (cmd, args, cwd) => {
      if (cmd === "gh" && args[0] === "api") return JSON.stringify({ data: { repository: { issue_0: { state: "OPEN", projectItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
      return f.run(cmd, args, cwd);
    } });
    assert.match(absent.violations[0], /Configured project item: expected exactly one match/);
    const wrongRef = await readTrackerStatus({ workspace_root: f.root, ticket_ref: "other/repo#7", run: f.run });
    assert.match(wrongRef.violations[0], /match configured repository/);
    const apiError = await readTrackerStatus({ workspace_root: f.root, ticket_ref: ref, run: async (cmd, args, cwd) => {
      if (cmd === "gh" && args[0] === "api") return JSON.stringify({ errors: [{ message: "configured project access unavailable" }] });
      return f.run(cmd, args, cwd);
    } });
    assert.match(apiError.violations[0], /GitHub batched issue query failed: configured project access unavailable/);
  } finally { await f.cleanup(); }
});

test("tracker CLI read is read-only and works without a registered Beads mirror", async () => {
  const f = await fixture();
  const cli = new URL("../.codex/scripts/harness-tracker.mjs", import.meta.url).pathname;
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, "read", "--root", f.root, "--ticket", f.ref], { encoding: "utf8" });
    const result = JSON.parse(stdout);
    assert.equal(result.status, "pass");
    assert.equal(result.canonical_status, "planned");
    await assert.rejects(execFileAsync(process.execPath, [cli, "read", "--root", f.root, "--ticket", f.ref, "--status", "completed"]), /read is read-only/);
  } finally { await f.cleanup(); }
});

test("documented capped number-only board lookup misses the exact issue when it is beyond the page", () => {
  const items = Array.from({ length: 362 }, (_, index) => ({ content: { number: index + 1000, repository: { nameWithOwner: "owner/repo" } } }));
  items[0] = { content: { number: 7, repository: { nameWithOwner: "other/repo" } } };
  items[361] = { content: { number: 7, repository: { nameWithOwner: "owner/repo" } } };
  for (const limit of [30, 100, 200]) {
    const page = items.slice(0, limit);
    assert.equal(page.find((item) => item.content.number === 7)?.content.repository.nameWithOwner, "other/repo");
    assert.equal(page.find((item) => item.content.number === 7 && item.content.repository.nameWithOwner === "owner/repo"), undefined);
  }
  assert.equal(items[361].content.repository.nameWithOwner, "owner/repo");
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
      if (cmd === "gh" && args[0] === "api") return JSON.stringify({ data: { repository: { issue_0: { state: "OPEN", projectItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
      return f.run(cmd, args, cwd);
    };
    await assert.rejects(syncTrackerStatus({ workspace_root: f.root, ticket_ref: ref, status: "completed", run: bad }), /exactly one match/);
    assert.equal(f.calls.some(([, args]) => args[0] === "close" || args[0] === "update"), false);
  } finally { await f.cleanup(); }
});

test("GitHub mirror check resolves project metadata once and batches issue reads", async () => {
  const f = await fixture("github");
  let fieldCalls = 0, viewCalls = 0, issueCalls = 0;
  const beads = [7, 8].map((number) => ({ ...f.bead, id: `bd-${number}`, external_ref: `owner/repo#${number}` }));
  const run = async (cmd, args, cwd) => {
    if (cmd === "bd" && args[0] === "list") return JSON.stringify([beads.find((bead) => bead.external_ref === args[args.indexOf("--external-ref") + 1])]);
    if (cmd === "gh" && args[0] === "project" && args[1] === "view") viewCalls++;
    if (cmd === "gh" && args[0] === "project" && args[1] === "field-list") {
      fieldCalls++;
    }
    if (cmd === "gh" && args[0] === "api") {
      issueCalls++;
      const query = args.find((arg) => arg.startsWith('query='));
      const repository = {};
      for (const [, alias, number] of query.matchAll(/(issue_\d+):issue\(number:(\d+)\)/g)) repository[alias] = { state: "OPEN", projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `item-${number}`, project: { id: "project-4" }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: "Planned", field: { id: "workflow" } }] } }] } };
      return JSON.stringify({ data: { repository } });
    }
    return f.run(cmd, args, cwd);
  };
  try {
    const result = await inspectTrackerSync({ workspace_root: f.root, ticket_refs: beads.map((bead) => bead.external_ref), run });
    assert.equal(result.status, "pass");
    assert.equal(fieldCalls, 1);
    assert.equal(viewCalls, 1);
    assert.equal(issueCalls, 1);
    assert.equal(result.tickets.length, 2);
    assert.equal((await inspectTrackerSync({ workspace_root: f.root, ticket_refs: beads.map((bead) => bead.external_ref), run })).status, "pass");
    assert.equal(fieldCalls, 2);
    assert.equal(viewCalls, 2);
    assert.equal(issueCalls, 2);
  } finally { await f.cleanup(); }
});

test("GitHub mirror check reports project metadata step and stops before issue reads on API failure", async () => {
  const f = await fixture("github");
  let fieldCalls = 0, issueCalls = 0;
  const run = async (cmd, args, cwd) => {
    if (cmd === "bd" && args[0] === "list") return JSON.stringify([f.bead]);
    if (cmd === "gh" && args[0] === "project" && args[1] === "field-list" && ++fieldCalls === 1) throw new Error("simulated API failure; raw GitHub stderr unavailable");
    if (cmd === "gh" && args[0] === "api") issueCalls++;
    return f.run(cmd, args, cwd);
  };
  try {
    const failed = await inspectTrackerSync({ workspace_root: f.root, ticket_refs: [ref], run });
    assert.equal(failed.status, "fail");
    assert.match(failed.violations[0], /GitHub configured project field-list failed \(owner\/4, Workflow Status\): simulated API failure/);
    assert.equal(issueCalls, 0);
    assert.equal(f.calls.some(([cmd, args]) => cmd === "gh" && args.includes("item-edit")), false);
    const retriedByCaller = await inspectTrackerSync({ workspace_root: f.root, ticket_refs: [ref], run });
    assert.equal(retriedByCaller.status, "pass");
    assert.equal(fieldCalls, 2);
    assert.equal(issueCalls, 1);
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
