# CLAUDE.md — SwiftCedi Banking Management Platform

This file is loaded automatically into every Claude Code session in this
repo. It defines the standing rules for the whole project. Module-specific
build instructions live in `SwiftCedi_Module_Build_Prompts.md` — read the
relevant module section from there when starting or resuming work on a
module. Cross-module conventions that have actually been decided (not just
proposed) live in `Decisions_Log.md` — always check it before implementing
anything that touches another module (GL postings, audit logging,
approvals, branch scoping).

## Project Overview

SwiftCedi is a multi-branch microfinance banking management platform for a
licensed microfinance institution operating in Ghana. It covers branch
management, customer/CRM, loans, savings & susu, investments, cashier/vault
operations, general ledger & financial reporting, regulatory compliance,
analytics, agent field operations, role-based access control, and system
administration. Full module specs are in `SwiftCedi_Module_Build_Prompts.md`.

## Stack

- Backend: Node.js (Express or Fastify)
- Database: PostgreSQL
- Frontend: React
- Roles with distinct dashboards: Owner/Executive, Branch Manager, Loan
  Officer, Cashier/Teller, Field Agent, Investor-facing views

## Non-Negotiable Rules

These apply to every module, every time, with no exceptions unless a human
explicitly overrides them in writing in `Decisions_Log.md`:

1. **Branch as a first-class entity.** Every account, loan, deposit,
   transaction, and GL entry must carry a `branch_id` foreign key. Nothing
   is created "globally." Reports must be producible at branch level and
   consolidated (region/cluster/head-office) level without manual
   reconciliation.

2. **Money handling.** All monetary values are stored as integers in the
   lowest currency unit (pesewas, i.e., GHS cents). Never use floats for
   currency, anywhere — schema, application code, or API payloads.

3. **Audit trail.** Every write to a financial table (accounts,
   transactions, GL entries, loan status changes) produces an immutable
   audit log entry: user_id, timestamp, before/after state, branch_id.
   Financial records are never hard-deleted — use status/soft-delete flags
   with a reason code. Route all audit writes through the shared audit-log
   service built in Module 11 — do not write ad hoc audit logic per module.

4. **Maker-checker.** Any action with financial or account-status impact
   above a configurable threshold requires dual-control approval. The user
   who initiates an action can never be the one who approves it. Route
   this through the shared approval-workflow service built in Module 11 —
   do not reimplement approval logic per module.

5. **GL posting.** No module writes to `gl_journal_lines` directly. All
   postings go through the shared posting interface built in Module 7.
   Every journal entry's lines must sum to zero (debits = credits) —
   reject unbalanced entries at the application layer.

6. **Localization.** Currency is Ghana Cedi (GHS). Dates display as
   DD-MMM-YYYY. Regulatory context is Bank of Ghana (BOG) and Ghana
   Revenue Authority (GRA). Payment rails referenced elsewhere in the
   system: MTN MoMo, Telecel Cash, GHIPSS Instant Pay, Paystack, Hubtel.

7. **Regulatory figures.** Never hardcode BOG thresholds, provisioning
   rules, or GRA tax rates from general knowledge. Flag anything
   regulation-dependent as needing verification against current official
   guidance before it ships, and note it in `Decisions_Log.md` under Open
   Questions.

## Code Style

- Favor explicit, readable code over cleverness.
- Validate all input at the API boundary.
- Write unit tests for business logic (interest calculations, GL
  postings, approval state machines) alongside the implementation, not
  as an afterthought.
- Run tests before considering any module "done."

## Build Order

Follow the dependency order below unless `Decisions_Log.md` records a
reason to deviate:

1. Module 11 (RBAC / Audit) + Module 7 (GL) — build in parallel first,
   as shared infrastructure everything else depends on.
2. Module 1 (Branch)
3. Module 2 (Customer & CRM)
4. Module 3 (Loan) and Module 4 (Savings/Susu) — parallel once Module 2
   is stable
5. Module 6 (Cashier/Till/Vault)
6. Module 5 (Investment)
7. Payments integration (MoMo/GHIPSS/Paystack/Hubtel)
8. Module 8 (Regulatory & Compliance)
9. Module 9 (Analytics & Owner Dashboard) — last, once real data exists
10. Module 10 (Agent & Field Ops)
11. Module 12 (System Administration)

## Working Agreement

- Before implementing any module, read `Decisions_Log.md` in full.
- After making any decision that another module will depend on (a table
  name, a GL account code, an API contract, a status enum), write it into
  `Decisions_Log.md` in the same session, not "later."
- Ask before switching to "accept all" file-edit mode on anything touching
  money handling, GL posting, or approval logic — these get reviewed diff
  by diff.
- If a module prompt in `SwiftCedi_Module_Build_Prompts.md` conflicts with
  something already recorded in `Decisions_Log.md`, the Decisions Log
  wins — it reflects what was actually built, not what was originally
  planned.
