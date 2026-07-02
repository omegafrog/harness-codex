"""Small HTTP API for the local harvest UI."""

from __future__ import annotations

import argparse
import errno
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from harness_codex.runtime.document_dashboard import (
    DashboardChangeSetNotFound,
    DashboardDocumentConflict,
    DashboardDocumentNotFound,
    DashboardDocumentValidationError,
    document_dashboard_state,
    delete_active_changeset,
    read_dashboard_document,
    save_dashboard_document,
)
from harness_codex.runtime.changes.resolver import ChangeSetResolver, PlanningBlocked
from harness_codex.runtime.change_set_delivery import DELIVERY_APPROVAL_ENV
from harness_codex.runtime.harvest_ui import (
    activate_changeset_harvest_ui,
    advance_ddd_architecture,
    advance_event_storming,
    answer_ddd_architecture,
    answer_event_storming,
    answer_use_cases,
    answer_requirements,
    begin_run_all_ddd_architecture,
    complete_ubiquitous_language,
    finish_run_all_ddd_architecture,
    load_changeset_harvest_ui,
    load_harvest_ui,
    rerun_ddd_architecture_step,
    restart_ddd_architecture,
    save_changeset_harvest_ui,
    start_requirements,
    start_ddd_architecture,
    start_event_storming,
    start_ubiquitous_language,
    start_use_case_generation,
    start_use_cases,
)
from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    procedure_stage,
    render_initial_changeset,
    update_changeset_stage_status,
)


_RERUNNABLE_DESIGN_STAGE_IDS = {
    "requirements-definition",
    "ubiquitous-language-definition",
    "use-case-definition",
    "event-storming",
    "ddd-architecture-definition",
    "technical-decisions",
    "plan-writing",
}

_IMPLEMENTATION_LOOP_PHASES: tuple[tuple[str, str], ...] = (
    ("implementation", "구현"),
    ("focused-tests", "집중 테스트"),
    ("build", "빌드"),
    ("runtime-e2e", "런타임 E2E"),
    ("closure", "완료 정리"),
)


_SERVER_ENDPOINTS: tuple[tuple[str, str, str], ...] = (
    ("GET", "/", "dashboard"),
    ("GET", "/dashboard", "dashboard"),
    ("GET", "/assets/dashboard.css", "dashboard stylesheet"),
    ("GET", "/assets/dashboard.js", "dashboard script"),
    ("GET", "/api/endpoints", "endpoint discovery"),
    ("GET", "/api/harvest", "harvest session state"),
    ("GET", "/api/dashboard", "dashboard document state"),
    ("GET", "/api/dashboard/change-sets/{change_set_id}/resume", "resume scoped ChangeSet"),
    ("GET", "/api/dashboard/change-sets/{change_set_id}/activity", "recent workflow agent activity"),
    ("GET", "/api/dashboard/change-sets/{change_set_id}/rerun-stage", "design stage rerun progress"),
    ("GET", "/api/dashboard/change-sets/{change_set_id}/planning", "plan-writing progress"),
    ("GET", "/api/dashboard/change-sets/{change_set_id}/implementation", "implementation progress"),
    (
        "GET",
        "/api/dashboard/change-sets/{change_set_id}/implementation/diff?path={path}",
        "implementation diff file",
    ),
    (
        "GET",
        "/api/dashboard/change-sets/{change_set_id}/implementation/source?path={path}",
        "implementation source file",
    ),
    ("GET", "/api/dashboard/documents/{document_id}", "read dashboard document"),
    ("POST", "/api/change-sets/requirements/start", "start requirements ChangeSet"),
    ("POST", "/api/change-sets/requirements/answer", "answer requirements question"),
    ("POST", "/api/requirements/start", "start requirements"),
    ("POST", "/api/requirements/answer", "answer requirements"),
    ("POST", "/api/ubiquitous-language/start", "start ubiquitous-language confirmation"),
    ("POST", "/api/ubiquitous-language/complete", "complete ubiquitous-language confirmation"),
    ("POST", "/api/use-cases/start", "start use-case generation"),
    ("POST", "/api/use-cases/answer", "answer use-case question"),
    ("POST", "/api/use-cases/complete", "complete use-case generation"),
    ("POST", "/api/event-storming/start", "start event storming"),
    ("POST", "/api/event-storming/advance", "advance event storming"),
    ("POST", "/api/event-storming/answer", "answer event storming question"),
    ("POST", "/api/ddd-architecture/start", "start DDD architecture"),
    ("POST", "/api/ddd-architecture/restart", "restart DDD architecture"),
    ("POST", "/api/ddd-architecture/advance", "advance DDD architecture"),
    ("POST", "/api/ddd-architecture/run-all", "run all remaining DDD architecture substeps"),
    ("POST", "/api/ddd-architecture/rerun-step", "rerun DDD architecture step"),
    ("POST", "/api/ddd-architecture/answer", "answer DDD architecture question"),
    ("POST", "/api/dashboard/change-sets/{change_set_id}/rerun-stage", "rerun design stage"),
    ("POST", "/api/dashboard/change-sets/{change_set_id}/planning/start", "start plan writing"),
    ("POST", "/api/dashboard/change-sets/{change_set_id}/implementation/start", "start implementation"),
    ("POST", "/api/dashboard/change-sets/{change_set_id}/delivery/start", "start PR delivery"),
    ("PUT", "/api/dashboard/documents/{document_id}", "save dashboard document"),
    ("DELETE", "/api/dashboard/change-sets/{change_set_id}", "delete active ChangeSet"),
)

_PLAN_WRITING_JOBS: dict[str, dict[str, Any]] = {}
_PLAN_WRITING_JOBS_LOCK = threading.Lock()
_IMPLEMENTATION_JOBS: dict[str, dict[str, Any]] = {}
_IMPLEMENTATION_JOBS_LOCK = threading.Lock()
_DELIVERY_JOBS: dict[str, dict[str, Any]] = {}
_DELIVERY_JOBS_LOCK = threading.Lock()
_STAGE_RERUN_JOBS: dict[str, dict[str, Any]] = {}
_STAGE_RERUN_JOBS_LOCK = threading.Lock()
_DDD_RUN_ALL_JOBS: dict[str, dict[str, Any]] = {}
_DDD_RUN_ALL_JOBS_LOCK = threading.Lock()
_DIFF_PATCH_LIMIT = 200_000
_DIFF_EXPLORER_SOURCE_SUFFIXES = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".css",
    ".go",
    ".gradle",
    ".groovy",
    ".h",
    ".hpp",
    ".html",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".mjs",
    ".py",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
}
_DIFF_EXPLORER_SOURCE_NAMES = {
    "dockerfile",
    "gradlew",
    "makefile",
}
_DIFF_EXPLORER_EXCLUDED_PARTS = {
    ".git",
    ".gradle",
    ".harness",
    "__pycache__",
    "build",
    "out",
    "target",
}
_ACTIVITY_TAIL_BYTES = 32_768
_ACTIVITY_LIMIT = 80
_PERSISTED_STAGE_RERUN_STATUSES = {"needs_input", "blocked", "failed"}


def _ui_server_pid_path(repo_root: Path) -> Path:
    return repo_root / ".harness" / "ui-server.pid"


def _stage_rerun_job_dir(repo_root: Path) -> Path:
    return repo_root / ".harness" / "ui" / "stage-rerun-jobs"


def _stage_rerun_job_path(repo_root: Path, change_set_id: str) -> Path:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", change_set_id.strip())
    return _stage_rerun_job_dir(repo_root) / f"{safe_id}.json"


def _persistable_stage_rerun_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in job.items()
        if key
        in {
            "change_set_id",
            "stage_id",
            "uc_id",
            "status",
            "started_at",
            "started_at_epoch",
            "finished_at",
            "finished_at_epoch",
            "returncode",
            "output",
            "error",
            "pending_questions",
        }
    }


def _save_stage_rerun_job(root: Path, job: dict[str, Any]) -> None:
    path = _stage_rerun_job_path(root, str(job.get("change_set_id", "")))
    status = str(job.get("status", ""))
    if status not in _PERSISTED_STAGE_RERUN_STATUSES:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(_persistable_stage_rerun_job(job), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _load_stage_rerun_job(root: Path, change_set_id: str) -> dict[str, Any] | None:
    path = _stage_rerun_job_path(root, change_set_id)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _load_latest_needs_input_stage_session(root, change_set_id)
    if not isinstance(data, dict):
        return _load_latest_needs_input_stage_session(root, change_set_id)
    if data.get("change_set_id") != change_set_id:
        return _load_latest_needs_input_stage_session(root, change_set_id)
    status = str(data.get("status", ""))
    if status not in _PERSISTED_STAGE_RERUN_STATUSES:
        return _load_latest_needs_input_stage_session(root, change_set_id)
    questions = data.get("pending_questions", [])
    if not isinstance(questions, list):
        data["pending_questions"] = []
    if data.get("status") == "needs_input" and not data.get("pending_questions"):
        output = data.get("output")
        if isinstance(output, str) and output:
            data["pending_questions"] = _stage_rerun_pending_questions(root, output)
    return data


def _load_latest_needs_input_stage_session(
    root: Path,
    change_set_id: str,
) -> dict[str, Any] | None:
    runs_dir = root / ".harness" / "runs"
    candidates = sorted(
        runs_dir.glob("*/grill-me-session.json"),
        key=lambda path: path.stat().st_mtime_ns if path.exists() else 0,
        reverse=True,
    )
    for session_path in candidates:
        try:
            session = json.loads(session_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(session, dict):
            continue
        if session.get("change_set_id") != change_set_id:
            continue
        if session.get("status") != "needs_input":
            continue
        questions = session.get("pending_questions", [])
        if not isinstance(questions, list) or not questions:
            continue
        mtime = session_path.stat().st_mtime
        timestamp = datetime.fromtimestamp(mtime).isoformat(timespec="seconds")
        job = {
            "change_set_id": change_set_id,
            "stage_id": str(session.get("stage", "")),
            "uc_id": str(session.get("uc_id", "") or ""),
            "status": "needs_input",
            "started_at": timestamp,
            "started_at_epoch": mtime,
            "finished_at": timestamp,
            "finished_at_epoch": mtime,
            "returncode": 0,
            "output": f"Restored pending questions from {session_path.relative_to(root)}",
            "error": "",
            "pending_questions": questions,
        }
        _save_stage_rerun_job(root, job)
        return job
    return None


def _terminate_previous_ui_server(repo_root: Path, host: str, port: int) -> bool:
    pid_path = _ui_server_pid_path(repo_root)
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, ValueError):
        return False
    process_matches = _is_harness_ui_server_process(pid)
    owns_port = _process_owns_listen_port(pid, host, port) if process_matches is False else False
    if pid <= 0 or pid == os.getpid() or (process_matches is False and not owns_port):
        pid_path.unlink(missing_ok=True)
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pid_path.unlink(missing_ok=True)
        return False
    return True


def _terminate_ui_server_on_port(host: str, port: int) -> bool:
    pid = _ui_server_pid_on_port(host, port)
    if pid is None or pid == os.getpid():
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    return True


def _ui_server_pid_on_port(host: str, port: int) -> int | None:
    listen_inodes = _listen_socket_inodes(host, port)
    if not listen_inodes:
        return None
    try:
        process_dirs = tuple(Path("/proc").iterdir())
    except FileNotFoundError:
        return None
    for process_dir in process_dirs:
        if not process_dir.name.isdigit():
            continue
        pid = int(process_dir.name)
        if _process_owns_socket(process_dir, listen_inodes) and _is_harness_ui_server_process(pid) is True:
            return pid
    return None


def _listen_socket_inodes(host: str, port: int) -> set[str]:
    if host not in {"", "0.0.0.0", "127.0.0.1", "::", "::1", "localhost"}:
        return set()
    inodes: set[str] = set()
    for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        try:
            lines = table.read_text(encoding="utf-8").splitlines()[1:]
        except FileNotFoundError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != "0A":
                continue
            try:
                _address_hex, port_hex = fields[1].rsplit(":", maxsplit=1)
            except ValueError:
                continue
            if int(port_hex, 16) == port:
                inodes.add(fields[9])
    return inodes


def _process_owns_socket(process_dir: Path, listen_inodes: set[str]) -> bool:
    try:
        entries = tuple((process_dir / "fd").iterdir())
    except (FileNotFoundError, PermissionError):
        return False
    for entry in entries:
        try:
            target = os.readlink(entry)
        except (FileNotFoundError, PermissionError, OSError):
            continue
        if target.startswith("socket:[") and target.removeprefix("socket:[").removesuffix("]") in listen_inodes:
            return True
    return False


def _process_owns_listen_port(pid: int, host: str, port: int) -> bool:
    listen_inodes = _listen_socket_inodes(host, port)
    if not listen_inodes:
        return False
    return _process_owns_socket(Path("/proc") / str(pid), listen_inodes)


def _is_harness_ui_server_process(pid: int) -> bool | None:
    try:
        command = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\x00")
    except FileNotFoundError:
        return False if Path("/proc").exists() else None
    except PermissionError:
        return None
    arguments = {part.decode("utf-8", errors="replace") for part in command if part}
    return "ui-server" in arguments and (
        "harness_codex" in arguments or "harness_codex.runtime.ui_server" in arguments
    )


def _create_http_server(
    host: str,
    port: int,
    handler: type[BaseHTTPRequestHandler],
    *,
    wait_for_restart: bool,
) -> ThreadingHTTPServer:
    deadline = time.monotonic() + 10
    while True:
        try:
            return ThreadingHTTPServer((host, port), handler)
        except OSError as exc:
            if not wait_for_restart or exc.errno != errno.EADDRINUSE or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def _exit_on_terminate(_signum: int, _frame: object) -> None:
    raise SystemExit(0)


def _format_bind_url(host: str, port: int) -> str:
    display_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"http://{display_host}:{port}"


def _print_startup_log(repo_root: Path, host: str, port: int, *, restarted: bool) -> None:
    base_url = _format_bind_url(host, port)
    print(f"Harness UI server running at {base_url}", flush=True)
    print(f"Repo root: {repo_root}", flush=True)
    if restarted:
        print("Restarted previous UI server for this repo.", flush=True)
    print("Exposed endpoints:", flush=True)
    for method, path, description in _SERVER_ENDPOINTS:
        print(f"  {method:<6} {base_url}{path} - {description}", flush=True)


def _suggest_change_set_id(repo_root: Path) -> str:
    date = datetime.now().strftime("%Y%m%d")
    sequence = 1
    for directory in (repo_root / "docs/changes/active", repo_root / "docs/changes/completed"):
        if not directory.exists():
            continue
        for path in directory.glob(f"CHG-{date}-*.md"):
            try:
                sequence = max(sequence, int(path.stem.rsplit("-", maxsplit=1)[1]) + 1)
            except (IndexError, ValueError):
                continue
    return f"CHG-{date}-{sequence:03d}"


def start_requirements_changeset(repo_root: Path | str, prompt: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    normalized_prompt = prompt.strip()
    if not normalized_prompt:
        raise ValueError("initial prompt is required")
    result = start_requirements(root, normalized_prompt)
    change_set_id = _suggest_change_set_id(root)
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title=normalized_prompt.splitlines()[0][:80],
            request_summary=normalized_prompt,
        ),
        encoding="utf-8",
    )
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def resume_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    result = load_changeset_harvest_ui(Path(repo_root).resolve(), change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def answer_requirements_changeset(
    repo_root: Path | str,
    change_set_id: str,
    answer: str | list[str],
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = answer_requirements(root, answer)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def start_ubiquitous_language_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = start_ubiquitous_language(root)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def complete_ubiquitous_language_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = complete_ubiquitous_language(root)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def start_use_cases_changeset(repo_root: Path | str, change_set_id: str, idea: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = start_use_case_generation(root, idea)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def answer_use_cases_changeset(repo_root: Path | str, change_set_id: str, answer: str, idea: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = answer_use_cases(root, answer, idea)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def start_event_storming_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = start_event_storming(root, change_set_id)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def advance_event_storming_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = advance_event_storming(root, change_set_id)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def answer_event_storming_changeset(
    repo_root: Path | str,
    change_set_id: str,
    uc_id: str,
    answer: str,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = answer_event_storming(root, change_set_id, uc_id, answer)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def start_ddd_architecture_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    _activate_scoped_ddd_inputs(root, change_set_id)
    result = start_ddd_architecture(root, change_set_id)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def restart_ddd_architecture_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    _activate_scoped_ddd_inputs(root, change_set_id)
    result = restart_ddd_architecture(root, change_set_id)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def advance_ddd_architecture_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    _activate_scoped_ddd_inputs(root, change_set_id)
    result = advance_ddd_architecture(root, change_set_id)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def run_all_ddd_architecture_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    with _DDD_RUN_ALL_JOBS_LOCK:
        current = _DDD_RUN_ALL_JOBS.get(change_set_id)
        if current and current.get("status") == "running":
            result = load_changeset_harvest_ui(root, change_set_id)
            return {"change_set_id": change_set_id, "harvest": result.as_dict(), "job": dict(current)}
        job = {
            "change_set_id": change_set_id,
            "status": "running",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": "",
            "error": "",
        }
        _DDD_RUN_ALL_JOBS[change_set_id] = job
    activate_changeset_harvest_ui(root, change_set_id)
    _activate_scoped_ddd_inputs(root, change_set_id)
    result = begin_run_all_ddd_architecture(root, change_set_id)
    save_changeset_harvest_ui(root, change_set_id)
    thread = threading.Thread(
        target=_run_ddd_run_all_job,
        args=(root, change_set_id),
        daemon=True,
    )
    thread.start()
    return {"change_set_id": change_set_id, "harvest": result.as_dict(), "job": dict(job)}


def _run_ddd_run_all_job(root: Path, change_set_id: str) -> None:
    try:
        activate_changeset_harvest_ui(root, change_set_id)
        _activate_scoped_ddd_inputs(root, change_set_id)
        finish_run_all_ddd_architecture(root, change_set_id)
        save_changeset_harvest_ui(root, change_set_id)
        status = "succeeded"
        error = ""
    except Exception as exc:  # pragma: no cover - exercised through server integration
        status = "failed"
        error = str(exc)
    with _DDD_RUN_ALL_JOBS_LOCK:
        job = _DDD_RUN_ALL_JOBS.get(change_set_id, {"change_set_id": change_set_id})
        job["status"] = status
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        job["error"] = error
        _DDD_RUN_ALL_JOBS[change_set_id] = job


def rerun_ddd_architecture_step_changeset(
    repo_root: Path | str,
    change_set_id: str,
    uc_id: str,
    step_id: str,
    user_prompt: str,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    _activate_scoped_ddd_inputs(root, change_set_id)
    result = rerun_ddd_architecture_step(root, change_set_id, uc_id, step_id, user_prompt)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def start_rerun_design_stage(
    repo_root: Path | str,
    change_set_id: str,
    stage_id: str,
    user_prompt: str,
    *,
    uc_id: str = "",
    answers: list[dict[str, str]] | None = None,
    restart: bool = False,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    if restart and stage_id != "technical-decisions":
        raise ValueError("restart is supported only for technical-decisions")
    _rerun_design_stage_command(
        root,
        change_set_id,
        stage_id,
        user_prompt,
        uc_id=uc_id,
    )
    with _STAGE_RERUN_JOBS_LOCK:
        current = _STAGE_RERUN_JOBS.get(change_set_id)
        if current and current.get("status") == "running":
            return {"change_set_id": change_set_id, "job": _stage_rerun_job_payload(root, current)}
        job = {
            "change_set_id": change_set_id,
            "stage_id": stage_id,
            "uc_id": uc_id.strip(),
            "status": "running",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "started_at_epoch": time.time(),
            "finished_at": "",
            "returncode": None,
            "output": "",
            "error": "",
            "pending_questions": [],
        }
        _save_stage_rerun_job(root, job)
        _STAGE_RERUN_JOBS[change_set_id] = job
    thread = threading.Thread(
        target=_run_rerun_design_stage_job,
        args=(
            root,
            change_set_id,
            stage_id,
            user_prompt,
            uc_id,
            answers or [],
            restart,
        ),
        daemon=True,
    )
    thread.start()
    return {"change_set_id": change_set_id, "job": _stage_rerun_job_payload(root, job)}


def stage_rerun_progress_state(
    repo_root: Path | str,
    change_set_id: str,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    _active_dashboard_change_set(root, change_set_id)
    with _STAGE_RERUN_JOBS_LOCK:
        job = _STAGE_RERUN_JOBS.get(change_set_id) or _load_stage_rerun_job(root, change_set_id)
        if job is not None:
            _STAGE_RERUN_JOBS[change_set_id] = job
        return {
            "change_set_id": change_set_id,
            "job": _stage_rerun_job_payload(root, job) if job else None,
        }

def workflow_activity_state(
    repo_root: Path | str,
    change_set_id: str,
    *,
    since: float,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    _active_dashboard_change_set(root, change_set_id)
    return {
        "change_set_id": change_set_id,
        "elapsed_seconds": max(0, int(time.time() - since)) if since > 0 else 0,
        "activity": _recent_agent_activity(root, since=since),
    }


def _run_rerun_design_stage_job(
    root: Path,
    change_set_id: str,
    stage_id: str,
    user_prompt: str,
    uc_id: str,
    answers: list[dict[str, str]],
    restart: bool,
) -> None:
    try:
        result = rerun_design_stage(
            root,
            change_set_id,
            stage_id,
            user_prompt,
            uc_id=uc_id,
            answers=answers,
            restart=restart,
        )
    except Exception as exc:
        with _STAGE_RERUN_JOBS_LOCK:
            job = _STAGE_RERUN_JOBS[change_set_id]
            job["status"] = "failed"
            job["finished_at"] = datetime.now().isoformat(timespec="seconds")
            job["finished_at_epoch"] = time.time()
            job["returncode"] = 1
            job["error"] = str(exc)
            _save_stage_rerun_job(root, job)
        return
    with _STAGE_RERUN_JOBS_LOCK:
        job = _STAGE_RERUN_JOBS[change_set_id]
        job["status"] = (
            "needs_input"
            if result.get("needs_input")
            else "blocked"
            if result.get("blocked")
            else "succeeded"
        )
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        job["finished_at_epoch"] = time.time()
        job["returncode"] = 0
        job["output"] = result["output"]
        if result.get("blocked"):
            job["error"] = result["output"]
        job["pending_questions"] = result.get("pending_questions", [])
        job["harvest"] = result["harvest"]
        job["dashboard"] = result["dashboard"]
        _save_stage_rerun_job(root, job)


def _stage_rerun_job_payload(root: Path, job: dict[str, Any]) -> dict[str, Any]:
    internal_keys = {"started_at_epoch", "finished_at_epoch"}
    payload = {key: value for key, value in job.items() if key not in internal_keys}
    started_at = float(job.get("started_at_epoch", 0.0))
    finished_at = float(job.get("finished_at_epoch", 0.0)) or time.time()
    payload["elapsed_seconds"] = max(0, int(finished_at - started_at))
    payload["activity"] = _recent_agent_activity(
        root,
        since=started_at,
    )
    return payload


def _recent_agent_activity(root: Path, *, since: float) -> list[str]:
    run_roots = (
        root / ".harness" / "runs",
        root / ".harness" / "ui" / "ddd-runs",
    )
    candidates: list[tuple[float, Path]] = []
    for runs_root in run_roots:
        if not runs_root.is_dir():
            continue
        for path in runs_root.rglob("*.txt"):
            if path.name not in {"stdout.txt", "stderr.txt"}:
                continue
            try:
                modified = path.stat().st_mtime
            except OSError:
                continue
            if modified >= since:
                candidates.append((modified, path))
    entries: list[str] = []
    for _modified, path in sorted(candidates)[-24:]:
        try:
            with path.open("rb") as stream:
                stream.seek(0, os.SEEK_END)
                size = stream.tell()
                stream.seek(max(0, size - _ACTIVITY_TAIL_BYTES))
                text = stream.read().decode("utf-8", errors="replace")
        except OSError:
            continue
        entries.extend(_activity_entries(text))
    deduplicated = list(dict.fromkeys(entry for entry in entries if entry))
    return deduplicated[-_ACTIVITY_LIMIT:]


def _activity_entries(text: str) -> list[str]:
    entries: list[str] = []
    expect_agent_summary = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            event = None
        if isinstance(event, dict):
            entry = _json_activity_entry(event)
            if entry:
                entries.append(entry)
            continue
        if line == "codex":
            expect_agent_summary = True
            continue
        if expect_agent_summary:
            entries.append(f"Agent summary: {line}")
            expect_agent_summary = False
            continue
        if line.startswith("exec"):
            entries.append(f"Tool: {line.removeprefix('exec').strip()}")
        elif line.startswith("collab:"):
            entries.append(f"Coordination: {line.removeprefix('collab:').strip()}")
        elif line.startswith(("succeeded in ", "failed in ", "tokens used")):
            entries.append(line)
    return entries


def _json_activity_entry(event: dict[str, Any]) -> str:
    event_type = str(event.get("type", ""))
    item = event.get("item")
    if event_type == "thread.started":
        return "Agent session started."
    if event_type == "turn.started":
        return "Agent turn started."
    if event_type == "turn.completed":
        usage = event.get("usage")
        if isinstance(usage, dict) and usage.get("output_tokens") is not None:
            return f"Agent turn completed. Output tokens: {usage['output_tokens']}."
        return "Agent turn completed."
    if not isinstance(item, dict):
        return ""
    item_type = str(item.get("type", ""))
    text = str(item.get("text", "")).strip()
    if item_type == "reasoning" and text:
        return f"Reasoning summary: {text}"
    if item_type == "agent_message" and text:
        return f"Agent summary: {text}"
    if item_type == "command_execution":
        command = str(item.get("command", "")).strip()
        status = str(item.get("status", "")).strip()
        if status == "in_progress":
            return f"Command running: {command}".strip()
        return f"Command {status}: {command}".strip()
    if item_type == "mcp_tool_call":
        server = str(item.get("server", "")).strip()
        tool = str(item.get("tool", "")).strip()
        status = str(item.get("status", "")).strip()
        return f"Tool {status}: {server}/{tool}".strip()
    return ""


def rerun_design_stage(
    repo_root: Path | str,
    change_set_id: str,
    stage_id: str,
    user_prompt: str,
    *,
    uc_id: str = "",
    answers: list[dict[str, str]] | None = None,
    restart: bool = False,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    if restart:
        _reset_technical_decisions_with_skill_script(root, change_set_id, uc_id)
    command = _rerun_design_stage_command(
        root,
        change_set_id,
        stage_id,
        user_prompt,
        uc_id=uc_id,
    )
    activate_changeset_harvest_ui(root, change_set_id)
    env = os.environ.copy()
    env["HARNESS_NONINTERACTIVE"] = "1"
    if answers:
        env["HARNESS_INTERACTIVE_STAGE_ANSWERS"] = json.dumps(answers, ensure_ascii=False)
    result = subprocess.run(
        command,
        cwd=Path(__file__).resolve().parents[2],
        text=True,
        capture_output=True,
        check=False,
        stdin=subprocess.DEVNULL,
        env=env,
    )
    output = result.stdout.strip()
    error = result.stderr.strip()
    if result.returncode != 0:
        detail = error or output or f"stage rerun exited with status {result.returncode}"
        raise ValueError(detail)
    pending_questions = _stage_rerun_pending_questions(root, output)
    needs_input = "Interactive status: needs_input" in output
    blocked = (
        not needs_input
        and (
            "ChangeSet status: blocked" in output
            or "Interactive status: blocked" in output
            or "Verification: failed" in output
        )
    )
    change_set_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not needs_input and not blocked:
        _mark_downstream_stages_stale(change_set_path, stage_id)
    save_changeset_harvest_ui(root, change_set_id)
    return {
        "change_set_id": change_set_id,
        "stage_id": stage_id,
        "uc_id": uc_id.strip(),
        "output": output,
        "needs_input": needs_input,
        "blocked": blocked,
        "pending_questions": pending_questions,
        "harvest": load_changeset_harvest_ui(root, change_set_id).as_dict(),
        "dashboard": document_dashboard_state(root),
    }


def _stage_rerun_pending_questions(root: Path, output: str) -> list[dict[str, str]]:
    session_prefix = "Session: "
    pending: list[dict[str, str]] = []
    for line in output.splitlines():
        if not line.startswith(session_prefix):
            continue
        session_path = root / line.removeprefix(session_prefix).strip()
        try:
            session = json.loads(session_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        questions = session.get("pending_questions", [])
        if not isinstance(questions, list):
            continue
        sanitized: list[dict[str, str]] = []
        for question in questions:
            if not isinstance(question, dict):
                continue
            text = str(question.get("question", "")).strip()
            if not text:
                continue
            sanitized.append(
                {
                    "question": text,
                    "recommended": str(question.get("recommended", "")).strip(),
                }
            )
        if sanitized:
            pending = sanitized
    return pending


def _rerun_design_stage_command(
    root: Path,
    change_set_id: str,
    stage_id: str,
    user_prompt: str,
    *,
    uc_id: str,
) -> list[str]:
    if stage_id not in _RERUNNABLE_DESIGN_STAGE_IDS:
        raise ValueError("stage_id must identify a rerunnable design stage")
    prompt = user_prompt.strip()
    change_set_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_set_path.exists():
        raise ValueError("active ChangeSet does not exist")
    if stage_id in {
        "event-storming",
        "ddd-architecture-definition",
        "plan-writing",
    } and not uc_id.strip():
        raise ValueError("uc_id is required for this design stage")
    command = [
        sys.executable,
        "-m",
        "harness_codex",
        "--repo-root",
        str(root),
        stage_id,
        change_set_id,
    ]
    if prompt:
        command.extend(["--idea", prompt])
    command.append("--force")
    if uc_id.strip():
        command.extend(["--uc", uc_id.strip()])
    return command


def _reset_technical_decisions_with_skill_script(
    root: Path,
    change_set_id: str,
    uc_id: str,
) -> dict[str, Any]:
    script = (
        root
        / ".codex"
        / "skills"
        / "harness-reset-technical-decisions"
        / "scripts"
        / "reset.py"
    )
    if not script.is_file():
        raise ValueError(f"technical decisions reset script not found: {script}")
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--repo-root",
            str(root),
            "--change-set",
            change_set_id,
            "--uc",
            uc_id,
        ],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise ValueError(
            result.stderr.strip()
            or result.stdout.strip()
            or "technical decisions reset failed"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("technical decisions reset returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("technical decisions reset returned invalid payload")
    return payload


def _mark_downstream_stages_stale(change_set_path: Path, stage_id: str) -> None:
    stage_ids = [stage.stage_id for stage in PROCEDURE_STAGES]
    start = stage_ids.index(stage_id) + 1
    text = change_set_path.read_text(encoding="utf-8")
    for downstream_id in stage_ids[start:]:
        text = update_changeset_stage_status(
            text,
            stage=procedure_stage(downstream_id),
            status="stale",
            notes=f"stale after forced rerun of {stage_id}",
        )
    change_set_path.write_text(text, encoding="utf-8")


def answer_ddd_architecture_changeset(
    repo_root: Path | str,
    change_set_id: str,
    uc_id: str,
    step_id: str,
    answer: str,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    _activate_scoped_ddd_inputs(root, change_set_id)
    result = answer_ddd_architecture(root, change_set_id, uc_id, step_id, answer)
    save_changeset_harvest_ui(root, change_set_id)
    return {"change_set_id": change_set_id, "harvest": result.as_dict()}


def _activate_scoped_ddd_inputs(root: Path, change_set_id: str) -> None:
    scoped_root = root / ".harness/ui/change-sets" / change_set_id
    for source in (scoped_root / "docs/use-cases").glob("UC-*"):
        target = root / "docs/use-cases" / source.name
        for name in ("event-storming.md", "ddd-design.md"):
            if (source / name).exists():
                target.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / name, target / name)
    architecture = scoped_root / "ARCHITECTURE.md"
    if architecture.exists():
        shutil.copyfile(architecture, root / "ARCHITECTURE.md")


def _required_change_set_id(body: dict[str, Any]) -> str:
    change_set_id = str(body.get("change_set_id", "")).strip()
    if not change_set_id:
        raise ValueError("change_set_id is required")
    return change_set_id


def _rerun_stage_answers_from_body(body: dict[str, Any]) -> list[dict[str, str]]:
    raw_answers = body.get("answers", [])
    if raw_answers in (None, ""):
        return []
    if not isinstance(raw_answers, list):
        raise ValueError("answers must be a list")
    answers: list[dict[str, str]] = []
    for raw_answer in raw_answers:
        if not isinstance(raw_answer, dict):
            raise ValueError("answers entries must be objects")
        question = str(raw_answer.get("question", "")).strip()
        answer = str(raw_answer.get("answer", "")).strip()
        recommended = str(raw_answer.get("recommended", "")).strip()
        if not question or not answer:
            raise ValueError("answers entries require question and answer")
        answers.append(
            {
                "question": question,
                "recommended": recommended,
                "answer": answer,
                "source": "rerun_ui",
            }
        )
    return answers


def implementation_progress_state(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    change_set = _active_dashboard_change_set(root, change_set_id)
    diff = _implementation_diff_state(root, change_set)
    job = _implementation_job(root, change_set_id)
    return {
        "change_set_id": change_set_id,
        "plans": [
            item.get("plan", {}) | {"work_item_id": item["id"], "name": item["name"]}
            for item in change_set["work_items"]
        ],
        "diff": diff,
        "job": job,
        "loop": _implementation_loop_state(root, change_set, job),
    }


def delivery_progress_state(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    change_set = _active_dashboard_change_set(root, change_set_id)
    stage = next(
        (item for item in change_set.get("stages", []) if item.get("id") == "change-set-pr"),
        {},
    )
    return {
        "change_set_id": change_set_id,
        "stage": stage,
        "pull_request": change_set.get("pull_request") or {},
        "job": _delivery_job(root, change_set_id),
    }


def planning_progress_state(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    change_set = _active_dashboard_change_set(root, change_set_id)
    return {
        "change_set_id": change_set_id,
        "plans": [
            item.get("plan", {}) | {"work_item_id": item["id"], "name": item["name"]}
            for item in change_set["work_items"]
        ],
        "job": _plan_writing_job(change_set_id),
    }


def start_plan_writing_changeset(
    repo_root: Path | str,
    change_set_id: str,
    uc_id: str,
    *,
    reset_plan: bool = False,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    change_set = _active_dashboard_change_set(root, change_set_id)
    normalized_uc_id = uc_id.strip()
    work_item_ids = {item["id"] for item in change_set["work_items"]}
    if normalized_uc_id not in work_item_ids:
        raise ValueError("uc_id must identify an affected ChangeSet work item")
    _assert_plan_writing_ready(root, change_set_id, normalized_uc_id)
    with _PLAN_WRITING_JOBS_LOCK:
        current = _PLAN_WRITING_JOBS.get(change_set_id)
        if current and current.get("status") == "running":
            return {"change_set_id": change_set_id, "job": dict(current)}
        reset_path = ""
        if reset_plan:
            reset_path = _reset_active_plan(root, normalized_uc_id)
        job = {
            "change_set_id": change_set_id,
            "uc_id": normalized_uc_id,
            "reset_plan": reset_plan,
            "reset_plan_path": reset_path,
            "status": "running",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": "",
            "returncode": None,
            "output": "",
            "error": "",
        }
        _PLAN_WRITING_JOBS[change_set_id] = job
    thread = threading.Thread(
        target=_run_plan_writing_job,
        args=(root, change_set_id, normalized_uc_id),
        daemon=True,
    )
    thread.start()
    return {"change_set_id": change_set_id, "job": dict(job)}


def _reset_active_plan(root: Path, uc_id: str) -> str:
    plan_path = root / "docs" / "plans" / "active" / uc_id / "plan.md"
    try:
        plan_path.relative_to(root / "docs" / "plans" / "active")
    except ValueError as exc:
        raise ValueError("plan reset path must stay under docs/plans/active") from exc
    if plan_path.exists():
        plan_path.unlink()
    return str(plan_path.relative_to(root))


def _assert_plan_writing_ready(root: Path, change_set_id: str, uc_id: str) -> None:
    from harness_codex.runtime.dashboard_runtime_state import assert_canonical_stage_gate

    assert_canonical_stage_gate(root, change_set_id, "plan-writing", uc_id=uc_id)
    change_set = ChangeSetResolver(root).load(
        Path("docs/changes/active") / f"{change_set_id}.md"
    )
    scopes = ChangeSetResolver(root).resolve_planning_scopes(change_set)
    if isinstance(scopes, PlanningBlocked):
        raise ValueError(scopes.reason)
    if not any(scope.display_id == uc_id for scope in scopes):
        raise ValueError("uc_id must identify an affected ChangeSet work item")


def _run_plan_writing_job(root: Path, change_set_id: str, uc_id: str) -> None:
    command = [
        sys.executable,
        "-m",
        "harness_codex",
        "plan-writing",
        change_set_id,
        "--uc",
        uc_id,
    ]
    result = subprocess.run(command, cwd=root, text=True, capture_output=True, check=False)
    with _PLAN_WRITING_JOBS_LOCK:
        job = _PLAN_WRITING_JOBS[change_set_id]
        job["status"] = "succeeded" if result.returncode == 0 else "failed"
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        job["returncode"] = result.returncode
        job["output"] = result.stdout.strip()
        job["error"] = result.stderr.strip()


def _plan_writing_job(change_set_id: str) -> dict[str, Any] | None:
    with _PLAN_WRITING_JOBS_LOCK:
        job = _PLAN_WRITING_JOBS.get(change_set_id)
        return dict(job) if job else None


def implementation_diff_file(repo_root: Path | str, change_set_id: str, path: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    change_set = _active_dashboard_change_set(root, change_set_id)
    normalized = _normalize_diff_path(path)
    diff = _implementation_diff_state(root, change_set)
    files = diff["files"]
    status_by_path = {item["path"]: item["status"] for item in files}
    if normalized not in status_by_path:
        return {
            "path": normalized,
            "patch": "",
            "truncated": False,
            "stale": True,
            "files": files,
            "source": diff["source"],
        }
    patch = _implementation_file_patch(root, normalized, status_by_path[normalized], diff["source"])
    truncated = len(patch) > _DIFF_PATCH_LIMIT
    if truncated:
        patch = patch[:_DIFF_PATCH_LIMIT] + "\n\n[diff truncated]\n"
    return {
        "path": normalized,
        "patch": patch,
        "truncated": truncated,
        "stale": False,
        "source": diff["source"],
    }


def implementation_source_file(repo_root: Path | str, change_set_id: str, path: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    _active_dashboard_change_set(root, change_set_id)
    normalized = _normalize_diff_path(path)
    if not _show_in_diff_explorer(normalized):
        raise ValueError("source path is not supported by Diff Explorer")
    target = (root / normalized).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError("invalid source path") from exc
    if not target.exists() or not target.is_file():
        return {"path": normalized, "content": "", "exists": False}
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return {"path": normalized, "content": "", "exists": True, "binary": True}
    truncated = len(content) > _DIFF_PATCH_LIMIT
    if truncated:
        content = content[:_DIFF_PATCH_LIMIT] + "\n\n[source truncated]\n"
    return {
        "path": normalized,
        "content": content,
        "exists": True,
        "binary": False,
        "truncated": truncated,
    }


def start_implementation_changeset(
    repo_root: Path | str,
    change_set_id: str,
    *,
    uc_id: str = "",
    force_verification: bool = False,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    change_set = _active_dashboard_change_set(root, change_set_id)
    normalized_uc_id = uc_id.strip()
    if normalized_uc_id:
        work_item_ids = {item["id"] for item in change_set["work_items"]}
        if normalized_uc_id not in work_item_ids:
            raise ValueError("uc_id must identify an affected ChangeSet work item")
    with _IMPLEMENTATION_JOBS_LOCK:
        current = _IMPLEMENTATION_JOBS.get(change_set_id)
        if current and current.get("status") == "running":
            return {"change_set_id": change_set_id, "job": dict(current)}
        job = {
            "change_set_id": change_set_id,
            "uc_id": normalized_uc_id,
            "status": "running",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": "",
            "returncode": None,
            "output": "",
            "error": "",
        }
        _IMPLEMENTATION_JOBS[change_set_id] = job
    thread = threading.Thread(
        target=_run_implementation_job,
        args=(root, change_set_id, normalized_uc_id, force_verification),
        daemon=True,
    )
    thread.start()
    return {"change_set_id": change_set_id, "job": dict(job)}


def _run_implementation_job(root: Path, change_set_id: str, uc_id: str, force_verification: bool) -> None:
    command = [sys.executable, "-m", "harness_codex", "implementation", change_set_id, "--apply"]
    if uc_id:
        command.extend(["--uc", uc_id])
    if force_verification:
        command.append("--force-verification")
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    try:
        process = subprocess.Popen(
            command,
            cwd=root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
    except OSError as exc:
        with _IMPLEMENTATION_JOBS_LOCK:
            job = _IMPLEMENTATION_JOBS[change_set_id]
            job["status"] = "failed"
            job["finished_at"] = datetime.now().isoformat(timespec="seconds")
            job["returncode"] = 1
            job["error"] = str(exc)
        return
    output_parts: list[str] = []
    if process.stdout is not None:
        for line in process.stdout:
            output_parts.append(line)
            with _IMPLEMENTATION_JOBS_LOCK:
                job = _IMPLEMENTATION_JOBS[change_set_id]
                job["output"] = "".join(output_parts).rstrip()
    returncode = process.wait()
    output = "".join(output_parts).strip()
    with _IMPLEMENTATION_JOBS_LOCK:
        job = _IMPLEMENTATION_JOBS[change_set_id]
        job["status"] = _implementation_process_status(returncode, output)
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        job["returncode"] = returncode
        job["output"] = output
        job["error"] = ""


def _implementation_process_status(returncode: int, output: str) -> str:
    if returncode != 0:
        return "failed"
    if re.search(r"\bstatus=blocked\b", output) or "ChangeSet status: blocked" in output:
        return "blocked"
    if re.search(r"\bstatus=failed\b", output) or "ChangeSet status: failed" in output:
        return "failed"
    return "succeeded"


def _implementation_job(root: Path, change_set_id: str) -> dict[str, Any] | None:
    with _IMPLEMENTATION_JOBS_LOCK:
        job = _IMPLEMENTATION_JOBS.get(change_set_id)
        payload = dict(job) if job else None
    if not payload:
        return None
    started_at = _parse_iso_epoch(str(payload.get("started_at", "")))
    finished_at = _parse_iso_epoch(str(payload.get("finished_at", ""))) or time.time()
    payload["elapsed_seconds"] = max(0, int(finished_at - started_at)) if started_at > 0 else 0
    payload["activity"] = _recent_agent_activity(root, since=started_at) if started_at > 0 else []
    return payload


def start_delivery_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    _active_dashboard_change_set(root, change_set_id)
    with _DELIVERY_JOBS_LOCK:
        current = _DELIVERY_JOBS.get(change_set_id)
        if current and current.get("status") == "running":
            return {"change_set_id": change_set_id, "job": dict(current)}
        job = {
            "change_set_id": change_set_id,
            "status": "running",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": "",
            "returncode": None,
            "output": "",
            "error": "",
            "approval_env": DELIVERY_APPROVAL_ENV,
        }
        _DELIVERY_JOBS[change_set_id] = job
    thread = threading.Thread(
        target=_run_delivery_job,
        args=(root, change_set_id),
        daemon=True,
    )
    thread.start()
    return {"change_set_id": change_set_id, "job": dict(job)}


def _run_delivery_job(root: Path, change_set_id: str) -> None:
    command = [sys.executable, "-m", "harness_codex", "implementation", change_set_id, "--apply"]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env[DELIVERY_APPROVAL_ENV] = "1"
    try:
        process = subprocess.Popen(
            command,
            cwd=root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
    except OSError as exc:
        with _DELIVERY_JOBS_LOCK:
            job = _DELIVERY_JOBS[change_set_id]
            job["status"] = "failed"
            job["finished_at"] = datetime.now().isoformat(timespec="seconds")
            job["returncode"] = 1
            job["error"] = str(exc)
        return
    output_parts: list[str] = []
    if process.stdout is not None:
        for line in process.stdout:
            output_parts.append(line)
            with _DELIVERY_JOBS_LOCK:
                job = _DELIVERY_JOBS[change_set_id]
                job["output"] = "".join(output_parts).rstrip()
    returncode = process.wait()
    output = "".join(output_parts).strip()
    with _DELIVERY_JOBS_LOCK:
        job = _DELIVERY_JOBS[change_set_id]
        job["status"] = _implementation_process_status(returncode, output)
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        job["returncode"] = returncode
        job["output"] = output
        job["error"] = ""


def _delivery_job(root: Path, change_set_id: str) -> dict[str, Any] | None:
    with _DELIVERY_JOBS_LOCK:
        job = _DELIVERY_JOBS.get(change_set_id)
        payload = dict(job) if job else None
    if not payload:
        return None
    started_at = _parse_iso_epoch(str(payload.get("started_at", "")))
    finished_at = _parse_iso_epoch(str(payload.get("finished_at", ""))) or time.time()
    payload["elapsed_seconds"] = max(0, int(finished_at - started_at)) if started_at > 0 else 0
    payload["activity"] = _recent_agent_activity(root, since=started_at) if started_at > 0 else []
    return payload


def _implementation_loop_state(
    root: Path,
    change_set: dict[str, Any],
    job: dict[str, Any] | None,
) -> dict[str, Any]:
    checkpoint = _latest_implementation_checkpoint(root, change_set)
    job_status = str((job or {}).get("status") or "")
    checkpoint_status = str((checkpoint or {}).get("status") or "")
    completed = {
        str(phase)
        for phase in (checkpoint or {}).get("completed_tasks", [])
        if str(phase)
    }
    if job_status == "succeeded" or checkpoint_status == "succeeded":
        completed = {phase_id for phase_id, _label in _IMPLEMENTATION_LOOP_PHASES}
    current = _current_implementation_loop_phase(job_status, checkpoint, completed)
    phase_ids = [phase_id for phase_id, _label in _IMPLEMENTATION_LOOP_PHASES]
    current_index = phase_ids.index(current) if current in phase_ids else 0
    phases = []
    for index, (phase_id, label) in enumerate(_IMPLEMENTATION_LOOP_PHASES):
        if phase_id in completed:
            status = "complete"
        elif phase_id == current:
            status = "active" if job_status == "running" else "pending"
        elif index < current_index:
            status = "complete"
        else:
            status = "pending"
        metrics = (checkpoint or {}).get("phase_metrics", {}).get(phase_id, {})
        phases.append(
            {
                "id": phase_id,
                "label": label,
                "status": status,
                "command_count": int(metrics.get("command_count") or 0)
                if isinstance(metrics, dict)
                else 0,
            }
        )
    complete_count = sum(1 for phase in phases if phase["status"] == "complete")
    if job_status == "running" and phases[current_index]["status"] == "active":
        progress = int(((complete_count + 0.5) / len(phases)) * 100)
    else:
        progress = int((complete_count / len(phases)) * 100)
    attempt = _latest_implementation_attempt(root, checkpoint)
    return {
        "current_phase": current,
        "current_label": dict(_IMPLEMENTATION_LOOP_PHASES).get(current, current),
        "percent": max(0, min(100, progress)),
        "status": job_status or checkpoint_status or "idle",
        "phases": phases,
        "checkpoint_path": str(checkpoint.get("_path", "")) if checkpoint else "",
        "attempt": attempt,
    }


def _current_implementation_loop_phase(
    job_status: str,
    checkpoint: dict[str, Any] | None,
    completed: set[str],
) -> str:
    if job_status == "running":
        next_phase = str((checkpoint or {}).get("next_phase") or "")
        if next_phase:
            return next_phase
    if job_status == "succeeded" or str((checkpoint or {}).get("status") or "") == "succeeded":
        return "closure"
    for phase_id, _label in _IMPLEMENTATION_LOOP_PHASES:
        if phase_id not in completed:
            return phase_id
    return "closure"


def _latest_implementation_checkpoint(
    root: Path,
    change_set: dict[str, Any],
) -> dict[str, Any] | None:
    work_item_ids = {
        str(item.get("id"))
        for item in change_set.get("work_items", [])
        if item.get("id")
    }
    candidates: list[tuple[float, Path, dict[str, Any]]] = []
    runs_dir = root / ".harness" / "runs"
    if not runs_dir.exists():
        return None
    for path in runs_dir.glob("**/steps/execute-work-item/checkpoint.json"):
        if work_item_ids and not any(part in work_item_ids for part in path.parts):
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        candidates.append((path.stat().st_mtime, path, payload))
    if not candidates:
        return None
    _timestamp, path, payload = max(candidates, key=lambda item: item[0])
    return dict(payload) | {"_path": path.relative_to(root)}


def _latest_implementation_attempt(
    root: Path,
    checkpoint: dict[str, Any] | None,
) -> dict[str, Any]:
    checkpoint_path = str((checkpoint or {}).get("_path") or "")
    if not checkpoint_path:
        return {}
    attempt_path = (root / checkpoint_path).with_name("attempt.json")
    try:
        payload = json.loads(attempt_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        "number": int(payload.get("attempt") or 0),
        "execution_mode": str(payload.get("execution_mode") or ""),
    }


def _parse_iso_epoch(value: str) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return 0.0


def _active_dashboard_change_set(root: Path, change_set_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
        raise ValueError("active ChangeSet does not exist")
    for change_set in document_dashboard_state(root)["change_sets"]:
        if change_set["id"] == change_set_id and change_set["lifecycle"] == "active":
            return change_set
    raise ValueError("active ChangeSet does not exist")


def _git_diff_files(root: Path) -> list[dict[str, str]]:
    output = _run_git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    files: list[dict[str, str]] = []
    entries = output.split("\0")
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        status = entry[:2].strip() or "M"
        path = entry[3:]
        if not _show_in_diff_explorer(path):
            if "R" in entry[:2] or "C" in entry[:2]:
                index += 1
            continue
        files.append({"path": path, "status": status})
        if "R" in entry[:2] or "C" in entry[:2]:
            index += 1
    return files


def _implementation_diff_state(root: Path, change_set: dict[str, Any]) -> dict[str, Any]:
    working_tree = _git_diff_files(root)
    artifact_state = _latest_scope_diff_state(root, change_set)
    artifact_files = artifact_state["files"]
    commit_files = _head_commit_diff_files(root)
    if artifact_files:
        if not working_tree and commit_files and not _diff_file_paths_compatible(artifact_files, commit_files):
            return {"source": "head-commit", "files": commit_files}
        state = {"source": "latest-run", "files": artifact_files}
        if artifact_state.get("task_file_map"):
            state["task_file_map"] = artifact_state["task_file_map"]
        if artifact_state.get("work_item_file_map"):
            state["work_item_file_map"] = artifact_state["work_item_file_map"]
        if working_tree:
            state["working_tree_files"] = working_tree
        return state
    if working_tree:
        return {"source": "working-tree", "files": working_tree}
    return {"source": "head-commit" if commit_files else "none", "files": commit_files}


def _attach_scope_diff_maps_for_files(
    state: dict[str, Any],
    artifact_state: dict[str, Any],
    files: list[dict[str, str]],
) -> None:
    active_paths = {file["path"] for file in files}
    task_file_map = []
    for row in artifact_state.get("task_file_map") or []:
        mapped_files = [file for file in row.get("files", []) if file.get("path") in active_paths]
        if not mapped_files:
            continue
        mapped = dict(row)
        mapped["files"] = mapped_files
        task_file_map.append(mapped)
    work_item_file_map = []
    for row in artifact_state.get("work_item_file_map") or []:
        mapped_files = [file for file in row.get("files", []) if file.get("path") in active_paths]
        if not mapped_files:
            continue
        work_item_file_map.append({"work_item_id": row.get("work_item_id"), "files": mapped_files})
    if task_file_map:
        state["task_file_map"] = task_file_map
    if work_item_file_map:
        state["work_item_file_map"] = work_item_file_map


def _diff_file_paths_compatible(left: list[dict[str, str]], right: list[dict[str, str]]) -> bool:
    left_paths = {item["path"] for item in left}
    right_paths = {item["path"] for item in right}
    return left_paths.issubset(right_paths)


def _latest_scope_diff_files(root: Path, change_set: dict[str, Any]) -> list[dict[str, str]]:
    return _latest_scope_diff_state(root, change_set)["files"]


def _latest_scope_diff_state(root: Path, change_set: dict[str, Any]) -> dict[str, Any]:
    work_item_ids = {str(item["id"]) for item in change_set.get("work_items", []) if item.get("id")}
    candidates: list[tuple[str, Path]] = []
    runs_dir = root / ".harness/runs"
    if not runs_dir.exists():
        return {"files": [], "task_file_map": [], "work_item_file_map": []}
    for report in runs_dir.glob("**/steps/execute-work-item/scope-diff-report.json"):
        work_item_id = _scope_diff_report_work_item_id(report, work_item_ids)
        if not work_item_id:
            continue
        candidates.append((work_item_id, report))

    latest_by_work_item: dict[str, dict[str, Any]] = {}
    for work_item_id, report in sorted(candidates, key=lambda item: item[1].stat().st_mtime, reverse=True):
        if work_item_id in latest_by_work_item:
            continue
        files = _scope_diff_report_files(report)
        if files:
            latest_by_work_item[work_item_id] = {
                "files": files,
                "task_file_map": _scope_diff_report_task_file_map(report),
            }
    if not latest_by_work_item:
        return {"files": [], "task_file_map": [], "work_item_file_map": []}
    return _merge_scope_diff_work_item_state(latest_by_work_item)


def _scope_diff_report_work_item_id(report: Path, work_item_ids: set[str]) -> str:
    for part in report.parts:
        if part in work_item_ids:
            return part
    return ""


def _merge_scope_diff_work_item_state(
    latest_by_work_item: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    files_by_path: dict[str, dict[str, Any]] = {}
    task_file_map: list[dict[str, Any]] = []
    work_item_file_map: list[dict[str, Any]] = []
    for work_item_id in sorted(latest_by_work_item):
        state = latest_by_work_item[work_item_id]
        work_item_files: list[dict[str, str]] = []
        for file in state["files"]:
            path = str(file["path"])
            status = str(file.get("status") or "M")
            current = files_by_path.setdefault(path, {"path": path, "status": status, "work_item_ids": []})
            if status != current["status"]:
                current["status"] = "*"
            if work_item_id not in current["work_item_ids"]:
                current["work_item_ids"].append(work_item_id)
            work_item_files.append({"path": path, "status": status})
        work_item_file_map.append({"work_item_id": work_item_id, "files": _dedupe_diff_files(work_item_files)})
        for row in state.get("task_file_map") or []:
            mapped = dict(row)
            mapped["work_item_id"] = str(mapped.get("work_item_id") or work_item_id)
            task_file_map.append(mapped)
    files = sorted(files_by_path.values(), key=lambda item: item["path"])
    return {
        "files": files,
        "task_file_map": task_file_map,
        "work_item_file_map": work_item_file_map,
    }


def _scope_diff_report_files(report: Path) -> list[dict[str, str]]:
    try:
        data = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = data.get("changed_files")
    if not isinstance(rows, list):
        return []
    files: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        path = str(row.get("path") or "")
        if not path or not _show_in_diff_explorer(path):
            continue
        before_state = (row.get("before") or {}).get("state") if isinstance(row.get("before"), dict) else ""
        after_state = (row.get("after") or {}).get("state") if isinstance(row.get("after"), dict) else ""
        files.append({"path": path, "status": _diff_status_from_states(before_state, after_state)})
    return _dedupe_diff_files(files)


def _scope_diff_report_task_file_map(report: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = data.get("plan_task_file_map")
    if not isinstance(rows, list):
        return []
    mapped = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        files = []
        for file in row.get("files", []):
            if not isinstance(file, dict):
                continue
            path = str(file.get("path") or "")
            if path and _show_in_diff_explorer(path):
                files.append({"path": path, "status": str(file.get("status") or "M")})
        mapped.append(
            {
                "work_item_id": str(row.get("work_item_id") or ""),
                "line": row.get("line"),
                "checked": bool(row.get("checked")),
                "text": str(row.get("text") or ""),
                "files": _dedupe_diff_files(files),
                "match": str(row.get("match") or "plan-task-token"),
            }
        )
    return mapped


def _head_commit_diff_files(root: Path) -> list[dict[str, str]]:
    output = _run_git(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"])
    files: list[dict[str, str]] = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status = parts[0].strip() or "M"
        path = parts[-1]
        if _show_in_diff_explorer(path):
            files.append({"path": path, "status": status[0]})
    return _dedupe_diff_files(files)


def _dedupe_diff_files(files: list[dict[str, str]]) -> list[dict[str, str]]:
    deduped: dict[str, str] = {}
    for item in files:
        deduped[item["path"]] = item["status"]
    return [{"path": path, "status": status} for path, status in sorted(deduped.items())]


def _diff_status_from_states(before: Any, after: Any) -> str:
    before_state = str(before or "")
    after_state = str(after or "")
    if before_state == "missing" and after_state != "missing":
        return "A"
    if before_state != "missing" and after_state == "missing":
        return "D"
    return "M"


def _show_in_diff_explorer(path: str) -> bool:
    candidate = Path(path)
    if any(part in _DIFF_EXPLORER_EXCLUDED_PARTS for part in candidate.parts):
        return False
    return (
        candidate.suffix.lower() in _DIFF_EXPLORER_SOURCE_SUFFIXES
        or candidate.name.lower() in _DIFF_EXPLORER_SOURCE_NAMES
    )


def _git_file_patch(root: Path, path: str, status: str) -> str:
    if status == "??":
        result = subprocess.run(
            ["git", "diff", "--no-index", "--", "/dev/null", path],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode not in (0, 1):
            raise ValueError(result.stderr.strip() or "git diff failed")
        return result.stdout
    return _run_git(root, ["diff", "HEAD", "--", path])


def _implementation_file_patch(root: Path, path: str, status: str, source: str) -> str:
    if source in {"head-commit", "latest-run"}:
        return _run_git(root, ["show", "--format=", "--", path])
    return _git_file_patch(root, path, status)


def _normalize_diff_path(path: str) -> str:
    normalized = path.strip().replace("\\", "/")
    if not normalized or normalized.startswith("/") or ".." in Path(normalized).parts:
        raise ValueError("invalid diff path")
    return normalized


def _run_git(root: Path, args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or "git command failed")
    return result.stdout


def run_ui_server(
    repo_root: Path | str,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
) -> None:
    root = Path(repo_root).resolve()

    class Handler(HarvestUiRequestHandler):
        repo_root = root

    restart_pending = _terminate_previous_ui_server(root, host, port)
    if not restart_pending:
        restart_pending = _terminate_ui_server_on_port(host, port)
    server = _create_http_server(host, port, Handler, wait_for_restart=restart_pending)
    _print_startup_log(root, host, port, restarted=restart_pending)
    pid_path = _ui_server_pid_path(root)
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(f"{os.getpid()}\n", encoding="utf-8")
    previous_sigterm_handler: Any | None = None
    if threading.current_thread() is threading.main_thread():
        previous_sigterm_handler = signal.signal(signal.SIGTERM, _exit_on_terminate)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if previous_sigterm_handler is not None:
            signal.signal(signal.SIGTERM, previous_sigterm_handler)
        try:
            if pid_path.read_text(encoding="utf-8").strip() == str(os.getpid()):
                pid_path.unlink()
        except FileNotFoundError:
            pass


class HarvestUiRequestHandler(BaseHTTPRequestHandler):
    repo_root: Path

    def do_GET(self) -> None:
        path = self._path()
        if path == "/api/endpoints":
            self._write_json(
                HTTPStatus.OK,
                {
                    "endpoints": [
                        {"method": method, "path": endpoint_path, "description": description}
                        for method, endpoint_path, description in _SERVER_ENDPOINTS
                    ]
                },
            )
            return
        if path == "/api/harvest":
            self._write_json(HTTPStatus.OK, load_harvest_ui(self.repo_root).as_dict())
            return
        if path == "/api/dashboard":
            self._write_json(HTTPStatus.OK, document_dashboard_state(self.repo_root))
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/resume"):
            change_set_id = unquote(path.removeprefix("/api/dashboard/change-sets/").removesuffix("/resume"))
            try:
                self._write_json(HTTPStatus.OK, resume_changeset(self.repo_root, change_set_id))
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/activity"):
            change_set_id = unquote(
                path.removeprefix("/api/dashboard/change-sets/").removesuffix("/activity")
            )
            query = parse_qs(urlparse(self.path).query)
            try:
                since = float(query.get("since", ["0"])[0])
            except ValueError:
                since = 0.0
            try:
                self._write_json(
                    HTTPStatus.OK,
                    workflow_activity_state(self.repo_root, change_set_id, since=since),
                )
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/rerun-stage"):
            change_set_id = unquote(
                path.removeprefix("/api/dashboard/change-sets/").removesuffix("/rerun-stage")
            )
            try:
                self._write_json(
                    HTTPStatus.OK,
                    stage_rerun_progress_state(self.repo_root, change_set_id),
                )
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/planning"):
            change_set_id = unquote(path.removeprefix("/api/dashboard/change-sets/").removesuffix("/planning"))
            try:
                self._write_json(HTTPStatus.OK, planning_progress_state(self.repo_root, change_set_id))
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/implementation"):
            change_set_id = unquote(path.removeprefix("/api/dashboard/change-sets/").removesuffix("/implementation"))
            try:
                self._write_json(HTTPStatus.OK, implementation_progress_state(self.repo_root, change_set_id))
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/delivery"):
            change_set_id = unquote(path.removeprefix("/api/dashboard/change-sets/").removesuffix("/delivery"))
            try:
                self._write_json(HTTPStatus.OK, delivery_progress_state(self.repo_root, change_set_id))
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/implementation/diff"):
            change_set_id = unquote(
                path.removeprefix("/api/dashboard/change-sets/").removesuffix("/implementation/diff")
            )
            query = parse_qs(urlparse(self.path).query)
            try:
                self._write_json(
                    HTTPStatus.OK,
                    implementation_diff_file(
                        self.repo_root,
                        change_set_id,
                        unquote(query.get("path", [""])[0]),
                    ),
                )
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/change-sets/") and path.endswith("/implementation/source"):
            change_set_id = unquote(
                path.removeprefix("/api/dashboard/change-sets/").removesuffix("/implementation/source")
            )
            query = parse_qs(urlparse(self.path).query)
            try:
                self._write_json(
                    HTTPStatus.OK,
                    implementation_source_file(
                        self.repo_root,
                        change_set_id,
                        unquote(query.get("path", [""])[0]),
                    ),
                )
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if path.startswith("/api/dashboard/documents/"):
            document_id = unquote(path.removeprefix("/api/dashboard/documents/"))
            try:
                self._write_json(HTTPStatus.OK, read_dashboard_document(self.repo_root, document_id))
            except DashboardDocumentNotFound as exc:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            return
        asset = {
            "/": ("dashboard.html", "text/html; charset=utf-8"),
            "/dashboard": ("dashboard.html", "text/html; charset=utf-8"),
            "/assets/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
            "/assets/dashboard.js": ("dashboard.js", "text/javascript; charset=utf-8"),
        }.get(path)
        if asset:
            self._write_asset(*asset)
            return
        self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            body = self._read_body()
            path = self._path()
            if path == "/api/change-sets/requirements/start":
                self._write_json(
                    HTTPStatus.OK,
                    start_requirements_changeset(self.repo_root, str(body.get("prompt", ""))),
                )
                return
            if path == "/api/change-sets/requirements/answer":
                self._write_json(
                    HTTPStatus.OK,
                    answer_requirements_changeset(
                        self.repo_root,
                        _required_change_set_id(body),
                        body.get("answers", body.get("answer", "")),
                    ),
                )
                return
            if path == "/api/requirements/start":
                result = start_requirements(self.repo_root, str(body.get("prompt", "")))
            elif path == "/api/requirements/answer":
                result = answer_requirements(
                    self.repo_root,
                    body.get("answers", body.get("answer", "")),
                )
            elif path == "/api/ubiquitous-language/start":
                payload = start_ubiquitous_language_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/ubiquitous-language/complete":
                payload = complete_ubiquitous_language_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/use-cases/start":
                payload = start_use_cases_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                    str(body.get("idea", "")),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/use-cases/answer":
                payload = answer_use_cases_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                    str(body.get("answer", "")),
                    str(body.get("idea", "")),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/event-storming/start":
                payload = start_event_storming_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/event-storming/advance":
                payload = advance_event_storming_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/event-storming/answer":
                payload = answer_event_storming_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                    str(body.get("uc_id", "")).strip(),
                    str(body.get("answer", "")),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/ddd-architecture/start":
                payload = start_ddd_architecture_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/ddd-architecture/restart":
                payload = restart_ddd_architecture_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/ddd-architecture/advance":
                payload = advance_ddd_architecture_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/ddd-architecture/run-all":
                payload = run_all_ddd_architecture_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/ddd-architecture/rerun-step":
                payload = rerun_ddd_architecture_step_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                    str(body.get("uc_id", "")).strip(),
                    str(body.get("step_id", "")).strip(),
                    str(body.get("user_prompt", "")),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/ddd-architecture/answer":
                payload = answer_ddd_architecture_changeset(
                    self.repo_root,
                    _required_change_set_id(body),
                    str(body.get("uc_id", "")).strip(),
                    str(body.get("step_id", "")).strip(),
                    str(body.get("answer", "")),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path.startswith("/api/dashboard/change-sets/") and path.endswith("/rerun-stage"):
                change_set_id = unquote(
                    path.removeprefix("/api/dashboard/change-sets/").removesuffix("/rerun-stage")
                )
                payload = start_rerun_design_stage(
                    self.repo_root,
                    change_set_id,
                    str(body.get("stage_id", "")).strip(),
                    str(body.get("user_prompt", "")),
                    uc_id=str(body.get("uc_id", "")).strip(),
                    answers=_rerun_stage_answers_from_body(body),
                    restart=bool(body.get("restart", False)),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path.startswith("/api/dashboard/change-sets/") and path.endswith("/implementation/start"):
                change_set_id = unquote(
                    path.removeprefix("/api/dashboard/change-sets/").removesuffix("/implementation/start")
                )
                payload = start_implementation_changeset(
                    self.repo_root,
                    change_set_id,
                    uc_id=str(body.get("uc_id", "")).strip(),
                    force_verification=bool(body.get("force_verification", False)),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path.startswith("/api/dashboard/change-sets/") and path.endswith("/delivery/start"):
                change_set_id = unquote(
                    path.removeprefix("/api/dashboard/change-sets/").removesuffix("/delivery/start")
                )
                payload = start_delivery_changeset(self.repo_root, change_set_id)
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path.startswith("/api/dashboard/change-sets/") and path.endswith("/planning/start"):
                change_set_id = unquote(
                    path.removeprefix("/api/dashboard/change-sets/").removesuffix("/planning/start")
                )
                payload = start_plan_writing_changeset(
                    self.repo_root,
                    change_set_id,
                    str(body.get("uc_id", "")),
                    reset_plan=bool(body.get("reset_plan", False)),
                )
                self._write_json(HTTPStatus.OK, payload)
                return
            elif path == "/api/use-cases/complete":
                result = start_use_cases(self.repo_root)
            else:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
        except ValueError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        self._write_json(HTTPStatus.OK, result.as_dict())

    def do_PUT(self) -> None:
        path = self._path()
        if not path.startswith("/api/dashboard/documents/"):
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        document_id = unquote(path.removeprefix("/api/dashboard/documents/"))
        try:
            body = self._read_body()
            result = save_dashboard_document(
                self.repo_root,
                document_id,
                content=str(body.get("content", "")),
                revision=str(body.get("revision", "")),
            )
        except DashboardDocumentConflict as exc:
            self._write_json(HTTPStatus.CONFLICT, {"error": str(exc)})
            return
        except DashboardDocumentNotFound as exc:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            return
        except DashboardDocumentValidationError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if document_id.startswith("requirements:"):
            change_set_id = document_id.removeprefix("requirements:")
            try:
                load_changeset_harvest_ui(self.repo_root, change_set_id)
            except ValueError:
                pass
            else:
                save_changeset_harvest_ui(self.repo_root, change_set_id)
        self._write_json(HTTPStatus.OK, result)

    def do_DELETE(self) -> None:
        path = self._path()
        if not path.startswith("/api/dashboard/change-sets/"):
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        change_set_id = unquote(path.removeprefix("/api/dashboard/change-sets/"))
        try:
            result = delete_active_changeset(self.repo_root, change_set_id)
        except DashboardChangeSetNotFound as exc:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            return
        self._write_json(HTTPStatus.OK, result)

    def log_message(self, format: str, *args: object) -> None:
        message = format % args
        print(f"[{self.log_date_time_string()}] {self.address_string()} {message}", flush=True)

    def _path(self) -> str:
        return urlparse(self.path).path

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _write_asset(self, filename: str, content_type: str) -> None:
        path = Path(__file__).with_name("dashboard_assets") / filename
        if not path.exists():
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK.value)
        self.send_header("content-type", content_type)
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    run_ui_server(args.repo_root, host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
