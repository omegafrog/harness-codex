# Stage 입력과 출력

각 stage의 native 서브에이전트 실행은 [실행 지침](../../.codex/skills/orchestrator/references/dispatch.md)을 따른다. `harness-native-stage.mjs launch`는 stage 입력을 만들고 실행을 예약해 agent profile, GUIDE, 입력과 출력 schema 경로를 반환한다(`harness-prepare-input.mjs`와 `start`를 따로 실행해도 같다). 기본 출력은 다음 단계에 필요한 값만 담은 compact JSON이고 오류는 `why`와 `next`를 가진다. 에이전트는 해당 파일을 읽어 실행하고 출력 schema에 맞는 결과를 작성한다. `finish`는 형식과 실행 경계를 검증하고 상태를 기록한다.
