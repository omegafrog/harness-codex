---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# ubiquitous-language

## Purpose

Step of the requirements flow after `bounded-context` and before `requirements-fix`. Make the same word always mean the same thing inside each bounded context: build the `## 3` term table of `requirements.md`, rewrite the document so every sentence uses only those terms, and record the settled terms with their context scope in the project's `CONTEXT.md`. No persona runs. The user is asked only about terms whose meaning would change the outcome.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/requirements.md` resolved with `harness-spec-path.mjs`. Its event names are the main source of terms; its `BIZ` text, SD table and hotspot decisions are the rest.
- The bounded-context table `### 1.1` of `requirements.md`, `stakeholder-analysis.md` for the vocabulary of the adopted candidates, and `CONTEXT.md` plus `CONTEXT-MAP.md` for the current canonical and retired terms and the context names.
- [Language lifecycle](../domain-modeling/references/language-lifecycle.md) and the [requirements.md template](../requirements-fix/references/template.md).

## Prohibited

- Inspecting source or test code, or taking identifiers from the current implementation as business terms.
- Adding a requirement, rule or scenario while rewording. Wording changes keep the meaning and the source of every item.
- Asking about a word whose meaning does not change what gets built, or one that an adopted candidate or earlier answer already settles.
- Defining a retired term as a current term or alias, or replacing a current canonical term on suspicion alone.

## Process

1. Work in the active workspace. Begin with `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and return `blocked` with the output when it fails. Look up each document with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, put the skip and its evidence path in the result summary and return `completed/OK`.
3. On resume, read the previous result, `requirements.md`, `CONTEXT.md` and the actual answers. Continue at step 6 when answers exist; keep rows and decisions already recorded.
4. Collect the words the document uses for business concepts, actors, states, rules and events. Group the variants. Keep only the words that are used in more than one form for the same thing, or that one word uses for different things, or that are easily confused with a neighboring term. Plain words that nobody can misread get no row.
5. Compare with `CONTEXT.md` using the [language lifecycle](../domain-modeling/references/language-lifecycle.md), per context. Reuse the current canonical term of that context when the meaning matches; never use a retired term. A different meaning for an existing term is a definition update or a rename, and it is a question when the choice changes the outcome. Draft the table as `용어 | 뜻 | 쓰지 않을 말` and list the terms whose meaning the user must choose. Ask them in one batch in Korean with concrete options and what each changes, a recommended option and its reason, and return `action_required` / `USER_DECISION_REQUIRED`. With no such term go to step 6.
6. With the answers, settle the table. A row decided by an answer ends its `뜻` with `(answers.json)`. Write the table into `## 3`.
7. Rewrite `requirements.md` so every sentence, event name, SD row, hotspot decision and common section uses only table terms: replace each `쓰지 않을 말` and each variant in the text, keeping quotations of the request and the `요청 원문` fields as they are, and the context names exactly as `bounded-context` wrote them. Add the stage to each touched `BIZ`'s `출처·변경 이력`.
8. Update `CONTEXT.md` in the consumer's own table format. For each table term that names a business concept, actor, state or rule of a context: add the entry with its context scope, update the definition, or record the replacement in the retired-term table, with `docs/specs/<plan-set-id>/requirements.md` as the source. Put `쓰지 않을 말` into the forbidden terms of the entry. Leave plan-set-only wording, UI copy and code identifiers out. Keep the existing table, order and lifecycle records.
9. Check before returning: the table's rows are the only terms in the document for their concepts; each affected term is classified as kept, definition updated, replaced or unresolved, and the `CONTEXT.md` diff matches that classification; no term is unresolved. Return `completed/OK` with `requirements.md` and `CONTEXT.md`.

## Per-context terms

A term may mean something different in each bounded context. Decide every term's meaning per context of the `### 1.1` table. When a word differs by context, write one row per context with the context in the `용어` cell as `<용어> (<BC 이름>)`, for example `회원 (커뮤니티)`, and one `CONTEXT.md` entry per context that states its context scope as the domain-modeling placement rules describe. The same word with different meanings in two contexts is a legitimate homonym, not a conflict, and is never merged. A word with one meaning across the contexts that use it keeps one row and one project-wide entry. A `BIZ` text uses the term of the context its `BIZ` belongs to; a sentence about the border between contexts names both contexts.

## Completion

- `## 3` lists the confusable terms with `용어 | 뜻 | 쓰지 않을 말`, and user-decided rows end with `(answers.json)`.
- `requirements.md` uses only those terms, and no item gained or lost meaning or source.
- `CONTEXT.md` carries the settled terms and any replacement records.
- The runner commits `docs/specs/<plan-set-id>/` and `CONTEXT.md` when this stage completes. `requirements-fix` and `spec-me` reuse the terms as they are.
