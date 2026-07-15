# Orchestration Routes

사용자 원문의 직접 의도와 일치하는 첫 route 하나를 선택한다.

| 사용자 요청 | `next_skill` |
| --- | --- |
| app 실행·상태·중지·attach, `harness run app`, wiki serve/build/install | `harness-runtime-run` |
| dashboard JSON·UI server | `harness-dashboard` |
| runtime 설치 갱신·update·dry-run | `harness-runtime-update` |
| CLI 명령·사용법·help | `harness-runtime-help` |
| ChangeSet 목록·조회·삭제·document delta | `harness-changes` |
| 구현된 ChangeSet 동작 설명·코드 위치 질문 | `harness-question-router` |
| runtime stage 상태 | `harness-runtime-stages` |
| runtime artifact 조회·승인 | `harness-runtime-artifacts` |
| run report·실패 요약 | `harness-runtime-report` |
| 새 동작·bugfix·refactor·제품 코드 변경 | `harness-changeset-workspace` 이후 ChangeSet intent route |

사용자가 skill을 명시해도 orchestration agent가 원문을 읽고 해당 route를 확인한 뒤 반환한다. route 반환 전 직접 명령 실행과 대체 skill 선택은 허용하지 않는다.
