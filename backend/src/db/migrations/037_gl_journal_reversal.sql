-- Module 6: activates the 'reversed' status that gl_journal_entries has
-- carried in its CHECK constraint since Module 7 but that nothing ever
-- produced. A reversal is a NEW entry with every line's debit/credit
-- swapped from the original — the original's lines are NEVER touched
-- (they're immutable at the DB layer already, migration 007) — only its
-- `status` flips from 'posted' to 'reversed'. `gl_journal_entries` itself
-- has no immutability trigger (only its lines do), so this UPDATE is
-- already legal at the DB layer; this migration just adds the link
-- column tying a reversal back to what it reverses.
--
-- UNIQUE ensures at most one reversal ever exists per original entry —
-- reverse it once, or post a fresh correcting entry for anything further,
-- never a second reversal of the same entry.

ALTER TABLE gl_journal_entries
  ADD COLUMN reverses_entry_id BIGINT REFERENCES gl_journal_entries(id);

ALTER TABLE gl_journal_entries
  ADD CONSTRAINT gl_journal_entries_reverses_unique UNIQUE (reverses_entry_id);

ALTER TABLE gl_journal_entries
  ADD CONSTRAINT gl_journal_entries_no_self_reverse_chk CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id);
