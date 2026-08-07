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
6. After approval, create Issue that cover the entire plan including sub-issues per slice, one plan document per slice, and a newly generated backlink index at `docs/plans/plans.md`.
7. Set every new plan status to `planned`, then evaluate the complete dependency graph.
8. Set every approved, dependency-free, implementation-ready plan to `ready-for-agent`; keep dependency-blocked plans as `planned`.
9. Publish each Issue using tracker-specific labels or metadata. Keep the Issue `ready-for-agent` label exactly aligned with the plan status.
10. Create new branch for entire plan set from origin/main and push to remote,
11. Hand off the approved context to `implement`.

## Plan Files

- Store each split plan in its own Markdown file, for example `docs/plans/<plan-id>.md`.
- Keep `docs/plans/plans.md` as an index only. It contains backlinks to individual plan documents, not full plan bodies.
- Always create or overwrite `docs/plans/plans.md` for the current ticket set after approval; do not preserve or append prior index entries.
- Keep one Issue matched to one plan document.
- Put plan status, dependencies, acceptance criteria, test contract, and implementation scope in the individual plan document.
- Write a Korean `구현 목적` section in every plan document. Explain clearly what the plan will implement and why, so the intended implementation is understandable without reading the Issue.
- Use `completed` as the terminal plan status.
- Use only the plan statuses defined in `docs/agents/plan-status.md`: `planned`, `ready-for-agent`, `in-progress`, `completed`, `blocked`.
- Do not use `pending` as a plan status.
- Do not collapse multiple plan documents into a single `plans.md` body.

## Rules

- Do not mutate GitHub or local plan files before approval.
- Keep one Issue per split plan.
- Include policy-based unit tests and `ui ~ entity` e2e tests in every plan slice.
- Do not split only by layer.
- Apply labels or metadata at publish time, not during the planning-only pass.
- Before handoff, assert that at least one executable plan is `ready-for-agent` unless the entire graph is blocked; report the violating plan IDs.
- Use the current spec and codebase summary as the source of truth.

## Pulled out on purpose

`to-ticket` keeps the public surface small and pushes the actual splitting rules into the internal skill.
