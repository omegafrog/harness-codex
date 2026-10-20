# 명세·계획·구현 추적 강화 구현 계획

- 작업: `harness-df0`
- 작성일: 2026-10-20
- 사용자 승인: 선택지 3 적용. 설계·계획은 주 agent, 구현과 수정은 `gpt-6-luna`, reasoning `low`.
- 작업 공간: `/home/jiwoo/workspace/harness`
- 범위: Harness 원본과 설치되는 runtime·skills. 소비 프로젝트의 기존 이슈와 코드는 변경하지 않는다.

## 문제와 완료 조건

기존 `spec_reviews`는 Spec을 검토하지만 분할 계획의 완전성을 검토하지 않는다. `plans_index`는 인덱스 존재를 검사하고, 구현 dispatch는 workspace·tracker·readiness만 검사한다. 명세 링크만 있는 계획도 진행할 수 있다.

이번 변경은 요구사항 → 계획 수용 조건 → 검증 사례 → 구현 위치 → 실제 검증 결과를 연결한다. 요구사항 누락, 독립 계획 리뷰 누락, 검토 후 입력 변경, 구현 증거 누락은 계획 완료·구현 시작·구현 완료의 실제 실행 경로에서 차단한다.

자동 검사는 구조·참조·현재성만 증명한다. 규칙이 올바르게 분해됐는지, 다른 규칙과 결합했을 때 의도에 맞는지는 fresh reviewer가 원문을 읽어 반례로 판단한다.

## 데이터와 저장 위치

새 DB나 tracker 상태를 추가하지 않는다. `docs/plans/<plan-set-id>/traceability.json`을 버전 관리하는 연결 원장으로 사용한다. 실행 receipt와 reviewer 원본 결과는 기존 session directory에 저장한다.

`schema_version: 1`, `plan_set_id`, `ticket_id`, `spec_paths`, `requirements`, `plans`, `review`를 명시한다. 구현 완료 근거는 별도 `implementation` 항목으로 두어 이를 기록하는 것만으로 계획 리뷰가 stale이 되지 않게 한다.

- `spec_paths`: Product·Architecture 필수 경로, request·runtime decisions·관련 다이어그램·현행 계약 등 검토 입력. 프로젝트 내부 상대 경로만 허용한다.
- `requirements`: 각 항목은 `id`, `source_path`, `source_anchor`, `statement`, `owner`, `plan_ids`와 명시적 `disposition`을 갖는다. `covered` 또는 `excluded`이며 제외는 사유와 reviewer의 검토를 필요로 한다. 설계상 불변식과 ID 없는 중요 결정은 출처를 연결한 안정 ID를 부여한다.
- `plans`: 실제 plan ID, 관련 requirement IDs, 수용 조건, 금지 동작/반례, 검증 사례, 실제 canonical plan 내용을 확인할 참조. GitHub에서는 기존 tracker read API로 읽은 본문을, local-markdown에서는 실제 파일을 사용한다. 수동 요약본만 해시하지 않는다.
- 여러 계획에 걸친 요구사항은 통합 검증 owner plan과 시나리오를 명시한다. 연결한 plan ID가 실제 계획 집합에 없거나 담당 계획이 없으면 차단한다.
- `review`: reviewer ID, 전체 작성자 ID 목록, `fork_turns: none`, verdict, findings, 입력별 SHA-256. 계획 작성자와 reviewer가 같거나 major/blocker가 남으면 차단한다.
- `implementation`: plan별 requirement ID → 구현 파일/심볼 → 테스트/검증 경로 → 실행 receipt의 연결. 검증하지 않은 항목을 pass로 생성하지 않는다.

서로 다른 문서에서 같은 `BR-01`을 사용할 수 있으므로 내부 요구사항 키는 source path와 ID 조합으로 구분한다. ID 중복·알 수 없는 ID·빈 문자열·경로 탈출·symlink·누락 파일은 오류다.

## 구체적인 구현 방법

### 1. 기존 workflow 모듈에 추적 검사 추가

`src/workflow/plan-traceability.mjs` 하나에 다음 공개 함수를 둔다. 독립 rule engine은 만들지 않는다.

1. `snapshotPlanTraceability(...)`: 실제 Spec 입력, 계획 내용, 요구사항 연결의 정규화된 입력을 해시한다. `src/workflow/spec-review.mjs`의 안전한 경로/해시 및 fresh reviewer 판정 방식을 재사용하거나 작은 공통 helper로 추출한다.
2. `inspectPlanTraceability({root, planSetId, phase, planId, ...})`: `planning`, `dispatch`, `completion` 단계별 검사. 기존 lifecycle 형태 `{status, reason, violations, details}`를 반환한다.
3. `inspectTraceabilityImpact(...)`: 이전 snapshot과 현행 파일·계획 비교로 추가/수정/삭제된 요구사항과 영향을 받는 plan IDs를 반환한다. 분석되지 않은 Spec 변경은 전체 관련 계획의 재검토를 요구한다.

Product/Architecture 문서의 BR/UC/AC/INV ID 선언을 추출하여 연결 원장과 대조한다. 단순 본문 언급을 새 선언으로 세지 않는다. ID 없는 중요 요구사항 누락은 fresh 리뷰 책임임을 명시한다. 원장에 빠진 선언 ID, 잘못된 출처, 빈 coverage는 실패한다.

Spec 전체 해시가 달라지면 의미가 같은 편집이어도 reviewer 확인 전에는 진행하지 않는다. 원장/새 해시를 자동 갱신하여 기존 pass를 되살리는 `seal` 기능은 만들지 않는다.

계획 리뷰 snapshot에는 구현 예정 source 파일의 내용 전체를 포함하지 않는다. 정상 구현 수정으로 계획 승인이 무효화되지 않게 하고, 구현 완료 증거만 실제 source·검증 파일·receipt의 현재 내용을 검사한다.

### 2. 실행 경로에 연결

- `src/gates/lifecycle.mjs`: `plan_traceability` 검사를 등록한다. 통과 여부 boolean을 신뢰하지 않고 실제 파일·tracker를 다시 읽는다.
- `.codex/workflows/to-ticket.yaml`: `before_complete`에 계획 추적 검사 추가. 아직 계획이 없는 to-ticket 진입 단계에는 요구하지 않는다.
- `src/workflow/completion.mjs`: to-ticket은 planning, implement/implement-wrapper는 completion 검사를 필수로 추가한다. 호출자가 hooks/state를 생략해도 새 workflow의 검사 자체가 빠지지 않게 한다.
- `src/wrapper/dispatch.mjs`: 기존 workspace preflight 뒤, `spawnImplement` 전 필수 dispatch 검사. 이미 필수인 `planSetId`를 사용한다. `executeImplementPlan`의 성공·tracker Done·종속 계획 해제 전에도 completion 검사 결과를 확인한다.
- `src/wrapper/reconciliation.mjs` 및 checkpoint: 기존 근거 보존 흐름에 필요한 연결만 추가한다. checkpoint의 오래된 pass가 현행 source 검사를 대체하지 않게 한다.
- `src/tracker/helpers.mjs` 등 기존 read port 사용: GitHub canonical 본문이 변경되면 old review를 거부한다. 원격 조회 실패를 로컬 snapshot pass로 대체하지 않는다. 테스트는 주입한 tracker port로 결정적으로 검증한다.
- 기존 standalone parser API는 유지할 수 있으나 실제 workflow 경로에서는 traceability 파일이 없다는 이유로 legacy pass하지 않는다. 기존 프로젝트는 “추적 원장 생성·fresh 리뷰 필요”라는 구체 blocker로 안내한다.

### 3. CLI와 설치

`.codex/scripts/harness-plan-traceability.mjs`를 기존 spec-review CLI의 source/installed runtime 로딩 방식으로 작성한다.

- `snapshot --root DIR --plan-set ID`: reviewer가 확인할 현재 입력을 반환한다.
- `check --root DIR --plan-set ID --phase planning|dispatch|completion [--plan ID]`: 실제 gate와 동일 함수를 호출하고 실패 시 nonzero.
- `impact --root DIR --plan-set ID`: 변경 경로·요구사항·영향 계획·필요 재검증을 출력한다. tracker 상태나 승인 기록은 변경하지 않는다.

installer가 새 runtime/script/skill을 포함하는지 기존 자산 수집 코드를 확인한다. 추가 의존성 없이 Node 표준 라이브러리를 사용한다.

### 4. agent와 skill 계약

- `to-ticket`: 전체 Spec/결정/다이어그램을 읽고 규칙 inventory 및 coverage 작성 → 전체 split plan 작성 → fresh 독립 subagent 리뷰 → 지적 수정 → 새 reviewer 재검토 → planning gate → 인계 순서로 변경한다.
- 새 `plan-review` skill과 provider adapter agent 설정: 작성 맥락을 상속하지 않는 reviewer가 원문·전체 계획·coverage를 직접 읽는다. “모든 계획 수용 조건을 충족해도 원래 규칙을 위반하는 구현이 가능한가”를 검토한다. 누락, 모호한 재개, 단계 간 소유권, 부정 사례와 통합 시나리오를 확인한다.
- `spec-me`/Product·Architecture skills: 승인 후 명세 변경 시 기존 traceability의 impact 검사와 관련 계획/검증 재검토가 필요하다고 안내한다.
- `implement`/wrapper/implementation agent: dispatch 전에 관련 규칙 원문과 traceability를 읽고, 완료 시 requirement별 구현 위치·검증 증거를 기록한다.
- `code-review`/spec reviewer: 계획뿐 아니라 현행 규칙 전체와 구현을 대조한다. 계획 자체의 누락도 major finding이다.
- 공통 규칙과 JSON 형식은 provider 중립적으로 작성한다. 특정 provider의 spawn API/모델 설정은 adapter 지침에 둔다.

### 5. 최소 회귀 검증

`tests/plan_traceability.test.mjs` 및 기존 dispatch/completion integration fixture를 갱신한다. 새 비즈니스 gate를 통과하도록 fixture에 유효한 계약을 넣으며, production gate를 test bypass로 약화하지 않는다.

필수 사례:

1. 올바른 규칙→계획→독립 리뷰는 planning/dispatch pass.
2. 그룹 차례 종료 규칙의 coverage 삭제, 선언 ID 추가/삭제, dangling plan/검증 owner는 차단.
3. 같은 작성자 리뷰, fork된 reviewer, unresolved major, 리뷰 없는 원장은 차단.
4. Spec/결정/diagram/실제 GitHub 본문 변경은 stale. impact에는 관련 계획을 표시.
5. 실행할 plan의 근거 누락 시 실제 spawn이 호출되지 않는다.
6. 구현 파일·검증 파일·receipt 누락/실패/다른 요구사항 증거 재사용은 completion 차단. 올바른 실행 evidence는 pass.
7. 완료 검사를 호출자가 생략하려 해도 tracker Done/종속 plan release가 일어나지 않는다.
8. 정상 source 구현 변경은 계획 review를 무효화하지 않지만 과거 구현 evidence는 무효화한다.
9. 경로 탈출·symlink·잘못된 JSON·중복 ID는 오류로 반환한다.
10. 설치된 CLI에서도 snapshot/check가 동작하고 missing contract를 차단한다.

`docs/agents/execution.json`에 focused profile을 추가하고 `docs/agents/EXEC.md`에 정확한 실행 방법을 적는다. 테스트·로그·임시 fixture는 session directory 아래에서만 생성한다. 실제 서버 E2E나 모델 호출은 이 데이터/실행 gate 회귀 테스트의 필수 전제가 아니다.

## 문서·검증 마감

`docs/architecture/enforcement.md`에 자동 검사와 의미 리뷰의 보장 범위를 구분한다. Product·Architecture 통합 계약과 delivery sequence를 실제 구현에 맞추고, 필요한 도식을 렌더한 뒤 manifest를 seal/check한다. 새 source/skill의 Git 추적 누락을 확인한다.

구현 agent는 변경 파일, 실제 검사 결과, 미해결 항목을 보고한다. 주 agent는 구현 계획과 diff·실행 증거를 대조하고 수정이 필요하면 같은 `gpt-6-luna low`에게 맡긴다. 이번 요청만으로 commit/push를 실행하지 않는다.
