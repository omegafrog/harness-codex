# Legacy Command Migration

The canonical runtime commands are `harvest`, `changes create-from-design`,
`run-change`, `run-work-item`, and `run-use-case`. The older procedure-stage
commands and `ultrawork` describe a parallel workflow and are no longer an
official execution interface.

## Migration Map

| Legacy entry point | Replacement | Notes |
| --- | --- | --- |
| `requirements-definition` | `harvest --idea "..." --apply` | Harvest owns requirements and use-case design generation. |
| `ubiquitous-language-definition` | `harvest --apply --resume` | Continue the same harvest session when clarification is required. |
| `use-case-definition` | `harvest --apply --resume` | Harvest produces runtime-ready use-case slices. |
| `event-storming` | `run-work-item <CHG-ID> <ITEM-ID> --apply` | Work-item workflow owns planning through verification. |
| `ddd-architecture-definition` | `run-work-item <CHG-ID> <ITEM-ID> --apply` | Do not keep an independent stage table. |
| `technical-decisions` | `run-work-item <CHG-ID> <ITEM-ID> --apply` | Decisions are work-item inputs and plan evidence. |
| `plan-writing` | `run-work-item <CHG-ID> <ITEM-ID> --apply` | The materialized workflow invokes the planner. |
| `implementation` | `run-change <CHG-ID> --apply` | Use `run-work-item` for an intentional narrow run. |
| `ultrawork` | `harvest` → `changes create-from-design` → `run-change` | This explicit sequence preserves inspectable boundaries. |
| `harness-full-workflow` skill | Thin wrapper around the same canonical commands | It may guide command choice but may not own workflow state. |

## Compatibility Contract

- Do not add new callers of legacy entries.
- Do not generate procedure tables or wrapper-owned completion state.
- Keep migration documentation through **2026-09-30**.
- Remove remaining compatibility documentation after that date only when usage
  has been checked in release notes and installed-template documentation.

## Recovering an Existing Legacy Run

1. Identify the active ChangeSet and its affected work items.
2. Validate it with `./harness changes active`.
3. Run `./harness run-change <CHG-ID> --preview`.
4. Continue with `--apply`, or choose one ready work item with
   `run-work-item`.
5. Use `resume` and the persisted report as the source of truth; do not copy
   status from a legacy procedure table into `RunState`.
