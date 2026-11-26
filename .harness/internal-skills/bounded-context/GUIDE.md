---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# bounded-context

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

## Purpose

Last step of the requirements flow, after `requirements-fix`. Decide the bounded contexts of the request's business from the requirements that `requirements-fix` completed, record them in `requirements.md`, update the project's `CONTEXT-MAP.md` and the context scopes in `CONTEXT.md`, then fix the document: when the confirmation gate passes, set its `상태` to `fixed` automatically. No persona runs. This stage runs at the high performance tier because a boundary is expensive to reverse, the later Architecture phase treats it as settled input and never compares it again, and the stage writes a project-wide document. It decides contexts only: no aggregates, modules, persistence, communication mechanism or deployment.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- Earlier stages' results and answers: the `context.upstream` refs of the input. Read them; never search `.io` for them.
- `docs/specs/<plan-set-id>/requirements.md` with its confirmed SD table and classes, the `BIZ` sections that `requirements-fix` completed (scenarios, `INV`, `EX`, `AC`) and the common sections, event flows, `## 4` cross-subdomain events and resolved hotspots, and `stakeholder-analysis.md`.
- The repository-root `CONTEXT-MAP.md`, `docs/architecture/domain-model.md`, the ADRs they link and the repository-root `<workspace_root>/CONTEXT.md` (not under `docs/specs/`), when present: the existing contexts and the current vocabulary.
- The boundary rule in [ddd-design](../ddd-design/GUIDE.md) and the model lifecycle in [model-continuity](../ddd-design/references/model-continuity.md). They own the criteria, the fair comparison of combined and separate options, the existing-owner-first rule and the `implemented` versus `accepted-target` distinction; apply them as written and do not restate them in the document.
- The [requirements.md template](../requirements-fix/references/template.md), which owns the BC table, and the [coverage checklist](../requirements-fix/references/coverage.md), whose `확정 조건` this stage runs before fixing.

## Prohibited

- Inspecting source or test code. Existing contexts come only from the documents above; when none exist, record `기존 모델 문서 없음` and treat the project as having no existing context.
- Inferring a context from a feature name, a single subdomain, an aggregate or a module, or choosing one by the size of the work.
- Modeling aggregates, entities or modules, choosing a communication or deployment mechanism, or drawing a context diagram.
- Changing a requirement, rule, event or scenario, or reopening a subdomain's confirmed set or class. A boundary that needs a requirement the document lacks returns `blocked` / `DEPENDENCY_INCOMPLETE` with `result.owner_stage: requirements-fix` and `result.dependency_gap` naming the missing `BIZ` item; the orchestrator reopens `requirements-fix` and runs this stage again.
- Writing a context as `implemented` when nothing is built, or overwriting an existing context's recorded facts.

## Process

1. Work in the active workspace. Return `blocked` when `context.workspace.preflight.valid` is false; take document paths from `context.workspace.documents`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, put the skip and its evidence path in the result summary and return `completed/OK`.
3. 재개할 때 이전 결과, `requirements.md`, `CONTEXT-MAP.md`, 실제 답변과 수정 지시를 읽는다. 영향받는 소유권과 관계만 다시 검토하고 유효한 컨텍스트 ID, 승인된 경계와 기존 구현 상태를 보존한다.
4. Map to existing contexts first. For each confirmed subdomain and its `BIZ`, decide whether an existing context already owns the language, rules and data; extension of that context is the first option to test.
5. For what the existing contexts cannot hold, compare the plausible combined and separate options with the ddd-design criteria, using the evidence in `requirements.md`: the vocabulary and event names, the rules each `BIZ` owns, the cross-subdomain events and their reactions, and the actors. Judge every option against the same criteria. Keep the options that remain plausible and the evidence that separates them. Check the early glossary and any terms added by event-storming against each plausible context placement; collect unresolved material meaning conflicts before asking. Settle by evidence what the evidence settles. Ask only the boundary choices or glossary meaning conflicts where the plausible options materially change the result, in one batch, in Korean: the options with what each includes and the consequences for responsibility, rules and relationships, a recommended option and its rationale, in the [question format](../grilling/GUIDE.md#ask-questions-the-user-can-answer) (settled rules as context; per option its effect and one concrete flow across the boundary as an example). Return `action_required` / `USER_DECISION_REQUIRED`. With nothing to ask go to step 6.
6. Record the decisions. With answers, a free-text answer is recorded in the user's wording; ask again only when it is ambiguous. Write `### 1.1 바운디드 컨텍스트` of `requirements.md` as the template shows: every `BIZ` is in exactly one context; `책임` and `소유 규칙·데이터` use the `INV` and `BIZ` IDs and terms of the document; `근거` states whether an existing context was extended and which criterion decided, with its source; `비교한 대안` lists the combined and separate options. Add the stage to each touched `BIZ`'s `출처·변경 이력`. BC 행은 `community (커뮤니티)`처럼 `Context ID (이름)`으로 적고 기존 ID를 재사용한다.
7. Assign provisional BIZ-scoped glossary entries to the decided contexts in `CONTEXT.md` without changing settled meanings. Add any qualifying terms introduced after the initial glossary from the requirements term table with their final scope and source. Preserve homonyms in separate context-scoped entries; if a material meaning conflict remains unresolved by the evidence, ask the user in the boundary question batch before recording the decision. Do not revive retired terms or rewrite unrelated text. After deciding the contexts, update `CONTEXT-MAP.md` and keep its existing contexts and records. Add or update a row per context in `## 2. 경계` with its responsibility, business inputs and outputs, covered subdomains and class, `accepted-target` status and source `docs/specs/<plan-set-id>/requirements.md`. Never mark a new context `implemented`; keep existing implementation facts. In `## 3. 관계`, give each evidenced relationship one concise row: upstream, downstream, each context's responsibility, the communication contract (information supplied, when it is needed, and the downstream reaction or rejection) and the `판단 소유자`, with its source and status. The `판단 소유자` is the context whose rules decide the outcome when the two contexts could disagree about the shared fact, so the other context carries that outcome. Take it from the `INV` and `EX` owners and the event reactions in `requirements.md`; write `미정` with the reason when the evidence does not say, never a guess. An existing map whose `## 3. 관계` table has no `판단 소유자` column gets the column added before the status column, with `미정` in rows the evidence cannot settle and its other cells kept. Name isolated contexts rather than inventing connections. The contract is a business-level agreement, not proof of an API, protocol, event transport or delivery guarantee; mark unspecified details as undecided. Record a relationship pattern only when supported by evidence and useful; do not invent one. Where direction is not established, say so instead of assigning upstream/downstream speculatively.
8. 확정 전에 각 `BIZ`의 출처와 완료 조건에서 SD의 경계(사용자 승인 또는 `요청 해석(에이전트 제안)`으로 승인 요약에 오른 것)와 소유 Context까지 추적한다. 업무마다 책임이 한 곳에 있고 규칙·데이터·관계 판단의 소유자가 현재 근거와 일치해야 한다. 독립 업무의 누락은 `subdomain-candidates`, 승인되지 않았거나 다시 비교해야 할 SD 경계는 `subdomain-classification`, 규칙·예외·완료 조건의 누락은 `requirements-fix` 등 가장 앞선 소유자에게 `blocked` / `DEPENDENCY_INCOMPLETE`와 확인한 근거로 돌려보낸다.
9. [Coverage checklist](../requirements-fix/references/coverage.md)의 `확정 조건`(bounded-context 행 포함)을 모두 대조한다. 통과하면 머리글·모든 `BIZ`와 `SD`의 `상태: fixed` 및 바뀐 `출처·변경 이력`을 writer에게 넘길 결정에 포함한다. 공통 정의 JSON 제안은 `runtime/executions/<execution_id>/domain-sync-proposal.json`에 항상 직접 저장한다(바꿀 공통 정의가 없으면 `{"schema_version":1,"links":{},"changes":[]}`). 미리 확인하려면 `HARNESS_STAGE_EXECUTION_ID=<execution_id> node .harness/scripts/harness-domain.mjs sync plan <plan-set-id> <제안 경로>`를 이 stage가 직접 실행하며, 호출자에게 부탁하지 않는다. 실행기가 작성된 문서에서 제안을 검증하고 동기화 계획을 계산한다. `completed/OK`에 `requirements.md`, `CONTEXT-MAP.md`와 범위가 바뀐 경우 `CONTEXT.md`를 적고, `result.summary`는 사용자 승인 요약으로 쓴다(12줄 이하, 줄마다 BIZ·서브도메인·Context 하나의 규칙·예외·완료 조건 수와 핵심, 마지막 줄에 `requirements.md` 경로). 오케스트레이터는 문서를 읽지 않고 이 요약을 그대로 보여 준다. 열린 행은 8단계에서 찾은 가장 앞선 소유자에게 돌려보낸다.

## Completion

- The BC table covers every `BIZ` with responsibility, owned rules and data, rationale and compared alternatives, and the boundary choices the user made carry their `answers.json` source.
- Every checklist row is `SETTLED` or `NOT_APPLICABLE` with a reason, the document's `상태` is `fixed`, and the runner validates the staged domain sync proposal. This stage asks no approval question. After it completes, the orchestrator shows the fixed requirements to the user, with the runner-provided `defaults_ko` list (every `기본값` decision and every unasked subdomain boundary or class) verbatim as "묻지 않고 정한 것" so the user may change any, and tactical design starts only with the user's approval.
- `CONTEXT-MAP.md` carries the contexts, their covered subdomains with class, their relationships with the `판단 소유자` of each and the `accepted-target` status.
- The runner commits `docs/specs/<plan-set-id>/`, `CONTEXT-MAP.md` and `CONTEXT.md` when this stage completes. `ubiquitous-language` already defined the provisional terms, and later tactical design stages treat the `fixed` requirements and the decision as settled input.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 Context 책임과 관계를 먼저 확인한다. Subdomain과 Context의 1:1 대응을 가정하지 않는다.

공통 정의를 소유할 Context는 `CONTEXT-MAP.md`의 Bounded Context 표에서 `Context ID`를 사용한다. 기존 ID를 우선하고, 새 Context의 ID는 소문자 slug로 정한다. 이름 변경 시 ID는 유지한다.

확정할 공통 정의와 기존 ID 재사용 결정을 사용자 답변 및 coverage와 대조한다. 실행 폴더의 `domain-sync-proposal.json`에 `{schema_version:1, links:{<로컬 ID>:<공통 ID>}, changes:[{operation,id,reason,document:{metadata,body}}]}`를 적고, 각 정의의 소유 Context는 이 stage가 정한 `Context ID`로 둔다. 기존 정의는 `reuse`와 ID만 지정할 수 있다. 작성 에이전트가 문서를 완성한 뒤 실행기가 계획을 계산해 적용하고 stage 문서와 함께 커밋한다. 관련 정의가 이미 맵에 있으면 기존 연결을 보존한다.
