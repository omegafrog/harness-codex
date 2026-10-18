import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sessionDirectory, sessionOutputPath } from "../src/workflow/session-output.mjs";

test("session output is scoped per workspace and survives workspace cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-output-"));
  const repository = join(root, "repo"), first = join(root, "first"), second = join(root, "second");
  await mkdir(repository);
  const git = (args) => import("node:child_process").then(({ execFileSync }) => execFileSync("git", args, { cwd: repository, stdio: "ignore" }));
  try {
    await git(["init", "-q"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base"]);
    await git(["worktree", "add", "-q", "-b", "first", first]);
    await git(["worktree", "add", "-q", "-b", "second", second]);
    const a = sessionDirectory(first, { repositoryRoot: repository });
    const b = sessionDirectory(second, { repositoryRoot: repository });
    assert.notEqual(a, b);
    assert.equal(await realpath(a), a);
    if (process.platform !== "win32") {
      await chmod(a, 0o777);
      sessionDirectory(first, { repositoryRoot: repository });
      assert.equal((await stat(a)).mode & 0o777, 0o700);
    }
    await writeFile(sessionOutputPath(first, "logs/run.txt", { repositoryRoot: repository }), "kept");
    await rm(first, { recursive: true, force: true });
    assert.equal(await (await import("node:fs/promises")).readFile(join(a, "logs/run.txt"), "utf8"), "kept");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session output rejects traversal, symlink parents/targets, and shared hardlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-output-safe-"));
  try {
    const session = sessionDirectory(root);
    assert.throws(() => sessionOutputPath(root, "../escape"), /relative path/);
    assert.throws(() => sessionOutputPath(root, "/tmp/escape"), /relative path/);
    await symlink(tmpdir(), join(session, "linked"));
    assert.throws(() => sessionOutputPath(root, "linked/out.txt"), /must not be a symlink/);
    await writeFile(join(session, "target"), "data");
    await symlink("target", join(session, "link"));
    assert.throws(() => sessionOutputPath(root, "link"), /symlink or shared hardlink/);
    await link(join(session, "target"), join(session, "alias"));
    assert.throws(() => sessionOutputPath(root, "alias"), /symlink or shared hardlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("E2E artifact guard requires a session manifest and removes only new artifacts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "session-artifact-"));
  const main = join(parent, "main"), root = join(parent, "worktree");
  const guard = join(import.meta.dirname, "../.codex/skills/e2e-test/scripts/artifact-guard.mjs");
  const run = (action, manifest) => spawnSync(process.execPath, [guard, action, "--root", root, "--manifest", manifest], { encoding: "utf8" });
  try {
    await mkdir(main);
    assert.equal(spawnSync("git", ["init", "-q", main]).status, 0);
    assert.equal(spawnSync("git", ["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base"]).status, 0);
    assert.equal(spawnSync("git", ["-C", main, "worktree", "add", "-q", "-b", "test", root]).status, 0);
    await writeFile(join(root, ".gitignore"), "*.artifact\n");
    await writeFile(join(root, "preexisting.artifact"), "keep");
    await writeFile(join(root, "preexisting.untracked"), "keep");
    const outside = run("snapshot", join(root, "outside.json"));
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /relative path without traversal/);

    const manifest = sessionOutputPath(root, "runtime/e2e/artifacts.json");
    assert.equal(run("snapshot", manifest).status, 0);
    await writeFile(join(root, "created.artifact"), "remove");
    await writeFile(join(root, "created.untracked"), "remove");
    const listing = spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "--ignored"], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /created\.artifact/);
    const cleaned = run("cleanup", manifest);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.deepEqual(JSON.parse(cleaned.stdout).removed, ["created.artifact", "created.untracked"]);
    assert.equal(await readFile(join(root, "preexisting.artifact"), "utf8"), "keep");
    assert.equal(await readFile(join(root, "preexisting.untracked"), "utf8"), "keep");
    assert.equal(await readFile(join(root, "created.artifact")).then(() => true, () => false), false);
    assert.equal(await readFile(join(root, "created.untracked")).then(() => true, () => false), false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
