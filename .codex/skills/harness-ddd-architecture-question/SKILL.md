---
name: harness-ddd-architecture-question
description: 통합 DDD architecture의 Aggregate·BC·통신·모듈·배포 단위 미결정을 사용자 선택 질문으로 만드는 L3 skill이다.
---

# DDD Architecture Question

레벨: L3.

통합 DDD 후보만 사용해 Aggregate 소유, BC 경계, BC 간 통신, 모듈 경계, 배포 단위의 미결정을 질문으로 만든다.

- 한 번에 최대 세 질문.
- 질문마다 추천안 하나와 선택지 둘 또는 셋을 한국어로 제시한다.
- 사업 정책, 성공·실패 기준, 권한, 상태 전이가 필요하면 질문하지 말고 가장 가까운 upstream blocker를 반환한다.
- 프레임워크·DB·프로토콜 등 기술 선택은 `technical-decisions` blocker를 반환한다.
- 문서·제품 코드·설정은 수정하지 않는다.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
