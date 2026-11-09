
1. **Problem and Context**

2. **Goals and Desired Outcomes**

기능마다 제품 의도를 하나 적는다. 의도는 금지 목록이 아니라 판단 기준이다. 적힌 의도를 위해 필요한 것만 구현하고 나머지는 하지 않는다.

```text
INT-COMMUNITY
- 목적: 회원이 글과 댓글을 주고받는 소규모 게시판을 먼저 출시한다
- 충분한 수준: 일반적인 사용 흐름이 깨지지 않으면 된다
- 출처: 사용자 답변
```

3. **Users and Actors**

4. **Ubiquitous Language and Terminology**

이 절의 모든 업무 개념·행위자/역할·업무 상태·규칙 용어는 대상 프로젝트의 공유 vocabulary다. 기존 `CONTEXT.md`와 대조하고, 새 용어와 확정된 정의 변경을 같은 workspace의 `CONTEXT.md`에 반영한다. 이 용어들을 현재 plan set에만 한정하지 않는다. UI 문구와 설명 표현, framework/package/API/code 식별자는 도메인 용어가 아니면 제외한다.

5. **Core Use Cases**

6. **Business Rules and Invariants**

수치·길이·경계·형식·검증처럼 구현 방식의 폭이 넓은 규칙과 삭제가 다른 데이터로 전파되는 규칙에는 아래 세 줄을 함께 적는다. Spec review가 이 세 줄을 검사하고 없으면 완료를 막는다. 다른 규칙에는 적지 않는다.

```text
BR-12: 게시글 본문은 최대 5,000자다. 초과한 작성·수정은 거부한다.
- 의도: 남용과 저장 부하를 억제한다.
- 충분한 수준: 대략적 상한이면 된다.
- 출처: 사용자 답변
```

`의도`는 사용자가 이 기능·규칙으로 막거나 얻으려는 결과, 즉 사용자의 이유다(기능을 다시 쓴 문장이 아니다). 사용자에게 물어 받은 이유를 그대로 쓰고, `충분한 수준`은 그 의도를 만족하는 데 필요한 정도다. 하지 않을 일을 나열하지 않는다. `출처`는 `사용자 답변`, 기존 근거 또는 `플랫폼 기본 동작`을 구분한다. 핵심 기능에 필요하지 않은 규칙을 추정해 추가하지 않는다. 사용자 의도가 실질적으로 달라지는 필수 결정은 근거가 없으면 질문하고, 일상적인 세부는 합리적인 기본 동작을 명시한다. 사용자가 명시한 경우에만 정규화·인코딩·locale 기준을 쓴다.

7. **States and State Transitions**

8. **Failures, Exceptions, and Boundary Conditions**

9. **Inputs and Outputs**

10. **Scope and Non-goals**

11. **Priorities and Trade-offs**

기술 선택에 영향을 주는 필수·선호 기준, 우선순위와 수용할 비용·운영·데이터 제약을 기록한다. 수치 목표에는 단위·조건·출처를 명시하고 미확정 목표는 추정하여 채우지 않는다. 후보별 구현 세부사항은 Architecture에 둔다.

12. **Success Conditions and Acceptance Criteria**

13. **End-user Scenarios**

최종 E2E가 그대로 실행할 사용자 시나리오다. 핵심 Use Case를 끝까지 따라가는 흐름만 적고, 각 단계에 관련 UC/BR/AC ID를 붙인다. 행위자·행동·사용자가 보는 기대 결과만 쓰고 서버·DB·도구 같은 실행 방식은 쓰지 않는다(Architecture Spec 12.7이 정한다). 의도의 `충분한 수준`을 넘는 확인(부하, 장애 주입, 보안 침투 등)은 넣지 않는다. 모든 단계는 이미 있는 요구에서 나와야 한다. 시나리오에 필요한데 요구에 없는 동작은 스스로 요구로 추가하지 말고, 추가할지 시나리오에서 뺄지 사용자에게 묻는다.

```text
E2E-01 방문자 계산과 공개 열람 (UC-01, UC-03, AC-01, AC-04)
1. 방문자가 2 + 3을 계산한다 → 5가 표시된다.
2. 방문자가 게시글 목록을 연다 → 로그인 없이 글이 보인다.
```

## Product 다이어그램 계약

- 흐름이 신설·변경되었으면 관련 유스케이스 및 액티비티 다이어그램을 `docs/specs/<plan-set-id>/diagrams/product/`에 둔다.
- 파일은 `UC-<id>.usecase.puml`, `UC-<id>.activity.puml`과 같은 basename의 `.svg`를 사용하고, 각 원본에 요구사항 ID 또는 유스케이스 ID를 기록한다.
- 업무 상태 다이어그램은 독립적인 업무 검토 목적이 있을 때만 `<concept>.business-state.puml`과 `.svg`로 추가한다. 그렇지 않으면 `해당 없음 — <reason>`을 기록한다.
- Product 단계에서는 클래스 다이어그램을 생성하지 않는다.
- 문서의 다이어그램 목록에서 편집 가능한 `.puml` 원본과 생성된 `.svg`를 각각 상대 경로 Markdown 링크로 제공한다. 원본 작성, 로컬 SVG 렌더, Markdown 링크, Spec 내용 일치 검토가 완료 조건이다. 렌더 실패는 완료를 막는다.
