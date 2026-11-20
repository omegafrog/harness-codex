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
- Existing areas, read-only and only when present: `CONTEXT-MAP.md`, `docs/contracts/architecture.md` and `CONTEXT.md`.
- The [requirements.md template](../requirements-fix/references/template.md), which owns the shape of the SD table and the `BIZ` sections.

## Prohibited

- Inspecting source or test code, naming bounded contexts, modules, packages, persistence or frameworks.
- Writing to `CONTEXT.md`, `CONTEXT-MAP.md` or `docs/architecture/`. Existing areas are only referred to by name.
- Adding a requirement, rule or scenario that no adopted candidate, request phrase or draft line supports. Moving an item keeps its wording and its source.
- Reintroducing a rejected or held candidate, or a `요청 범위 밖 관찰`.
- Asking whether a feature of the requested-feature table (`REQUESTER`) is in scope, or leaving it without a `BIZ`. The requester already settled it.

## Shared interview protocol

사용자 질문을 반환하기 전에 [stage 인터뷰 절차](../grill-with-docs/GUIDE.md#stage-hosted-invocation)를 일괄 질문 모드로 적용한다. 이 stage의 점검 항목과 정본 문서, 결정 범위를 입력으로 사용한다.

## Process

1. Work in the active workspace. Start with `node .harness/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and, if it fails, return `blocked` with its output. Find each document with `node .harness/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. Read `stakeholder-analysis.md`. When it says `판정: 생략`, write nothing, record the skip and its evidence path in the result summary and return `completed/OK`.
3. 재개할 때 이전 결과와 `requirements.md`, 실제 답변, 수정 지시를 읽는다. 표가 있어도 누락 지적과 수정 지시를 현행 근거와 대조한다. 영향을 받는 행만 보완하고 유효한 결정과 ID를 보존한다. 이미 확정된 문서를 보완하는 실행이면 문서 상태를 `draft`로 바꾸고 수정 근거를 남긴다.
4. `stakeholder-analysis`의 requested-action 표와 실제 답변을 읽는다. 포함 행동 각각을 행위자·대상·시작 조건·독립적으로 관찰 가능한 완료 결과로 검토하고 `BIZ`로 배정한다. 요청 범위 결정은 여기서 바꾸지 않는다. 누락된 범위 판단은 `blocked` / `DEPENDENCY_INCOMPLETE`, `result.owner_stage: stakeholder-analysis`로 돌린다. 결정된 포함 행동에 BIZ가 없으면 이 stage가 소유한다. 제외·후속 행동에 BIZ를 만들지 않는다. 모든 포함 ACT는 적어도 하나의 BIZ에, 모든 BIZ는 포함 ACT와 근거에 연결한다.
5. Place every adopted `CAND` in exactly one `BIZ` by its kind: `goal` in `업무 목적`, `actor` in `업무 주체`, `rule` in `업무 규칙`, `exception` in `예외 시나리오`, `completion` in `완료 조건`. A candidate that no single activity owns goes to the document's `6.1 범위·비목표` or `6.2` with the source `CAND-xx 채택`.
6. `6.1`의 포함 ACT마다 BIZ 링크를 채우고, 각 BIZ에 역방향 ACT 및 evidence 참조를 둔다. BIZ 본문에는 `- 행동 ID: ACT-xx — 근거: <동일한 scope evidence>` 필드를 한 번 기록하고, 이후 다른 필드의 ACT 언급은 역방향 링크로 간주하지 않는다. Actor, target, start condition, independent completion result, applicable create/read/change/delete/end actions, state/permission and prerequisite를 검토한다. umbrella BIZ 하나로 서로 독립 완료되는 행동을 숨기지 않고, 내부 단계마다 BIZ를 만들거나 무조건 CRUD를 만들지 않는다. Group the `BIZ` into subdomain candidates. Map to existing areas first: when `CONTEXT-MAP.md` or `docs/contracts/architecture.md` already holds the activity's business, extend that area and write `기존 영역 확장: <이름>`. Propose a `새 후보` only when no existing area can hold the work, and name which difference makes it separate. Split only by a different business purpose, a different language (the same word meaning different things) or a different set of actors. Never make one subdomain per candidate; a small request usually has one subdomain.
7. Write `requirements.md`: the SD table with `분류` set to `미정`, `근거` to `-`, `상태` to `draft` and `핵심 용어 후보` (words the activities use that need one meaning, taken from the request, candidates and existing `CONTEXT.md`), a `### BIZ-xx <업무명> (SD-xx)` section per activity with `상태: draft`, `업무 목적`, `업무 주체`, `참여한 stakeholder`, `정상 시나리오` and `예외 시나리오` moved from the draft, and `없음 — 후속 stage가 채운다` in the fields that later stages own. Delete the `### 요구사항 초안` block after every line of it has moved. Add the stage to each `BIZ`'s `출처·변경 이력`.
8. 모든 `BIZ`가 SD 하나에 속하는지, 모든 SD에 BIZ가 있는지 확인한다. 모든 요청 기능과 채택 `CAND`를 활동이나 그 활동의 규칙·예외·조건에서 출처로 역추적한다. 다른 활동에 숨은 독립 완료를 확인하고, 기존 자료에서 확인한 실제 공백만 수정한다. `requirements.md`를 첨부해 `completed/OK`를 반환한다.

## Questions

Ask only when two plausible groupings of the same request change which work is in scope, not merely how it is arranged. A feature the request names is never such a choice: its inclusion is settled by the requester. Write the questions in Korean in one batch, show what each option includes and excludes, give each a recommended option with a rationale from the request, and return `action_required` / `USER_DECISION_REQUIRED`. Record the answer with its `answers.json` source. A grouping preference alone is never a question.

## Completion

- `requirements.md` has a complete SD table and a `BIZ` section for every activity, with the draft block gone.
- Every item keeps its original source; rejected, held and out-of-scope items are absent.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `ubiquitous-language` reads the SD table and the `BIZ` sections.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 Subdomain과 업무 후보를 먼저 비교하고 의미가 같으면 공통 ID를 근거로 연결한다.
