# Review Write Rules

쓰기 범위는 다음 review 문서다.

- `docs/plans/active/<WORK-ITEM-ID>/verification.md`: `.harness/docs/templates/plans/verification.md`를 따른다.
- 마지막 work item의 `docs/changes/active/<CHG-ID>/review.md`: `template.md`를 따른다.

모든 gate가 통과했을 때만 `ready`를 기록한다. 실패하면 `blocked`와 최소 blocker를 기록한다.
