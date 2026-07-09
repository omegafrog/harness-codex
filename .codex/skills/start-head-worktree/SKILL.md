---
name: start-head-worktree
description: Update the current Git branch from origin, then create a new isolated Git worktree and branch from the updated exact HEAD commit. Use when the user asks to start work in a separate, individual, isolated, parallel, or task-specific worktree based on the current checkout or current HEAD.
---

# Start HEAD Worktree

Create one worktree with `scripts/start_head_worktree.py`.

## Workflow

1. Confirm the source worktree has no tracked or untracked changes.
2. Run from the target repository or pass `--repo`.
3. Derive a short task slug from the user request.
4. Run:

```bash
python3 <skill-dir>/scripts/start_head_worktree.py <task-slug>
```

5. Report created path, branch, and base commit.
6. Continue requested work inside created worktree when worktree creation is preparatory.

## Options

```bash
python3 <skill-dir>/scripts/start_head_worktree.py <task-slug> \
  --repo /path/to/repo \
  --branch feature/custom-branch \
  --path /path/to/worktree
```

- Omit `--branch` → use `worktree/<task-slug>`.
- Omit `--path` → use sibling path `<repo-name>-<task-slug>`.
- Generated branch/path collisions → append numeric suffix.
- Explicit branch/path collisions → fail without modifying existing work.
- Before creating worktree, run `git fetch origin` then `git pull --ff-only origin <current-branch>`.

## Guardrails

- Require a clean source worktree before fetch/pull.
- Require a local branch checkout and an `origin` remote.
- Base new branch on SHA returned by `git rev-parse HEAD` after fetch/pull, not branch name.
- Do not include uncommitted or untracked files; current HEAD means committed state only.
- Do not stash, reset, clean, or otherwise alter source worktree.
- Keep worktree when later task execution fails unless user asks to remove it.
- Use resulting path as working directory for subsequent commands.
