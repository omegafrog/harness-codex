"""Small HTTP API for the local harvest UI."""

from __future__ import annotations

import argparse
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from harness_codex.runtime.harvest_ui import (
    answer_requirements,
    load_harvest_ui,
    start_requirements,
    start_use_cases,
)


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
        if self._path() == "/api/harvest":
            self._write_json(HTTPStatus.OK, load_harvest_ui(self.repo_root).as_dict())
            return
        self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            body = self._read_body()
            path = self._path()
            if path == "/api/requirements/start":
                result = start_requirements(self.repo_root, str(body.get("prompt", "")))
            elif path == "/api/requirements/answer":
                result = answer_requirements(self.repo_root, str(body.get("answer", "")))
            elif path == "/api/use-cases/start":
                result = start_use_cases(self.repo_root)
            else:
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
        except ValueError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        self._write_json(HTTPStatus.OK, result.as_dict())

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
