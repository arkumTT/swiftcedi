-- Module 12: System Administration. Per the module prompt's own "BEFORE
-- YOU WRITE CODE" instruction, this module owns SCHEDULING
-- INFRASTRUCTURE, not the financial calculations that run on a schedule
-- — interest accrual math stays in Module 3/5, close-out logic stays in
-- Module 6, standing-order execution stays in Module 4. Every job this
-- module's scheduler runs is a thin wrapper calling an EXISTING function
-- in the module that actually owns that business logic.

-- Working-days/holiday calendar. `is_working_day` on an explicit row
-- OVERRIDES the default Mon-Fri banking week (calendarMath.js) —
-- absent a row for a date, Sat/Sun default to non-working and every
-- other day defaults to working. This default is an operational
-- convention, not a BOG rule, and is fully overridable via data (e.g. a
-- branch that opens on a particular Saturday, or a public holiday that
-- falls on a weekday). "Calendar changes should not retroactively alter
-- already-generated loan schedules" (module prompt's own rule) is
-- satisfied structurally: the calendar is only ever consulted at
-- schedule/next-run-date GENERATION time (loanService.disburseLoan /
-- applyRestructureOnApproval, standingOrderService.executeOrder), never
-- via a retroactive update to existing loan_schedules/standing_orders
-- rows.
CREATE TABLE working_calendar (
  id BIGSERIAL PRIMARY KEY,
  calendar_date DATE NOT NULL UNIQUE,
  is_working_day BOOLEAN NOT NULL,
  holiday_name TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON working_calendar (calendar_date);

-- job_type is validated at the application layer against
-- systemAdminService.JOB_REGISTRY (same "free-form but validated against
-- a code-level registry" pattern as Module 9's dashboard_widget_configs.
-- widget_key), so new job types can be added by extending the registry,
-- without a migration. `run_as_user_id` is required rather than
-- inventing a fake "system" user account: every underlying module
-- function this job calls (accrueOverdraftInterest, accrueInterest,
-- closeOutPeriod, executeDueOrders, ...) requires a real, auditable
-- user id for its own created_by/accruedBy/closedBy/executedBy
-- parameter, so a scheduled job runs "as" whichever admin configured it
-- — the audit trail then correctly attributes the automated action to a
-- real accountable person, not a phantom system identity.
CREATE TABLE scheduled_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type VARCHAR(60) NOT NULL,
  cron_expression VARCHAR(60) NOT NULL,
  run_as_user_id BIGINT NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_run_at TIMESTAMPTZ,
  last_status VARCHAR(20),
  next_run_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_jobs_status_chk CHECK (status IN ('active', 'paused')),
  CONSTRAINT scheduled_jobs_last_status_chk CHECK (last_status IS NULL OR last_status IN ('success', 'failed'))
);

CREATE INDEX ON scheduled_jobs (job_type);
CREATE INDEX ON scheduled_jobs (status);

-- Observability/debugging for every job execution — manual triggers
-- (scheduled_job_id NULL, triggered_by the calling admin) and real
-- scheduled runs both write here, so "did the job actually run" is
-- always answerable from one table. A failed run is always recorded
-- with its error here (module prompt's "must never fail silently") —
-- there is no live alerting/paging integration to actually push a
-- notification about it (no SMS/email gateway exists in this codebase
-- yet, same gap as reminder_notifications below), so today "not fail
-- silently" means "always queryable here," not "proactively pages
-- someone." See Decisions_Log.md.
CREATE TABLE job_run_history (
  id BIGSERIAL PRIMARY KEY,
  scheduled_job_id BIGINT REFERENCES scheduled_jobs(id),
  job_type VARCHAR(60) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  result_summary JSONB,
  error_message TEXT,
  triggered_by BIGINT REFERENCES users(id),
  CONSTRAINT job_run_history_status_chk CHECK (status IN ('running', 'success', 'failed'))
);

CREATE INDEX ON job_run_history (job_type);
CREATE INDEX ON job_run_history (status);
CREATE INDEX ON job_run_history (scheduled_job_id);

-- Archive policies + the archived-record log. Deliberately does NOT
-- physically relocate rows to a separate store — "Module 7's historical
-- reports must still resolve archived data" (module prompt's own
-- business rule) is satisfied trivially by never moving anything: a
-- "closed" loan/savings account is already terminal and already
-- soft-deleted in place (CLAUDE.md's own "status/soft-delete flags,
-- never hard-deleted" rule), so "archiving" here means marking
-- `archived_at` on the row (a lightweight, reversible marker) and
-- logging the sweep, not exporting to cold storage. `archive_location`
-- is a descriptive/config field for when a real cold-storage export is
-- built — see Decisions_Log.md Open Questions.
CREATE TABLE archive_policies (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(40) NOT NULL,
  retention_period_days INT NOT NULL,
  archive_location VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT archive_policies_entity_type_chk CHECK (entity_type IN ('closed_loans', 'closed_savings_accounts')),
  CONSTRAINT archive_policies_status_chk CHECK (status IN ('active', 'inactive')),
  CONSTRAINT archive_policies_retention_chk CHECK (retention_period_days > 0),
  UNIQUE (entity_type)
);

CREATE TABLE archived_records (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(40) NOT NULL,
  entity_id BIGINT NOT NULL,
  policy_id BIGINT NOT NULL REFERENCES archive_policies(id),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archive_location VARCHAR(200) NOT NULL,
  UNIQUE (entity_type, entity_id)
);

CREATE INDEX ON archived_records (entity_type);

-- Nullable marker on the two initial archivable entity types — set once
-- an archive sweep sweeps them in; the row itself is never moved or
-- touched otherwise, so every existing query/report keeps working
-- unmodified.
ALTER TABLE loans ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE savings_accounts ADD COLUMN archived_at TIMESTAMPTZ;

-- Real, minimal pg_dump-based backup tooling. file_path points at a
-- server-local backup directory (never user-supplied — see
-- systemAdminService.js for why command-injection safety requires this).
CREATE TABLE backup_runs (
  id BIGSERIAL PRIMARY KEY,
  triggered_by BIGINT NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  file_path VARCHAR(500),
  file_size_bytes BIGINT,
  error_message TEXT,
  CONSTRAINT backup_runs_status_chk CHECK (status IN ('running', 'success', 'failed'))
);

CREATE INDEX ON backup_runs (status);

-- SaaS-readiness tracking ONLY — "if/when SaaS multi-tenancy is
-- introduced" (module prompt's own conditional framing). This codebase
-- is single-tenant today; nothing reads this table to enforce tenant
-- isolation or feature-gate anything. It exists so subscription/licence
-- EXPIRY can be tracked and reminded about now, without pretending
-- multi-tenancy already exists. See Decisions_Log.md.
CREATE TABLE subscription_licences (
  id BIGSERIAL PRIMARY KEY,
  tenant_name VARCHAR(150) NOT NULL,
  plan VARCHAR(60) NOT NULL,
  seats INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  renewal_reminder_sent_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_licences_status_chk CHECK (status IN ('active', 'expired', 'cancelled')),
  CONSTRAINT subscription_licences_dates_chk CHECK (end_date >= start_date),
  CONSTRAINT subscription_licences_seats_chk CHECK (seats > 0)
);

CREATE INDEX ON subscription_licences (status);

-- Repayment-due / susu-collection-due reminders. This is a LOG/QUEUE
-- table, not a real delivery mechanism — there is no SMS/push/email
-- gateway integrated anywhere in this codebase (same "manual payment
-- reference, no live gateway" gap already documented for Module 5/6
-- payouts), so `status = 'sent'` must NOT be read as "the customer/agent
-- actually received a message." A real notification-provider integration
-- would call markNotificationSent/Failed after actually dispatching one
-- of these rows — see Decisions_Log.md.
CREATE TABLE reminder_notifications (
  id BIGSERIAL PRIMARY KEY,
  notification_type VARCHAR(40) NOT NULL,
  entity_type VARCHAR(20) NOT NULL,
  entity_id BIGINT NOT NULL,
  customer_id BIGINT REFERENCES customers(id),
  due_date DATE NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT reminder_notifications_type_chk CHECK (notification_type IN ('repayment_due', 'susu_collection_due')),
  CONSTRAINT reminder_notifications_status_chk CHECK (status IN ('pending', 'sent', 'failed')),
  UNIQUE (notification_type, entity_type, entity_id, due_date)
);

CREATE INDEX ON reminder_notifications (status);
CREATE INDEX ON reminder_notifications (customer_id);
