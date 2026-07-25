# SwiftCedi — Decisions Log

This file is the single source of truth for conventions actually adopted
during the build — not what was proposed, what was *decided*. Every Claude
Code session should read this before implementing anything that touches
another module. Update it in the same session a decision is made.

Format for each entry: **What / Why / Decided in module / Date.**

---

## Chart of Accounts & GL Codes

_Exact GL account codes and structure, once finalized in Module 7 — e.g.,
cash-in-hand account numbering scheme, per-branch account code pattern,
income/expense account ranges._

| Code Range | Category | Notes |
|---|---|---|
| _TBD_ | _TBD_ | _TBD_ |

---

## Table Naming Conventions

_Naming patterns adopted for the schema so later modules stay consistent
— e.g., plural snake_case table names, `_id` foreign key suffix,
`created_at`/`updated_at` on every table, soft-delete column name._

- _TBD_

---

## API Conventions

_REST resource naming, pagination pattern, error response shape,
authentication header, versioning approach._

- _TBD_

---

## Status Enums & Lifecycle States

_Canonical status values per entity, so "active/suspended/closed" doesn't
drift into different spellings across modules — e.g., branch status
values, loan status values, account status values._

| Entity | Status Values | Module |
|---|---|---|
| _TBD_ | _TBD_ | _TBD_ |

---

## Shared Services (Module 11 / Module 7 interfaces)

_Exact function/endpoint signatures for the audit-log service, the
approval-workflow service, and the GL posting interface, once built —
every other module should call these, not reimplement them._

- Audit log service: _TBD_
- Approval workflow service: _TBD_
- GL posting interface: _TBD_

---

## Branch Scoping Convention

_How `branch_id` is enforced across queries — e.g., middleware-level
scoping, row-level security, or application-layer filtering — decided
once and applied everywhere._

- _TBD_

---

## Open Questions

_Anything flagged as needing verification — especially regulatory figures
(BOG thresholds, GRA rates) that must not be hardcoded from general
knowledge — plus any module prompt conflicts that need a human call._

- [ ] _TBD_

---

## Deviations from the Original Module Prompts

_Anywhere the actual build diverged from `SwiftCedi_Module_Build_Prompts.md`,
and why — so future sessions don't "fix" something back to a plan that was
deliberately changed._

- _TBD_
