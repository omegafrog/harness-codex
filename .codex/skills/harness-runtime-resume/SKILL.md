---
name: harness-runtime-resume
description: Inspect the next resume target for a harness runtime run. Use when the user asks how to resume a run, what run should continue next, or to execute the harness resume command for a run ID.
---

# Harness Runtime Resume

## Command Map

- `./harness resume <RUN-ID>`

## Procedure

1. If run ID is unknown, list `.harness/runs/` or use dashboard/report commands to identify candidates.
2. Run resume inspection; do not automatically execute downstream stage work unless user requested continuation.
3. Report run ID, next stage, suggested command, and blocker if present.
