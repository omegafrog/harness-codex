from pathlib import Path

import pytest

from harness_codex.runtime.changes.design_bridge import (
    DesignBridgeError,
    create_changeset_from_design,
)


def write_requirements(repo: Path) -> None:
    design_dir = repo / "docs/design"
    design_dir.mkdir(parents=True, exist_ok=True)
    (design_dir / "요구사항.md").write_text(
        "# Requirements Specification\n\n## 1. Overview\n- Goal: Build a calculator.\n",
        encoding="utf-8",
    )


def write_unparsable_use_case_doc(repo: Path) -> None:
    design_dir = repo / "docs/design"
    design_dir.mkdir(parents=True, exist_ok=True)
    (design_dir / "유스케이스.md").write_text(
        """# Use Case Document

## 2. High-Level Use Case List

| Use Case ID | Name |
|---|---|
| `UC-001` | 사용자가 계산 결과를 확인한다 |
""",
        encoding="utf-8",
    )


def write_use_case_slice(repo: Path, uc_id: str = "UC-001") -> None:
    use_case_dir = repo / "docs/use-cases" / uc_id
    use_case_dir.mkdir(parents=True, exist_ok=True)
    (use_case_dir / "use-case.md").write_text(
        f"""# {uc_id}. 사용자가 계산 결과를 확인한다

## Goal
- 사용자는 계산 결과를 확인한다.

## Main Flow
1. 사용자가 숫자와 연산자를 입력한다.
2. 시스템이 계산 결과를 보여준다.
""",
        encoding="utf-8",
    )
    (use_case_dir / "e2e-goal.md").write_text(
        f"# {uc_id} E2E Goal\n\n## Then\n- 계산 결과가 표시된다.\n",
        encoding="utf-8",
    )


def test_create_from_design_falls_back_to_generated_use_case_slices(tmp_path: Path) -> None:
    write_requirements(tmp_path)
    write_unparsable_use_case_doc(tmp_path)
    write_use_case_slice(tmp_path)

    result = create_changeset_from_design(
        tmp_path,
        title="계산기",
        change_set_id="CHG-20260521-001",
    )

    assert result.change_set_id == "CHG-20260521-001"
    assert len(result.use_cases) == 1
    assert result.use_cases[0].uc_id == "UC-001"
    assert result.use_cases[0].name == "사용자가 계산 결과를 확인한다"
    assert (tmp_path / "docs/changes/active/CHG-20260521-001.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/use-case.md").read_text(encoding="utf-8").startswith(
        "# UC-001. 사용자가 계산 결과를 확인한다"
    )
    assert (tmp_path / "docs/use-cases/UC-001/event-storming.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/affected-files.md").is_file()


def test_create_from_design_filters_slice_fallback_by_selected_use_case(tmp_path: Path) -> None:
    write_requirements(tmp_path)
    write_unparsable_use_case_doc(tmp_path)
    write_use_case_slice(tmp_path, "UC-001")
    write_use_case_slice(tmp_path, "UC-002")

    result = create_changeset_from_design(
        tmp_path,
        title="계산기",
        change_set_id="CHG-20260521-002",
        selected_use_cases=("UC-002",),
    )

    assert [use_case.uc_id for use_case in result.use_cases] == ["UC-002"]


def test_create_from_design_reports_both_sources_when_no_use_cases_exist(tmp_path: Path) -> None:
    write_requirements(tmp_path)
    write_unparsable_use_case_doc(tmp_path)

    with pytest.raises(DesignBridgeError, match="docs/use-cases/UC-.*/use-case.md"):
        create_changeset_from_design(
            tmp_path,
            title="계산기",
            change_set_id="CHG-20260521-003",
        )
