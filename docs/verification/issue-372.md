# Issue 372 verification evidence

## Rebase basis

- Rebasing target: `main` at the commit checked out by this workflow.
- Preserved the typed work-item document contract introduced on `main`.
- Added `security-verification` to the materializer executor-input contract.

## Verification method

- Executed a `RunnerEngine` graph where precompleted work-item nodes are skipped but finalization nodes continue.
- Parsed and materialized the canonical workflow with a concrete run ID.
- Verified security verification receives type-specific executor inputs.
- Verified strict wiki build → PR → ChangeSet completion ordering.
- Ran existing resolver, materializer, and typed-document contract regression tests from `main`.

## Command

```text
python -m pytest -q tests/test_issue_372_canonical_finalization.py tests/runtime/test_affected_use_case_resolver.py tests/runtime/test_workflow_materializer.py tests/runtime/test_typed_work_item_documents.py tests/runtime/test_typed_work_item_document_cli.py
```

## Result

```text
..............................                                           [100%]
30 passed in 0.38s
```
