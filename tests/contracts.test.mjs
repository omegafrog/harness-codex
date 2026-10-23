import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inspectContracts, sealContracts } from "../src/contracts/contracts.mjs";
import { updateProject, writeHarnessLock } from "../src/installer/update.mjs";
import { makeContractsFixture } from "./contracts-fixture.mjs";
import { sessionOutputPath } from "../src/workflow/session-output.mjs";
import { snapshotSpecReview } from "../src/workflow/spec-review.mjs";

const fixture = async () => (await makeContractsFixture()).root;
const cli = join(process.cwd(), ".codex/scripts/harness-workflow-complete.mjs");
async function assertSeal(root, options = {}) {
  const result = await sealContracts({ workspace_root: root, change_summary: "검토 완료", ...options });
  assert.equal(result.status, "pass", result.violations.join("; "));
}

test("canonical contract docs seal, detect drift, and validate all component kinds", async () => {
  const root = await fixture();
  try {
    assert.equal((await inspectContracts({ workspace_root: root })).status, "pass");
    await writeFile(join(root, "src/app.mjs"), "export const app = false;\n");
    assert.equal((await inspectContracts({ workspace_root: root })).reason, "contracts_out_of_sync");
    await assert.rejects(() => sealContracts({ workspace_root: root, change_summary: "검토", }), /no_contract_change/);
    await assertSeal(root, { no_contract_change: "구현 동작과 계약 영향 검토 완료" });
    assert.equal((await inspectContracts({ workspace_root: root, base_ref: "HEAD" })).status, "pass");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("first seal creates the HTML view in a fresh repository without HEAD", async () => {
  const { root, cleanup } = await makeContractsFixture({ commit: false });
  try {
    assert.equal((await inspectContracts({ workspace_root: root })).status, "pass");
    assert.match(await readFile(join(root, "docs/contracts/architecture.html"), "utf8"), /DDD 아키텍처/);
  } finally { await cleanup(); }
});

test("Spec edits require reconciliation while runtime receipts stay outside the snapshot", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "docs/specs"), { recursive: true });
    await writeFile(join(root, "docs/specs/new-spec.md"), "# Ticket Spec\n");
    assert.equal((await inspectContracts({ workspace_root: root })).reason, "contracts_out_of_sync");
    await assert.rejects(() => sealContracts({ workspace_root: root, change_summary: "Spec 갱신" }), /no_contract_change/);
    await assertSeal(root, { no_contract_change: "티켓 Spec 변경을 공통 계약에 비추어 검토했고 계약 의미는 동일함" });
    await writeFile(sessionOutputPath(root, "checkpoint.jsonl"), "runtime receipt\n");
    assert.equal((await inspectContracts({ workspace_root: root })).status, "pass");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("contract seal rejects missing fields, links, sequence, stale SVG, old revision, and unsafe paths", async () => {
  const root = await fixture();
  const manifestPath = join(root, "docs/contracts/manifest.json");
  const archPath = join(root, "docs/contracts/architecture.md");
  const original = await readFile(archPath, "utf8");
  const originalManifest = await readFile(manifestPath, "utf8");
  const svgPath = join(root, "docs/contracts/diagrams/ddd.svg");
  const originalSvg = await readFile(svgPath, "utf8");
  try {
    const missingServiceAttribute = original.replace(/(<a id="policy"><\/a>\n## policy\n[\s\S]*?)### 속성\n내용\n/, "$1");
    for (const [text, pattern] of [
      [original.replace("### 불변식\n내용", ""), /불변식/],
      [original.replace("architecture.md#root", "architecture.md#missing"), /child link/],
      [missingServiceAttribute, /Missing 속성: policy/],
      [original.replace("architecture.md#reserve", "architecture.md#missing"), /Missing child link: policy -> reserve/],
    ]) {
      await writeFile(archPath, text);
      await assert.rejects(() => sealContracts({ workspace_root: root, change_summary: "invalid" }), pattern);
      await writeFile(archPath, original);
    }
    await writeFile(svgPath, originalSvg.replace('<a xlink:href="../architecture.md#system">system</a>', "system ../architecture.md#system"));
    await assert.rejects(() => sealContracts({ workspace_root: root, change_summary: "missing clickable link" }), /Missing SVG link: system/);
    await writeFile(svgPath, originalSvg);
    const data = JSON.parse(originalManifest);
    data.diagrams = data.diagrams.filter((d) => d.kind !== "sequence");
    await writeFile(manifestPath, JSON.stringify(data));
    await assert.rejects(() => sealContracts({ workspace_root: root, change_summary: "invalid" }), /sequence/);
    await writeFile(manifestPath, originalManifest);
    await writeFile(join(root, "docs/contracts/diagrams/ddd.svg"), "<svg>stale</svg>");
    assert.ok((await inspectContracts({ workspace_root: root })).violations.some((v) => v.includes("Stale/unverified SVG")));
    await writeFile(svgPath, originalSvg);
    const oldRevision = JSON.parse(originalManifest);
    oldRevision.revision = 0;
    await writeFile(manifestPath, JSON.stringify(oldRevision));
    assert.ok((await inspectContracts({ workspace_root: root, base_ref: "HEAD" })).violations.some((v) => v.includes("revision must increase")));
    const unsafe = JSON.parse(originalManifest);
    unsafe.components[0].sources = ["../outside.mjs"];
    await writeFile(manifestPath, JSON.stringify(unsafe));
    assert.ok((await inspectContracts({ workspace_root: root })).violations.some((v) => v.includes("Invalid relative path")));
    const cycle = JSON.parse(originalManifest);
    cycle.components.find((c) => c.id === "booking").owner = "root";
    await writeFile(manifestPath, JSON.stringify(cycle));
    await assert.rejects(() => sealContracts({ workspace_root: root, change_summary: "cycle" }), /Owner cycle/);
    await writeFile(manifestPath, originalManifest);
    await writeFile(svgPath, `${originalSvg}<script>alert(1)</script>`);
    await assert.rejects(() => sealContracts({ workspace_root: root, change_summary: "unsafe svg" }), /Unsafe SVG content/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("completion CLI records verdicts and cannot bypass canonical contracts", async () => {
  const { root, cleanup } = await makeContractsFixture();
  try {
    await mkdir(join(root, ".codex/agents"), { recursive: true });
    await mkdir(join(root, ".codex/workflows"), { recursive: true });
    await mkdir(join(root, ".codex/internal-skills/sync-contracts"), { recursive: true });
    await writeFile(join(root, ".codex/agents/runner.toml"), "# local runner\n");
    await writeFile(join(root, ".codex/internal-skills/sync-contracts/GUIDE.md"), "# local skill\n");
    const workflowPath = join(root, ".codex/workflows/frontend-design.yaml");
    const workflow = (checks) => `schema_version: 1\nid: frontend-design\nroles: [runner]\nskills: [sync-contracts]\nhooks:\n  before_complete: [${checks}]\nstages:\n  - id: run\n    role: runner\n    skill: sync-contracts\n    model_tier: implementation\n    needs: []\n`;
    await writeFile(workflowPath, workflow("contract_docs"));
    const { stdout: base } = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const baseRef = base.trim();
    const run = (args = ["--root", root, "--workflow", "frontend-design", "--base-ref", baseRef], cwd = root) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });

    const passed = run();
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).state, "completed");
    const firstJournal = (await readFile(sessionOutputPath(root, `runtime/workflow-completion/frontend-design-${baseRef}.jsonl`), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(firstJournal.some((event) => event.type === "workflow_completion" && event.payload.state === "completed"));

    await writeFile(join(root, "src/app.mjs"), "export const app = 'stale';\n");
    const stale = run();
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stdout).state, "in-progress");
    assert.equal(JSON.parse(stale.stdout).verdict.checks.find((check) => check.rule_id === "contract_docs").status, "fail");
    assert.match(run(["--root", root, "--workflow", "frontend-design"]).stderr, /Starting commit SHA is required/);
    assert.match(run(["--root", root, "--workflow", "frontend-design", "--base-ref", baseRef], process.cwd()).stderr, /Workspace preflight failed/);

    await sealContracts({ workspace_root: root, change_summary: "영향 검토", no_contract_change: "구현 변경의 계약 영향 검토 완료" });
    const e2eStatePath = sessionOutputPath(root, "state/e2e-learning.json");
    for (const [status, expectedStatus] of [["passed", 0], ["failed", 1]]) {
    for (const e2e_failures of [[{
      id: "run-1", category: "product", status: "open", scenario: "checkout", profile_id: "e2e-learning-check",
      evidence_path: "evidence/failure.json", cause: "stale state", lesson_path: "lessons/checkout.md",
      verification_path: "verification/checkout.test.mjs", prevention_paths: ["src/checkout.mjs"],
    }], null]) {
      await writeFile(e2eStatePath, JSON.stringify({ tests: { status, e2e_failures } }));
      const blocked = run(["--root", root, "--workflow", "frontend-design", "--base-ref", baseRef, "--state", "state/e2e-learning.json"]);
      assert.equal(blocked.status, expectedStatus, blocked.stderr);
      const result = JSON.parse(blocked.stdout);
      assert.equal(result.state, status === "passed" ? "completed" : "in-progress");
      assert.equal(result.verdict.checks.find((check) => check.rule_id === "tests").status, status === "passed" ? "pass" : "fail");
    }
    }
    await writeFile(workflowPath, workflow(""));
    const removed = run();
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).state, "completed");
    assert.ok(JSON.parse(removed.stdout).verdict.checks.some((check) => check.rule_id === "contract_docs"));
    const journal = (await readFile(sessionOutputPath(root, `runtime/workflow-completion/frontend-design-${baseRef}.jsonl`), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(journal.some((event) => event.type === "workflow_completion" && event.payload.state === "completed"));
    assert.ok(journal.some((event) => event.type === "workflow_completion" && event.payload.state === "in-progress"));
  } finally { await cleanup(); }
});

test("installed completion CLI blocks spec-me without independent reviews and rejects unsafe state paths", async () => {
  const { root, cleanup } = await makeContractsFixture();
  try {
    await writeHarnessLock({ sourceRoot: process.cwd(), targetRoot: root });
    await updateProject({ sourceRoot: process.cwd(), targetRoot: root });
    const installedCli = join(root, ".codex/scripts/harness-workflow-complete.mjs");
    const { stdout: base } = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const baseRef = base.trim();
    const args = [installedCli, "--root", root, "--workflow", "spec-me", "--base-ref", baseRef];
    const run = (extra = []) => spawnSync(process.execPath, [...args, ...extra], { cwd: root, encoding: "utf8" });
    const passed = run();
    assert.equal(passed.status, 1, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).workflow_id, "spec-me");
    assert.equal(JSON.parse(passed.stdout).state, "in-progress");
    assert.equal(JSON.parse(passed.stdout).verdict.checks.find((check) => check.rule_id === "spec_reviews").status, "blocked");
    assert.match(await readFile(join(root, ".codex/harness-runtime/src/eval/workspace-preflight.mjs"), "utf8"), /inspectWorkspace/);

    const ticketId = "completion-review-fixture";
    const specRoot = join(root, "docs/specs", ticketId);
    await mkdir(join(specRoot, "diagrams/product"), { recursive: true });
    await mkdir(join(specRoot, "diagrams/architecture"), { recursive: true });
    for (const [name, value] of [["request.md", "request"], ["product-spec.md", "product"], ["architecture-spec.md", "architecture"]]) await writeFile(join(specRoot, name), `${value}\n`);
    await writeFile(join(specRoot, "diagrams/product/product.puml"), "@startuml\n@enduml\n");
    await writeFile(join(specRoot, "diagrams/architecture/architecture.puml"), "@startuml\n@enduml\n");
    // Fixture-only review metadata exercises completion validation; it does not represent a production review.
    const spec_reviews = {};
    for (const axis of ["product", "architecture"]) spec_reviews[axis] = {
      axis, ticket_id: ticketId, reviewer_id: `reviewer-${axis}`, author_ids: ["fixture-writer"], fork_turns: "none",
      verdict: "pass", findings: [], inputs: await snapshotSpecReview({ root, ticketId, axis }),
    };
    await sealContracts({ workspace_root: root, change_summary: "fixture Spec added", no_contract_change: "테스트용 Spec fixture는 계약 외부 항목임" });
    await writeFile(sessionOutputPath(root, "state/reviews.json"), JSON.stringify({ ticket_id: ticketId, spec_reviews }));
    const reviewed = run(["--state", "state/reviews.json"]);
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(JSON.parse(reviewed.stdout).state, "completed");
    assert.equal(JSON.parse(reviewed.stdout).completion_kind, "spec_ready_for_planning");

    const workflowPath = join(root, ".codex/workflows/spec-me.yaml");
    const installedWorkflow = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, installedWorkflow.replace("before_complete: [tracker_sync, contract_docs, spec_reviews]", "before_complete: []"));
    const removedHook = run();
    assert.equal(removedHook.status, 1, removedHook.stderr);
    assert.equal(JSON.parse(removedHook.stdout).verdict.checks.find((check) => check.rule_id === "spec_reviews").status, "blocked");

    for (const path of ["/etc/passwd", "../outside.json"]) {
      const rejected = run(["--state", path]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /relative path without traversal/);
    }
    await writeFile(sessionOutputPath(root, "state/valid.json"), JSON.stringify({ ticket_id: ticketId, spec_reviews }));
    const statePassed = run(["--state", "state/valid.json"]);
    assert.equal(statePassed.status, 0, statePassed.stderr);
    assert.equal(JSON.parse(statePassed.stdout).completion_kind, "spec_ready_for_planning");

    const toTicketWorkflowPath = join(root, ".codex/workflows/to-ticket.yaml");
    const toTicketWorkflow = await readFile(toTicketWorkflowPath, "utf8");
    await writeFile(toTicketWorkflowPath, toTicketWorkflow.replace("before_complete: [", "before_complete: [contract_docs, "));
    const toTicket = spawnSync(process.execPath, [installedCli, "--root", root, "--workflow", "to-ticket", "--base-ref", baseRef], { cwd: root, encoding: "utf8" });
    assert.equal(toTicket.status, 1);
    assert.equal(JSON.parse(toTicket.stdout).completion_kind, "plan_set_ready_for_implementation");
    assert.ok(!JSON.parse(toTicket.stdout).verdict.checks.some((check) => check.rule_id === "contract_docs"));
    await symlink("valid.json", sessionOutputPath(root, "state/linked.json"));
    const linked = run(["--state", "state/linked.json"]);
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /symlink or shared hardlink/);
  } finally { await cleanup(); }
});
