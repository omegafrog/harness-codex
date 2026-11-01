# 초기 setup과 기준 commit


1. 대상 Git root와 현재 branch를 확인하고 `git status --short --untracked-files=all`과 staged 경로를 session에 기록한다. 기존 변경과 미추적 파일은 사용자 소유로 보존한다. `.codex/harness-lock.json`과 `.codex/scripts/harness-setup.mjs`가 있으면 [설정 선택](native-choices.md)의 프로젝트 로컬 setup CLI를 실행한다. 설치된 자산이 없으면 사용 가능한 `harness-codex install --project <절대 경로>`로 설치하고, 설치 CLI가 없으면 사유를 보고한다.
2. 설정 선택과 필수 파일 준비를 마친 뒤 프로젝트에서 `node .codex/scripts/harness-doctor.mjs --project <repository-root>`로 설치된 Doctor를 실행한다. `configured`는 설정 선택 완료이며 준비·커밋 완료가 아니다.
3. 설치 전 상태와 실제 생성·수정 목록을 대조해 이번 setup이 만든 프로젝트 소유 준비 파일만 정확한 경로별로 식별한다. `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/agents/EXEC.md`, `docs/agents/execution.json`, guidance, `docs/contracts/**`, 필요한 `.gitignore` 등 실제 이번 setup이 변경한 파일이 대상이다. `.codex/`, `.agents/`, `.harness/`, 세션 출력과 설치 전 이미 변경됐거나 미추적이던 사용자 파일은 포함하지 않는다. 사용자가 이전 setup 산출물의 커밋을 명시적으로 요청한 경우에만 실제 해당 경로와 내용을 확인해 포함할 수 있다. 기존 변경과 겹치거나 소유권이 불명확하면 해당 경로를 자동 커밋하지 말고 이유를 보고한다.
4. Git root에서 `git add -- <식별한 경로들>` 후 `git commit --only -m "chore: initialize harness setup" -- <동일 경로들>`로 준비 파일만 커밋한다. 첫 커밋 이전의 저장소에서 setup 외의 미커밋 제품 파일이 있으면 보존하고 중단한다. Git identity, hook 또는 commit 오류는 그대로 보고한다. GitHub tracker의 origin에 branch가 없으면 이 기준 commit을 현재 branch로 push한다.
5. 커밋에 포함된 경로와 `git status --short --untracked-files=all`을 확인한다. 준비 파일이 기준 commit에 포함되고 다른 변경도 없을 때 새 workflow worktree를 시작한다. 기존 사용자 변경이 남으면 보존하고 clean workspace가 필요한 이유를 보고한다.
