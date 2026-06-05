from pathlib import Path


SCRIPT = Path("scripts/install-harness-codex.sh").read_text(encoding="utf-8")


def test_installer_defines_workflow_artifacts_as_preserved_paths():
    for path in [
        ".harness/runs",
        ".harness/sessions",
        ".harness/state",
        ".harness/checkpoints",
        ".harness/ui",
        "docs/changes",
        "docs/use-cases",
        "docs/maintenance",
        "docs/plans",
        "docs/design/요구사항.md",
        "docs/design/유스케이스.md",
        "context.md",
        ".codex/repository-settings.md",
        ".codex/stack-profile.yaml",
        ".codex/test-gate.yaml",
        "AGENTS.md",
    ]:
        assert f'"{path}"' in SCRIPT


def test_installer_restores_preserved_paths_after_forced_runtime_copy():
    backup_index = SCRIPT.index("backup_preserved_paths")
    runtime_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/.harness"')
    codex_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/.codex"')
    restore_index = SCRIPT.index("restore_preserved_paths")

    assert backup_index < runtime_copy_index
    assert backup_index < codex_copy_index
    assert runtime_copy_index < restore_index
    assert codex_copy_index < restore_index


def test_installer_copies_shell_completion_sources():
    runtime_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/harness_codex"')
    completion_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/completions" "$TARGET_DIR/completions"')
    tests_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/tests/runtime"')

    assert runtime_copy_index < completion_copy_index < tests_copy_index


def test_default_project_files_are_not_overwritten_by_force_update():
    function_start = SCRIPT.index("copy_file_if_missing() {")
    function_end = SCRIPT.index("create_launcher() {")
    body = SCRIPT[function_start:function_end]

    assert 'if [[ -e "$dst" ]]' in body
    assert '"$FORCE"' not in body
