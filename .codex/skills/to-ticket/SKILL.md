---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation tickets and plans.
---

# to-ticket

## What it does

`to-ticket` is the public entrypoint for turning Product Spec and Architecture Spec into vertical implementation slices. It recommends a clean split, waits for approval, and then prepares the Issue and plan structure needed for execution.

## Flow

1. Run `code-research` to get the current codebase baseline in compact form.
2. Verify the Architecture Spec contains class and state diagrams before splitting; if absent, stop and report the missing artifact.
3. Split the spec into smart-zone vertical slices.
4. Attach policy-based unit tests and `ui ~ entity` e2e tests to each slice.
5. Define dependencies between slices.
6. Present the split plan to the user and wait for approval before any mutation.
7. After approval, read `.codex/harness.yaml` and use its tracker mode exclusively.
8. GitHub mode: create one parent Issue for the plan set and one child Issue per split slice, add them to the configured GitHub Project, and set their configured `Workflow Status` to `Planned`. Put the complete split-plan contract in each child Issue body and link the child Issues under the parent. local-markdown mode: create one ticket file and one matching plan document per slice in the configured directory with status `planned`, plus `docs/plans/plans.md` as its backlink index.
9. Store blocking edges in that same selected tracker.
10. Resolve the plan-set branch lineage using the rules below, create the new branch from the resolved fixed base ref, and push it to the remote. Do not assume `origin/main`.
11. In GitHub mode, after every split plan has been created, linked, and set to `Planned`, run `gh-open-pr` to create or update a draft plan PR against the resolved base branch. Include the parent Issue, all child Issues, dependencies, Product Spec, Architecture Spec, class diagram, state diagram, planning validation, and predecessor PR when present. Do not add an Issue-closing trigger. If the pushed branch has no commits beyond the resolved base ref, report that GitHub cannot create the PR and stop before implementation handoff.
12. Hand off the approved context to `implement`.

## Branch Lineage

Resolve branch lineage before creating the plan-set branch:

1. Fetch the remote and determine its default branch from Git instead of assuming `main`.
2. Inspect the current branch, its upstream, its commits relative to the remote default branch, and any open PR whose head is the current branch.
3. For a follow-up or continuation whose required implementation exists on an unmerged open PR, use that current branch or explicitly identified predecessor branch as the base branch. Capture its current commit as the fixed base ref before creating the new branch.
4. Use the remote default branch, such as `origin/main`, only when there is no unmerged predecessor or continuation dependency, or when the predecessor PR is already merged and the commit is present on the fetched default branch.
5. If the current non-default branch is unrelated, detached, dirty in a way that prevents safe branching, or has ambiguous predecessor status, stop and ask one Korean question identifying the candidate branches. Do not silently fall back to the default branch.
6. Record the resolved base branch, fixed base ref, predecessor PR, and reason in the plan-set handoff.

For a stacked follow-up, the resulting history must be:

```text
remote default branch
└── predecessor implementation branch / open PR
    └── follow-up plan-set branch / stacked PR
```

## Plan Representation

- GitHub Issues mode: each child Issue is one split plan. Its body must contain status, dependencies, implementation purpose, scope, acceptance criteria, test contract, and links to the relevant ticket-scoped class and state diagrams in the Architecture Spec. The parent Issue and its child links replace `docs/plans/plans.md`.
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
- Never discard an unmerged predecessor implementation by rebuilding a dependent follow-up branch from the default branch.
