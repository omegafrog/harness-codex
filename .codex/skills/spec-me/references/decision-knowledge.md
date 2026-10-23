# 결정 근거 조회·수집 — spec-me 내부 스킬

## 호출 시점과 입력

Architecture 단계에서 대안 비교 전에 실행한다. 결정 질문이 추가되면 그 질문에 필요한 자료만 다시 확인한다. 확정된 Product 요구사항, System Target, 결정 질문과 제약을 입력으로 사용한다.

## 기존 근거 우선 조회

1. 이번 스펙의 중요한 결정 질문을 requirement·target·Decision ID(있는 경우)에 연결한다. 결정할 질문이 없으면 이유를 남기고 수집을 생략한다.
2. 관련 ADR, `docs/architecture/constraints.md`, 소유 팀의 승인된 기술 기준, project-local Principle·Evidence 및 연결된 Source·Claim을 조회한다. 질문의 용어·동의어와 관련 ID로 검색하고 registry 목록도 확인해 빠진 일치 항목을 찾는다.
   - 기술 선택 질문에는 적용되는 formal standard, official/primary technical documentation, maintainer 또는 기술 작성 팀이 발행한 기준, 실측 Evidence를 우선 대조한다. 각 출처의 발행 주체, 적용 범위, 원문 위치, 최신성을 확인한다. 조직 내부 기준은 소유 팀의 승인 상태와 예외 조건을 확인한다.
3. 승인 hash가 유효한 `approved` Principle과 승인된 durable 프로젝트 Evidence만 권위 있는 근거로 사용한다. candidate/reviewed, staged/rejected, deprecated 자료는 근거를 대신하지 못한다. Source/Claim은 출처와 맥락을 확인하는 자료이며 승인된 Principle로 자동 승격하지 않는다.
4. 질문마다 출처의 권위·적용 조건·예외·반대 근거·최신성, Evidence의 원래 프로젝트·환경·측정 유효성·실행 상태를 이번 요구사항과 정량 System Target에 대조한다. 각 기술 option이 목표와 적용 기준을 얼마나 충족하는지 비교하고 `충분 / 부분 충족 / 없음`, 재사용할 ID, 배제 이유, 부족한 질문을 기록한다.

## 부족분 수집과 복귀

5. 충분한 질문은 기존 근거를 재사용한다. 부분 충족/없음인 질문에 대해서만 [knowledge-harvest](../../knowledge-harvest/SKILL.md)와 `.codex/workflows/knowledge-harvest-workflow.yaml`에 선언된 역할·gate로 수집한다. 기존 Source/Claim을 재사용하고 중복 자료를 만들지 않는다. 수집 입력에는 질문, 제약, 관련 System Target, 기존 근거 ID, 부족분, 반대 근거 조사 범위를 포함한다. 자료 사용 승인, Principle 승인, Evidence 승인을 각각 기록한다.
6. 수집 후 registry를 다시 조회하고 충분성을 재평가한다. 승인 대기·접근 불가·불충분·미해결 반대 근거가 남으면 관련 결정을 보류한다.

## spec-me 반환

질문별 판정, 검색 범위, 재사용·신규 Source/Claim/Principle/Evidence ID, 출처 위치, 부족분과 승인 대기 상태를 Architecture 결정 단계에 전달한다. 임시 조회·수집 기록은 `session_directory` 아래에 둔다.
