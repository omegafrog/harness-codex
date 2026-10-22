# 결정 근거 조회·수집 — spec-me 내부 스킬

이 파일은 `spec-me`가 읽고 실행하는 내부 스킬이다. 독립 `SKILL.md`, 공개 skill catalog, UI metadata 또는 별도 사용자 명령으로 등록하지 않는다.

## 호출 시점과 입력

System Targets와 domain-baseline을 확인한 뒤, Architecture 대안을 선택하기 전에 실행한다. 인터뷰에서 중요한 결정 질문·조건이 추가되면 해당 질문만 다시 확인한다. `workspace_root`, `shared_guidance_root`, `session_directory`, 확정된 Product 요구사항, System Target, 결정 질문과 제약을 전달한다. Product 단계의 source/test 조사 금지는 유지한다.

## 기존 근거 우선 조회

1. 이번 스펙의 중요한 결정 질문을 requirement·target·Decision ID(있는 경우)에 연결한다. 결정할 질문이 없으면 이유를 남기고 수집을 생략한다.
2. 프로젝트 로컬 `knowledge/principles/`, `knowledge/evidence/`와 연결된 Source·Claim을 조회한다. Principle 검색은 기존 `lookupPrinciples({ root: workspace_root, query })`를 사용한다. 구현은 원본의 `src/knowledge/registry.mjs`, 설치 프로젝트의 `.codex/harness-runtime/src/knowledge/registry.mjs`에 있다. Evidence는 `knowledge/evidence/`의 파일 ID를 열거한 뒤 같은 모듈의 공개 `readEvidence`로 확인한다. 승인 검증이 없는 직접 YAML 읽기로 대체하지 않는다. 질문의 용어·동의어와 관련 ID로 찾고, 검색 결과가 없으면 registry 목록도 확인해 단순 단어 불일치를 배제한다.
3. 승인 hash가 유효한 `approved` Principle과 승인된 durable 프로젝트 Evidence만 권위 있는 근거로 사용한다. candidate/reviewed, staged/rejected, deprecated 자료는 근거를 대신하지 못한다. Source/Claim은 출처와 맥락을 확인하는 자료이며 승인된 Principle로 자동 승격하지 않는다.
4. 질문마다 적용 조건·예외·반대 근거·최신성, Evidence의 원래 프로젝트·환경·측정 유효성·실행 상태를 이번 요구사항과 목표에 대조한다. 검색 hit나 승인 상태만으로 충분하다고 판단하지 않는다. `충분 / 부분 충족 / 없음`과 재사용할 ID, 배제 이유, 부족한 질문을 기록한다. 손상·읽기 실패를 `없음`으로 처리하지 말고 진단 후 해당 결정을 보류한다.

## 부족분 수집과 복귀

5. 충분한 질문은 기존 근거를 재사용하고 수집하지 않는다. 부분 충족/없음인 질문에 대해서만 공개 스킬 경로의 `knowledge-harvest/SKILL.md`와 프로젝트의 `.codex/workflows/knowledge-harvest-workflow.yaml`을 읽고 선언된 역할·gate로 수집 흐름을 실행한다. 기존 Source/Claim을 먼저 재사용하고 같은 URI·주장·측정을 중복 생성하지 않는다. 수집 입력에는 질문, 제약, 기존 근거 ID, 부족분, 반대 근거 조사 범위를 전달한다.
6. `spec-me`가 직접 Principle을 생성·수정·승인·폐기하지 않는다. 해당 쓰기와 검토는 knowledge-harvest의 역할이 수행한다. 수집·저장은 자료 제시를 위해 가능하지만 Reviewer의 신규 자료 사용 승인과 Principle/Evidence의 사용자 승인은 별개로 유지한다. 기존 승인은 내용과 범위가 여전히 유효한 경우 재사용하고, 침묵을 승인으로 간주하지 않는다.
7. 수집 후 registry를 다시 조회하고 충분성을 재평가한다. 승인 대기·접근 불가·불충분·미해결 반대 근거가 남으면 관련 결정을 보류한다. 근거가 부족한 상태로 결론을 확정하거나 decision gate를 우회하지 않는다. 기존 session workspace와 출력 경계를 유지하며 내부 호출이 상위 worktree를 종료하지 않도록 한다.

## spec-me 반환

질문별 판정·이유, 검색 범위, 재사용/신규 근거 ID, 부족분과 승인 대기 상태를 상위 Architecture 인터뷰에 전달한다. 임시 조회·수집 기록은 `session_directory` 아래에만 두고 최종 결정에는 requirement·target·Decision·Principle·Evidence ID와 근거의 적용 한계를 보존한다. 이는 agent가 수행하는 의미 판단 절차이며 새로운 runtime 자동 gate를 뜻하지 않는다.
