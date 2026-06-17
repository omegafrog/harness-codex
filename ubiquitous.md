# Project Ubiquitous Language

This file defines project-local terms for the harness repository. Use these meanings when discussing or implementing harness workflows.

## Repository Roles

### Harness repository

The repository that contains the harness runtime, CLI, dashboard, skills, agents, and workflow orchestration code.

Changes to runtime behavior belong to the harness repository.

### Target repository

The repository passed through `--repo-root`.

Harness runtime workflows operate on the target repository. ChangeSet artifacts, generated documents, implementation changes, verification artifacts, and wiki updates are target-repository outputs unless a command explicitly states otherwise.

### Repo root

The effective root of the repository being operated on by a harness runtime command.

If a command uses `--repo-root ../zeten`, then `../zeten` is the target repository and workflow outputs belong there.

Do not infer the current shell working directory as the target repository when `--repo-root` is present.

## Workflow Terms

### Harness runtime workflow

A workflow executed by the harness runtime CLI, such as requirements, use cases, ChangeSet execution, planning, implementation, verification, wiki update, or completion.

A completed ChangeSet implementation workflow includes target-repository PR creation after final gates pass.

### ChangeSet

A target-repository work unit managed by the harness runtime.

A ChangeSet includes staged artifacts such as requirements, affected use cases, event storming, DDD design, technical decisions, plans, implementation results, verification results, and completion state.

### ChangeSet output

Any file or state produced for a ChangeSet in the target repository.

Examples include `docs/changesets`, `docs/use-cases`, `docs/plans`, generated wiki updates, implementation code changes, and dashboard projection state.

ChangeSet output is not the same as a runtime code fix in the harness repository.

### Runtime behavior change

A change to harness code that modifies how workflows run.

Examples include changing resume targets, retry policy, gate classification, dashboard projection, or CLI behavior.

Runtime behavior changes belong to the harness repository even when discovered while operating on a target repository.

## Delivery Terms

### Pull request

A GitHub PR opened from committed repository changes.

For completed ChangeSet implementation workflows, PR creation is a final delivery gate.

When a PR is required, its repository must match the changed files:

- Target-repository ChangeSet output -> target repository PR.
- Harness runtime behavior change -> harness repository PR.

### deliver-worktree-pr

A Codex skill that wraps repository work with isolated worktree creation, implementation, verification, commit, push, PR creation, and conflict checks.

This is not the same thing as a harness runtime workflow.

Only use `deliver-worktree-pr` semantics when that skill is explicitly requested or when the user asks for PR delivery.

## Gate Terms

### Workflow gate

A harness runtime decision point that must pass before the workflow continues.

Examples include planning review, security plan review, scope-diff guard, implementation execution, verification, and completion gates.

### Test gate

A repository test or verification command run outside or inside a workflow to validate code behavior.

Harness unit tests validate harness runtime code. They do not prove that a target-repository ChangeSet workflow completed.

### PR creation gate

The final ChangeSet delivery gate that commits target-repository workflow output, pushes the current branch to `origin`, and opens or reuses a GitHub PR.

This gate passes only when a PR URL is recorded.

This gate blocks when target repository git/GitHub prerequisites are missing, such as no current branch, no `origin` remote, missing `gh`, failed push, or failed PR creation.

### Gate pass

A gate passes only when the exact gate under discussion reports success.

Do not collapse different gates into one statement.

Examples:

- "Harness focused tests passed" means the selected harness tests passed.
- "Zeten ChangeSet workflow passed" means the runtime workflow for `--repo-root ../zeten` completed its required workflow gates.
- "PR creation gate passed" means the target-repository PR URL was recorded.
- "PR mergeability passed" means GitHub and local conflict checks passed for a PR branch.

## Required Clarifications

When reporting workflow status, always identify:

- Target repository.
- Workflow or skill being discussed.
- ChangeSet ID or branch when applicable.
- Current gate or failed gate.
- Whether the result is runtime workflow completion, test verification, PR delivery, or only a runtime-code patch.

When blocked, report:

- Stage ID.
- Gate name.
- Failure kind.
- Blocking artifact or message.
- Whether retry should restart from planning, implementation, verification, or requires upstream input.

## Session Lesson

The phrase "workflow completed" is ambiguous and must not be used alone.

Use specific status instead:

- "Harness runtime patch verified."
- "Target ChangeSet workflow completed."
- "Target ChangeSet workflow blocked at review gate."
- "Target repository PR opened."
- "Harness repository PR opened."

This prevents confusing a harness runtime fix with target-repository ChangeSet delivery.
