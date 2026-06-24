# design_visualization Agent Reference

- Required skill entrypoint: `.codex/skills/harness-design-visualization/SKILL.md`
- Read the skill detailed instructions before generating artifacts.
- This role renders approved inputs; it never resolves pending technical decisions, changes aggregate boundaries, or invents unapproved behavior.
- On a missing, pending, or contradictory input, leave no partial diagram metadata marked `verified` and report the upstream blocker.
- The runtime validates Mermaid syntax markers and source-document hashes. Generate all declared outputs together.
