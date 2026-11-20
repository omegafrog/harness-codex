---
model_tier: low_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# plantuml-diagrams

`plantuml-diagrams`는 Spec에 필요한 다이어그램만 독립 `.puml` 편집 원본으로 만들고, 기존 로컬 renderer를 통해 SVG를 생성·검증한다.

Spec workflow에서는 경량 `diagram_creator` 서브에이전트가 이 스킬을 실행한다. 호출자는 settled 요구사항·설계와 ticket scope를 제공하고, diagram_creator는 `docs/specs/<plan-set-id>/requirements.md`와 `docs/specs/<plan-set-id>/tactical-design.md`에서 확정된 diagram inventory를 읽는다. 상위 Spec 에이전트는 산출물과 내용 일치를 검토한다.

## 적용 판단

Spec diagram stage가 선언한 `product_diagram_required` 및 `architecture_diagram_required` 조건은 입력의 같은 이름 필드에 boolean을 요구한다. 상위 workflow가 확정 Spec inventory를 판단해 전달하며, `true`면 stage를 dispatch하고 `false`면 skip한다. 필드가 누락되거나 boolean이 아니면 조건 평가를 차단한다.

- 흐름이 신설·변경된 경우에만 관련 Product 유스케이스·액티비티 다이어그램을 생성하거나 갱신한다.
- 업무 상태와 설계 상태가 서로 다른 검토 목적을 가질 때만 각각 만든다. 같은 상태 모델을 중복하지 않는다.
- 구조 모델이 적용되는 Architecture 단계에서는 클래스 다이어그램을 만들 수 있다. Product 단계에서는 클래스 다이어그램을 생성하지 않는다.
- 모든 Spec에 형식적으로 다이어그램을 강제하지 않는다. 해당 없음이면 그 이유를 Spec에 기록한다.

## 파일·식별자·링크 규약

다이어그램은 `docs/specs/<plan-set-id>/diagrams/{product,architecture}/` 아래에 둔다.

- Product: `UC-<id>.<usecase|activity>.puml` 및 같은 basename의 `.svg`
- 업무 상태: `<concept>.business-state.puml` 및 `.svg`
- Architecture: `<context>.class.puml` 및 `.svg`
- 설계 상태: `<concept>.state.puml` 및 `.svg`
- 각 원본은 관련 요구사항 ID 또는 유스케이스 ID를 제목·주석으로 식별한다.
- `requirements.md`은 편집 가능한 `.puml` 원본과 생성된 SVG를 각각 상대 경로 링크로 제공한다. `tactical-design.md`은 기존 SVG 링크 규칙을 따른다. `.puml`와 `.svg` basename은 일치해야 한다.

## 작성·렌더 규칙

- `.puml`가 유일한 편집 원본이다. SVG·PNG를 직접 수정하지 않는다.
- 다이어그램의 제목, 액터명, 상태명, 흐름 라벨, 주석 등 설명 텍스트는 한글로 작성한다. 코드 식별자, 파일 경로, API·프로토콜명, 이벤트명, 필드명, PlantUML alias는 원문을 보존한다.
- 클래스 다이어그램에서는 클래스·컴포넌트·인터페이스·열거형 이름, 메서드·변수·상수 명, 타입, 매개변수, 반환 타입, 전체 시그니처를 원문 그대로 작성한다. 이 구조 요소를 번역하거나 한글 음역·변환하지 않는다.
- 클래스 다이어그램의 visibility 심볼, 타입·제네릭·연산자와 관계 심볼(`+`, `-`, `#`, `~`, `-->`, `<|..` 등)은 PlantUML 및 코드 원문 그대로 유지한다. 한글 설명은 note 또는 관계 라벨에만 둔다.
- `.harness/tools/plantuml-render.mjs`를 유일한 렌더 실행 경계로 사용하고, 도구는 `.harness/tools/plantuml-bootstrap.mjs`의 검증된 cache를 사용한다.
- 외부 URL 또는 workspace 밖 파일을 가리키는 `!include`를 사용하지 않는다. 원격 PlantUML/MCP나 호출 시 자동 설치에 의존하지 않는다.
- SVG 렌더가 성공하고 비어 있지 않으며, Markdown 링크가 존재하는지 확인한다.
- 원본·SVG·Markdown 링크·Spec 내용 일치 검토가 모두 통과하기 전에는 해당 Spec 단계를 완료하지 않는다.
- 렌더 실패, 누락된 SVG, 잘못된 링크 또는 내용 불일치는 실패 파일·행과 복구 방법을 보고하고 단계를 차단한다.
- `diagram_creator`는 다이어그램 파일만 수정한다. Product 원본과 SVG 경로는 결과 보고서의 diagram inventory로 전달하며, Spec을 소유한 stage가 Spec Markdown에 링크한다. 요구사항·설계 결정을 새로 만들거나 바꾸지 않는다.
- 호출자는 `diagram_creator`를 띄우기 전에 `node .harness/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill plantuml-diagrams`를 실행하고, 반환된 `model`·`reasoning_effort`로 실행한다. 이 명령이 실패하면 멈추고 부모 모델을 상속하지 않는다.
- `diagram_creator`는 요청된 `docs/specs/<plan-set-id>/diagrams/` 또는 `docs/contracts/diagrams/`만 수정하고 다른 agent를 만들지 않는다. 선택한 관점, 변경 파일, 렌더 명령, 검증 증거와 blocker를 보고한다.

## 완료 체크리스트

- [ ] 필요한 관점만 선택했고 Product에 클래스 다이어그램을 넣지 않았다.
- [ ] ID와 파일명 규약을 지켰다.
- [ ] `.puml`에서 SVG를 로컬 렌더했다.
- [ ] Spec Markdown의 SVG 링크와 내용 일치를 검토했다.

## 전술 클래스 다이어그램

`aggregate-design`이 확정한 BC별 Entity·Value Object에 맞춰 `docs/specs/<plan-set-id>/diagrams/<bc>.class.puml`과 같은 이름의 SVG를 작성한다. Aggregate는 이름이 있는 경계로 표시하고 그 안에 Root·Entity·Value Object, 타입과 메서드, 포함 관계를 표시한다. Aggregate 사이에는 실제 ID 참조와 방향을 표시한다. Aggregate가 없는 BC의 Value Object도 그 구성과 관계를 표시한다. `tactical-design.md`의 해당 `## BC <context-id>` 아래 두 파일에 상대 링크를 둔다. Entity와 Value Object가 모두 없으면 해당 BC에 이유를 기록한다.

전술 설계에서는 `aggregate-design` 담당자가 확정된 모델을 기준으로 원본을 작성하고 로컬 renderer를 실행한다. 이미 검증된 JAR의 경로를 `--jar`로 넘긴다. `node .harness/tools/plantuml-render.mjs --workspace <workspace_root> --jar <verified_jar> <class.puml>`을 사용한다. 렌더 결과와 모델·링크가 일치하면 원본과 SVG를 workspace artifact에 실어 보고한다.

## 통합 계약 다이어그램

`sync-contracts/references/format.md`에 따라 `docs/contracts/diagrams/`의 현행 DDD·class·기능별 sequence·state 원본과 SVG도 같은 diagram_creator가 유지한다. DDD 구조는 전체 외부 시스템·Context·Aggregate·root/entity/VO·domain service/method·composition service/method를 실제 owner 경계 안에 **이름만** 표시하고 `[[../architecture.md#<stable-id> <이름>]]`으로 상세 section에 연결한다. class 그림은 속성과 타입·메서드·관계를 담는다. 모든 활성 기능은 sequence가 필요하고, 상태/class가 적용되지 않을 때만 근거를 manifest에 기록한다. 근거 없이 관점을 생략하지 않는다.

`.harness/tools/plantuml-render.mjs`와 `.harness/tools/plantuml-bootstrap.mjs`를 정본 및 실행 경로로 사용한다. canonical 원본은 include 없이 자체 완결한다. 문서 링크 URL은 허용하며 원격 include/실행은 금지한다. SVG의 원본 SHA는 renderer가 기록한다. 부모가 `seal`로 클릭 가능한 HTML을 생성하고 `check` 통과를 확인한다.
