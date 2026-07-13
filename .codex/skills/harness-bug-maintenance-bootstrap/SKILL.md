---
name: harness-bug-maintenance-bootstrap
description: Create one bug maintenance slice from a dispatched ChangeSet.
---

# Bug Maintenance Sequence

1. Read only invocation artifacts.
2. Write one `docs/maintenance/<MAINT-ID>/` slice: reproduction, root-cause candidate, minimal boundary, and verification.
3. Complete the result XML and stop.
