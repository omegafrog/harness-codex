---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# ubiquitous-language

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

## Purpose

Step of the requirements flow after `subdomain-candidates` and before `event-storming`. Settle confusing business terms from the request and candidate activities before event tables and diagrams are written. Record them in `## 3` of `requirements.md` and the project glossary `CONTEXT.md`. Candidate subdomains are not bounded contexts: scope new terms to their BIZ or existing proven context, and mark the scope provisional until `bounded-context` assigns it. No persona runs. Ask only when a meaning changes the outcome.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- Earlier stages' results and answers: the `context.upstream` refs of the input. Read them; never search `.io` for them.
- `docs/specs/<plan-set-id>/requirements.md`. Its draft `BIZ` text and SD term candidates are the sources; event tables, classifications and new bounded contexts do not exist yet.
- `stakeholder-analysis.md` for adopted candidates.
- The existing repository-root `<workspace_root>/CONTEXT.md` and `<workspace_root>/CONTEXT-MAP.md` (not under `docs/specs/`) for canonical and retired terms and any already established context names.
- [Language lifecycle](../domain-modeling/references/language-lifecycle.md) and the [requirements.md template](../requirements-fix/references/template.md).

## Prohibited

- Inspecting source or test code, or taking identifiers from the current implementation as business terms.
- Adding a requirement, rule or scenario while rewording. Wording changes keep the meaning and the source of every item.
- Asking about a word whose meaning does not change what gets built, or one that an adopted candidate or earlier answer already settles.
- Defining a retired term as a current term or alias, or replacing a current canonical term on suspicion alone.

## Process

1. Work in the active workspace. Return `blocked` when `context.workspace.preflight.valid` is false; take document paths from `context.workspace.documents`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, put the skip and its evidence path in the result summary and return `completed/OK`.
3. 재개할 때 이전 결과, `requirements.md`, `CONTEXT.md`와 실제 답변을 읽는다. 앞 단계 변경을 검토하는 실행이면 추가·수정된 BIZ의 용어만 4단계부터 검토하고 나머지 용어와 유효한 답변을 보존한다. 대기한 질문을 이어가는 실행에서 답변을 받았으면 6단계로 간다.
4. Collect the words the document uses for business concepts, actors, states, rules and events. Group the variants. Keep only the words that are used in more than one form for the same thing, or that one word uses for different things, or that are easily confused with a neighboring term. Plain words that nobody can misread get no row.
5. Compare with `CONTEXT.md` using the [language lifecycle](../domain-modeling/references/language-lifecycle.md), per existing context or provisional BIZ scope. Reuse the current canonical term of that scope when the meaning matches; never use a retired term. A different meaning for an existing term is a definition update or a rename, and it is a question when the choice changes the outcome. Draft the table as `용어 | 뜻 | 쓰지 않을 말`. Apply the [asking criterion](../grilling/GUIDE.md#decide-whether-to-ask): a term whose competing meanings give a `high` difference is a question; a `low` one (a label, a wording) is settled by you with the row's `뜻` ending in `(요청 해석(에이전트 제안))`, and a term with no observable difference is settled silently. Ask the `high` terms in one batch in Korean with concrete options and what each changes, a recommended option (the smallest that serves the request's purpose) and its reason, and return `action_required` / `USER_DECISION_REQUIRED`. With no such term go to step 6.
6. With the answers, settle the table. A row decided by an answer ends its `뜻` with `(answers.json)`. Write the table into `## 3`.
7. Update only draft expressions whose ambiguity or conflict with a settled term changes their meaning; preserve request quotations and sources. Do not rewrite every sentence for stylistic uniformity. Add the stage to each touched `BIZ`'s `출처·변경 이력`. Later stages use the terms when writing new content.
8. Update `CONTEXT.md` in the consumer's own table format. For each table term that names a business concept, actor, state or rule: add the entry with its established context or provisional BIZ scope, update the definition, or record the replacement in the retired-term table, with `docs/specs/<plan-set-id>/requirements.md` as the source. Put `쓰지 않을 말` into the forbidden terms of the entry. Leave plan-set-only wording, UI copy and code identifiers out. Keep the existing table, order and lifecycle records.
9. Check before returning: no materially ambiguous or conflicting use remains in the existing draft; each affected term is classified as kept, definition updated, replaced or unresolved, and the `CONTEXT.md` diff matches that classification; no term is unresolved. Return `completed/OK` with `requirements.md` and `CONTEXT.md`.

## Scope before bounded contexts

Reuse established context ownership where evidence exists. Otherwise mark each new scoped entry with its BIZ or candidate SD and `범위 미확정`; these provisional groups are not context decisions. Distinct meanings may have separate entries with their BIZ scopes. Do not assert that candidate SDs are bounded contexts. `bounded-context` later maps these scopes to the selected contexts, reconciles the glossary and asks when a material meaning conflict cannot be resolved from existing evidence.

## Completion

- `## 3` lists the confusable terms with `용어 | 뜻 | 쓰지 않을 말`, and user-decided rows end with `(answers.json)`.
- `requirements.md` has no materially ambiguous or conflicting use, and no item gained or lost meaning or source.
- `CONTEXT.md` carries the settled terms and any replacement records.
- The runner commits `docs/specs/<plan-set-id>/` and `CONTEXT.md` when this stage completes. `event-storming` uses the terms, and `bounded-context` reconciles their final scope.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. Pack에 표시된 용어는 CONTEXT.md의 현행 표로 확인한다. 폐기 용어를 현행 Alias로 되살리지 않는다.
