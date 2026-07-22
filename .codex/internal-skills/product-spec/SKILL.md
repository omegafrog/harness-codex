# Product Spec

## 목적

사용자 요청을 제품 관점의 문제, 요구사항, 유스케이스, 업무 규칙으로 정리한다.

## 입력

- 사용자 요청
- `CONTEXT.md`
- `CONTEXT-MAP.md`가 있으면 함께 읽기
- 기존 제품 문서

## 금지

- source code 조사
- test code 조사
- framework, package, persistence, module 구조 결정

## 진행

1. `/grill-with-docs`로 한 번에 사용자 결정 하나만 질문한다.
2. 각 질문에 추천안과 추천 이유를 함께 적는다.
3. 저장소에서 확인할 수 있는 사실은 질문하지 않는다.
4. 충분한 공동 이해가 생기면 Product Spec을 작성한다.

## 연결

- `grill-with-docs`는 product interview의 public wrapper다.
- `product-spec`은 질문 결과를 제품 문서로 정리한다.

## 완료 조건

- Product Spec에 코드 구조나 구현 세부가 들어가지 않는다.
- 요구사항과 유스케이스가 안정적인 ID로 추적된다.
