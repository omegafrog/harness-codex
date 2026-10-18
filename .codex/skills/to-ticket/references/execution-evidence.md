# 기능 추적과 정량 검증 계약

계획은 검증할 결과를 정의하고 구현은 같은 기준의 관측 결과를 제출한다. 로그 개수, 클래스 수, 테스트 개수로 완료를 판단하지 않는다. 기존 ID·테스트·관측 도구와 checkpoint journal을 재사용한다.

## 계획 시

각 slice의 기존 `수용 기준`에 `UC/BR/INV 또는 기존 requirement ID → Context/모델 owner → 실행 진입점 → 기대 결과 → 검증 명령`을 기록한다. 전역 ID 체계나 별도 task board를 새로 만들지 않는다. `테스트 계약`에는 아래 항목을 필요한 만큼 기록한다. GitHub 구조 입력에서는 기존 `acceptance_criteria`, `test_contract.unit_policy`, `test_contract.ui_entity_e2e` 문자열에 포함해 canonical renderer가 보존하게 한다.

- 변경된 rule과 enforcement method/function, 허용·금지 의존성, 기존 검사 또는 도메인 테스트.
- 현행/폐기 용어와 호환 식별자 예외. 기존 구현 대체라면 old → new 경로, 이전할 소비자, 삭제할 구현/export/config/fixture와 잔존 검색·동작 검증. 제거할 수 없는 호환 경로는 소비자 근거·제거 조건·후속 tracker 참조를 포함한다.
- 제거하기로 승인된 파일/디렉터리는 `retirement.removed_paths`의 저장소 상대 경로 목록으로 runtime handoff에 전달한다. canonical tracker에는 기존 acceptance/test-contract 문자열에 목록을 보존하고 새로운 structured-source key를 추가하지 않는다. 제거 대상이 없으면 빈 목록과 근거 `reason`을 전달한다. 이 검사는 새 후보가 임의로 정한 목록이 아니라 승인된 계획의 제거 목록을 사용한다.
- 성능·용량·자원 사용·장기 실행 안정성이 관련되면 연결된 System Target, 실제 사용자 경로, 대표 workload 크기/분포/동시성, 지표·단위, 측정 명령, 환경, baseline commit, 허용 회귀와 성공 조건.
- baseline은 구현 전에 관측한다. 수치가 없으면 `미측정`과 수집 방법을 쓰며 예상치를 측정값으로 쓰지 않는다. 새 기능은 이전 동등 경로나 명시적 목표와 비교하고, 비교 불가능하면 전후 개선율을 계산하지 않는다.
- 성능과 무관한 작은 변경은 `해당 없음 — 근거`로 충분하다. 모든 slice에 benchmark나 runtime logging을 추가하지 않는다.
- 여러 slice가 같은 경로를 바꾸면 같은 workload와 지표를 유지하고 대표 checkpoint에서 누적 결과를 비교한다. 기준을 바꾸면 이전 결과와 비동등임을 기록한다.

## 구현과 handoff 시

기존 `PlanCheckpointStore`의 `tests` object에 아래 의미의 `traceability`와 `measurements`를 보존한다. `write()`/replay를 사용하고 `checkpoint.md`를 직접 수정하지 않는다. `events.jsonl`은 기존 `checkpoint_updated` event로 기록하며 별도 journal 형식은 만들지 않는다.

```json
{
  "status": "passed",
  "traceability": [
    {"requirement_id": "BR-1", "owner": "Context/Model.operation", "code_ref": "src/path:line", "command": "project command", "result": "passed", "evidence": "local artifact path", "commit": "commit SHA"}
  ],
  "measurements": [
    {"target_id": "existing target ID", "metric": "latency", "unit": "ms", "baseline_commit": "SHA", "current_commit": "SHA", "workload": "size/distribution/concurrency", "command": "project command", "environment": "runtime/config", "before": [42, 41, 44, 40, 43], "after": [35, 34, 36, 35, 34], "errors": 0, "work_completed": 100, "evidence": "local artifact path", "verdict": "improved"}
  ]
}
```

예시는 실제 결과로 치환한다. 필드 이름이 새로운 runtime schema를 의미하지 않는다. 기존 `tests` payload를 활용한 소비자 계약이다. 실패·미실행·환경 차단을 passed로 쓰지 않는다. 재시도와 기각한 변경도 before/after, 이유와 함께 보존한다. 비교값의 신뢰도는 `evaluate-harness/references/measurement.md`를 따른다.

기능 간 상관 추적이 필요하면 기존 request/operation ID를 사용한다. 필요한 경계의 시작·결과·duration·실패만 구조화 로그/기존 tracing에 연결하고, 개인정보·토큰·업무 payload 전체를 로그로 남기지 않는다. 프로젝트 observability가 충분하면 새 logger나 tracing framework를 추가하지 않는다.

로컬 checkpoint와 raw log는 외부에 게시하지 않는다. 완료 보고/PR에는 requirement별 확인 결과, 재현 명령, commit, 승인된 비민감 증거 링크와 핵심 측정 요약만 담는다. gitignored 로컬 파일 경로만으로 후속 세션의 재현성을 충족했다고 하지 않는다. 설계 모델의 실제 코드 연결과 검증 기능 지도도 영향받는 항목만 갱신한다.

## 실행 전제 변경

실행 인자·환경·설정 원본/생성·인프라가 바뀌는 plan은 대상 execution.json profile ID와 EXEC 갱신을 범위에 포함한다. 실제 entrypoint·config loader·infra/CI를 확인하여 필수 argv·required_env·prepare/verify_config·dependency readiness를 명시한다. 누락/불일치 시 main이 시작되지 않는 수용 조건을 둔다. 계획된 검증도 harness-exec profile을 사용한다.
