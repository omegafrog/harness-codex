"""Deprecated module shim for legacy work-item verification."""

from warnings import warn

warn(
    "harness_codex.runtime.verify_work_item is a two-release compatibility shim; "
    "use generic evidence envelopes instead",
    DeprecationWarning,
    stacklevel=2,
)

from harness_codex.compat.verify_work_item import *  # noqa: F401,F403,E402
from harness_codex.compat.verify_work_item import main as _main


if __name__ == "__main__":
    raise SystemExit(_main())
