"""Execute one DDD candidate per use case with deterministic artifact contracts."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Mapping


_CANDIDATE_SCHEMA_VERSION = 1
_REQUIRED_HEADINGS = (
    "## Impact Assessment",
    "## Entity / Value Objects",
    "## Behaviors",
    "## Application Flow",
    "## Aggregates",
    "## Bounded Contexts",
    "## Integration Impact",
    "## Architecture Visualization",
)


def apply_ddd_candidate_efficiency_patch() -> None:
    import harness_codex.runtime.harvest_ui as ui

    if getattr(ui, "_ddd_candidate_efficiency_patch_applied", False):
        return

    original_advance_all = ui._advance_all_ddd_architecture
    original_validate_slice = ui._validate_ddd_design_slice
    ui.DDD_RUN_ALL_TIMEOUT_SEC = ui.DDD_TIMEOUT_SEC

    def validate_slice(path: Path, completed_step: str) -> tuple[bool, str]:
        ready, error = original_validate_slice(path, completed_step)
        if not ready:
            return ready, error
        return _validate_visualization_contract(path)

    def candidate_advance(
        root,
        session: dict[str, Any],
        change_set_id: str,
        *,
        uc_id: str | None = None,
        step_id: str | None = None,
    ) -> None:
        state = session["ddd_architecture"]
        target_uc = uc_id or _first_incomplete_uc(ui, state)
        if target_uc is None:
            ui._refresh_ddd_completion(state)
            session["runtime_error"] = ""
            return
        targets = _targets_for_uc(ui, state, target_uc)
        if targets:
            _run_candidate(
                ui=ui,
                original_advance_all=original_advance_all,
                root=Path(root),
                session=session,
                change_set_id=change_set_id,
                uc_id=target_uc,
                targets=targets,
            )

    def candidate_advance_all(root, session: dict[str, Any], change_set_id: str, _targets) -> None:
        state = session["ddd_architecture"]
        for uc_id in state.get("uc_ids", []):
            targets = _targets_for_uc(ui, state, uc_id)
            if not targets:
                continue
            _run_candidate(
                ui=ui,
                original_advance_all=original_advance_all,
                root=Path(root),
                session=session,
                change_set_id=change_set_id,
                uc_id=uc_id,
                targets=targets,
            )
            if state.get("status") in {"needs_input", "error"}:
                return
        ui._refresh_ddd_completion(state)
        session["runtime_error"] = ""

    def candidate_contract(change_set_id: str, targets, state: dict[str, Any]) -> str:
        uc_ids = sorted({str(target["uc_id"]) for target in targets})
        if len(uc_ids) != 1:
            raise ValueError("DDD candidate invocation must target exactly one use case")
        uc_id = uc_ids[0]
        item = state["items"][uc_id]
        answers = {
            step_id: value.get("clarifications", [])
            for step_id, value in item.get("steps", {}).items()
            if value.get("clarifications")
        }
        return f"""## DDD Candidate Execution

Target ChangeSet: {change_set_id}
Target Use Case: {uc_id}

Create or repair the complete candidate at `docs/use-cases/{uc_id}/ddd-design.md`
in this one turn. Use the selected `harness-ddd-design` skill as the authoritative
format contract. Do not generate code or edit `ARCHITECTURE.md`.

The runtime accepts a `complete` result only when the candidate has all required
sections, exactly one Mermaid graph inside the `entity_vo` managed range, candidate
front matter matching this ChangeSet and use case, and an `event_storming` input hash
matching the current event-storming artifact. The runtime also rejects actual writes
outside this candidate file; `changed_files` is only a claim and is not authoritative.

Complete all DDD sections together: Impact Assessment, Entity / Value Objects,
Behaviors, Application Flow, Aggregates, Bounded Contexts, Integration Impact,
and one cumulative Mermaid graph. Use the selected slice first; read baseline
artifacts only when that slice lacks evidence for reuse or modification.

Return JSON keys: status, questions, changed_files, blocker, impact,
completed_steps, current_target.
- `complete`: all five DDD sections are complete.
- `needs_input`: exactly one question; `current_target` names the blocking section.
- `blocked`: an upstream evidence gap cannot be resolved by one answer.

Prior answers:
{json.dumps(answers, ensure_ascii=False)}
"""

    ui._validate_ddd_design_slice = validate_slice
    ui._advance_ddd_architecture = candidate_advance
    ui._advance_all_ddd_architecture = candidate_advance_all
    ui._ddd_run_all_contract = candidate_contract
    ui._ddd_candidate_efficiency_patch_applied = True


def _run_candidate(
    *,
    ui,
    original_advance_all,
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    uc_id: str,
    targets: list[dict[str, str]],
) -> None:
    state = session["ddd_architecture"]
    try:
        _prepare_fresh_candidate(root, state, uc_id)
        before = _git_snapshot(root)
        if before is None:
            raise ValueError("DDD candidate contract requires a Git worktree for write-scope verification")

        original_advance_all(root, session, change_set_id, targets)
        scope_error = _validate_candidate_write_scope(root, change_set_id, uc_id, before)
        if scope_error:
            raise ValueError(scope_error)

        if _all_complete(state, uc_id, targets):
            error = _validate_complete_candidate(root, change_set_id, uc_id)
            if error:
                raise ValueError(error)
            _write_candidate_receipt(root, change_set_id, uc_id, status="accepted")
    except (OSError, ValueError) as exc:
        _mark_candidate_error(ui, state, uc_id, targets, str(exc))
        session["runtime_error"] = str(exc)


def _prepare_fresh_candidate(root: Path, state: Mapping[str, Any], uc_id: str) -> None:
    steps = state["items"][uc_id]["steps"]
    if any(step.get("status") == "complete" for step in steps.values()):
        return
    path = root / "docs" / "use-cases" / uc_id / "ddd-design.md"
    if path.is_symlink():
        raise ValueError(f"DDD candidate output must not be a symlink: {path}")
    if path.is_dir():
        raise ValueError(f"DDD candidate output must be a file: {path}")
    path.unlink(missing_ok=True)


def _all_complete(state: Mapping[str, Any], uc_id: str, targets: list[dict[str, str]]) -> bool:
    steps = state["items"][uc_id]["steps"]
    return bool(targets) and all(steps[target["step_id"]].get("status") == "complete" for target in targets)


def _validate_candidate_write_scope(root: Path, change_set_id: str, uc_id: str, before: Mapping[str, str]) -> str:
    after = _git_snapshot(root)
    if after is None:
        return "DDD candidate contract could not read the Git worktree after execution"
    changed = sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path))
    allowed = {f"docs/use-cases/{uc_id}/ddd-design.md"}
    disallowed = [path for path in changed if path not in allowed and not path.startswith(".harness/")]
    _write_scope_receipt(root, change_set_id, uc_id, changed, disallowed)
    if disallowed:
        return "DDD candidate wrote outside its declared output: " + ", ".join(disallowed)
    return ""


def _git_snapshot(root: Path) -> dict[str, str] | None:
    probe = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        return None
    paths: set[str] = set()
    for command in (
        ["git", "diff", "--name-only"],
        ["git", "diff", "--name-only", "--cached"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    ):
        completed = subprocess.run(command, cwd=root, text=True, capture_output=True, check=False)
        if completed.returncode == 0:
            paths.update(line.strip() for line in completed.stdout.splitlines() if line.strip())
    return {relative: _path_digest(root / relative) for relative in sorted(paths)}


def _path_digest(path: Path) -> str:
    if path.is_file():
        return "file:" + hashlib.sha256(path.read_bytes()).hexdigest()
    if path.is_dir():
        digest = hashlib.sha256()
        for child in sorted(item for item in path.rglob("*") if item.is_file()):
            digest.update(str(child.relative_to(path)).encode("utf-8"))
            digest.update(child.read_bytes())
        return "dir:" + digest.hexdigest()
    return "missing"


def _validate_visualization_contract(path: Path) -> tuple[bool, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False, f"unreadable DDD candidate: {path}"
    if text.count("```mermaid") != 1:
        return False, f"DDD candidate must contain exactly one Mermaid graph: {path}"
    start = "<!-- harness:ddd-visualization:entity_vo:start -->"
    end = "<!-- harness:ddd-visualization:entity_vo:end -->"
    if text.count(start) != 1 or text.count(end) != 1:
        return False, f"DDD candidate must contain one entity_vo visualization managed range: {path}"
    section = text.find("## Architecture Visualization")
    range_start = text.find(start)
    graph_start = text.find("```mermaid")
    range_end = text.find(end)
    graph_end = text.find("```", graph_start + len("```mermaid"))
    if section < 0 or not (section < range_start < graph_start < graph_end < range_end):
        return False, f"DDD Mermaid graph must be closed inside Architecture Visualization entity_vo range: {path}"
    return True, ""


def _validate_complete_candidate(root: Path, change_set_id: str, uc_id: str) -> str:
    relative = Path("docs") / "use-cases" / uc_id / "ddd-design.md"
    path = root / relative
    if not path.is_file() or path.is_symlink():
        return f"DDD candidate output must be a regular file: {path}"
    text = path.read_text(encoding="utf-8")
    for heading in _REQUIRED_HEADINGS:
        if len(re.findall(rf"(?m)^{re.escape(heading)}\s*$", text)) != 1:
            return f"DDD candidate must contain exactly one `{heading}` heading"
    ready, error = _validate_visualization_contract(path)
    if not ready:
        return error
    front_matter = _front_matter(text)
    if not front_matter:
        return "DDD candidate is missing required YAML front matter"
    if _front_value(front_matter, "status") != "candidate":
        return "DDD candidate front matter must declare `status: candidate`"
    if _front_value(front_matter, "change_set") != change_set_id:
        return f"DDD candidate front matter change_set must equal `{change_set_id}`"
    if _front_value(front_matter, "work_item") != uc_id:
        return f"DDD candidate front matter work_item must equal `{uc_id}`"

    event_path = root / "docs" / "use-cases" / uc_id / "event-storming.md"
    if not event_path.is_file():
        return f"DDD candidate is missing event-storming input: {event_path}"
    expected_event_hash = hashlib.sha256(event_path.read_bytes()).hexdigest()
    actual_event_hash = _front_value(front_matter, "event_storming")
    if actual_event_hash != f"sha256:{expected_event_hash}":
        return "DDD candidate event_storming input hash does not match current event-storming artifact"

    _write_document_contract_sidecar(
        root=root,
        relative=relative,
        text=text,
        change_set_id=change_set_id,
        uc_id=uc_id,
    )
    return ""


def _write_document_contract_sidecar(
    *,
    root: Path,
    relative: Path,
    text: str,
    change_set_id: str,
    uc_id: str,
) -> None:
    from harness_codex.runtime.document_metadata import infer_document_metadata, write_contract_sidecar

    source_docs = (
        Path("docs") / "changes" / "active" / f"{change_set_id}.md",
        Path("docs") / "use-cases" / uc_id / "use-case.md",
        Path("docs") / "use-cases" / uc_id / "event-storming.md",
        Path("docs") / "use-cases" / uc_id / "e2e-goal.md",
    )
    metadata = infer_document_metadata(
        relative,
        change_set_id=change_set_id,
        work_item_id=uc_id,
        source_docs=source_docs,
        status="candidate",
    )
    write_contract_sidecar(root, relative, text, metadata, upstream_docs=source_docs)


def _front_matter(text: str) -> str:
    match = re.match(r"\A---\n(?P<body>.*?)\n---\n?", text, flags=re.DOTALL)
    return match.group("body") if match else ""


def _front_value(front_matter: str, key: str) -> str:
    match = re.search(rf"(?m)^\s*{re.escape(key)}:\s*(\S+)\s*$", front_matter)
    return match.group(1).strip("'\"") if match else ""


def _write_scope_receipt(root: Path, change_set_id: str, uc_id: str, changed: list[str], disallowed: list[str]) -> None:
    _write_json(
        root / ".harness" / "contracts" / change_set_id / uc_id / "ddd-candidate-scope.json",
        {
            "schema_version": _CANDIDATE_SCHEMA_VERSION,
            "change_set_id": change_set_id,
            "work_item_id": uc_id,
            "status": "blocked" if disallowed else "accepted",
            "changed_files": changed,
            "disallowed_files": disallowed,
        },
    )


def _write_candidate_receipt(root: Path, change_set_id: str, uc_id: str, *, status: str) -> None:
    output = root / "docs" / "use-cases" / uc_id / "ddd-design.md"
    _write_json(
        root / ".harness" / "contracts" / change_set_id / uc_id / "ddd-candidate.runtime.json",
        {
            "schema_version": _CANDIDATE_SCHEMA_VERSION,
            "change_set_id": change_set_id,
            "work_item_id": uc_id,
            "status": status,
            "output": str(output.relative_to(root)),
            "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        },
    )


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _mark_candidate_error(ui, state: dict[str, Any], uc_id: str, targets: list[dict[str, str]], error: str) -> None:
    item = state["items"][uc_id]
    for target in targets:
        step = item["steps"][target["step_id"]]
        step["status"] = "error"
        step["error"] = error
        step["current_question"] = None
    ui._refresh_ddd_completion(state)
    state["current_uc"] = uc_id
    state["current_step"] = targets[0]["step_id"]
    state["status"] = "error"
    state["complete"] = False


def _first_incomplete_uc(ui, state: dict[str, Any]) -> str | None:
    for uc_id in state.get("uc_ids", []):
        if _targets_for_uc(ui, state, uc_id):
            return str(uc_id)
    return None


def _targets_for_uc(ui, state: dict[str, Any], uc_id: str) -> list[dict[str, str]]:
    steps = state["items"][uc_id]["steps"]
    return [
        {"uc_id": uc_id, "step_id": step_id, "label": label}
        for step_id, label in ui.DDD_STEPS
        if steps.get(step_id, {}).get("status") in {"pending", "running", "error", "stale"}
    ]
