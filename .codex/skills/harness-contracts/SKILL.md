---
name: harness-contracts
description: Validate harness document handoff contracts through the runtime CLI. Use when the user asks to check ChangeSet or work-item document contracts, dashboard contract data, artifact handoff validity, or `harness contracts validate`.
---

# Harness Contracts

## Command Map

- `./harness contracts validate <CHG-ID> [--work-item ID] [--json]`

## Procedure

1. Identify ChangeSet and optional work item from user input or `./harness changes list`.
2. Run validation from repo root.
3. If output is long, rerun with `--json` only when machine-readable detail helps.
4. Report failing contract, expected artifact, missing/invalid field, and next owner stage.
5. Do not edit artifacts unless user also asks for remediation.
