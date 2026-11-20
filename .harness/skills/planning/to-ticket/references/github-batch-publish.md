# GitHub Issue 발행

전체 계획이 독립 리뷰를 통과하고 사용자가 발행을 승인한 뒤, 별도 `tracker-publish` 단계에서 실행한다. 발행 전에는 로컬에서 [Issue 본문](github-issue-template.md)을 준비한다.

`harness-publication.mjs publish`는 승인된 본문으로 저장소에 parent·child Issue를 직접 만든다. 저장소의 Issue에서 plan 식별자 또는 승인 본문이 고유하게 일치하면 기존 Issue를 사용한다. 응답이 불명확하면 자동 재시도하지 않고 `inspect`로 저장소의 Issue를 확인한다.

`activate`는 Issue를 연결하고 번호를 세션에 저장한다. Project 등록과 상태 확인은 보조 작업이며 실패 시 경고를 반환한다. 발행 후에도 canonical 계획 snapshot을 보존한다.
