---
name: grilling
description: Stress-test a plan or design through one focused question at a time. Use when requirements, tradeoffs, or assumptions need deliberate stakeholder validation.
---

# grilling

## What it does

`grilling` is the interview primitive: it stress-tests a plan or design one decision at a time until the reasoning is shared.

It asks one question at a time, includes a recommended answer, and waits for the response before moving on. It does not ask for facts the codebase or documents can already settle.

## When to reach for it

Use `/grilling` when you want to pressure-test a plan, design, or idea before building it.

## Pulled out on purpose

`grilling` is the shared interview engine used by higher-level wrappers such as `/grill-me` and `/grill-with-docs`.
