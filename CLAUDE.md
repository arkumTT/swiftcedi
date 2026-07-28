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

## Development Commands

### Backend (`backend/`)

```bash
docker compose -f ../docker-compose.yml up -d   # Postgres 16 on :5432
cp .env.example .env
npm install
npm run dev                                     # migrates + seeds admin, then node --watch src/server.js
```

- `npm run migrate` — applies pending SQL files in `src/db/migrations/`
  (plain numbered files tracked in a `schema_migrations` table, no ORM;
  never edit an already-applied migration, add a new numbered file). Pass
  `--test` to target `TEST_DATABASE_URL` instead of `DATABASE_URL`.
- `npm run seed:admin` — idempotent bootstrap of the first `system_admin`
  user from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`; no-ops (with a log
  line, not a crash) if those aren't set or the user already exists.
- `npm test` — Jest, `--runInBand`. Runs `tests/unit/**` (mocked db, always
  runs) and `tests/integration/**` (needs `TEST_DATABASE_URL`; each
  integration file skips itself if it's unset).
- Single file: `npx jest tests/unit/loanMath.test.js`
- Single test: `npx jest -t 'name pattern'`

### Frontend (`frontend/`)

```bash
cp .env.example .env
npm install
npm run dev       # Vite; proxies /api/* to the backend per vite.config.ts
```

- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint (`.oxlintrc.json`)
- No frontend test runner is configured yet; Playwright is a devDependency
  but there's no `test` script or spec directory in `src/` — don't assume
  `npm test` works here.

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

## Architecture

### Backend layering

`routes/*.js` (thin, wrapped in `utils/asyncHandler.js`) → `modules/<name>/<name>Service.js`
(business logic, one directory per module, e.g. `modules/loan/loanService.js`
+ `loanMath.js` for pure interest/schedule calculations) → `shared/*.js`. All
routers are mounted in `src/app.js`, which takes the `pg` `Pool` as a
constructor arg (`createApp(pool)`) so tests can inject a different pool;
`src/server.js` is the only place that calls `getPool()` (`db/pool.js`) and
`app.listen()`.

Three shared services in `backend/src/shared/` are the only writers to their
respective tables — every module goes through these instead of touching
the tables directly (see rules 3–5 above and `Decisions_Log.md` §"Shared
Services"):
- `auditLog.js` — `audit_log` (DB-enforced append-only/immutable)
- `approvalWorkflow.js` — `approval_requests`. `requestApproval()` creates a
  pending request; `decide()` enforces maker ≠ checker (app layer + DB CHECK
  constraint) and then dispatches a side effect via either an explicit
  `execute` callback or a handler registered with
  `registerExecutionHandler(actionType, handler)`. Every module that has
  approval-gated actions registers its handler once, in `app.js`, at
  startup (`registerBranchExecutionHandlers()`,
  `registerLoanExecutionHandlers()`, etc.) — this is what lets the single
  generic `POST /approvals/:id/decide` route trigger a branch closure, loan
  approval, GL prior-period adjustment, etc. without a per-module decide
  endpoint.
- `glPosting.js` — `gl_journal_entries` / `gl_journal_lines`.
  `postJournalEntry()` validates lines balance (integer pesewas, exactly one
  of debit/credit per line, total debit == total credit) before it ever
  touches the DB, then posts inside its own transaction. `reverseJournalEntry()`
  builds a new offsetting entry rather than mutating the original.

RBAC/branch-scoping helpers used by nearly every route live in
`middleware/requirePermission.js` (`requirePermission(code)`,
`resolveBranchScope`/`resolveConsolidatedBranchScope`/`canAccessBranch`) and
`middleware/auth.js` (`requireAuth(pool)`, populates `req.user` with
`permissions`, `homeBranchId`, `roleName`, `crossBranchAccessibleBranchIds`).
The rule everywhere: a request defaults to the caller's home branch; only
`owner`/`system_admin` (`CROSS_BRANCH_ROLES`) or a role holding an explicit
cross-branch-access grant may act on another branch — see
`Decisions_Log.md` §"Branch Scoping Convention". `sessionStore.js` is an
explicitly-flagged in-memory placeholder for login/session state (see
`Decisions_Log.md` Open Questions), not a persisted/JWT mechanism.

### Frontend structure

One SPA, one route tree in `src/App.tsx`, two permission-gated sub-trees
sharing an `AppShell`:
- `/admin/*` (`layouts/AdminLayout.tsx`) — Admin Back Office
- `/app/*` (`layouts/MainAppLayout.tsx`) — Main Banking Application

Both gates come from the same `GET /auth/me` permission set
(`RequireAuth`/`RequirePermission` in `auth/RequireAuth.tsx`); the backend
enforces the identical check server-side on every route, so a hidden nav
item is never the only thing standing between a role and a screen. Screens
live under `features/admin/` and `features/main/<module>/`, one directory
per module, mirroring the backend's module boundaries.

Conventions to preserve when touching frontend code:
- Every color is a CSS custom-property token in `src/styles/tokens.css` —
  never a hardcoded hex; light/dark is a single `data-theme` attribute flip.
- Render money via `lib/format.ts`'s `formatGhs()` — never divide pesewas
  by 100 inline in a component.
- List/table screens go through `components/DataTable.tsx` for a consistent
  sticky-header/empty-state/error-state/row-action pattern.
- Server state goes through TanStack Query (`lib/queryClient.ts`); forms use
  `react-hook-form` + `zod`.

### Where to look things up

- `Decisions_Log.md` (repo root, ~2700 lines) is the authoritative record of
  what was actually built — table names, GL account codes, status enums,
  API conventions, and every shared service's exact signature — vs.
  `SwiftCedi_Module_Build_Prompts.md`, which is the original spec and loses
  to the Decisions Log on conflict. Use `grep -n '^##'
  Decisions_Log.md` to jump straight to a section instead of reading it
  top to bottom.

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
