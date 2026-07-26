-- Module 10: Agent & Field Operations.
--
-- field_agents is a 1:1 EXTENSION of a staff/user record, not a
-- replacement for one — same "confirm the join key" question the Module
-- 4 build already pre-answered (see 029_susu.sql's own comment):
-- susu_collections.agent_id / susu_accounts.assigned_agent_id /
-- agent_remittances.agent_id all reference users(id) DIRECTLY, not this
-- table. Module 10's own tables (agent_assignments/agent_locations/
-- agent_reconciliations) reference field_agents(id) as their own PK, and
-- bridge to Module 4's data via field_agents.user_id = <that column>,
-- exactly the "susu_collections -> users <- field_agents" join the
-- Module 4 comment describes. This also means a user can be tracked as a
-- field agent regardless of their RBAC role — the module prompt's own
-- "susu collectors, loan officers doing field visits" framing needs both
-- a 'field_agent'-role user AND a 'loan_officer'-role user to be
-- trackable here, so field_agents is deliberately NOT constrained to one
-- RBAC role.
CREATE TABLE field_agents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
  home_branch_id BIGINT NOT NULL REFERENCES branches(id),
  territory TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT field_agents_status_chk CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX ON field_agents (home_branch_id);
CREATE INDEX ON field_agents (status);

-- Territory/branch coverage HISTORY. field_agents.home_branch_id/territory
-- always reflect the CURRENT (open) row here — same denormalized-current-
-- state-plus-full-history shape as branch_staff_assignments
-- (012_branch_staff_and_access.sql), kept in sync by agentService's
-- reassignAgent() the same way branchService.assignStaff() keeps
-- users.home_branch_id in sync with branch_staff_assignments.
CREATE TABLE agent_assignments (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES field_agents(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  territory TEXT,
  start_date DATE NOT NULL DEFAULT current_date,
  end_date DATE,
  assigned_by BIGINT NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_assignments_dates_chk CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX ON agent_assignments (agent_id);
CREATE INDEX ON agent_assignments (branch_id);
-- At most one open (end_date IS NULL) assignment per agent at a time.
CREATE UNIQUE INDEX agent_assignments_one_open_per_agent
  ON agent_assignments (agent_id) WHERE end_date IS NULL;

-- High-frequency GPS pings. Deliberately no infinite retention: the
-- module prompt asks for "a rolling retention window rather than
-- infinite history" — agentService.purgeOldLocations() is a real,
-- callable primitive, but actually SCHEDULING it to run periodically is
-- a Module 12 (System Administration) concern, same "the job exists, the
-- cron doesn't yet" deferral already used for Module 9's
-- daily_metrics_snapshot. No CHECK against a fixed minimum time between
-- rows — the minimum-ping-interval business rule is enforced at the
-- application layer (agentService.recordLocationPing), not the DB,
-- since it needs a "how long since THIS agent's last row" comparison a
-- plain CHECK constraint can't express.
CREATE TABLE agent_locations (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES field_agents(id),
  gps_lat NUMERIC(9, 6) NOT NULL,
  gps_lng NUMERIC(9, 6) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_locations_coords_chk CHECK (
    gps_lat BETWEEN -90 AND 90 AND gps_lng BETWEEN -180 AND 180
  )
);

CREATE INDEX ON agent_locations (agent_id, recorded_at DESC);

-- End-of-day expected-vs-received reconciliation. 'expected_amount_pesewas'
-- is what the agent collected in the field that day (SUM of that
-- agent_id's susu_collections for the date — the only field-collection
-- channel with real agent/GPS instrumentation right now; "any field loan
-- repayments" from the module prompt is NOT included, since loanService
-- has no field-collection/agent concept to reconcile against yet — see
-- Decisions_Log.md Open Questions). 'received_amount_pesewas' is what the
-- cashier actually recorded banking that day (SUM of that agent_id's
-- agent_remittances for the SAME date) — these are independently-dated
-- events (collection_date vs remitted_on), so a real, non-tautological
-- variance shows up whenever an agent is still holding cash overnight or
-- remits a different day's collections, not just a re-derivation of the
-- same number.
--
-- status NEVER auto-resolves a variance (module prompt's own explicit
-- rule): 'matched' is set automatically only when variance = 0;
-- 'pending_review' is set automatically whenever variance != 0; only a
-- human, via resolveReconciliation(), can move a row to 'resolved'.
CREATE TABLE agent_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES field_agents(id),
  reconciliation_date DATE NOT NULL,
  expected_amount_pesewas BIGINT NOT NULL,
  received_amount_pesewas BIGINT NOT NULL,
  variance_pesewas BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'matched',
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_reconciliations_status_chk CHECK (status IN ('matched', 'pending_review', 'resolved')),
  CONSTRAINT agent_reconciliations_resolved_chk CHECK (
    (status = 'resolved') = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  UNIQUE (agent_id, reconciliation_date)
);

CREATE INDEX ON agent_reconciliations (agent_id);
CREATE INDEX ON agent_reconciliations (status);
CREATE INDEX ON agent_reconciliations (reconciliation_date);
