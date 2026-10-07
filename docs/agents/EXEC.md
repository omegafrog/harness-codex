# 실행 환경 안내

플랫폼별 설정과 실행 방법은 이 문서에 기록한다. `AGENTS.md`에는 공통 agent 규칙만 둔다.

## 기록 대상

- 플랫폼별 개발 환경 설정
- server 실행·중지 방법
- infra 의존성 준비와 정리 방법
- 플랫폼별 명령어 차이와 필요한 환경 변수

## 플랫폼별 실행 방법

플랫폼별 설정·실행 방법이 추가되면 아래에 기록한다.

### macOS / Linux

추가 지침 없음.

### Windows

추가 지침 없음.


## Harness 원본 저장소의 설치 동작

- Harness 원본 저장소와 해당 worktree에서는 `.codex/skills/` 및 `.codex/agents/`를 직접 사용한다. `install`, `update`, `lock`은 설치 사본을 만들거나 원본 agent profile의 경로를 치환하지 않고 건너뛴다. 원본 갱신은 Git으로 관리한다.
- 원본 checkout 판별은 설치 도구와 대상이 같은 실제 경로이거나, 같은 package 이름과 Harness installer·소스·스킬 파일이 있는지를 확인한다.
- 외부 프로젝트에는 기존 방식으로 스킬을 `.agents/skills/`에, agent profile을 `.codex/agents/`에 설치한다. workflow·schema·script와 프로젝트 설정도 `.codex/`에 둔다.
- workflow의 스킬 탐색은 `.agents/skills/`를 먼저 확인하고 없으면 `.codex/skills/`를 사용한다. 원본 저장소에는 중복 스킬 사본이 필요하지 않다.
