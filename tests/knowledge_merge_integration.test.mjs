import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { WorktreeManager } from "../src/eval/plan-workspace.mjs";

const execFileAsync = promisify(execFile);

async function git(root, args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function fixture(t, { baseKnowledge = "id: k-one\nstatement: Base\napproval:\n  body_sha256: base\n", sourceKnowledge, targetKnowledge, sourceOther, targetOther } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "knowledge-merge-integration-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo");
  const runtime = join(temp, "runtime");
  await execFileAsync("git", ["init", "-q", repo]);
  await git(repo, ["config", "user.email", "integration@example.invalid"]);
  await git(repo, ["config", "user.name", "Integration Test"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await mkdir(join(repo, "knowledge", "principles"), { recursive: true });
  await writeFile(join(repo, "knowledge", "principles", "k-one.yaml"), baseKnowledge);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await git(repo, ["branch", "--show-current"])).stdout.trim();
  const mergeCommands = [];
  const runGitCommand = async (root, args) => {
    if (args[0] === "merge" && args[1] !== "--abort") mergeCommands.push([...args]);
    return git(root, args);
  };
  const manager = new WorktreeManager({ repoRoot: repo, runtimeRoot: runtime, runId: "knowledge-merge", runGitCommand });
  const handle = await manager.allocate({ planId: "source", fixedGroupBase: base, groupId: "merge-group" });
  if (sourceKnowledge !== undefined) {
    await writeFile(join(handle.workspace, "knowledge", "principles", "k-one.yaml"), sourceKnowledge);
  }
  if (sourceOther !== undefined) await writeFile(join(handle.workspace, "notes.txt"), sourceOther);
  await git(handle.workspace, ["add", "."]);
  await git(handle.workspace, ["commit", "-q", "-m", "source edit"]);
  if (targetKnowledge !== undefined) await writeFile(join(repo, "knowledge", "principles", "k-one.yaml"), targetKnowledge);
  if (targetOther !== undefined) await writeFile(join(repo, "notes.txt"), targetOther);
  await git(repo, ["add", "."]);
  if (targetKnowledge !== undefined || targetOther !== undefined) await git(repo, ["commit", "-q", "-m", "target edit"]);
  return { manager, handle, repo, branch, mergeCommands };
}

test("integrate reports divergent same-ID body edits and aborts before Git merge", async (t) => {
  const f = await fixture(t, {
    sourceKnowledge: "id: k-one\nstatement: Source\napproval:\n  body_sha256: base\n",
    targetKnowledge: "id: k-one\nstatement: Target\napproval:\n  body_sha256: base\n",
  });
  await assert.rejects(
    () => f.manager.integrate(f.handle, { targetWorkspace: f.repo, expectedTargetBranch: f.branch }),
    (error) => {
      assert.equal(error.reason, "knowledge_merge_conflict");
      assert.deepEqual(error.conflicts, [{ id: "k-one", object_kind: "principle", fields: ["statement"] }]);
      return true;
    },
  );
  assert.deepEqual(f.mergeCommands, []);
});

test("integrate reports divergent same-ID approval edits without exposing object content", async (t) => {
  const f = await fixture(t, {
    sourceKnowledge: "id: k-one\nstatement: Base\napproval:\n  body_sha256: source-approval\n",
    targetKnowledge: "id: k-one\nstatement: Base\napproval:\n  body_sha256: target-approval\n",
  });
  await assert.rejects(
    () => f.manager.integrate(f.handle, { targetWorkspace: f.repo, expectedTargetBranch: f.branch }),
    (error) => {
      assert.equal(error.reason, "knowledge_merge_conflict");
      assert.deepEqual(error.conflicts, [{ id: "k-one", object_kind: "principle", fields: ["approval"] }]);
      assert.doesNotMatch(error.message, /source-approval|target-approval/);
      return true;
    },
  );
  assert.deepEqual(f.mergeCommands, []);
});

test("integrate fails closed on malformed source Knowledge YAML before Git merge", async (t) => {
  const f = await fixture(t, {
    sourceKnowledge: "id: k-one\nnot a mapping\n",
    targetKnowledge: "id: k-one\nstatement: Target\napproval:\n  body_sha256: base\n",
  });
  await assert.rejects(
    () => f.manager.integrate(f.handle, { targetWorkspace: f.repo, expectedTargetBranch: f.branch }),
    (error) => {
      assert.equal(error.reason, "knowledge_merge_invalid");
      assert.deepEqual(error.invalid_objects, [{
        id: "k-one",
        object_kind: "principle",
        path: "knowledge/principles/k-one.yaml",
        side: "source",
        cause: "Invalid YAML mapping: not a mapping",
      }]);
      return true;
    },
  );
  assert.deepEqual(f.mergeCommands, []);
});

test("integrate fails closed on malformed target Knowledge YAML before Git merge", async (t) => {
  const f = await fixture(t, {
    sourceKnowledge: "id: k-one\nstatement: Source\napproval:\n  body_sha256: base\n",
    targetKnowledge: "id: k-one\nnot a mapping\n",
  });
  await assert.rejects(
    () => f.manager.integrate(f.handle, { targetWorkspace: f.repo, expectedTargetBranch: f.branch }),
    (error) => {
      assert.equal(error.reason, "knowledge_merge_invalid");
      assert.deepEqual(error.invalid_objects, [{
        id: "k-one",
        object_kind: "principle",
        path: "knowledge/principles/k-one.yaml",
        side: "target",
        cause: "Invalid YAML mapping: not a mapping",
      }]);
      return true;
    },
  );
  assert.deepEqual(f.mergeCommands, []);
});

test("identical same-ID edits continue to Git merge", async (t) => {
  const content = "id: k-one\nstatement: Identical\napproval:\n  body_sha256: base\n";
  const f = await fixture(t, { sourceKnowledge: content, targetKnowledge: content });
  const result = await f.manager.integrate(f.handle, { targetWorkspace: f.repo, expectedTargetBranch: f.branch });
  assert.equal(result.merged, true);
  assert.equal(f.mergeCommands.length, 1);
});

test("one-sided same-ID edits continue to Git merge", async (t) => {
  const f = await fixture(t, { sourceKnowledge: "id: k-one\nstatement: Source only\napproval:\n  body_sha256: base\n" });
  const result = await f.manager.integrate(f.handle, { targetWorkspace: f.repo, expectedTargetBranch: f.branch });
  assert.equal(result.merged, true);
  assert.equal(f.mergeCommands.length, 1);
});

test("non-Knowledge Git conflicts retain the existing integration behavior", async (t) => {
  const f = await fixture(t, { sourceOther: "source\n", targetOther: "target\n" });
  await assert.rejects(
    () => f.manager.integrate(f.handle, { targetWorkspace: f.repo, expectedTargetBranch: f.branch }),
    (error) => {
      assert.equal(error.reason, "integration_conflict");
      assert.deepEqual(error.conflicts, ["notes.txt"]);
      return true;
    },
  );
  assert.equal(f.mergeCommands.length, 1);
});
