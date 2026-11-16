---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# subdomain-candidates

## Purpose

Second step of the requirements flow, after `stakeholder-analysis` and before `ubiquitous-language`. Group the business of the request into subdomain candidates (`SD-xx`) and cut it into business activities (`BIZ-xx`), then write both into `requirements.md`. A candidate is a hypothesis about how the work splits; `subdomain-classification` later checks it against the event flows and has the user confirm it. Nothing here is written to project-wide documents and nothing is decided about bounded contexts, modules or technology. No persona runs and the user is not asked, except for the case under Questions.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/requirements.md` with its `### 요구사항 초안`, and `stakeholder-analysis.md` with its candidate table and decisions. Both are resolved with `harness-spec-path.mjs`.
- Existing areas, read-only and only when present: `CONTEXT-MAP.md`, `docs/architecture/domain-model.md` and `CONTEXT.md`.
- The [requirements.md template](../requirements-fix/references/template.md), which owns the shape of the SD table and the `BIZ` sections.

## Prohibited

- Inspecting source or test code, naming bounded contexts, modules, packages, persistence or frameworks.
- Writing to `CONTEXT.md`, `CONTEXT-MAP.md` or `docs/architecture/`. Existing areas are only referred to by name.
- Adding a requirement, rule or scenario that no adopted candidate, request phrase or draft line supports. Moving an item keeps its wording and its source.
- Reintroducing a rejected or held candidate, or a `요청 범위 밖 관찰`.

## Process

1. Work in the active workspace. Start with `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and, if it fails, return `blocked` with its output. Find each document with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. Read `stakeholder-analysis.md`. When it says `판정: 생략`, write nothing, record the skip and its evidence path in the result summary and return `completed/OK`.
3. On resume, read the previous result, `requirements.md` and the actual answers. When the SD table and every `BIZ` section already exist, only verify them and finish; apply new answers to the affected grouping and do not redo settled parts.
4. List the business activities. A `BIZ` is one thing an actor completes in one go, like a use case: an actor, a trigger and a visible end. Cut the draft's scenarios and the adopted candidates by that unit. Two activities that one actor finishes separately are two `BIZ`; steps inside one completion are not.
5. Place every adopted `CAND` in exactly one `BIZ` by its kind: `goal` in `업무 목적`, `actor` in `업무 주체`, `rule` in `업무 규칙`, `exception` in `예외 시나리오`, `completion` in `완료 조건`. A candidate that no single activity owns goes to the document's `6.1 범위·비목표` or `6.2` with the source `CAND-xx 채택`.
6. Group the `BIZ` into subdomain candidates. Map to existing areas first: when `CONTEXT-MAP.md` or `docs/architecture/domain-model.md` already holds the activity's business, extend that area and write `기존 영역 확장: <이름>`. Propose a `새 후보` only when no existing area can hold the work, and name which difference makes it separate. Split only by a different business purpose, a different language (the same word meaning different things) or a different set of actors. Never make one subdomain per candidate; a small request usually has one subdomain.
7. Write `requirements.md`: the SD table with `분류` set to `미정`, `근거` to `-`, `상태` to `draft` and `핵심 용어 후보` (words the activities use that need one meaning, taken from the request, candidates and existing `CONTEXT.md`), a `### BIZ-xx <업무명> (SD-xx)` section per activity with `상태: draft`, `업무 목적`, `업무 주체`, `참여한 stakeholder`, `정상 시나리오` and `예외 시나리오` moved from the draft, and `없음 — 후속 stage가 채운다` in the fields that later stages own. Delete the `### 요구사항 초안` block after every line of it has moved. Add the stage to each `BIZ`'s `출처·변경 이력`.
8. Check before returning: every `BIZ` belongs to exactly one `SD` and every `SD` lists at least one `BIZ`; every adopted `CAND` appears exactly once with its source; no line lost its source; no technology or bounded-context wording was added. Return `completed/OK` with `requirements.md`.

## Questions

Ask only when two plausible groupings of the same request change which work is in scope, not merely how it is arranged. Write the questions in Korean in one batch, show what each option includes and excludes, give each a recommended option with a rationale from the request, and return `action_required` / `USER_DECISION_REQUIRED`. Record the answer with its `answers.json` source. A grouping preference alone is never a question.

## Completion

- `requirements.md` has a complete SD table and a `BIZ` section for every activity, with the draft block gone.
- Every item keeps its original source; rejected, held and out-of-scope items are absent.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `ubiquitous-language` reads the SD table and the `BIZ` sections.
