# harness-codex

`harness-codex`는 Codex skill과 ChangeSet 문서를 보조하는 로컬 utility 모음입니다.

## 구조

- `.codex/`: Codex가 발견하는 agent와 skill 정의
- `harness_codex/`: 문서 조회·검증·대시보드·completion·업데이트 utility 소스
- `.harness/`: 기존 ChangeSet 문서, 템플릿, 상태 같은 프로젝트 데이터

`.harness/runtime` 설치 사본과 runtime orchestration은 없습니다. runtime은 agent 생성, step 실행, routing, retry, session polling을 하지 않습니다.

## 작업 진행

현재 Codex 세션에서 사용자가 `$harness-orchestrate-instruction`을 호출하거나 모델이 구현 요청을 감지하면 orchestration이 시작됩니다. `feature`는 requirements부터, `bugfix`와 `refactor`는 `docs/maintenance/<MAINT-ID>/` intake부터 진행합니다. 두 흐름은 `docs/plans/active/<WORK-ITEM-ID>/plan.md`부터 같은 planning·security·implementation·review 단계를 사용합니다.

## Utility CLI

```bash
./harness help
./harness changes list
./harness contracts validate <CHG-ID>
./harness dashboard
./harness completion install
```

CLI는 workflow 실행 진입점이 아닙니다.
