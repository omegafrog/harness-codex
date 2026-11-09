# Workflow 지도

요청과 기존 답변·위임을 확인하고 필요한 setup과 worktree를 준비한다. `spec-me`는 Product 요구와 Architecture를 작성하고 필요할 때만 내부 [기술 선택](../../technology-selection/GUIDE.md)을 수행한다. `spec-me` 내부의 fresh reviewer는 두 Spec만 독립 검토한다. diagram 적용 여부와 링크는 리뷰 전에 정하고 렌더는 리뷰 뒤 수행한다.

`to-ticket`은 두 Spec을 수직 계획으로 나누고, 같은 stage 안에서 fresh `plan_reviewer`에게 두 Spec·index·전체 계획 리뷰를 맡겨 통과할 때까지 반복한다. 실제 사용자 발행 승인 또는 명시적 위임 후 `tracker-publish`가 계획을 GitHub Project에 발행하고 저장소 Issue·sub-issue 관계·Beads mirror까지 활성화한다. 요청이 계획까지면 여기서 멈춘다. 구현 요청이 있으면 `implement-wrapper`가 계획별 구현과 독립 코드 리뷰를 수행한다. split plan은 하나씩 구현하며 전체 구현 후 Spec 기반 통합 코드 리뷰를 수행한다. 최종 통합에서만 통합 계약을 갱신하고 에이전트가 최종 E2E 시나리오를 작성해 사용자 실행 승인을 받는다. 승인 뒤 fresh `e2e_test_runner`가 E2E를 실행하고 완료 gate를 실행하며 실패 시 자동 수정·재실행 없이 사용자에게 확인한다.

정본은 `worktree.json`, 프로젝트 Spec·계획, session의 stage result·review history와 configured tracker의 발행 상태이다. runner는 실행 식별자와 현재성 기록을 관리하고 작성자는 제품 산출물을 작성한다. 추가 ledger를 만들지 않는다. stage 결과·미해결 findings와 gate, 사용자 질문별 답변·승인·위임, provider/session과 실제 process 상태를 확인해 다음 단계를 고른다. 요약이 부족하면 해당 정본을 읽는다. 완료된 조사는 재실행하지 않고 독립 질문은 묶으며 수정 요청은 소유 단계로 반환한다.

필수 독립 리뷰, 실제 승인, 실행 전제와 중복 process 방지는 생략하지 않는다. 같은 provider/session을 재개하고 진행 중 process의 생존 여부를 확인한다. 실패·취소 시 기록을 보존하며 worktree 삭제나 상태 수작업 변경으로 복구하지 않는다. 각 실행 절차는 [실행 조율](../GUIDE.md), 리뷰와 발행의 해당 GUIDE가 소유한다.
