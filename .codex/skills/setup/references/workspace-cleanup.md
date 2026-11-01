# 설치·갱신 후 작업공간 정리


1. 정리 전에 `git status --short`로 변경·미추적 경로를 수집하고, installer ownership inventory와 대조해 Harness 관리 산출물과 프로젝트 소유 파일을 구분한다.
2. consumer의 Harness 관리 경로는 installer가 관리하는 `.git/info/exclude` 또는 소유권에 맞는 `.gitignore`와 동기화하고, 대표 경로마다 `git check-ignore -v <path>` 결과를 확인한다. 프로젝트 소유 준비 문서인 `docs/agents/EXEC.md`, `docs/agents/execution.json`, `docs/contracts/**`는 Git 추적 대상으로 유지한다.
3. 변경·미추적 파일 전체를 session backup에 보존하고 백업 파일 목록을 확인한다. ignore 규칙은 tracked modification에 적용되지 않으므로 tracked 파일도 백업한다.
4. 소유권을 확인한 Harness 관리 산출물만 경로별로 정리하고, 정리 후 `git status --short`와 백업을 다시 확인한다.
