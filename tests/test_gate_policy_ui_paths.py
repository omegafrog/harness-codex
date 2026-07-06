from harness_codex.runtime.gate_policy import reconcile_observed_change_gates
from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.gate_policy import derive_gate_policy


def test_java_server_ui_package_does_not_require_browser_gate() -> None:
    policy = derive_gate_policy(
        work_item_id="UC-001",
        work_item_type=WorkItemType.USE_CASE,
        impact_type="source-code, user-feature",
    )

    escalations = reconcile_observed_change_gates(
        (policy,),
        (
            "platform/gateway/src/main/java/org/codenbug/gateway/statuscheck/ui/StatusCheckHealthEndpointExtension.java",
        ),
    )

    assert {item.gate_id for item in escalations} == set()
