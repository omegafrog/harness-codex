---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# stakeholder-analysis

## Purpose

First stage of a new feature: extract candidate requirements for the user's request from independent persona agents, and let the user adopt them one by one. Only adopted candidates enter the requirements. A candidate is a decision the request leaves open, never a restatement of the request. This stage is the facilitator: it selects personas, runs them, checks their output, finds conflicts, asks the user and records the result. The persona record stays in `stakeholder-analysis.md`; the requirements the user settled go into the living spec `requirements.md`, which this stage creates. It does not write the Product Spec; the stages from `subdomain-candidates` to `requirements-fix` continue the requirements.

## Inputs

- The user request (`scope` of the execution input), read verbatim. It is the only subject of discussion. The requester is a stakeholder (`REQUESTER`): every feature the request names is the requester's settled requirement.
- Default expert lenses: [domain expert](references/lenses/domain.md), [security expert](references/lenses/security.md).
- Registered stakeholder cards: `node .codex/scripts/harness-stakeholder.mjs list --json` in the active workspace. Cards are project-owned; never create, edit or remove them. A card under `problems` is malformed and is not run.
- `CONTEXT.md`, and an approved `docs/specs/*/product-spec.md` only for the skip decision.
- [Output template](references/output-template.md), the [requirements.md template](../requirements-fix/references/template.md) and the [persona contract](../stakeholder-persona/GUIDE.md).

## Prohibited

- Inspecting source or test code, or choosing frameworks, persistence or module structure.
- Turning actors named in the request into personas. Only registered cards become stakeholder personas.
- Treating a persona statement, or agreement among personas, as a user decision.
- Asking whether a feature the request names is in scope, or offering to reject, hold or defer it. Its content may be asked; its inclusion is settled.
- Excluding an anchored candidate for any reason other than its anchor (see step 6).
- Writing requirements the user has not adopted into the Product Spec or `CONTEXT.md`.

## Process

1. Use the active workspace as cwd. Run `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json`; on failure return `blocked` with the result. Resolve the artifact paths with `node .codex/scripts/harness-spec-path.mjs <workspace_root> stakeholder-analysis.md` and the same command for `requirements.md`. Use those exact paths to check, read or write either file. Scope discovery under `docs/specs/` to `product-spec.md` candidates for the skip decision.
2. On resume, read the previous result, the existing `stakeholder-analysis.md`, `requirements.md` and the actual answers. Continue at step 10 when answers exist, otherwise at the first step whose output is not recorded. Never rerun personas whose output is already recorded.
3. Skip decision. Skip only when all hold: the request changes behavior inside one use case of an existing approved Product Spec, adds no actor or authority, and conflicts with no existing business rule. When in doubt, run. For a skip, write only `stakeholder-analysis.md` with `판정: 생략`, the reason and the evidence paths, create no `requirements.md`, then return `completed/OK`. The later requirements stages then record the skip without writing and the tactical design stages run as before.
4. Select personas: both default lenses always. The requester is always a participant (`REQUESTER`, 구분 `요청자`, 실행 `요청 원문`) and is never run as a persona. Add a registered `person` card only when its goals or pain points touch a phrase of the request; record the phrase as the selection reason. A `constraint-source` card is not run; pass its constraints to every persona as context and list it as a participant. Run at most 3 personas. When more cards qualify, keep the ones whose goals touch the request most directly and record the rest, and any malformed card with its problem message, as not selected with the reason.
5. Round 1. Run `node .codex/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill stakeholder-persona` and use the returned model and reasoning effort; if it fails, return `blocked` / `MODEL_BINDING_UNAVAILABLE`. Start one fresh native `stakeholder_persona` subagent per persona in parallel (Codex: `spawn_agent` with `fork_turns: "none"`; Claude Code: `Agent` with `subagent_type: stakeholder_persona`). Send each only its card text, the constraint-source context and the request verbatim. Personas must not see each other's output. Wait for all of them.
6. Check every candidate:
   - `request_anchor` must be an exact substring of the request. Otherwise move it to `요청 범위 밖 관찰` with that anchor (reference only, never asked or adopted). This is the only reason a candidate leaves the candidate table: a candidate that names something the request does not, such as a concrete item of a requested feature (posts of a community), stays a candidate and is asked, with a recommendation. The runner rejects an observation whose anchor is in the request.
   - Drop a candidate that only restates the request's explicit scope, meaning it adds no decision beyond the request's words. It gets no `CAND` and no question; step 10 records that scope.
   - Merge candidates that state the same requirement; keep every proposer.
   - Assign `CAND-01…` in proposal order and keep the persona's wording and rationale.
7. Round 2, only when two anchored candidates on the same anchor contradict each other: give each involved persona the opposing candidate with a `CONF-nn` ID in its own subagent and ask for `keep`, `concede` or `revise`. If that subagent can no longer be continued, start a fresh one with its card, the request, its own round-1 candidates and the opposing candidate. Record the replies. Do not start a group discussion.
8. List the requested features: every feature or capability the request names, each quoted verbatim, as a row of the requested-feature table with 제안자 `REQUESTER`, 결정 `확정` and 출처 `요청 원문`. For each requested feature whose content (what the actors do in it and when it is done) no anchored candidate settles, prepare one content question with options drawn from the request's wording and a recommended option. Then draft the business actors (`업무 주체`) from the request yourself: actor, authority and the request phrase. Mark the source `요청 해석(에이전트 제안)`.
9. Write `stakeholder-analysis.md` from its template, and create `requirements.md` from the [requirements.md template](../requirements-fix/references/template.md) with the header and a `### 요구사항 초안` holding only the request's own scope in `업무 목적` (source `요청 원문`) and the actor draft. Then ask in one batch: one question per anchored candidate (`채택` / `기각` / `보류`), one per unresolved conflict (each side, or reject both), one content question per requested feature from step 8, and one to confirm the business actor draft. Write the questions in Korean and quote the request anchor. Start each question title with the stakeholders it came from, each by the role and ID of the participant table, for example `[제안: 도메인 전문가(LENS-DOMAIN), 결제 담당자(SH-01)]`: every proposer of a merged candidate, each side's proposers for a conflict, `[제안: 요청자(REQUESTER) · 요청 기능: <기능>]` for a content question of a requested feature, and `[제안: 요청 해석(에이전트)]` for the business actor draft. A candidate that refines a requested feature also names that feature after its proposers (`· 요청 기능: <기능>`). Give each question a recommended option and a rationale grounded in the request. When no anchored candidate and no content question exist, ask only the actor confirmation. Return `action_required` / `USER_DECISION_REQUIRED`.
10. With the actual answers, record each decision and its `answers.json` source in `stakeholder-analysis.md`. Complete the `requirements.md` draft only from adopted candidates, content answers, confirmed actors and the request's own scope: `업무 목적` with one line per requested feature (source `요청 원문`, `REQUESTER`), `업무 주체`, `참여한 stakeholder` including `REQUESTER`, and draft normal and exception scenarios, each with its source, plus the header's `참여한 stakeholder`. Every requested feature has at least one draft scenario from its content answer or an adopted candidate. A free-text answer that changes a candidate is recorded as the user's wording. Ask again only when an answer is ambiguous. Return `completed/OK` with both artifacts.

## Completion

- `stakeholder-analysis.md` exists at the resolved path, lists every participant and selection reason, and every anchored candidate has a user decision with its source. It holds no requirement draft.
- The requested-feature table lists every feature the request names as `REQUESTER` / `확정`, and the participant table lists `REQUESTER`. The runner checks both and that no observation anchored in the request was moved out of scope.
- `requirements.md` exists with `상태: draft`, and its `요구사항 초안` cites only adopted candidates (`CAND-xx`), content answers, confirmed actors and `요청 원문`, with a draft scenario for every requested feature.
- Rejected and held candidates stay in the candidate table and are not reintroduced by later stages without a new user decision.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `subdomain-candidates` continues from both documents.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .codex/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 Actor·권한·규칙과 같은 결정을 다시 묻기 전에 정본을 비교한다. persona 입력 계약은 유지한다.
