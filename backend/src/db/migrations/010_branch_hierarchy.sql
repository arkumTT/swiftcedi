-- Module 1: region -> cluster -> branch hierarchy, and fleshing out the
-- `branches` stub from Module 11/7's migrations. ALTERs the existing table
-- rather than recreating it, since users/gl_accounts/audit_log already
-- reference branches.id (see Decisions_Log.md "Table Naming Conventions").

CREATE TABLE branch_regions (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branch_clusters (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  region_id BIGINT NOT NULL REFERENCES branch_regions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region_id, name)
);

ALTER TABLE branches
  ADD COLUMN region_id BIGINT REFERENCES branch_regions(id),
  ADD COLUMN cluster_id BIGINT REFERENCES branch_clusters(id),
  ADD COLUMN address TEXT,
  ADD COLUMN gps_lat NUMERIC(9, 6),
  ADD COLUMN gps_lng NUMERIC(9, 6),
  ADD COLUMN opening_date DATE,
  ADD COLUMN operating_hours VARCHAR(100),
  ADD COLUMN licence_ref VARCHAR(80);

-- Branch code is immutable once transactions exist against it (business
-- rule, checked in branchService.js since "any GL journal entry posted"
-- isn't expressible as a simple DB constraint without a trigger scan).
-- Enforce the code SHAPE at the DB layer, though: branchService.js's
-- auto-generated GL sub-account codes are "<control_code>.<branch_code>"
-- and depend on branch_code being short enough to fit gl_accounts.code
-- (VARCHAR(20)).
ALTER TABLE branches
  ADD CONSTRAINT branches_code_shape_chk CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,9}$');
