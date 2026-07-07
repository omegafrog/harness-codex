"""Run the public harness command."""

from __future__ import annotations

import sys

from harness_codex.bootstrap import configure_runtime
from harness_codex.entrypoint import main
from harness_codex.runtime.migration_startup import migrate_runtime_artifacts

configure_runtime()
migrate_runtime_artifacts(sys.argv[1:])

raise SystemExit(main())
