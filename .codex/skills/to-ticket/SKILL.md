---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation tickets and plans.
---

# to-ticket

## What it does

`to-ticket` is the public entrypoint for turning Product Spec and Architecture Spec into vertical implementation slices. It recommends a clean split, waits for approval, and then prepares the Issue and plan structure needed for execution.

## Flow

1. Run `code-research` to get the current codebase baseline in compact form.
2. Split the spec into smart-zone vertical slices.
3. Attach policy-based unit tests and `ui ~ entity` e2e tests to each slice.
4. Define dependencies between slices.
5. Present the split plan to the user and wait for approval before any mutation.
6. After approval, read `.codex/harness.yaml` and use its tracker mode exclusively.
7. GitHub mode: create one parent Issue for the plan set and one child Issue per split slice, add them to the configured GitHub Project, and set their configured `Workflow Status` to `Planned`. Put the complete split-plan contract in each child Issue body and link the child Issues under the parent. local-markdown mode: create one ticket file and one matching plan document per slice in the configured directory with status `planned`, plus `docs/plans/plans.md` as its backlink index.
8. Store blocking edges in that same selected tracker.
9. Capture the current session branch and `HEAD` using the rules below, create the new plan-set branch from that fixed base ref, and push it to the remote. Do not assume or switch to `origin/main`.
10. In GitHub mode, after every split plan has been created, linked, and set to `Planned`, run `gh-open-pr` to create or update a draft plan PR against the captured session base branch. Include the parent Issue, all child Issues, dependencies, Product Spec, Architecture Spec, available diagram links, planning validation, and captured base branch. Do not add an Issue-closing trigger. If the pushed branch has no commits beyond the fixed base ref, report that GitHub cannot create the PR and stop before implementation handoff.
11. Hand off the approved context to `implement`.

## Branch Lineage

Capture branch lineage immediately before creating the plan-set branch:

1. Read the current session's current branch with `git branch --show-current`. Use that exact branch as the base branch without inferring dependency, PR state, or relation to the remote default branch.
2. Capture the current `HEAD` commit as the fixed base ref before switching or creating branches.
3. Create the new plan-set branch from that fixed base ref. Do not switch to the remote default branch or rebuild from `origin/main`.
4. In GitHub mode, push the captured base branch first when it has no remote ref, then push the new plan-set branch.
5. If the current session is detached or has uncommitted changes that prevent safe branch creation, stop and ask one Korean question explaining the exact condition. Do not choose another base branch.
6. Record the captured session base branch and fixed base ref in the plan-set handoff.

The resulting history must be:

```text
current session branch at captured HEAD
└── new plan-set branch
```

## Plan Representation

- GitHub Issues mode: each child Issue is one split plan. Its body must contain status, dependencies, implementation purpose, scope, acceptance criteria, test contract, and links to relevant ticket-scoped diagrams when they exist. The parent Issue and its child links replace `docs/plans/plans.md`.
- local-markdown mode: create exactly one plan document per split slice at `docs/plans/<plan-id>.md`. Keep `docs/plans/plans.md` as an index only: it contains backlinks to the current individual plan documents, not full plan bodies. After approval, create or overwrite it for the current ticket set; do not preserve or append prior entries or collapse plan bodies into it.
- In either mode, record slice-specific classes, relationships, states, and transitions when the slice changes them.
- Write a Korean implementation-purpose section in every plan representation. Explain clearly what the plan will implement and why, so the intended implementation is understandable without reading the Issue.

## Rules

- Do not mutate GitHub or local plan files before approval.
- Keep one Issue per split plan.
- Include policy-based unit tests and `ui ~ entity` e2e tests in every plan slice.
- Do not split only by layer.
- Do not write to a non-selected tracker. GitHub mode uses configured `Workflow Status`; local-markdown mode uses ticket status.
- Use the current spec and codebase summary as the source of truth.
- Always branch from the current session branch captured at `to-ticket` entry; never substitute a guessed default or predecessor branch.
