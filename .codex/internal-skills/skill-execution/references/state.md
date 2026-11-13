# 스키마와 실행 상태

`harness-native-stage.mjs start`가 stage의 정본 입력을 검증하고 그 실행의 `return.schema.json`을 생성 또는 검증한 뒤 실행을 예약한다. 서브에이전트는 schema 파일을 직접 읽고 지정된 출력 파일을 작성한다. `waiting_for_answers`이면 stage를 실행하지 않고 실제 답을 기다린다.

`harness-native-stage.mjs finish`는 출력의 JSON 형식과 schema만 먼저 검사한다. 형식 오류는 잘못된 필드 경로·규칙·기대값·실제값을 반환하며 stage를 종료하지 않는다. 호출자는 오류를 같은 서브에이전트에 돌려 수정하게 한다. 성공하면 정본 결과와 상태를 기록한다. 실행 ID, worktree, 안전한 파일 경로와 실제 승인 등 신뢰 경계는 별도로 유지한다. 실제 서브에이전트 실패는 `fail`로 기록한다. 상태 파일을 직접 수정하지 않는다.
