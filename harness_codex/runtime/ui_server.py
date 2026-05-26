"""Small HTTP API for the local harvest UI."""

from __future__ import annotations

import argparse
import json
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
    answer_use_cases,
    answer_requirements,
    load_changeset_harvest_ui,
    load_harvest_ui,
    save_changeset_harvest_ui,
    start_requirements,
    start_use_case_generation,
    start_use_cases,
)
from harness_codex.runtime.procedure_stages import render_initial_changeset


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

    server = ThreadingHTTPServer((host, port), Handler)
    server.serve_forever()


class HarvestUiRequestHandler(BaseHTTPRequestHandler):
    repo_root: Path

    def do_GET(self) -> None:
        path = self._path()
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
        return

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
