# design_visualization Agent Reference

- Required skill entrypoint: `.codex/skills/harness-design-visualization/SKILL.md`
- Read the skill detailed instructions before generating artifacts.
- This role renders approved inputs; it never resolves pending technical decisions, changes aggregate boundaries, or invents unapproved behavior.
- On a missing, pending, or contradictory input, leave no partial diagram metadata marked `verified` and report the upstream blocker.
- The runtime validates Mermaid syntax markers and source-document hashes. Generate all declared outputs together.
- Read only approved DDD integration, technical decisions, selected slice artifacts, and runtime handoff metadata needed for source hashes.
- Do not inspect source code, build files, Docker files, CI files, runtime logs, or unrelated docs. Visualization must reflect approved design evidence, not implementation discovery.
- Keep command output compact: changed diagram paths, source hashes, Mermaid validation status, and blocker path only.
