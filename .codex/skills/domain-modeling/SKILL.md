---
name: domain-modeling
description: Refine ubiquitous language and record durable domain decisions. Use when terminology is ambiguous, domain relationships conflict, or an ADR-worthy decision emerges.
---

# domain-modeling

## What it does

`domain-modeling` sharpens ubiquitous language, stress-tests relationships, and records durable decisions.

Use it when the model changes: coining a canonical term, resolving a contradiction, or recording an expensive-to-reverse decision.

`CONTEXT.md` is a glossary and nothing else: no implementation details, no spec, no scratch pad. When a real decision crystallizes, let the model decide whether to record it in an ADR.

## Durable vocabulary placement

When a Product Spec or Architecture Spec defines terminology, classify each term before the stage is complete:

- Project-wide canonical terms used across contexts belong in `CONTEXT.md`.
- Context-specific terms belong in `CONTEXT.md` with their bounded-context scope stated, or in a dedicated context glossary when one exists.
- Bounded-context names, responsibilities, and relationships belong in `CONTEXT-MAP.md`, not in the glossary.
- Spec-only temporary wording remains in the ticket-scoped Spec.

The Spec terminology table is evidence for this classification, not a substitute for updating the durable document. Add or correct the durable entry when the term is settled, preserve the Spec as the historical source, and record the source Spec or decision in the glossary row. Do not copy every descriptive noun into `CONTEXT.md`.

## When to reach for it

Type `/domain-modeling`, or let a higher-level flow reach for it automatically, when you are pinning down terminology, resolving an overloaded word, or recording an architectural decision.
