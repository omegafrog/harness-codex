import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../src/doctor/index.mjs";
import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";

import { updateProject } from "../src/installer/update.mjs";
import { discoverHarnessOwnedFiles } from "../src/installer/lock.mjs";
import { loadNamedWorkflow } from "../src/workflow/index.mjs";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("internal skills reach installed workflows without public skill entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-internal-consumer-"));
  try {
    await updateProject({ sourceRoot: SOURCE, targetRoot: root, initialize: true });
    const names = await readdir(join(SOURCE, ".codex/internal-skills"));
    const owned = await discoverHarnessOwnedFiles(root);
    for (const name of names) {
      const relative = `.codex/internal-skills/${name}/GUIDE.md`;
      assert.ok(owned.includes(relative), name);
      await assert.rejects(readFile(join(root, `.agents/skills/${name}/SKILL.md`)), { code: "ENOENT" });
      const source = await readFile(join(SOURCE, relative), "utf8");
      assert.equal(await readFile(join(root, relative), "utf8"), source.replaceAll(".codex/skills/", ".agents/skills/"));
    }
    for (const name of ["spec-me", "to-ticket", "implement-wrapper", "frontend-design", "knowledge-harvest-workflow"]) {
      const workflow = await loadNamedWorkflow(name, { root });
      for (const [skill, path] of Object.entries(workflow.references.skills)) {
        if (names.includes(skill)) assert.equal(path, join(root, `.codex/internal-skills/${skill}/GUIDE.md`));
      }
    }
    // Cross-boundary links must resolve from the installed tree as well as the source.
    for (const relative of owned.filter((path) => path.endsWith("/GUIDE.md") || path.endsWith("/SKILL.md"))) {
      const text = await readFile(join(root, relative), "utf8");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || target.includes("://") || target.includes("<") || target.startsWith("/")) continue;
        const path = resolve(root, dirname(relative), target);
        if (path.startsWith(join(root, ".codex/internal-skills/")) || path.startsWith(join(root, ".agents/skills/"))) await readFile(path);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal skill migration backs up and removes managed public copies on skills-only update", async () => {
  const source = await mkdtemp(join(tmpdir(), "harness-internal-source-"));
  const target = await mkdtemp(join(tmpdir(), "harness-internal-target-"));
  try {
    const oldDirectory = join(source, ".codex/skills/helper");
    await mkdir(join(oldDirectory, "references"), { recursive: true });
    await writeFile(join(oldDirectory, "SKILL.md"), "old public helper\n");
    await writeFile(join(oldDirectory, "references/rule.md"), "old rule\n");
    await updateProject({ sourceRoot: source, targetRoot: target, initialize: true });
    await writeFile(join(target, ".agents/skills/helper/SKILL.md"), "local helper edits\n");
    await rm(oldDirectory, { recursive: true });
    const internal = join(source, ".codex/internal-skills/helper");
    await mkdir(join(internal, "references"), { recursive: true });
    await writeFile(join(internal, "GUIDE.md"), "internal helper\n");
    await writeFile(join(internal, "references/rule.md"), "internal rule\n");
    const agentsOnly = await updateProject({ sourceRoot: source, targetRoot: target, scope: "agents" });
    assert.ok(agentsOnly.lock.files[".agents/skills/helper/SKILL.md"]);
    assert.equal(await readFile(join(target, ".agents/skills/helper/SKILL.md"), "utf8"), "local helper edits\n");
    const result = await updateProject({ sourceRoot: source, targetRoot: target, scope: "skills" });
    assert.deepEqual(result.skipped, []);
    for (const path of [".agents/skills/helper/SKILL.md", ".agents/skills/helper/references/rule.md"]) {
      await assert.rejects(readFile(join(target, path)), { code: "ENOENT" });
      assert.ok(result.retired.includes(path));
      assert.equal(result.lock.files[path], undefined);
    }
    assert.equal(await readFile(join(result.backup_directory, ".agents/skills/helper/SKILL.md"), "utf8"), "local helper edits\n");
    assert.equal(await readFile(join(target, ".codex/internal-skills/helper/GUIDE.md"), "utf8"), "internal helper\n");
    assert.ok(result.lock.files[".codex/internal-skills/helper/GUIDE.md"]);
    const repeated = await updateProject({ sourceRoot: source, targetRoot: target });
    assert.deepEqual(repeated.updated, []);
    assert.deepEqual(repeated.added, []);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});


test("fresh and updated consumers receive the existing-root implementation policy without hiding application changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-implementation-policy-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const paths = [
    [".codex/skills/implement-wrapper/SKILL.md", ".agents/skills/implement-wrapper/SKILL.md"],
    ...["implement", "session-worktree", "sync-contracts"].map((name) => {
      const path = `.codex/internal-skills/${name}/GUIDE.md`;
      return [path, path];
    }),
  ];
  try {
    git("init", "--quiet");
    await writeFile(join(root, "app.txt"), "original application\n");
    git("add", "app.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "initial");
    await writeFile(join(root, "app.txt"), "application edit\n");
    await writeFile(join(root, "new-app.txt"), "new application file\n");
    const before = git("worktree", "list", "--porcelain");
    for (const operation of ["install", "update"]) {
      await protectLocalInstallArtifacts(root, SOURCE);
      await updateProject({ sourceRoot: SOURCE, targetRoot: root, initialize: operation === "install", scope: "skills" });
      const inventory = await discoverHarnessOwnedFiles(root);
      const lock = JSON.parse(await readFile(join(root, ".codex/harness-lock.json"), "utf8"));
      for (const [source, target] of paths) {
        assert.equal(await readFile(join(root, target), "utf8"), (await readFile(join(SOURCE, source), "utf8")).replaceAll(".codex/skills/", ".agents/skills/"));
        assert.ok(inventory.includes(target), target);
        assert.ok(lock.files[target], target);
      }
      const doctor = await runDoctor({ root, sourceRoot: SOURCE });
      assert.equal(doctor.diagnostics.some((item) => paths.some(([, target]) => item.path.endsWith(target))), false, JSON.stringify(doctor.diagnostics));
      assert.equal(git("worktree", "list", "--porcelain"), before);
      assert.equal(git("status", "--short", "--untracked-files=all"), " M app.txt\n?? new-app.txt\n");
      assert.equal(await readFile(join(root, "app.txt"), "utf8"), "application edit\n");
      if (operation === "install") {
        for (const [, target] of paths) await writeFile(join(root, target), "stale implementation policy\n");
        const stale = await runDoctor({ root, sourceRoot: SOURCE });
        for (const [, target] of paths) assert.ok(stale.diagnostics.some((item) => item.path.endsWith(target)), target);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
