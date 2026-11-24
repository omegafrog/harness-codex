---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# context-boundary

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

마지막 전술 설계 검토다. [공통 절차](../domain-model/references/deepening.md)에 따라 preflight와 경로 확인을 마친 뒤 확정 요구사항, 승인 답변, Context Map, 관련 ADR과 [전술 설계](../domain-model/references/template.md)를 대조한다.

- 실제 사용 관계의 방향과 판단 소유자가 Context Map에 맞는지 확인한다. 다른 BC의 데이터·Repository·내부 타입 접근이나 순환 의존이 있는지 계약과 호출을 읽어 점검한다.
- Aggregate 참조가 ID를 사용하고 클래스 다이어그램이 해당 BC 모델·관계와 일치하는지 확인한다. 다른 BC에 대한 통신은 공개 계약을 통해 이루어지는지 검토한다. 지속되는 결정 링크가 실제 ADR의 근거와 일치하는지도 확인한다.
- 관계 또는 판단 소유자는 `bounded-context`, Aggregate나 그림은 `aggregate-design`, 포트와 호출은 `application-service`로 돌려보낸다. 가장 앞선 실제 소유자를 [반환 계약](../domain-model/references/deepening.md#automatic-rewind-to-the-owner)으로 지정한다.
- 확인한 근거를 결과 요약에 기록하고 `completed / OK`를 반환한다. 실행기가 [최종 gate](../domain-model/references/deepening.md#relaunch-after-a-block)를 수행한다.

기존 번호형 문서는 [기존 템플릿](../domain-model/references/legacy-template.md)의 경계 및 결정 이력을 사용한다. 구형 `## 6. 결정 이력`은 결정과 ID를 보존하며 7절로 옮긴 뒤 6절을 완성한다.
