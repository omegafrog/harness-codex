"""Small HTTP API for the local harvest UI."""

from __future__ import annotations

import argparse
import errno
import json
import os
import signal
import shutil
import threading
import time
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

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
    load_changeset_harvest_ui,
    load_harvest_ui,
    rerun_ddd_architecture_step,
    restart_ddd_architecture,
    save_changeset_harvest_ui,
    start_requirements,
    start_ddd_architecture,
    start_event_storming,
    start_use_case_generation,
    start_use_cases,
)
from harness_codex.runtime.procedure_stages import render_initial_changeset


_SERVER_ENDPOINTS: tuple[tuple[str, str, str], ...] = (
    ("GET", "/", "dashboard"),
    ("GET", "/dashboard", "dashboard"),
    ("GET", "/assets/dashboard.css", "dashboard stylesheet"),
    ("GET", "/assets/dashboard.js", "dashboard script"),
    ("GET", "/api/endpoints", "endpoint discovery"),
    ("GET", "/api/harvest", "harvest session state"),
    ("GET", "/api/dashboard", "dashboard document state"),
    ("GET", "/api/dashboard/change-sets/{change_set_id}/resume", "resume scoped ChangeSet"),
    ("GET", "/api/dashboard/documents/{document_id}", "read dashboard document"),
    ("POST", "/api/change-sets/requirements/start", "start requirements ChangeSet"),
    ("POST", "/api/change-sets/requirements/answer", "answer requirements question"),
    ("POST", "/api/requirements/start", "start requirements"),
    ("POST", "/api/requirements/answer", "answer requirements"),
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
    ("PUT", "/api/dashboard/documents/{document_id}", "save dashboard document"),
    ("DELETE", "/api/dashboard/change-sets/{change_set_id}", "delete active ChangeSet"),
)


def _ui_server_pid_path(repo_root: Path) -> Path:
    return repo_root / ".harness" / "ui-server.pid"


def _terminate_previous_ui_server(repo_root: Path) -> bool:
    pid_path = _ui_server_pid_path(repo_root)
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, ValueError):
        return False
    process_matches = _is_harness_ui_server_process(pid)
    if pid <= 0 or pid == os.getpid() or process_matches is False:
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


def answer_requirements_changeset(repo_root: Path | str, change_set_id: str, answer: str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    activate_changeset_harvest_ui(root, change_set_id)
    result = answer_requirements(root, answer)
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


def run_ui_server(
    repo_root: Path | str,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
) -> None:
    root = Path(repo_root).resolve()

    class Handler(HarvestUiRequestHandler):
        repo_root = root

    restart_pending = _terminate_previous_ui_server(root)
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
                        str(body.get("answer", "")),
                    ),
                )
                return
            if path == "/api/requirements/start":
                result = start_requirements(self.repo_root, str(body.get("prompt", "")))
            elif path == "/api/requirements/answer":
                result = answer_requirements(self.repo_root, str(body.get("answer", "")))
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
