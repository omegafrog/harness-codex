# Agent Context Map

## Repository Purpose

This repository contains a Python runtime and CLI for Codex-oriented ChangeSet and use-case workflows. It also includes a bundled runtime dashboard for viewing workflow state.

The runtime can bootstrap compact repo-local agent context in any target repository through `python3 -m harness_codex agent-context init --description "<repo description>"`.

## Main Paths

- `harness_codex/cli.py`: CLI entrypoint for harvest, ChangeSet, work-item, stage, artifact, resume, report, and dashboard commands.
- `harness_codex/runtime/`: workflow engine, models, policy, reports, runner, state, verifier, UI server, and dashboard JSON.
- `.harness/workflows/`: YAML workflow definitions for harvest and ChangeSet/use-case execution.
- `docs/design/`: canonical product and domain design documents.
- `docs/changes/`: active and completed ChangeSet documents.
- `docs/use-cases/`: executor-facing use-case slices.
- `docs/maintenance/`: executor-facing maintenance slices.
- `docs/plans/`: active and completed implementation plans.
- `.harness/docs/templates/`: templates for ChangeSet, use-case, and maintenance documents.
- `harness_codex/runtime/dashboard_assets/`: bundled dashboard JavaScript and CSS served by the runtime UI server.
- `harness_codex/runtime/ui_server.py`: local dashboard HTTP server and asset routing.
- `harness_codex/runtime/document_dashboard.py`: dashboard document projection and view data assembly.
- `tests/`: Python tests for CLI, runtime, workflow parsing, document structure, and planning/execution behavior.
- `.harness/docs/agent/`: hot/cold-path agent context bootstrap output used by this repo and generated for new target repos.

## Documentation Model

`docs/design/**` is the canonical design source. Use-case slices under `docs/use-cases/<UC-ID>/` narrow canonical design into executor-facing scope. Maintenance slices under `docs/maintenance/<MAINT-ID>/` narrow refactor, bugfix, test, infra, docs, or chore work into executable scope.

When a slice exists, planner and executor work should read that slice first. Read `docs/design/**` only when shared design context is required or when a slice points there.

## Plan And State Flow

Active ChangeSets live in `docs/changes/active/`. Completed ChangeSets move to `docs/changes/completed/`.

Active implementation plans live in `docs/plans/active/<WORK-ITEM-ID>/plan.md`. Completed plans move to `docs/plans/completed/<WORK-ITEM-ID>/plan.md` only after checklist completion, verification criteria pass, required test gates pass, and evidence is recorded.

Runtime state is written under `.harness/runs/<run-id>/`.

## Agent Execution Model

Harness is an agent-backed sequential pipeline, not an agent team architecture. Specialist agents do not communicate directly. They hand off through declared artifacts and workflow dependencies.

Producer-reviewer behavior must be modeled as an explicit workflow step. See `.harness/docs/runtime/agent-pipeline.md`.

## Context Loading Guidance

Start with the nearest `AGENTS.md`, then read only the smallest relevant file from `.harness/docs/agent/`. Prefer `rg`, targeted reads, and symbol tools. Avoid full `docs/design/**` or broad file dumps unless needed for the current decision.
