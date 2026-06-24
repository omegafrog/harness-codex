# ChangeSet-first Long-Term Memory

`docs/memory/` is the human-reviewed source of truth for durable project knowledge. It is not a dump of execution logs, active ChangeSet text, generated artifacts, or source-code embeddings.

The runtime may retrieve this material before `plan-work-item`, `execute-work-item`, and `verify-work-item`. Retrieval is **historical reference only**. It can never override the active ChangeSet, current Work Item documents, the working tree/current revision, or current ADRs.

## Precedence

1. Active ChangeSet and Work Item documents
2. Current working tree and current git revision
3. Current architecture documents and ADRs
4. Verified memory documents in this directory
5. Conversation summaries

A memory hit whose revision differs from the current checkout is labelled `historical`. A hit from the current ChangeSet is blocked. Both remain non-authoritative even when displayed.

## Directory layout

```text
docs/memory/
  decisions/
  completed-changes/
  failure-patterns/
  review-learnings/
.harness/memory-index/       # generated locally; ignored by git
```

## Document schema

Every retrieved document must start with YAML front matter.

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
created_at: YYYY-MM-DD
```

Only `status: verified` documents are retrievable. `source_path` must be repository-relative and must not point to `docs/changes/active/`.

## Retrieval and reindexing

`rebuild_memory_index(repo_root)` reads every memory document and regenerates `.harness/memory-index/memory-index.json`. The index is disposable and must not be reviewed as a source artifact.

`search_memory(...)` applies optional metadata filters (`kind`, `change_set_id`, `work_item_id`, `stage`) and ranks the remaining documents with BM25. Each result exposes its source, revision, confidence, matched terms, score rationale, and `reference_only=true`.

## Writer rules

Write a memory document only after the Work Item has completed and its verification has passed. The writer rejects active ChangeSet sources and always records `status: verified`. Store concise, reviewable knowledge such as:

- a completed ChangeSet's verified outcome and revision,
- a decision and its trade-off,
- a recurring verification failure with a prevention rule,
- a PR-review learning that has been accepted.

Do not store raw logs, untriaged failures, active ChangeSet text, or code intended to replace current repository inspection.
