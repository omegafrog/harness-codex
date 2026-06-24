## Output Template

The planner writes `docs/plans/active/<WORK-ITEM-ID>/plan.md` using these sections:

1. `# Implementation Plan`
2. `## 1. 구현 목표`
3. `## 2. 구현하지 말아야 할 것`
4. `## 3. 입력 문서` with a document / purpose / status table
5. `## 3.1 ChangeSet 및 Work Item` with ChangeSet, work item ID/type/slice, and E2E or verification goal
6. `## 4. 아키텍처 제약`
7. `## 5. 구현 범위`
8. `## 5.1 승인된 기술 결정`
9. `## 5.2 도메인 영향`
10. `## 5.3 호환성 확인`
11. `## 5.4 OWASP Security Review`
12. `## 6. 구현 계획` with unchecked implementation tasks
13. `## 7. 테스트 계획` with matching unchecked test tasks
14. `## 8. 검증 방법` with Build, Tests, E2E or maintenance verification, Test gate, Runtime server verification, and Static analysis tasks
15. `## 9. 완료 조건` with all required evidence conditions and this rule: the workflow `complete-work-item-plan` git step exclusively performs the active-to-completed transition.
16. `## 10. 검증 결과` for executor-owned command and evidence results
17. `## 11. 검증 실패`

The executor may only change existing checkbox state and the `## 10. 검증 결과` (or `## 10. Verification Results`) section. The planner must not create, delete, or move a completed plan path.

## User-Facing Result

After agent completion, report:

- Whether `ARCHITECTURE.md` existed.
- Whether static-analysis procedures were included in the work-item plan.
- The active plan path.
- Whether the plan is ready for executor use.
- Any missing ChangeSet, work-item, architecture, repository setting, technical decision, or canonical domain inputs.
