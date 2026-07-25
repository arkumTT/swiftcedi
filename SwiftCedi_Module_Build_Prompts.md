# SwiftCedi Banking Solution — Module Build Prompts

A ready-to-use prompt for each module in the SwiftCedi Framework & Roadmap document. Each prompt is written so it can be handed directly to an AI coding assistant (e.g., Claude Code) to produce a working implementation — data model, API, business logic, and UI — for that module.

## How to Use These Prompts

1. **Paste the Shared Project Context (Section 0) once** at the start of your build session, or keep it in a `CONTEXT.md` / `CLAUDE.md` file in your repo so every module build inherits it.
2. **Paste one module prompt at a time**, in the roadmap order (Branch → Customer → Loan → Savings/Susu → Cashier/Vault → Investment → Payments → Regulatory → Analytics → Agent Ops → RBAC → System Admin). Building in this order means each module's prompt can assume the previous ones already exist.
3. Each prompt ends with **"Before you write code"** — a checklist instruction that pushes the AI to clarify schema conflicts with earlier modules instead of guessing. Keep this line even if you trim other parts.
4. Treat each prompt as a starting brief, not a rigid spec — add specifics (exact GL account codes, exact BOG return formats, your actual repo structure) as they firm up.

---

## 0. Shared Project Context
*(Paste this before every module prompt below, or store it as persistent project context.)*

```
You are building SwiftCedi, a multi-branch microfinance banking management
platform for a licensed microfinance institution operating in Ghana.

STACK: Node.js (Express or Fastify) backend, PostgreSQL database, React
frontend. Role-based dashboards for: Owner/Executive, Branch Manager, Loan
Officer, Cashier/Teller, Field Agent, and Investor-facing views.

CORE ARCHITECTURAL RULE: Every account, loan, deposit, transaction, and GL
entry must carry a branch_id foreign key. Nothing is created "globally" —
it always belongs to a branch, even if head office is modeled as a branch
itself. Reports must be producible at branch level and consolidated
(region/cluster/head-office) level without manual reconciliation.

MONEY HANDLING: All monetary values are stored as integers in the lowest
currency unit (pesewas, i.e., GHS cents) to avoid floating-point rounding
errors. Never use floats for currency.

AUDIT RULE: Every write to a financial table (accounts, transactions, GL
entries, loan status changes) must produce an immutable audit log entry
recording user_id, timestamp, before/after state, and branch_id. Financial
records are never hard-deleted — use status/soft-delete flags with a
reason code.

APPROVAL RULE: Any action with financial or account-status impact above a
configurable threshold requires a maker-checker (dual-control) approval
workflow — the user who initiates an action cannot be the one who approves
it.

LOCALIZATION: Currency is Ghana Cedi (GHS). Dates use DD-MMM-YYYY display
format. Regulatory context is Bank of Ghana (BOG) and Ghana Revenue
Authority (GRA). Payment rails referenced elsewhere in the system include
MTN MoMo, Telecel Cash, GHIPSS Instant Pay, Paystack, and Hubtel.

CODE STYLE: Favor explicit, readable code over cleverness. Include input
validation at the API boundary. Write unit tests for business logic
(interest calculations, GL postings, approval state machines) alongside
the implementation, not as an afterthought.
```

---

## 1. Branch Creation & Management Module

```
Build the Branch Creation & Management module for SwiftCedi.

OBJECTIVE
Give head office the ability to create, configure, and monitor branches as
first-class entities, with every branch automatically wired into the
chart of accounts and cash-handling infrastructure on creation.

FUNCTIONAL REQUIREMENTS
- Branch setup wizard capturing: name, unique branch code, region/province,
  physical address, GPS coordinates, opening date, operating hours,
  licence/registration reference.
- On branch creation, auto-generate branch-specific GL sub-accounts:
  cash-in-hand, vault, income, expense — bound to the branch_id.
- Branch hierarchy: region -> cluster -> branch, with reports able to
  roll up at any level of the hierarchy.
- Staff assignment: loan officers, cashiers, tellers, and field agents are
  tied to a home branch, with an optional cross-branch access grant
  (time-bound, revocable) for staff covering multiple branches.
- Vault & till setup per branch: opening float amount, daily cash-handling
  limits, and denomination breakdown tracking.
- Branch performance dashboard: portfolio size, PAR, total deposits,
  headcount, cost-to-income ratio, profitability — viewable standalone or
  compared side-by-side against other branches.
- Branch status lifecycle: active -> suspended -> under-review -> closed.
  Moving to "closed" requires a mandatory GL-reconciliation approval step
  (zero cash-in-hand, zero vault balance, all customer accounts
  transferred out) before the transition is allowed.
- Branch-to-branch transfers: cash-in-transit records, corresponding GL
  transfer entries, and a workflow for moving a customer's accounts from
  one branch to another (with full history preserved).

DATA MODEL EXPECTATIONS
- `branches` table: id, code (unique), name, region_id, cluster_id,
  address, gps_lat, gps_lng, opening_date, operating_hours, licence_ref,
  status, created_at, updated_at.
- `branch_regions` / `branch_clusters` tables for the hierarchy.
- `branch_gl_accounts` linking branch_id to its cash-in-hand / vault /
  income / expense GL account IDs.
- `branch_staff_assignments` with home_branch_id, and a separate
  `cross_branch_access_grants` table with start/end dates.
- `branch_transfers` recording cash-in-transit amount, source/destination
  branch, status, and linked GL journal entry IDs.

API ENDPOINTS EXPECTED
CRUD for branches, regions, clusters; branch status transition endpoint
(with reconciliation check); staff assignment endpoints; branch
performance summary endpoint (accepts a date range and optional
comparison branch list); branch-to-branch transfer initiation and
confirmation endpoints.

BUSINESS RULES & EDGE CASES
- Branch code must be immutable once transactions exist against it.
- Closing a branch with a non-zero vault or cash-in-hand balance must be
  blocked with a clear error, not silently zeroed out.
- Cross-branch access grants must expire automatically and be logged.

BEFORE YOU WRITE CODE
Confirm the exact set of GL account types you're auto-generating per
branch against the chart-of-accounts structure the GL module (Module 6)
expects, so branch creation doesn't produce orphaned or mismatched GL
entries.
```

---

## 2. Customer & CRM Module

```
Build the Customer & CRM module for SwiftCedi.

OBJECTIVE
Provide a single source of truth for customer identity, relationships,
and history, feeding every other module (loans, savings, investments).

FUNCTIONAL REQUIREMENTS
- Customer onboarding for three types: individual, group, and SME — each
  with its own required-field set.
- KYC capture: Ghana Card number (with format validation), biometric
  reference (photo + optional fingerprint hash), passport-style photo,
  next-of-kin details.
- Group/community management: create a group, assign a group leader,
  attach members, and support group-level constraints used by group
  lending (Module 3) and susu (Module 4).
- Customer 360 view: a single screen aggregating a customer's accounts,
  loans, savings, susu participation, full transaction history, attached
  documents, and next-of-kin — pulled live from the other modules, not
  duplicated data.
- Customer segmentation/classification (e.g., by risk tier, product
  eligibility, susu classification) usable as a filter by other modules
  for targeted products or reporting.
- Account reactivation and closure workflow, with a mandatory closure
  reason code and a cooling-off/approval step before a closure is final.
- Credit reference/bureau lookup integration point — before loan
  disbursement, the system should call out to an external credit bureau
  API (stub this as an interface if no live bureau contract exists yet)
  and store the response against the customer record.

DATA MODEL EXPECTATIONS
- `customers` table: id, customer_type (individual/group/sme), branch_id
  (home branch), ghana_card_no, kyc_status, classification, created_at.
- `customer_documents` for photos, ID scans, signed agreements — store
  references/URLs, not blobs, in Postgres.
- `groups` and `group_members` tables, with group_leader_id.
- `next_of_kin` table linked to customer_id.
- `credit_bureau_lookups` storing request/response payloads and
  timestamps per customer.
- `account_closures` with reason_code, requested_by, approved_by,
  closure_date.

API ENDPOINTS EXPECTED
Customer CRUD (type-aware validation); group CRUD and membership
management; customer-360 aggregation endpoint; classification
assignment endpoint; closure request/approval endpoints; credit bureau
lookup trigger endpoint.

BUSINESS RULES & EDGE CASES
- A customer cannot be deleted once any account, loan, or transaction
  exists — only deactivated with a reason.
- Group members should be individually KYC'd even though they borrow
  under a group structure.
- Ghana Card number should be unique across active customers but allow
  re-registration checks against closed accounts (fraud prevention).

BEFORE YOU WRITE CODE
Confirm with the Branch module how "home branch" on a customer interacts
with the branch-to-branch transfer workflow (Module 1), since moving a
customer between branches touches both modules.
```

---

## 3. Loan Management Module

```
Build the Loan Management module for SwiftCedi.

OBJECTIVE
Support the full loan lifecycle for individual loans, group loans, and
overdrafts, with configurable products, an appraisal-to-disbursement
workflow, and delinquency management that feeds portfolio-at-risk (PAR)
reporting.

FUNCTIONAL REQUIREMENTS
- Full lifecycle: application -> appraisal (with a structured checklist)
  -> approval workflow (maker-checker) -> disbursement -> repayment
  schedule generation -> repayment posting -> closure or write-off.
- Support individual loans, group loans (linked to Module 2's group
  structure, with joint-liability rules), and overdrafts (linked to a
  savings account, Module 4).
- Loan products configuration: interest calculation method (flat vs.
  reducing balance), interest periods, fee schedule, PAR bucket
  parameters, and a configurable list of loan-purpose/reason codes.
- Loan calculator usable both by staff (pre-appraisal) and customer-facing
  (self-service estimate, no commitment).
- Restructuring/rescheduling workflow: allow a distressed loan's schedule
  to be regenerated with a new term/rate, preserving the original
  schedule and all prior repayment history for audit.
- Delinquency/arrears management: automatic aging into configurable
  buckets (e.g., 1-30, 31-60, 61-90, 90+ days), driving PAR calculations
  consumed by the Analytics module (Module 9).
- Collateral/guarantor tracking: attach one or more collateral items or
  guarantors to a loan, each with its own valuation/verification status.

DATA MODEL EXPECTATIONS
- `loan_products` table: interest method, rate, fee structure, PAR
  buckets, allowed reason codes.
- `loans` table: id, customer_id or group_id, branch_id, product_id,
  principal_amount (integer, lowest unit), status, disbursement_date.
- `loan_appraisals` storing checklist responses and appraiser_id.
- `loan_approvals` implementing maker-checker (requested_by, approved_by,
  cannot be the same user).
- `loan_schedules` and `loan_repayments` — repayments never overwrite
  schedule rows; they post against them.
- `loan_restructures` linking an old schedule to a new one.
- `loan_collateral` and `loan_guarantors`.

API ENDPOINTS EXPECTED
Product CRUD; application submission; appraisal submission; approval
action endpoint (enforces maker != checker); disbursement endpoint
(triggers GL posting into Module 6); repayment posting endpoint;
restructure endpoint; arrears/aging report endpoint; collateral and
guarantor CRUD.

BUSINESS RULES & EDGE CASES
- Reducing-balance interest recalculation must handle early/partial/late
  payments without drifting from the original schedule's total interest
  assumptions — write unit tests for this specifically.
- A loan cannot be disbursed until both appraisal and approval are
  complete, and the approving user must differ from the requesting user.
- Group loans need a rule for how one member's default affects the
  group's ability to access further group credit.

BEFORE YOU WRITE CODE
Confirm the exact GL account mapping for disbursement and repayment
postings with Module 6 (loan principal, interest income, fee income
accounts) before wiring the disbursement endpoint.
```

---

## 4. Savings, Susu & Deposits Module

```
Build the Savings, Susu & Deposits module for SwiftCedi.

OBJECTIVE
Support standard savings accounts and susu (daily/periodic informal
collection) products, including field-agent collection and commission
tracking.

FUNCTIONAL REQUIREMENTS
- Standard savings accounts with a configurable charges schedule
  (maintenance fees, withdrawal fees, minimum balance charges).
- Susu-specific functionality: daily collection rounds run by a field
  agent, agent-collected deposits recorded against the customer's susu
  account, agent commission calculation and tracking, and a status split
  between "completed" susu accounts (cycle finished, payout due) and
  "uncompleted" ones.
- Standing orders: recurring scheduled deposits/transfers configured by
  the customer or staff, executed automatically by the scheduler
  (Module 12).
- Withdrawal workflow with configurable approval thresholds — small
  withdrawals process immediately, larger ones require supervisor
  approval before the cashier can pay out.

DATA MODEL EXPECTATIONS
- `savings_products` and `savings_accounts` (branch_id, customer_id,
  balance in lowest currency unit, charges_config).
- `susu_accounts` linked to a customer, with cycle_length,
  target_amount, status (active/completed/uncompleted).
- `susu_collections` recording each field visit: agent_id, amount,
  collection_date, gps location if available.
- `susu_commissions` calculated per collection or per cycle, linked to
  the agent.
- `standing_orders` with frequency, next_run_date, source/destination
  account.
- `withdrawal_requests` with amount, threshold_flag, approver_id.

API ENDPOINTS EXPECTED
Savings account CRUD and charge application; susu account CRUD, deposit
recording endpoint (agent-facing, ideally offline-tolerant), cycle
completion/payout endpoint; standing order CRUD; withdrawal request and
approval endpoints.

BUSINESS RULES & EDGE CASES
- Susu deposit recording must tolerate agents working in low-connectivity
  areas — design the deposit endpoint to accept a client-generated
  idempotency key so retried submissions don't double-post.
- Withdrawal threshold should be configurable per branch or per product,
  not hardcoded.
- Standing orders that fail (insufficient funds) should retry on a
  configurable schedule and notify the customer, not fail silently.

BEFORE YOU WRITE CODE
Confirm with Module 10 (Agent & Field Operations) how agent_id on a susu
collection ties into that module's agent reconciliation process, so the
same collection record isn't reconciled twice under different logic.
```

---

## 5. Investment Module

```
Build the Investment Module for SwiftCedi.

OBJECTIVE
Manage fixed-term investment/deposit products for investors, including
profit accrual, payout scheduling, and electronic redemption.

FUNCTIONAL REQUIREMENTS
- Book new investment/fixed-deposit products with configurable tenor and
  interest rate.
- Investor profit/interest accrual running on a schedule (daily or
  periodic accrual job feeding the scheduler in Module 12), with payout
  scheduling (monthly, at maturity, etc.).
- Pending-approval queue for new investments and disinvestments —
  maker-checker before funds move.
- Investor statements: a point-in-time and historical statement showing
  principal, accrued interest, and payout history.
- ePayout/redemption workflow for electronic payouts to investors,
  integrating with the payments layer (Module 7) for MoMo/bank payout.

DATA MODEL EXPECTATIONS
- `investment_products` (tenor, rate, minimum amount, early-withdrawal
  penalty rules).
- `investments` (investor/customer_id, branch_id, product_id, principal,
  start_date, maturity_date, status).
- `investment_accruals` recording daily/periodic interest accrual entries
  (immutable, one row per accrual event).
- `investment_payouts` and `investment_redemptions`, each with a
  maker-checker approval trail and a link to the payment transaction
  reference once executed.

API ENDPOINTS EXPECTED
Product CRUD; investment booking endpoint; accrual job endpoint (called
by the scheduler); approval endpoints for new investments and
disinvestments; investor statement generation endpoint; redemption
initiation and confirmation endpoints.

BUSINESS RULES & EDGE CASES
- Early withdrawal before maturity should apply the product's configured
  penalty and recalculate accrued interest accordingly — write this as
  an explicit, tested rule rather than an ad hoc adjustment.
- Redemption should never mark an investment "paid out" until the
  payment layer confirms the transfer succeeded — use a pending ->
  confirmed status, not an optimistic update.

BEFORE YOU WRITE CODE
Confirm the payout mechanism (which payment rail, and whether payouts
route through Module 7's payments layer or a manual cashier process)
before building the redemption endpoint, since the confirmation
callback contract differs between the two.
```

---

## 6. Cashier, Till & Vault Operations Module

```
Build the Cashier, Till & Vault Operations module for SwiftCedi.

OBJECTIVE
Manage physical cash handling at branch level: till and vault balances,
day-open/close processes, and transaction reversal/audit handling.

FUNCTIONAL REQUIREMENTS
- Cashier till setup: opening balance, assigned cashier, denomination
  breakdown; closing balance reconciliation at end of shift.
- Start-of-day / end-of-day / end-of-month / end-of-year close-out
  processes, each producing a locked snapshot that later periods cannot
  silently alter.
- Cash-back requests (cashier requesting additional float from the
  vault), reversed-transaction handling (with a reason code and
  approver), and a deleted-transaction audit log (soft-delete only,
  never hard-delete a financial transaction).
- Live cash position per branch (till + vault) and consolidated across
  all branches, viewable in near real time.

DATA MODEL EXPECTATIONS
- `cashier_tills` (branch_id, cashier_id, opening_balance,
  closing_balance, status: open/closed).
- `vault_balances` per branch, updated by cash-back requests and
  branch-to-branch transfers (Module 1).
- `day_close_snapshots` (branch_id, period_type: day/month/year, closed_
  by, closed_at, locked flag).
- `cash_back_requests`, `transaction_reversals` (original_txn_id, reason_
  code, approved_by), and `deleted_transactions_log`.

API ENDPOINTS EXPECTED
Till open/close endpoints; cash-back request and approval endpoints;
reversal request and approval endpoints; day/month/year close-out
endpoints (each validating all tills for the branch are closed first);
live cash position endpoint (branch and consolidated).

BUSINESS RULES & EDGE CASES
- End-of-day close should be blocked if any till in the branch is still
  open, with a clear list of which tills are outstanding.
- A reversal must never simply delete the original transaction — it
  posts an offsetting entry and links both records together.
- Once a period is closed (day_close_snapshots.locked = true), no new
  transaction should be postable into that period; late corrections go
  through a distinct back-dated adjustment workflow with extra approval.

BEFORE YOU WRITE CODE
Confirm with Module 6's GL counterpart (Section 6 in the framework doc,
"GL, Accounting & Financial Reporting") exactly which GL accounts a
till-close and vault movement post to, so cash operations and the
general ledger never drift out of sync.
```

---

## 7. GL, Accounting & Financial Reporting Module

```
Build the GL, Accounting & Financial Reporting module for SwiftCedi.

OBJECTIVE
Provide the double-entry general ledger backbone that every other
financial module posts into, plus the standard financial statements.

FUNCTIONAL REQUIREMENTS
- Full chart of accounts management (create/edit/deactivate GL accounts,
  assign account types: asset/liability/equity/income/expense) and GL
  description assignment.
- Balance sheet, income statement, and trial balance reports — both
  current (as-of-today) and historical (as-of-any-past-date).
- GL daily balance summaries, end-of-year transaction reports, and a
  GL-to-customer-account reconciliation report (proving subledger totals
  match GL control accounts).
- Bank reconciliation module for matching SwiftCedi's own bank accounts
  against statements.
- Batch posting and journal voucher (JV) transfers for manual/corrective
  entries, always double-entry and always balanced (debits = credits).

DATA MODEL EXPECTATIONS
- `gl_accounts` (code, name, type, branch_id nullable for
  head-office-level accounts, parent_account_id for hierarchy).
- `gl_journal_entries` (header: date, reference, created_by, approved_by)
  and `gl_journal_lines` (account_id, debit, credit — every entry's lines
  must sum to zero).
- `gl_periods` for month/year locking, referenced by Module 6's day-close
  snapshots.
- A `postings` interface/contract that every other module (Loan, Savings,
  Investment, Cashier) calls into rather than writing to gl_journal_lines
  directly — enforce this as the only path to the ledger.

API ENDPOINTS EXPECTED
Chart of accounts CRUD; JV entry creation (validated balanced) and
approval; balance sheet / income statement / trial balance report
endpoints (accepting as-of date and branch/consolidated scope); GL
reconciliation report endpoint; bank reconciliation matching endpoint.

BUSINESS RULES & EDGE CASES
- Reject any journal entry where debit total != credit total, at the
  database or application layer — never allow an unbalanced entry to
  post.
- Historical reports must reconstruct balances as of the requested date
  from journal_lines, not from a mutable running-balance column, so
  restated history stays accurate after corrections.
- Once a GL period is locked, only a distinct "prior-period adjustment"
  entry type (clearly flagged in reports) can affect it.

BEFORE YOU WRITE CODE
Design the shared posting interface first, and get it right, since every
other module (Loan, Savings, Investment, Cashier, Branch) depends on
calling into it correctly — a change here after other modules are built
means retrofitting all of them.
```

---

## 8. Regulatory & Compliance Reporting Module

```
Build the Regulatory & Compliance Reporting module for SwiftCedi.

OBJECTIVE
Produce the statutory reports a licensed Ghanaian microfinance
institution must submit, and monitor for AML/CFT red flags, without
requiring a code release every time a report format changes.

FUNCTIONAL REQUIREMENTS
- Bank of Ghana prudential returns: capital adequacy ratio, liquidity
  ratio, and loan classification/provisioning (per BOG's loan
  classification categories — current, OLEM, substandard, doubtful,
  loss), calculated from live loan and GL data.
- GRA tax reporting: withholding tax on investor interest payouts, and
  VAT where applicable to fee income.
- Configurable regulatory report templates — an admin-editable
  template/field-mapping system so report layout and required fields can
  be adjusted without a code deployment when a regulator changes a form.
- Social performance/outreach reporting (e.g., number of active
  borrowers, average loan size, outreach to underserved segments) for
  donor or investor reporting where applicable.
- AML/CFT monitoring: configurable transaction-threshold rules that flag
  transactions for review, and a sanctions-list screening check run
  against customer records at onboarding and periodically thereafter.

DATA MODEL EXPECTATIONS
- `regulatory_report_templates` (name, target_authority, field_mappings
  as JSON, version, effective_date) — reports are generated by mapping
  live data through this template, not hardcoded per-report code.
- `regulatory_report_submissions` (template_id, period, generated_at,
  submitted_by, file_reference) for audit history of what was actually
  submitted.
- `loan_classifications` recomputed periodically from loan aging data
  (Module 3) per BOG category rules.
- `aml_flags` (transaction_id or customer_id, rule_triggered, status:
  open/reviewed/cleared, reviewed_by).
- `sanctions_screening_results` per customer, with screening_date and
  match_status.

API ENDPOINTS EXPECTED
Template CRUD (admin-only); report generation endpoint (accepts
template_id + period, returns populated report); AML rule configuration
CRUD; AML flag review/clear endpoint; sanctions screening trigger
endpoint (manual and batch/scheduled).

BUSINESS RULES & EDGE CASES
- Loan classification thresholds (days-past-due boundaries for each BOG
  category) must be configurable, since regulatory guidance can change.
- An AML flag must never be auto-cleared by the system — it always
  requires a human reviewer action, logged with reviewer identity and
  rationale.
- Report templates should be versioned so a report generated last year
  can be regenerated using the template version that was active then.

BEFORE YOU WRITE CODE
Confirm which specific BOG return formats and thresholds are current, as
regulatory formats and provisioning rules change; do not hardcode
assumptions from general knowledge — flag any figures that need
verification against the current BOG guidelines with SwiftCedi's
compliance officer before going live.
```

---

## 9. Analytics & Owner Dashboard Module

```
Build the Analytics & Owner Dashboard module for SwiftCedi.

OBJECTIVE
Turn the operational data produced by every other module into a
role-aware, real-time insight layer for ownership, branch managers, and
loan officers — this module reads from other modules' data, it does not
own primary transactional data itself.

FUNCTIONAL REQUIREMENTS
- Live stats: current cash position, non-cash transaction volume, today's
  disbursements/collections, and a branch snapshot grid.
- Portfolio quality: PAR at 30/60/90 days, loan portfolio-at-risk detail
  drill-down, largest exposures list, and aging analysis — sourced from
  Module 3's loan schedules and aging buckets.
- Profitability: loan customer profitability, cost-to-income ratio,
  operational self-sufficiency ratio, and branch-level P&L — sourced from
  Module 6's GL data joined to branch_id.
- Growth trends: customer recruitment per year, disbursement trend,
  deposit growth, and sector analysis over configurable time ranges.
- Agent/loan officer productivity: per-agent portfolio size, collection
  rate, and call-over reports.
- A consolidated executive report pack (balance sheet, P&L, portfolio
  summary, social performance) generated on demand as a single exportable
  document.
- Configurable dashboard widgets per role: the Owner role sees every
  branch and metric; a Branch Manager's dashboard is scoped to their
  branch by default; a Loan Officer's dashboard is scoped to their own
  loan book.

DATA MODEL EXPECTATIONS
- This module should be primarily read/aggregation logic (materialized
  views or scheduled aggregation jobs) over other modules' tables — avoid
  duplicating source-of-truth data.
- `dashboard_widget_configs` (role, widget_key, position, visible) for
  per-role customization.
- Consider a `daily_metrics_snapshot` table populated by a scheduled job
  (Module 12) so dashboards load fast without recomputing heavy
  aggregates on every page view.

API ENDPOINTS EXPECTED
Live stats endpoint (branch-scoped and consolidated); portfolio quality
endpoint with drill-down parameters; profitability endpoint; growth
trend endpoint (accepts date range); agent productivity endpoint;
executive report pack generation endpoint; dashboard config CRUD.

BUSINESS RULES & EDGE CASES
- All figures shown must reconcile to the underlying module's own reports
  (e.g., the dashboard's "today's disbursements" must always match
  Module 3's disbursement log for the same day) — treat any discrepancy
  as a bug, not a rounding artifact.
- Role scoping must be enforced at the query layer, not just hidden in
  the UI — a Loan Officer's API calls should be incapable of returning
  another officer's book even if they inspect network requests.

BEFORE YOU WRITE CODE
Build this module last, after Modules 1-8 have real data flowing through
them, so the dashboards are validated against actual operational data
rather than placeholder figures.
```

---

## 10. Agent & Field Operations Module

```
Build the Agent & Field Operations module for SwiftCedi.

OBJECTIVE
Manage field agents (susu collectors, loan officers doing field visits)
including assignment, live location tracking, and end-of-day
reconciliation against cashier records.

FUNCTIONAL REQUIREMENTS
- Field agent assignment and reassignment across branches, with a clear
  history of which agent covered which territory/customers over time.
- Live agent tracking (GPS-based) for susu/loan collection agents,
  showing current or last-known location on a map view for supervisors.
- Agent transaction reconciliation: at end of day, each agent's
  field-collected transactions (from Module 4's susu_collections and any
  field loan repayments) must be matched against what the branch cashier
  actually received and banked, flagging discrepancies.

DATA MODEL EXPECTATIONS
- `field_agents` (linked to a staff/user record, home_branch_id,
  territory description).
- `agent_assignments` history table (agent_id, branch_id/territory,
  start_date, end_date).
- `agent_locations` (agent_id, lat, lng, recorded_at) — expect frequent
  writes; design for a rolling retention window rather than infinite
  history.
- `agent_reconciliations` (agent_id, date, expected_amount [sum of
  field-collected transactions], received_amount [what the cashier
  banked], variance, status, reviewed_by).

API ENDPOINTS EXPECTED
Agent CRUD and assignment history endpoint; location ping endpoint
(agent-facing, should be lightweight and tolerant of intermittent
connectivity); current-location and location-history endpoints
(supervisor-facing); end-of-day reconciliation run endpoint (computes
expected vs. received and flags variances).

BUSINESS RULES & EDGE CASES
- A variance in end-of-day reconciliation should never auto-resolve — it
  routes to a supervisor review queue.
- Location tracking should respect a reasonable ping interval (e.g., not
  more often than every few minutes) to control mobile data costs for
  agents working with limited connectivity.

BEFORE YOU WRITE CODE
Confirm with Module 4 (Savings, Susu & Deposits) the exact join key
between susu_collections.agent_id and this module's field_agents table,
since the same collection event is the input to two different
reconciliation processes (susu cycle completion and agent cash
reconciliation) and they must never double-count or contradict each
other.
```

---

## 11. User, Role & Access Management Module

```
Build the User, Role & Access Management module for SwiftCedi.

OBJECTIVE
Provide fine-grained, auditable access control across every other
module, including maker-checker enforcement and time-windowed access.

FUNCTIONAL REQUIREMENTS
- Role-based access control down to individual feature level (not just
  broad roles) — every menu item / API capability across all modules
  should be independently toggleable per role.
- Transaction approver roles and configurable approval thresholds,
  enforcing maker-checker on disbursements, GL entries, and account
  closures (the approving user must differ from the requesting user).
- Ability to assign specific users to restricted accounts (VIP or
  sensitive customer accounts visible only to named staff) and to assign
  GL account access to specific users.
- Role-based access time windows — e.g., a cashier role can be restricted
  to only transact during configured business hours.
- A full audit trail of user actions across the system: who did what,
  when, from where, and what changed.

DATA MODEL EXPECTATIONS
- `roles`, `permissions` (one row per fine-grained capability, e.g.,
  "loan.disburse", "gl.post_journal", "branch.close"), and a
  `role_permissions` join table.
- `users` with role_id, home_branch_id, and status.
- `approval_thresholds` (action_type, amount_threshold, required_
  approver_role).
- `restricted_account_access` (account_id, user_id) for named-user-only
  visibility.
- `access_time_windows` (role_id, allowed_days, start_time, end_time).
- `audit_log` (user_id, action, entity_type, entity_id, before_state,
  after_state, ip_address, timestamp) — this table is written to by
  every other module, so design it as a shared service/interface early.

API ENDPOINTS EXPECTED
Role and permission CRUD; user CRUD and role assignment; approval
threshold configuration; restricted account access grant/revoke;
access time window configuration; audit log query endpoint (filterable
by user, entity, date range).

BUSINESS RULES & EDGE CASES
- Permission checks must happen server-side on every request, never
  relying on the frontend hiding a button.
- The maker != checker rule must be enforced at the database or service
  layer for every approval-gated action across all modules — this module
  should expose a single reusable "requestApproval / approve" service
  that other modules call rather than each module reimplementing it.
- Time-window restrictions should fail gracefully with a clear message,
  not a generic error, when a user attempts an out-of-window action.

BEFORE YOU WRITE CODE
Design the shared audit-log and approval-workflow services first and
treat them as infrastructure every other module (Loan, Savings,
Investment, Branch, GL) depends on — this module should be built early
and in parallel with Module 7 (GL), not last, even though it's numbered
here for narrative order.
```

---

## 12. System Administration Module

```
Build the System Administration module for SwiftCedi.

OBJECTIVE
Provide the operational scaffolding that keeps the platform running:
scheduled jobs, data lifecycle management, and calendar configuration.

FUNCTIONAL REQUIREMENTS
- A scheduler for automated jobs: interest accrual (feeds Modules 3 and
  5), end-of-day/end-of-month/end-of-year triggers (feeds Module 6), and
  reminder notifications (repayment due, susu collection due).
- Data cleanup and archiving: move old/closed records to an archive
  store on a configurable retention policy, without breaking historical
  reporting (Module 7's historical reports must still resolve archived
  data).
- Database backup/restore tooling, and a backup-to-Excel export for
  non-technical staff who need an offline copy of key tables.
- Working-days/holiday calendar configuration, consumed by loan schedule
  generation (Module 3) and standing order execution (Module 4) so
  due-dates correctly skip non-business days.
- Subscription/licence renewal tracking, in case SwiftCedi later offers
  this platform as SaaS to other MFIs.

DATA MODEL EXPECTATIONS
- `scheduled_jobs` (job_type, cron_expression, last_run_at, last_status,
  next_run_at).
- `job_run_history` for observability/debugging of scheduled job
  executions.
- `archive_policies` (entity_type, retention_period, archive_location).
- `working_calendar` (date, is_working_day, holiday_name).
- `subscription_licences` if/when SaaS multi-tenancy is introduced.

API ENDPOINTS EXPECTED
Scheduled job CRUD and manual trigger endpoint (for testing/support);
job run history query endpoint; archive policy CRUD and manual archive-
run trigger; backup trigger and backup-to-Excel export endpoints;
working calendar CRUD.

BUSINESS RULES & EDGE CASES
- A failed scheduled job (e.g., interest accrual didn't run) must alert
  an administrator, not fail silently — missed accrual runs compound
  into real financial discrepancies.
- Archiving must never archive a record still referenced by an open
  workflow (e.g., a loan under active repayment) — validate before
  archiving, not after.
- Calendar changes should not retroactively alter already-generated loan
  schedules; they apply going forward only, unless a rebuild is
  explicitly requested through Module 3's restructuring workflow.

BEFORE YOU WRITE CODE
Confirm which jobs are truly system-wide (belong here) versus
module-specific business logic that merely runs on a schedule (e.g.,
interest accrual math belongs in Module 3/5, not here) — this module
should own the scheduling infrastructure, not the financial calculations
themselves.
```

---

## Suggested Build Order

Matching the roadmap's dependency chain:

1. Shared Project Context + Module 11 (RBAC/Audit) + Module 7 (GL) — build these two in parallel first as shared infrastructure.
2. Module 1 (Branch)
3. Module 2 (Customer & CRM)
4. Module 3 (Loan) and Module 4 (Savings/Susu) — can run in parallel once Module 2 is stable
5. Module 6 (Cashier/Till/Vault)
6. Module 5 (Investment)
7. Payments integration (from the Additional Recommended Features list — not detailed as its own prompt above, but needed before Module 5's ePayout and Module 4's withdrawal flows are fully live)
8. Module 8 (Regulatory & Compliance)
9. Module 9 (Analytics & Owner Dashboard) — build last, once real data exists
10. Module 10 (Agent & Field Ops)
11. Module 12 (System Administration)
