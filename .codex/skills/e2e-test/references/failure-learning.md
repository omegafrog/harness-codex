# E2E 실패의 재발 방지

실행 여부와 retry는 [공통 검증 정책](verification-policy.md)을 따른다. Current attempt와 remaining budget을 handoff의 기존 test evidence 요약으로 넘기며 새 schema를 만들지 않는다.

## 실행 전

caller와 runner는 `<shared_guidance_root>/docs/agents/testing-guidance.md`, 프로젝트의 `docs/verification/e2e-lessons.md`가 있으면 관련 scenario/profile의 현행 항목, 그리고 연결된 EXEC·execution.json·검사·테스트를 읽는다. lesson은 과거 명령의 실행 허가가 아니다. 현재 source/config/용어와 다르면 caller가 정정하고 runner는 추측해 우회하지 않는다. caller는 적용한 guidance/lesson ID·예방 검사·미해결 실패를 runner에게 전달한다.

각 시도에는 새 run_id와 `<session_directory>/runtime/e2e/<run_id>/`를 부여한다. artifact snapshot·로그·receipt·브라우저 증거를 시도별로 보존한다. 재시도로 이전 실패 증거를 덮어쓰지 않는다. 새 worktree/세션의 기록은 통합한 branch의 현행 lesson과 연결된 예방 검사에서 이어받는다.

## 결과와 학습 상태 분리

`tests.status`는 현재 요구된 테스트의 실제 실행 결과다. 과거 실패 이력의 `status`, `learning_route`, `learning_target`, lesson/예방 문서 유무는 테스트 통과나 workflow 완료 조건이 아니다. lifecycle과 wrapper는 학습 상태를 `e2e_learning: complete|pending`으로 별도 보고한다. 기록·원인 확인·지침 정리가 덜 끝났으면 pending으로 인계하며 테스트 결과를 바꾸지 않는다. 학습만을 위해 E2E를 추가 실행하지 않는다. 현재 테스트 실패·미실행, 실제 미해결 제품 문제와 cleanup 실패는 기존 완료 조건을 따른다.

## 실패 직후

runner는 시작 실패·환경 차단·제품 실패·timeout·cleanup 실패를 구분하고, cleanup 후 caller에게 실패 단계·scenario/profile·관측/기대·정확한 재현 조건·관련 설정값과 참조 경로·실패 receipt/로그 경로·소유 process 정리 결과를 반환한다. 서비스별 주소/포트처럼 설정이 여러 소비자에 복제된 경우, 각 소비자의 실제 값과 출처를 함께 수집한다. 원인 가설은 사실과 구분한다. runner는 제품 코드·프로필·lesson을 수정하거나 실패를 숨겨 통과시키지 않는다.

VictoriaLogs가 이미 준비된 프로젝트는 공식 MCP/LogsQL로 해당 실패의 service·시각·request/trace ID에 한정해 관련 로그를 수집한다. 초기 범위는 15분·100건이며 수치가 실제 기록된 작업만 지연 통계를 비교한다. 조회식·범위·원본 로그 시각을 증거에 남긴다. 관측성 미준비 시 session 파일 로그를 사용하고 정보 부족을 기록하며 진단만을 위해 서버를 새로 띄우지 않는다.

각 실패 발생은 `<run_id>:<scenario>:<phase>`처럼 고유한 ID를 가진다. caller는 같은 scenario/category의 과거 checkpoint와 lessons를 symptom·cause·환경 조건으로 대조해 반복 원인을 묶는다. 같은 원인의 다른 발생은 각각 보존하되 공통 lesson/guidance와 연결하고, 이미 있는 지침이 왜 막지 못했는지도 확인한다.

caller는 즉시 plan checkpoint의 `tests.e2e_failures`에 실패를 추가한다. 원인 확인 전에 verified로 표시하지 않는다. 이 checkpoint가 없는 직접 실행에서는 동일 필드를 세션 결과/인계와 완료 state.tests에 전달한다. 다음 성공 요약에도 전체 실패 이력을 포함한다. 원인 확인 뒤 각 실패의 학습 경로를 `project_execution_contract`, `project_e2e_lesson`, `shared_testing_guidance`, `not_reusable` 중 하나로 분류한다. 원인이 확인되지 않은 항목은 학습 pending으로 인계한다. 현재 필수 테스트의 실패·미실행과 실제 제품 blocker는 별도로 보고한다. 모든 E2E 실패는 이 분류를 거쳐야 한다. 다음처럼 원인이 확정된 항목을 보완한다.

- `startup`, `configuration`, `infrastructure`: 실제 entrypoint/config/CI를 조사해 EXEC·execution.json의 정확한 인자·prepare/verify_config·전체 dependencies readiness를 수정한다. 일회성 수동 설정만 고치고 끝내지 않는다.
- `product`: 승인 Product 규칙과 실제 실패를 대조해 기존 owner의 제품 코드·집중 회귀 테스트를 수정한다. 기대값/계약을 버그에 맞춰 약화하지 않는다. 승인 범위 밖 변경은 기존 tracker로 연결하고 해결 전 완료하지 않는다.
- `test`: 사용자 경로·관측값·selector/wait/fixture 소유권을 근거로 테스트를 고친다. 고정 sleep 증가·assert 제거·skip·timeout만 늘리기로 통과시키지 않는다.
- `cleanup`: artifact guard/실행 recipe와 소유 프로세스 정리를 고치고 기존 파일 보존 및 새 산출물 제거를 다시 확인한다.
- `project_execution_contract`: 실행 프로필·환경값·URL·포트·readiness 검증은 `docs/agents/execution.json`에 반영하고, 사람이 따라야 할 준비·진단·기동 절차와 근거는 `docs/agents/EXEC.md`에 반영한다. 두 문서를 함께 검토해 서로 일치시키며 한쪽만 바꾸지 않는다. 이것은 아래의 재사용 가능한 testing-guidance 반영을 대체하지 않는다.
- `project_e2e_lesson`: 프로젝트 고유 재현 조건과 예방 검사는 `docs/verification/e2e-lessons.md`에 기록한다.
- `shared_testing_guidance`: 같은 종류의 테스트 실패가 반복되거나 확정된 원인이 다른 실행에도 적용되는 프로젝트 테스트 절차를 드러내면 `testing-guidance` 스킬로 `<shared_guidance_root>/docs/agents/testing-guidance.md`도 반드시 갱신한다. 다음 실행자의 행동, 적용 범위, 이유, 실패 근거/날짜를 기록하고 사건 로그와 정확한 실행 설정은 복제하지 말고 lesson과 EXEC/profile을 링크한다. 실행 계약을 고친 경우에도 재사용 가능한 예방 절차를 이 guidance에 함께 남긴다.
- `not_reusable`: 프로젝트/실행에 한정되어 재사용할 절차가 없음을 근거와 함께 기록한다. 반복 원인을 이 경로로 분류하면 공통 예방이 불가능한 이유도 남긴다.
- `unknown` 또는 외부 장애: 가설·증거·다음 확인 조건을 미해결로 남긴다. 권한 없는 인프라 변경이나 무한 재시도는 하지 않는다.

변경 없는 동일 실패 재시도는 금지한다. 재시도는 공통 검증 정책의 시나리오당 총 2회 한도(최초 1회와 진단 근거를 반영한 재실행 최대 1회) 안에서만 가능하다. 일시 장애도 실제 health/config 변화와 알려진 상태 복구를 입증해야 한다. 두 발생 증거로 같은 원인이 확인되면 `correct`를 적용해 구조적 예방 검사가 필요한지 판단한다. 기존 lesson/guidance가 그 조건을 다루는데도 실패했다면 문구를 반복 추가하지 말고 빠지거나 잘못된 예방 검사·프로필을 수정한다. 재실행 한도를 쓰고도 현재 테스트가 실패하면 실제 실패와 복구 조건을 인계한다. 테스트가 통과했지만 과거 실패의 원인이 불명확하면 학습 pending으로 남긴다.

## 검증 및 다음 실행에 반영

1. 가능한 가장 작은 부정 경로 검증으로 과거의 잘못된 전제를 잡는지 확인한다. 이전 실패 증거와 예방 검사의 검증 증거를 함께 보존한다.
2. 공통 검증 정책에 따라 해당 E2E 경로가 여전히 필요한 경우에만 현행 프로필로 다시 실행하고 실제 결과·부작용·cleanup을 확인한다. E2E 해결을 주장한다면 해당 경로를 실제로 재검증한다. Lower-level 변경을 마무리하기 위해 무관한 E2E를 실행하지 않는다. 과거 실패의 원인/예방 효과를 검증하지 못한 경우 학습 verified로 바꾸지 말고 pending으로 남긴다. 실패·미실행·불완전 cleanup은 verified가 아니다.
3. 확인된 프로젝트 고유 원인만 `docs/verification/e2e-lessons.md`에 요약한다. 항목은 stable ID, 수정일, 적용 scenario/profile, 원인/재현 전제, 다음 실행 전 검사, 예방 source/profile/test 링크, 마지막 검증 결과와 source revision을 가진다. 미확정 가설·raw 로그·비밀값·task 상태 목록은 넣지 않는다. 실행 설정은 EXEC/execution.json을 링크하며 복제하지 않는다. 폐기 항목은 대체 ID/이유를 남기고 활성 규칙에서 제외한다. 관련 기능/검증 지도와 계약 영향만 함께 반영한다.
4. `shared_testing_guidance`로 분류한 경우 원본 프로젝트의 `<shared_guidance_root>/docs/agents/testing-guidance.md`를 `testing-guidance` 스킬로 갱신하고 공통 Git directory를 확인한다. lesson과 실행 계약을 링크한다. 재사용할 교훈이 없으면 `not_reusable`과 판단 근거만 기록하며 대상 파일을 요구하지 않는다. 학습 경로 확인이나 지침 갱신이 미완료여도 실제 테스트 결과와 workflow 완료 판정은 바꾸지 않는다.
5. 학습을 실제로 검증한 경우에만 `tests.e2e_failures`의 항목을 아래 형식으로 보완하고 학습 상태를 verified로 바꾼다. reviewer는 실제 수정·부정/긍정 증거·lesson·분류한 학습 대상의 반영을 읽어 예방 조치가 같은 실패 원인을 막는지 확인한다. 완료 검사 전 `sync-contracts`를 수행한다.

```json
{
  "id": "E2E-<stable-id>",
  "scenario": "<requirement/use-case ID>",
  "profile_id": "<execution profile ID>",
  "category": "configuration",
  "status": "verified",
  "evidence_path": "runtime/e2e/<failed-run>/failure.json",
  "cause": "<확인된 원인>",
  "prevention_paths": ["docs/agents/execution.json", "<회귀 검사 source>"],
  "learning_route": "project_execution_contract",
  "learning_target": "docs/agents/execution.json",
  "lesson_path": "docs/verification/e2e-lessons.md#<stable-id>",
  "verification_path": "runtime/e2e/<verification-run>/result.json"
}
```

evidence_path와 verification_path는 해당 workspace의 세션 상대 경로이고 lesson/prevention/learning_target은 프로젝트 상대 경로다. `learning_route`는 주된 학습 대상이다. 반복되거나 재사용할 테스트 절차가 확인되면 실행 계약도 함께 갱신했더라도 `shared_testing_guidance`를 주 경로로 삼고 `learning_target`을 공용 testing-guidance로 둔다. `prevention_paths`에는 함께 갱신한 모든 정본(EXEC, execution profile, lesson, 구조적 검사 포함)을 기록한다. run 간 workspace가 다르면 원래 세션 식별자와 보존 위치를 인계에 함께 기록하고 소비할 workspace 세션에 증거를 복사·검증해 상대 경로를 유지한다. 원본 실패 evidence_path는 기존 checkpoint에서 교체하지 않는다.

자동 `tests` gate와 wrapper 완료 판정은 현재 테스트 결과를 사용한다. `e2eLearningComplete`는 별도 학습 상태를 산출하며 완료를 차단하지 않는다. checkpoint는 ID별 실패 이력을 합치고 빈 배열/단순 성공 요약으로 삭제하지 않는다. 학습 상태 검사는 기록 형식만 확인하며 실제 원인·예방 효과·미보고 실패는 caller/reviewer가 증거와 대조한다.
