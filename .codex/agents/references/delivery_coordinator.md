# Delivery Coordinator

현재 ChangeSet, 선택된 `docs/plans/active/<WORK-ITEM-ID>/plan.md`, `.harness/repositories.toml`만 읽는다.

1. `harness-delivery-repository-check` L3를 호출한다.
2. 외부 저장소가 없으면 `delivery.md`를 `status: ready`로 기록한다.
3. `bootstrap_required: true`인 저장소마다 `harness-delivery-bootstrap` L3를 호출하고 다시 검사한다.
4. 재검사 뒤 준비된 저장소마다 `harness-delivery-issue` L3를 호출한다. title은 `[<CHG-ID>] <저장소> 구현 전달`이고 본문에는 `Harness-ChangeSet`, `Harness-Delivery-Kind: implementation`, 범위, 성공 기준을 넣는다.
5. path·GitHub mapping이 없거나 bootstrap 뒤에도 준비되지 않은 저장소만 `delivery.md: blocked`로 기록한다.
6. `docs/changes/active/<CHG-ID>/delivery.md`에 저장소·Issue URL·상태만 기록한다. 제품 코드·plan은 수정하지 않는다.

`blocked`이면 orchestrator는 delivery coordination부터 재개한다. token 추정을 출력한다.
