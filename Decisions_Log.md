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
| 1000-1999 | Asset | `1000` Cash in Hand, `1010` Vault Cash, `1020` Cash in Transit, `1100` Loans Receivable (Module 3) |
| 2000-2999 | Liability | None seeded yet — no module has needed one |
| 3000-3999 | Equity | None seeded yet |
| 4000-4999 | Income | `4000` Operating Income, `4010` Loan Interest Income (Module 3), `4020` Loan Fee Income (Module 3) |
| 5000-5999 | Expense | `5000` Operating Expense, `5100` Loan Loss Expense (Module 3) |

Branch sub-account pattern: on branch creation, `branchService.createBranch()`
auto-generates a sub-account per control account (8 as of Module 3:
cash-in-hand, vault, income, expense, loans-receivable,
loan-interest-income, loan-fee-income, loan-loss-expense) coded
`<control_code>.<branch_code>` (e.g. `1000.NRA-01`), each with
`branch_id` = the new branch and `parent_account_id` = the matching
org-wide control row — so a consolidated report can roll sub-accounts up to
their control account by `parent_account_id`, and a branch report can
filter `gl_accounts.branch_id`. **This is why branch codes are capped at 10
characters** (enforced by `branches_code_shape_chk` and
`branchService.validateBranchCode()`) — the composed code must fit
`gl_accounts.code`'s `VARCHAR(20)`.

Liability/equity control accounts aren't seeded yet — add them (and this
row) when a module first needs one (e.g. Module 4 for a customer-deposits
liability control, or Module 5 for investor equity).

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
  `gl_journal_lines`, `loan_repayments`) need `TRUNCATE`, since their
  triggers block plain `DELETE`.
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
  `/loans/:id/collateral`, `/loans/:id/guarantors`.
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
| `gl_journal_entries.status` | `posted`, `reversed` | 7 — a "reversed" entry keeps its original immutable lines; reversal is a separate new entry, never an edit |
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
  `loan.view_reports`. Add new codes via
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
applyForLoan(pool, { customerId, productId, principalPesewas, termMonths, reasonCode, appliedBy }) -> loan
submitAppraisal(pool, { loanId, checklist, recommendation, appraiserId }) -> { appraisal, loan }
requestLoanApproval(pool, { loanId, requestedBy }) -> approval_request
disburseLoan(pool, { loanId, disbursedBy, disbursementDate }) -> loan + { feesPesewas, netCashPesewas, journalEntry }
postRepayment(pool, { loanId, amountPesewas, paymentDate, receivedBy }) -> { components, loanClosed, journalEntry }
requestRestructure(pool, { loanId, newTermMonths, newAnnualInterestRateBps, reason, requestedBy }) -> restructure + approvalRequest
writeOffLoan(pool, { loanId, reason, writtenOffBy }) -> loan + journalEntry
getArrearsReport(pool, { branchId, asOfDate }) -> { loans, totals: { buckets, parRatio } }
findGroupCreditBlockers(db, groupCustomerId) -> blocking members
registerLoanExecutionHandlers()  // 'loan.approve' + 'loan.restructure'
```

**GL mapping — the contract every other module should read before posting
anything loan-related** (all via `glPosting.postJournalEntry`, never
direct writes):

| Event | Debit | Credit |
|---|---|---|
| Disbursement | Loans Receivable `principal` | Cash in Hand `principal - fees`; Loan Fee Income `fees` |
| Repayment | Cash in Hand `amount` | Loans Receivable `principal component`; Loan Interest Income `interest component`; Loan Fee Income `fee component` |
| Write-off | Loan Loss Expense `outstanding principal` | Loans Receivable `outstanding principal` |

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
- [ ] **Overdraft loans are not implemented.** `overdraft` is a valid
      `loan_type` in the enum (the spec lists it), but nothing supports
      it: an overdraft is drawn against a savings account, and Module 4
      (Savings/Susu) doesn't exist yet. `applyForLoan()` will happily
      create one and it will amortize like a term loan, which is NOT
      overdraft behavior. Either build it properly with Module 4 or
      reject `overdraft` at the application boundary until then.
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
      approval requests) — decide the real bands with the business.

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
- **Customer `status: 'closed'` has no reactivation path**, unlike
  `branches.status: 'closed'` where the parallel doesn't even apply (both
  are terminal). This wasn't specified either way in the Module 2 prompt;
  chosen for consistency with the branch closure precedent and because
  "unclosing" a customer account is a big enough decision to deserve its
  own explicit workflow if it's ever needed, not a side effect of the
  existing reactivate endpoint. See Open Questions if this needs
  revisiting.
