-- Module 1: staff assignment history and time-bound cross-branch access
-- grants. `users.home_branch_id` (Module 11) remains the live/current
-- pointer used everywhere else in the app; branch_staff_assignments is the
-- append-style history of how that pointer got there over time — see
-- Decisions_Log.md.

CREATE TABLE branch_staff_assignments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  start_date DATE NOT NULL DEFAULT current_date,
  end_date DATE,
  assigned_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT branch_staff_assignments_dates_chk CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX ON branch_staff_assignments (user_id);
CREATE INDEX ON branch_staff_assignments (branch_id);
-- At most one open (end_date IS NULL) assignment per user at a time.
CREATE UNIQUE INDEX branch_staff_assignments_one_open_per_user
  ON branch_staff_assignments (user_id) WHERE end_date IS NULL;

CREATE TABLE cross_branch_access_grants (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  granted_by BIGINT NOT NULL REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revoked_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cross_branch_access_grants_dates_chk CHECK (end_date >= start_date)
);

CREATE INDEX ON cross_branch_access_grants (user_id);
CREATE INDEX ON cross_branch_access_grants (branch_id);
