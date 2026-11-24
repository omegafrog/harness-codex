---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# event-storming

실행 배정에 `document_draft_root`가 있으면 문서별 결정·근거·변경 위치와 필요한 양식을 그 아래의 같은 상대 경로에 간결하게 모은다. 완성 문장은 작성 에이전트가 한 묶음으로 작성한다. 아래의 작성·수정 지시는 작성 에이전트에게 넘길 내용 기준으로 사용하고, 결과에는 정본의 상대 경로를 적는다.

## Purpose

Step of the requirements flow after `ubiquitous-language` and before `subdomain-classification`. Map the flow of each business activity (`BIZ-xx`) into actors, commands, domain events, policies, external systems and hotspots, at business level only, and record it in `requirements.md` with PlantUML diagrams. This stage is the facilitator: it runs the domain lens as a fresh persona, validates what it returns, asks the user about the hotspots and records the answers. The domain model that the tactical design flow builds later starts from this result; this stage does not model aggregates, bounded contexts, modules or persistence.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- Earlier stages' results and answers: the `context.upstream` refs of the input. Read them; never search `.io` for them.
- On a resume, read the current input's `context.previous_result_ref` and saved answer refs; read the prior execution's input only when it matters and `input_refs` lists it.
- `docs/specs/<plan-set-id>/requirements.md` (SD table and `BIZ` sections) and `stakeholder-analysis.md` (adopted `CAND`s), resolved with `harness-spec-path.mjs`, and the `## 3` term table there for settled vocabulary.
- The repository-root `<workspace_root>/CONTEXT.md` (not under `docs/specs/`; do not resolve it with `harness-spec-path.mjs`) for settled vocabulary.
- The [domain lens card](../stakeholder-analysis/references/lenses/domain.md) and the events mode of the [persona contract](../stakeholder-persona/GUIDE.md).
- The [event diagram reference](references/diagrams.md) and the [requirements.md template](../requirements-fix/references/template.md).

## Prohibited

- Inspecting source or test code, or choosing frameworks, persistence or module structure.
- Modeling aggregates, entities or bounded contexts, or recording technical events such as clicks, saves or API calls.
- Recording events for a `BIZ` that is not in `requirements.md`, or adding a feature, policy or step that no scenario line, adopted candidate or request phrase supports.
- Rerunning the persona after the user answered or on a feedback/recovery run that finds the event tables recorded, or treating a persona statement as a user decision.

## Process

1. Work in the active workspace. Start with `node .harness/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and return `blocked` with its output if it fails. Find the documents with `node .harness/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, record the skip with its evidence path in the result summary and return `completed/OK`.
3. 재개할 때 현재 입력의 `context.previous_result_ref`, 답변 refs, `requirements.md`, `stakeholder-analysis.md`를 읽는다. 이전 입력은 맥락에 필요하고 현재 입력 `input_refs`가 가리킬 때만 연다. 앞 단계 변경을 검토하는 실행이면 바뀐 업무와 연결된 이벤트·정책·hotspot부터 점검하고 해당 표와 다이어그램만 갱신한다. 유효한 ID와 답변, 이미 기록된 persona 결과는 보존한다. `--feedback`·복구·인계로 재개한 실행(입력에 `context.previous_result_ref`나 `kind: previous_execution_result`인 `input_refs`가 있음)은 `requirements.md`의 BIZ마다 `이벤트 흐름` 표나 `이벤트 없음 — 이유`가 있고 `## 5` hotspot 목록이 있으면 그 표가 persona 결과다. 이때 4·5단계를 건너뛰고 기록된 표와 이전 결과의 refs를 재사용하며 persona를 시작하지 않는다. 표가 없는 BIZ가 남았을 때만 그 BIZ의 skeleton만 보내 4단계를 실행한다. 질문에 답변을 받았으면 7단계로, 다이어그램만 남았으면 8단계로, 그 외에는 아직 기록되지 않은 단계로 간다.
4. Run `node .harness/scripts/harness-stage-runtime.mjs binding --root <workspace_root> --skill stakeholder-persona` and use the returned model and reasoning effort; if it fails, return `blocked` / `MODEL_BINDING_UNAVAILABLE`. Start one fresh native `stakeholder_persona` subagent (Codex: `spawn_agent` with `fork_turns: "none"`; Claude Code: `Agent` with `subagent_type: stakeholder_persona`) with `mode: events`. Send it only the domain lens card text, the request verbatim, the adopted candidates with their statements, the SD table, the `BIZ` skeletons and the settled `## 3` term table. Wait for its JSON.
5. Validate every step and hotspot before it enters the document:
   - `biz_id` is a `BIZ` in `requirements.md`. A `BIZ` the persona skipped is recorded as `이벤트 없음 — 이유`.
   - `basis` is a scenario line of that `BIZ`, an adopted `CAND`, or an exact substring of the request. Otherwise the step is a `요청 범위 밖 관찰`.
   - `event` is a business fact in Korean past tense and names no technical occurrence. Fix the wording of a valid step; drop an event that has no business meaning.
   - `policy` and `external_system` must come from the same basis. A reaction that would add a feature, such as a notification no scenario mentions, is a `요청 범위 밖 관찰`.
   - Merge hotspots that ask the same thing. A hotspot that an adopted `CAND` or an earlier answer already settles is `해결` with that source and is not asked.
6. Use settled terms in events and diagrams. When a new event introduces a distinct concept, record it in the `## 3` term table with its source and provisional BIZ scope; never invent an already settled meaning. Write into `requirements.md` the `이벤트 흐름` table of each `BIZ`, the `## 4` table of events whose reaction lies in another subdomain, and the `## 5` hotspot list as `HS-01…` with `상태: 대기`. A cross-subdomain row needs a reaction that a step, policy or candidate supports; when none does, make it a hotspot. Add the stage to each touched `BIZ`'s `출처·변경 이력`. Append the out-of-scope observations to the `요청 범위 밖 관찰` table of `stakeholder-analysis.md` with the proposer `LENS-DOMAIN (event-storming)`.
7. Ask every open hotspot in one batch, in Korean: one question per hotspot titled with its `BIZ` and `HS` ID, concrete options with their consequences, a recommended option and a rationale grounded in the request. Follow the [question format](../grilling/GUIDE.md#ask-questions-the-user-can-answer): the settled `INV`/`EX` rules of that `BIZ` as context, and under each option its effect and the same scenario played out as an example. Return `action_required` / `USER_DECISION_REQUIRED`. With no open hotspot go to step 8. For each settled answer, set its hotspot `해결` and record only the user's confirmed decision as `업무 규칙` (`INV-xx`) or `예외 시나리오` (`EX-xx`) of its `BIZ` with the source `answers.json` and the `question_id`, then link it in `## 5`. Preserve the wording of confirmed free-text decisions and their conditions. Keep explanations and follow-up questions out of rules and exceptions. If an answer still leaves a decision open, keep its hotspot `대기`, return a focused question for that decision and preserve the other settled answers. Change an event table row only when the answer itself names the resulting business fact.
8. Write the diagrams from the final tables as the [event diagram reference](references/diagrams.md) describes: one `SD-xx.events.puml` per subdomain candidate and `cross-subdomain.events.puml`, each rendered to `.svg` with the local renderer, and link every `.puml` and `.svg` from `## 4`. A render failure blocks completion.
9. Check before returning: every `BIZ` has an event table or an `이벤트 없음` reason; every event traces to a basis; no hotspot is `대기`; every `.puml` has a non-empty `.svg` and both are linked. Return `completed/OK` with `requirements.md`, `stakeholder-analysis.md` when it changed, and the `diagrams/events` directory.

## Completion

- `requirements.md` holds the event tables, the cross-subdomain table, the hotspot list with every decision linked to an `INV` or `EX`, and the diagram links.
- Every hotspot answer is recorded as confirmed with its `answers.json` source; no persona ran after the answers.
- The `.puml` originals and their `.svg` renders exist under `docs/specs/<plan-set-id>/diagrams/events/`.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `subdomain-classification` validates the subdomain boundaries with these tables, `ddd-design` and the tactical design stages read the same tables instead of running this stage again.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 후보 이벤트·정책·전이를 비교하고 같은 정의는 공통 ID를 참조한다. 신규 이벤트 흐름의 각 정의에 Plan Set 고유 EVT-xx, POL-xx, TRN-xx를 배정한다. 없는 정책·전이에는 ID를 만들지 않는다. 완료 문서에 ID를 소급 추가하지 않는다.
