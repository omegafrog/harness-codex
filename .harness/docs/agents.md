# Active Agents

This catalog contains only agent IDs used by the current public stage registry or
active ChangeSet work-item workflow. It is not a list of every file under
`.codex/agents/`.

## Public stages

| Stage | Agent ID | Responsibility | Source |
| --- | --- | --- | --- |
| Requirements Definition | `requirements_interviewer` | Derive and confirm canonical requirements. | [config](../../.codex/agents/requirements_interviewer.toml) |
| Ubiquitous Language Definition | `ubiquitous_language_reviewer` | Confirm canonical terms and language boundaries. | [config](../../.codex/agents/ubiquitous_language_reviewer.toml) |
| Use Case Definition | `harness_usecases` | Derive runtime-ready use-case and E2E-goal artifacts. | [config](../../.codex/agents/harness_usecases.toml) |
| Event Storming | `oracle` | Derive commands, events, policies, systems, and invariants. | [config](../../.codex/agents/oracle.toml) |
| DDD Architecture Definition | `ddd_architect` | Produce one use-case-scoped candidate DDD design. | [config](../../.codex/agents/ddd_architect.toml) |
| DDD Design Integration | `ddd_design_integrator` | Reconcile all candidate designs into one ChangeSet-level canonical contract. | [config](../../.codex/agents/ddd_design_integrator.toml) |
| Technical Decisions | `technical_decisions` | Record implementation technology decisions inside the approved boundary. | [config](../../.codex/agents/technical_decisions.toml) |
| Design Visualization | `design_visualization` | Render verified class and flow diagrams from approved design evidence. | [config](../../.codex/agents/design_visualization.toml) |
| Plan Writing | `implementation_planner` | Create the executable work-item plan. | [config](../../.codex/agents/implementation_planner.toml) |

## Work-item implementation workflow

| Workflow step | Agent ID | Responsibility | Source |
| --- | --- | --- | --- |
| `secure-work-item-plan` | `security_plan_reviewer` | Add applicable security controls to the active plan. | [config](../../.codex/agents/security_plan_reviewer.toml) |
| `review-work-item-plan` | `artifact_reviewer` | Review plan completeness and its verification contract before execution. | [config](../../.codex/agents/artifact_reviewer.toml) |
| `execute-work-item` | `implementation_executor` | Execute unchecked tasks in the approved plan. | [config](../../.codex/agents/implementation_executor.toml) |
| `verify-work-item-security` | `security_implementation_reviewer` | Independently review implemented work for security findings. | [config](../../.codex/agents/security_implementation_reviewer.toml) |

## Selection rule

The runtime selects an agent through `agent_id` in the stage registry or workflow
definition. Do not add an agent to this catalog merely because a configuration or
reference file exists. Update this document only when the active workflow starts
or stops referencing an agent ID.

See [Active Skills](skills.md) for the corresponding skill contracts.
