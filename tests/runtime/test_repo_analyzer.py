import json
from pathlib import Path

from harness_codex.runtime.repo_analyzer import analyze_repository


def test_analyze_repository_detects_python_project(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='sample'\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src/sample.py").write_text("print('sample')\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests/test_sample.py").write_text("def test_sample(): pass\n", encoding="utf-8")
    (tmp_path / "venv/bin").mkdir(parents=True)
    (tmp_path / "venv/bin/python3").write_text("", encoding="utf-8")

    analysis = analyze_repository(tmp_path, "sample project")

    assert "Python" in analysis.technologies
    assert Path("pyproject.toml") in analysis.manifests
    assert Path("src") in analysis.source_roots
    assert Path("tests") in analysis.test_roots
    assert any(command.command == "./venv/bin/python3 -m pytest -q -s" for command in analysis.commands)


def test_analyze_repository_detects_node_scripts(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test": "vitest", "build": "vite build"}}),
        encoding="utf-8",
    )
    (tmp_path / "src").mkdir()
    (tmp_path / "src/app.ts").write_text("export {}\n", encoding="utf-8")

    analysis = analyze_repository(tmp_path)

    assert "Node.js" in analysis.technologies
    assert Path("package.json") in analysis.manifests
    assert any(command.command == "npm run test" for command in analysis.commands)
    assert any(command.command == "npm run build" for command in analysis.commands)


def test_analyze_repository_deduplicates_mixed_commands(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='sample'\n", encoding="utf-8")
    (tmp_path / "requirements.txt").write_text("pytest\n", encoding="utf-8")
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test": "vitest"}}),
        encoding="utf-8",
    )

    analysis = analyze_repository(tmp_path)

    command_values = [command.command for command in analysis.commands]
    assert len(command_values) == len(set(command_values))
    assert "Python" in analysis.technologies
    assert "Node.js" in analysis.technologies
