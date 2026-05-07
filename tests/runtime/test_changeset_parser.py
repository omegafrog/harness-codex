from pathlib import Path

from harness_codex.runtime.changes import parse_changeset_markdown


CHANGESET = """# ChangeSet CHG-001

## 1. 메타데이터

|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|
|관련 이슈/요청|#23|

## 2. 구현 의도

- 요청 요약: parser 추가

## 3. Before / After

|구분|내용|
|---|---|
|Before|문서를 사람이 읽는다|
|After|런타임 모델로 읽는다|

## 4. 변경 문서

|문서|변경 유형|변경 이유|상태|
|---|---|---|---|
|`docs/use-cases/UC-001/use-case.md`|update|scope|planned|

## 5. 영향 유스케이스

|UC ID|유스케이스 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`UC-001`|결제 승인|update|`docs/use-cases/UC-001/`|planned|

## 7. Planner 입력 범위

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `.codex/repository-settings.md`

## 8. Scope Boundary

### 포함

- 결제 승인 UC

### 제외

- 정산 UC

### 금지 변경

- 승인되지 않은 E2E goal 변경 금지
"""

ENGLISH_CHANGESET = """# ChangeSet CHG-20260507-001

## 1. Metadata

|Item|Value|
|---|---|
|ChangeSet ID|`CHG-20260507-001`|
|Status|active|
|Related issue/request|calculator smoke test|

## 2. Implementation Intent

- Request summary: create a simple calculator app

## 3. Before / After

|Item|Value|
|---|---|
|Before|No calculator app exists|
|After|A calculator app can add, subtract, multiply, and divide numbers|

## 4. Changed Documents

|Document|Change Type|Reason|Status|
|---|---|---|---|
|`docs/use-cases/UC-001/use-case.md`|create|Define calculator usage|planned|

## 5. Affected Use Cases

|Use Case ID|Use Case Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
|`UC-001`|Use calculator|new|`docs/use-cases/UC-001/`|planned|

## 7. Planner Input Scope

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`

## 8. Scope Boundary

### Included

- Calculator arithmetic UI and behavior

### Excluded

- User accounts

### Forbidden Changes

- Do not add persistence
"""


def test_parse_changeset_markdown_extracts_core_fields() -> None:
    change_set = parse_changeset_markdown(
        CHANGESET,
        path=Path("docs/changes/active/CHG-001.md"),
    )

    assert change_set.change_set_id == "CHG-001"
    assert change_set.status == "active"
    assert change_set.related_issue == "#23"
    assert change_set.intent_summary == "parser 추가"
    assert change_set.before_summary == "문서를 사람이 읽는다"
    assert change_set.after_summary == "런타임 모델로 읽는다"


def test_parse_changeset_markdown_extracts_documents_and_use_cases() -> None:
    change_set = parse_changeset_markdown(CHANGESET)

    assert change_set.changed_documents[0].path == Path(
        "docs/use-cases/UC-001/use-case.md"
    )
    assert change_set.changed_documents[0].change_type == "update"

    affected = change_set.affected_use_cases[0]
    assert affected.uc_id == "UC-001"
    assert affected.name == "결제 승인"
    assert affected.impact_type == "update"
    assert affected.slice_path == Path("docs/use-cases/UC-001")


def test_parse_changeset_markdown_extracts_planner_scope_and_boundaries() -> None:
    change_set = parse_changeset_markdown(CHANGESET)

    assert Path("docs/changes/active/<CHG-ID>.md") in change_set.planner_inputs
    assert Path("docs/use-cases/<UC-ID>/e2e-goal.md") in change_set.planner_inputs
    assert "결제 승인 UC" in change_set.included_scope
    assert "정산 UC" in change_set.excluded_scope
    assert "승인되지 않은 E2E goal 변경 금지" in change_set.forbidden_changes


def test_parse_changeset_markdown_extracts_mixed_work_items() -> None:
    text = CHANGESET + """

## 6. 영향 maintenance
|Maintenance ID|작업 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`MAINT-001`|테스트 게이트 정리|update|`docs/maintenance/MAINT-001/`|planned|
"""

    change_set = parse_changeset_markdown(text)

    assert [item.work_item_id for item in change_set.ordered_work_items()] == [
        "UC-001",
        "MAINT-001",
    ]
    assert change_set.ordered_work_items()[1].work_item_type.value == "maintenance"


def test_parse_changeset_markdown_extracts_english_sections() -> None:
    change_set = parse_changeset_markdown(
        ENGLISH_CHANGESET,
        path=Path("docs/changes/active/CHG-20260507-001.md"),
    )

    assert change_set.change_set_id == "CHG-20260507-001"
    assert change_set.status == "active"
    assert change_set.related_issue == "calculator smoke test"
    assert change_set.intent_summary == "create a simple calculator app"
    assert change_set.before_summary == "No calculator app exists"
    assert change_set.after_summary == (
        "A calculator app can add, subtract, multiply, and divide numbers"
    )
    assert change_set.changed_documents[0].path == Path(
        "docs/use-cases/UC-001/use-case.md"
    )
    assert change_set.affected_use_cases[0].name == "Use calculator"
    assert Path("docs/use-cases/<UC-ID>/e2e-goal.md") in change_set.planner_inputs
    assert "Calculator arithmetic UI and behavior" in change_set.included_scope
    assert "User accounts" in change_set.excluded_scope
    assert "Do not add persistence" in change_set.forbidden_changes


def test_parse_changeset_markdown_extracts_english_maintenance_items() -> None:
    text = """# ChangeSet CHG-20260507-002

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet ID|`CHG-20260507-002`|
|Status|active|

## 6. Affected Maintenance
|Maintenance ID|Task Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
|`MAINT-001`|Clean test gate|update|`docs/maintenance/MAINT-001/`|planned|
"""

    change_set = parse_changeset_markdown(text)

    assert change_set.affected_maintenance_items[0].maintenance_id == "MAINT-001"
    assert change_set.affected_maintenance_items[0].name == "Clean test gate"
    assert change_set.ordered_work_items()[0].work_item_type.value == "maintenance"
