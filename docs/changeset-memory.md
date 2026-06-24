# ChangeSet-first Long-Term Memory

`docs/memory/` is the human-reviewed source of truth for durable project knowledge. The directory is reserved for schema-valid memory documents; explanatory documentation lives outside it so retrieval never indexes an unreviewed README.

The runtime retrieves only bounded, **historical reference-only** context before `plan-work-item`, `execute-work-item`, and `verify-work-item`. It cannot override the active ChangeSet, current Work Item documents, working tree/current revision, or current ADRs.

## Precedence

1. Active ChangeSet and Work Item documents
2. Current working tree and current git revision
3. Current architecture documents and ADRs
4. Verified memory documents
5. Conversation summaries

A revision mismatch is labelled `historical`. A hit from the active ChangeSet is `blocked` and is omitted from agent-context injection.

## Layout

```text
docs/memory/
  decisions/
  completed-changes/
  failure-patterns/
  review-learnings/
.harness/memory-index/       # generated locally and ignored by git
```

## Schema

Every memory document begins with front matter:

```yaml
memory_id: MEM-YYYYMMDD-NNN
kind: completed_changeset | decision | failure_pattern | review_learning
source_path: docs/changes/completed/CHG-123.md
change_set_id: CHG-123
work_item_id: UC-045
status: verified
repository_revision: <commit-sha>
supersedes: MEM-YYYYMMDD-NNN # optional
tags:
  - workflow-materialization
  - placeholder-validation
applies_to:
  - plan
  - execute
  - verify
created_at: "YYYY-MM-DD"
```

Only `status: verified` documents are retrievable. `source_path` must be repository-relative and may not point to `docs/changes/active/`.

## Reindexing and retrieval

`rebuild_memory_index(repo_root)` regenerates `.harness/memory-index/memory-index.json` from the reviewed documents. The index stores token/digest data for BM25 retrieval; it is disposable and never the source of truth.

`search_memory(...)` supports `kind`, ChangeSet, Work Item, and stage filters. Each hit includes its source, ChangeSet/Work Item IDs, revision, confidence, BM25/match ranking reasons, and `reference_only=true`.

## Writer policy

Use `create_verified_memory_document()` only after a Work Item has completed and its verification evidence has been reviewed. The writer rejects active ChangeSet sources, empty bodies, and duplicate memory IDs, then rebuilds the local index.

Store concise, approved knowledge: completed ChangeSet outcomes, ADR trade-offs, recurring verification failures with prevention rules, and accepted PR-review learning. Do not store raw execution logs, untriaged failures, active ChangeSet text, generated intermediates, or source code intended to replace current repository inspection.
