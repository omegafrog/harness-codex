---
name: plantuml-diagrams
description: Create and validate ticket-scoped PlantUML sources and local SVG artifacts for Product and Architecture Specs.
---

# plantuml-diagrams

`plantuml-diagrams`는 Spec에 필요한 다이어그램만 독립 `.puml` 편집 원본으로 만들고, 기존 로컬 renderer를 통해 SVG를 생성·검증한다.

## 적용 판단

- 흐름이 신설·변경된 경우에만 관련 Product 유스케이스·액티비티 다이어그램을 생성하거나 갱신한다.
- 업무 상태와 설계 상태가 서로 다른 검토 목적을 가질 때만 각각 만든다. 같은 상태 모델을 중복하지 않는다.
- 구조 모델이 적용되는 Architecture 단계에서는 클래스 다이어그램을 만들 수 있다. Product 단계에서는 클래스 다이어그램을 생성하지 않는다.
- 모든 Spec에 형식적으로 다이어그램을 강제하지 않는다. 해당 없음이면 그 이유를 Spec에 기록한다.

## 파일·식별자·링크 규약

다이어그램은 `docs/specs/<ticket-id>/diagrams/{product,architecture}/` 아래에 둔다.

- Product: `UC-<id>.<usecase|activity>.puml` 및 같은 basename의 `.svg`
- 업무 상태: `<concept>.business-state.puml` 및 `.svg`
- Architecture: `<context>.class.puml` 및 `.svg`
- 설계 상태: `<concept>.state.puml` 및 `.svg`
- 각 원본은 관련 요구사항 ID 또는 유스케이스 ID를 제목·주석으로 식별한다.
- Markdown은 원본이 아니라 생성된 SVG를 상대 경로로 링크한다. `.puml`와 `.svg` basename은 일치해야 한다.

## 작성·렌더 규칙

- `.puml`가 유일한 편집 원본이다. SVG·PNG를 직접 수정하지 않는다.
- `bin/plantuml-render.mjs`를 유일한 렌더 실행 경계로 사용하고, 도구는 `bin/plantuml-bootstrap.mjs`의 검증된 cache를 사용한다.
- 외부 URL 또는 workspace 밖 파일을 가리키는 `!include`를 사용하지 않는다. 원격 PlantUML/MCP나 호출 시 자동 설치에 의존하지 않는다.
- SVG 렌더가 성공하고 비어 있지 않으며, Markdown 링크가 존재하는지 확인한다.
- 원본·SVG·Markdown 링크·Spec 내용 일치 검토가 모두 통과하기 전에는 해당 Spec 단계를 완료하지 않는다.
- 렌더 실패, 누락된 SVG, 잘못된 링크 또는 내용 불일치는 실패 파일·행과 복구 방법을 보고하고 단계를 차단한다.

## 완료 체크리스트

- [ ] 필요한 관점만 선택했고 Product에 클래스 다이어그램을 넣지 않았다.
- [ ] ID와 파일명 규약을 지켰다.
- [ ] `.puml`에서 SVG를 로컬 렌더했다.
- [ ] Spec Markdown의 SVG 링크와 내용 일치를 검토했다.
