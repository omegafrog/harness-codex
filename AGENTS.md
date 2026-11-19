# Harness

Node.js 기반 Codex Harness의 ChangeSet/use-case workflow 소스 저장소다. 에이전트 간 입력·출력은 영어, workflow Markdown 산출물과 사용자 질문은 한국어로 쓴다. 식별자·경로·명령·프로토콜·승인 용어는 호환에 필요한 원문을 보존한다.

## Harness 소스 작업

- 현재 checkout에서 직접 수정하고 검증한다. 사용자가 요청한 경우에만 orchestrator 호출, workflow 구성, worktree 생성을 한다.
- 동작 변경은 설치·갱신·Doctor·Git 제외까지 추적한다. 설치된 소비자의 동작과 `git status`를 회귀 검사하고 프로젝트 소유 파일을 보존한다. 릴리스·소비자 갱신·백업 절차는 [EXEC의 설치 절](.harness/agents/EXEC.md#harness-원본-저장소의-설치-동작)을 따른다.

## 작업별 진입점

- Workflow 조율은 [coordination](.codex/skills/orchestrator/references/coordination.md), 각 단계 실행은 배정된 GUIDE를 따른다.
- 새 page/view/app shell과 대규모 UI/UX 변경은 독립 [frontend-design workflow](.codex/workflows/frontend-design.yaml)와 [GUIDE](.codex/internal-skills/frontend-design/GUIDE.md)를 사용한다. `implement`·`implement-wrapper`·`code-review`·`e2e-test`의 하위 단계로 실행하지 않는다.
- 실제 서버·인프라를 띄우는 사용자 흐름 E2E는 [e2e-test GUIDE](.codex/internal-skills/e2e-test/GUIDE.md)와 `e2e_test_runner`를 사용한다. 소비자 계산기 시나리오, 일반 검증 CLI와 서버 설정은 [EXEC](.harness/agents/EXEC.md)를 따른다.
- GitHub Issues 사용법은 [issue-tracker](.harness/agents/issue-tracker.md), 상태 전이는 [plan-status](.harness/agents/plan-status.md)를 따른다.

## 프로젝트 기준

- 용어와 경계는 [CONTEXT](CONTEXT.md), [CONTEXT-MAP](CONTEXT-MAP.md)을 확인한다. 모델·현행/폐기 용어·호환성 기준은 [domain](.harness/agents/domain.md)을 따른다.
- 실행기가 강제하는 규칙과 리뷰가 확인할 규칙은 [enforcement](docs/architecture/enforcement.md)에서 확인한다. 반복 agent 오류는 `correct`, 검증 지도는 `maintain-verification`을 사용한다.
- 구현과 검증은 해당 작업에서 활성 workspace의 [implementation-guidance](.harness/agents/implementation-guidance.md)와 [testing-guidance](.harness/agents/testing-guidance.md)를 각각 확인한다.
