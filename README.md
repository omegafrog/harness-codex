# harness-codex

`harness-codex`는 Codex skill과 ChangeSet 문서를 보조하는 로컬 utility 모음입니다.

## 구조

- `.codex/`: Codex가 발견하는 agent와 skill 정의
- `harness_codex/`: 문서 조회·검증·대시보드·completion·업데이트 utility 소스
- `.harness/`: 기존 ChangeSet 문서, 템플릿, 상태 같은 프로젝트 데이터

`.harness/runtime` 설치 사본과 runtime orchestration은 없습니다. runtime은 agent 생성, step 실행, routing, retry, session polling을 하지 않습니다.

## 작업 진행

Harness 저장소의 실행·변경·검토·조회 요청은 모두 `$harness-orchestrate-instruction`으로 시작합니다. 이 skill은 사용자 프롬프트 원문 전체를 `orchestration` agent에 먼저 전달하고, agent가 반환한 skill만 실행합니다. utility 요청은 해당 runtime skill로, `feature`는 requirements로, `bugfix`와 `refactor`는 `docs/maintenance/<MAINT-ID>/` intake로 라우팅합니다.

## Utility CLI

```bash
./harness help
./harness changes list
./harness contracts validate <CHG-ID>
./harness dashboard
./harness completion install
```

CLI는 workflow 실행 진입점이 아닙니다.
