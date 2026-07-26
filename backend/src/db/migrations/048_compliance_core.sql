-- Module 8: Regulatory & Compliance Reporting.
--
-- CLAUDE.md rule 7 governs every table in this file: "Never hardcode BOG
-- thresholds, provisioning rules, or GRA tax rates from general
-- knowledge. Flag anything regulation-dependent as needing verification
-- ... before it ships." NONE of the tables below are seeded with any
-- default numeric figure — every days-past-due boundary, provisioning
-- rate, capital/liquidity ratio definition, and tax rate is left for a
-- compliance officer to configure with verified current BOG/GRA guidance
-- before this module is used for a real submission. See Decisions_Log.md
-- Open Questions for the full list of what must be verified.

-- Loan classification categories (BOG's current/OLEM/substandard/
-- doubtful/loss framing) as CONFIGURABLE DATA, not a hardcoded app-layer
-- rule — "must be configurable, since regulatory guidance can change"
-- per the module prompt. Multiple rows share one `effective_date` (one
-- row per category); complianceService resolves "the active config as
-- of a date" as every row at the MAX effective_date <= that date, same
-- resolution rule `regulatory_ratio_definitions`/`tax_rates` below use.
CREATE TABLE loan_classification_configs (
  id BIGSERIAL PRIMARY KEY,
  category VARCHAR(20) NOT NULL,
  min_days_past_due INT NOT NULL,
  max_days_past_due INT, -- NULL = no upper bound (the terminal/worst category)
  provisioning_rate_bps INT NOT NULL,
  effective_date DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_classification_configs_category_chk CHECK (
    category IN ('current', 'olem', 'substandard', 'doubtful', 'loss')
  ),
  CONSTRAINT loan_classification_configs_days_chk CHECK (
    min_days_past_due >= 0 AND (max_days_past_due IS NULL OR max_days_past_due >= min_days_past_due)
  ),
  CONSTRAINT loan_classification_configs_rate_chk CHECK (provisioning_rate_bps BETWEEN 0 AND 10000),
  UNIQUE (effective_date, category)
);

CREATE INDEX ON loan_classification_configs (effective_date);

-- Per-loan classification snapshots, recomputed periodically from Module
-- 3's aging data (via analyticsService.getLoanBookSnapshot, never a
-- second days-overdue computation) against whichever
-- loan_classification_configs generation was active as of the run date.
CREATE TABLE loan_classifications (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id),
  as_of_date DATE NOT NULL,
  config_effective_date DATE NOT NULL,
  category VARCHAR(20) NOT NULL,
  days_past_due INT NOT NULL,
  outstanding_principal_pesewas BIGINT NOT NULL,
  provisioning_amount_pesewas BIGINT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loan_classifications_category_chk CHECK (
    category IN ('current', 'olem', 'substandard', 'doubtful', 'loss')
  ),
  UNIQUE (loan_id, as_of_date)
);

CREATE INDEX ON loan_classifications (as_of_date);
CREATE INDEX ON loan_classifications (category);

-- Capital adequacy ratio / liquidity ratio (and any other prudential
-- ratio a regulator asks for) as a GENERIC, ADMIN-DEFINED computation —
-- deliberately NOT a hardcoded CAR/liquidity formula in application code.
-- Which GL control accounts count toward the numerator/denominator (and
-- at what weight — e.g. a risk-weighting schedule), and what the actual
-- minimum ratio is, are exactly the "current BOG guidelines" the module
-- prompt says must be verified with a compliance officer, so they are
-- DATA here, resolved the same "latest effective_date <= asOfDate wins"
-- way as loan_classification_configs.
CREATE TABLE regulatory_ratio_definitions (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  numerator_gl_codes JSONB NOT NULL, -- [{ code, weightBps }]
  denominator_gl_codes JSONB NOT NULL, -- [{ code, weightBps }]
  minimum_ratio_bps INT, -- NULL = not yet configured; no compliant/non-compliant verdict is asserted until set
  effective_date DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, effective_date)
);

CREATE INDEX ON regulatory_ratio_definitions (name, effective_date);

-- GRA withholding tax (on investor interest payouts) and VAT (on fee
-- income) rates. `vat_applicable_gl_codes` is only meaningful for
-- tax_type = 'vat_fee_income' (which GL fee-income accounts are
-- VAT-scoped is itself a classification decision, not assumed) and is
-- NULL for 'withholding_tax_investment_interest' (that one applies to
-- the whole of investment_payouts, a specific transaction type, not a
-- GL-code sweep).
CREATE TABLE tax_rates (
  id BIGSERIAL PRIMARY KEY,
  tax_type VARCHAR(40) NOT NULL,
  rate_bps INT NOT NULL,
  vat_applicable_gl_codes JSONB,
  effective_date DATE NOT NULL,
  description TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_rates_type_chk CHECK (
    tax_type IN ('withholding_tax_investment_interest', 'vat_fee_income')
  ),
  CONSTRAINT tax_rates_rate_chk CHECK (rate_bps BETWEEN 0 AND 10000),
  UNIQUE (tax_type, effective_date)
);

CREATE INDEX ON tax_rates (tax_type, effective_date);

-- Versioned report templates — "an admin-editable template/field-mapping
-- system so report layout and required fields can be adjusted without a
-- code deployment." A new edit is a NEW row (version = prior max + 1 for
-- the same `name`), never an UPDATE to an old version — "a report
-- generated last year can be regenerated using the template version that
-- was active then" requires old versions to stay byte-for-byte immutable
-- and addressable. `field_mappings` names which of complianceService's
-- named data sources (loan_classification_summary,
-- capital_adequacy_ratio, liquidity_ratio, social_performance_summary,
-- withholding_tax_summary, vat_summary) populate which report field.
CREATE TABLE regulatory_report_templates (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  target_authority VARCHAR(60) NOT NULL,
  field_mappings JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  effective_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT regulatory_report_templates_status_chk CHECK (status IN ('active', 'retired')),
  UNIQUE (name, version)
);

CREATE INDEX ON regulatory_report_templates (name);

-- Audit history of what was actually generated/submitted — report_data
-- is a full snapshot of the populated report at generation time, so a
-- later template edit (a new version) can never retroactively change
-- what a past submission says it contained.
CREATE TABLE regulatory_report_submissions (
  id BIGSERIAL PRIMARY KEY,
  template_id BIGINT NOT NULL REFERENCES regulatory_report_templates(id),
  template_version INT NOT NULL,
  period_start DATE,
  period_end DATE,
  report_data JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by BIGINT NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'generated',
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  file_reference VARCHAR(200),
  CONSTRAINT regulatory_report_submissions_status_chk CHECK (status IN ('generated', 'submitted')),
  CONSTRAINT regulatory_report_submissions_submitted_chk CHECK (
    (status = 'submitted') = (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
  )
);

CREATE INDEX ON regulatory_report_submissions (template_id);
CREATE INDEX ON regulatory_report_submissions (status);

-- AML monitoring. rule_type is an enum for future extension, but only
-- 'single_transaction_threshold' has real evaluation logic today — see
-- complianceService.js and Decisions_Log.md; this is documented, not
-- silently pretended to be complete.
CREATE TABLE aml_rules (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  rule_type VARCHAR(40) NOT NULL DEFAULT 'single_transaction_threshold',
  threshold_pesewas BIGINT NOT NULL,
  transaction_scope VARCHAR(20) NOT NULL DEFAULT 'all',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT aml_rules_rule_type_chk CHECK (rule_type IN ('single_transaction_threshold')),
  CONSTRAINT aml_rules_scope_chk CHECK (transaction_scope IN ('all', 'savings', 'loan_disbursement', 'investment')),
  CONSTRAINT aml_rules_status_chk CHECK (status IN ('active', 'inactive')),
  CONSTRAINT aml_rules_threshold_chk CHECK (threshold_pesewas > 0)
);

-- A flag NEVER auto-clears (module prompt's own explicit rule) — status
-- moves open -> reviewed/cleared ONLY via a human reviewer action
-- (complianceService.reviewAmlFlag), which is why reviewed_by/reviewed_at/
-- review_notes are required together with any non-'open' status. UNIQUE
-- on (rule_id, transaction_type, transaction_id) so re-running a
-- screening pass over the same period never creates a duplicate flag for
-- the same transaction/rule pair.
CREATE TABLE aml_flags (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL REFERENCES aml_rules(id),
  transaction_type VARCHAR(20) NOT NULL,
  transaction_id BIGINT NOT NULL,
  customer_id BIGINT REFERENCES customers(id),
  branch_id BIGINT NOT NULL REFERENCES branches(id),
  amount_pesewas BIGINT NOT NULL,
  flagged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  CONSTRAINT aml_flags_transaction_type_chk CHECK (transaction_type IN ('savings', 'loan_disbursement', 'investment')),
  CONSTRAINT aml_flags_status_chk CHECK (status IN ('open', 'reviewed', 'cleared')),
  CONSTRAINT aml_flags_reviewed_chk CHECK (
    (status = 'open') = (reviewed_by IS NULL AND reviewed_at IS NULL AND review_notes IS NULL)
  ),
  UNIQUE (rule_id, transaction_type, transaction_id)
);

CREATE INDEX ON aml_flags (status);
CREATE INDEX ON aml_flags (branch_id);
CREATE INDEX ON aml_flags (customer_id);

-- Sanctions screening. `sanctions_list_entries` starts and STAYS EMPTY
-- from this migration — there is no legitimate way to embed a real OFAC/
-- UN/Ghana-FIC sanctions list in application code, and fabricating
-- placeholder "sanctions" names would be actively dangerous for a
-- compliance feature. A real deployment MUST load a genuine, currently-
-- maintained list feed into this table before screening means anything —
-- see Decisions_Log.md Open Questions. The screening WORKFLOW below is
-- real and fully wired; only the underlying list data is a deliberate,
-- loudly-documented gap.
CREATE TABLE sanctions_list_entries (
  id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(200) NOT NULL,
  list_source VARCHAR(100) NOT NULL,
  notes TEXT,
  added_by BIGINT NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON sanctions_list_entries (full_name);

-- match_status never reaches 'confirmed_match' from the automatic
-- screening pass itself — only 'no_match' or 'potential_match' (a human
-- must explicitly confirm or clear a potential match via
-- complianceService.resolveScreeningMatch), same "never auto-resolve a
-- compliance finding" discipline as aml_flags.
CREATE TABLE sanctions_screening_results (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  screened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  screened_by BIGINT NOT NULL REFERENCES users(id),
  match_status VARCHAR(20) NOT NULL,
  matched_entry_ids JSONB,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  CONSTRAINT sanctions_screening_results_status_chk CHECK (
    match_status IN ('no_match', 'potential_match', 'confirmed_match', 'cleared')
  ),
  CONSTRAINT sanctions_screening_results_match_entries_chk CHECK (
    (match_status = 'no_match') = (matched_entry_ids IS NULL)
  )
);

CREATE INDEX ON sanctions_screening_results (customer_id);
CREATE INDEX ON sanctions_screening_results (match_status);
