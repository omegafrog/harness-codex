---
name: harness-implementation-executor
description: Execute unchecked tasks for one approved work item.
---

# Implementation Executor Sequence

1. Read the selected active plan, its execution boundary, and only the fixed references needed by the task.
2. Validate plan sections, scope, approvals, and first unchecked task. Stop with a blocker if insufficient.
3. Read only declared source scope. Record a concrete reason before any required cross-scope read.
4. Implement unchecked tasks in order. Do not alter plan checkboxes or plan verification text.
5. Run each focused verification command once, serially. Run potentially long commands under the execution scope observation budget; do not run raw then stop later.
6. On slow/failing/nondeterministic verification, collect minimal evidence. Return `verification_root_cause` only when a missing in-scope plan task is required; otherwise return the concrete environment/scope blocker.
7. Report changed files, evidence, remaining tasks, and blockers. Terminate.
