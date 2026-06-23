---
name: harness-plan-executor
description: Legacy runtime orchestration policy for active implementation plans. Runtime code, not the implementation executor, owns sequencing, verification classification, remediation, and plan transitions.
---

# Harness Plan Executor

## Status

This is a compatibility policy document for the runtime orchestration boundary. It is not an implementation skill and must not be supplied to `implementation_executor`.

## Runtime-owned responsibilities

The runtime workflow owns:

- selecting the active ChangeSet and work item;
- sequencing planning, implementation, verification, classification, remediation, and delivery;
- interpreting verifier and security-review results;
- deciding whether an implementation failure retries or a non-implementation failure blocks;
- moving an active plan to completed plans only after the completion contract passes.

## Boundary

Do not use this skill to direct code edits or to invoke another agent. The implementation step uses the focused implementation-executor skill. This document never creates plan transitions, workflow retries, commits, or pull requests.
