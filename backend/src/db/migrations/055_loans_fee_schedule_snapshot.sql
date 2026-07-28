-- Fixes a real pre-existing gap found while orienting for the loan
-- products/concessions feature: loanService.disburseLoan read
-- product.fee_schedule LIVE at disbursement time, so a product's fees
-- could silently change between when a customer applied and when the
-- loan actually disbursed — the exact "past disbursements shouldn't
-- silently change" guarantee that interest_method/annual_interest_rate_bps
-- already had (they're snapshotted onto the loan row at application,
-- per migration 023's own comment) never covered fees. This also gives
-- a loan concession somewhere to store a negotiated fee override without
-- inventing a second, parallel mechanism.
--
-- Backfilled from each existing loan's product so no row is left NULL
-- for loans that predate this migration; disburseLoan is updated in the
-- same commit as this migration to read loan.fee_schedule instead of the
-- live product.

ALTER TABLE loans ADD COLUMN fee_schedule JSONB;

UPDATE loans l
   SET fee_schedule = p.fee_schedule
  FROM loan_products p
 WHERE l.product_id = p.id
   AND l.fee_schedule IS NULL;

ALTER TABLE loans ALTER COLUMN fee_schedule SET NOT NULL;
ALTER TABLE loans ALTER COLUMN fee_schedule SET DEFAULT '[]';
