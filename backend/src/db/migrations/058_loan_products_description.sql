-- Feature 1 ("Loan Products with Fixed and Floating interest options")
-- explicitly lists product description as a configurable field alongside
-- name/code/status; migration 022 never added it. Nullable — every
-- existing product simply has no description until an admin edits one.

ALTER TABLE loan_products ADD COLUMN description TEXT;
