---
name: setup
description: Initialize a repository for the harness workflow. Use when setting up a repository for the first time, when CONTEXT.md or CONTEXT-MAP.md is missing, when agent model tiers have not been chosen, or when tracker configuration has not been chosen.
model_tier: execution
---

# Harness Setup

메인 세션에서 저장소 초기 설정을 조율한다. 설정 적용과 준비 파일 생성은 `harness-setup.mjs`가 담당한다. 설정 결과와 준비 완료를 구분한다.

1. 프로젝트의 `.codex/harness-lock.json`과 `.codex/scripts/harness-setup.mjs`가 있으면 설치된 Harness로 판단하고 [설정 선택](references/native-choices.md)에 따라 프로젝트의 `node .codex/scripts/harness-setup.mjs`를 직접 실행한다. 기존 설정이 있으면 CLI가 재사용 또는 재설정을 묻는다. CLI는 아직 답이 없는 질문 전체를 한 번에 돌려주므로 한 화면에서 모두 묻고 답을 함께 돌려준다. 선행 답이 바뀐 `depends_on` 질문이 다시 오면 그것만 후속 배치로 묻는다. 별도 중복 질문이나 이전 실행의 답변 재사용을 하지 않는다. 설치가 필요한 경우 [초기 setup](references/initial-setup.md)을 따른다.
2. [초기 setup과 기준 commit](references/initial-setup.md)에 따라 결과를 확인하고 기준 commit을 준비한다.
3. 관측성을 선택한 경우 `victorialogs-local-setup`을 호출한다. Beads 준비와 상태 확인은 setup CLI의 완료 결과에 포함된다.
4. GitHub Project를 사용하면 보드의 group-by를 `Workflow Status`로 설정하도록 안내한다.

설치·갱신 후 정리가 필요한 경우에만 [작업공간 정리](references/workspace-cleanup.md)를 따른다. 실행·E2E 조건은 실제 구현과 검증 단계에서 결정한다.
