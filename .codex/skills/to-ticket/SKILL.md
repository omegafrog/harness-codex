---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation tickets and plans.
---

# to-ticket

## What it does

`to-ticket` is the public entrypoint for turning Product Spec and Architecture Spec into vertical implementation slices. It recommends a clean split, waits for approval, and then prepares the Issue and plan structure needed for execution.

## Flow

1. Run `code-research` to get the current codebase baseline in compact form.
2. Split the spec into tracer-bullet or smart-zone vertical slices.
3. Attach policy-based unit tests and `ui ~ entity` e2e tests to each slice.
4. Define dependencies between slices.
5. Present the split plan to the user and wait for approval before any mutation.
6. After approval, create Issues and `plans.md` entries that match one-to-one.
7. Publish each Issue using tracker-specific labels or metadata.
8. Apply `ready-for-agent` only when it can be handed to `implement`.
9. Hand off the approved context to `implement`.

## Rules

- Do not mutate GitHub or local plan files before approval.
- Keep one Issue per split plan.
- Include policy-based unit tests and `ui ~ entity` e2e tests in every plan slice.
- Do not split only by layer.
- Apply labels or metadata at publish time, not during the planning-only pass.
- Use the current spec and codebase summary as the source of truth.

## Pulled out on purpose

`to-ticket` keeps the public surface small and pushes the actual splitting rules into the internal skill.
