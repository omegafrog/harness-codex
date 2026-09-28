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
  const elsewhere = join(root, "elsewhere");
  try {
    await execFileAsync("git", ["init", "-q", root]);
    const valid = await inspectWorkspace({ expectedRoot: root, cwd: root });
    assert.equal(valid.valid, true);
    assert.equal(valid.worktree_registered, true);

    const wrongCwd = await inspectWorkspace({ expectedRoot: root, cwd: process.cwd() });
    assert.equal(wrongCwd.valid, false);
    assert.equal(wrongCwd.reason, "cwd_mismatch");

    const unregistered = await inspectWorkspace({ expectedRoot: elsewhere, cwd: elsewhere });
    assert.equal(unregistered.valid, false);
    assert.equal(unregistered.reason, "workspace_path_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
