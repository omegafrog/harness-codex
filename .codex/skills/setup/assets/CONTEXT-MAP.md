# 컨텍스트 맵

## 1. 목적

이 문서는 저장소에서 세션을 넘어 유지되는 설계 경계만 정리한다.
세부 구현 절차나 실행 계획은 포함하지 않는다.

## 2. 경계

| Bounded Context | 책임 | 주 입력 | 주 출력 | 비고 |
|---|---|---|---|---|

## 3. 관계

| Upstream | Downstream | Upstream 책임 | Downstream 책임 | 통신 계약 | 판단 소유자 | 상태·근거 |
|---|---|---|---|---|---|---|

관계가 확인되지 않은 컨텍스트는 연결을 추측하지 않는다. 통신 계약에는 교환할 정보와 조건·반응을 기록하고 미결정 기술 방식은 표시한다. 판단 소유자는 두 컨텍스트의 규칙이 어긋날 때 결과를 정하는 컨텍스트이며 근거가 없으면 `미정`으로 둔다. 관계 패턴은 근거가 있고 이해에 도움이 될 때만 기록한다.

## 4. 모델과 배포 근거

변경 설계는 관련 plan set의 `docs/specs/<plan-set-id>/tactical-design.md`에 두고 현행 구현 근거와 승인된 설계를 구분한다.


통합 현행 구조: [DDD Architecture](docs/contracts/architecture.md) · [전체 Product 계약](docs/contracts/product.md). `sync-contracts`로 최초 통합 후 모든 정상 workflow 완료에 정합성 검사를 적용한다.
