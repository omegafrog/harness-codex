# 리뷰 수정과 결정 요청 조정

독립 reviewer를 호출하는 orchestrator가 적용하는 공통 절차다. reviewer는 입력을 읽고 판정·근거·findings를 반환한다. reviewer 생성·결과 수집·수정 지시·사용자 결정 요청·재검토·완료 gate는 아래 소유 orchestrator가 관리한다.

| 리뷰 대상 | 소유 orchestrator | 리뷰 절차 |
|---|---|---|
| Architecture Spec | spec-me workflow의 최상위 orchestrator | `spec-review` |
| split plan 집합 | to-ticket workflow의 최상위 orchestrator | `plan-review` |
| 구현 코드 | `code-review`를 호출한 구현 workflow | `code-review` |

각 orchestrator는 자신의 리뷰 대상에 해당하는 기록과 CLI만 사용한다. 다른 대상의 변경이 필요하면 해당 소유 workflow에 인계하고 현재 실행을 보류한다. 각 리뷰의 독립성·순서·한도·승인 gate는 해당 소유 절차를 따른다.

1. 현재 실행 중인 관련 reviewer 결과를 모두 수집·기록한 뒤 수정 범위를 정한다. 결과가 아직 없으면 해당 scope를 pending으로 표시하고, 종료된 reviewer의 누락은 해당 재시도 절차로 처리한다.
2. 원본 finding을 축별로 보존하고 같은 원인의 지적을 연결해 수정표를 대화 또는 기존 checkpoint 근거로 제시한다. `지적 ID·근거 / 원인 / 영향 Spec·plan·diagram·코드·테스트 / 수정 또는 반박 근거 / 필요한 사용자 결정`을 함께 적는다. 새 guard·예약·상태가 다른 정상·경쟁·복구 경로에 만드는 영향을 같은 수정 범위에 포함한다.
3. 사용자 결정이 필요하면 아래 통합 조회로 관련 축의 기록과 한도를 함께 읽는다. 실제 사용자에게는 해결할 쟁점과 영향을 받는 scope별 현재/남은 한도·필요 결정·재개 조건을 한 번에 제시한다. 이미 관찰한 다른 한도 문제도 같은 요청에 포함한다. 추가 검토로 새 쟁점이 발견되면 그 근거를 별도로 설명한다.
4. 사용자가 승인한 결정의 원문·범위를 보존하고, 해당하는 소유 CLI의 resolve를 각 scope에 적용한다. 기록된 pass는 현재 snapshot gate로 재확인한다. 아직 실행 중인 검토는 기다리며, 사용자의 범위 결정과 기술적 한도 재개 승인을 구분한다.
5. 확정 답변과 수정표에 해당하는 문서·정본 plan·원장·diagram·코드·검증을 함께 반영하고 현재성을 확인한 뒤 새 admission/commit으로 재검토한다. 활성 검토가 읽는 입력을 수정해야 하면 해당 reviewer를 종료하고 abort를 기록한 뒤 새 snapshot으로 시작한다. 검토 중 snapshot을 유지하는 것은 caller의 편집 책임이며 runtime은 변경을 탐지해 stale 결과·repair 예약·완료를 차단한다.

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
