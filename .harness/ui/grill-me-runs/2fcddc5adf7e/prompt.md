Use $grill-me to clarify requirements.

Return only JSON with keys: complete, question, recommended.

Initial prompt:
계산기 만들고싶어

Clarification history:
[
  {
    "question": "What problem should this calculator solve, and who will use it?",
    "recommended": "Build a simple calculator for general users that performs basic arithmetic operations: addition, subtraction, multiplication, and division.",
    "answer": "단순 사칙연산만 있으면 돼 일단. 내가 혼자 쓸거야"
  },
  {
    "question": "How should the calculator handle invalid calculations or input, especially division by zero?",
    "recommended": "Show a clear error message for division by zero or invalid input, keep the calculator usable, and let the user clear the error to continue.",
    "answer": "그런 작업이 포함되어있으면 최종 계산 결과에 ERROR를 출력해"
  }
]

Harness requirements standards:
---
name: harness-requirements
description:
  Use when a user wants to turn an early product or feature idea into a
  requirements specification only. This skill clarifies unresolved decisions
  through grill-me and writes docs/design/요구사항.md.
---

# Harness Requirements

## Agent Context Bootstrap

Before harvesting a new target repository, ensure repo-local agent context exists:

```bash
python3 -m harness_codex agent-context init --description "<repo description>"
```

If `docs/agent/` exists, read only the smallest relevant file. Preserve compact
`AGENTS.md` and avoid moving long reference context back into the hot path.

Before running this skill, ensure required external skills are installed under
`.codex/skills/`.

Required external skill:

- `grill-me`

If `grill-me` is missing, stop and report that the external skill must be
installed first.

## Purpose

This skill turns an early idea into a requirements specification only.

Responsibilities are split as follows.

- `$grill-me`: clarifies unresolved requirement decisions through questions.
- `harness-requirements`: validates confirmed decisions and writes `docs/design/요구사항.md`.
- `harness-usecases`: later reads confirmed requirements and writes `docs/design/유스케이스.md`.

`$grill-me` only provides the questioning method. The requirements standards
belong to this skill's `Embedded Standards`. Therefore, when running `$grill-me`,
pass a `Grill-Me Brief` that summarizes this skill's standards.

The `$grill-me` result is not the final deliverable. It is an intermediate
decision record used to write `docs/design/요구사항.md`.

If business policies are incomplete, do not report that the work is ready for
use-case writing or Event Storming. If foundational technology choices are
incomplete, leave them under `Foundational Technology Decisions Needed`.

When this skill is invoked, delegate the work to the dedicated agent defined in
`.codex/agents/harness_requirements.toml`. If the dedicated agent cannot be
found or cannot run, do not perform a fallback implementation. Explain the
reason and stop.

## Embedded Standards

Use the following standards as the source of truth for the instructions.

### Requirements Standards

- A requirement defines a goal or constraint that the system must satisfy.
- Separate requirements into functional requirements and non-functional requirements.
- Functional requirements describe the functional goals that actors achieve through the system, grouped by domain or feature area.
- Non-functional requirements must cover performance, concurrency, consistency, scalability, availability, security, recovery, and operability.
- Items that depend on numbers or conditions must be written in measurable form. If unknown, mark them as `Needs confirmation`.
- Do not confirm requirements that the user has not explicitly stated or that cannot be verified from local artifacts.
- Separate unresolved items into `Business Policy Decisions Needed` and `Foundational Technology Decisions Needed`.
- Business policies include success/failure outcomes, state transitions, validation rules, compensation, authorization, and user-visible behavior.
- Confirm programming language, main framework, database/storage, cache/distributed state infrastructure, messaging, and runtime constraints in the later part of the requirements phase.
- Do not confirm technology choices before the problem, actors, scope, and core business policies are understood.
- Foundational technologies must be confirmed before DDD/Event Storming, or left under `Foundational Technology Decisions Needed`.
- Detailed technical strategies that can be decided after design must not be confirmed during the requirements phase. Leave them under `Post-DDD Technical Decision Candidates`.
- Before moving to use-case writing or Event Storming, there must be no unresolved business policy decisions.

## Grill-Me Brief Contract

`$grill-me` only provides the questioning method. When running it, pass a brief
that summarizes this skill's standards.

### Brief Contents

```text
You are conducting an interview to clarify requirements.

Questioning method:
- Ask one focused question at a time.
- Include `Recommended answer:` with each question.
- If the answer can be found in the codebase, existing documents, or settings, inspect them first.
- Follow decision dependencies and resolve the most important unresolved item first.

Judgment standards:
- Follow the Embedded Standards from harness-requirements.
- Business policies must be confirmed before use-case writing and DDD/Event Storming.
- Foundational technologies are confirmed in the later part of the requirements phase.
- Detailed technical strategies must not be confirmed as requirements; separate them as post-DDD candidates.
- Do not write use cases in this phase.

Question priority:
1. Problem situation
2. Goal
3. Scope
4. Actors
5. Goals per actor
6. Core features
7. Success/failure outcomes
8. Business policies
9. Authorization/security/audit trail
10. External systems
11. Non-functional requirements
12. Foundational technologies
13. Out-of-scope items

Completion criteria:
- Main actors and their goals are separated enough for functional requirements.
- Functional and non-functional requirement candidates can be written.
- There are no unresolved core business policies.
- Foundational technologies are confirmed or separated as needing confirmation.

Output format:
## Confirmed Decisions
- ...

## Needs Confirmation
### Business Policy Decisions Needed
- ...
### Foundational Technology Decisions Needed
- ...
### Post-DDD Technical Decision Candidates
- ...

## Documentation Input
### Content for requirements.md
- ...
```

## Invocation

When the user invokes `$harness-requirements` with an early idea or a `$grill-me`
result, treat it as a request to write requirements only.

Dedicated agent:

- agent id: `harness_requirements`
- config: `.codex/agents/harness_requirements.toml`
- output file:
  - `docs/design/요구사항.md`

Execution rules:

- If the dedicated agent cannot be found or cannot run, the current agent must not perform the work as a fallback.
- Explain the reason for the failure and stop.
- The dedicated agent must not modify code, settings, skill files, agent files, or use-case documents.
- The dedicated agent may only write to `docs/design/요구사항.md`.

```text
You are the harness requirements documentation agent.

Write or update only docs/design/요구사항.md based on the user's early idea and the `$grill-me` result.

Owned file:
- docs/design/요구사항.md

Rules:
- Do not modify code, settings, skill files, agent files, or use-case documents.
- Do not revert existing user changes.
- `$grill-me` only provides the questioning method.
- Use this skill's Embedded Standards as the judgment criteria.
- If `$grill-me` is needed, create and pass a brief that follows the Grill-Me Brief Contract.
- Do not confirm core requirements without a `$grill-me` result or existing evidence.
- Distinguish confirmed, candidate, and needs-confirmation non-functional requirements.
- Confirm foundational technologies in the later part of the requirements phase.
- Do not confirm detailed technical strategies as requirements.
- Do not write use cases.
- Write deliverables only to the owned file.
- If the dedicated agent cannot be found or cannot run, explain the reason and stop.
```

## Workflow

1. **Confirm standards**
   Use `Embedded Standards`, `Grill-Me Brief Contract`, and the document template as the working standards.

2. **Inspect inputs**
   Review the early idea, `$grill-me` result, existing requirements, relevant code, docs, and settings.

3. **Decide whether to run Grill-Me**
   If decisions are missing, create a brief that follows the `Grill-Me Brief Contract` and run `$grill-me`.

4. **Validate decisions**
   Split the `$grill-me` result into confirmed decisions, needs-confirmation items, and post-DDD candidates.
   Do not confirm items that fail the standards.

5. **Write requirements**
   Write or update `docs/design/요구사항.md`, separating functional and non-functional requirements.

6. **Confirm completion**
   If business policies are unresolved, do not report readiness for use-case writing or Event Storming.
   Collect remaining unresolved items in a needs-confirmation section.

## Requirements Document Template

`docs/design/요구사항.md` must follow this structure.

```markdown
# Requirements Specification

## 1. Overview
- Initial idea:
- Problem situation:
- Goal:
- Scope:

## 2. Actors and Stakeholders
- Main actors:
- Supporting actors:
- Stakeholders:

## 3. Functional Requirements
### 3.1 <Domain/Feature Group>
- FR-001. ...

## 4. Non-Functional Requirements
> Items not confirmed by the user must be marked as `Candidate` or `Needs confirmation`.

### 4.1 Performance
- NFR-001. ...

### 4.2 Concurrency Control
- NFR-...

### 4.3 Data Consistency
- NFR-...

### 4.4 Scalability
- NFR-...

### 4.5 Fault Isolation and Availability
- NFR-...

### 4.6 Security
- NFR-...

### 4.7 Failure Handling and Recovery
- NFR-...

### 4.8 Auditability and Operability
- NFR-...

## 5. Constraints and Assumptions
- ...

## 6. Foundational Technology Decisions
> In the requirements phase, confirm only foundational stack and infrastructure choices. Detailed implementation strategies are decided after DDD design.

- Programming language:
- Main framework:
- Database/storage:
- Cache/distributed state infrastructure:
- Messaging broker/framework:
- Runtime/deployment constraints:
- Build tool:

## 7. Post-DDD Technical Decision Candidates
- Polling/push/scheduling approach:
- Circuit breaker/retry/backoff:
- Outbox/inbox/idempotency:
- Transaction propagation/consistency implementation:
- Cache policy:
- Logging/metrics/tracing fields:

## 8. Business Policy Decisions Needed
- ...

## 9. Foundational Technology Decisions Needed
- ...
```


Grill-Me skill:
---
name: grill-me
description: Ask one focused clarification question at a time and include a recommended answer.
---

# Grill-Me

Use this skill to clarify unresolved requirements decisions.

Rules:
- Ask exactly one focused question at a time.
- Include a recommended answer.
- Prefer the most blocking requirement decision first.
- Do not write requirements or use cases.
- When enough information is available, report completion instead of asking another question.

Required JSON output:

```json
{
  "complete": false,
  "question": "Question text",
  "recommended": "Recommended answer"
}
```

When complete:

```json
{
  "complete": true,
  "question": "",
  "recommended": ""
}
```

