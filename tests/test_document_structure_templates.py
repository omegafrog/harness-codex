from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_doc(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_docs_tree_keeps_only_workflow_artifact_roots() -> None:
    allowed_roots = {"changes", "design", "maintenance", "plans", "use-cases"}
    actual_roots = {
        path.name for path in (REPO_ROOT / "docs").iterdir() if path.is_dir()
    }

    assert actual_roots <= allowed_roots
    assert (REPO_ROOT / ".harness/docs/agent").is_dir()
    assert (REPO_ROOT / ".harness/docs/templates").is_dir()


def test_docs_readme_defines_changeset_and_use_case_slice_structure() -> None:
    readme = read_doc(".harness/docs/README.md")

    required_paths = [
        "docs/changes/active/<CHG-ID>.md",
        "docs/changes/completed/<CHG-ID>.md",
        "docs/use-cases/<UC-ID>/",
        "docs/use-cases/<UC-ID>/e2e-goal.md",
        "docs/maintenance/<MAINT-ID>/",
        "docs/maintenance/<MAINT-ID>/change-intent.md",
        "docs/maintenance/<MAINT-ID>/verification-goal.md",
        "docs/plans/active/<UC-ID>/plan.md",
        "docs/plans/completed/<UC-ID>/plan.md",
        "docs/plans/active/<MAINT-ID>/plan.md",
        "docs/plans/completed/<MAINT-ID>/plan.md",
    ]

    for path in required_paths:
        assert path in readme

    assert "Before" in readme
    assert "After" in readme
    assert "MAINT-001" in readme
    assert "maintenance slice" in readme
    assert "planner/executor" in readme
    assert "DOCUMENT_DELTA_CONFLICT" in readme
    assert "UPSTREAM_DESIGN_CONFLICT" in readme


def test_change_set_template_contains_required_planner_scope() -> None:
    template = read_doc(".harness/docs/templates/changes/change-set.md")

    required_sections = [
        "## 3. Before / After",
        "## 4. 변경 문서",
        "## 5. 영향 Work Item",
        "## 6. 검증 목표 변경",
        "## 7. Planner 입력 범위",
        "## 8. Scope Boundary",
        "## 10. 완료 조건",
    ]

    for section in required_sections:
        assert section in template

    required_inputs = [
        "docs/changes/active/<CHG-ID>.md",
        "docs/use-cases/<UC-ID>/use-case.md",
        "docs/use-cases/<UC-ID>/event-storming.md",
        "docs/use-cases/<UC-ID>/e2e-goal.md",
        "docs/maintenance/<MAINT-ID>/change-intent.md",
        "docs/maintenance/<MAINT-ID>/technical-decisions.md",
        "docs/maintenance/<MAINT-ID>/verification-goal.md",
        ".codex/repository-settings.md",
    ]

    for input_path in required_inputs:
        assert input_path in template

    assert "use_case" in template
    assert "maintenance" in template


def test_use_case_templates_cover_executor_inputs_and_e2e_gate() -> None:
    template_paths = [
        ".harness/docs/templates/use-cases/index.md",
        ".harness/docs/templates/use-cases/use-case.md",
        ".harness/docs/templates/use-cases/event-storming.md",
        ".harness/docs/templates/use-cases/ddd-design.md",
        ".harness/docs/templates/use-cases/technical-decisions.md",
        ".harness/docs/templates/use-cases/e2e-goal.md",
        ".harness/docs/templates/plans/verification.md",
    ]

    for path in template_paths:
        assert (REPO_ROOT / path).is_file()

    e2e_goal = read_doc(".harness/docs/templates/use-cases/e2e-goal.md")
    verification = read_doc(".harness/docs/templates/plans/verification.md")

    assert "## 3. Given / When / Then" in e2e_goal
    assert "## 4. Business Success Criteria" in e2e_goal
    assert "## 5. Business Failure Criteria" in e2e_goal
    assert "## 6. Observability Boundary" in e2e_goal
    assert "./gradlew build" not in e2e_goal
    assert "./gradlew test" not in e2e_goal
    assert "./gradlew e2eTest" not in e2e_goal
    assert ".codex/test-gate.yaml" not in e2e_goal

    assert "## 2. Test Suite" in verification
    assert "## 3. Fixtures" in verification
    assert "## 4. API Examples" in verification
    assert "## 5. UI Steps" in verification
    assert "## 8. Actual Results" in verification

def test_maintenance_templates_cover_intent_scope_and_verification_goal() -> None:
    template_paths = [
        ".harness/docs/templates/maintenance/index.md",
        ".harness/docs/templates/maintenance/change-intent.md",
        ".harness/docs/templates/maintenance/technical-decisions.md",
        ".harness/docs/templates/maintenance/verification-goal.md",
    ]

    for path in template_paths:
        assert (REPO_ROOT / path).is_file()

    index = read_doc(".harness/docs/templates/maintenance/index.md")
    change_intent = read_doc(".harness/docs/templates/maintenance/change-intent.md")
    verification_goal = read_doc(".harness/docs/templates/maintenance/verification-goal.md")

    assert "docs/plans/active/<MAINT-ID>/plan.md" in index
    assert "docs/plans/completed/<MAINT-ID>/plan.md" in index
    assert "## 3. Before / After" in change_intent
    assert "## 4. Scope Boundary" in change_intent
    assert "## 3. Given / When / Then" in verification_goal
    assert "./venv/bin/python3 -m pytest -q -s" in verification_goal
    assert ".codex/test-gate.yaml" in verification_goal
