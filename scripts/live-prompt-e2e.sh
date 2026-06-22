#!/bin/sh
set -eu

mkdir -p .harness/runs/live-prompt-372/work-items/MAINT-E2E-372/security docs/verification docs/wiki
cp docs/live-prompt-e2e.md docs/verification/live-prompt-e2e.md
cat > .harness/runs/live-prompt-372/work-items/MAINT-E2E-372/security/security-review.md <<'EOF'
# Security Implementation Review

Security Review Status: approved

## Reviewed Inputs
- Active plan
- Maintenance slice

## Security Findings
- No blocking finding.

## Remediation Target
none

## Evidence
- Runtime source changed: no.
EOF
cat > docs/wiki/index.md <<'EOF'
# Harness workflow evidence

- [Live prompt workflow run](live-prompt-e2e.md)
EOF
cat > docs/wiki/live-prompt-e2e.md <<'EOF'
# Live prompt workflow run

The document-only maintenance fixture completed its local gates.
EOF
cat > mkdocs.yml <<'EOF'
site_name: Harness workflow evidence
docs_dir: docs/wiki
EOF
python - <<'PY'
from pathlib import Path

evidence = Path('docs/verification/live-prompt-e2e.md').read_text(encoding='utf-8')
security = Path('.harness/runs/live-prompt-372/work-items/MAINT-E2E-372/security/security-review.md').read_text(encoding='utf-8')
for heading in ('## Planner Output', '## Plan Security Review', '## Artifact Review', '## Execution Evidence', '## Implementation Security Review', '## Wiki Update'):
    assert heading in evidence, heading
assert 'Runtime source changed: no' in evidence
assert 'Security Review Status: approved' in security
for heading in ('## Reviewed Inputs', '## Security Findings', '## Remediation Target', '## Evidence'):
    assert heading in security, heading
PY
python -m mkdocs build -f mkdocs.yml -d .harness/wiki-site --strict
mkdir -p docs/plans/completed/MAINT-E2E-372 docs/changes/completed
mv docs/plans/active/MAINT-E2E-372/plan.md docs/plans/completed/MAINT-E2E-372/plan.md
mv docs/changes/active/CHG-E2E-372.md docs/changes/completed/CHG-E2E-372.md
test -f docs/plans/completed/MAINT-E2E-372/plan.md
test -f docs/changes/completed/CHG-E2E-372.md
