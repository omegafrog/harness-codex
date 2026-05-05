from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_doc(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_docs_readme_defines_changeset_and_use_case_slice_structure() -> None:
    readme = read_doc("docs/README.md")

    required_paths = [
        "docs/changes/active/<CHG-ID>.md",
        "docs/changes/completed/<CHG-ID>.md",
        "docs/use-cases/<UC-ID>/",
        "docs/use-cases/<UC-ID>/e2e-goal.md",
        "docs/use-cases/<UC-ID>/affected-files.md",
        "docs/plans/active/<UC-ID>/plan.md",
        "docs/plans/completed/<UC-ID>/plan.md",
    ]

    for path in required_paths:
        assert path in readme

    assert "Before" in readme
    assert "After" in readme
    assert "planner/executor" in readme
    assert "DOCUMENT_DELTA_CONFLICT" in readme
    assert "UPSTREAM_DESIGN_CONFLICT" in readme


def test_change_set_template_contains_required_planner_scope() -> None:
    template = read_doc("docs/templates/changes/change-set.md")

    required_sections = [
        "## 3. Before / After",
        "## 4. 변경 문서",
        "## 5. 영향 유스케이스",
        "## 6. E2E 목표 변경",
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
        "docs/use-cases/<UC-ID>/affected-files.md",
        ".codex/repository-settings.md",
    ]

    for input_path in required_inputs:
        assert input_path in template


def test_use_case_templates_cover_executor_inputs_and_e2e_gate() -> None:
    template_paths = [
        "docs/templates/use-cases/index.md",
        "docs/templates/use-cases/use-case.md",
        "docs/templates/use-cases/event-storming.md",
        "docs/templates/use-cases/ddd-design.md",
        "docs/templates/use-cases/technical-decisions.md",
        "docs/templates/use-cases/e2e-goal.md",
        "docs/templates/use-cases/affected-files.md",
    ]

    for path in template_paths:
        assert (REPO_ROOT / path).is_file()

    e2e_goal = read_doc("docs/templates/use-cases/e2e-goal.md")
    affected_files = read_doc("docs/templates/use-cases/affected-files.md")

    assert "## 3. Given / When / Then" in e2e_goal
    assert "./gradlew build" in e2e_goal
    assert "./gradlew test" in e2e_goal
    assert "./gradlew e2eTest" in e2e_goal
    assert ".codex/test-gate.yaml" in e2e_goal

    assert "## 2. 예상 변경 파일" in affected_files
    assert "## 5. 금지 파일/경로" in affected_files
    assert "docs/use-cases/<다른-UC-ID>/" in affected_files
