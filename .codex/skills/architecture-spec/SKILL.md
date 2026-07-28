---
name: architecture-spec
description: Turn a completed Product Spec into an implementation-ready architecture contract. Use when defining boundaries, design decisions, and codebase impact before planning.
---

# Architecture Spec

## 목적

Product Spec을 구현 가능한 설계 계약으로 바꾼다.

## 입력

- 완료된 Product Spec
- `CONTEXT.md`
- `CONTEXT-MAP.md`가 있으면 함께 읽기
- 관련 ADR
- `code-research` 결과

## 진행

1. Product Spec과 guidance를 먼저 읽는다.
2. `code-research`를 호출해 현재 구조와 목표 설계의 차이를 요약받는다.
3. `grill-with-docs` 인터뷰를 수행해 `references/template.md`를 완성한다.

## 완료 조건

- 미결정 설계 사항이 남아 있으면 완료하지 않는다.
- 코드와 요구사항의 불일치를 숨기지 않는다.
- Product Spec에서 이미 확정된 사실을 다시 묻지 않는다.
- 코드 조사 원문은 Architecture Spec 본문에 길게 남기지 않는다.
- `docs/specs/architecture-spec.md`에 `references/template.md` 형식으로 문서가 생성된다.
