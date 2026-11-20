---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# stakeholder-analysis

## Purpose

First stage of a new feature: settle scope before detailed business rules. Every explicitly requested top-level feature is already included by `REQUESTER`; it is never offered for adoption, rejection or deferral. For each named capability, identify independently completable user actions and record the user's include, exclude or workflow-follow-up decision. Personas may expose candidate decisions, conflicts and optional observations, but cannot remove requested scope. The persona record stays in `stakeholder-analysis.md`; this stage creates `requirements.md` and its per-action coverage contract. `subdomain-candidates` owns BIZ decomposition and IDs; this stage records scope decisions, not BIZ groupings.

## Inputs

- The user request (`scope` of the execution input), read verbatim. It is the only subject of discussion. The requester is a stakeholder (`REQUESTER`): every feature the request names is the requester's settled requirement.
- Default expert lenses: [domain expert](references/lenses/domain.md), [security expert](references/lenses/security.md).
- Registered stakeholder cards: `node .harness/scripts/harness-stakeholder.mjs list --json` in the active workspace. Cards are project-owned; never create, edit or remove them. A card under `problems` is malformed and is not run.
- `CONTEXT.md` and any existing `docs/specs/*/requirements.md` only for the skip decision.
- [Output template](references/output-template.md), the [requirements.md template](../requirements-fix/references/template.md) and the [persona contract](../stakeholder-persona/GUIDE.md).

## Prohibited

- Inspecting source or test code, or choosing frameworks, persistence or module structure.
- Turning actors named in the request into personas. Only registered cards become stakeholder personas.
- Treating a persona statement, or agreement among personas, as a user decision.
- Asking whether a feature the request names is in scope, or offering to reject, hold or defer it. Its content may be asked; its inclusion is settled.
- Treating an exact request anchor as proof that an optional persona idea is in scope.
- Writing requirements the user has not adopted into `requirements.md` or `CONTEXT.md`.

범위·업무 후보를 비교할 때 선택을 바꿀 외부 사실이 있으면 [결정 근거 수집과 표시](../../research/knowledge-harvest/GUIDE.md#결정-소유-단계의-수집-요청과-근거-표시)의 절차를 적용한다. 유사 서비스 정책은 가능한 행동과 결과를 비교하는 자료다. 사용자 정책과 범위 결정의 출처는 실제 요청 또는 답변으로 기록한다.

## Shared interview protocol

사용자 질문을 반환하기 전에 [stage 인터뷰 절차](../grill-with-docs/GUIDE.md#stage-hosted-invocation)를 일괄 질문 모드로 적용한다. 이 stage의 점검 항목과 정본 문서, 결정 범위를 입력으로 사용한다.

## Process

1. Use the active workspace as cwd. Run `node .harness/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json`; on failure return `blocked` with the result. Resolve the artifact paths with `node .harness/scripts/harness-spec-path.mjs <workspace_root> stakeholder-analysis.md` and the same command for `requirements.md`. Use those exact paths to check, read or write either file. Scope discovery under `docs/specs/` to existing `requirements.md` candidates for the skip decision.
2. On resume, read the previous result, the existing `stakeholder-analysis.md`, `requirements.md` and the actual answers. Continue at step 10 when answers exist, otherwise at the first step whose output is not recorded. Never rerun personas whose output is already recorded.
3. Skip decision. Skip only when all hold: the request changes behavior inside one use case of an existing fixed `requirements.md`, adds no actor or authority, and conflicts with no existing business rule. When in doubt, run. For a skip, write only `stakeholder-analysis.md` with `판정: 생략`, the reason and the evidence paths, create no `requirements.md`, then return `completed/OK`. The later requirements stages then record the skip without writing and the tactical design stages run as before.
4. Select personas: both default lenses always. The requester is always a participant (`REQUESTER`, 구분 `요청자`, 실행 `요청 원문`) and is never run as a persona. Add a registered `person` card only when its goals or pain points touch a phrase of the request; record the phrase as the selection reason. A `constraint-source` card is not run; pass its constraints to every persona as context and list it as a participant. Run at most 3 personas. When more cards qualify, keep the ones whose goals touch the request most directly and record the rest, and any malformed card with its problem message, as not selected with the reason.
5. Round 1. Run `node .harness/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill stakeholder-persona` and use the returned model and reasoning effort; if it fails, return `blocked` / `MODEL_BINDING_UNAVAILABLE`. Start one fresh native `stakeholder_persona` subagent per persona in parallel (Codex: `spawn_agent` with `fork_turns: "none"`; Claude Code: `Agent` with `subagent_type: stakeholder_persona`). Send each only its card text, the constraint-source context and the request verbatim. Personas must not see each other's output. Wait for all of them.
6. Check every candidate:
   - `request_anchor` must be an exact substring of the request. Otherwise move it to `요청 범위 밖 관찰` with that anchor (reference only). Keep a candidate only when it raises a material decision about a plausible required slice or conflicts with another candidate. Record an optional extension with an exact anchor as `ACT` kind `선택 확장 관찰`, decision `관찰`, evidence `요청 앵커 "…"`, and no BIZ; do not place it in the unrelated-observation table or ask for adoption.
   - Drop a candidate that only restates the request's explicit scope, meaning it adds no decision beyond the request's words. It gets no `CAND` and no question; step 10 records that scope.
   - Merge candidates that state the same requirement; keep every proposer.
   - Assign `CAND-01…` in proposal order and keep the persona's wording and rationale.
7. Round 2, only when two anchored candidates on the same anchor contradict each other: give each involved persona the opposing candidate with a `CONF-nn` ID in its own subagent and ask for `keep`, `concede` or `revise`. If that subagent can no longer be continued, start a fresh one with its card, the request, its own round-1 candidates and the opposing candidate. Record the replies. Do not start a group discussion.
8. List every requested feature verbatim as `REQUESTER` / `확정` / `요청 원문`. For each, enumerate only plausible independently completing actions, including necessary derived actions; do not generate blanket CRUD or optional extensions. Record each action in the requested-action table with a stable `ACT-xx`, actor, observable action, decision (`포함`, `제외`, `후속`) and evidence. The feature itself remains included even when an action is excluded or deferred. Ask about action scope only where the request leaves a material boundary open; first settle scope gaps before asking detailed rules. Do not use persona candidate count or exact request anchors as admission criteria. Optional ideas remain observations and are never labeled unrelated merely because their anchor matches a requested feature.
9. Ask and resolve the scope round first: only materially ambiguous action boundaries or whether a concrete optional action is included. Ask about the named feature/action and consequences of include/exclude/follow-up (follow-up is this workflow), with a recommendation and rationale. Do not ask policy, privilege, or detailed-rule questions in this round. Once scope is settled, ask policy and candidate/conflict questions in a later round. A named, known actor is recorded as the actor; do not force a confirmation question unless a real actor boundary remains unclear. Preserve participant provenance, conflict records, skip behavior and answers. Do not ask a top-level feature adoption question. Return `action_required` / `USER_DECISION_REQUIRED` while required scope decisions remain.
10. Create `requirements.md` with the existing template's temporary draft and a new `6.1` action coverage table. Then, with the actual answers, record each decision and its `answers.json` source in `stakeholder-analysis.md`. Complete the `requirements.md` draft only from adopted candidates, content answers, confirmed actors and the request's own scope: `업무 목적` with one line per requested feature (source `요청 원문`, `REQUESTER`), `업무 주체`, `참여한 stakeholder` including `REQUESTER`, and draft normal and exception scenarios, each with its source, plus the header's `참여한 stakeholder`. Every requested feature has at least one draft scenario from its content answer or an adopted candidate. A free-text answer that changes a candidate is recorded as the user's wording. Ask again only when an answer is ambiguous. Return `completed/OK` with both artifacts.

## Completion

- `stakeholder-analysis.md` exists at the resolved path, lists every participant and selection reason, and every anchored candidate has a user decision with its source. It holds no requirement draft.
- The requested-feature and requested-action tables list every explicitly requested feature and its traceable actions. No top-level feature is asked as adopt/reject/defer; only the requester can change explicit scope through a new instruction.
- `6.1` carries the decided action contract with evidence and is later linked to BIZ IDs by `subdomain-candidates`.
- `requirements.md` exists with `상태: draft`, and its `요구사항 초안` cites only adopted candidates (`CAND-xx`), content answers, confirmed actors and `요청 원문`, with a draft scenario for every requested feature.
- Rejected and held candidates stay in the candidate table and are not reintroduced by later stages without a new user decision.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `subdomain-candidates` continues from both documents.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 Actor·권한·규칙과 같은 결정을 다시 묻기 전에 정본을 비교한다. persona 입력 계약은 유지한다.
