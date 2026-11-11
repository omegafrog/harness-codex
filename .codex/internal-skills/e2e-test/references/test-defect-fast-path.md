# 테스트 코드 결함 빠른 경로

최종 E2E가 실패했을 때 orchestrator가 실패 증거를 직접 읽고 **테스트 코드 자체의 결함**이라고 확정하면 사용자 결정을 기다리지 않고 이 경로로 고치고 다시 실행한다. 그 밖의 실패는 기존대로 증거와 제안 조치를 보여 주고 사용자 결정을 받는다. Spec 수정은 이 경로의 대상이 아니다. 구현이 `SPEC_REVISION_REQUIRED`를 반환할 때만 `spec-me`로 간다.

## 적용 조건

아래를 모두 만족할 때만 적용한다. 하나라도 불확실하면 사용자에게 묻는다.

1. 실패한 시나리오마다 `failure.json`의 `observation`과 로그가 **앱이 Spec대로 동작했음**을 보인다. 예: 기대한 결과가 화면에 있는데 선택자가 요소 둘을 잡아 strict mode로 실패, 대기 조건이 앱의 정상 응답 시간보다 짧음, locator 이름 오타.
2. 고칠 파일이 프로필의 테스트 디렉터리(예: `e2e/`)와 그 테스트 설정뿐이다. 제품 코드, Spec, 프로필, `docs/agents/EXEC.md`, 서버·DB 설정은 바꾸지 않는다.
3. 수정이 단언을 약하게 만들지 않는다. 단언 삭제, 기대값 완화, `skip`·`fixme`·재시도 횟수 증가, timeout을 늘려 실패를 가리는 수정은 허용하지 않는다. 같은 기대를 더 정확한 선택자·대기로 다시 쓰는 수정만 허용한다.
4. 같은 시나리오의 첫 실행 뒤 이 경로를 쓴 횟수가 3회 미만이다. 3회째에도 실패하면 사용자에게 묻는다.

## 절차

1. orchestrator는 사용자에게 보내는 다음 응답에 분류와 근거를 적는다: 실패 시나리오, 앱이 정상이었다는 증거 인용, 고칠 파일, 허용 조건 충족 여부. 사용자 답을 기다리지 않는다.
2. orchestrator는 테스트 파일이든 제품 파일이든 직접 수정하지 않는다(메인 세션의 쓰기 도구는 PreToolUse hook이 거부한다). 구현 stage가 수정 없이 끝났더라도 orchestrator가 대신 고치지 않고 같은 `implement-wrapper`를 `--feedback`으로 다시 시작한다. 해당 e2e plan을 `implement-wrapper`로 다시 열어 `--feedback`에 실패 증거 경로, 고칠 범위(테스트 파일만), 위 3번 금지 사항을 그대로 전달한다. 구현자가 제품 코드나 Spec을 바꿔야 한다고 판단하면 수정하지 않고 `IMPLEMENTATION_REVISION_REQUIRED` 또는 `SPEC_REVISION_REQUIRED`로 돌려보낸다.
3. 수정 commit은 기존 독립 Standards·Spec 리뷰와 완료 gate를 통과해야 한다. 리뷰는 테스트 diff가 단언을 약화하지 않았는지 확인한다.
4. 이미 승인된 시나리오·대상 commit 갱신·실행 조건이 같으면 실행 승인을 다시 묻지 않는다. orchestrator는 새 대상 commit과 승인 근거(이전 승인 참조)를 runner에 넘긴다. 시나리오나 실행 조건이 바뀌었으면 기존대로 승인을 받는다.
5. 재실행 결과도 같은 방식으로 분류한다. 앱 결함이나 Spec 결함이 드러나면 이 경로를 끝내고 사용자에게 증거와 제안 조치를 보여 준다.

## 기록

`tests.e2e_failures`의 해당 항목에 `classification: test_defect`, 근거 인용, 수정 commit, 사용 횟수를 적는다. 원인이 확정되었으므로 `learning_route`는 [실패 재발 방지](failure-learning.md)에 따라 분류한다.
