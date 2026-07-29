-- Multi-role approval thresholds: a tier can require ANY ONE of several
-- roles to decide (e.g. loan.approve's lower tier is branch_manager OR
-- loan_officer), not just a single role. Additive only — the existing
-- singular `required_approver_role_id` column is kept and backfilled as
-- `required_approver_role_ids[1]` so any code still reading it keeps
-- working; new code should read the array. See Decisions_Log.md
-- "Shared Services" / approval_thresholds.

ALTER TABLE approval_thresholds
  ADD COLUMN required_approver_role_ids BIGINT[];

UPDATE approval_thresholds
  SET required_approver_role_ids = ARRAY[required_approver_role_id];

ALTER TABLE approval_thresholds
  ALTER COLUMN required_approver_role_ids SET NOT NULL,
  ADD CONSTRAINT approval_thresholds_role_ids_nonempty_chk
    CHECK (array_length(required_approver_role_ids, 1) > 0);

ALTER TABLE approval_requests
  ADD COLUMN required_approver_role_ids BIGINT[];

UPDATE approval_requests
  SET required_approver_role_ids = ARRAY[required_approver_role_id]
  WHERE required_approver_role_id IS NOT NULL;
