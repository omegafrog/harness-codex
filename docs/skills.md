# Active Skills

This catalog contains only skill IDs used by the current public stage registry or
active ChangeSet work-item workflow. It intentionally excludes compatibility,
experimental, and unreferenced skills.

## Public-stage skills

| Stage | Skill ID | Purpose | Source |
| --- | --- | --- | --- |
| Requirements Definition | `harness-requirements` | Turn a product idea into canonical requirements. | [skill](../.codex/skills/harness-requirements/SKILL.md) |
| Ubiquitous Language Definition | `harness-ubiquitous-language` | Confirm canonical language from approved requirements. | [skill](../.codex/skills/harness-ubiquitous-language/SKILL.md) |
| Use Case Definition | `harness-usecases` | Produce runtime-ready use-case and E2E-goal artifacts. | [skill](../.codex/skills/harness-usecases/SKILL.md) |
| Event Storming | `harness-event-storming` | Derive commands, events, policies, systems, and invariants from a use-case slice. | [skill](../.codex/skills/harness-event-storming/SKILL.md) |
| DDD Architecture Definition | `harness-ddd-design` | Define bounded contexts, aggregates, and architecture impact. | [skill](../.codex/skills/harness-ddd-design/SKILL.md) |
| Technical Decisions | `harness-technical-decisions` | Make technology decisions only within the approved design boundary. | [skill](../.codex/skills/harness-technical-decisions/SKILL.md) |
| Plan Writing | `harness-code-planner` | Convert the approved slice into an executable work-item plan. | [skill](../.codex/skills/harness-code-planner/SKILL.md) |

## Work-item implementation skills

| Workflow step | Skill ID | Purpose | Source |
| --- | --- | --- | --- |
| `secure-work-item-plan` | `harness-security-plan-reviewer` | Add applicable OWASP-oriented controls to the active plan. | [skill](../.codex/skills/harness-security-plan-reviewer/SKILL.md) |
| `review-work-item-plan` | `harness-artifact-reviewer` | Review plan completeness, scope, and verification contract. | [skill](../.codex/skills/harness-artifact-reviewer/SKILL.md) |
| `execute-work-item` | `harness-implementation-executor` | Execute only unchecked tasks in the approved plan. | [skill](../.codex/skills/harness-implementation-executor/SKILL.md) |
| `verify-work-item-security` | `harness-security-implementation-reviewer` | Independently assess the implemented work for security findings. | [skill](../.codex/skills/harness-security-implementation-reviewer/SKILL.md) |

## Selection rule

The runtime selects a skill through `skill_id` in the stage registry or workflow
definition. Do not add a skill to this catalog merely because it exists on disk.
Update this document only when the active workflow starts or stops referencing a
skill ID.

See [Active Agents](agents.md) for the corresponding agent roles.
