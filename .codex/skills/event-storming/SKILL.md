---
name: event-storming
description: Map a use-case flow into actors, commands, events, policies, and external systems. Use before DDD aggregate or implementation-structure design.
---

# event-storming

## What it does

`event-storming` starts from a specific use case command and maps the business flow into the domain elements that matter for DDD: events, policies, commands, external systems, and actors.

It stays in the problem space. It does not jump to module structure, persistence, or framework choices. It first lays out the story from the use case, then extracts the behavioral pieces that the design has to honor.

## Stakeholder input

The skill must reflect stakeholder perspectives. Ask about stakeholders whenever they are already known from prior context, or whenever the use case needs them to be made explicit.

Use those stakeholder views to shape the extraction of:

- actors
- commands
- events
- policies
- external systems

If the stakeholder set is incomplete, ask one question at a time until the missing perspective is clear enough to keep going.

## When to reach for it

Use `/event-storming` when a use case needs its domain flow made explicit before aggregates or code structure are discussed.

## Output

- candidate actors
- candidate commands
- candidate events
- candidate policies
- candidate external systems
- open questions for the next grilling step

## Pulled out on purpose

`event-storming` is the first DDD shaping step. `ddd-design` calls it before it narrows the model into aggregates and boundaries.
