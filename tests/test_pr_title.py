from harness_codex.runtime.change_set_pr_delivery import _pr_title
from harness_codex.runtime.changes.models import ChangeSet


def test_pr_title_is_capped_to_short_display_length() -> None:
    change_set = ChangeSet(
        change_set_id="CHG-20260706-001",
        title=(
            "사용자가 게이트웨이를 통해 접근하는 헬스 체크 또는 기존 상태 확인 응답에서 "
            "현재 실행 중인 티켓온 애플리케이션 버전을 확인할 수 있게 version 필드를 추가한다"
        ),
    )

    title = _pr_title(change_set)

    assert len(title) <= 72
    assert title.startswith("feat: CHG-20260706-001 ")
    assert title.endswith("…")
