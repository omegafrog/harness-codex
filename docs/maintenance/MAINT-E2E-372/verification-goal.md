# Verification Goal

- Observable success condition: `docs/verification/live-prompt-e2e.md` exists and records planner, plan security review, artifact review, execution, implementation security review, and wiki update outcomes.
- Required command evidence: `python -m pytest -q tests/runtime/test_live_prompt_e2e_artifact.py` passes.
- Regression condition: the artifact declares that runtime source files were not changed by this work item.
