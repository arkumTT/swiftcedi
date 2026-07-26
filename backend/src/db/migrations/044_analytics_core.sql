-- Module 9: Analytics & Owner Dashboard. Per the module prompt, this
-- module is "primarily read/aggregation logic ... over other modules'
-- tables — avoid duplicating source-of-truth data", so the ONLY table it
-- owns is dashboard widget layout/visibility configuration — every
-- reporting figure itself is computed live from Modules 1-7's own tables
-- (loans/loan_schedules, savings_transactions, gl_journal_lines via the
-- existing glService/glPosting/cashierService, etc.), never duplicated
-- here. No `daily_metrics_snapshot` table (also mentioned in the module
-- prompt) — that's explicitly a Module 12 scheduled-job concern per the
-- prompt's own wording ("populated by a scheduled job (Module 12)"), and
-- Module 12 doesn't exist yet; adding an unpopulated snapshot table now
-- would be exactly the kind of half-finished, nothing-writes-to-it table
-- CLAUDE.md's working agreement warns against (same reasoning already
-- applied to savings_accounts.status = 'dormant' and
-- investments.status = 'matured' — both exist in their CHECK constraints
-- with no producer until a Module 12 sweep exists). See Decisions_Log.md
-- Open Questions.

-- Per-ROLE (not per-user) dashboard customization, matching the module
-- prompt's own framing ("Configurable dashboard widgets per role").
-- widget_key is deliberately free-form VARCHAR, not a CHECK-constrained
-- enum — same reasoning as customers.classification: the registry of
-- known widget keys lives in analyticsService.js and can grow without a
-- migration, while still being validated at the application layer.
CREATE TABLE dashboard_widget_configs (
  id BIGSERIAL PRIMARY KEY,
  role_id BIGINT NOT NULL REFERENCES roles(id),
  widget_key VARCHAR(60) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  visible BOOLEAN NOT NULL DEFAULT true,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role_id, widget_key)
);

CREATE INDEX ON dashboard_widget_configs (role_id);
