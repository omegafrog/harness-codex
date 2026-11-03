
1. **Problem and Context**

2. **Goals and Desired Outcomes**

3. **Users and Actors**

4. **Ubiquitous Language and Terminology**

이 절의 모든 업무 개념·행위자/역할·업무 상태·규칙 용어는 대상 프로젝트의 공유 vocabulary다. 기존 `CONTEXT.md`와 대조하고, 새 용어와 확정된 정의 변경을 같은 workspace의 `CONTEXT.md`에 반영한다. 이 용어들을 현재 plan set에만 한정하지 않는다. UI 문구와 설명 표현, framework/package/API/code 식별자는 도메인 용어가 아니면 제외한다.

5. **Core Use Cases**

6. **Business Rules and Invariants**

7. **States and State Transitions**

8. **Failures, Exceptions, and Boundary Conditions**

9. **Inputs and Outputs**

10. **Scope and Non-goals**

11. **Priorities and Trade-offs**

12. **Success Conditions and Acceptance Criteria**

## Product 다이어그램 계약

- 흐름이 신설·변경되었으면 관련 유스케이스 및 액티비티 다이어그램을 `docs/specs/<plan-set-id>/diagrams/product/`에 둔다.
- 파일은 `UC-<id>.usecase.puml`, `UC-<id>.activity.puml`과 같은 basename의 `.svg`를 사용하고, 각 원본에 요구사항 ID 또는 유스케이스 ID를 기록한다.
- 업무 상태 다이어그램은 독립적인 업무 검토 목적이 있을 때만 `<concept>.business-state.puml`과 `.svg`로 추가한다. 그렇지 않으면 `해당 없음 — <reason>`을 기록한다.
- Product 단계에서는 클래스 다이어그램을 생성하지 않는다.
- 문서의 다이어그램 목록에서 편집 가능한 `.puml` 원본과 생성된 `.svg`를 각각 상대 경로 Markdown 링크로 제공한다. 원본 작성, 로컬 SVG 렌더, Markdown 링크, Spec 내용 일치 검토가 완료 조건이다. 렌더 실패는 완료를 막는다.
