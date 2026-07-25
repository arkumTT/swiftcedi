-- Minimal branches table so every other table can carry a real branch_id FK
-- before Module 1 (Branch Creation & Management) is built. Module 1 will
-- ALTER this table to add region_id, cluster_id, address, gps, etc. — see
-- Decisions_Log.md "Deviations from the Original Module Prompts".
--
-- Head office is modeled as a branch (code 'HQ'), per the branch-hierarchy
-- note in SwiftCedi_Module_Build_Prompts.md Module 1, so head-office-level
-- writes (e.g. RBAC administration) still have a real branch_id to attach to.

CREATE TABLE branches (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT branches_status_chk CHECK (status IN ('active', 'suspended', 'under_review', 'closed'))
);

INSERT INTO branches (code, name, status) VALUES ('HQ', 'Head Office', 'active');
