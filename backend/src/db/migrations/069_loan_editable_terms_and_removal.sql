-- Loan module amendment (item 3, revised classification): principal,
-- tenor, and loan offer become editable pre-approval, constrained to the
-- (possibly newly-selected) product's own min/max principal and term.
-- terms_last_edited_at/by is a persistent "review notice" — surfaced as a
-- banner on the loan detail page for whoever appraises/decides the loan
-- next, so an edited application is never silently re-appraised against
-- stale numbers. Not cleared automatically; it is a permanent audit-
-- visible marker of "this application's terms changed after it was
-- first submitted," not a dismissable flag.
ALTER TABLE loans
  ADD COLUMN terms_last_edited_at TIMESTAMPTZ,
  ADD COLUMN terms_last_edited_by BIGINT REFERENCES users(id);

-- Collateral "remove" (item 3c) is a soft delete, never a hard DELETE —
-- financial-adjacent supporting records follow the same never-hard-delete
-- discipline as accounts/transactions/loans elsewhere in this codebase
-- (CLAUDE.md rule 3), with a reason code for why it was removed.
ALTER TABLE loan_collateral
  ADD COLUMN removed_at TIMESTAMPTZ,
  ADD COLUMN removed_by BIGINT REFERENCES users(id),
  ADD COLUMN removal_reason TEXT;
