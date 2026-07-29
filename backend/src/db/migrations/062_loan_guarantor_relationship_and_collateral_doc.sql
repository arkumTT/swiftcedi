-- Loan module amendment (item 3b/3c): guarantor relationship, and a
-- collateral document reference. Follows the existing URL/link-only
-- document pattern this codebase already uses for customer_documents
-- (migration 016's file_url TEXT) rather than introducing any new file
-- upload/blob-storage infrastructure — see Decisions_Log.md.
--
-- relationship is a loose VARCHAR, not a CHECK-constrained enum, matching
-- next_of_kin.relationship's existing precedent (also migration 016)
-- rather than loan_concessions.reason_code's stricter style — guarantor
-- relationship is free-text descriptive data (spouse/sibling/parent/
-- friend/business partner/colleague/other), not a value anything branches
-- logic on.

ALTER TABLE loan_guarantors ADD COLUMN relationship VARCHAR(60);
ALTER TABLE loan_collateral ADD COLUMN document_url TEXT;
