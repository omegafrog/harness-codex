import test from "node:test";
import assert from "node:assert/strict";

import { buildQualityEvaluatorCommand } from "../src/eval/graders/quality.mjs";

test("quality evaluator command skips git repo trust checks for isolated grader workspace", () => {
  assert.deepEqual(
    buildQualityEvaluatorCommand(
      ["codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--sandbox", "workspace-write"],
      "fixed-evaluator-v1",
    ),
    [
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--model",
      "fixed-evaluator-v1",
      "--config",
      "sandbox_workspace_write.network_access=false",
    ],
  );
});

test("quality evaluator command does not duplicate skip-git-repo-check", () => {
  const command = buildQualityEvaluatorCommand(
    ["codex", "exec", "--json", "--skip-git-repo-check"],
    "fixed-evaluator-v1",
  );

  assert.equal(command.filter((part) => part === "--skip-git-repo-check").length, 1);
});

test("non-Codex evaluator commands are not given Codex-only trust flags", () => {
  assert.deepEqual(
    buildQualityEvaluatorCommand(["custom-evaluator", "--json"], "fixed-evaluator-v1"),
    ["custom-evaluator", "--json", "--model", "fixed-evaluator-v1"],
  );
});
