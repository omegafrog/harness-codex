from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_dispatch_prefers_message_then_reuse_then_spawn() -> None:
    lifecycle = _read(".codex/workflow/agent-lifecycle.md")

    send = lifecycle.index("`send_message`")
    reuse = lifecycle.index("`followup_task`")
    spawn = lifecycle.index("`spawn_agent`")
    assert send < reuse < spawn
    assert "reusable lease가 없을 때만 `spawn_agent`" in lifecycle
    assert "같은 key에 둘 이상의 agent를 두지 않는다" in lifecycle
    assert "orchestration agent를 하나만 유지" in lifecycle
    assert "동일 artifact revision의 reviewer" in lifecycle


def test_l3_is_owned_and_review_independence_is_preserved() -> None:
    lifecycle = _read(".codex/workflow/agent-lifecycle.md")

    assert "L3 document skill은 owning L2 agent가 직접 호출" in lifecycle
    assert "별도 agent를 spawn하지 않는다" in lifecycle
    assert "producer와 분리된 plan, implementation 또는 security review" in lifecycle


def test_slot_and_depth_failure_cannot_repeat_spawn() -> None:
    lifecycle = _read(".codex/workflow/agent-lifecycle.md")

    assert "slot 또는 depth 한도 실패 뒤 같은 인수로 spawn을 반복하지 않는다" in lifecycle
    assert "현재 cohort가 끝날 때까지" in lifecycle


def test_cohort_wait_has_one_path_and_no_normal_list_agents() -> None:
    lifecycle = _read(".codex/workflow/agent-lifecycle.md")

    assert "running cohort가 있을 때만 `wait_agent`를 한 번 호출" in lifecycle
    assert "정상 진행 확인을 위해 `list_agents`를 호출하지 않는다" in lifecycle
    assert "최초 topology 확인, compaction 복구" in lifecycle
    assert "독촉, 변화 없는 진행 상태는 보내지 않는다" in lifecycle


def test_executor_lease_is_batch_scoped_and_checkpointed() -> None:
    lifecycle = _read(".codex/workflow/agent-lifecycle.md")
    executor = _read(".codex/agents/references/implementation_executor.md")

    lease = "(ChangeSet ID, implementation_executor, Batch ID)"
    assert lease in lifecycle
    assert lease in executor
    assert "task 또는 commit 경계만으로 executor를 교체하지 않는다" in lifecycle
    for field in ("commit", "`EvidenceEnvelope`", "invalidated requirement", "remaining batch"):
        assert field in lifecycle


def test_visible_progress_dedup_is_not_agent_tool_control() -> None:
    lifecycle = _read(".codex/workflow/agent-lifecycle.md")
    progress = _read("harness_codex/runtime/session_progress.py")

    assert "Runtime은 Codex\ncollaboration tool을 가로채거나 agent를 선택하지 않는다" in lifecycle
    for tool in ("spawn_agent", "wait_agent", "list_agents"):
        assert tool not in progress
