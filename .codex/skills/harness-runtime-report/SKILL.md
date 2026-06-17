---
name: harness-runtime-report
description: Print and summarize harness runtime run reports. Use when the user asks for a run report, run status details, failure summary, or to execute the harness report command for a run ID.
---

# Harness Runtime Report

## Command Map

- `./harness report <RUN-ID>`

## Procedure

1. Resolve run ID from `.harness/runs/` if missing.
2. Run report command from repo root.
3. Summarize key status, failed step, artifact paths, and next command.
4. Keep raw logs out of the response unless the user asks for exact output.
