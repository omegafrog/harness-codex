---
name: session-worktree
description: Prepare or reuse the linked Git worktree for a Harness workflow session.
---

# Session worktree

Prepare the absolute `session_worktree` before a workflow reads or writes repository files.

1. Inspect `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD`, `git status --porcelain`, and `git worktree list --porcelain` from the active directory.
2. If the active directory is already a registered linked worktree, reuse it without creating another worktree. Capture its root, branch, and `HEAD` as `session_worktree`, `session_branch`, `session_base_branch`, and `session_base_sha`.
3. Otherwise, require a named branch and a clean working tree. Create a sibling linked worktree and dedicated branch from the active branch and captured `HEAD`; do not require or fetch `origin/main`. Record `session_worktree` and `session_branch`.
4. Carry over local setup configuration that Git does not track. If `<source_workspace>/.codex/harness.yaml` exists and `<session_worktree>/.codex/harness.yaml` does not, create the target `.codex` directory and copy the file without overwriting an existing target.
5. Install the project-local Harness runtime before any workflow stage or subagent spawn. For a Harness source checkout, run `node <harness_source_root>/bin/harness-install.mjs install --project <session_worktree> --force`. Otherwise run `npx --yes github:omegafrog/harness-codex install --project <session_worktree> --force`.
6. Resolve `<session_worktree>/.agents/skills/<skill>/SKILL.md` first, then `<session_worktree>/.codex/skills/<skill>/SKILL.md`, matching the workflow loader. Harness source checkouts use repository-owned `.codex/skills` directly. Verify the workflow's required skills, `.codex/agents/spec_document_writer.toml`, and `.codex/workflows/spec-me.yaml` exist; stop if installation or verification fails.
7. Before starting a stage or subagent, run from `session_worktree`: `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <session_worktree> --json`. Require `valid: true`, matching `cwd` and `git_root`, `worktree_registered: true`, and `is_linked_worktree: true`.
8. Pass the exact absolute `session_worktree` as both `cwd` and `workspace_root` to every tool and agent that accesses repository files. A command's working directory does not carry over to later calls.
