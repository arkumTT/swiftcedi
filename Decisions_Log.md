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

Finalized in Module 1 (migration 009_gl_control_accounts.sql):

| Code Range | Category | Notes |
|---|---|---|
| 1000-1999 | Asset | `1000` Cash in Hand, `1010` Vault Cash, `1020` Cash in Transit, `1030` Cash with Agents (Module 4), `1100` Loans Receivable (Module 3) |
| 2000-2999 | Liability | `2000` Customer Deposits (Module 4), `2010` Susu Deposits (Module 4), `2020` Agent Commission Payable (Module 4), `2030` Investment Deposits Payable (Module 5) |
| 3000-3999 | Equity | None seeded yet — see below, this stays true even after Module 5 |
| 4000-4999 | Income | `4000` Operating Income, `4010` Loan Interest Income (Module 3), `4020` Loan Fee Income (Module 3), `4030` Savings Fee Income (Module 4), `4040` Early Withdrawal Penalty Income (Module 5) |
| 5000-5999 | Expense | `5000` Operating Expense, `5100` Loan Loss Expense (Module 3), `5200` Agent Commission Expense (Module 4), `5300` Investment Interest Expense (Module 5) |

**Module 6 added NO new GL control accounts.** Till float, cash-back, and
till-close all move cash between the branch's EXISTING Cash in Hand and
Vault sub-accounts (both from Module 1) — see the Cashier service section
below for why, and for why there's deliberately no separate
`vault_balances` table either.

Branch sub-account pattern: on branch creation, `branchService.createBranch()`
auto-generates a sub-account per control account (17 as of Module 5 — the
full `branchService.CONTROL_ACCOUNT_CODES` map, minus `1020` Cash in
Transit which is org-wide by design since it spans two branches) coded
`<control_code>.<branch_code>` (e.g. `1000.NRA-01`), each with
`branch_id` = the new branch and `parent_account_id` = the matching
org-wide control row — so a consolidated report can roll sub-accounts up to
their control account by `parent_account_id`, and a branch report can
filter `gl_accounts.branch_id`. **This is why branch codes are capped at 10
characters** (enforced by `branches_code_shape_chk` and
`branchService.validateBranchCode()`) — the composed code must fit
`gl_accounts.code`'s `VARCHAR(20)`.

Equity control accounts aren't seeded yet. **Correction to this note's own
earlier guess**: it used to say "add them ... e.g. Module 5 for investor
equity" — Module 5 (Investments) turned out to need a LIABILITY control
(`2030` Investment Deposits Payable), not equity. The spec describes a
fixed-term deposit with a `maturity_date` and a redemption/payout, i.e.
money the institution owes back to the investor on a schedule — that's
debt, not an ownership stake (no dividend-contingent-on-profit language,
no implied governance/ownership rights). If the business later wants
genuine investor equity/shareholding, that is a different, unbuilt
product and needs its own explicit decision, not a relabeling of this
one — see Open Questions for the regulatory classification question this
raises. Liability controls first arrived with Module 4's deposit
accounting and Module 5 added to the same range.

**How to add a control account (the Module 3 recipe, follow it verbatim):**
a new migration (a) `INSERT`s the org-wide control row(s) into
`gl_accounts`, (b) `ALTER TABLE branch_gl_accounts ADD COLUMN
<name>_account_id BIGINT REFERENCES gl_accounts(id)`, (c) backfills a
sub-account for **every existing branch** in a `DO $$` loop and sets the
new column, then (d) `ALTER COLUMN ... SET NOT NULL`. Then add the code to
`branchService.CONTROL_ACCOUNT_CODES` and create the sub-account in
`createBranch()` so *new* branches get it too. Miss either half and you
get branches with a NULL account id (existing branches) or new branches
that can't post (new branches). See migration
`021_loan_gl_control_accounts.sql`.

That migration also **repaired a latent Module 1 gap it uncovered**: the
`HQ` branch was seeded directly by migration 001's `INSERT INTO branches`,
bypassing `createBranch()`, so it never had a `branch_gl_accounts` row or
any GL sub-accounts at all. The backfill now creates the full set for any
branch missing one, so `HQ` is a complete branch like any other.

---

## Table Naming Conventions

_Naming patterns adopted for the schema so later modules stay consistent
— e.g., plural snake_case table names, `_id` foreign key suffix,
`created_at`/`updated_at` on every table, soft-delete column name._

- Tables: plural snake_case (`branches`, `gl_accounts`, `approval_requests`).
- Primary keys: `id BIGSERIAL`. Foreign keys: `<referenced_singular>_id`
  (e.g. `branch_id`, `role_id`, `journal_entry_id`).
- Every table has `created_at TIMESTAMPTZ DEFAULT now()`; mutable tables
  also have `updated_at TIMESTAMPTZ DEFAULT now()` (immutable/append-only
  tables like `audit_log` and `gl_journal_lines` deliberately omit it).
- Money columns are always integer pesewas with an explicit `_pesewas`
  suffix (`debit_pesewas`, `amount_threshold_pesewas`) — never a bare
  `amount`, so a float/decimal accidentally sneaking in is easy to catch in
  review.
- Status columns are `status VARCHAR(20)` with a `CHECK` constraint
  enumerating allowed values at the DB layer (not just app-layer
  validation) — see "Status Enums & Lifecycle States" below. Exception:
  `customers.classification` (Module 2) is a free-form tag, not a
  lifecycle status — deliberately NOT `CHECK`-constrained, since the spec
  wants it usable as an open, admin-extensible segmentation filter by
  other modules, not a closed enum.
- Migrations live in `backend/src/db/migrations/`, named
  `NNN_description.sql`, applied in filename order and tracked in a
  `schema_migrations` table by `backend/src/db/migrate.js`. Each file is
  additive (no down-migrations for this build) — a wrong migration gets a
  new corrective migration, not an edited history. (A migration that has
  not yet been committed/pushed may still be edited in place — it hasn't
  been applied anywhere but the author's local db.)
- **Integration-test cleanup is a shared cross-module concern.** Each
  `tests/integration/*.test.js` wipes the tables it needs in `beforeAll`,
  in FK order. Adding a table that FKs to `users`, `customers`,
  `approval_requests`, or `gl_journal_entries` therefore breaks *other*
  modules' suites (they run in one process against one database, in
  arbitrary order) unless the new table is added to their cleanup lists
  too. This has caught out every module so far — when you add tables,
  run the **full** `npm test`, not just your own file, and verify with a
  reversed file order. Note also that immutable tables (`audit_log`,
  `gl_journal_lines`, `loan_repayments`, `savings_transactions`,
  `susu_collections`, `overdraft_interest_accruals`, `investment_accruals`)
  need `TRUNCATE`, since their triggers block plain `DELETE`.
- **A second, latent cross-suite gap found and fixed in Module 6**: every
  suite's cleanup did an UNSCOPED `DELETE FROM branch_gl_accounts` and
  `DELETE FROM gl_accounts WHERE branch_id IS NOT NULL`, which wipes HQ's
  own GL sub-accounts and `branch_gl_accounts` row too — and nothing ever
  recreates them for HQ (only `branchService.createBranch()` does that,
  which HQ bypassed at seed time; see below). This was silently harmless
  for five modules because nothing ever queried HQ's GL setup specifically
  — Module 6's `getConsolidatedCashPosition()` (which queries **every**
  branch, HQ included) was the first code to do so, and broke in the test
  database as soon as any earlier suite's cleanup had already run once.
  Fixed by scoping both deletes to exclude HQ's `branch_id` in all six
  integration test files — **not** by adding defensive code to the
  service itself, since every branch always has a complete GL setup in
  real operation (guaranteed by `createBranch()` and migration 021's
  one-time HQ backfill); skipping a "branch with no GL accounts" in
  production code would be handling a scenario that cannot happen, which
  CLAUDE.md's code-style rules explicitly discourage.
- **`branches`** started as a stub in Module 11/7's migrations (just `id,
  code, name, status, created_at, updated_at`) so every other table could
  carry a real `branch_id` FK immediately. Module 1 (migration
  010_branch_hierarchy.sql) `ALTER TABLE`'d it to add `region_id`,
  `cluster_id`, `address`, `gps_lat`, `gps_lng`, `opening_date`,
  `operating_hours`, `licence_ref` — it did NOT drop/recreate the table,
  since `users`, `gl_accounts`, `audit_log`, etc. already referenced
  `branches.id`. Any future module adding branch fields should extend the
  same table the same way, not create a parallel `branch_details` table.
- **Branch codes**: `VARCHAR(20)`, but constrained to 2-10 chars,
  uppercase letters/digits/hyphens (`branches_code_shape_chk`,
  `branchService.validateBranchCode()`) — see "Chart of Accounts" above
  for why the 10-char cap exists. Immutable once the branch has any GL
  activity (`branchService.updateBranch()` checks `gl_journal_lines` for
  the branch before allowing a code change; enforced at the application
  layer only, not the DB, since "has any journal line" isn't a static
  constraint).
- Head office is modeled as a real branch, seeded as `branches` row with
  `code = 'HQ'` — per the Module 1 prompt's "even if head office is
  modeled as a branch itself." Use this row's id, not `NULL`, when a
  write is organizationally global but the schema requires a branch_id
  (e.g. an RBAC admin action's audit log entry).

---

## API Conventions

_REST resource naming, pagination pattern, error response shape,
authentication header, versioning approach._

- Resource paths are plural, kebab/lower-case, mounted at the app root
  (no `/api/v1` prefix yet — add versioning when a breaking change is
  actually needed, not preemptively): `/rbac/roles`, `/rbac/users`,
  `/audit-log`, `/approvals`, `/gl/accounts`, `/gl/journal-entries`,
  `/branches`, `/branches/regions`, `/branches/clusters`,
  `/branches/transfers`, `/branches/:id/status`,
  `/branches/:id/staff-assignments`, `/branches/:id/cross-branch-grants`,
  `/branches/:id/performance`, `/customers`, `/customers/:id/360`,
  `/customers/:id/kyc-status`, `/customers/:id/closure-requests`,
  `/customers/:id/branch-transfer`, `/customers/:id/documents`,
  `/customers/:id/next-of-kin`, `/customers/:id/credit-bureau-lookups`,
  `/groups`, `/groups/:id/members`, `/groups/:id/leader`,
  `/account-closures/:id` (top-level — resolves a closure by its own id,
  not nested under a customer, mirroring `getAccountClosure()`'s signature),
  `/loans`, `/loans/products`, `/loans/calculator`,
  `/loans/reports/arrears`, `/loans/:id/appraisals`,
  `/loans/:id/approval-requests`, `/loans/:id/disburse`,
  `/loans/:id/schedule`, `/loans/:id/repayments`,
  `/loans/:id/restructure-requests`, `/loans/:id/write-off`,
  `/loans/:id/collateral`, `/loans/:id/guarantors`, `/savings`,
  `/savings/products`, `/savings/:id/deposits`,
  `/savings/:id/withdrawal-requests`, `/savings/:id/charges`,
  `/savings/:id/statement`, `/savings/:id/reconciliation`,
  `/savings/withdrawal-requests/:id/settle`,
  `/savings/reconciliation/branch/:branchId`,
  `/savings/standing-orders`, `/savings/standing-orders/execute-due`,
  `/savings/standing-orders/failures`, `/susu`, `/susu/:id/collections`,
  `/susu/:id/complete-cycle`, `/susu/:id/payout`, `/susu/remittances`,
  `/susu/agents/:agentId/commissions`, `/analytics/live-stats`,
  `/analytics/portfolio-quality`, `/analytics/profitability`,
  `/analytics/top-loan-customers`, `/analytics/growth-trends`,
  `/analytics/agent-productivity`, `/analytics/report-pack`,
  `/analytics/dashboard-configs/mine`, `/analytics/dashboard-configs/:roleId`,
  `/agents/ping`, `/agents/reconciliations`,
  `/agents/reconciliations/run-branch`, `/agents/reconciliations/:id/resolve`,
  `/agents/:id/reassign`, `/agents/:id/assignments`, `/agents/:id/location`,
  `/agents/:id/locations`, `/agents/:id/reconciliations`,
  `/compliance/loan-classification-configs`, `/compliance/loan-classification/run`,
  `/compliance/loan-classification/summary`, `/compliance/ratio-definitions/:name`,
  `/compliance/ratios/:name/compute`, `/compliance/tax-rates/:taxType`,
  `/compliance/tax/withholding-summary`, `/compliance/tax/vat-summary`,
  `/compliance/report-templates/:id/status`, `/compliance/reports/generate`,
  `/compliance/reports/:id/submit`, `/compliance/aml/rules/:id/status`,
  `/compliance/aml/screen`, `/compliance/aml/flags/:id/review`,
  `/compliance/sanctions/screen`, `/compliance/sanctions/screen-batch`,
  `/compliance/sanctions/results/:id/resolve`.
- Route file ordering rule (see `backend/src/routes/branches.js`): every
  fixed-prefix path (`/regions`, `/clusters`, `/transfers`,
  `/performance/compare`) must be registered before the `/:id` catch-all,
  or Express will match e.g. `GET /branches/performance/compare` as
  `GET /branches/:id` with `id="performance"`.
- Error handling: custom error classes may set `err.statusCode` (e.g.
  `BranchValidationError` → 400, `BranchNotFoundError` → 404,
  `BranchImmutableCodeError`/`InvalidStatusTransitionError`/
  `BranchReconciliationError` → 409); `app.js`'s final error handler uses
  `err.statusCode` if present, else 500. Older routes (rbac/gl/approvals)
  still use explicit `instanceof` checks per error type — both patterns
  coexist; new routes should prefer the `statusCode` property since it
  needs no route-level knowledge of every module's error classes (this is
  what let the generic `POST /approvals/:id/decide` endpoint surface a
  `BranchReconciliationError` thrown deep inside a registered execution
  handler as a clean 409 without approvals.js importing branchService).
- Auth: `Authorization: Bearer <token>` header, token obtained from
  `POST /auth/login` (`{ email, password }` → `{ token }`). See "Open
  Questions" — this session's session store is an in-memory placeholder,
  not the final auth mechanism.
- Request/response bodies use camelCase JSON keys (`homeBranchId`,
  `amountPesewas`) even though the DB is snake_case — the HTTP layer is the
  translation boundary, not the DB.
- Errors: `{ "error": "<message>" }` with the appropriate 4xx status
  (400 validation, 401 unauthenticated, 403 authorization/maker-checker
  violation, 404 not found). No envelope/wrapper on success responses —
  the resource (or array of resources) is returned directly.
- Pagination (only `GET /audit-log` needs it so far): `?limit=&offset=`
  query params, default `limit=50`, hard cap `limit=500`.
- Branch scoping on requests: see "Branch Scoping Convention" below.

---

## Status Enums & Lifecycle States

_Canonical status values per entity, so "active/suspended/closed" doesn't
drift into different spellings across modules — e.g., branch status
values, loan status values, account status values._

| Entity | Status Values | Module |
|---|---|---|
| `branches.status` | `active`, `suspended`, `under_review`, `closed` | 1. **Not a free graph** — see the transition table below; `CHECK` constraint enumerates the values but the DB doesn't (can't easily) enforce which transitions are legal, so `branchService.isValidStatusTransition()` does |
| `users.status` | `active`, `suspended`, `disabled` | 11 |
| `gl_accounts.status` | `active`, `inactive` | 7 |
| `gl_accounts.account_type` | `asset`, `liability`, `equity`, `income`, `expense` | 7 |
| `gl_periods.period_type` | `month`, `year` | 7 |
| `gl_journal_entries.entry_type` | `standard`, `prior_period_adjustment` | 7 — only `prior_period_adjustment` may post into a locked period |
| `gl_journal_entries.status` | `posted`, `reversed` | 7 — a "reversed" entry keeps its original immutable lines; reversal is a separate new entry, never an edit. `reversed` existed in this CHECK constraint since Module 7 but had no producer until Module 6's `glPosting.reverseJournalEntry()` |
| `approval_requests.status` | `pending`, `approved`, `rejected`, `cancelled` | 11 |
| `branch_transfers.status` | `pending`, `in_transit`, `completed`, `cancelled` | 1 — `initiateTransfer()` moves straight from insert to `in_transit` (posts the outbound GL entry synchronously); `pending` exists in the enum for a future draft/pre-posting state but nothing produces it yet |
| `customers.status` | `active`, `inactive`, `closed` | 2 — `active`/`inactive` toggle directly (`customerService.isValidDirectStatusTransition()`); `closed` is only reachable via the maker-checker closure flow, never a direct transition, and is terminal (no reactivation path — see Open Questions) |
| `customers.kyc_status` | `pending`, `verified`, `rejected` | 2 — no restrictive state machine; any value may follow any other (re-review after resubmission, or downgrading a verified customer if fraud surfaces later), just permission-gated and audited via `customerService.updateKycStatus()` |
| `customers.customer_type` | `individual`, `group`, `sme` | 2 |
| `credit_bureau_lookups.status` | `completed`, `failed` | 2 |
| `loans.status` | `applied`, `appraised`, `pending_approval`, `approved`, `rejected`, `disbursed`, `closed`, `written_off` | 3 — see the lifecycle note below; `closed` (fully repaid) and `written_off` (bad debt) are both terminal and deliberately distinct, since Module 8/9 must be able to tell a performing payoff from a loss |
| `loan_products.loan_type` / `loans.loan_type` | `individual`, `group`, `overdraft` | 3 — `overdraft` is in the enum but NOT implemented; it needs a savings account to attach to (Module 4). See Open Questions |
| `loan_products.interest_method` / `loans.interest_method` | `flat`, `reducing_balance` | 3 |
| `loan_products.status` | `active`, `inactive` | 3 |
| `loan_schedules.status` | `pending`, `partially_paid`, `paid` | 3 |
| `loan_appraisals.recommendation` | `recommend`, `decline` | 3 — a `decline` moves the loan straight to `rejected` |
| `loan_collateral.verification_status` / `loan_guarantors.verification_status` | `pending`, `verified`, `rejected` | 3 |
| `savings_products.status` | `active`, `inactive` | 4 |
| `savings_accounts.status` | `active`, `dormant`, `closed` | 4 — `closed` requires a zero balance; nothing sets `dormant` yet (no inactivity job until Module 12) |
| `savings_transactions.txn_type` | `deposit`, `withdrawal`, `maintenance_fee`, `withdrawal_fee`, `min_balance_charge`, `standing_order_out`, `standing_order_in`, `susu_payout` | 4 — the signed `amount_pesewas` carries direction, so type is descriptive not directional |
| `withdrawal_requests.status` | `pending`, `paid`, `rejected` | 4 |
| `susu_accounts.status` | `active`, `completed`, `uncompleted`, `paid_out` | 4 — `completed`/`uncompleted` is the spec's required split (target reached vs. cycle ended short); `paid_out` is added so a settled account is distinguishable from one still awaiting payout |
| `susu_commissions.basis` | `per_collection`, `per_cycle` | 4 — only `per_collection` is produced today |
| `standing_orders.status` | `active`, `paused`, `suspended`, `completed`, `cancelled` | 4 — `suspended` is set automatically after `max_consecutive_failures`; `paused`/`cancelled` are deliberate human actions |
| `standing_order_runs.status` | `success`, `failed` | 4 — every run writes one, so a failure is never silent |
| `investment_products.status` | `active`, `inactive` | 5 |
| `investment_products.payout_frequency` / `investments.payout_frequency` | `monthly`, `at_maturity` | 5 — the spec's own examples; other frequencies are a future extension, not guessed at |
| `investments.status` | `applied`, `pending_approval`, `rejected`, `approved`, `active`, `matured`, `redeemed` | 5 — mirrors the loan lifecycle's applied/pending_approval/approved/disbursed shape; `matured` exists in the enum but nothing sets it yet (no Module 12 sweep — see Open Questions), same as savings' unused `dormant` |
| `investment_payouts.status` | `pending`, `paid`, `rejected` | 5 |
| `investment_redemptions.status` | `pending`, `approved`, `paid`, `rejected` | 5 — never jumps straight to `paid`; see the Investment service section |
| `cashier_tills.status` | `open`, `closed` | 6 |
| `cash_back_requests.status` | `pending`, `paid`, `rejected` | 6 |
| `transaction_reversals.status` | `pending`, `approved`, `reversed`, `rejected` | 6 — same never-jumps-straight-to-executed shape as `investment_redemptions.status` |
| `day_close_snapshots.period_type` | `day`, `month`, `year` | 6 — `month`/`year` also create+lock a `gl_periods` row; `day` has no `gl_periods` equivalent (that table only supports month/year), so a day-lock is enforced by `cashierService` itself, not `glPosting` |
| `gl_prior_period_adjustments.status` | `pending`, `approved`, `posted`, `rejected` | 6/7 (shared `glPosting.js`, added while building Module 6 — see the Cashier service section) |
| `gl_manual_entries.status` | `pending`, `approved`, `posted`, `rejected` | 7 — same shape as `gl_prior_period_adjustments.status`, deliberately a separate table (see the GL service section) |
| `bank_accounts.status` | `active`, `inactive` | 7 |
| `bank_statement_lines.status` | `unmatched`, `matched` | 7 — `matched` requires (and is the only status paired with) a non-null `matched_journal_line_id`, enforced by a CHECK constraint |
| `field_agents.status` | `active`, `inactive` | 10 |
| `agent_reconciliations.status` | `matched`, `pending_review`, `resolved` | 10 — `matched`/`pending_review` are set automatically from the computed variance; `resolved` is reachable ONLY via `resolveReconciliation()`, never automatically — a CHECK constraint ties `resolved` 1:1 to `reviewed_by`/`reviewed_at` both being set |
| `loan_classification_configs.category` / `loan_classifications.category` | `current`, `olem`, `substandard`, `doubtful`, `loss` | 8 — BOG's prudential loan classification categories; thresholds/rates are configurable data, never hardcoded (see the Compliance service section) |
| `regulatory_report_templates.status` | `active`, `retired` | 8 — a lifecycle flag only; template CONTENT (`field_mappings`) is immutable once created, a layout change is always a new `version` |
| `regulatory_report_submissions.status` | `generated`, `submitted` | 8 — `submitted` requires (and is the only status paired with) non-null `submitted_by`/`submitted_at`, enforced by a CHECK constraint |
| `aml_rules.status` | `active`, `inactive` | 8 |
| `aml_flags.status` | `open`, `reviewed`, `cleared` | 8 — NEVER auto-clears (module prompt's own rule); `reviewAmlFlag()` is the only path off `open`, and never back to it. A CHECK constraint ties `open` 1:1 to `reviewed_by`/`reviewed_at`/`review_notes` all being null |
| `sanctions_screening_results.match_status` | `no_match`, `potential_match`, `confirmed_match`, `cleared` | 8 — the automatic screening pass can only ever produce `no_match`/`potential_match`; `confirmed_match`/`cleared` are reachable ONLY via `resolveScreeningMatch()`, same "never auto-resolve a compliance finding" discipline as `aml_flags.status` |

**`branches.status` transition table** (`branchService.VALID_STATUS_TRANSITIONS`):

| From \ To | active | suspended | under_review | closed |
|---|---|---|---|---|
| active | — | ✅ | ✅ | ❌ |
| suspended | ✅ | — | ✅ | ✅ |
| under_review | ✅ | ✅ | — | ✅ |
| closed | ❌ | ❌ | ❌ | — (terminal) |

A branch cannot close directly from `active` — it must pass through
`suspended` or `under_review` first. This reads stricter than the Module 1
prompt's literal "active -> suspended -> under-review -> closed" chain
requires, but is a deliberate governance rail (closing is highest-impact
and irreversible), not an oversight — see Deviations.

`customers.status` is simpler: `active <-> inactive` freely
(`customerService.deactivateCustomer`/`reactivateCustomer`, no approval),
but `closed` is reachable ONLY via `requestClosure()` +
`approvalWorkflow.decide()` (never a direct transition, mirroring how
branch closure works), and is terminal — there is no reactivate-from-closed
endpoint. If a real "unclose" business need shows up, add it as its own
explicit, audited, probably-approval-gated action rather than folding it
into `reactivateCustomer`.

**`loans.status` lifecycle** — each arrow is a distinct permissioned
service call, never an implicit side effect:

```
applied ──appraise(recommend)──> appraised ──requestLoanApproval──> pending_approval
   │                                                                      │
   └──appraise(decline)──> rejected <────────approvalWorkflow reject───────┤
                                                                          │
                                          approvalWorkflow approve ───> approved
                                                                          │
                                                       disburseLoan ──> disbursed
                                                                        │      │
                                     final repayment ──> closed  <──────┘      │
                                                       writeOffLoan ──> written_off
```

Disbursement is deliberately a **separate** action from approval (not
something the approval handler does): maker-checker is already satisfied
at the approval step, and disbursement is when cash actually moves, so it
carries its own `loan.disburse` permission and its own audit entry.

Follow this pattern for every future status column: app-layer values
documented here **and** a DB `CHECK` constraint enumerating the same
values (see migrations for examples) — never app-layer-only validation on
a status field.

---

## Shared Services (Module 11 / Module 7 interfaces)

_Exact function/endpoint signatures for the audit-log service, the
approval-workflow service, and the GL posting interface, once built —
every other module should call these, not reimplement them._

The three genuinely shared services live under `backend/src/shared/` and
take a `db` (a pg Client/PoolClient/Pool) as their first argument — pass
the **same client your caller's transaction is running on** wherever you
need the audit entry (or approval decision) to commit/rollback atomically
with the write it's about. Every module MUST call these instead of writing
to `audit_log`, `approval_requests`, or
`gl_journal_lines`/`gl_journal_entries` directly — those tables also refuse
direct-write shortcuts at the DB layer (see "Deviations" below for what's
DB-enforced vs. convention-only).

The per-module service sections that follow (branch, customer, loan math,
loan) are **not** shared services other modules call into — they're each
module's own business logic, documented here because later modules read
their tables and need the real shape and the decisions baked into them.

### Audit log — `backend/src/shared/auditLog.js`

```js
record(db, { userId, branchId, action, entityType, entityId, beforeState, afterState, ipAddress }) -> Promise<row>
query(db, { userId, branchId, entityType, entityId, from, to }, { limit, offset }) -> Promise<row[]>
```
- Required: `branchId`, `action`, `entityType`, `entityId`. `userId` may be
  `null` only for genuinely system-initiated actions (e.g. a scheduled
  job).
- `action` convention: `<domain>.<verb>` (e.g. `loan.disburse`,
  `gl.post_journal.<sourceModule>`, `rbac.user_created`).
- `audit_log` is append-only at the DB layer (BEFORE UPDATE/DELETE trigger
  raises an exception) — there is no update/delete function to call.

### Approval workflow — `backend/src/shared/approvalWorkflow.js`

```js
requestApproval(db, { actionType, entityType, entityId, branchId, requestedBy, amountPesewas, payload }) -> Promise<approval_request row>
decide(db, { approvalId, decidedBy, decision: 'approved'|'rejected', reason, execute }) -> Promise<approval_request row>
getApplicableThreshold(db, { actionType, branchId }) -> Promise<approval_thresholds row | null>
isApprovalRequired(threshold, amountPesewas) -> boolean   // pure, no db
registerExecutionHandler(actionType, handler(approvalRequest, db) -> Promise<void>) -> void   // added in Module 1, see below
```
- `requestApproval` always creates a row (status `pending`); it does NOT
  decide for you whether approval is needed for this specific call — check
  `isApprovalRequired(await getApplicableThreshold(...), amount)` first if
  your module wants to skip the workflow below a threshold.
- `decide`'s `execute` callback runs only on `decision === 'approved'` and
  receives `(approvalRequest, db)` — `db` is the SAME client `decide()` was
  called with, so the callback can run further queries in the same
  transaction without closing over anything from outside. Pass an explicit
  `execute` when calling `decide()` directly from code; **if you omit it**,
  `decide()` falls back to whatever handler was registered for this
  request's `action_type` via `registerExecutionHandler()` — this is what
  lets the ONE generic `POST /approvals/:id/decide` HTTP endpoint trigger a
  module-specific side effect (an HTTP handler can't accept a JS callback).
  **Added in Module 1** for branch closure
  (`branchService.registerBranchExecutionHandlers()`, called once at app
  startup in `app.js`) — any future module with an approval-gated action
  that needs to *do* something on approval should register a handler the
  same way rather than building its own decide endpoint. **Module 2 reused
  it as-is** for customer closure
  (`customerService.registerCustomerExecutionHandlers()`, also called at
  app startup) with zero further changes to `approvalWorkflow.js` needed —
  the pattern held up on its second real consumer.
- `backend/src/routes/approvals.js`'s `POST /:id/decide` now wraps `decide()`
  in its own transaction (`pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`) —
  this was a gap in the original Module 11 build (it passed the raw `pool`)
  that only mattered once an execute handler could run real side effects
  needing atomicity with the decision; fixed in Module 1 since branch
  closure needed it. If an execute handler throws (e.g. reconciliation
  fails again at decide-time), the whole transaction rolls back, so the
  approval request reverts to `pending` rather than getting stuck
  "approved but not applied."
- Maker-checker (`decidedBy !== requestedBy`) is enforced both here (throws
  `MakerCheckerViolationError`) and by a DB `CHECK` constraint on
  `approval_requests` as defense in depth — do not remove either.
- If `required_approver_role_id` is set on the request (from a matching
  `approval_thresholds` row), `decide` also verifies the deciding user
  actually holds that role.

### GL posting interface — `backend/src/shared/glPosting.js`

```js
postJournalEntry(pool, { branchId, reference, description, entryDate, sourceModule, createdBy, approvedBy, entryType, lines }) -> Promise<{ ...entry, lines }>
reverseJournalEntry(pool, { originalEntryId, reason, reversedBy, entryDate, entryType }) -> Promise<{ reversalEntry, originalEntry }>  // added in Module 6
requestPriorPeriodAdjustment(pool, { branchId, entryDate, description, lines, requestedBy }) -> Promise<{ adjustment, approvalRequest }>  // added in Module 6, ALWAYS maker-checker
postApprovedPriorPeriodAdjustment(pool, { adjustmentId, postedBy }) -> Promise<{ adjustment, journalEntry }>  // added in Module 6
registerGlExecutionHandlers()  // 'gl.prior_period_adjustment' — added in Module 6
getAccountBalance(db, { accountId, asOfDate, branchId }) -> Promise<number>  // signed pesewas, reconstructed from gl_journal_lines
validateBalancedLines(lines) -> void  // pure, throws UnbalancedEntryError; no db
```
- `lines`: `[{ accountId, debitPesewas?, creditPesewas?, branchId? }]` —
  exactly one of `debitPesewas`/`creditPesewas` per line, both must be
  non-negative integers, and the entry must balance overall. Rejected at
  the application layer first (`UnbalancedEntryError`), then again by a
  deferred DB constraint trigger at commit as defense in depth.
- `postJournalEntry` takes the **pool** (it owns its own
  BEGIN/COMMIT/ROLLBACK transaction, since it's the single funnel every
  module posts through) — don't pass an already-open client.
- `entryType: 'prior_period_adjustment'` is the only value allowed to post
  into a locked `gl_periods` row; anything else throws `PeriodLockedError`.
- `getAccountBalance` always reconstructs from `gl_journal_lines` (never a
  running-balance column) and returns the balance normalized to the
  account's natural side (asset/expense = debit-normal,
  liability/equity/income = credit-normal) — per the CLAUDE.md rule that
  historical reports must reconstruct from journal lines, not a mutable
  running balance.
- `gl_journal_lines` rows are immutable at the DB layer once inserted
  (BEFORE UPDATE/DELETE trigger) — corrections are always a new reversing
  entry, never an edit.
- **`reverseJournalEntry` (added in Module 6)** builds a NEW entry with
  every line's debit/credit swapped from the original (via
  `postJournalEntry`, so it gets the same balance/period-lock checks and
  audit trail), links it back with `reverses_entry_id`
  (`gl_journal_entries` migration 037, `UNIQUE` — at most one reversal per
  original entry ever), and flips the ORIGINAL entry's `status` to
  `'reversed'`. The original's *lines* are never touched — only its
  status column, which (unlike `gl_journal_lines`) was never immutable at
  the DB layer, just unused until now. This activates
  `gl_journal_entries.status = 'reversed'`, which has existed in the
  CHECK constraint since Module 7 with no producer until Module 6.
- **`requestPriorPeriodAdjustment` / `postApprovedPriorPeriodAdjustment`
  (added in Module 6)** are the module spec's "distinct back-dated
  adjustment workflow with extra approval" for correcting a LOCKED
  period. Deliberately placed here (shared, Module 7's domain) rather
  than inside `cashierService.js` — any module could need a back-dated
  correction, not just cashier operations. ALWAYS maker-checker, no
  threshold. Same two-phase shape as every other approval-gated GL
  posting in this codebase: the registered execution handler
  (`applyPriorPeriodAdjustmentApprovalDecision`) only flips the request
  to `approved` inside `decide()`'s transaction; the actual posting
  (`entryType: 'prior_period_adjustment'`, the only value
  `assertPeriodOpen()` lets through a locked period) happens afterward via
  `postApprovedPriorPeriodAdjustment`, since `postJournalEntry` owns its
  own transaction and can't run inside `decide()`'s. `lines` is
  snapshotted on the `gl_prior_period_adjustments` row at request time so
  what eventually posts can never silently drift from what a checker
  reviewed — same reasoning as `loan_restructures` snapshotting proposed
  new terms.
- **`gl_periods` had no producer until Module 6.** The table and
  `assertPeriodOpen()`'s lock check existed since Module 7, but nothing
  ever inserted a row — `cashierService.closeOutPeriod()`'s month/year
  level is the first code in this codebase to actually create (and lock)
  one, which is what makes the period-lock mechanism real for every
  module's postings, not just cashier's. See the Cashier service section.

### RBAC/auth building blocks used by all three

- `backend/src/middleware/auth.js` → `requireAuth(pool)`: loads
  `req.user = { id, homeBranchId, roleId, roleName, permissions: Set<string> }`
  from a bearer session token.
- `backend/src/middleware/requirePermission.js` → `requirePermission(code)`
  and `resolveBranchScope(req)` (see Branch Scoping Convention).
- Permission codes seeded so far: `audit.view`, `approval.request`,
  `approval.decide`, `rbac.manage_roles`, `rbac.manage_users`,
  `gl.manage_accounts`, `gl.post_journal`, `gl.view_reports`,
  `branch.create`, `branch.update`, `branch.change_status`,
  `branch.manage_staff`, `branch.manage_vault_config`, `branch.transfer`,
  `branch.view_performance`, `customer.create`, `customer.update`,
  `customer.close`, `customer.reactivate` (also gates deactivate),
  `customer.classify`, `customer.transfer_branch`,
  `customer.manage_documents`, `customer.manage_next_of_kin`,
  `customer.credit_bureau_lookup`, `customer.verify_kyc`,
  `group.manage_members`, `loan.manage_products`, `loan.apply`,
  `loan.appraise`, `loan.request_approval`, `loan.disburse`,
  `loan.post_repayment`, `loan.restructure`, `loan.write_off`,
  `loan.manage_collateral`, `loan.manage_guarantors`,
  `loan.view_reports`, `savings.manage_products`, `savings.open_account`,
  `savings.close_account`, `savings.deposit`, `savings.withdraw`,
  `savings.apply_charges`, `savings.view`, `susu.manage_accounts`,
  `susu.record_collection`, `susu.remit`, `susu.complete_cycle`,
  `susu.view`, `standing_order.manage`, `standing_order.execute`.
  Note the `field_agent` role gets `susu.record_collection` but NOT
  `savings.deposit`/`savings.withdraw` — agents never touch a till.
  Add new codes via
  `POST /rbac/roles/:roleId/permissions`, not a new migration, unless you
  also need to seed a default grant.

### Branch service — `backend/src/modules/branch/branchService.js` (Module 1)

Not a "shared service" other modules call into (unlike the three above) —
this is Module 1's own business logic, listed here because later modules
(2, 3, 4, 6, 9, 10) will read `branches`/`branch_gl_accounts`/
`branch_staff_assignments` and should know the real shape rather than
re-deriving it from the migrations.

```js
createBranch(pool, { code, name, regionId, clusterId, address, gpsLat, gpsLng, openingDate, operatingHours, licenceRef, openingFloatPesewas, dailyCashLimitPesewas, createdBy }) -> Promise<branch row + glAccounts>
updateBranch(pool, { branchId, updatedBy, fields }) -> Promise<branch row>
changeBranchStatus(pool, { branchId, toStatus, requestedBy, reason }) -> Promise<branch row | pending approval_request row>
assignStaff(pool, { branchId, userId, assignedBy }) -> Promise<{ assignment, user }>
grantCrossBranchAccess(pool, { userId, branchId, startDate, endDate, grantedBy }) -> Promise<grant row>
initiateTransfer / confirmTransfer / cancelTransfer(pool, {...}) -> Promise<branch_transfer row>
getBranchPerformance(pool, { branchId, asOfDate }) -> Promise<metrics>
```
- `changeBranchStatus` is the one function with a split return type: for
  `toStatus !== 'closed'` it applies immediately and returns the updated
  branch; for `toStatus === 'closed'` it runs the GL-reconciliation check
  (`assertZeroBalances` — cash-in-hand and vault must both be exactly 0)
  and, if that passes, calls `approvalWorkflow.requestApproval()` and
  returns the **pending approval request**, not an updated branch — the
  branch doesn't actually close until a different user approves it via
  `POST /approvals/:id/decide`, which dispatches to
  `closeBranchOnApproval()` (registered as the `'branch.close'` execution
  handler). If reconciliation fails, it throws
  `BranchReconciliationError` immediately — no approval request is ever
  created for a branch that can't reconcile, so there's nothing to clean
  up or "expire."
- `assignStaff` closes any existing open (`end_date IS NULL`)
  `branch_staff_assignments` row for the user, inserts a new open row, and
  updates `users.home_branch_id` to match — that column (Module 11) stays
  the live/current pointer everywhere else in the app; this table is
  purely the history of how it got there.
- Cross-branch access grants "expire automatically" per the Module 11
  prompt's requirement — checked lazily (`branchService.isGrantActive()`,
  and `requireAuth` middleware loading a user's currently-active grants
  onto `req.user.crossBranchAccessibleBranchIds` on every request) rather
  than by a background job, since Module 12 (scheduler) doesn't exist yet.
  See Open Questions.
- Cash-in-transit transfers (`initiateTransfer`/`confirmTransfer`/
  `cancelTransfer`) are NOT approval-gated through `approval_requests` —
  the source-initiates / destination-confirms two-step *is* the dual
  control (different branch, typically different staff). See Deviations
  for why this was a deliberate choice rather than an oversight.
- `getBranchPerformance` only returns metrics computable from what's
  built so far (cash position, income/expense/net from GL, headcount from
  staff assignments) — loan/deposit-derived metrics (portfolio size, PAR,
  total deposits) are listed under a `pendingMetrics` array rather than
  faked, since Modules 3/4/9 don't exist yet.
- Branch-scoped read endpoints (`GET /branches/:id/performance`,
  `GET /branches/performance/compare`) use
  `requirePermission.canAccessBranch(req, branchId)` — same access rule as
  `resolveBranchScope` (below) but checked against a path param instead of
  derived from `?branchId=`.

### Customer service — `backend/src/modules/customer/customerService.js` (Module 2)

Same status as the branch service above — Module 2's own business logic,
documented here for later modules (3, 4, 5, 9, 10) that will read
`customers`/`groups`/`group_members` rather than re-deriving the shape.

```js
createCustomer(pool, { customerType: 'individual'|'sme', branchId, fullName, ghanaCardNo?, businessRegistrationNo?, contactPersonName?, ..., createdBy }) -> Promise<customer row + priorClosedMatches[]>
createGroup(pool, { name, branchId, formationDate?, createdBy }) -> Promise<group row + customer>
addGroupMember / removeGroupMember / setGroupLeader(pool, { groupId, customerId, ...By }) -> Promise<row>
updateKycStatus(pool, { customerId, kycStatus, actorId, notes? }) -> Promise<customer row>
requestClosure(pool, { customerId, reasonCode, reasonNotes?, requestedBy }) -> Promise<account_closure row + approvalRequest>
transferCustomerBranch(pool, { customerId, toBranchId, transferredBy, reason? }) -> Promise<customer row>
lookupCreditBureau(pool, { customerId, requestedBy }) -> Promise<credit_bureau_lookups row>  // STUB, see below
getCustomer360(pool, { customerId }) -> Promise<{ customer, documents, nextOfKin, creditBureauLookups, groupInfo, pendingModules }>
```
- **`customers` is one polymorphic table** for all three types
  (`individual`/`group`/`sme`), not three separate tables — type-specific
  columns (`ghana_card_no`, `date_of_birth`, `gender` for individual;
  `business_registration_no`, `contact_person_name` for sme) are simply
  nullable, validated per-type by `customerService.validateCustomerFields()`
  (pure, exported, directly unit-tested). `createCustomer()` REJECTS
  `customer_type: 'group'` — a group's `customers` row is only ever created
  atomically alongside its `groups` row via `createGroup()`, so there's no
  path to a `customer_type: 'group'` row without the group structure that
  has to come with it.
- **Ghana Card format**: `GHA-XXXXXXXXX-X`
  (`customerService.validateGhanaCardNo()`, pure). Flagged in Open
  Questions for verification against the current official NIA spec.
- **Ghana Card uniqueness** is enforced by a partial unique index
  (`customers_ghana_card_active_uq`, migration 015) covering
  non-`closed` customers only — `createCustomer()` pre-checks for a clean
  409 (`CustomerConflictError`) and also catches the DB's `23505` as a
  race-condition backstop, both mapped to the same error. Matches on
  **closed** customers are returned as `priorClosedMatches` on the created
  customer (fraud review signal) rather than blocking creation — see the
  Module 2 business rule this implements.
- **`account_closures` does not duplicate `approval_requests`'s
  requested_by/decided_by/status** — it has a `UNIQUE` FK to the
  `approval_requests` row that IS the maker-checker record
  (`approval_request_id`), and `getAccountClosure()` joins to surface
  `approval_status`/`requested_by`/`decided_by` rather than risking two
  copies disagreeing. Same reasoning as why branch closure doesn't have
  its own status column either. The module spec's literal data model
  ("`account_closures` with reason_code, requested_by, approved_by,
  closure_date") is satisfied via the join, not by literal duplicate
  columns — see Deviations.
- **No timed cooling-off period is implemented** for closure beyond the
  maker-checker approval step itself — the spec never states a specific
  duration, and inventing one (e.g. "7 days") would be fabricating a
  business rule CLAUDE.md's spirit says not to guess. See Open Questions.
- **Group members must be individually KYC-verified** (`kyc_status =
  'verified'`) before `addGroupMember()` will add them — the literal
  enforcement of the Module 2 business rule "group members should be
  individually KYC'd even though they borrow under a group structure."
  Removing a member who is currently the group leader auto-clears
  `groups.group_leader_id` (no group is left with a leader who isn't a
  current member).
- **Customer branch transfers resolve Module 1's Open Question** on how
  "home branch" interacts with the branch-to-branch transfer workflow:
  `customer_branch_transfers` (migration 019) is a separate, independent
  table from Module 1's `branch_transfers` — the two never overlap
  (`branch_transfers` is cash-in-transit only; this is customer-record
  reassignment only, direct/audited, not maker-checker gated since it has
  no direct financial impact by itself).
- **Credit bureau lookup is a labeled STUB**
  (`backend/src/modules/customer/creditBureauClient.js`) — deterministic
  fake score derived from a hash of the customer's ID, `stub: true` always
  present in the response, no real bureau contract configured. Must be
  replaced before this goes near production; see Open Questions.
- `getCustomer360()` follows the same honesty pattern as Module 1's branch
  performance dashboard — loans/savings/susu/transaction history are
  listed under `pendingModules` rather than faked, since Modules 3/4/5
  don't exist yet. **Module 3 did NOT wire loans into this** — it stayed
  in `pendingModules`; whoever needs a loans section on the 360 view
  should add it deliberately (it's a `listLoans({ customerId })` call).

### Loan math — `backend/src/modules/loan/loanMath.js` (Module 3)

**Pure functions, no db, no side effects** — deliberately split out from
`loanService.js` so the interest/allocation logic (the part CLAUDE.md and
the module spec both single out for dedicated tests) is exhaustively
testable in isolation. 29 unit tests in `tests/unit/loanMath.test.js`.

```js
generateLoanSchedule({ principalPesewas, termMonths, annualInterestRateBps, interestMethod, startDate }) -> [{ installmentNumber, dueDate, principalDuePesewas, interestDuePesewas }]
allocateRepayment(scheduleRows, amountPesewas) -> { allocations, unallocatedPesewas }
computeFeesPesewas(feeSchedule, principalPesewas) -> number
computeOutstandingPrincipalPesewas(scheduleRows) -> number
bucketArrearsDays(daysOverdue, bucketBoundaryDays) -> string | null
addMonthsToDateString(dateStr, months) -> string
```
- **Interest rates are integer basis points of the ANNUAL nominal rate**
  (`annual_interest_rate_bps`; 2400 = 24% p.a.) — never a float, same
  reasoning as money. Amortization is always **monthly** (annual/12).
- **The anti-drift guarantee** the spec demands ("reducing-balance
  recalculation must handle early/partial/late payments without drifting
  from the original schedule's total interest assumptions") is achieved
  structurally, not by re-deriving anything: (a) the schedule's LAST
  installment always absorbs the rounding remainder, so
  `sum(principalDue) === principal` exactly, by construction, for every
  method/term/rate; and (b) repayments never recalculate the schedule —
  `allocateRepayment()` only decides how a payment *covers* fixed
  installment amounts. Early/partial/late payment therefore cannot move
  the totals at all.
- **Repayment waterfall**: oldest installment first, and within an
  installment **fees -> interest -> principal**, spilling into the next
  installment once one is fully covered.
- `bucketArrearsDays` produces portfolio-management PAR buckets
  (`1-30`/`31-60`/`61-90`/`90+` by default, configurable per product).
  These are **not** BOG's prudential loan classification categories
  (current/OLEM/substandard/doubtful/loss) — that's Module 8's job, and it
  must not reuse these buckets as if they were the same thing.

### Loan service — `backend/src/modules/loan/loanService.js` (Module 3)

```js
createLoanProduct / listLoanProducts / getLoanProduct(pool, ...)
calculateLoan(pool, { productId, principalPesewas, termMonths, startDate }) -> preview, creates nothing
applyForLoan(pool, { customerId, productId, principalPesewas, termMonths, reasonCode, overdraftSavingsAccountId?, appliedBy }) -> loan
submitAppraisal(pool, { loanId, checklist, recommendation, appraiserId }) -> { appraisal, loan }
requestLoanApproval(pool, { loanId, requestedBy }) -> approval_request
disburseLoan(pool, { loanId, disbursedBy, disbursementDate }) -> loan + { feesPesewas, netCashPesewas, journalEntry }
  // dispatches to activateOverdraft() for loan_type = 'overdraft' — see below
postRepayment(pool, { loanId, amountPesewas, paymentDate, receivedBy }) -> { components, loanClosed, journalEntry }
requestRestructure(pool, { loanId, newTermMonths, newAnnualInterestRateBps, reason, requestedBy }) -> restructure + approvalRequest
writeOffLoan(pool, { loanId, reason, writtenOffBy }) -> loan + journalEntry
  // dispatches to writeOffOverdraft() for loan_type = 'overdraft' — see below
getArrearsReport(pool, { branchId, asOfDate }) -> { loans, totals: { buckets, parRatio } }
findGroupCreditBlockers(db, groupCustomerId) -> blocking members
registerLoanExecutionHandlers()  // 'loan.approve' + 'loan.restructure'

// Overdraft servicing (Module 3, closing the Open Question below)
activateOverdraft(pool, { loanId, disbursedBy, disbursementDate })  // called BY disburseLoan, not directly
getOverdraftStatus(pool, { loanId }) -> { limitPesewas, balancePesewas, drawnPesewas, availablePesewas }
accrueOverdraftInterest(pool, { loanId, accrualDate?, days?, accruedBy }) -> { accrued, interestPesewas, journalEntry }
closeOverdraft(pool, { loanId, closedBy }) -> loan
```

**GL mapping — the contract every other module should read before posting
anything loan-related** (all via `glPosting.postJournalEntry`, never
direct writes):

| Event | Debit | Credit |
|---|---|---|
| Disbursement | Loans Receivable `principal` | Cash in Hand `principal - fees`; Loan Fee Income `fees` |
| Repayment | Cash in Hand `amount` | Loans Receivable `principal component`; Loan Interest Income `interest component`; Loan Fee Income `fee component` |
| Write-off | Loan Loss Expense `outstanding principal` | Loans Receivable `outstanding principal` |
| **Overdraft activation** | *(nothing posts — see Overdraft loans below)* | |
| **Overdraft interest accrual** | Customer Deposits `interest` | Loan Interest Income `interest` |
| **Overdraft write-off** | Loan Loss Expense `drawn balance` | Customer Deposits `drawn balance` |

- **Fees are charged once, at disbursement, netted from the cash handed
  over** — the borrower owes the full principal, receives
  `principal - fees`, and fee income is recognized immediately. The
  alternative (billing fees across installments via
  `loan_schedules.fees_due_pesewas`) is *supported by the schema and the
  repayment waterfall* but nothing populates it yet; a future product type
  that needs periodic fees can use it without a migration.
- **Interest is recognized on RECEIPT, not on accrual.** Interest income
  hits the GL only as repayments come in. This is why write-off only
  reverses outstanding *principal* — unpaid interest was never booked as
  income, so there is nothing to reverse. If Module 8 (BOG provisioning)
  or Module 9 needs accrual-basis interest income, that is a real change
  to this posting model, not a tweak — see Open Questions.
- **`loans` snapshots `interest_method` and `annual_interest_rate_bps`
  from the product at application time** rather than reading the product
  live, so editing a product later never retroactively alters existing
  loans' terms.
- **Restructuring versions the schedule** (`loan_schedules.schedule_version`,
  `loans.current_schedule_version`): approval inserts a brand-new set of
  rows at version N+1 re-amortizing the *currently outstanding* principal;
  version N's rows and every repayment posted against them are never
  touched. That is how "preserving the original schedule and all prior
  repayment history for audit" is satisfied. Read schedules via
  `getLoanSchedule({ loanId })` (current version) or pass an explicit
  `scheduleVersion` for history.
- **Group loans**: `loans.customer_id` points at the *group's own*
  `customers` row (`customer_type = 'group'`, Module 2's design), and
  `loan_group_liabilities` snapshots which individual members were jointly
  liable **at disbursement** — group membership can change afterward
  without silently shifting liability on an existing loan.
- **Group default rule** (the spec asks for one but doesn't specify it —
  this is the decided rule): if any *current* member of a group has a
  `written_off` loan of their own, or is jointly liable on a written-off
  group loan, the group cannot take new group credit.
  `findGroupCreditBlockers()` returns the offending members (so the error
  names them) and `applyForLoan()` enforces it. See Deviations.
- **No `loan_approvals` table** — the shared `approval_requests` row IS
  the maker-checker trail, exactly as Modules 1 and 2 decided for branch
  and customer closure. See Deviations.
- `loan_repayments` is append-only at the DB layer, with **one narrow
  exception**: stamping `journal_entry_id` once, NULL -> value. Necessary
  because `postJournalEntry()` owns its own transaction, so the entry id
  doesn't exist yet when the repayment row is inserted. Every financial
  field stays immutable, and the trigger verifies nothing else changed.

**Overdraft loans — finished, migration `032_overdraft.sql` /
`033_overdraft_permissions_seed.sql`.** Closes the Open Question that used
to sit at the bottom of this file: an overdraft is now a real revolving
facility against a specific EXISTING savings account, not an amortizing
term loan and not (the actual bug) an unconditional bypass of the balance
check for any `allows_overdraft` account.

- **`loans.principal_pesewas` is repurposed to mean the approved LIMIT**
  for `loan_type = 'overdraft'` — no new "limit" column on `loans`. The
  real, numeric ceiling actually enforced lives on the savings side:
  `savings_accounts.overdraft_limit_pesewas` (0 unless an overdraft is
  currently active against that account).
- **`loans.overdraft_savings_account_id`** links the loan to the specific
  account (`applyForLoan` validates: same customer, account `active`, and
  the account's product has `allows_overdraft = true`; at most one
  non-terminal overdraft loan per account at a time).
- **Activation (`activateOverdraft`, dispatched from `disburseLoan` when
  `loan_type = 'overdraft'`) generates NO schedule and posts NOTHING to
  GL.** It only sets `savings_accounts.overdraft_limit_pesewas` to the
  loan's principal. Nothing is owed until the customer actually draws —
  and drawing happens through the **existing savings withdrawal path**
  (`savingsService.requestWithdrawal`/`payOutWithdrawal`), not a new
  disbursement-style money movement.
- **Interest is accrued, not recognized on receipt** — a deliberate
  exception to the "interest is recognized on receipt" rule term loans
  follow (see above), because an overdraft has no schedule to recognize
  interest against on receipt. `accrueOverdraftInterest` computes simple
  interest on the currently drawn balance for a caller-supplied period
  (`loanMath.computeOverdraftInterestPesewas`), posts it through
  `savingsService.applyMovement` (txn_type `overdraft_interest`: Dr
  Customer Deposits / Cr Loan Interest Income — same direction as an
  ordinary withdrawal, since Customer Deposits is a liability and interest
  owed further reduces what's owed back to the customer), and records an
  `overdraft_interest_accruals` row. `UNIQUE(loan_id, accrual_date)` blocks
  double-accruing the same day. A no-op (not an error) when nothing is
  currently drawn.
- **Write-off** (`writeOffOverdraft`, dispatched from `writeOffLoan`) is
  DIFFERENT from a term loan's write-off: the debt lives on the linked
  savings account's negative balance, not on Loans Receivable (nothing was
  ever posted there for an overdraft). Writing it off brings that balance
  back to zero through `applyMovement` (txn_type `overdraft_writeoff`: Dr
  Loan Loss Expense / Cr Customer Deposits) and resets
  `overdraft_limit_pesewas` to 0.
- **Closing** (`closeOverdraft`) requires the drawn balance already repaid
  to zero (same precondition as closing an ordinary savings account),
  resets `overdraft_limit_pesewas` to 0, and marks the loan `closed`.
- **Three edge cases found and fixed during a post-build review** (before
  anything shipped, so no migration needed):
  1. `savingsService.closeAccount` now also rejects closing an account
     with `overdraft_limit_pesewas > 0` — otherwise a customer could close
     an account with a zero *balance* while a facility limit was still
     attached to it, orphaning an active loan from its account.
  2. `activateOverdraft` re-locks and re-checks the linked account is
     still `active` at disbursement time, not just at application time — a
     savings account can be closed in the (potentially long) gap between
     applying for an overdraft and it being appraised/approved/disbursed.
  3. `accrueOverdraftInterest` treats a computed `interestPesewas` of 0
     (e.g. a 0%-rate product, or a very short period) as a no-op rather
     than attempting the insert, which would otherwise hit
     `overdraft_interest_accruals`' `interest_pesewas > 0` CHECK
     constraint as a raw, unhelpful 500.
- **The real bug this replaced**: `savingsMath.assessWithdrawal` took an
  `allowsOverdraft` boolean that, when true, skipped the balance/minimum-
  balance check ENTIRELY — any account on an `allows_overdraft` product had
  an *unlimited*, unattached overdraft. Likewise
  `savingsService.applyMovement`'s `skipBalanceCheck` boolean fully
  bypassed the `balanceAfter < 0` check. Both are now real numeric floors:
  `assessWithdrawal({ ..., overdraftLimitPesewas })` checks
  `balanceAfter >= minBalance - overdraftLimitPesewas`, and
  `applyMovement({ ..., minAllowedBalancePesewas })` checks
  `balanceAfter >= minAllowedBalancePesewas` (default 0). Callers derive
  both from the account's actual `overdraft_limit_pesewas` — 0 for every
  account without an active facility, so ordinary savings behavior is
  unchanged.

### Savings / susu / standing orders — `backend/src/modules/savings/` (Module 4)

`savingsMath.js` is pure (no db) and separately unit-tested, same split as
Module 3's `loanMath.js`: charge resolution, withdrawal assessment,
commission, cycle outcome, and next-run-date scheduling.

```js
// savingsService.js
openAccount / closeAccount(pool, ...)
deposit(pool, { accountId, amountPesewas, depositedBy, idempotencyKey? })
requestWithdrawal(pool, { accountId, amountPesewas, requestedBy })   // pays out OR queues for approval
settleApprovedWithdrawal(pool, { withdrawalRequestId, paidBy })
applyCharges(pool, { accountId, appliedBy, chargeTypes? })
applyMovement(pool, { accountId, txnType, deltaPesewas, buildGlLines, ... })  // the single balance-movement funnel
reconcileAccount / reconcileBranchDeposits(pool, ...)

// susuService.js
createSusuAccount / recordCollection / recordRemittance / completeCycle / payOutCycle(pool, ...)

// standingOrderService.js
createStandingOrder / executeOrder / executeDueOrders / listUnnotifiedFailures(pool, ...)
```

**GL mapping — deposits are a LIABILITY** (money owed back to the
customer), which is why a deposit *credits* the control account:

| Event | Debit | Credit |
|---|---|---|
| Deposit | Cash in Hand | Customer Deposits |
| Withdrawal | Customer Deposits | Cash in Hand |
| Fee / charge | Customer Deposits | Savings Fee Income |
| **Susu field collection** | **Cash with Agents (1030)** | Susu Deposits |
| **Agent remittance (banking it)** | Cash in Hand | **Cash with Agents (1030)** |
| Agent commission accrual | Agent Commission Expense | Agent Commission Payable |
| Susu cycle payout | Susu Deposits | Customer Deposits |
| **Overdraft interest accrual (Module 3)** | Customer Deposits | Loan Interest Income |
| **Overdraft write-off (Module 3)** | Loan Loss Expense | Customer Deposits |

- **`1030` Cash with Agents answers Module 4's "BEFORE YOU WRITE CODE"
  question.** Cash an agent collects in the field is NOT branch cash until
  they bank it, so a collection debits 1030 rather than 1000. **1030's
  balance is therefore exactly "what agents are currently holding"** —
  the figure Module 10's end-of-day reconciliation compares against what
  the cashier actually received. `susu_collections.remittance_id` is NULL
  until banked and can only ever be set once (enforced by the immutability
  trigger), so **the same collection can never be reconciled twice** under
  two different processes — the specific risk that question raised.
- **The join key into Module 10 is `users(id)`.** `susu_collections.agent_id`
  references the agent's staff/user record directly, NOT a Module-10
  `field_agents` row (which doesn't exist yet). Module 10's `field_agents`
  is specced as "linked to a staff/user record", so it will hang off the
  same `users(id)`; joining `susu_collections -> users <- field_agents`
  gives Module 10 its input without Module 4 depending on unbuilt tables.
  **Module 10 must not introduce a second agent identifier** — extend
  `field_agents.user_id` instead.
- **`savings_accounts.balance_pesewas` is a stored subledger balance**,
  which is NOT a violation of CLAUDE.md's "reconstruct from journal lines"
  rule — that rule governs *GL* reporting, which still reconstructs from
  `gl_journal_lines` untouched. This is a customer subledger, the spec
  explicitly asks for it, and a teller needs a balance without summing all
  history. It stays trustworthy because every movement also writes an
  immutable `savings_transactions` row carrying `balance_after_pesewas`,
  so `reconcileAccount()` proves stored balance == ledger sum, and
  `reconcileBranchDeposits()` proves subledger total == GL control
  balance. Those two are the per-account and per-branch halves of Module
  7's required "GL-to-customer-account reconciliation report".
- **Withdrawal approval threshold resolution order** (business rule:
  "configurable per branch or per product"): a Module 11
  `approval_thresholds` row for `action_type = 'savings.withdraw'` wins
  (and that table already prefers a branch-specific row over the org-wide
  one); otherwise the account's `charges_config` override; otherwise the
  product's `withdrawal_approval_threshold_pesewas`. An amount **>=** the
  threshold needs approval. A threshold of 0 means *everything* needs
  approval and is honoured as such, not treated as "unset".
- **Idempotency is a DB guarantee, not a convention.**
  `savings_transactions.idempotency_key` and
  `susu_collections.idempotency_key` are UNIQUE; the services check first
  and return the existing row with `idempotentReplay: true` (HTTP 200
  rather than 201) instead of erroring. That is what makes the agent
  collection endpoint safe for low-connectivity retries.
- **`applyMovement()` is the single funnel** for every savings balance
  change — it locks the account, writes the immutable ledger row, updates
  the balance, then posts the GL entry via `glPosting`. Callers supply a
  `buildGlLines` callback so the funnel doesn't need to know every
  transaction type. Any future module touching savings balances should go
  through it rather than updating `balance_pesewas` directly.
- **Overdraft is a real numeric floor, not a bypass** — fixed alongside
  Module 3's overdraft loan work (see the Loan service section above for
  the full design). `assessWithdrawal`'s `allowsOverdraft` boolean and
  `applyMovement`'s `skipBalanceCheck` boolean previously disabled the
  balance check ENTIRELY for any `allows_overdraft` account, i.e. an
  unlimited, unattached overdraft. They are now `overdraftLimitPesewas`
  and `minAllowedBalancePesewas` — real numbers callers derive from
  `savings_accounts.overdraft_limit_pesewas` (0 unless an overdraft loan is
  actually disbursed against the account), so the floor is always
  `minBalance - actualApprovedLimit`, never "no floor at all".
- **Standing orders never fail silently**: every run writes a
  `standing_order_runs` row; a failure records the reason, reschedules by
  the order's own `retry_after_days`, and suspends the order once
  `max_consecutive_failures` is reached (rather than retrying forever).
  `listUnnotifiedFailures()` exposes the queue of failures nobody has told
  the customer about — see Open Questions, there is no notification
  service yet.
- **Savings accounts accrue no interest.** The Module 4 spec covers
  charges, not credit interest; interest-bearing products are Module 5
  (Investments). If a savings product ever needs to pay interest, that is
  a new accrual posting model, not a config tweak.

### Investment service — `backend/src/modules/investment/` (Module 5)

Built ahead of Module 6 (Cashier/Till/Vault) in CLAUDE.md's suggested
build order, on explicit instruction — see Deviations.

`investmentMath.js` is pure (no db) and separately unit-tested, same split
as every other module's math file: maturity-date calculation, simple
(non-compounding) interest accrual, and the early-withdrawal penalty/
redemption payout calculation. **Deliberately does not import
loanMath.js/savingsMath.js** even though the month-clamp and
simple-interest formulas are identical — each module's math file stays
self-contained, the same choice Module 4 made for its own date helpers.

```js
// investmentService.js
createInvestmentProduct / listInvestmentProducts / getInvestmentProduct(pool, ...)
bookInvestment(pool, { customerId, productId, principalPesewas, appliedBy }) -> { investment, approvalRequest }
activateInvestment(pool, { investmentId, activatedBy, startDate }) -> investment + journalEntry
accrueInterest(pool, { investmentId, accrualDate, days, accruedBy }) -> { accrued, interestPesewas, journalEntry? }
requestInvestmentPayout(pool, { investmentId, amountPesewas?, requestedBy }) -> pays out OR queues for approval
settleApprovedInvestmentPayout(pool, { payoutId, paidBy, paymentReference })
requestRedemption(pool, { investmentId, redemptionDate, requestedBy }) -> { redemption, approvalRequest }  // ALWAYS maker-checker
confirmRedemptionPayout(pool, { redemptionId, paymentReference, confirmedBy }) -> { redemption, investment, journalEntry }
getInvestorStatement(pool, { investmentId }) -> { accruals, payouts, redemption, totals }
registerInvestmentExecutionHandlers()  // 'investment.book' + 'investment.payout' + 'investment.redeem'
```

**Investments are booked as a LIABILITY** (Investment Deposits Payable),
not equity — see the Chart of Accounts section above for why.

**GL mapping:**

| Event | Debit | Credit |
|---|---|---|
| Activation (funds received) | Cash in Hand `principal` | Investment Deposits Payable `principal` |
| Interest accrual | Investment Interest Expense `interest` | Investment Deposits Payable `interest` |
| Periodic interest payout | Investment Deposits Payable `amount` | Cash in Hand `amount` |
| Redemption | Investment Deposits Payable `principal + accrued interest` | Cash in Hand `total payout`; Early Withdrawal Penalty Income `penalty` (if any) |

- **Booking and redemption ALWAYS require maker-checker approval** — no
  threshold escape hatch, per the module spec's own "pending-approval
  queue for new investments and disinvestments" (same treatment as
  `loan.approve`). **Periodic interest payouts are threshold-gated**,
  same convention as Module 4's `savings.withdraw`: a branch-specific
  `approval_thresholds` row for `'investment.payout'` wins if present,
  else `investment_products.payout_approval_threshold_pesewas` (default 0
  — everything needs approval until a real threshold is configured, the
  same safe default Module 4 established).
- **No schedule is generated and nothing posts to GL at booking** — only
  at activation (a separate, explicitly-permissioned step after approval,
  same `approve` vs. `disburse` split as loans). `principal_pesewas` is
  the actual amount received (unlike an overdraft, where it means a
  limit) — the whole principal is funded up front, same as a term loan.
- **Interest does NOT compound.** Each `accrueInterest` call computes
  simple interest on the ORIGINAL principal for the given period, never on
  a running balance that includes prior accruals — a fixed-term deposit,
  not a compounding one. `UNIQUE(investment_id, accrual_date)` blocks
  double-accruing the same day, and a computed interest of exactly 0
  (a 0%-rate product) is a no-op rather than an error — same lesson
  learned fixing Module 3's overdraft interest accrual.
- **`investment_accruals` needs no two-phase `journal_entry_id` stamp**,
  unlike `loan_repayments`/`savings_transactions`: the GL entry is posted
  FIRST (nothing else needs this row to exist first), then the row is
  inserted with `journal_entry_id` already known. Fully immutable at the
  DB layer (plain BEFORE UPDATE/DELETE block, no stamp exception needed).
- **Principal is never penalized on early redemption — only accrued
  interest is**, up to `investment_products.early_withdrawal_penalty_bps`
  (a fraction of accrued interest, 0-10000 bps). A redemption at or after
  maturity applies no penalty regardless of the product's configured
  rate, even if requested against an early-withdrawal-eligible investment
  — `investmentMath.isEarlyRedemption()` decides this from the actual
  redemption date vs. `maturity_date`, not from a flag the caller sets.
- **Redemption extinguishes the FULL liability in one entry**: `Dr
  Investment Deposits Payable` for `principal + accrued_interest` (the
  entire balance built up by activation + every accrual), split on the
  credit side between what's actually paid out (`Cr Cash in Hand`) and
  what's forfeited as a penalty (`Cr Early Withdrawal Penalty Income`).
  This is why `investment_redemptions` has DB `CHECK` constraints tying
  `interest_payable_pesewas = accrued_interest_pesewas - penalty_pesewas`
  and `total_payout_pesewas = principal_pesewas + interest_payable_pesewas`
  — the arithmetic invariant is enforced at the DB layer, not just
  trusted from the application.
- **`investment_payouts`/`investment_redemptions` never mark `paid`
  optimistically** — same reasoning as the module spec's own "use a
  pending -> confirmed status, not an optimistic update." Both follow the
  same two-phase shape Module 4 established for threshold-gated
  withdrawals: the maker-checker execution handler
  (`payOutInvestmentPayoutOnApproval` / `applyRedemptionApprovalDecision`)
  only records the approval outcome inside `decide()`'s transaction
  (glPosting can't run there — it owns its own transaction); the actual
  payout/GL posting happens afterward via a separate explicit call
  (`settleApprovedInvestmentPayout` / `confirmRedemptionPayout`), which is
  also where `payment_reference` (a manually-entered MoMo/bank reference
  or cashier voucher number) gets recorded — see Open Questions for why
  this is manual rather than a live payments-integration callback.
- **A DATE column read back from Postgres is a JS `Date` object, not a
  `'YYYY-MM-DD'` string** — `node-postgres`'s default behavior. Feeding one
  straight into `investmentMath`'s string-based date functions (which do
  `` `${d}T00:00:00Z` ``) silently produces an `Invalid Date`, and every
  comparison against an `Invalid Date` is `false` — this specific bug
  made `requestRedemption` classify EVERY redemption as "not early"
  regardless of the actual date, caught in smoke-testing before it
  shipped. Fixed with `investmentService.toDateString()`, applied
  wherever a DB-read date feeds back into date arithmetic. Watch for the
  same trap in any future module that round-trips a DATE column through
  loanMath/savingsMath's equivalent string-based helpers — none of the
  existing call sites happen to do this today, but nothing stops a future
  one from introducing it.

### Cashier service — `backend/src/modules/cashier/` (Module 6)

No dedicated pure-math file — the only arithmetic (expected-closing-
balance, variance) is simple subtraction, not worth its own unit-tested
module the way loan/savings/investment interest math is.

```js
// cashierService.js
openTill(pool, { branchId, cashierId, openingBalancePesewas, businessDate, openedBy }) -> till + journalEntry
closeTill(pool, { tillId, closingBalancePesewas, closedBy }) -> till + journalEntry  // records variance, never blocks on it
requestCashBack(pool, { tillId, amountPesewas, requestedBy }) -> pays out OR queues for approval
settleApprovedCashBack(pool, { cashBackRequestId, paidBy })
requestReversal(pool, { originalJournalEntryId, reasonCode, notes, requestedBy }) -> { reversal, approvalRequest }  // ALWAYS maker-checker
executeApprovedReversal(pool, { reversalId, executedBy }) -> { reversal, reversalEntry }
closeOutPeriod(pool, { branchId, periodType, periodStart, periodEnd, closedBy }) -> day_close_snapshots row  // day/month/year
getBranchCashPosition(pool, branchId) / getConsolidatedCashPosition(pool)
registerCashierExecutionHandlers()  // 'cashback.request' + 'gl.reversal'
```

**GL mapping — no new control accounts** (see Chart of Accounts above):

| Event | Debit | Credit |
|---|---|---|
| Till open (float issuance) | Cash in Hand | Vault |
| Cash-back | Cash in Hand | Vault |
| Till close (banking the count back) | Vault | Cash in Hand |
| Reversal | `glPosting.reverseJournalEntry` — swaps the original entry's own lines | |

- **No `vault_balances` table, despite the spec listing one.** "The vault
  balance" for a branch already IS `branch_gl_accounts.vault_account_id`'s
  reconstructed GL balance (`glPosting.getAccountBalance`) — a parallel
  stored-balance table would just be a second, driftable copy of the same
  number, the exact thing CLAUDE.md's "reconstruct from journal lines"
  rule exists to prevent. Module 1's cash-in-transit transfers actually
  move `Cash in Hand` (not `Vault`) between branches, so — in THIS
  codebase specifically — only till-open/cash-back/till-close ever touch
  a branch's vault balance.
- **No `deleted_transactions_log` table either.** Nothing in this
  codebase ever hard-deletes a financial record (every table is either
  append-only with an immutability trigger, or uses a status/soft-delete
  column), and every write already goes through the shared `audit_log`
  service. A parallel deletion-log table would violate CLAUDE.md's "route
  all audit writes through the shared audit-log service — do not write ad
  hoc audit logic per module." Reversals (`transaction_reversals`) ARE
  the "soft-delete" mechanism for GL transactions here.
- **Cash-back is threshold-gated** (same convention as Module 4's
  `savings.withdraw` / Module 5's `investment.payout`): a branch-specific
  `approval_thresholds` row for `'cashback.request'` wins if present,
  else 0 — every cash-back needs approval until someone configures a real
  threshold, the same safe default established elsewhere. **Reversals
  ALWAYS require maker-checker**, no threshold — matches the spec's own
  "with a reason code and approver" framing, same treatment as
  `loan.approve`/`investment.book`/`investment.redeem`.
- **Till variance is real but approximate, not a true per-transaction
  reconciliation.** `expected_closing_balance_pesewas` = opening float +
  every `'paid'` cash-back for that till — it does NOT net out ordinary
  teller transactions (deposits, withdrawals, loan disbursements/
  repayments), because none of those carry a `till_id` anywhere in this
  schema; they all post directly to the branch's POOLED Cash in Hand
  account. Attributing every cash-moving transaction across Modules 3–5
  to a specific till would be a real, much larger schema change (adding
  `till_id` to `savings_transactions`, `loan_repayments`, etc.) — out of
  scope here and flagged in Open Questions, not silently assumed away. A
  variance is recorded, never blocks closing (a real-world shortage/
  surplus must surface, not be hidden), same "report don't block"
  philosophy as `savingsService.reconcileAccount()`.
- **All GL postings tied to a specific till use that till's own
  `business_date`, not "today."** A real bug caught in smoke-testing:
  `closeTill`/cash-back originally used `todayIso()` for the entry date,
  which misdates a till's activity to whenever the action happens to be
  recorded rather than the shift it belongs to, and can even spuriously
  collide with a period lock that covers today but not the till's actual
  business date (closing a till dated last month, today, after this
  month has already been locked). Fixed with the same
  `toDateString()`-normalization pattern Module 5 already established for
  DATE columns read back from Postgres.
- **Close-out (`closeOutPeriod`) shares ONE precondition across all three
  levels** — no till in the branch may still be open — per the spec's own
  "close-out endpoints (each validating all tills for the branch are
  closed first)". `'month'`/`'year'` additionally create+lock a
  `gl_periods` row (see the GL posting interface section above);
  `'day'` has no `gl_periods` equivalent, so its lock is enforced by
  `assertDayNotLocked()` inside `cashierService` itself, checked before
  every `openTill()`.

### GL, accounting & financial reporting service — `backend/src/modules/gl/glService.js` (Module 7)

`glPosting.js` (shared, above) is the cross-module POSTING primitive every
module calls into; `glService.js` is Module 7's OWN business logic layered
on top — chart-of-accounts admin, the financial statements, the manual-JV
maker-checker workflow, and bank reconciliation. Same split as every other
module (`approvalWorkflow.js`/`glPosting.js` shared vs. `loanService.js`
Module 3's own logic).

```js
// glService.js
listGlAccounts(pool, { branchId, accountType, status }) -> gl_accounts[]
createGlAccount(pool, { code, name, accountType, branchId, parentAccountId, createdBy, actorBranchId }) -> gl_account
updateGlAccount(pool, { accountId, updatedBy, actorBranchId, fields }) -> gl_account  // name/status always editable; code/accountType only pre-activity; branchId/parentAccountId never editable
getTrialBalance(pool, { asOfDate, branchId }) / getBalanceSheet(pool, { asOfDate, branchId }) / getIncomeStatement(pool, { fromDate, toDate, branchId }) / getDailyBalanceSummary(pool, { date, branchId }) / getAnnualTransactionReport(pool, { year, branchId })
requestManualJournalEntry(pool, { branchId, entryDate, description, lines, requestedBy }) -> { entry, approvalRequest }  // ALWAYS maker-checker
postApprovedManualJournalEntry(pool, { entryId, postedBy }) -> { entry, journalEntry }
createBankAccount(pool, { glAccountId, branchId, bankName, accountNumber, createdBy, actorBranchId }) -> bank_account  // glAccountId must already exist and be account_type='asset'
importStatementLines(pool, { bankAccountId, lines, uploadedBy, actorBranchId }) -> bank_statement_lines[]
matchStatementLine(pool, { statementLineId, journalLineId, matchedBy, actorBranchId }) -> bank_statement_line
getBankReconciliation(pool, { bankAccountId, asOfDate }) -> { glBalancePesewas, statementBalancePesewas, outstandingOnStatementNotInGl, outstandingInGlNotOnStatement, adjustedGlBalancePesewas, adjustedStatementBalancePesewas, reconciled }
registerGlModuleExecutionHandlers()  // 'gl.manual_jv'
```

- **Financial statements are all built on one shared rollup query,
  `getAccountRollup`** — reconstructed from `gl_journal_lines` directly
  (never a running balance), for either a point in time (`asOfDate`) or a
  period (`fromDate`..`toDate`). Every account maps to
  `COALESCE(parent_account_id, id)`: a branch's own sub-account (e.g.
  `1000.NRA-01`) rolls up into its org-wide control row (`1000`). Passing
  `branchId` restricts to that branch's own accounts (a branch-level
  statement); omitting it aggregates every branch under each control row
  (a consolidated statement). Zero-activity accounts still appear (LEFT
  JOIN), matching standard trial-balance convention.
- **Balance sheet's "Net Income (current period)" is a plug, not a real
  equity account** — income minus expense (same as-of date/scope) shown as
  its own equity line, since nothing in this codebase formally closes
  income/expense into retained earnings at period-end. This is what makes
  `Assets = Liabilities + Equity` hold by construction (the fundamental
  accounting identity, guaranteed as long as every posted entry balanced,
  which `glPosting.js` already enforces) rather than an approximation.
- **Manual JV (`gl_manual_entries`, migration 041) is ALWAYS maker-checker,
  no threshold** — same reasoning as `loan.approve`/`investment.book`/
  `investment.redeem`/`gl.reversal`/`gl.prior_period_adjustment`: a
  hand-entered manual JV has no natural "product" to hang a configurable
  default threshold off, and it's arguably the single most arbitrary,
  error-prone entry point in the system (no business-rule validation
  beyond "it balances," unlike every module's own postings which are
  already gated by that module's own upstream approval step). Deliberately
  a SEPARATE table from `gl_prior_period_adjustments` (migration 038)
  despite the nearly identical shape: that one is specifically for
  corrections into a LOCKED period (`entryType: 'prior_period_adjustment'`);
  this one is for ordinary open-period entries (`entryType: 'standard'`) —
  reusing the other's name here would be misleading for an everyday
  in-period JV. Same two-phase shape as every other approval-gated GL
  posting: the registered execution handler only flips the entry to
  `approved` inside `decide()`'s transaction (`postJournalEntry` owns its
  own transaction, can't run inside `decide()`'s); the actual posting is a
  separate, explicit follow-up call. `lines` is snapshotted at request time
  so what eventually posts can never silently drift from what a checker
  reviewed. If the target period has since been locked,
  `postApprovedManualJournalEntry` lets `postJournalEntry` itself throw
  `PeriodLockedError` rather than silently reclassifying as a prior-period
  adjustment — the requester must use that dedicated workflow instead.
- **Bank reconciliation (`bank_accounts` / `bank_statement_lines`,
  migration 042) deliberately does NOT auto-create a bank GL sub-account
  per branch** the way cash-in-hand/vault/cash-in-transit do
  (`branchService.js`'s `CONTROL_ACCOUNT_CODES`/`createSubAccount`
  pattern) — unlike cash and a vault, not every branch necessarily holds
  its own bank account, so registering one is an explicit, occasional
  admin action (`createBankAccount`, linking an already-existing asset
  account created via the ordinary chart-of-accounts endpoints) rather
  than something every branch needs at creation time.
- **`bank_statement_lines.amount_pesewas` is signed from the bank's own
  point of view** (positive = money in, negative = money out) — this lines
  up directly with `normalizeBalance('asset', debit, credit)` since a bank
  account is a debit-normal asset, so a matched GL journal line's
  `debit_pesewas - credit_pesewas` must equal the statement line's
  `amount_pesewas` exactly. `matchStatementLine` enforces this equality —
  never a fuzzy/tolerance match — and a GL journal line can settle at most
  one statement line (`bank_statement_lines_matched_journal_line_uidx`).
- **`reconciled` means "every transaction on both sides has been matched,"
  not "the adjusted balances agree."** A real bug caught during this
  module's own integration testing: the initially-written formula compared
  `glBalance + unmatchedStatementTotal` against
  `statementBalance + unmatchedJournalTotal` and called them "reconciled"
  when equal — but algebraically that difference always reduces to
  `matchedJournalTotal - matchedStatementTotal`, which is always zero
  (every match is validated to have equal amounts by construction), making
  the check a tautology: it read `reconciled: true` even for a wholly
  fictitious, unmatched GL entry with zero bank corroboration. Fixed by
  redefining `reconciled` as `outstandingOnStatementNotInGl.length === 0 &&
  outstandingInGlNotOnStatement.length === 0` — genuinely meaningful,
  since it can only be true once every line has a validated, exactly-equal
  counterpart. The adjusted-balance figures are still returned (a useful
  "projected true cash position" once outstanding items clear as expected)
  but are no longer treated as the pass/fail signal.
- **GL-to-customer-account reconciliation** (the spec's other reconciliation
  report) is already satisfied by Module 4's `reconcileAccount`/
  `reconcileBranchDeposits` — no new endpoint was added here to avoid a
  second, parallel reconciliation mechanism for the same concern.

### Analytics & owner dashboard service — `backend/src/modules/analytics/analyticsService.js` (Module 9)

Per the module prompt, this module is "primarily read/aggregation logic
... over other modules' tables — avoid duplicating source-of-truth data",
so it owns exactly ONE table (`dashboard_widget_configs`) and reuses every
other module's own service wherever one already exists —
`cashierService.getBranchCashPosition`/`getConsolidatedCashPosition` for
cash position, `glService.getBalanceSheet`/`getIncomeStatement` for the
financial-statement pieces, `susuService.getAgentCommissionSummary` for
susu commissions — rather than re-deriving any of those a second way.

```js
// analyticsService.js
getLiveStats(pool, { branchId, date }) -> { cashPosition, todaysDisbursements, todaysCollections, nonCashTransactionCount, branchSnapshotGrid? }
getLoanBookSnapshot(pool, { asOfDate, branchId, loanOfficerId }) -> per-loan { outstandingPrincipalPesewas, daysOverdue }[]  // the shared base every portfolio-quality figure is built on
getPortfolioQuality(pool, { asOfDate, branchId, loanOfficerId, requestingUser, largestExposuresLimit }) -> { par30/60/90, agingBuckets, largestExposures }
getProfitability(pool, { fromDate, toDate, branchId }) -> { costToIncomeRatio, operationalSelfSufficiencyRatio, branchPL? }
getTopLoanCustomersByRevenue(pool, { fromDate, toDate, branchId, limit }) -> interest+fee revenue per customer, ranked
getGrowthTrends(pool, { fromDate, toDate, branchId, granularity }) -> { customerRecruitment, disbursementTrend, depositGrowth, sectorBreakdown }
getAgentProductivity(pool, { agentId, fromDate, toDate, requestingUser }) -> { susu: {...}, loanOfficer: {...} }
generateExecutiveReportPack(pool, { asOfDate, fromDate, toDate, branchId }) -> { balanceSheet, incomeStatement, portfolioSummary, socialPerformance }
listWidgetConfigs(pool, { roleId }) / upsertWidgetConfig(pool, { roleId, widgetKey, position, visible, updatedBy, actorBranchId }) / deleteWidgetConfig(pool, { configId, deletedBy, actorBranchId })
resolveLoanOfficerScope(requestingUser, requestedOfficerId)  // the own-book enforcement, see below
```

- **No `daily_metrics_snapshot` table.** The module prompt itself frames
  it as "populated by a scheduled job (Module 12)", and Module 12 doesn't
  exist yet — adding an unpopulated snapshot table now would be exactly
  the half-finished, nothing-writes-to-it pattern CLAUDE.md's working
  agreement warns against, the same reasoning already applied to
  `savings_accounts.status = 'dormant'` and `investments.status =
  'matured'` (both exist in their CHECK constraints with no producer
  until a Module 12 sweep exists). Every figure is instead computed live
  from the source tables, same "reconstruct, never a stale cached number"
  philosophy Module 7's reports already follow. Revisit if/when real data
  volume makes live computation too slow for a dashboard page load.
- **Role/branch/own-book scoping is enforced in TWO places, deliberately**,
  per the module prompt's explicit "incapable of returning another
  officer's book even if they inspect network requests": ordinary branch
  scoping goes through the existing `resolveBranchScope`/`canAccessBranch`
  middleware (`backend/src/middleware/requirePermission.js`) at the ROUTE
  layer, same convention every other module already follows (see "Branch
  Scoping Convention" below) — not duplicated here. But the NEW dimension
  this module introduces, a loan officer's own-book restriction, is
  enforced a SECOND time inside `analyticsService.js` itself
  (`resolveLoanOfficerScope`), called from `getPortfolioQuality` and
  `getAgentProductivity` — whatever `loanOfficerId`/`agentId` a caller
  passes is silently overridden to the requesting user's own id whenever
  `requestingUser.roleName === 'loan_officer'`. This is belt-and-suspenders
  by design: the route always forwards `requestingUser`, but the
  restriction lives at the layer a route bug can't bypass.
- **"Loan officer" is approximated as `loans.applied_by`** — this schema
  has no dedicated `loan_officer_id`/case-reassignment column (the closest
  real field is who filed the application), and adding one was judged out
  of scope for a reporting module (a real "reassign this loan to a
  different officer" workflow is a Module 3 business-process question,
  not something to bolt on from Module 9). See Open Questions.
- **"Sector" is approximated as the existing `customers.classification`
  free-form tag** (added in Module 2 for "risk tier / product eligibility
  / susu classification"), rather than adding a new dedicated
  `business_sector` column — reusing an existing free-form grouping field
  is more consistent with CLAUDE.md's anti-duplication rule than adding a
  parallel one for a very similar purpose. See Open Questions: no BOG-style
  sector taxonomy has been verified, so this is descriptive grouping only,
  not a regulatory classification.
- **Operational self-sufficiency ratio is simplified to income / expense**
  (no separate loan-loss-provision line exists to split out of "expense"
  yet) — a textbook OSS calculation nets financing expense and loan-loss
  provision separately from operating expense; this schema doesn't yet
  distinguish them at that granularity. Flagged as an approximation, not
  presented as the audited ratio.
- **"Loan customer profitability" is approximated as interest+fee revenue
  collected per customer**, ranked descending — a true fully-loaded
  profitability figure would need overhead-cost allocation this schema has
  no basis for, so this is deliberately a defensible proxy
  (`getTopLoanCustomersByRevenue`), not presented as final P&L per customer.
- **"Social performance" (the module prompt's own, otherwise-undefined
  term) is interpreted as the standard microfinance outreach figures this
  schema can actually support**: active customer/borrower counts, a
  gender split (the existing `customers.gender` column), and susu
  participation count — rather than inventing an undefined metric.
- **Dashboard widget config is per-ROLE, not per-user**, matching the
  module prompt's own framing ("Configurable dashboard widgets per
  role"). `widget_key` is deliberately free-form `VARCHAR`, not a
  CHECK-constrained enum — same reasoning as `customers.classification`:
  the registry of known keys (`KNOWN_WIDGET_KEYS`) lives in
  `analyticsService.js` and can grow without a migration, while a caller
  still gets a clear validation error for a typo'd key. Any
  `analytics.view` holder may read their OWN role's config
  (`GET /dashboard-configs/mine`, always the caller's own `roleId`,
  ignoring anything else); only `analytics.manage_dashboards` (owner/
  system_admin) can view another role's config or write.

### Field agent & operations service — `backend/src/modules/agent/agentService.js` (Module 10)

`field_agents` is a 1:1 EXTENSION of a staff/user record, not a
replacement for one — Module 4's own build already pre-answered this
module's "confirm the join key" question (see 029_susu.sql's comment):
`susu_collections.agent_id`/`susu_accounts.assigned_agent_id`/
`agent_remittances.agent_id` all reference `users(id)` directly, NOT
`field_agents`. So Module 10's own tables (`agent_assignments`,
`agent_locations`, `agent_reconciliations`) reference `field_agents(id)`
as their own PK, and bridge to Module 4's data via
`field_agents.user_id = <that column>` — exactly the
"susu_collections -> users <- field_agents" join the Module 4 comment
describes.

```js
// agentService.js
createFieldAgent(pool, { userId, homeBranchId, territory, createdBy }) -> field_agent  // opens its first agent_assignments row in the same transaction
updateFieldAgent(pool, { agentId, updatedBy, fields }) -> field_agent  // territory/status only; homeBranchId must go through reassignAgent
reassignAgent(pool, { agentId, newBranchId, territory, effectiveDate, reason, assignedBy }) -> field_agent  // closes the current open assignment, opens a new one, syncs the denormalized current branch/territory
listAssignmentHistory(pool, { agentId }) -> agent_assignments[]
recordLocationPing(pool, { agentId, gpsLat, gpsLng, recordedAt }) -> agent_location  // rejects (429) a ping submitted under MIN_PING_INTERVAL_SECONDS since the agent's last accepted ping
getCurrentLocation(pool, { agentId }) / getLocationHistory(pool, { agentId, fromDate, toDate })
purgeOldLocations(pool, { olderThanDays }) -> { deletedCount }  // callable now; scheduling it is a Module 12 concern, see below
runDailyReconciliation(pool, { agentId, date, createdBy }) -> agent_reconciliation  // upserts; never reverts an already-'resolved' row
runBranchDailyReconciliation(pool, { branchId, date, createdBy }) -> agent_reconciliation[]  // every active agent at the branch
listReconciliations(pool, { branchId, agentId, status, fromDate, toDate })
resolveReconciliation(pool, { reconciliationId, resolvedBy, resolutionNotes }) -> agent_reconciliation  // the ONLY path to status 'resolved'
```

- **`reassignAgent` mirrors `branchService.assignStaff`'s exact shape**:
  close the current open (`end_date IS NULL`) `agent_assignments` row,
  insert a new one, then sync the denormalized "current" fields
  (`field_agents.home_branch_id`/`territory`) onto the parent record —
  same pattern `branchService.assignStaff` already established for
  `users.home_branch_id`/`branch_staff_assignments`. At most one open
  assignment per agent at a time, enforced by a partial unique index
  (`agent_assignments_one_open_per_agent`), same mechanism as
  `branch_staff_assignments_one_open_per_user`.
- **A user can be tracked as a field agent regardless of their RBAC
  role.** The module prompt's own "susu collectors, loan officers doing
  field visits" framing needs both a `field_agent`-role user AND a
  `loan_officer`-role user to be trackable here, so `createFieldAgent`
  doesn't check/require any particular role — it's an operational
  tracking construct orthogonal to RBAC role assignment.
- **Minimum location-ping interval (`MIN_PING_INTERVAL_SECONDS = 120`) is
  an engineering/cost-control choice, not a regulatory figure** — the
  module prompt asks for "a reasonable ping interval... to control mobile
  data costs," not a specific number. A ping submitted too soon gets a
  distinct 429 (`AgentPingTooFrequentError`), not a 409 or a silent
  no-op, so a mobile client on flaky connectivity knows definitively not
  to bother retrying yet.
- **No scheduled purge job for `agent_locations`.** The module prompt
  itself asks for "a rolling retention window rather than infinite
  history" — `purgeOldLocations()` is a real, callable primitive
  (default 90-day window), but actually SCHEDULING it to run periodically
  is a Module 12 (System Administration) concern, same "the job exists,
  the cron doesn't yet" deferral already used for Module 9's
  `daily_metrics_snapshot`.
- **End-of-day reconciliation only covers susu field collections, NOT
  "any field loan repayments" the module prompt also asks for.**
  `loanService.js` (Module 3) has no field-collection/agent concept at
  all — `postRepayment` always posts against the branch's own cash-in-hand
  account with no notion of "collected in the field, not yet banked" the
  way susu's `cash_with_agents` control account + `agent_remittances`
  bridge provides. Adding that would be real Module 3 schema/posting
  surgery (a new collection channel, likely its own GL control account),
  judged out of scope for a module described as reading other modules'
  data, not redesigning one. See Open Questions.
- **The expected/received comparison is genuinely non-tautological**,
  unlike the bug this session already found and fixed in Module 7's bank
  reconciliation (see that section above): `expected_amount_pesewas` sums
  `susu_collections` by `collection_date`; `received_amount_pesewas` sums
  `agent_remittances` by the INDEPENDENT `remitted_on` date — since an
  agent doesn't necessarily remit the same day they collect, these two
  sums can genuinely differ (an agent still holding cash overnight is
  exactly the case worth flagging), not just re-derive the same number a
  different way.
- **A variance never auto-resolves** (module prompt's own explicit rule):
  `status` is set to `'matched'` only when variance is exactly zero, else
  `'pending_review'`, and only `resolveReconciliation()` — a distinct,
  always-`resolutionNotes`-required human action — can move a row to
  `'resolved'`. Re-running `runDailyReconciliation` for an already-
  `'resolved'` day recomputes the expected/received FIGURES but leaves
  `status` at `'resolved'` rather than silently reverting it back to
  `'pending_review'`/`'matched'`.
- **Per-agent branch scoping is enforced at the route layer for every
  `:id`-scoped endpoint** (`GET/PATCH /agents/:id`, `/reassign`,
  `/assignments`, `/location(s)`, `/:id/reconciliations`): the route
  fetches the agent first, then checks
  `canAccessBranch(req, agent.home_branch_id)`, 403ing rather than
  leaking whether some other branch's numeric agent id even exists — same
  "server-side, never trust the path param" rule as
  `GET /branches/:id/performance`.

### Regulatory & compliance service — `backend/src/modules/compliance/complianceService.js` (Module 8)

**CLAUDE.md rule 7 governs almost every table this module owns**: "Never
hardcode BOG thresholds, provisioning rules, or GRA tax rates from
general knowledge." None of `loan_classification_configs`,
`regulatory_ratio_definitions`, or `tax_rates` ship with ANY seeded
numeric figure (migration 048's own header comment) — every function that
reads one throws `ComplianceNotFoundError` with an explicit "a compliance
officer must configure this first" message if nothing has been
configured, rather than silently assuming a default. See Open Questions
for the full list of what needs verification before this module is used
for a real submission.

```js
// complianceService.js
createLoanClassificationConfigSet(pool, { categories, effectiveDate, createdBy, actorBranchId }) -> rows[]  // must cover all 5 BOG categories in one call
runLoanClassification(pool, { asOfDate, branchId, createdBy }) -> loan_classifications[]  // reuses analyticsService.getLoanBookSnapshot for days-overdue, never a second computation
getLoanClassificationSummary(pool, { asOfDate, branchId }) -> reads the PERSISTED snapshot, not a live recompute
createRatioDefinition(pool, { name, numeratorGlCodes, denominatorGlCodes, minimumRatioBps, effectiveDate, createdBy })
computeRatio(pool, { name, asOfDate, branchId }) -> { numeratorPesewas, denominatorPesewas, ratioBps, minimumRatioBps, compliant }  // compliant is null until a minimum is configured
createTaxRate(pool, { taxType, rateBps, vatApplicableGlCodes, effectiveDate, createdBy })
getWithholdingTaxSummary(pool, { periodStart, periodEnd }) / getVatSummary(pool, { periodStart, periodEnd, branchId })
createReportTemplate(pool, { name, targetAuthority, fieldMappings, effectiveDate, createdBy }) -> versioned, never mutates an old version
generateReport(pool, { templateId, periodStart, periodEnd, asOfDate, branchId, generatedBy, actorBranchId }) -> snapshots report_data onto a NEW regulatory_report_submissions row
markReportSubmitted(pool, { submissionId, submittedBy, fileReference })
createAmlRule(pool, {...}) / runAmlScreening(pool, { fromDate, toDate }) / reviewAmlFlag(pool, { flagId, reviewedBy, newStatus, reviewNotes })  // NEVER auto-clears
addSanctionsListEntry(pool, {...}) / screenCustomer(pool, { customerId, screenedBy }) / resolveScreeningMatch(pool, { screeningResultId, resolvedBy, resolution, notes })  // NEVER auto-confirms a match
```

- **Loan classification reuses `analyticsService.getLoanBookSnapshot`
  rather than re-deriving days-overdue a second way** — the exact same
  per-loan snapshot Module 9's portfolio-quality report is built on.
  `loan_classification_configs` requires a FULL generation (all five BOG
  categories: current/OLEM/substandard/doubtful/loss) inserted together
  for one `effective_date` — a partial generation would leave
  `classifyLoan` unable to categorize a loan whose arrears fall in an
  ungapped range, so `createLoanClassificationConfigSet` rejects anything
  less than full coverage. `loan_classifications` is a deliberate
  point-in-time SNAPSHOT table (unlike Module 7/9's always-live reports) —
  a regulatory submission must reflect exactly what was classified at
  generation time, not silently drift if the loan book changes afterward.
- **Capital adequacy ratio and liquidity ratio are NOT hardcoded
  formulas** — `regulatory_ratio_definitions` is a fully generic
  "numerator GL codes (with optional weights) / denominator GL codes"
  computation engine, reusing `glService.getAccountRollup` (never a
  second balance-aggregation path) so ANY ratio a regulator asks for —
  not just CAR/liquidity — can be defined as data. Which GL control
  accounts belong in a real CAR/liquidity numerator/denominator, at what
  risk-weight, and what the actual minimum ratio is, are exactly "the
  current BOG guidelines" the module prompt says must be verified with a
  compliance officer — so `minimum_ratio_bps` is nullable, and
  `computeRatio`'s `compliant` field is `null` (never a guessed
  true/false) until an admin has configured a verified minimum.
- **GRA withholding tax / VAT are configurable `tax_rates`, effective-
  dated the same "latest effective_date <= asOfDate wins" way as
  `regulatory_ratio_definitions`/`loan_classification_configs`.**
  Withholding tax sums `investment_payouts` actually PAID in the period
  (`updated_at`, stamped at settlement by
  `investmentService.settleApprovedInvestmentPayout` — there's no
  separate "paid_at" column). VAT requires `vat_applicable_gl_codes` to
  be explicitly configured on the tax_rates row (which GL fee-income
  accounts are VAT-scoped is itself a classification decision, not
  assumed) and sums that code list's PERIOD activity via
  `glService.getAccountRollup`, same reuse as the ratio engine.
- **Report templates are versioned by NEVER mutating a row** — creating
  another template with the same `name` always inserts version
  `max(version) + 1`; the OLD version's `field_mappings` stay exactly as
  they were, satisfying the module prompt's "a report generated last year
  can be regenerated using the template version that was active then."
  Only `status` (`active`/`retired`) is togglable in place — that's a
  lifecycle flag, not report content.
- **`generateReport` is a small dispatcher over `REPORT_DATA_SOURCES`**, a
  fixed map of named data sources (`loan_classification_summary`,
  `capital_adequacy_ratio`, `liquidity_ratio`, `social_performance_summary`,
  `withholding_tax_summary`, `vat_summary`) — a template's
  `field_mappings.fields` just says which source populates which report
  key. `social_performance_summary` calls
  `analyticsService.getSocialPerformanceSummary` directly (extracted from
  Module 9's `generateExecutiveReportPack` specifically so this module
  doesn't duplicate that aggregation for a different audience).
- **An AML flag never auto-clears** (module prompt's own explicit rule,
  same discipline as Module 10's `agent_reconciliations`): `runAmlScreening`
  only ever creates flags at `status = 'open'`; `reviewAmlFlag` is the
  ONLY path to `'reviewed'`/`'cleared'`, always requires `reviewNotes`,
  and can never move a flag back to `'open'`. Re-scanning an
  already-scanned window never creates a duplicate flag for the same
  transaction/rule pair (`UNIQUE (rule_id, transaction_type,
  transaction_id)`, `ON CONFLICT DO NOTHING`). Only `rule_type =
  'single_transaction_threshold'` has real evaluation logic today — the
  column allows for future rule types, but nothing else is implemented,
  and that's documented rather than silently pretended to be complete.
- **Sanctions screening never auto-produces a `'confirmed_match'`** —
  applying the same "a human must resolve it" discipline the module
  prompt states explicitly for AML flags to this equally sensitive
  finding, even though the prompt doesn't say it in so many words for
  sanctions specifically. The automatic screening pass can only produce
  `'no_match'` or `'potential_match'`; only `resolveScreeningMatch` (always
  requiring `notes`) can move a `'potential_match'` to `'cleared'` or
  `'confirmed_match'`. **`sanctions_list_entries` starts and stays EMPTY**
  — there is no legitimate way to embed a real OFAC/UN/Ghana-FIC list in
  application code, and fabricating placeholder "sanctions" names would
  be actively dangerous for a compliance feature. The screening WORKFLOW
  is real and fully wired; only the underlying list DATA is a deliberate,
  loudly-flagged gap — see Open Questions.
- **No dedicated "compliance officer" role exists yet** — permissions
  split `compliance.manage_config` (system_admin only, the technical
  "define the regulatory engine's parameters" action, same grain as
  `gl.manage_accounts`) from `compliance.generate_reports`/
  `compliance.manage_aml`/`compliance.manage_sanctions` (owner +
  system_admin, the actual day-to-day compliance work) — see Open
  Questions.

---

## Branch Scoping Convention

_How `branch_id` is enforced across queries — e.g., middleware-level
scoping, row-level security, or application-layer filtering — decided
once and applied everywhere._

- Application-layer filtering (not Postgres row-level security) via
  `resolveBranchScope(req)` (query-param-scoped endpoints) and
  `canAccessBranch(req, branchId)` (path-param-scoped endpoints), both in
  `backend/src/middleware/requirePermission.js`.
- Default: every request is scoped to `req.user.homeBranchId`.
- Roles in `CROSS_BRANCH_ROLES` (currently `owner`, `system_admin`) may
  access any branch.
- **Updated in Module 1**: any other role may also access a branch it
  holds an active `cross_branch_access_grants` row for (time-bound,
  revocable — Module 1's `grantCrossBranchAccess`/`revokeCrossBranchAccess`).
  `requireAuth` middleware (`backend/src/middleware/auth.js`) loads a
  user's currently-active grant branch ids onto
  `req.user.crossBranchAccessibleBranchIds` on every request (a fresh DB
  query each time — see Open Questions on caching), so `resolveBranchScope`/
  `canAccessBranch` can check it synchronously with no extra query.
  Otherwise the request falls back to `req.user.homeBranchId` — a
  non-privileged role's `?branchId=` for a branch it has neither the home
  branch nor an active grant for is silently ignored (query-param version)
  or 403s (path-param version via `canAccessBranch`), so an API client
  can't escalate scope by editing the query string or path.
- This mirrors the CLAUDE.md rule that permission/scope checks happen
  server-side, never trusting the frontend.

---

## Open Questions

_Anything flagged as needing verification — especially regulatory figures
(BOG thresholds, GRA rates) that must not be hardcoded from general
knowledge — plus any module prompt conflicts that need a human call._

- [ ] **Auth/session mechanism is a placeholder.** `backend/src/middleware/sessionStore.js`
      is an in-memory `Map` of bearer tokens — no persistence across
      restarts, no multi-instance support, no password reset/lockout
      policy. Fine for local dev on this milestone; must be replaced
      (JWT or a persisted session store) before any other environment
      depends on it. No regulatory figures were hardcoded in this
      session (Module 11/7 don't touch BOG/GRA numbers), so nothing to
      flag on that front yet — Module 8 will need to.
- [ ] `approval_thresholds` table exists and is queryable
      (`getApplicableThreshold`), but no default threshold rows are
      seeded — every module that wants auto-routing to a checker role
      must insert its own threshold row(s) (e.g. loan disbursement above
      X pesewas requires a branch_manager). Decide per-module, record the
      actual amounts here when set.
- [ ] `restricted_account_access` and `access_time_windows` tables exist
      (migration 003) per the Module 11 spec, but no middleware enforces
      them yet — only `requirePermission`/`resolveBranchScope` are wired
      into the request pipeline. Whoever builds the module that needs
      VIP-account restriction or time-windowed access must add that
      enforcement, not assume the table's existence means it's enforced.
- [x] ~~Customer-account transfers between branches are NOT built.~~
      **Resolved in Module 2**: `customer_branch_transfers` (migration 019)
      + `customerService.transferCustomerBranch()`. Independent of Module
      1's `branch_transfers` (cash-in-transit only) — see the Customer
      service section under Shared Services above.
- [ ] `req.user.crossBranchAccessibleBranchIds` (Module 1) is loaded with
      a fresh DB query on every single request in `requireAuth`. Fine at
      current scale; if this becomes a hot path, consider caching it
      alongside the session rather than joining on every request — not
      done now because there's no evidence yet it needs to be.
- [ ] No `approval_thresholds` row exists for `branch.close` (or any
      action_type yet) — every branch closure request currently has
      `required_approver_role_id = NULL`, meaning `decide()` accepts
      approval from anyone holding `approval.decide`, not specifically a
      more senior role. Decide the real threshold/role policy per
      action_type as modules mature; don't assume NULL is a permanent
      choice. This now also applies to `customer.close` (Module 2) —
      same gap, same fix when addressed.
- [ ] **Ghana Card format** (`GHA-XXXXXXXXX-X`,
      `customerService.validateGhanaCardNo()`) is the publicly documented
      NIA format, implemented from general knowledge rather than a cited
      official spec. Not a BOG/GRA monetary figure, but still flagged for
      verification before this blocks real customer onboarding — same
      caution CLAUDE.md asks for regulation-dependent figures, applied to
      an ID format instead.
- [ ] **No specific closure cooling-off duration is implemented.** The
      Module 2 spec says "a mandatory closure reason code and a
      cooling-off/approval step before a closure is final" — implemented
      as the maker-checker approval step alone (a different user must
      decide). If product/compliance actually wants a literal time delay
      (e.g. "closure can't be approved until N days after the request"),
      the value of N is not specified anywhere in the spec and was not
      guessed — get it from an actual requirement, then enforce it in
      `requestClosure`/the `'customer.close'` execution handler.
- [ ] **`creditBureauClient.js` is a hardcoded stub** — deterministic fake
      score, `stub: true` always in the response, no real bureau
      configured. Must be replaced with a real integration (endpoint,
      credentials, response mapping) before any bureau-lookup result is
      treated as real by Module 3 (loan appraisal) or shown to staff as
      more than a placeholder. **Module 3 deliberately did NOT make a
      bureau lookup a precondition of loan approval** precisely because
      the stub's output is meaningless — wire that in when the real
      integration lands.
- [x] ~~Overdraft loans are still not implemented.~~ **Resolved**:
      migrations `032_overdraft.sql` / `033_overdraft_permissions_seed.sql`
      + `loanService.js`'s `activateOverdraft` / `getOverdraftStatus` /
      `accrueOverdraftInterest` / `closeOverdraft` / `writeOffOverdraft`.
      `applyForLoan()` now links an overdraft loan to a specific existing
      savings account and validates it (same customer, active, product
      `allows_overdraft`); disbursement activates a real numeric limit on
      that account with no schedule and no GL posting; drawing happens
      through the ordinary savings withdrawal path; interest is accrued
      (not recognized on receipt, unlike term loans — a deliberate
      exception, see the Loan service section) and posted through
      `savingsService.applyMovement`. **This also fixed a real bug**
      uncovered while building it: `assessWithdrawal`'s `allowsOverdraft`
      boolean and `applyMovement`'s `skipBalanceCheck` boolean previously
      disabled the balance floor ENTIRELY for any `allows_overdraft`
      account — an unlimited, unattached overdraft with no ties to an
      actual approved facility. Both are now real numeric parameters
      (`overdraftLimitPesewas` / `minAllowedBalancePesewas`) tied to
      `savings_accounts.overdraft_limit_pesewas`, which is 0 unless an
      overdraft loan is actually disbursed against that account.
- [ ] **Interest is recognized on receipt, not accrual** (see the Loan
      service section). This is a coherent, simple model for a
      cash-basis microfinance book, but Module 8 (BOG prudential returns,
      provisioning) and Module 9 (profitability) may require
      accrual-basis interest income. Confirm the required basis with the
      compliance officer **before** building Module 8 — retrofitting
      accrual after loans are live means restating income.
- [ ] **PAR buckets vs. BOG loan classification are different things.**
      `loan_products.par_bucket_days` drives portfolio-management aging
      (default 30/60/90). BOG's classification categories
      (current/OLEM/substandard/doubtful/loss) and their days-past-due
      boundaries are a Module 8 concern and must come from current
      official BOG guidance — do NOT assume the PAR buckets double as
      the regulatory thresholds.
- [ ] **No `approval_thresholds` row exists for `loan.approve` either**,
      so every loan approval currently accepts any user holding
      `approval.decide` regardless of loan size. The table supports
      amount-banded routing (`amount_pesewas` is already stamped on loan
      approval requests) — decide the real bands with the business. Module
      4's `savings.withdraw` reads the same table and does have a
      resolution path wired (product default -> branch override), but no
      rows are seeded there either: the real withdrawal thresholds are a
      business/compliance number nobody has supplied yet.
- [ ] **There is no notification service, so standing-order failures are
      recorded but not delivered.** The business rule says a failed
      standing order should "notify the customer". Module 4 records every
      failure with its reason and exposes
      `GET /savings/standing-orders/failures` (rows where
      `customer_notified = false`) so nothing is silently lost — but
      nothing sends an SMS/email, and nothing ever flips that flag.
      Whoever builds notifications (likely alongside Module 12) should
      drain that queue and set `customer_notified`.
- [ ] **Cross-branch standing orders are rejected, not supported.**
      Transferring between accounts at different branches needs a
      due-to/due-from inter-branch GL account pair, which doesn't exist.
      `createStandingOrder()` refuses them explicitly rather than posting
      something lopsided. Add the inter-branch pair (and the same for
      ad-hoc customer transfers) when the business needs it.
- [ ] **Nothing marks a savings account `dormant`.** The status exists in
      the enum but requires an inactivity sweep, which belongs to Module
      12's scheduler. Likewise, `applyCharges()` is per-account and
      staff-invoked — the periodic bulk run (monthly maintenance fees
      across the book) is a Module 12 job that doesn't exist yet.
- [ ] **Agent commission is accrued but never paid.**
      `susu_commissions.paid_at` and the Agent Commission Payable
      liability exist, and commission accrues per collection, but there is
      no payout flow — that plausibly belongs with Module 10 (Agent & Field
      Ops) or payroll. The liability will therefore grow monotonically
      until someone builds the settlement side.
- [ ] **Module 5's "investments" haven't been checked against actual BOG
      (or, if structured as a collective investment scheme, Ghana SEC)
      regulatory classification.** They're booked as a deposit-taking
      liability here (see Chart of Accounts / Investment service above),
      which is the coherent reading of the spec's own language, but
      whether this specific product actually falls under the
      institution's deposit-taking licence, needs a separate CIS
      registration, or something else entirely is a real compliance
      question that wasn't answered from general knowledge — confirm with
      the compliance officer before this product is offered to a real
      investor, per CLAUDE.md's rule on regulation-dependent figures.
- [ ] **No live payments integration exists yet** (the Suggested Build
      Order's separate "Payments integration" step, still unbuilt) — so
      Module 5's redemption/payout "confirm the transfer succeeded" step
      is a manual staff action: `confirmRedemptionPayout`/
      `settleApprovedInvestmentPayout` take a free-text
      `payment_reference` the staff member types in after actually moving
      the money via MoMo/bank/cashier, rather than a real callback from a
      payment rail. Wire a real confirmation callback in when MoMo/GHIPSS/
      Paystack/Hubtel integration lands — don't treat `payment_reference`
      as verified proof of anything until then.
- [ ] **A rejected `investment.book` approval leaves `investments.status`
      at `pending_approval`, not `rejected`** — because
      `approvalWorkflow.decide()` only invokes an action_type's registered
      execution handler when `decision === 'approved'`, never on
      rejection, so there is no hook for the investment module (or any
      module) to react to a rejection by updating its own entity's
      status. The `approval_requests` row itself is correct (`status:
      'rejected'`), the information isn't lost, just not mirrored onto
      `investments.status`. **This is not new** — Module 3's
      `loan.approve` has the exact same gap (a rejected loan approval
      never flips `loans.status` to `rejected` either; only appraisal
      decline does), and **Module 6 has it a third and fourth time**:
      `cash_back_requests.status` and `transaction_reversals.status` both
      stay `pending` forever on rejection instead of moving to their own
      `rejected` value. Fixing it properly means changing
      `approvalWorkflow.decide()` to invoke the handler on both outcomes
      and updating every existing handler (branch/customer closure, loan
      approve/restructure, savings withdrawal, investment book/payout/
      redeem, cashier cashback/reversal) to branch on the outcome — a
      cross-cutting change touching every module built so far,
      deliberately NOT done as a drive-by fix here. Do it as its own
      explicit, tested change.
- [ ] **Nothing sweeps `investments.status` to `matured` when
      `maturity_date` passes.** Same shape as savings' unbuilt dormancy
      sweep — belongs to Module 12's scheduler. Until then, `matured` is a
      valid enum value that nothing ever sets; `requestRedemption` works
      correctly regardless (it derives "early or not" from comparing dates
      directly, not from this status), so this is a reporting gap, not a
      correctness one.
- [ ] **Till variance is not a true per-transaction reconciliation** (see
      the Cashier service section for the full reasoning) — it only nets
      the till's own opening float and cash-back against the cashier's
      physical count, because ordinary teller transactions (deposits,
      withdrawals, disbursements, repayments) aren't attributed to a
      specific `till_id` anywhere in this schema; they post to the
      branch's pooled Cash in Hand. If the business needs a true
      till-level audit trail (which specific transactions a given cashier
      actually processed), that requires adding `till_id` to
      `savings_transactions`, `loan_repayments`, and every other cash-
      moving table across Modules 3–5 — a real, cross-module schema
      change, not a Module 6 tweak.
- [ ] **No `approval_thresholds` row exists for `cashback.request`
      either**, so every cash-back currently needs approval regardless of
      amount (the safe default). Same open question as `loan.approve` and
      `savings.withdraw`/`investment.payout` before it — the real
      threshold is a business/compliance number nobody has supplied yet.
- [ ] **`gl_periods` locking is now real but coarse: month/year only, no
      partial-branch exemptions.** Once a period is locked for a branch,
      EVERY module's postings into it are blocked (loans, savings,
      investments, cashier) — there's no way to lock "GL adjustments only"
      while leaving, say, loan disbursement open, nor to lock a period for
      some branches but not others in one call (each `closeOutPeriod`
      call is single-branch). If the business needs finer-grained locking
      than that, it's a new decision, not an extension of this mechanism.
- [ ] **Module 9's "loan officer" is approximated as `loans.applied_by`** —
      there is no dedicated `loan_officer_id`/case-reassignment column
      anywhere in this schema. In most real usage a loan officer likely IS
      whoever takes the application, but a genuine "reassign this loan to
      a different officer" business need would require an actual schema
      addition (a Module 3 decision, not a Module 9 one) — flagging here
      rather than silently treating the approximation as exact.
- [ ] **Module 9's "sector analysis" reuses the existing
      `customers.classification` free-form tag**, not a dedicated
      `business_sector` column or any verified BOG sectoral-classification
      taxonomy. No historical customers have a value populated (nothing
      before Module 9 ever set it for this purpose), so sector analysis
      will read as mostly "unspecified" until customer onboarding actually
      captures a real value. If BOG's own sector taxonomy for microfinance
      reporting needs to be followed exactly, that's a regulatory-figures
      question per CLAUDE.md ("never hardcode BOG thresholds... from
      general knowledge") and needs verification before this classification
      is presented as anything more than descriptive grouping.
- [ ] **Module 9's operational self-sufficiency ratio is simplified**
      (income / expense, no separate loan-loss-provision split) — see the
      Analytics service section. If a real OSS figure needs to match a
      specific regulatory or investor-reporting definition, verify the
      exact formula before presenting it as that number.
- [ ] **No `daily_metrics_snapshot` table exists yet** (Module 9's own
      module prompt frames it as a Module 12 scheduled-job artifact) —
      every analytics figure is computed live from source tables. Revisit
      if/when dashboard load times at real data volume make live
      computation impractical; build the scheduled snapshot job in Module
      12 then, not as an unpopulated table now.
- [ ] **Module 10's end-of-day reconciliation does not cover "any field
      loan repayments"**, only susu field collections — `loanService.js`
      has no field-collection/agent concept (no "collected in the field,
      not yet banked" channel the way susu's `cash_with_agents`/
      `agent_remittances` bridge provides). If loan officers start doing
      field collection for real, this needs actual Module 3 schema/
      posting work (a new collection channel, likely its own GL control
      account) — not something to bolt onto Module 10's reconciliation
      without that primitive existing first. See the Agent service
      section.
- [ ] **`agent_locations` has no scheduled purge** — `agentService.
      purgeOldLocations()` is a real, callable function (default 90-day
      retention), but nothing calls it periodically yet. Wire it into
      Module 12's scheduler when that exists, same deferral as Module 9's
      `daily_metrics_snapshot`.
- [ ] **`MIN_PING_INTERVAL_SECONDS` (120s) is a starting engineering
      guess**, not a number derived from actual mobile-data-cost analysis
      or field-agent workflow research — revisit if real agent usage shows
      it's too strict (missed genuine movement) or too loose (excessive
      data usage).
- [ ] **Module 8 (Regulatory & Compliance) ships with ZERO regulatory
      figures configured — this is deliberate, per CLAUDE.md rule 7, and
      every one of the following MUST be verified with SwiftCedi's actual
      compliance officer against current official guidance before this
      module is used for a real BOG/GRA submission:**
      - `loan_classification_configs` — no rows exist. The BOG
        current/OLEM/substandard/doubtful/loss days-past-due boundaries
        and provisioning rates used in this session's own tests
        (0/1-30/31-90/91-180/181+ days; 0%/5%/25%/50%/100% provisioning)
        are illustrative test fixtures ONLY, not sourced from any actual
        current BOG prudential guideline — do not carry them into a real
        deployment's seed data.
      - `regulatory_ratio_definitions` — no rows exist for a real
        capital-adequacy or liquidity ratio. Which GL control accounts
        belong in the numerator/denominator, at what risk-weight, and
        what the actual minimum ratio BOG requires for a licensed
        microfinance institution, are all unknowns this session did not
        attempt to guess.
      - `tax_rates` — no rows exist for GRA withholding tax on investor
        interest or VAT on fee income. Ghana's actual current rates were
        deliberately NOT hardcoded from training-data "general knowledge"
        per CLAUDE.md's explicit instruction, since tax rates change and
        stale/wrong figures in a live compliance report are worse than an
        obvious `ComplianceNotFoundError`.
      - `sanctions_list_entries` — starts and stays EMPTY. There is no
        legitimate way to embed a real OFAC/UN/Ghana-FIC sanctions list in
        application code; a real deployment MUST load a genuine,
        currently-maintained list feed before sanctions screening means
        anything. Until then, every screening will report `no_match`,
        which must NOT be mistaken for "screened clean" in the real
        compliance sense.
      - `aml_rules` — no rows exist. Real AML transaction-threshold
        amounts are a compliance-policy decision (and may be tied to
        actual FIC/BOG reporting thresholds), not a number this session
        invented.
      See the Compliance service section above for how each of these
      resolves to a clear, typed "not configured yet" error rather than a
      silent default when nothing has been set.
- [ ] **No dedicated "compliance officer" role exists in this codebase's
      role set** (owner, branch_manager, loan_officer, cashier,
      field_agent, system_admin) — Module 8's compliance-work permissions
      (`compliance.generate_reports`/`manage_aml`/`manage_sanctions`) are
      granted to `owner` as the closest fit for now. If a real dedicated
      compliance-officer position is created, add a proper role for it
      (Module 11's RBAC CRUD) rather than continuing to overload `owner`.
- [ ] **AML screening only covers `single_transaction_threshold`
      rules** — `aml_rules.rule_type` allows for future rule types (e.g.
      structuring/smurfing detection, velocity rules) but none of those
      have real evaluation logic yet; only flag this as a gap if/when a
      real compliance requirement needs them.

---

## Deviations from the Original Module Prompts

_Anywhere the actual build diverged from `SwiftCedi_Module_Build_Prompts.md`,
and why — so future sessions don't "fix" something back to a plan that was
deliberately changed._

- **A minimal `branches` table was created in Module 11/7's migrations**,
  ahead of Module 1, purely so `users`, `gl_accounts`, `audit_log`, etc.
  could carry a real `branch_id` FK from day one instead of a bare
  unconstrained integer. It has only `id, code, name, status, created_at,
  updated_at` — none of Module 1's region/cluster/GPS/hierarchy fields.
  Module 1 must `ALTER TABLE` this, not drop/recreate it. This isn't a
  scope change to Module 1, just sequencing: the column had to exist
  before Module 11/7 could enforce "every table carries branch_id" for
  real.
- **DB-level enforcement added beyond what the prompts asked for**: a
  deferred constraint trigger makes unbalanced `gl_journal_lines` fail at
  COMMIT (not just at the application layer), a `CHECK` constraint makes
  `approval_requests.decided_by = requested_by` physically impossible, and
  BEFORE triggers make `audit_log` and `gl_journal_lines` reject
  UPDATE/DELETE outright. CLAUDE.md's rules ("reject unbalanced entries at
  the application layer", "immutable audit log entry") are satisfied at
  the app layer already; the DB layer is a deliberate second line of
  defense given these are financial-integrity rules, not a requirement
  anyone should feel obligated to replicate for every future rule.
- **Auth was not in Module 11's explicit scope** (the module prompt is
  about RBAC/permissions/audit, not login) but `requireAuth`/`requirePermission`
  middleware needed *something* to authenticate against to be testable
  end-to-end, so a minimal login/session flow was added
  (`POST /auth/login`, in-memory bearer tokens). See Open Questions —
  this is explicitly a placeholder, not a considered auth design.
- **Module 1's own "BEFORE YOU WRITE CODE" note names "Module 6" for the
  GL counterpart to confirm account types against** — that's a numbering
  inconsistency in `SwiftCedi_Module_Build_Prompts.md` itself (Module 6 is
  Cashier/Till/Vault; the actual GL module is Section 7, "GL, Accounting &
  Financial Reporting," per the same document's own numbering and table of
  contents). Treated "the GL module" as Module 7 throughout — i.e. used
  the real `gl_accounts`/`postJournalEntry()` built in this repo's Module
  7 session, not a nonexistent "Module 6 GL." A couple of other module
  prompts (e.g. Module 6 Cashier's own "BEFORE YOU WRITE CODE") have the
  same "Module 6's GL counterpart" phrasing — same resolution applies
  there when that module gets built.
- **`branches.status` closure requires passing through `suspended` or
  `under_review` first** (`branchService.VALID_STATUS_TRANSITIONS`) — the
  prompt's literal lifecycle text ("active -> suspended -> under-review ->
  closed") reads as a chain, but doesn't explicitly forbid closing
  directly from active. Interpreted it as a chain deliberately: closure is
  the one irreversible, highest-impact transition, and forcing a stop at
  `suspended`/`under_review` first is a reasonable governance rail for a
  banking platform. If a future session decides direct active->closed
  should be legal after all, change
  `VALID_STATUS_TRANSITIONS.active` — don't work around it per-caller.
- **Cash-in-transit branch transfers are not routed through
  `approval_requests`**, unlike every other financial-impact action in
  this codebase so far. The source branch initiates (posts the outbound
  leg) and the destination branch confirms (posts the inbound leg) — two
  different actors, naturally providing dual control without a formal
  maker-checker record. This was a deliberate scope call, not an
  oversight: revisit if a future compliance requirement wants an explicit
  approval trail for transfers specifically (the GL journal entries
  themselves are still a full, immutable audit trail of what moved and
  when).
- **`customers` is one polymorphic table for individual/group/sme**, not
  three type-specific tables — the module prompt's own data model
  ("`customers` table: id, customer_type ...") reads as a single table
  too, so this isn't really a deviation so much as a confirmation, but
  it's called out because the alternative (per-type tables with a shared
  parent) is a common enough pattern that a future session might
  "refactor" toward it without realizing the single-table design was
  deliberate — the join-heavy queries every other module will run
  (Customer 360, group membership, loan/savings eligibility checks) are
  simpler against one table.
- **`account_closures` doesn't literally match the spec's column list**
  ("reason_code, requested_by, approved_by, closure_date") — it has
  `reason_code`/`closure_date` but gets `requested_by`/`approved_by`/
  status via a `UNIQUE` FK join to `approval_requests` instead of storing
  them twice. Same reasoning as Module 1's branch closure (which has no
  bespoke closure table at all) — extend the shared approval-workflow
  service, don't duplicate its state. See the Customer service section
  under Shared Services.
- **No `loan_approvals` table**, which the Module 3 prompt's data model
  explicitly lists ("`loan_approvals` implementing maker-checker
  (requested_by, approved_by, cannot be the same user)"). The shared
  `approval_requests` row IS that record — same call Modules 1 and 2 made
  for branch/customer closure, and the "cannot be the same user"
  requirement is already enforced there at BOTH the app layer and by a DB
  `CHECK` constraint. A per-module approvals table would duplicate that
  state and risk the two disagreeing. `loan_restructures` DOES exist as
  its own table, but only because it carries restructure-specific data
  (old/new schedule version, new term/rate); it FKs to the
  `approval_requests` row rather than duplicating its status.
- **The group-default rule is invented, because the spec asks for one
  without specifying it** ("Group loans need a rule for how one member's
  default affects the group's ability to access further group credit").
  Decided rule: any *current* member with a written-off loan (their own
  or a group loan they were jointly liable on) blocks the whole group
  from new group credit until resolved. Deliberately strict — solidarity
  lending's whole premise is joint liability — but it is a **business
  policy choice that should be confirmed**, not a derived requirement.
  If the business wants something softer (a grace threshold, a
  time-decay, manager override), change `findGroupCreditBlockers()`; the
  named-members error message is designed so staff can see exactly who
  is blocking.
- **Fees are netted from disbursement rather than billed across
  installments.** The spec says products have a "fee schedule" without
  saying when fees are charged. Netting at disbursement is the common
  microfinance practice and keeps the repayment schedule to pure
  principal+interest. The schema and the repayment waterfall both already
  support per-installment fees (`loan_schedules.fees_due_pesewas`) if a
  future product needs them — nothing populates that column today.
- **Susu accounts are standalone, not a savings product variant.** The
  spec lists `susu_accounts` as its own table with its own cycle fields,
  so susu balances live in their own liability control (`2010`) and only
  become ordinary savings on payout. The alternative (susu as a flavour of
  `savings_accounts`) would have made "cycle completed vs uncompleted" and
  the agent-collection flow awkward to model. A susu account optionally
  points at a `payout_savings_account_id` for settlement.
- **`agent_remittances` is a Module 4 table even though agent
  reconciliation is Module 10's job.** Module 4 has to record *that* an
  agent banked their cash (otherwise Cash-with-Agents never clears and the
  GL is wrong), so the remittance event and its GL posting live here.
  Module 10 owns the *reconciliation* — comparing these remittances and
  their collections against what the cashier counted, and routing variances
  to a supervisor. Module 10 should read this table, not create a parallel
  one.
- **A stored `savings_accounts.balance_pesewas` coexists with CLAUDE.md's
  "no mutable running balances" rule.** That rule is about GL reporting,
  which is untouched — this is a customer subledger the spec explicitly
  asks for, backed by an immutable transaction ledger and two
  reconciliation checks. Called out because a future session could
  reasonably read the CLAUDE.md rule as forbidding it; it was a considered
  decision, not an oversight. See the Savings service section.
- **Customer `status: 'closed'` has no reactivation path**, unlike
  `branches.status: 'closed'` where the parallel doesn't even apply (both
  are terminal). This wasn't specified either way in the Module 2 prompt;
  chosen for consistency with the branch closure precedent and because
  "unclosing" a customer account is a big enough decision to deserve its
  own explicit workflow if it's ever needed, not a side effect of the
  existing reactivate endpoint. See Open Questions if this needs
  revisiting.
- **Module 5 (Investment) was built before Module 6 (Cashier/Till/Vault)**,
  out of CLAUDE.md's suggested order (`... 5. Module 6 ... 6. Module 5
  ...`) — done on an explicit instruction to start Module 5 next, not a
  discovered dependency reason. Checked before starting: nothing in
  Module 5's actual functional requirements needs Module 6 to exist first
  (it needs a customer, a branch, and the shared GL/approval services, all
  already built) — the payout/redemption confirmation is a manual staff
  step precisely because neither Module 6's cashier/till flow nor real
  payments integration exist yet, see Open Questions. If Module 6 later
  wants investment payouts to actually run through a till, that's a
  genuine integration point to build then, not something this session
  blocked on.
- **Module 5's own "BEFORE YOU WRITE CODE" note references "Module 7"
  for the payments layer** (MoMo/bank payout) — same
  `SwiftCedi_Module_Build_Prompts.md` numbering inconsistency already
  flagged for Module 1 (see above): Module 7 in this document is "GL,
  Accounting & Financial Reporting," not payments, and no payments module
  exists in the prompt document at all — payments integration is only the
  Suggested Build Order's separate, undetailed step 7. Resolved the same
  way: GL posting in Module 5 uses the real `glPosting.js`/Module 7 GL
  built in this repo; the actual payments-rail question is answered by
  the manual-confirmation stub described in Open Questions, not by a
  nonexistent "Module 7 payments layer."
- **Module 6's data model expectations list `vault_balances` and a
  `deleted_transactions_log` table; neither was built.** "The vault
  balance" is already `branch_gl_accounts.vault_account_id`'s
  reconstructed GL balance, and every write already goes through the
  shared `audit_log` service with nothing ever hard-deleted — see the
  Cashier service section for the full reasoning. Building either as a
  literal, separate table would duplicate existing infrastructure this
  codebase deliberately consolidated.
- **`glPosting.js` (Module 7's shared interface) was extended twice
  during Module 6's build** rather than adding this logic inside
  `cashierService.js`: `reverseJournalEntry` and the prior-period-
  adjustment workflow (`requestPriorPeriodAdjustment` /
  `postApprovedPriorPeriodAdjustment`) both live at the shared-services
  layer because any module could need to reverse a posting or correct a
  locked period, not just cashier operations — same reasoning Module 1
  used when it added `registerExecutionHandler` to `approvalWorkflow.js`
  for branch closure rather than building a bespoke decide endpoint.
- **Module 9 (Analytics & Owner Dashboard) was built before Module 8
  (Regulatory & Compliance) and before payments integration**, out of
  CLAUDE.md's suggested order (`... 8. Module 8 ... 9. Module 9 ...`) —
  done on an explicit instruction to start Module 9 next, not a discovered
  dependency reason. Checked before starting: Module 9's own functional
  requirements (live stats, portfolio quality, profitability, growth
  trends, agent productivity, an executive report pack, dashboard configs)
  don't actually reference anything Module 8 or payments integration would
  own — they read from Modules 1-7's existing tables only. The module
  prompt's "build this last, after Modules 1-8 have real data flowing"
  note is a data-freshness recommendation (dashboards read better against
  real activity than empty tables), not a hard technical dependency, and
  this codebase already has real activity across every built module from
  its own integration test runs and any manual smoke-testing. If Module 8
  later needs its own analytics/report-pack section, that's a genuine
  extension to build then, not something this session blocked on.
