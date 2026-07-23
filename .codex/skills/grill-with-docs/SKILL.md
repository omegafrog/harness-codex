---
name: grill-with-docs
description: Interview a design one decision at a time while updating project vocabulary and durable decisions. Use when a design discussion should update CONTEXT.md or ADRs.
---

# grill-with-docs

## What it does

`grill-with-docs` is a thin wrapper that runs the grilling discipline while keeping the project's language and decision record current. It asks one question at a time, offers a recommended answer, and lets the model decide whether the result belongs in `CONTEXT.md` or a short ADR.

This skill does not replace `grilling` or `domain-modeling`; it combines them. `grilling` owns the interview shape. `domain-modeling` owns the glossary and any hard-to-reverse decision that should be recorded immediately.

## When to reach for it

Use `/grill-with-docs` when you need to stress-test a plan or design and want the resulting terminology or decision to be written down as soon as it settles.

## Pulled out on purpose

`grill-with-docs` is the convenience front door for sessions that should both interrogate the design and update the project's shared language or ADR trail when the model judges it useful.
