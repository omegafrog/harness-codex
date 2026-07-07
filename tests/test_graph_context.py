import json
from pathlib import Path

from harness_codex.runtime.graph_context import (
    GRAPH_PATH,
    build_graph_context,
    graph_context_status,
    query_graph_context,
    rebuild_graph_context,
)


def test_graph_context_status_counts_graph_payload(tmp_path: Path) -> None:
    graph_path = tmp_path / GRAPH_PATH
    graph_path.parent.mkdir(parents=True)
    graph_path.write_text(
        json.dumps(
            {
                "nodes": [{"id": "A"}, {"id": "B"}],
                "edges": [{"source": "A", "target": "B"}],
                "communities": [{"id": "C1"}],
            }
        ),
        encoding="utf-8",
    )

    status = graph_context_status(tmp_path)

    assert status.exists
    assert status.graph_path == GRAPH_PATH
    assert status.nodes == 2
    assert status.edges == 1
    assert status.communities == 1


def test_graph_context_status_counts_graphify_links(tmp_path: Path) -> None:
    graph_path = tmp_path / GRAPH_PATH
    graph_path.parent.mkdir(parents=True)
    graph_path.write_text(
        json.dumps(
            {
                "nodes": [{"id": "A"}],
                "links": [{"source": "A", "target": "B"}, {"source": "B", "target": "C"}],
            }
        ),
        encoding="utf-8",
    )

    status = graph_context_status(tmp_path)

    assert status.edges == 2


def test_graph_context_status_counts_node_communities(tmp_path: Path) -> None:
    graph_path = tmp_path / GRAPH_PATH
    graph_path.parent.mkdir(parents=True)
    graph_path.write_text(
        json.dumps(
            {
                "nodes": [
                    {"id": "A", "community": 1},
                    {"id": "B", "community": 1},
                    {"id": "C", "community": 2},
                ],
                "links": [],
            }
        ),
        encoding="utf-8",
    )

    status = graph_context_status(tmp_path)

    assert status.communities == 2


def test_build_graph_context_writes_manifest_and_status_detects_stale(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "docs/design"
    source.mkdir(parents=True)
    document = source / "요구사항.md"
    document.write_text("# 요구사항\n", encoding="utf-8")

    monkeypatch.setattr("harness_codex.runtime.graph_context.shutil.which", lambda name: "/bin/graphify")

    def fake_run(command, **kwargs):
        graph_path = tmp_path / GRAPH_PATH
        graph_path.parent.mkdir(parents=True, exist_ok=True)
        graph_path.write_text('{"nodes":[{"id":"A"}],"links":[{"source":"A","target":"B"}]}', encoding="utf-8")

        class Completed:
            returncode = 0
            stdout = "built"
            stderr = ""

        return Completed()

    monkeypatch.setattr("harness_codex.runtime.graph_context.subprocess.run", fake_run)

    result = build_graph_context(tmp_path, ["docs/design"], backend="ollama", model="qwen3.5:9b")

    assert result.tracked_files == 1
    fresh = graph_context_status(tmp_path)
    assert fresh.exists
    assert not fresh.stale
    assert fresh.tracked_files == 1

    document.write_text("# 요구사항\n변경\n", encoding="utf-8")

    stale = graph_context_status(tmp_path)
    assert stale.stale
    assert stale.changed_files == 1


def test_rebuild_graph_context_uses_last_manifest(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "docs/design"
    source.mkdir(parents=True)
    (source / "요구사항.md").write_text("# 요구사항\n", encoding="utf-8")
    commands = []

    monkeypatch.setattr("harness_codex.runtime.graph_context.shutil.which", lambda name: "/bin/graphify")

    def fake_run(command, **kwargs):
        commands.append(command)
        graph_path = tmp_path / GRAPH_PATH
        graph_path.parent.mkdir(parents=True, exist_ok=True)
        graph_path.write_text('{"nodes":[],"links":[]}', encoding="utf-8")

        class Completed:
            returncode = 0
            stdout = "built"
            stderr = ""

        return Completed()

    monkeypatch.setattr("harness_codex.runtime.graph_context.subprocess.run", fake_run)

    build_graph_context(tmp_path, ["docs/design"], backend="ollama", model="qwen3.5:9b")
    rebuild_graph_context(tmp_path)

    assert len(commands) == 2
    assert commands[1][:2] == ["/bin/graphify", "extract"]
    assert commands[1][-4:] == ["--backend", "ollama", "--model", "qwen3.5:9b"]


def test_query_graph_context_delegates_to_graphify_cli(tmp_path: Path, monkeypatch) -> None:
    graph_path = tmp_path / GRAPH_PATH
    graph_path.parent.mkdir(parents=True)
    graph_path.write_text('{"nodes":[],"edges":[]}', encoding="utf-8")
    captured = {}

    monkeypatch.setattr("harness_codex.runtime.graph_context.shutil.which", lambda name: "/bin/graphify")

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["cwd"] = kwargs["cwd"]

        class Completed:
            returncode = 0
            stdout = "answer"
            stderr = ""

        return Completed()

    monkeypatch.setattr("harness_codex.runtime.graph_context.subprocess.run", fake_run)

    output = query_graph_context(tmp_path, "어떤 설계가 구현을 건드리나?", budget=900, dfs=True)

    assert output == "answer"
    assert captured["cwd"] == tmp_path
    assert captured["command"] == [
        "/bin/graphify",
        "query",
        "어떤 설계가 구현을 건드리나?",
        "--graph",
        str(graph_path),
        "--budget",
        "900",
        "--dfs",
    ]
