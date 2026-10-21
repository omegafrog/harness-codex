# E2E 실패의 재발 방지

실행 여부와 retry는 [공통 검증 정책](verification-policy.md)을 따른다. Current attempt와 remaining budget을 handoff의 기존 test evidence 요약으로 넘기며 새 schema를 만들지 않는다.

## 실행 전

caller와 runner는 `docs/verification/e2e-lessons.md`가 있으면 관련 scenario/profile의 현행 항목과 연결된 EXEC·execution.json·검사·테스트를 읽는다. lesson은 과거 명령의 실행 허가가 아니다. 현재 source/config/용어와 다르면 caller가 정정하고 runner는 추측해 우회하지 않는다. caller는 적용한 lesson ID·예방 검사·미해결 실패를 runner에게 전달한다.

각 시도에는 새 run_id와 `<session_directory>/runtime/e2e/<run_id>/`를 부여한다. artifact snapshot·로그·receipt·브라우저 증거를 시도별로 보존한다. 재시도로 이전 실패 증거를 덮어쓰지 않는다. 새 worktree/세션의 기록은 통합한 branch의 현행 lesson과 연결된 예방 검사에서 이어받는다.

## 실패 직후

runner는 시작 실패·환경 차단·제품 실패·timeout·cleanup 실패를 구분하고, cleanup 후 caller에게 실패 단계·scenario/profile·관측/기대·정확한 재현 조건·실패 receipt/로그 경로·소유 process 정리 결과를 반환한다. 원인 가설은 사실과 구분한다. runner는 제품 코드·프로필·lesson을 수정하거나 실패를 숨겨 통과시키지 않는다.

각 실패 발생은 `<run_id>:<scenario>:<phase>`처럼 고유한 ID를 가진다. 같은 원인의 다른 발생도 별도 항목으로 보존하고, 원인별 현행 lesson으로 연결한다.

caller는 즉시 plan checkpoint의 `tests.e2e_failures`에 실패를 추가한다. 원인 확인 전에 verified로 표시하지 않는다. 이 checkpoint가 없는 직접 실행에서는 동일 필드를 세션 결과/인계와 완료 state.tests에 전달한다. 다음 성공 요약에도 전체 실패 이력을 포함한다. 다음처럼 원인이 확정된 항목을 보완한다.

- `startup`, `configuration`, `infrastructure`: 실제 entrypoint/config/CI를 조사해 EXEC·execution.json의 정확한 인자·prepare/verify_config·전체 dependencies readiness를 수정한다. 일회성 수동 설정만 고치고 끝내지 않는다.
- `product`: 승인 Product 규칙과 실제 실패를 대조해 기존 owner의 제품 코드·집중 회귀 테스트를 수정한다. 기대값/계약을 버그에 맞춰 약화하지 않는다. 승인 범위 밖 변경은 기존 tracker로 연결하고 해결 전 완료하지 않는다.
- `test`: 사용자 경로·관측값·selector/wait/fixture 소유권을 근거로 테스트를 고친다. 고정 sleep 증가·assert 제거·skip·timeout만 늘리기로 통과시키지 않는다.
- `cleanup`: artifact guard/실행 recipe와 소유 프로세스 정리를 고치고 기존 파일 보존 및 새 산출물 제거를 다시 확인한다.
- `unknown` 또는 외부 장애: 가설·증거·다음 확인 조건을 미해결로 남긴다. 권한 없는 인프라 변경이나 무한 재시도는 하지 않는다.

변경 없는 동일 실패 재시도는 금지한다. 재시도는 공통 검증 정책의 시나리오당 총 2회 한도(최초 1회와 진단 근거를 반영한 재실행 최대 1회) 안에서만 가능하다. 일시 장애도 실제 health/config 변화와 알려진 상태 복구를 입증해야 한다. 두 발생 증거로 같은 원인이 확인되면 `correct`를 적용해 구조적 예방 검사가 필요한지 판단한다. 재실행 한도를 쓰고도 해결되지 않거나 원인이 불명확하면 blocker와 복구 조건을 인계한다.

## 검증 및 다음 실행에 반영

1. 가능한 가장 작은 부정 경로 검증으로 과거의 잘못된 전제를 잡는지 확인한다. 이전 실패 증거와 예방 검사의 검증 증거를 함께 보존한다.
2. 공통 검증 정책에 따라 해당 E2E 경로가 여전히 필요한 경우에만 현행 프로필로 다시 실행하고 실제 결과·부작용·cleanup을 확인한다. E2E 해결을 주장한다면 해당 경로를 실제로 재검증한다. Lower-level 변경을 마무리하기 위해 무관한 E2E를 실행하지 않는다. 그 E2E 실패를 해결했다고 주장하지 않는 경우는 verified로 바꾸지 말고 미해결 blocker로 남긴다. 실패·미실행·불완전 cleanup은 verified가 아니다.
3. 확인된 원인만 프로젝트 소유 `docs/verification/e2e-lessons.md`에 요약한다. 항목은 stable ID, 수정일, 적용 scenario/profile, 원인/재현 전제, 다음 실행 전 검사, 예방 source/profile/test 링크, 마지막 검증 결과와 source revision을 가진다. 미확정 가설·raw 로그·비밀값·task 상태 목록은 넣지 않는다. 실행 설정은 EXEC/execution.json을 링크하며 복제하지 않는다. 폐기 항목은 대체 ID/이유를 남기고 활성 규칙에서 제외한다. 관련 기능/검증 지도와 계약 영향만 함께 반영한다.
4. `tests.e2e_failures`의 항목을 아래 형식으로 보완하고 verified로 바꾼다. reviewer는 실제 수정·부정/긍정 증거·lesson을 읽어 예방 조치가 같은 실패 원인을 막는지 확인한다. 완료 검사 전 `sync-contracts`를 수행한다.

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
  "lesson_path": "docs/verification/e2e-lessons.md#<stable-id>",
  "verification_path": "runtime/e2e/<verification-run>/result.json"
}
```

evidence_path와 verification_path는 해당 workspace의 세션 상대 경로이고 lesson/prevention은 프로젝트 상대 경로다. run 간 workspace가 다르면 원래 세션 식별자와 보존 위치를 인계에 함께 기록하고 소비할 workspace 세션에 증거를 복사·검증해 상대 경로를 유지한다. 원본 실패 evidence_path는 기존 checkpoint에서 교체하지 않는다.

자동 `tests` gate와 wrapper 완료 판정은 실패 항목의 해결 상태·필수 근거 필드 형식을 검사한다. checkpoint는 ID별 실패 이력을 합치고 빈 배열/단순 성공 요약으로 삭제하지 않는다. 이 검사는 실제 파일 내용·원인의 진실성·검사 충분성이나 누락 보고된 실패를 자동 증명하지 않는다. runner 원본 결과와 launcher receipt를 caller/독립 reviewer가 대조한다.
