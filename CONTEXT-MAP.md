# 컨텍스트 맵

## 1. 목적

이 문서는 저장소에서 세션을 넘어 유지되는 설계 경계만 정리한다.
세부 구현 절차나 실행 계획은 포함하지 않는다.

## 2. 경계

| Bounded Context | 책임 | 주 입력 | 주 출력 | 비고 |
|---|---|---|---|---|
| harness/control-plane | workflow invariant, execution evidence, deterministic gate, evaluation classification | workflow/case contract, observed execution | gate verdict, evidence, eval result | 별도 deployment service가 아닌 기존 control-plane 내부 경계 |

## 3. 관계

## 4. 모델과 배포 근거

[Harness 모델 기준](docs/architecture/domain-model.md)에서 현재 소유 모델·공개 동작·검증·통신·배포 근거를 확인한다. 내부 기술 모듈을 별도 Context나 Aggregate로 추정하지 않는다. 새 설계는 영향받는 모델의 source와 승인 target을 대조하고, 구현 완료 후 실제 상태를 갱신한다.

현행 상세 모델·통신·배포 계약: [통합 DDD Architecture](docs/contracts/architecture.md). 전체 기능 계약: [Product](docs/contracts/product.md). [클릭 가능한 구조 보기](docs/contracts/architecture.html).
