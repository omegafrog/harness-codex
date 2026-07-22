# Active Skills

This catalog lists the skills mapped by the current workflow and shared skills
explicitly invoked by those stages or the runtime. It does not list every
directory under `.codex/skills/`.

## Orchestration과 intake

| 단계 | Skill | Source |
| --- | --- | --- |
| Intent routing | `harness-orchestrate-instruction` | [source](../../.codex/skills/harness-orchestrate-instruction/SKILL.md) |
| Maintenance definition | `harness-maintenance-bootstrap` | [source](../../.codex/skills/harness-maintenance-bootstrap/SKILL.md) |

## Shared interview skills

| 역할 | Skill | Source |
| --- | --- | --- |
| Shared-understanding interview entrypoint | `grill-me` | [source](../../.codex/skills/grill-me/SKILL.md) |
| One-question-at-a-time grilling protocol | `grilling` | [source](../../.codex/skills/grilling/SKILL.md) |

## Public stages

| Stage | Skill | Source |
| --- | --- | --- |
| Requirements Definition | `harness-requirements` | [source](../../.codex/skills/harness-requirements/SKILL.md) |
| Ubiquitous Language Definition | `harness-ubiquitous-language` | [source](../../.codex/skills/harness-ubiquitous-language/SKILL.md) |
| Use Case Definition | `harness-usecases` | [source](../../.codex/skills/harness-usecases/SKILL.md) |
| Event Storming | `harness-event-storming` | [source](../../.codex/skills/harness-event-storming/SKILL.md) |
| DDD Architecture Definition | `harness-ddd-design` | [source](../../.codex/skills/harness-ddd-design/SKILL.md) |
| DDD Design Integration | `harness-ddd-integration` | [source](../../.codex/skills/harness-ddd-integration/SKILL.md) |
| Technical Decisions | `harness-technical-decisions` | [source](../../.codex/skills/harness-technical-decisions/SKILL.md) |
| Design Visualization | `harness-design-visualization` | [source](../../.codex/skills/harness-design-visualization/SKILL.md) |
| Plan Writing | `harness-code-planner` | [source](../../.codex/skills/harness-code-planner/SKILL.md) |

## Work-item implementation workflow

| Workflow step | Skill | Source |
| --- | --- | --- |
| `secure-work-item-plan` | `harness-security-plan-reviewer` | [source](../../.codex/skills/harness-security-plan-reviewer/SKILL.md) |
| `review-work-item-plan` | `harness-artifact-reviewer` | [source](../../.codex/skills/harness-artifact-reviewer/SKILL.md) |
| `execute-work-item` | `harness-implementation-executor` | [source](../../.codex/skills/harness-implementation-executor/SKILL.md) |
| `verify-work-item-security` | `harness-security-implementation-reviewer` | [source](../../.codex/skills/harness-security-implementation-reviewer/SKILL.md) |
| `review-work-item` | `harness-review` | [source](../../.codex/skills/harness-review/SKILL.md) |
| `resolve-deferred-findings` | `harness-deferred-findings` | [source](../../.codex/skills/harness-deferred-findings/SKILL.md) |

The public-stage IDs come from the stage registry. The implementation IDs come
from the active work-item workflow. Update this catalog only when those mappings
or their shared dependencies change.

See [Active Agents](agents.md) for the corresponding roles.
