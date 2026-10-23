import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { inspectWorkspace } from "../src/eval/workspace-preflight.mjs";

const execFileAsync = promisify(execFile);

test("workspace preflight accepts only the expected registered Git worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-workspace-preflight-"));
  const main = join(root, "main");
  const session = join(root, "session");
  const elsewhere = join(root, "elsewhere");
  try {
    await execFileAsync("git", ["init", "-q", "-b", "main", main]);
    await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base"], { cwd: main });
    await execFileAsync("git", ["worktree", "add", "-q", "-b", "session", session], { cwd: main });
    const valid = await inspectWorkspace({ workspaceRoot: session, cwd: session });
    assert.equal(valid.valid, true);
    assert.equal(valid.worktree_registered, true);
    assert.equal(valid.is_linked_worktree, true);
    assert.equal(valid.git_root, session);

    const wrongCwd = await inspectWorkspace({ workspaceRoot: session, cwd: process.cwd() });
    assert.equal(wrongCwd.valid, false);
    assert.equal(wrongCwd.reason, "cwd_mismatch");

    const unregistered = await inspectWorkspace({ workspaceRoot: elsewhere, cwd: elsewhere });
    assert.equal(unregistered.valid, false);
    assert.equal(unregistered.reason, "workspace_path_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
