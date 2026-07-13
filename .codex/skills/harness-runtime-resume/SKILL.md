---
name: harness-runtime-resume
description: Inspect persisted utility run records. Use when the user asks to inspect a recorded run.
---

# Harness Runtime Resume

## Command Map

- `./harness report <RUN-ID>`

## Procedure

1. If run ID is unknown, list `.harness/runs/` or use dashboard/report commands to identify candidates.
2. Run resume inspection; do not automatically execute downstream stage work unless user requested continuation.
3. Report run ID, next stage, suggested command, and blocker if present.
