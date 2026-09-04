# 사용자 관리 아키텍처 제약

이 문서는 사용자가 직접 관리하는 지속적인 구현·설계 제약이다.
새 코드 생성과 Architecture Spec 작성 시 반드시 확인한다.

## Spring Bean 등록

- Annotation-based component scan을 사용하지 않는다.
- Bean은 명시적인 `@Bean` configuration 또는 명시적 등록 경로로 구성한다.
- 신규 코드 생성 시 `@Component`, `@Service`, `@Repository` 자동 검색에 의존하지 않는다.

## 운영 규칙

- 이 문서의 규칙은 사용자 승인 없이 완화하거나 삭제하지 않는다.
- 오래 유지할 결정의 근거와 배경은 ADR에 기록할 수 있지만, 동일한 규칙을 중복 정의하지 않는다.
