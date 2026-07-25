-- Module 2: group/community structure. `groups.customer_id` is the
-- group's own row in `customers` (customer_type = 'group') — the entity
-- loans/accounts attach to. `group_members` links individually-KYC'd
-- individual customers to that group; a member must exist as its own
-- `customers` row (customer_type = 'individual') per the business rule
-- "group members should be individually KYC'd even though they borrow
-- under a group structure" — enforced in customerService.js, not the DB,
-- since "customer_type of the referenced row" isn't a static CHECK.

CREATE TABLE groups (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL UNIQUE REFERENCES customers(id),
  group_leader_id BIGINT REFERENCES customers(id),
  formation_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES groups(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  joined_at DATE NOT NULL DEFAULT current_date,
  left_at DATE,
  added_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT group_members_dates_chk CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE INDEX ON group_members (group_id);
CREATE INDEX ON group_members (customer_id);
-- A customer can only be an active (not-yet-left) member of a given group once.
CREATE UNIQUE INDEX group_members_one_active_per_group
  ON group_members (group_id, customer_id)
  WHERE left_at IS NULL;
