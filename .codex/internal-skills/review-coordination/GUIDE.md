# 리뷰 수정과 결정 요청 조정

독립 reviewer를 호출하는 orchestrator가 적용하는 공통 절차다. reviewer는 입력을 읽고 판정·근거·findings를 반환한다. reviewer 생성·결과 수집·수정 지시·사용자 결정 요청·재검토·완료 gate는 아래 소유 orchestrator가 관리한다.

| 리뷰 대상 | 소유 orchestrator | 리뷰 절차 |
|---|---|---|
| Architecture Spec | `spec-me` | `spec-review` |
| split plan 집합 | to-ticket workflow의 최상위 orchestrator | `plan-review` |
| 구현 코드 | `code-review`를 호출한 구현 workflow | `code-review` |

각 orchestrator는 자신의 리뷰 대상에 해당하는 기록과 CLI만 사용한다. 다른 대상의 변경이 필요하면 해당 소유 workflow에 인계하고 현재 실행을 보류한다. 각 리뷰의 독립성·순서·한도·승인 gate는 해당 소유 절차를 따른다.

## 구현 리뷰 근거 재확인

`code-review`가 `reason: basis_unverified`, `next_action: review-coordination`을 반환하면 수정·사용자 질문·repair 예약을 하지 않는다. `repair` 출력의 각 `basis_rechecks[].artifact_ref`를 확인한다. 생성 실패 또는 `status: blocked`면 dispatch하지 않고 blocked로 반환한다. 나머지는 비어 있는 독립 child context (`fork_turns: none`)에 이 섹션과 해당 artifact를 전달해 재확인을 맡긴다. artifact에는 검증된 review-time admission의 exact Spec·plan contents, implementation diff/commit, 현재 Spec·plan contents와 HEAD가 있다. child는 두 시점의 Spec·구현·plan을 비교해 상세 evidence를 만들고, 구조화된 result를 parent에 반환한다. historical snapshot 참조가 없거나 해시가 맞지 않으면 과거 내용을 추정하거나 새로 만들어 채우지 않는다.

child는 아래 JSON 하나를 반환한다. `source_plan_id`는 리뷰받은 plan이고 `affected_plan_id`는 영향받는 기존 plan이어야 한다. `evidence[]`는 `snapshot`이 `review_time` 또는 `current`인 캡처된 파일의 정확한 `path`와 `quote`, 그리고 비교 분석을 포함한다. 코드 근거는 `implementation.diff`, `implementation.staged_diff`, `implementation.worktree_diff`, 또는 `implementation.untracked/<repo-relative-path>`를 인용한다. supported finding에는 current implementation diff와 Spec/plan 근거가 모두 필수다. plan gap은 영향을 받는 현재 canonical plan을 인용한다. dismissed 판정에는 review-time과 current의 evidence가 모두 필수다. parent는 반환물을 session runtime JSON에 저장하고 `node .codex/scripts/harness-code-review.mjs record-basis-result --root <workspace_root> --plan <source-plan-id> --artifact <artifact_ref> --result <child-result-ref>`를 실행한다. runtime은 finding ID·route/classification 조합·source/affected plan·evidence quote를 검증하고 현재 HEAD·tracked/untracked code·plan-set snapshot이 dispatch 때와 같은지 확인한다. 검증이 실패하면 결과를 route에 사용하지 말고 blocked로 반환한다.

검증에 성공하면 `repair`를 다시 실행한다. `dismiss` 결과는 근거와 함께 implementation review evidence에 기록되고 해당 finding만 해소한다. `implementation`은 통상 repair 검증·예약으로 이어진다. `to-ticket`은 지목된 plan의 소유 workflow로, `spec-me`는 실제 Spec 결정을 소유하는 단계로 인계한다. `blocked`는 누락·불일치 근거를 보존해 멈춘다. 어떤 route도 plan/spec review나 implementation completion gate를 대신 통과시키지 않는다.

```json
{"schema_version":1,"finding_id":"<original-id>","source_plan_id":"<reviewed-plan-id>","classification":"supported_finding|plan_gap|spec_decision|unsupported_finding|insufficient_evidence","affected_plan_id":"<existing-plan-id>","route":"implementation|to-ticket|spec-me|dismiss|blocked","summary":"<compact conclusion>","evidence":[{"snapshot":"review_time|current","path":"<captured-path>","quote":"<exact captured text>","analysis":"<why this evidence supports the classification>"}]}
```

허용 route:

- 기존 plan의 요구와 구현 간 결함이면 해당 plan의 implementation으로 돌려보낸다.
- 현재 plan이 요구를 충족하지 못하면 영향받는 plan을 지정해 to-ticket으로 보낸다.
- 실제로 Spec의 결정·요구 변경이 필요하다는 근거가 있으면 spec-me로 보낸다.
- finding이 승인된 근거에 의해 뒷받침되지 않는다고 충분한 evidence로 확인되면 원본 finding을 보존한 채 evidence와 함께 dismiss한다.
- 비교를 완료할 근거가 부족하면 blocked로 반환하고 누락된 근거를 지정한다.

재확인 결과는 원래의 implementation review gate를 통과시키지 않는다. 문서·plan을 바꾼 route는 해당 소유자의 fresh review와 snapshot gate를 다시 통과해야 한다.

1. 현재 실행 중인 관련 reviewer 결과를 모두 수집·기록한 뒤 수정 범위를 정한다. 결과가 아직 없으면 해당 scope를 pending으로 표시하고, 종료된 reviewer의 누락은 해당 재시도 절차로 처리한다.
2. 원본 finding을 축별로 보존하고 같은 원인의 지적을 연결해 수정표를 대화 또는 기존 checkpoint 근거로 제시한다. `지적 ID·근거 / 원인 / 영향 Spec·plan·diagram·코드·테스트 / 수정 또는 반박 근거 / 필요한 사용자 결정`을 함께 적는다. 새 guard·예약·상태가 다른 정상·경쟁·복구 경로에 만드는 영향을 같은 수정 범위에 포함한다.
3. 사용자 결정이 필요하면 아래 통합 조회로 관련 축의 기록과 한도를 함께 읽는다. 실제 사용자에게는 해결할 쟁점과 영향을 받는 scope별 현재/남은 한도·필요 결정·재개 조건을 한 번에 제시한다. 이미 관찰한 다른 한도 문제도 같은 요청에 포함한다. 추가 검토로 새 쟁점이 발견되면 그 근거를 별도로 설명한다.
4. 사용자가 승인한 결정의 원문·범위를 보존하고, 해당하는 소유 CLI의 resolve를 각 scope에 적용한다. Spec review의 준비 abort 한도에 도달했으면 복구된 준비 조건을 `resolve --reason 'preparation recovery: <복구 내용>'`으로 기록한다. 이는 사용자 요구/범위 결정이 아니며 substantive review 회차도 초기화하지 않는다. 기록된 pass는 현재 snapshot gate로 재확인한다. 아직 실행 중인 검토는 기다리며, 사용자의 범위 결정과 기술적 한도 재개 승인을 구분한다.
5. 확정 답변과 수정표에 해당하는 문서·정본 plan·원장·diagram·코드·검증을 함께 반영하고 현재성을 확인한 뒤 새 admission/commit으로 재검토한다. 활성 검토가 읽는 입력을 수정해야 하면 해당 reviewer를 종료하고 abort를 기록한 뒤 새 snapshot으로 시작한다. Architecture Spec에서 reviewer dispatch 전에 발생한 준비 실패만 spec-me 소유 절차의 `pre-dispatch preparation: <원인>` 사유로 기록한다. reviewer dispatch 뒤의 종료와 legacy abort는 일반 substantive attempt로 계산한다. 검토 중 snapshot을 유지하는 것은 caller의 편집 책임이며 runtime은 변경을 탐지해 stale 결과·repair 예약·완료를 차단한다.

## 통합 조회 CLI

`node .codex/scripts/harness-review-status.mjs --root <workspace_root> --ticket <ticket-id> --plan-set <plan-set-id> --plan <plan-id> [--spec-root <spec-workspace>] [--reviews <session-relative implementation-review.json>]`

| 입력·출력 | 의미 |
|---|---|
| `--root` | 계획·구현을 진행하는 절대 workspace. 모든 명령의 cwd로도 사용한다. |
| `--ticket`, `--plan-set`, `--plan` | 조회할 실제 ID. 관련 항목만 지정한다. |
| `--spec-root` | Spec 리뷰가 다른 기존 workspace에서 수행됐을 때 그 위치. 같은 Git 저장소인지 확인한다. |
| `--reviews` | 현재 구현의 두 reviewer를 모은 기존 session JSON. 생략하면 예약 원장의 과거 지적만 조회한다. |
| `records[].root`, `scope`, `evidence_path` | 읽은 실제 원장 위치와 scope. 구현 budget은 원본 저장소의 원장에서 읽는다. |
| `recorded_state`, `findings`, `findings_source` | 기록 당시 상태와 지적 출처. active는 결과 대기, unreadable은 조회 실패다. 과거 repair 예약 지적은 현재 미해결 판정과 구분한다. |
| `budget.used`, `limit`, `remaining` | 현재 묶음의 사용량과 한도. 구현 예약이 없으면 한도는 null이다. pass나 유효한 resolve 뒤 새 review 묶음은 사용량 0으로 표시한다. |
| `next_admission_requires_resolution` | 다음 회차를 새로 시작할 때 필요한 한도 해제. 이미 예약한 수정의 재개나 기능 완료 판정과 구분한다. |
| `implementation_findings` | `--reviews`의 현재 입력에 대한 양쪽 지적 분류. 실제 원본 응답과 현재 commit/snapshot을 대조한다. |
| 최상위 `status` | 조회 성공 여부. Spec·계획·구현 gate의 pass를 대신하지 않는다. 일부 원장이 손상돼도 읽힌 다른 scope는 함께 반환한다. |

조회는 원장을 수정하거나 session·권한·복구 파일을 생성하지 않는다. 조회 JSON은 파생 결과이며 기존 review 원장·원본 응답·checkpoint를 정본으로 유지한다. 이 조회가 확인하지 않은 숨은 쟁점이나 미래 review pass를 사용자 승인으로 대체하지 않는다.
