# harness-codex

`harness-codex`는 Codex skill과 ChangeSet 문서를 보조하는 로컬 utility 모음입니다.

## 구조

- `.codex/`: Codex가 발견하는 agent와 skill 정의
- `harness_codex/`: 문서 조회·검증·대시보드·completion·업데이트 utility 소스
- `.harness/`: 기존 ChangeSet 문서, 템플릿, 상태 같은 프로젝트 데이터

`.harness/runtime` 설치 사본과 runtime orchestration은 없습니다. runtime은 agent 생성, step 실행, routing, retry, session polling을 하지 않습니다.

## 작업 진행

현재 Codex 세션에서 `$harness-orchestrate-instruction`을 호출합니다. 이 skill이 한 ChangeSet/work item을 고르고, 각 specialist skill을 native subagent로 위임합니다. specialist는 문서·코드·검증 결과를 직접 남기고 종료합니다.

## Utility CLI

```bash
./harness help
./harness changes list
./harness contracts validate <CHG-ID>
./harness dashboard
./harness completion install
```

CLI는 workflow 실행 진입점이 아닙니다.
