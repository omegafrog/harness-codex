# Stage 입력과 출력

각 stage의 native 서브에이전트 실행은 [실행 지침](../../.codex/internal-skills/skill-execution/references/dispatch.md)을 따른다. 준비기는 stage 입력을 만들고 `harness-native-stage.mjs start`는 agent profile, GUIDE, 입력과 출력 schema 경로를 반환한다. 에이전트는 해당 파일을 읽어 실행하고 출력 schema에 맞는 결과를 작성한다. `finish`는 형식과 실행 경계를 검증하고 상태를 기록한다.
