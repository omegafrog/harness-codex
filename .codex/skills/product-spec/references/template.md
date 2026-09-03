
1. **Problem and Context**

2. **Goals and Desired Outcomes**

3. **Users and Actors**

4. **Ubiquitous Language and Terminology**

5. **Core Use Cases**

6. **Business Rules and Invariants**

7. **States and State Transitions**

8. **Failures, Exceptions, and Boundary Conditions**

9. **Inputs and Outputs**

10. **Scope and Non-goals**

11. **Priorities and Trade-offs**

12. **Success Conditions and Acceptance Criteria**

## Product 다이어그램 계약

- 흐름이 신설·변경되었으면 관련 유스케이스 및 액티비티 다이어그램을 `docs/specs/<ticket-id>/diagrams/product/`에 둔다.
- 파일은 `UC-<id>.usecase.puml`, `UC-<id>.activity.puml`과 같은 basename의 `.svg`를 사용하고, 각 원본에 요구사항 ID 또는 유스케이스 ID를 기록한다.
- 업무 상태 다이어그램은 독립적인 업무 검토 목적이 있을 때만 `<concept>.business-state.puml`과 `.svg`로 추가한다. 그렇지 않으면 `해당 없음 — <reason>`을 기록한다.
- Product 단계에서는 클래스 다이어그램을 생성하지 않는다.
- 문서에는 생성된 SVG만 링크한다. 원본 작성, 로컬 SVG 렌더, Markdown 링크, Spec 내용 일치 검토가 완료 조건이다. 렌더 실패는 완료를 막는다.
