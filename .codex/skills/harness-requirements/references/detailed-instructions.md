# harness-requirements Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-requirements/SKILL.md`
- Agent config: `.codex/agents/requirements_interviewer.toml`
- Compatibility agent config: `.codex/agents/harness_requirements.toml`

## Role

Turn an early idea into a requirements specification for one coherent MVP delivery scope. The scope may contain multiple closely related use cases when they are jointly required to deliver one user-visible outcome within a single ChangeSet.

This stage does not own full ubiquitous language confirmation. It may confirm only MVP-blocking terms needed to understand the requirement. Full canonical term review belongs to `$harness-ubiquitous-language`.

## Inputs

- User idea or existing requirements draft.
- Existing docs, settings, and code relevant to the requested product behavior.
- Existing `context.md` as read-only terminology context when present.

## Outputs

- `docs/design/요구사항.md`

Do not write `context.md`. Do not write use cases.

## Required Skill Use

- Use `$grill-me` only as the questioning method.
- Pass a brief that restricts questions to requirements clarification.
- The `$grill-me` result is an intermediate decision record used to write `docs/design/요구사항.md`.

## Discovery Before Questions

- Before asking the user a question, inspect the codebase, existing docs/design documents, existing context.md, .codex configuration, and build/runtime settings when those artifacts could answer it.
- If local artifacts could answer it, inspect them first.
- Do not ask the user for facts you can verify locally.
- If local artifacts partially answer the question, ask only for the missing decision.

## Question Loop

- Write or update the current `docs/design/요구사항.md` draft before asking questions.
- Ask up to three focused Grill-Me questions per turn.
- Ask only blockers needed before the requirements stage can be correct.
- Run at most 3 rounds.
- After each round, summarize what has been clarified and what remains unresolved.
- Do not continue asking until the domain is perfect.
- Stop once the information is sufficient to produce a draft.
- Include `Recommended answer:` with every question.
- The recommendation must reflect current evidence and should say whether it is based on local artifacts or inference.
- When invoked by runtime, return only JSON with keys `status`, `questions`, `changed_files`, and `blocker`.

## Scope Selection

- Define one coherent MVP delivery scope for the current ChangeSet; do not force it into one arbitrary use case.
- A scope may include multiple use cases only when they are jointly necessary to produce one primary user-visible outcome, share material domain or implementation dependencies, and can be verified as one delivery.
- Mark the primary user outcome and distinguish primary use cases from supporting or prerequisite work items.
- Split work into separate ChangeSets when a use case has independent user value, can be delivered and verified independently, or would make the scope lack a clear delivery boundary.
- Do not use a broad program, roadmap, or unrelated feature bundle as an MVP delivery scope.

## Allowed Requirement Questions

Requirements grill-me should clarify:
- primary user outcome
- actor or actors
- included use cases and necessary supporting work
- success condition
- failure policy
- hard scope boundary
- business policy decisions
- MVP-blocking terminology needed to understand the requirement

## Forbidden Requirement Questions

Requirements grill-me must not ask:
- detailed canonical naming
- alias decisions
- forbidden term decisions
- aggregate naming
- domain event naming
- state-transition naming
- DDD design terminology
- implementation strategy

Do not ask technology-specific questions by default unless they directly change the primary user outcome, user-visible result, user-visible failure policy, hard scope boundary, or whether the work still fits one ChangeSet.

Do not ask about authentication, authorization, cache, Redis, messaging, events, outbox, observability, deployment, infrastructure, or implementation strategy unless the MVP delivery scope explicitly depends on that decision.

## Requirements Rules

- Requirements define goals and constraints the system must satisfy.
- Split functional requirements and non-functional requirements.
- Classify unresolved decisions as either Business Policy Decisions Needed, Foundational Technology Decisions Needed, or Language Handoff Notes.
- Business Policy Decisions are product/domain rules: success/failure outcomes, validation rules, compensation, permissions, and user-visible behavior.
- Foundational Technical Decisions are large technology choices that shape the whole program. During harvest, defer them by default unless they directly change the primary user outcome, user-visible result, user-visible failure policy, hard scope boundary, or whether the work still fits one ChangeSet.
- Do not decide detailed implementation strategies during requirements elicitation. Polling vs push, circuit breaker, retry/backoff, outbox/inbox, detailed transaction propagation, cache TTL/invalidation, and observability fields belong after DDD design in the technical-decision stage.
- Business Policy Decisions must be resolved before ubiquitous language confirmation can pass.
- Foundational Technical Decisions may remain unresolved after requirements, but must be clearly separated for DDD and technical-decision gates.
- If a measurable non-functional target is missing, mark it as confirmation needed instead of inventing it.

## Language Boundary

- Record MVP-blocking terms only enough for the later ubiquitous-language-definition stage to confirm canonical language.
- Do not ask full ubiquitous language questions before finalizing the requirements document.
- If a naming decision is not needed to understand the requirement, record it under `Language Handoff Notes`.
- If language uncertainty blocks use-case writing, mark the document as ready for ubiquitous-language-definition and not ready for use-case writing.

## Requirements Document Template

```markdown
# 요구사항

## 1. Scope

- MVP delivery scope:
- Primary user outcome:
- Primary actor(s):
- Included use cases:
- Supporting / prerequisite work items:
- Hard out-of-scope boundary:

## 2. Functional Requirements

### FR-001

- Requirement:
- Success condition:
- Failure policy:

## 3. Non-Functional Requirements

### NFR-001

- Candidate requirement:
- Confirmation status:

## 4. Business Policy Decisions Needed

- None.

## 5. Foundational Technology Decisions Needed

- None.

## 6. Language Handoff Notes

- None.

## 7. Readiness

- Requirements gate:
- Ubiquitous language gate:
- Use-case writing:
```
