from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


CONTRACT_VERSION = 1

FRONT_MATTER_RE = re.compile(r"\A---\n(?P<body>.*?)\n---\n?", re.DOTALL)

DOC_TYPES_BY_NAME = {
    "use-case.md": "use_case",
    "event-storming.md": "event_storming",
    "ddd-design.md": "ddd_design",
    "technical-decisions.md": "technical_decisions",
    "e2e-goal.md": "e2e_goal",
    "index.md": "use_case_index",
}


def parse_front_matter(text: str) -> dict[str, Any]:
    match = FRONT_MATTER_RE.match(text)
    if match is None:
        return {}

    metadata: dict[str, Any] = {}
    current_key = ""
    for raw_line in match.group("body").splitlines():
        if not raw_line.strip():
            continue
        if raw_line.startswith("  - ") and current_key:
            values = metadata.setdefault(current_key, [])
            if isinstance(values, list):
                values.append(_parse_scalar(raw_line[4:].strip()))
            continue
        if ":" not in raw_line:
            continue
        key, value = raw_line.split(":", maxsplit=1)
        current_key = key.strip()
        value = value.strip()
        metadata[current_key] = [] if value == "" else _parse_scalar(value)
    return metadata


def strip_front_matter(text: str) -> str:
    match = FRONT_MATTER_RE.match(text)
    if match is None:
        return text
    return text[match.end() :]


def apply_front_matter(text: str, metadata: dict[str, Any]) -> str:
    clean = strip_front_matter(text).lstrip("\n")
    return _render_front_matter(metadata) + clean


def approval_status_from_metadata_or_markdown(text: str) -> tuple[bool, str]:
    metadata = parse_front_matter(text)
    approval = metadata.get("approval_status")
    if isinstance(approval, str):
        return True, approval
    return approval_status_from_markdown(text)


def approval_status_from_markdown(text: str) -> tuple[bool, str]:
    for line in strip_front_matter(text).splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "---" in stripped:
            continue
        cells = [cell.strip().strip("`") for cell in stripped.strip("|").split("|")]
        if len(cells) >= 2 and cells[0] in {"Approval Status", "승인 상태"}:
            return True, cells[1]
    return False, ""


def infer_document_metadata(
    relative_path: Path,
    *,
    change_set_id: str = "",
    work_item_id: str = "",
    source_docs: tuple[Path, ...] = (),
    approval_status: str = "",
    status: str = "",
) -> dict[str, Any]:
    doc_type = _doc_type_for_path(relative_path)
    inferred_work_item_id = work_item_id or _work_item_id_for_path(relative_path)
    inferred_change_set_id = change_set_id or _change_set_id_for_path(relative_path)
    doc_id = _doc_id(doc_type, inferred_change_set_id, inferred_work_item_id)

    metadata: dict[str, Any] = {
        "doc_type": doc_type,
        "doc_id": doc_id,
        "contract_version": CONTRACT_VERSION,
    }
    if inferred_change_set_id:
        metadata["change_set_id"] = inferred_change_set_id
    if inferred_work_item_id:
        metadata["work_item_id"] = inferred_work_item_id
    if source_docs:
        metadata["source_docs"] = [str(path) for path in source_docs]
    if approval_status:
        metadata["approval_status"] = approval_status
    if status:
        metadata["status"] = status
    return metadata


def ensure_generated_document_metadata(
    repo_root: Path,
    relative_path: Path,
    *,
    change_set_id: str = "",
    work_item_id: str = "",
    source_docs: tuple[Path, ...] = (),
    approval_status: str = "",
    status: str = "",
    blockers: tuple[str, ...] = (),
    downstream_docs: tuple[Path, ...] = (),
) -> Path | None:
    if relative_path.suffix != ".md":
        return None
    if not generated_doc_type(relative_path):
        return None

    absolute_path = repo_root / relative_path
    if not absolute_path.exists():
        return None

    text = absolute_path.read_text(encoding="utf-8")
    metadata = infer_document_metadata(
        relative_path,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        source_docs=source_docs,
        approval_status=approval_status,
        status=status,
    )
    merged = {**metadata, **parse_front_matter(text)}
    updated = apply_front_matter(text, merged)
    if updated != text:
        absolute_path.write_text(updated, encoding="utf-8")
        text = updated

    return write_contract_sidecar(
        repo_root,
        relative_path,
        text,
        merged,
        blockers=blockers,
        upstream_docs=source_docs,
        downstream_docs=downstream_docs,
    )


def generated_doc_type(relative_path: Path) -> str:
    return _doc_type_for_path(relative_path)


def write_contract_sidecar(
    repo_root: Path,
    relative_path: Path,
    text: str,
    metadata: dict[str, Any],
    *,
    blockers: tuple[str, ...] = (),
    upstream_docs: tuple[Path, ...] = (),
    downstream_docs: tuple[Path, ...] = (),
) -> Path:
    payload = {
        "doc_type": metadata.get("doc_type", _doc_type_for_path(relative_path)),
        "doc_id": metadata.get("doc_id", ""),
        "path": str(relative_path),
        "checksum": _checksum(text),
        "contract_version": metadata.get("contract_version", CONTRACT_VERSION),
        "status": metadata.get("status", "ready" if not blockers else "blocked"),
        "approval_status": metadata.get("approval_status", ""),
        "change_set_id": metadata.get("change_set_id", ""),
        "work_item_id": metadata.get("work_item_id", ""),
        "blockers": list(blockers),
        "upstream_docs": [str(path) for path in upstream_docs],
        "downstream_docs": [str(path) for path in downstream_docs],
    }
    sidecar = contract_sidecar_path(relative_path, metadata)
    absolute_sidecar = repo_root / sidecar
    absolute_sidecar.parent.mkdir(parents=True, exist_ok=True)
    absolute_sidecar.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return sidecar


def contract_sidecar_path(relative_path: Path, metadata: dict[str, Any]) -> Path:
    doc_type = str(metadata.get("doc_type") or _doc_type_for_path(relative_path))
    change_set_id = str(
        metadata.get("change_set_id") or _change_set_id_for_path(relative_path)
    )
    work_item_id = str(
        metadata.get("work_item_id") or _work_item_id_for_path(relative_path)
    )
    if change_set_id and work_item_id:
        return (
            Path(".harness/contracts")
            / change_set_id
            / work_item_id
            / f"{doc_type}.contract.json"
        )
    if change_set_id:
        return Path(".harness/contracts") / change_set_id / f"{doc_type}.contract.json"
    return Path(".harness/contracts/repository") / f"{doc_type}.contract.json"


def _render_front_matter(metadata: dict[str, Any]) -> str:
    lines = ["---"]
    for key in sorted(metadata):
        value = metadata[key]
        if isinstance(value, list):
            lines.append(f"{key}:")
            for item in value:
                lines.append(f"  - {_format_scalar(item)}")
        else:
            lines.append(f"{key}: {_format_scalar(value)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def _parse_scalar(value: str) -> Any:
    if value in {"true", "false"}:
        return value == "true"
    if value.isdigit():
        return int(value)
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    return value


def _format_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    text = str(value)
    if (
        not text
        or text.strip() != text
        or any(ch in text for ch in ":#[]{}&,*?!|>'\"%@`")
    ):
        return json.dumps(text, ensure_ascii=False)
    return text


def _doc_type_for_path(relative_path: Path) -> str:
    parts = relative_path.parts
    if len(parts) >= 3 and parts[0] == "docs" and parts[1] == "changes":
        return "change_set"
    if (
        len(parts) >= 3
        and parts[0] == "docs"
        and parts[1] == "plans"
        and relative_path.name == "plan.md"
    ):
        return "plan"
    if len(parts) >= 2 and parts[0] == "docs" and parts[1] == "design":
        if relative_path.name == "요구사항.md":
            return "requirements"
        if relative_path.name == "ubiquitous-language.md":
            return "ubiquitous_language"
        if relative_path.name == "유스케이스.md":
            return "canonical_use_cases"
    if relative_path.name == "context.md":
        return "context"
    return DOC_TYPES_BY_NAME.get(relative_path.name, "")


def _work_item_id_for_path(relative_path: Path) -> str:
    parts = relative_path.parts
    if (
        len(parts) >= 3
        and parts[0] == "docs"
        and parts[1] in {"use-cases", "maintenance"}
    ):
        return parts[2]
    if len(parts) >= 4 and parts[0] == "docs" and parts[1] == "plans":
        return parts[3]
    return ""


def _change_set_id_for_path(relative_path: Path) -> str:
    parts = relative_path.parts
    if len(parts) >= 4 and parts[0] == "docs" and parts[1] == "changes":
        return relative_path.stem
    return ""


def _doc_id(doc_type: str, change_set_id: str, work_item_id: str) -> str:
    if work_item_id:
        return f"{work_item_id}:{doc_type}"
    if change_set_id:
        return f"{change_set_id}:{doc_type}"
    return doc_type


def _checksum(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
