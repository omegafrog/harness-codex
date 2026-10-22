import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, lstat, symlink, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { finishWorkflowWorktree, registerWorkflowWorktree, reserveWorkflowWorktree } from "../src/workflow/worktrees.mjs";
import { completeWorkflow } from "../src/workflow/completion.mjs";
import { createWorkflowWorktree } from "../src/workflow/worktrees.mjs";
import { makeContractsFixture } from "./contracts-fixture.mjs";
import { sessionOutputPath } from "../src/workflow/session-output.mjs";

const run = promisify(execFile);
const git = (cwd, ...args) => run("git", args, { cwd });
const cli = join(import.meta.dirname, "../.codex/scripts/harness-workflow-worktree.mjs");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-worktree-"));
  const main = join(root, "main"), tree = join(root, "tree");
  await mkdir(main);
  await git(main, "init", "-q", "-b", "main");
  await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base");
  await git(main, "worktree", "add", "-q", "-b", "workflow", tree);
  return { root, main, tree };
}
const cleanup = (root) => rm(root, { recursive: true, force: true });

for (const outcome of ["completed", "aborted", "failed", "handoff"]) test(`${outcome} archives dirty worktree and removes only its registration`, async () => {
  const { root, main, tree } = await fixture();
  try {
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "flow-1", return_root: main });
    await writeFile(join(tree, "tracked"), "tracked");
    await git(tree, "add", "tracked");
    await writeFile(join(tree, "tracked"), "staged version");
    await git(tree, "add", "tracked");
    await writeFile(join(tree, "tracked"), "modified");
    await writeFile(join(tree, "untracked"), "untracked");
    await writeFile(join(tree, ".ignored"), "ignored");
    await writeFile(join(tree, ".gitignore"), ".ignored\n");
    await writeFile(sessionOutputPath(tree, "state.json", { repositoryRoot: main }), "runtime");
    const result = await finishWorkflowWorktree({ workspace_root: tree, repository_root: main, workflow_id: "flow-1", outcome });
    assert.equal(result.state, "removed");
    assert.equal(await readFile(join(result.recovery_path, "files", "tracked"), "utf8"), "modified");
    assert.equal(await readFile(join(result.recovery_path, "files", "untracked"), "utf8"), "untracked");
    assert.equal(await readFile(join(result.recovery_path, "files", ".ignored"), "utf8"), "ignored");
    assert.equal(await readFile(sessionOutputPath(tree, "state.json", { repositoryRoot: main }), "utf8"), "runtime");
    assert.ok((await lstat(join(result.recovery_path, "index"))).size > 0);
    assert.match(await git(main, "show-ref", "--verify", result.recovery_ref).then(x => x.stdout), /refs\/harness\/recovery\//);
    await git(main, "gc", "--prune=now");
    const archived = JSON.parse(await readFile(sessionOutputPath(tree, "receipt.json", { repositoryRoot: main }), "utf8"));
    const stagedEntry = await git(main, "ls-tree", `${archived.staged_ref}^{tree}`);
    const stagedBlob = stagedEntry.stdout.match(/blob ([a-f0-9]+)/)?.[1];
    assert.ok(stagedBlob);
    assert.equal((await git(main, "cat-file", "blob", stagedBlob)).stdout, "staged version");
    assert.match(await git(main, "branch", "--list", "workflow").then(x => x.stdout), /workflow/);
    assert.equal(await lstat(tree).then(() => true, () => false), false);
    assert.equal((await finishWorkflowWorktree({ workspace_root: tree, repository_root: main, workflow_id: "flow-1" })).already_removed, true);
  } finally { await cleanup(root); }
});

test("CLI creates new and existing branches and finish aborts both", async () => {
  const { root, main } = await fixture();
  try {
    await git(main, "branch", "existing");
    for (const branch of [null, "existing"]) {
      const args = [cli, "create", "--root", main, "--workflow", "cli-flow"];
      if (branch) args.push("--branch", branch);
      const created = JSON.parse((await run(process.execPath, args)).stdout);
      assert.equal(created.state, "active");
      const finished = JSON.parse((await run(process.execPath, [cli, "finish", "--root", created.workspace, "--repository", main, "--workflow", "cli-flow", "--outcome", "aborted"])).stdout);
      assert.equal(finished.state, "removed");
    }
  } finally { await cleanup(root); }
});

test("failed Git allocation removes its pre-reserved ownership receipt", async () => {
  const { root, main, tree } = await fixture();
  try {
    await assert.rejects(createWorkflowWorktree({ workspace_root: main, workflow_id: "allocation", branch: "workflow" }), (error) => {
      assert.equal(error.worktree_cleanup?.state, "removed");
      return /allocation cleanup=removed/.test(error.message);
    });
    const listing = await git(main, "worktree", "list", "--porcelain");
    assert.equal(listing.stdout.includes("harness-worktrees"), false);
    assert.ok(await lstat(tree));
  } finally { await cleanup(root); }
});

test("concurrent reservations have one owner and the losing attempt preserves it", async () => {
  const { root, main } = await fixture();
  const workspace = join(root, "reserved");
  try {
    const attempts = await Promise.allSettled([
      reserveWorkflowWorktree({ workspace_root: workspace, repository_root: main, workflow_id: "first", branch: "first" }),
      reserveWorkflowWorktree({ workspace_root: workspace, repository_root: main, workflow_id: "second", branch: "second" }),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    const winner = attempts.find((item) => item.status === "fulfilled");
    const loser = attempts.find((item) => item.status === "rejected");
    const owner = JSON.parse(await readFile(join(main, ".git", "harness-workflows", "sessions", createHash("sha256").update(workspace).digest("hex"), "receipt.json"), "utf8"));
    assert.equal(owner.workflow_id, winner === attempts[0] ? "first" : "second");
    assert.match(loser.reason.message, /Cleanup is already running|Allocation already has a pending owner/);
    assert.equal(owner.state, "allocating");
  } finally { await cleanup(root); }
});

test("aborted completeWorkflow removes an owned linked worktree", async () => {
  const { root, main, tree } = await fixture();
  try {
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "implement", return_root: main });
    const controller = new AbortController(); controller.abort(new Error("stop"));
    await assert.rejects(completeWorkflow({ workflow_id: "implement", workspace_root: tree, base_ref: "bad", signal: controller.signal }), (error) => {
      assert.equal(error.worktree_cleanup?.state, "removed"); return /stop/.test(error.message);
    });
    await assert.rejects(lstat(tree), { code: "ENOENT" });
  } finally { await cleanup(root); }
});

test("completion CLI removes an owned tree when its state JSON is invalid", async () => {
  const { root, main, tree } = await fixture();
  try {
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "implement", return_root: main });
    await writeFile(join(tree, "bad.json"), "{");
    const failure = await run(process.execPath, [join(import.meta.dirname, "../.codex/scripts/harness-workflow-complete.mjs"), "--root", tree, "--workflow", "implement", "--state", "bad.json"]).then(() => null, (error) => error);
    assert.ok(failure);
    assert.equal(JSON.parse(failure.stderr).worktree_cleanup.state, "removed");
    await assert.rejects(lstat(tree), { code: "ENOENT" });
  } finally { await cleanup(root); }
});

test("locked worktree cleanup reports its archive and succeeds after unlock", async () => {
  const { root, main, tree } = await fixture();
  try {
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "locked", return_root: main });
    await writeFile(join(tree, "dirty"), "preserve");
    await git(main, "worktree", "lock", "--reason", "test", tree);
    const failed = await finishWorkflowWorktree({ workspace_root: tree, repository_root: main, workflow_id: "locked" });
    assert.equal(failed.state, "failed");
    assert.equal(await readFile(join(failed.recovery_path, "files", "dirty"), "utf8"), "preserve");
    assert.ok(await lstat(tree));
    await git(main, "worktree", "unlock", tree);
    assert.equal((await finishWorkflowWorktree({ workspace_root: tree, repository_root: main, workflow_id: "locked" })).state, "removed");
  } finally { await cleanup(root); }
});

test("completeWorkflow removes a registered tree after an early invalid-base error", async () => {
  const { root, main, tree } = await fixture();
  try {
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "implement", return_root: main });
    await assert.rejects(completeWorkflow({ workflow_id: "implement", workspace_root: tree, base_ref: "bad" }), (error) => {
      assert.equal(error.worktree_cleanup?.state, "removed");
      return /Starting commit SHA/.test(error.message);
    });
    await assert.rejects(lstat(tree), { code: "ENOENT" });
  } finally { await cleanup(root); }
});

test("completeWorkflow requires live plan traceability even when the workflow hook list is empty", async () => {
  const { root, main, tree } = await fixture();
  const workflowDir = join(tree, ".codex/workflows");
  const agentDir = join(tree, ".codex/agents");
  const skillDir = join(tree, ".codex/internal-skills/implement");
  await mkdir(workflowDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(agentDir, "implementation_agent.toml"), 'name = "implementation_agent"\ndescription = "fixture"\nsandbox_mode = "workspace-write"\n');
  await writeFile(join(skillDir, "GUIDE.md"), "# Internal implementation fixture\n");
  await writeFile(join(workflowDir, "implement-wrapper.yaml"), "schema_version: 1\nid: implement-wrapper\nroles: [implementation_agent]\nskills: [implement]\nhooks:\n  before_complete: []\nstages:\n  - id: implementation\n    role: implementation_agent\n    skill: implement\n    model_tier: implementation\n    needs: []\n");
  await git(tree, "add", ".codex/workflows/implement-wrapper.yaml", ".codex/agents/implementation_agent.toml", ".codex/internal-skills/implement/GUIDE.md");
  await git(tree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "minimal workflow");
  const baseRef = (await git(tree, "rev-parse", "HEAD")).stdout.trim();
  try {
    const result = await run(process.execPath, ["-e", `import { completeWorkflow } from ${JSON.stringify(new URL("../src/workflow/completion.mjs", import.meta.url).href)}; const result = await completeWorkflow({ workflow_id: "implement-wrapper", workspace_root: process.cwd(), base_ref: ${JSON.stringify(baseRef)}, state: {} }); console.log(JSON.stringify(result));`], { cwd: tree, encoding: "utf8" });
    const completion = JSON.parse(result.stdout);
    assert.equal(completion.state, "in-progress");
    assert.ok(completion.verdict.checks.some((check) => check.rule_id === "plan_traceability" && check.status === "blocked"));
  } finally { await cleanup(root); }
});

test("normal completion passes gates and removes its owned linked worktree", async () => {
  const { root, cleanup: removeFixture } = await makeContractsFixture();
  const tree = join(root, "session");
  try {
    await mkdir(join(root, ".codex", "agents"), { recursive: true });
    await mkdir(join(root, ".codex", "workflows"), { recursive: true });
    await mkdir(join(root, ".agents", "skills", "alpha"), { recursive: true });
    await writeFile(join(root, ".codex", "agents", "runner.toml"), "# runner\n");
    await writeFile(join(root, ".agents", "skills", "alpha", "SKILL.md"), "# alpha\n");
    await writeFile(join(root, ".codex", "workflows", "minimal.yaml"), "schema_version: 1\nid: minimal\nroles: [runner]\nskills: [alpha]\nhooks:\n  before_complete: []\nstages:\n  - id: run\n    role: runner\n    skill: alpha\n    model_tier: implementation\n    needs: []\n");
    await git(root, "add", ".codex", ".agents"); await git(root, "commit", "-q", "-m", "workflow fixture");
    await git(root, "worktree", "add", "-q", "-b", "session", tree);
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "minimal", return_root: root });
    const base = (await git(tree, "rev-parse", "HEAD")).stdout.trim();
    const completeCli = join(import.meta.dirname, "../.codex/scripts/harness-workflow-complete.mjs");
    const result = await run(process.execPath, [completeCli, "--root", tree, "--workflow", "minimal", "--base-ref", base], { cwd: tree });
    const completion = JSON.parse(result.stdout);
    assert.equal(completion.state, "completed");
    assert.equal(completion.verdict.status, "pass");
    assert.equal(completion.worktree_cleanup.state, "removed");
    await assert.rejects(lstat(tree), { code: "ENOENT" });
  } finally { await removeFixture(); }
});

test("unowned linked and primary worktrees are preserved; active ownership is exclusive", async () => {
  const { root, main, tree } = await fixture();
  try {
    assert.equal((await finishWorkflowWorktree({ workspace_root: tree, repository_root: main })).state, "not-owned");
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "one", return_root: main });
    await assert.rejects(registerWorkflowWorktree({ workspace_root: tree, workflow_id: "two", return_root: main }), /another active workflow/);
    assert.equal((await finishWorkflowWorktree({ workspace_root: main, repository_root: main })).state, "not-owned");
    assert.equal(await lstat(main).then(() => true), true);
  } finally { await cleanup(root); }
});

test("branch tampering refuses cleanup and symlinks are archived without dereferencing", async () => {
  const { root, main, tree } = await fixture();
  try {
    await registerWorkflowWorktree({ workspace_root: tree, workflow_id: "flow", return_root: main });
    await git(tree, "checkout", "-b", "tampered");
    assert.equal((await finishWorkflowWorktree({ workspace_root: tree, repository_root: main })).state, "failed");
    await git(tree, "checkout", "workflow");
    const outside = join(root, "outside"); await writeFile(outside, "secret");
    await symlink(outside, join(tree, "link"));
    const result = await finishWorkflowWorktree({ workspace_root: tree, repository_root: main, workflow_id: "flow" });
    assert.equal(result.state, "removed");
    assert.equal(await readlink(join(result.recovery_path, "files", "link")), outside);
  } finally { await cleanup(root); }
});
