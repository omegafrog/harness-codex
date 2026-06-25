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
        "docs/design/ubiquitous-language.md",
        "docs/design/유스케이스.md",
        "context.md",
        ".codex/repository-settings.md",
        ".codex/stack-profile.yaml",
        ".codex/test-gate.yaml",
        "AGENTS.md",
    ]:
        assert f'"{path}"' in SCRIPT


def test_installer_defines_harness_operation_gitignore_entries():
    for path in [
        ".harness/",
        ".codex/",
        "harness_codex/",
        "completions/",
        "harness",
        "scripts/install-harness-codex.sh",
        "scripts/bump_runtime_version.py",
        "tests/runtime/",
        "venv/",
    ]:
        assert f'"{path}"' in SCRIPT


def test_installer_does_not_gitignore_workflow_artifacts():
    gitignore_start = SCRIPT.index("HARNESS_GITIGNORE_ENTRIES=(")
    gitignore_end = SCRIPT.index(")", gitignore_start)
    gitignore_entries = SCRIPT[gitignore_start:gitignore_end]

    for path in [
        "docs/changes/",
        "docs/use-cases/",
        "docs/maintenance/",
        "docs/plans/",
        "docs/design/",
        "AGENTS.md",
        "ARCHITECTURE.md",
        "context.md",
    ]:
        assert f'"{path}"' not in gitignore_entries


def test_installer_restores_preserved_paths_after_forced_runtime_copy():
    backup_index = SCRIPT.index("backup_preserved_paths")
    runtime_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/.harness"')
    codex_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/.codex"')
    restore_index = SCRIPT.index("restore_preserved_paths")

    assert backup_index < runtime_copy_index
    assert backup_index < codex_copy_index
    assert runtime_copy_index < restore_index
    assert codex_copy_index < restore_index


def test_installer_updates_gitignore_during_runtime_install():
    runtime_start = SCRIPT.index("install_runtime_files() {")
    skills_only_start = SCRIPT.index("install_skills_only() {")
    runtime_body = SCRIPT[runtime_start:skills_only_start]

    mkdir_index = runtime_body.index('mkdir -p \\')
    gitignore_index = runtime_body.index("ensure_harness_gitignore_entries")
    restore_index = runtime_body.index("restore_preserved_paths")

    assert mkdir_index < gitignore_index < restore_index


def test_installer_copies_shell_completion_sources():
    runtime_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/harness_codex"')
    completion_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/completions" "$TARGET_DIR/completions"')
    installer_copy_index = SCRIPT.index(
        'copy_dir "$SRC_DIR/scripts/install-harness-codex.sh" '
        '"$TARGET_DIR/scripts/install-harness-codex.sh"'
    )
    version_script_copy_index = SCRIPT.index(
        'copy_dir "$SRC_DIR/scripts/bump_runtime_version.py" '
        '"$TARGET_DIR/scripts/bump_runtime_version.py"'
    )
    tests_copy_index = SCRIPT.index('copy_dir "$SRC_DIR/tests/runtime"')

    assert (
        runtime_copy_index
        < completion_copy_index
        < installer_copy_index
        < version_script_copy_index
        < tests_copy_index
    )


def test_installer_exposes_runtime_and_skills_only_modes():
    assert "--runtime" in SCRIPT
    assert "--skills-only" in SCRIPT
    assert 'HARNESS_CODEX_INSTALL_MODE  runtime or skills-only' in SCRIPT
    assert 'copy_dir "$SRC_DIR/.codex/skills" "$TARGET_DIR/.codex/skills"' in SCRIPT


def test_skills_only_mode_does_not_copy_runtime_files():
    skills_only_start = SCRIPT.index("install_skills_only() {")
    skills_only_end = SCRIPT.rindex('case "$INSTALL_MODE" in')
    skills_only_body = SCRIPT[skills_only_start:skills_only_end]

    assert 'copy_dir "$SRC_DIR/.codex/skills" "$TARGET_DIR/.codex/skills"' in skills_only_body
    assert 'copy_dir "$SRC_DIR/harness_codex"' not in skills_only_body
    assert 'copy_dir "$SRC_DIR/.harness"' not in skills_only_body
    assert "create_launcher" not in skills_only_body
    assert "python3 -m venv" not in skills_only_body
    assert "ensure_harness_gitignore_entries" not in skills_only_body


def test_default_project_files_are_not_overwritten_by_force_update():
    function_start = SCRIPT.index("copy_file_if_missing() {")
    function_end = SCRIPT.index("create_launcher() {")
    body = SCRIPT[function_start:function_end]

    assert 'if [[ -e "$dst" ]]' in body
    assert '"$FORCE"' not in body
