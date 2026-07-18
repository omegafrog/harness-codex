# Review Write Rules

쓰기 범위는 다음 review 문서다.

- `docs/plans/active/<CHG-ID>/verification.md`: `.harness/docs/templates/plans/verification.md`를 따른다.
- `docs/changes/active/<CHG-ID>/review.md`: `template.md`를 따른다.

모든 gate가 통과하고 deferred finding이 resolved됐을 때만 `ready`를 기록한다. 미결정 finding이면
`needs_input`, 실패하면 `blocked`와 최소 blocker를 기록한다. required/achieved verification level과
finding disposition·사용자 승인·Issue URL을 보존한다.
