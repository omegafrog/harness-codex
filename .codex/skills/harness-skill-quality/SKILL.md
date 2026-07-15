---
name: harness-skill-quality
description: 사용자가 명시하거나 모델이 harness skill 생성·수정을 감지했을 때 네 단계 품질 검사를 적용한다.
---

# Skill Quality Check

1. Trigger: description에 호출자와 호출 조건을 쓴다. 확실한 진입이 필요하면 사용자 호출, 의도 기반 편의가 우선이면 모델 호출을 허용한다.
2. Structure: `SKILL.md`에는 절차만 남기고 분기·참고자료는 한 단계 reference로 옮긴다.
3. Guidance: 각 단계는 다음 행동을 강한 동사로 시작한다. 즉시 gate만 드러내고 먼 최종 목표는 작은 단계로 나눈다.
4. Prune: 지워도 결과가 같으면 삭제한다.
