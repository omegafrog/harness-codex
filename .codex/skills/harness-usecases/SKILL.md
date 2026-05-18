---
name: harness-usecases
description:
  Use after requirements exist to turn confirmed requirements into external-actor
  use cases only. This skill writes docs/design/유스케이스.md.
---

# Harness Use Cases

## Purpose

This skill turns confirmed requirements into a use case document only.

Responsibilities are split as follows.

- `harness-requirements`: writes `docs/design/요구사항.md`.
- `harness-usecases`: validates requirements readiness and writes `docs/design/유스케이스.md`.

If requirements do not exist, or if core business policy decisions remain
unresolved, stop and ask the user to run `$harness-requirements` first. Do not
invent missing requirements.

When this skill is invoked, delegate the work to the dedicated agent defined in
`.codex/agents/harness_usecases.toml`. If the dedicated agent cannot be found
or cannot run, do not perform a fallback implementation. Explain the reason and
stop.

## Embedded Standards

Use the following standards as the source of truth for the instructions.

### Use Case Standards

- Write use cases around the goals of external actors.
- Do not define internal server/API interactions as use cases.
- Use case names in this format: `UC-01. Actor performs goal`.
- Each use case must contain exactly one user goal.
- Split combined goals into separate use cases.
- When a detailed flow implies commands, events, or policies, each sentence must have a single meaning.
- Do not mix policies and commands.
- Commands must be imperative.
- Events must be past tense.
- Policies must be written as conditions or decision criteria.
- A use case that does not satisfy these rules is not complete.
- If a requirement is ambiguous, mark the related use case detail as `Needs confirmation` instead of inventing behavior.

## Invocation

When the user invokes `$harness-usecases` with existing requirements or a
requirements decision record, treat it as a request to write use cases only.

Dedicated agent:

- agent id: `harness_usecases`
- config: `.codex/agents/harness_usecases.toml`
- output file:
  - `docs/design/유스케이스.md`

Execution rules:

- If the dedicated agent cannot be found or cannot run, the current agent must not perform the work as a fallback.
- Explain the reason for the failure and stop.
- The dedicated agent must not modify code, settings, skill files, agent files, or requirements documents.
- The dedicated agent may only write to `docs/design/유스케이스.md`.

```text
You are the harness use case documentation agent.

Write or update only docs/design/유스케이스.md based on docs/design/요구사항.md and any confirmed decision record.

Owned file:
- docs/design/유스케이스.md

Rules:
- Do not modify code, settings, skill files, agent files, or requirements documents.
- Do not revert existing user changes.
- Read docs/design/요구사항.md first.
- If docs/design/요구사항.md is missing, stop and ask the user to run $harness-requirements first.
- If unresolved Business Policy Decisions remain, stop because use cases would encode unconfirmed behavior.
- Write use cases around a single goal of an external actor.
- Do not turn internal server/API flows into use cases.
- Separate commands, events, and policies by meaning and sentence form.
- Write deliverables only to the owned file.
- If the dedicated agent cannot be found or cannot run, explain the reason and stop.
```

## Workflow

1. **Inspect requirements**
   Read `docs/design/요구사항.md` and any explicit user-provided decision record.

2. **Check readiness**
   Stop if requirements are missing or unresolved business policy decisions remain.
   Foundational technology decisions may remain unresolved if they do not affect actor goals.

3. **Derive actor goals**
   Extract external actors and one goal per actor from confirmed functional requirements.

4. **Write use cases**
   Write or update `docs/design/유스케이스.md`, using one external actor goal per use case.

5. **Confirm completion**
   If any use case still has multiple goals, mixed command/policy wording, or multi-meaning event-storming candidates, mark it as `Needs confirmation`.
   If ambiguity blocks correctness, ask one focused question at a time and include `Recommended answer:`.

## Use Case Document Template

`docs/design/유스케이스.md` must follow this structure.

```markdown
# Use Case Document

## 1. Actor Definitions
### Main Actors
- ...

### Supporting Actors
- ...

## 2. High-Level Use Case List
### <Actor Group>
- UC-01. ...

## 3. Use Case Details
## UC-01. <Actor performs goal>
**Actor**
- ...

**Supporting Actor**
- ...

**Goal**
- ...

**Preconditions**
- ...

**Main Flow**
1. ...

**Exception Flow**
- ...

**Result**
- ...

**Non-Functional Requirements**
- ...

---

## 4. System-Wide Non-Functional Requirements
### 4.1 Performance
- ...

### 4.2 Scalability
- ...

### 4.3 Availability
- ...

### 4.4 Data Consistency
- ...

### 4.5 Concurrency Control
- ...

### 4.6 Security
- ...

### 4.7 Failure Handling and Recovery
- ...

### 4.8 Auditability and Operability
- ...

## 5. Needs Confirmation
- ...
```

Even when a use case has no supporting actors, exception flow, or non-functional
requirements, keep the sections and write `- None` or `- Needs confirmation`.
