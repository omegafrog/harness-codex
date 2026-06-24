# Legacy Long-Term Memory Model Retired

The former `.harness/memory/index.yaml` corpus, its active/candidate lifecycle, and score-based promotion policy have been removed.

Harness now uses the ChangeSet-first model documented in [`changeset-memory.md`](changeset-memory.md):

- Human-reviewed source documents live under `docs/memory/`.
- Only `status: verified` documents are retrievable.
- `.harness/memory-index/` is an ignored, regenerated BM25 index rather than a source of truth.
- Retrieval is historical reference only and cannot override active ChangeSets, the current working tree/revision, or ADRs.
- Accepted `harness evolution` guidance can become `review_learning` only after the ChangeSet and Work Item plan are completed and a repository revision is available.

Use the replacement commands:

```bash
python3 -m harness_codex memory list
python3 -m harness_codex memory search "workflow materialization" --stage plan
python3 -m harness_codex memory reindex
```

`memory score` is retired. Durable memory promotion is based on reviewed completion evidence, not a separate numeric candidate score.
