-- Loan module amendment (payments): Payment Mode + Receiver of funds +
-- transaction reference on each repayment record. Nullable — existing
-- loan_repayments rows predate this feature and are never backfilled
-- (same convention as investment_payouts.payment_reference, migration
-- 035); the application layer requires all three on every NEW postRepayment
-- call. "Receiver" is a single field used identically for both Cash and
-- Mobile Money (an explicit simplification over a mode-conditional split
-- — see Decisions_Log.md), an FK to users like every other actor column
-- in this schema (received_by, requested_by, verified_by, ...) rather
-- than free text, so it stays queryable/reconcilable the same way.
--
-- One call to postRepayment can insert MULTIPLE loan_repayments rows (one
-- per schedule installment an allocation touches) — all rows from the
-- same call carry the same payment_mode_id/receiver_user_id/
-- transaction_reference, since they're one physical payment split across
-- installments, not separate payments.

ALTER TABLE loan_repayments
  ADD COLUMN payment_mode_id BIGINT REFERENCES payment_modes(id),
  ADD COLUMN receiver_user_id BIGINT REFERENCES users(id),
  ADD COLUMN transaction_reference VARCHAR(120);

-- Extend the append-only guarantee (migration 024) to cover the three new
-- columns — they must be immutable just like every other field on this
-- table, with the same one-time journal_entry_id-stamp exception.
CREATE OR REPLACE FUNCTION prevent_loan_repayments_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.journal_entry_id IS NULL
     AND NEW.journal_entry_id IS NOT NULL
     AND ROW(NEW.id, NEW.loan_id, NEW.schedule_id, NEW.amount_pesewas, NEW.principal_component_pesewas,
             NEW.interest_component_pesewas, NEW.fees_component_pesewas, NEW.payment_date, NEW.received_by, NEW.created_at,
             NEW.payment_mode_id, NEW.receiver_user_id, NEW.transaction_reference)
       IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.loan_id, OLD.schedule_id, OLD.amount_pesewas, OLD.principal_component_pesewas,
             OLD.interest_component_pesewas, OLD.fees_component_pesewas, OLD.payment_date, OLD.received_by, OLD.created_at,
             OLD.payment_mode_id, OLD.receiver_user_id, OLD.transaction_reference)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'loan_repayments rows are immutable (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;
