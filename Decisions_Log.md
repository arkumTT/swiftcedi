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

The `gl_accounts` table and `postJournalEntry()` interface are built
(Module 7 shared infra), but the actual chart-of-accounts numbering scheme
(code ranges per account type, per-branch sub-account pattern) is **not**
decided — that's Module 1's "auto-generate branch-specific GL sub-accounts"
requirement and should be settled when Module 1 is built, not guessed here.

| Code Range | Category | Notes |
|---|---|---|
| _TBD — Module 1_ | _TBD_ | `gl_accounts.account_type` enum itself is decided (see below); numbering scheme is not |

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
  validation) — see "Status Enums & Lifecycle States" below.
- Migrations live in `backend/src/db/migrations/`, named
  `NNN_description.sql`, applied in filename order and tracked in a
  `schema_migrations` table by `backend/src/db/migrate.js`. Each file is
  additive (no down-migrations for this build) — a wrong migration gets a
  new corrective migration, not an edited history.
- **`branches` is currently a stub** (`id, code, name, status,
  created_at, updated_at`), created in Module 11/7's migrations only so
  every other table can carry a real `branch_id` FK immediately. Module 1
  will `ALTER TABLE branches` to add `region_id`, `cluster_id`, `address`,
  `gps_lat`, `gps_lng`, `opening_date`, `operating_hours`, `licence_ref` —
  it must not `DROP`/recreate the table, since `users`, `gl_accounts`,
  `audit_log`, etc. already reference `branches.id`.
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
  `/audit-log`, `/approvals`, `/gl/accounts`, `/gl/journal-entries`.
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
| `branches.status` | `active`, `suspended`, `under_review`, `closed` | 1 (values taken from the Module 1 prompt's lifecycle; enforced now via a `branches` stub CHECK constraint since Module 11/7 needed the column to exist) |
| `users.status` | `active`, `suspended`, `disabled` | 11 |
| `gl_accounts.status` | `active`, `inactive` | 7 |
| `gl_accounts.account_type` | `asset`, `liability`, `equity`, `income`, `expense` | 7 |
| `gl_periods.period_type` | `month`, `year` | 7 |
| `gl_journal_entries.entry_type` | `standard`, `prior_period_adjustment` | 7 — only `prior_period_adjustment` may post into a locked period |
| `gl_journal_entries.status` | `posted`, `reversed` | 7 — a "reversed" entry keeps its original immutable lines; reversal is a separate new entry, never an edit |
| `approval_requests.status` | `pending`, `approved`, `rejected`, `cancelled` | 11 |

Follow this pattern for every future status column: app-layer values
documented here **and** a DB `CHECK` constraint enumerating the same
values (see migrations for examples) — never app-layer-only validation on
a status field.

---

## Shared Services (Module 11 / Module 7 interfaces)

_Exact function/endpoint signatures for the audit-log service, the
approval-workflow service, and the GL posting interface, once built —
every other module should call these, not reimplement them._

All three live under `backend/src/shared/` and take a `db` (a pg
Client/PoolClient/Pool) as their first argument — pass the **same client
your caller's transaction is running on** wherever you need the audit
entry (or approval decision) to commit/rollback atomically with the write
it's about. Every module MUST call these instead of writing to
`audit_log`, `approval_requests`, or `gl_journal_lines`/`gl_journal_entries`
directly — those tables also refuse direct-write shortcuts at the DB layer
(see "Deviations" below for what's DB-enforced vs. convention-only).

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
```
- `requestApproval` always creates a row (status `pending`); it does NOT
  decide for you whether approval is needed for this specific call — check
  `isApprovalRequired(await getApplicableThreshold(...), amount)` first if
  your module wants to skip the workflow below a threshold.
- `decide`'s `execute` callback runs only on `decision === 'approved'`, so
  the caller performs the authorized side effect (e.g. calling
  `glPosting.postJournalEntry`) from inside it — pass the same `db` client
  through so approval + side effect commit together.
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
  `gl.manage_accounts`, `gl.post_journal`, `gl.view_reports`. Add new codes
  via `POST /rbac/roles/:roleId/permissions`, not a new migration, unless
  you also need to seed a default grant.

---

## Branch Scoping Convention

_How `branch_id` is enforced across queries — e.g., middleware-level
scoping, row-level security, or application-layer filtering — decided
once and applied everywhere._

- Application-layer filtering (not Postgres row-level security) via
  `resolveBranchScope(req)` in `backend/src/middleware/requirePermission.js`.
- Default: every request is scoped to `req.user.homeBranchId`.
- Only roles in `CROSS_BRANCH_ROLES` (currently `owner`, `system_admin`)
  may override this with an explicit `?branchId=` query param. Any other
  role's `?branchId=` is silently ignored — they always get their own
  branch, so an API client can't escalate scope by editing the query
  string themselves.
- This mirrors the CLAUDE.md rule that permission/scope checks happen
  server-side, never trusting the frontend. Full cross-branch access
  grants (time-bound, revocable, per Module 1's staff-assignment spec) are
  NOT built yet — `CROSS_BRANCH_ROLES` is a role-level allowlist only, a
  placeholder until Module 1's `cross_branch_access_grants` table exists.
  Revisit this function when that lands.

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
