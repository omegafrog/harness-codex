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
from harness_codex.runtime.harvest_ui import (
    activate_changeset_harvest_ui,
    advance_ddd_architecture,
    advance_event_storming,
    answer_ddd_architecture,
    answer_event_storming,
    answer_use_cases,
    answer_requirements,
    complete_ubiquitous_language,
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
}


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
    ("POST", "/api/ddd-architecture/rerun-step", "rerun DDD architecture step"),
    ("POST", "/api/ddd-architecture/answer", "answer DDD architecture question"),
    ("POST", "/api/dashboard/change-sets/{change_set_id}/rerun-stage", "rerun design stage"),
    ("POST", "/api/dashboard/change-sets/{change_set_id}/planning/start", "start plan writing"),
    ("POST", "/api/dashboard/change-sets/{change_set_id}/implementation/start", "start implementation"),
    ("PUT", "/api/dashboard/documents/{document_id}", "save dashboard document"),
    ("DELETE", "/api/dashboard/change-sets/{change_set_id}", "delete active ChangeSet"),
)

_PLAN_WRITING_JOBS: dict[str, dict[str, Any]] = {}
_PLAN_WRITING_JOBS_LOCK = threading.Lock()
_IMPLEMENTATION_JOBS: dict[str, dict[str, Any]] = {}
_IMPLEMENTATION_JOBS_LOCK = threading.Lock()
_STAGE_RERUN_JOBS: dict[str, dict[str, Any]] = {}
_STAGE_RERUN_JOBS_LOCK = threading.Lock()
_DIFF_PATCH_LIMIT = 200_000
_ACTIVITY_TAIL_BYTES = 32_768
_ACTIVITY_LIMIT = 80


def _ui_server_pid_path(repo_root: Path) -> Path:
    return repo_root / ".harness" / "ui-server.pid"


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
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    _rerun_design_stage_command(root, change_set_id, stage_id, user_prompt, uc_id=uc_id)
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
        _STAGE_RERUN_JOBS[change_set_id] = job
    thread = threading.Thread(
        target=_run_rerun_design_stage_job,
        args=(root, change_set_id, stage_id, user_prompt, uc_id, answers or []),
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
        job = _STAGE_RERUN_JOBS.get(change_set_id)
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
) -> None:
    try:
        result = rerun_design_stage(
            root,
            change_set_id,
            stage_id,
            user_prompt,
            uc_id=uc_id,
            answers=answers,
        )
    except Exception as exc:
        with _STAGE_RERUN_JOBS_LOCK:
            job = _STAGE_RERUN_JOBS[change_set_id]
            job["status"] = "failed"
            job["finished_at"] = datetime.now().isoformat(timespec="seconds")
            job["finished_at_epoch"] = time.time()
            job["returncode"] = 1
            job["error"] = str(exc)
        return
    with _STAGE_RERUN_JOBS_LOCK:
        job = _STAGE_RERUN_JOBS[change_set_id]
        job["status"] = "needs_input" if result.get("needs_input") else "succeeded"
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        job["finished_at_epoch"] = time.time()
        job["returncode"] = 0
        job["output"] = result["output"]
        job["pending_questions"] = result.get("pending_questions", [])
        job["harvest"] = result["harvest"]
        job["dashboard"] = result["dashboard"]


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
    runs_root = root / ".harness" / "runs"
    if not runs_root.is_dir():
        return []
    candidates: list[tuple[float, Path]] = []
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
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
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
        cwd=root,
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
    change_set_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not needs_input:
        _mark_downstream_stages_stale(change_set_path, stage_id)
    save_changeset_harvest_ui(root, change_set_id)
    return {
        "change_set_id": change_set_id,
        "stage_id": stage_id,
        "uc_id": uc_id.strip(),
        "output": output,
        "needs_input": needs_input,
        "pending_questions": pending_questions,
        "harvest": load_changeset_harvest_ui(root, change_set_id).as_dict(),
        "dashboard": document_dashboard_state(root),
    }


def _stage_rerun_pending_questions(root: Path, output: str) -> list[dict[str, str]]:
    session_prefix = "Session: "
    for line in output.splitlines():
        if not line.startswith(session_prefix):
            continue
        session_path = root / line.removeprefix(session_prefix).strip()
        try:
            session = json.loads(session_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        questions = session.get("pending_questions", [])
        if not isinstance(questions, list):
            return []
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
        return sanitized
    return []


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
        "technical-decisions",
    } and not uc_id.strip():
        raise ValueError("uc_id is required for this design stage")
    command = [
        sys.executable,
        "-m",
        "harness_codex",
        stage_id,
        change_set_id,
    ]
    if prompt:
        command.extend(["--idea", prompt])
    command.append("--force")
    if uc_id.strip():
        command.extend(["--uc", uc_id.strip()])
    return command


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
    return {
        "change_set_id": change_set_id,
        "plans": [
            item.get("plan", {}) | {"work_item_id": item["id"], "name": item["name"]}
            for item in change_set["work_items"]
        ],
        "diff": {"files": _git_diff_files(root)},
        "job": _implementation_job(change_set_id),
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
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    change_set = _active_dashboard_change_set(root, change_set_id)
    normalized_uc_id = uc_id.strip()
    work_item_ids = {item["id"] for item in change_set["work_items"]}
    if normalized_uc_id not in work_item_ids:
        raise ValueError("uc_id must identify an affected ChangeSet work item")
    with _PLAN_WRITING_JOBS_LOCK:
        current = _PLAN_WRITING_JOBS.get(change_set_id)
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
        _PLAN_WRITING_JOBS[change_set_id] = job
    thread = threading.Thread(
        target=_run_plan_writing_job,
        args=(root, change_set_id, normalized_uc_id),
        daemon=True,
    )
    thread.start()
    return {"change_set_id": change_set_id, "job": dict(job)}


def _run_plan_writing_job(root: Path, change_set_id: str, uc_id: str) -> None:
    command = [
        sys.executable,
        "-m",
        "harness_codex",
        "plan-writing",
        change_set_id,
        "--uc",
        uc_id,
        "--apply",
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
    _active_dashboard_change_set(root, change_set_id)
    normalized = _normalize_diff_path(path)
    files = _git_diff_files(root)
    status_by_path = {item["path"]: item["status"] for item in files}
    if normalized not in status_by_path:
        return {
            "path": normalized,
            "patch": "",
            "truncated": False,
            "stale": True,
            "files": files,
        }
    patch = _git_file_patch(root, normalized, status_by_path[normalized])
    truncated = len(patch) > _DIFF_PATCH_LIMIT
    if truncated:
        patch = patch[:_DIFF_PATCH_LIMIT] + "\n\n[diff truncated]\n"
    return {"path": normalized, "patch": patch, "truncated": truncated, "stale": False}


def start_implementation_changeset(repo_root: Path | str, change_set_id: str, *, force_verification: bool = False) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    _active_dashboard_change_set(root, change_set_id)
    with _IMPLEMENTATION_JOBS_LOCK:
        current = _IMPLEMENTATION_JOBS.get(change_set_id)
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
        }
        _IMPLEMENTATION_JOBS[change_set_id] = job
    thread = threading.Thread(
        target=_run_implementation_job,
        args=(root, change_set_id, force_verification),
        daemon=True,
    )
    thread.start()
    return {"change_set_id": change_set_id, "job": dict(job)}


def _run_implementation_job(root: Path, change_set_id: str, force_verification: bool) -> None:
    command = [sys.executable, "-m", "harness_codex", "implementation", change_set_id, "--apply"]
    if force_verification:
        command.append("--force-verification")
    result = subprocess.run(command, cwd=root, text=True, capture_output=True, check=False)
    with _IMPLEMENTATION_JOBS_LOCK:
        job = _IMPLEMENTATION_JOBS[change_set_id]
        job["status"] = "succeeded" if result.returncode == 0 else "failed"
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        job["returncode"] = result.returncode
        job["output"] = result.stdout.strip()
        job["error"] = result.stderr.strip()


def _implementation_job(change_set_id: str) -> dict[str, Any] | None:
    with _IMPLEMENTATION_JOBS_LOCK:
        job = _IMPLEMENTATION_JOBS.get(change_set_id)
        return dict(job) if job else None


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
        files.append({"path": path, "status": status})
        if "R" in entry[:2] or "C" in entry[:2]:
            index += 1
    return files


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
                    force_verification=bool(body.get("force_verification", False)),
                )
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
