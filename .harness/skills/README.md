# Harness 내부 스킬

Codex와 Claude Code가 함께 읽는 정본 `GUIDE.md`와 단계별 참조, 템플릿, 스크립트는 `.harness/skills/`에 둔다.

| 폴더 | 역할 |
|---|---|
| [workflow](workflow/) | 워크플로우 구성, 세션, worktree |
| [requirements](requirements/) | 범위와 이해관계자, 인터뷰, 업무·용어·이벤트 분석, 요구사항 확정 |
| [design/domain-model](design/domain-model/) | 도메인 모델, Aggregate, 서비스, 통합과 컨텍스트 경계 |
| [design/technical-decisions](design/technical-decisions/) | 기술 선택과 UI·API·데이터 결정 |
| [planning](planning/) | 티켓 분할, 독립 계획 리뷰, 트래커 발행 |
| [delivery](delivery/) | 티켓 구현, 독립 프런트엔드 흐름, 통합 계약 동기화 |
| [quality](quality/) | 코드·설계·계약 리뷰, 검증·E2E, 다이어그램, Harness 평가 |
| [research](research/) | 기존 코드 조사와 의사결정 근거 수집 |
| [operations](operations/) | Harness 유지보수·복구, 프로젝트 지침, 진단과 운영 절차 |

워크플로우와 실행 기록은 기존 skill ID를 사용한다. 예를 들어 `plan-review`의 가이드는 [planning/plan-review/GUIDE.md](planning/plan-review/GUIDE.md)에 있다. 실행기는 skill ID로 가이드 경로를 해석하며, 설치기는 이 디렉터리 구조를 소비자 저장소에 복제한다.

기존 소비자 저장소는 전체 Harness 업데이트로 이 구조를 설치한다. 설치 lock에 기록된 과거 경로는 기존 백업 정책으로 정리하고, 관리 대상이 아닌 파일은 보존한다.
