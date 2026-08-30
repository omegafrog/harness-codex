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
10. Create new branch for entire plan set from origin/main and push to remote,
11. Hand off the approved context to `implement`.

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
