# 컨텍스트 맵

## 1. 목적

이 문서는 저장소에서 세션을 넘어 유지되는 설계 경계만 정리한다.
세부 구현 절차나 실행 계획은 포함하지 않는다.

## 2. 경계

| Bounded Context | 책임 | 주 입력 | 주 출력 | 비고 |
|---|---|---|---|---|
| harness/control-plane | workflow invariant, execution evidence, deterministic gate, evaluation classification | workflow/case contract, observed execution | gate verdict, evidence, eval result | 별도 deployment service가 아닌 기존 control-plane 내부 경계 |

## 3. 관계
