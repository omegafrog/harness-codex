---
name: harness-change-set-pr
description: Create the final target-repository pull request for a completed harness ChangeSet. Use after all ChangeSet implementation gates pass, the project wiki gate passes, and the ChangeSet completion gate succeeds; also use when wiring or auditing the final PR creation step in harness runtime workflows.
---

# Harness ChangeSet PR

Create the final PR for target-repository ChangeSet output.

## Preconditions

Run only after:

- all affected work-item plans completed
- required verification gates passed
- project wiki update completed
- `./harness run wiki build` passed
- `docs/changes/active/<CHG-ID>.md` moved to `docs/changes/completed/<CHG-ID>.md`

Do not use this skill to bypass a failed workflow gate.

## Target Repository

Operate only in the runtime `repo_root`.

When `--repo-root` is present, that path is the target repository. Do not open a PR in the harness repository unless the harness repository itself is the target repository.

## Required Behavior

The final PR gate must:

1. Verify the target repository is a git worktree.
2. Verify the target repository has a current branch.
3. Verify `origin` exists.
4. Block if the current branch is the base branch.
5. Commit target-repository ChangeSet output when dirty changes exist.
6. Push the current branch to `origin`.
7. Open or reuse a GitHub PR.
8. Record the PR URL in `.harness/runs/<RUN-ID>/pull-request.json`.

The gate passes only when the PR URL is recorded.

## Blocking Rules

Block with the exact prerequisite failure when:

- `gh` is missing
- target repository is not a git worktree
- current branch is missing
- `origin` is missing
- current branch is the base branch
- commit fails
- push fails
- PR creation fails
- GitHub command succeeds without a PR URL

## PR Body

Use Korean PR body sections:

- 구현 의도
- 구현 접근
- 검증 방법
- 위험 및 롤백

The PR body must mention the ChangeSet ID and runtime run ID when available.

## Reporting

Report:

- target repository
- ChangeSet ID
- run ID
- PR URL
- whether PR was newly created or reused
- blocked gate and exact error when blocked
