---
name: harness-maintenance-bootstrap
description: Create one general maintenance slice from a dispatched ChangeSet.
---

# Maintenance Sequence

1. Read only invocation artifacts.
2. Write every output path declared in the invocation, using its matching declared template.
3. Complete the result XML and stop.
