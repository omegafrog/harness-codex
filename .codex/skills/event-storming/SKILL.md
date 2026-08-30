---
name: event-storming
description: Map a use-case flow into actors, commands, events, policies, and external systems. Use before DDD aggregate or implementation-structure design.
---

# event-storming

## What it does

`event-storming` maps a use-case command into actors, commands, events, policies, and external systems for DDD.

It stays in the problem space and does not choose module structure, persistence, or frameworks.

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
