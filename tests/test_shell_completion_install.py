from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.shell_completion import install_completion


def test_install_completion_uses_installed_runtime_completion_dir(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    runtime_completions = repo / ".harness/runtime/completions"
    runtime_completions.mkdir(parents=True)
    (runtime_completions / "_harness").write_text("#compdef harness\n", encoding="utf-8")

    home = tmp_path / "home"
    result = install_completion(repo, shell="zsh", home=home)

    assert result[0].source == runtime_completions / "_harness"
    assert (home / ".zfunc/_harness").read_text(encoding="utf-8") == "#compdef harness\n"
