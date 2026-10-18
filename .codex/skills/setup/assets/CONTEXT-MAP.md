# 컨텍스트 맵

## 1. 목적

이 문서는 저장소에서 세션을 넘어 유지되는 설계 경계만 정리한다.
세부 구현 절차나 실행 계획은 포함하지 않는다.

## 2. 경계

| Bounded Context | 책임 | 주 입력 | 주 출력 | 비고 |
|---|---|---|---|---|

## 3. 관계

## 4. 모델과 배포 근거

영향받는 모델이 확인되면 `docs/architecture/domain-model.md`에 현재 구현과 승인 target을 구분해 연결한다. 기존 Aggregate·규칙 소유자·공개 계약·통신·deployment unit·추출 조건 및 source/ADR/다이어그램 근거를 기록한다. 확인되지 않은 모델을 추측해 채우지 않는다.


통합 현행 구조: [DDD Architecture](docs/contracts/architecture.md) · [전체 Product 계약](docs/contracts/product.md). `sync-contracts`로 최초 통합 후 모든 정상 workflow 완료에 정합성 검사를 적용한다.
