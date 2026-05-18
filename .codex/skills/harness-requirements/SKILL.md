---
name: harness-requirements
description:
  Use when a user wants to turn an early product or feature idea into a
  requirements specification and project ubiquitous language. This skill
  clarifies unresolved decisions through grill-me and writes
  docs/design/요구사항.md and context.md.
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

This skill turns an early idea into a requirements specification and a project
ubiquitous language source of truth.

Responsibilities are split as follows.

- `$grill-me`: clarifies unresolved requirement and language decisions through questions.
- `harness-requirements`: validates confirmed decisions and writes `docs/design/요구사항.md` and `context.md`.
- `harness-usecases`: later reads confirmed requirements and `context.md`, then writes `docs/design/유스케이스.md`.

`$grill-me` only provides the questioning method. The requirements and ubiquitous
language standards belong to this skill's `Embedded Standards`. Therefore, when
running `$grill-me`, pass a `Grill-Me Brief` that summarizes this skill's
standards.

The `$grill-me` result is not the final deliverable. It is an intermediate
decision record used to write `docs/design/요구사항.md` and `context.md`.

If business policies are incomplete, do not report that the work is ready for
use-case writing or Event Storming. If foundational technology choices are
incomplete, leave them under `Foundational Technology Decisions Needed`.

If ubiquitous language is incomplete, do not report that the work is ready for
use-case writing, Event Storming, planning, or implementation. Leave unresolved
terms under `Open Language Questions` in `context.md`.

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

### Ubiquitous Language Standards

- Requirements harvest must confirm ubiquitous language through `$grill-me` before use-case harvest begins.
- Store the confirmed language in root-level `context.md` under `## 1. Ubiquitous Language` or `## Ubiquitous Language`.
- `context.md` is the project-wide source of truth for domain language.
- Confirm actor names, user goal names, domain concepts, state names, command candidate terms, event candidate terms, policy/rule terms, and external system names.
- For every important term, confirm the canonical term, Korean label, English code-facing label, type, definition, aliases, forbidden terms, and source.
- The same concept must not have multiple canonical terms.
- Aliases may be recorded only as aliases; generated requirements, use cases, plans, tests, and code identifiers must use canonical terms.
- Forbidden terms must not appear in newly generated docs or code identifiers.
- Do not mix implementation technology terms with domain terms unless the business explicitly uses the same term.
- If a required term is missing or contested, do not invent it. Record it under `Open Language Questions` in `context.md`.

## Grill-Me Brief Contract

`$grill-me` only provides the questioning method. When running it, pass a brief
that summarizes this skill's standards.

### Brief Contents

```text
You are conducting an interview to clarify requirements and confirm ubiquitous language.

Questioning method:
- Ask up to three focused questions at a time when at least three unresolved decisions remain.
- Ask fewer than three only when fewer unresolved decisions remain.
- Include `Recommended answer:` with each question.
- If the answer can be found in the codebase, existing documents, or settings, inspect them first.
- Follow decision dependencies and resolve the most important unresolved item first.

Judgment standards:
- Follow the Embedded Standards from harness-requirements.
- Business policies must be confirmed before use-case writing and DDD/Event Storming.
- Ubiquitous language must be confirmed before use-case writing and DDD/Event Storming.
- Foundational technologies are confirmed in the later part of the requirements phase.
- Detailed technical strategies must not be confirmed as requirements; separate them as post-DDD candidates.
- Do not write use cases in this phase.

Question priority:
1. Problem situation
2. Goal
3. Scope
4. Actors
5. Goals per actor
6. Core domain terms and concept names
7. State names
8. Command/event/policy candidate terms
9. Alias and forbidden-term cleanup
10. Core features
11. Success/failure outcomes
12. Business policies
13. Authorization/security/audit trail
14. External systems
15. Non-functional requirements
16. Foundational technologies
17. Out-of-scope items

Ubiquitous language confirmation criteria:
- Same concept has exactly one canonical term.
- Korean and English/code-facing names are confirmed.
- Term type is clear: Actor, Goal, Domain Concept, State, Command Candidate, Event Candidate, Policy, External System, or Other.
- Aliases and forbidden terms are recorded.
- Missing terms are recorded in `Open Language Questions` instead of invented.

Completion criteria:
- Main actors and their goals are separated enough for functional requirements.
- Functional and non-functional requirement candidates can be written.
- There are no unresolved core business policies.
- Foundational technologies are confirmed or separated as needing confirmation.
- Core ubiquitous language is confirmed and can be written to `context.md`.

Output format:
## Confirmed Decisions
- ...

## Confirmed Ubiquitous Language
| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | grill-me |

## Needs Confirmation
### Business Policy Decisions Needed
- ...
### Foundational Technology Decisions Needed
- ...
### Open Language Questions
- ...
### Post-DDD Technical Decision Candidates
- ...

## Documentation Input
### Content for requirements.md
- ...
### Content for context.md
- ...
```

## Invocation

When the user invokes `$harness-requirements` with an early idea or a `$grill-me`
result, treat it as a request to write requirements and project language only.

Dedicated agent:

- agent id: `harness_requirements`
- config: `.codex/agents/harness_requirements.toml`
- output files:
  - `docs/design/요구사항.md`
  - `context.md`

Execution rules:

- If the dedicated agent cannot be found or cannot run, the current agent must not perform the work as a fallback.
- Explain the reason for the failure and stop.
- The dedicated agent must not modify code, settings, skill files, agent files, or use-case documents.
- The dedicated agent may only write to `docs/design/요구사항.md` and `context.md`.

```text
You are the harness requirements documentation agent.

Write or update only docs/design/요구사항.md and context.md based on the user's early idea and the `$grill-me` result.

Owned files:
- docs/design/요구사항.md
- context.md

Rules:
- Do not modify code, settings, skill files, agent files, or use-case documents.
- Do not revert existing user changes.
- `$grill-me` only provides the questioning method.
- Use this skill's Embedded Standards as the judgment criteria.
- If `$grill-me` is needed, create and pass a brief that follows the Grill-Me Brief Contract.
- Do not confirm core requirements without a `$grill-me` result or existing evidence.
- Do not confirm core ubiquitous language without a `$grill-me` result or existing evidence.
- Distinguish confirmed, candidate, and needs-confirmation non-functional requirements.
- Confirm foundational technologies in the later part of the requirements phase.
- Confirm canonical domain terms, English code-facing names, aliases, and forbidden terms.
- Write confirmed ubiquitous language to context.md.
- Record unresolved language decisions under Open Language Questions in context.md.
- Use context.md canonical terms when writing docs/design/요구사항.md.
- Do not confirm detailed technical strategies as requirements.
- Do not write use cases.
- Write deliverables only to the owned files.
- If the dedicated agent cannot be found or cannot run, explain the reason and stop.
```

## Workflow

1. **Confirm standards**
   Use `Embedded Standards`, `Grill-Me Brief Contract`, and the document templates as the working standards.

2. **Inspect inputs**
   Review the early idea, `$grill-me` result, existing requirements, existing `context.md`, relevant code, docs, and settings.

3. **Decide whether to run Grill-Me**
   If requirement or language decisions are missing, create a brief that follows the `Grill-Me Brief Contract` and run `$grill-me`.

4. **Validate decisions**
   Split the `$grill-me` result into confirmed decisions, needs-confirmation items, confirmed language, open language questions, and post-DDD candidates.
   Do not confirm items that fail the standards.

5. **Write requirements and language**
   Write or update `context.md` first, then write or update `docs/design/요구사항.md` using the canonical terms from `context.md`.

6. **Confirm completion**
   If business policies are unresolved, do not report readiness for use-case writing or Event Storming.
   If ubiquitous language has unresolved core terms, do not report readiness for use-case writing or Event Storming.
   Collect remaining unresolved items in needs-confirmation sections.

## Context Document Template

`context.md` must follow this structure.

```markdown
# Project Context

## 1. Ubiquitous Language

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | grill-me |

## 2. Naming Rules

- Documents must use `Canonical Term`.
- Code class, method, package, command, event, and policy identifiers must use `English`.
- User-facing text should use `Korean`.
- `Forbidden Terms` must not be used in new documents, plans, tests, or code identifiers.
- Aliases are recorded only for migration/search context and must not be introduced as new canonical language.

## 3. Open Language Questions

- ...
```

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
