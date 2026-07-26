'use strict';

const auditLog = require('../../shared/auditLog');
const glService = require('../gl/glService');
const analyticsService = require('../analytics/analyticsService');

/**
 * Module 8: Regulatory & Compliance Reporting.
 *
 * CLAUDE.md rule 7 applies to almost everything in this file: loan
 * classification day-boundaries/provisioning rates, capital/liquidity
 * ratio definitions, and GRA tax rates are NEVER hardcoded here — they
 * are all read from tables a compliance officer must configure
 * (migration 048's own header comment). Every function below that reads
 * one of those configs throws a clear `ComplianceNotFoundError` if none
 * has been configured yet, rather than silently assuming a default.
 */

class ComplianceValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class ComplianceNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}
class ComplianceConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// --- Loan classification ------------------------------------------------------

const LOAN_CLASSIFICATION_CATEGORIES = ['current', 'olem', 'substandard', 'doubtful', 'loss'];

/** Every category row sharing the latest effective_date <= asOfDate — a full "generation" of the config, never a partial one. */
async function getActiveLoanClassificationConfig(pool, asOfDate = todayIso()) {
  const { rows: dateRows } = await pool.query(
    'SELECT MAX(effective_date) AS effective_date FROM loan_classification_configs WHERE effective_date <= $1',
    [asOfDate]
  );
  const effectiveDate = dateRows[0].effective_date;
  if (!effectiveDate) {
    throw new ComplianceNotFoundError(
      `no loan_classification_configs are effective as of ${asOfDate} — a compliance officer must configure BOG loan classification thresholds first`
    );
  }
  const { rows } = await pool.query(
    'SELECT * FROM loan_classification_configs WHERE effective_date = $1 ORDER BY min_days_past_due',
    [effectiveDate]
  );
  return rows;
}

/**
 * Inserts one full generation of classification categories (all five,
 * sharing one effective_date) in a single transaction — a partial
 * generation (e.g. only 3 of 5 categories configured) would make
 * `classifyLoan` unable to categorize a loan whose arrears fall in an
 * ungapped range, so this rejects anything less than full coverage.
 */
async function createLoanClassificationConfigSet(pool, { categories, effectiveDate, createdBy, actorBranchId }) {
  if (!Array.isArray(categories) || categories.length === 0 || !effectiveDate || !createdBy || !actorBranchId) {
    throw new ComplianceValidationError('categories, effectiveDate, createdBy, and actorBranchId are required');
  }
  const providedCategories = new Set(categories.map((c) => c.category));
  const missing = LOAN_CLASSIFICATION_CATEGORIES.filter((c) => !providedCategories.has(c));
  if (missing.length > 0) {
    throw new ComplianceValidationError(`categories must cover all five BOG categories; missing: ${missing.join(', ')}`);
  }

  const client = await pool.connect();
  let inserted;
  try {
    await client.query('BEGIN');
    inserted = [];
    for (const cat of categories) {
      const { rows } = await client.query(
        `INSERT INTO loan_classification_configs
           (category, min_days_past_due, max_days_past_due, provisioning_rate_bps, effective_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [cat.category, cat.minDaysPastDue, cat.maxDaysPastDue ?? null, cat.provisioningRateBps, effectiveDate, createdBy]
      );
      inserted.push(rows[0]);
    }
    await auditLog.record(client, {
      userId: createdBy,
      branchId: actorBranchId,
      action: 'compliance.loan_classification_config_created',
      entityType: 'loan_classification_config',
      entityId: effectiveDate,
      afterState: { effectiveDate, categories: inserted },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      throw new ComplianceConflictError(`a loan_classification_configs generation already exists for effective_date ${effectiveDate}`);
    }
    throw err;
  } finally {
    client.release();
  }
  return inserted;
}

/** Pure: which category a days-past-due value falls into, given an active config generation. Throws if the config has a gap. */
function classifyLoan(daysPastDue, config) {
  for (const row of config) {
    const min = row.min_days_past_due;
    const max = row.max_days_past_due;
    if (daysPastDue >= min && (max === null || daysPastDue <= max)) {
      return row;
    }
  }
  throw new ComplianceValidationError(`no configured category covers ${daysPastDue} days past due — the active config has a gap`);
}

/**
 * Recomputes and persists a classification snapshot for every disbursed
 * loan as of `asOfDate`, reusing `analyticsService.getLoanBookSnapshot`
 * for the days-overdue figure (never a second computation of the same
 * thing). `loan_classifications` is a deliberate point-in-time SNAPSHOT
 * table (unlike Module 7/9's always-live reports) — a regulatory
 * submission must reflect exactly what was classified at generation
 * time, not silently drift if the loan book changes afterward.
 */
async function runLoanClassification(pool, { asOfDate = todayIso(), branchId = null, createdBy }) {
  if (!createdBy) throw new ComplianceValidationError('createdBy is required');
  const config = await getActiveLoanClassificationConfig(pool, asOfDate);
  const configEffectiveDate = config[0].effective_date;
  const book = await analyticsService.getLoanBookSnapshot(pool, { asOfDate, branchId });

  const results = [];
  for (const loan of book) {
    const categoryRow = classifyLoan(loan.daysOverdue, config);
    const provisioningAmountPesewas = Math.round((loan.outstandingPrincipalPesewas * categoryRow.provisioning_rate_bps) / 10000);
    const { rows } = await pool.query(
      `INSERT INTO loan_classifications
         (loan_id, as_of_date, config_effective_date, category, days_past_due, outstanding_principal_pesewas, provisioning_amount_pesewas)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (loan_id, as_of_date)
       DO UPDATE SET config_effective_date = EXCLUDED.config_effective_date, category = EXCLUDED.category,
         days_past_due = EXCLUDED.days_past_due, outstanding_principal_pesewas = EXCLUDED.outstanding_principal_pesewas,
         provisioning_amount_pesewas = EXCLUDED.provisioning_amount_pesewas, computed_at = now()
       RETURNING *`,
      [loan.loanId, asOfDate, configEffectiveDate, categoryRow.category, loan.daysOverdue, loan.outstandingPrincipalPesewas, provisioningAmountPesewas]
    );
    results.push(rows[0]);
  }
  return results;
}

/** Reads the PERSISTED snapshot for a date (requires runLoanClassification to have been run for it first) — the intended "as officially classified" record, not a live recompute. */
async function getLoanClassificationSummary(pool, { asOfDate = todayIso(), branchId = null } = {}) {
  const params = [asOfDate];
  let where = 'lc.as_of_date = $1';
  if (branchId) {
    params.push(branchId);
    where += ` AND l.branch_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT lc.category, COUNT(*)::int AS loan_count,
            COALESCE(SUM(lc.outstanding_principal_pesewas), 0)::bigint AS outstanding_pesewas,
            COALESCE(SUM(lc.provisioning_amount_pesewas), 0)::bigint AS provisioning_pesewas
       FROM loan_classifications lc JOIN loans l ON l.id = lc.loan_id
      WHERE ${where}
      GROUP BY lc.category`,
    params
  );
  const byCategory = Object.fromEntries(
    rows.map((r) => [
      r.category,
      { category: r.category, loanCount: r.loan_count, outstandingPesewas: Number(r.outstanding_pesewas), provisioningPesewas: Number(r.provisioning_pesewas) },
    ])
  );
  const categories = LOAN_CLASSIFICATION_CATEGORIES.map(
    (c) => byCategory[c] || { category: c, loanCount: 0, outstandingPesewas: 0, provisioningPesewas: 0 }
  );
  return {
    asOfDate,
    branchId: branchId ? Number(branchId) : null,
    categories,
    totalProvisioningPesewas: categories.reduce((s, c) => s + c.provisioningPesewas, 0),
  };
}

// --- Regulatory ratios (CAR, liquidity, or any admin-defined ratio) ----------

async function getActiveRatioDefinition(pool, { name, asOfDate = todayIso() }) {
  const { rows } = await pool.query(
    `SELECT * FROM regulatory_ratio_definitions WHERE name = $1 AND effective_date <= $2 ORDER BY effective_date DESC LIMIT 1`,
    [name, asOfDate]
  );
  if (!rows[0]) {
    throw new ComplianceNotFoundError(
      `no regulatory_ratio_definitions named '${name}' are effective as of ${asOfDate} — a compliance officer must configure it first`
    );
  }
  return rows[0];
}

async function createRatioDefinition(pool, { name, numeratorGlCodes, denominatorGlCodes, minimumRatioBps = null, effectiveDate, createdBy }) {
  if (!name || !numeratorGlCodes || !denominatorGlCodes || !effectiveDate || !createdBy) {
    throw new ComplianceValidationError('name, numeratorGlCodes, denominatorGlCodes, effectiveDate, and createdBy are required');
  }
  const { rows } = await pool.query(
    `INSERT INTO regulatory_ratio_definitions (name, numerator_gl_codes, denominator_gl_codes, minimum_ratio_bps, effective_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, JSON.stringify(numeratorGlCodes), JSON.stringify(denominatorGlCodes), minimumRatioBps, effectiveDate, createdBy]
  );
  return rows[0];
}

/** Sums `balancePesewas * weightBps / 10000` for each configured GL control-account code, reusing glService.getAccountRollup rather than re-deriving balances. */
function sumWeightedCodes(rollupByCode, codeWeights) {
  return codeWeights.reduce((sum, { code, weightBps = 10000 }) => {
    const entry = rollupByCode.get(code);
    const balance = entry ? entry.balancePesewas : 0;
    return sum + Math.round((balance * weightBps) / 10000);
  }, 0);
}

async function computeRatio(pool, { name, asOfDate = todayIso(), branchId = null }) {
  const definition = await getActiveRatioDefinition(pool, { name, asOfDate });
  const rollup = await glService.getAccountRollup(pool, { asOfDate, branchId });
  const rollupByCode = new Map(rollup.map((r) => [r.code, r]));

  const numeratorPesewas = sumWeightedCodes(rollupByCode, definition.numerator_gl_codes);
  const denominatorPesewas = sumWeightedCodes(rollupByCode, definition.denominator_gl_codes);
  const ratioBps = denominatorPesewas !== 0 ? Math.round((numeratorPesewas / denominatorPesewas) * 10000) : null;
  const minimumRatioBps = definition.minimum_ratio_bps;

  return {
    name,
    asOfDate,
    branchId: branchId ? Number(branchId) : null,
    numeratorPesewas,
    denominatorPesewas,
    ratioBps,
    minimumRatioBps,
    // null (not a boolean) until an admin has configured a verified minimum — never assert compliance against a guessed threshold.
    compliant: minimumRatioBps === null || ratioBps === null ? null : ratioBps >= minimumRatioBps,
  };
}

// --- GRA tax reporting ---------------------------------------------------------

async function getActiveTaxRate(pool, { taxType, asOfDate = todayIso() }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_rates WHERE tax_type = $1 AND effective_date <= $2 ORDER BY effective_date DESC LIMIT 1`,
    [taxType, asOfDate]
  );
  if (!rows[0]) {
    throw new ComplianceNotFoundError(
      `no tax_rates configured for '${taxType}' as of ${asOfDate} — a compliance officer must configure the current GRA rate first`
    );
  }
  return rows[0];
}

async function createTaxRate(pool, { taxType, rateBps, vatApplicableGlCodes = null, effectiveDate, description = null, createdBy }) {
  if (!taxType || rateBps === undefined || !effectiveDate || !createdBy) {
    throw new ComplianceValidationError('taxType, rateBps, effectiveDate, and createdBy are required');
  }
  const { rows } = await pool.query(
    `INSERT INTO tax_rates (tax_type, rate_bps, vat_applicable_gl_codes, effective_date, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [taxType, rateBps, vatApplicableGlCodes ? JSON.stringify(vatApplicableGlCodes) : null, effectiveDate, description, createdBy]
  );
  return rows[0];
}

/** Withholding tax on investor interest payouts — sums investment_payouts actually PAID in the period (updated_at is stamped at settlement, see Decisions_Log.md). */
async function getWithholdingTaxSummary(pool, { periodStart, periodEnd, asOfDate = periodEnd }) {
  if (!periodStart || !periodEnd) throw new ComplianceValidationError('periodStart and periodEnd are required');
  const taxRate = await getActiveTaxRate(pool, { taxType: 'withholding_tax_investment_interest', asOfDate });

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_pesewas), 0)::bigint AS total
       FROM investment_payouts
      WHERE status = 'paid' AND updated_at::date >= $1 AND updated_at::date <= $2`,
    [periodStart, periodEnd]
  );
  const totalInterestPaidPesewas = Number(rows[0].total);
  const taxDuePesewas = Math.round((totalInterestPaidPesewas * taxRate.rate_bps) / 10000);

  return { periodStart, periodEnd, totalInterestPaidPesewas, rateBps: taxRate.rate_bps, taxDuePesewas };
}

/** VAT on fee income — sums the configured VAT-applicable GL fee-income codes' PERIOD activity via glService.getAccountRollup. */
async function getVatSummary(pool, { periodStart, periodEnd, asOfDate = periodEnd, branchId = null }) {
  if (!periodStart || !periodEnd) throw new ComplianceValidationError('periodStart and periodEnd are required');
  const taxRate = await getActiveTaxRate(pool, { taxType: 'vat_fee_income', asOfDate });
  if (!taxRate.vat_applicable_gl_codes || taxRate.vat_applicable_gl_codes.length === 0) {
    throw new ComplianceValidationError(
      `tax_rates row for 'vat_fee_income' effective ${taxRate.effective_date} has no vat_applicable_gl_codes configured`
    );
  }

  const rollup = await glService.getAccountRollup(pool, { fromDate: periodStart, toDate: periodEnd, branchId });
  const rollupByCode = new Map(rollup.map((r) => [r.code, r]));
  const totalFeeIncomePesewas = sumWeightedCodes(
    rollupByCode,
    taxRate.vat_applicable_gl_codes.map((code) => ({ code, weightBps: 10000 }))
  );
  const vatDuePesewas = Math.round((totalFeeIncomePesewas * taxRate.rate_bps) / 10000);

  return { periodStart, periodEnd, totalFeeIncomePesewas, rateBps: taxRate.rate_bps, vatDuePesewas };
}

// --- Report templates (versioned) ---------------------------------------------

/** Inserting a new version NEVER touches an old version's row — see migration 048's comment on why. */
async function createReportTemplate(pool, { name, targetAuthority, fieldMappings, effectiveDate, createdBy }) {
  if (!name || !targetAuthority || !fieldMappings || !effectiveDate || !createdBy) {
    throw new ComplianceValidationError('name, targetAuthority, fieldMappings, effectiveDate, and createdBy are required');
  }
  const { rows: versionRows } = await pool.query(
    'SELECT COALESCE(MAX(version), 0) AS max_version FROM regulatory_report_templates WHERE name = $1',
    [name]
  );
  const version = Number(versionRows[0].max_version) + 1;

  const { rows } = await pool.query(
    `INSERT INTO regulatory_report_templates (name, target_authority, field_mappings, version, effective_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, targetAuthority, JSON.stringify(fieldMappings), version, effectiveDate, createdBy]
  );
  return rows[0];
}

async function listReportTemplates(pool, { name, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('name', name);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM regulatory_report_templates ${where} ORDER BY name, version DESC`, params);
  return rows;
}

async function getReportTemplate(pool, templateId) {
  const { rows } = await pool.query('SELECT * FROM regulatory_report_templates WHERE id = $1', [templateId]);
  if (!rows[0]) throw new ComplianceNotFoundError(`regulatory_report_template ${templateId} not found`);
  return rows[0];
}

/** Only status is togglable post-creation — template CONTENT is immutable once created; a change to layout/mappings is always a new version. */
async function setReportTemplateStatus(pool, { templateId, status, updatedBy, actorBranchId }) {
  if (!['active', 'retired'].includes(status)) throw new ComplianceValidationError("status must be 'active' or 'retired'");
  if (!updatedBy || !actorBranchId) throw new ComplianceValidationError('updatedBy and actorBranchId are required');
  const before = await getReportTemplate(pool, templateId);
  const { rows } = await pool.query(
    'UPDATE regulatory_report_templates SET status = $1 WHERE id = $2 RETURNING *',
    [status, templateId]
  );
  await auditLog.record(pool, {
    userId: updatedBy,
    branchId: actorBranchId,
    action: 'compliance.report_template_status_changed',
    entityType: 'regulatory_report_template',
    entityId: templateId,
    beforeState: { status: before.status },
    afterState: { status },
  });
  return rows[0];
}

// --- Report generation ---------------------------------------------------------

const REPORT_DATA_SOURCES = {
  loan_classification_summary: (pool, params) => getLoanClassificationSummary(pool, params),
  capital_adequacy_ratio: (pool, params) => computeRatio(pool, { ...params, name: 'capital_adequacy_ratio' }),
  liquidity_ratio: (pool, params) => computeRatio(pool, { ...params, name: 'liquidity_ratio' }),
  social_performance_summary: (pool, params) => analyticsService.getSocialPerformanceSummary(pool, params),
  withholding_tax_summary: (pool, params) => getWithholdingTaxSummary(pool, params),
  vat_summary: (pool, params) => getVatSummary(pool, params),
};

/**
 * Populates a template's `field_mappings.fields` (each `{ key, source }`,
 * `source` naming one of REPORT_DATA_SOURCES) against live data, snapshots
 * the result onto a NEW regulatory_report_submissions row, and returns it.
 * The template row itself is never touched — regenerating this same
 * report later against the SAME templateId (a specific, immutable
 * version) reproduces the same field-mapping definition even if a newer
 * template version exists by then.
 */
async function generateReport(pool, { templateId, periodStart = null, periodEnd = null, asOfDate = todayIso(), branchId = null, generatedBy, actorBranchId }) {
  if (!generatedBy || !actorBranchId) throw new ComplianceValidationError('generatedBy and actorBranchId are required');
  const template = await getReportTemplate(pool, templateId);

  const fields = (template.field_mappings && template.field_mappings.fields) || [];
  if (fields.length === 0) throw new ComplianceValidationError(`regulatory_report_template ${templateId} has no fields in field_mappings`);

  const reportData = {};
  for (const field of fields) {
    const source = REPORT_DATA_SOURCES[field.source];
    if (!source) throw new ComplianceValidationError(`unknown report data source '${field.source}' for field '${field.key}'`);
    reportData[field.key] = await source(pool, { asOfDate, periodStart, periodEnd, branchId });
  }

  const { rows } = await pool.query(
    `INSERT INTO regulatory_report_submissions (template_id, template_version, period_start, period_end, report_data, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [templateId, template.version, periodStart, periodEnd, JSON.stringify(reportData), generatedBy]
  );
  const submission = rows[0];

  await auditLog.record(pool, {
    userId: generatedBy,
    branchId: branchId || actorBranchId,
    action: 'compliance.report_generated',
    entityType: 'regulatory_report_submission',
    entityId: submission.id,
    afterState: { templateId, templateVersion: template.version, periodStart, periodEnd },
  });

  return submission;
}

async function markReportSubmitted(pool, { submissionId, submittedBy, fileReference }) {
  if (!submittedBy || !fileReference) throw new ComplianceValidationError('submittedBy and fileReference are required');
  const { rows: beforeRows } = await pool.query('SELECT * FROM regulatory_report_submissions WHERE id = $1', [submissionId]);
  const before = beforeRows[0];
  if (!before) throw new ComplianceNotFoundError(`regulatory_report_submission ${submissionId} not found`);
  if (before.status === 'submitted') throw new ComplianceConflictError(`regulatory_report_submission ${submissionId} is already submitted`);

  const { rows } = await pool.query(
    `UPDATE regulatory_report_submissions SET status = 'submitted', submitted_by = $1, submitted_at = now(), file_reference = $2 WHERE id = $3 RETURNING *`,
    [submittedBy, fileReference, submissionId]
  );
  return rows[0];
}

async function listReportSubmissions(pool, { templateId, status } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('template_id', templateId);
  add('status', status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM regulatory_report_submissions ${where} ORDER BY generated_at DESC`, params);
  return rows;
}

// --- AML monitoring -------------------------------------------------------------

async function createAmlRule(pool, { name, thresholdPesewas, transactionScope = 'all', createdBy }) {
  if (!name || !thresholdPesewas || !createdBy) throw new ComplianceValidationError('name, thresholdPesewas, and createdBy are required');
  const { rows } = await pool.query(
    `INSERT INTO aml_rules (name, threshold_pesewas, transaction_scope, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, thresholdPesewas, transactionScope, createdBy]
  );
  return rows[0];
}

async function listAmlRules(pool, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM aml_rules ${where} ORDER BY id`, params);
  return rows;
}

async function updateAmlRuleStatus(pool, { ruleId, status }) {
  if (!['active', 'inactive'].includes(status)) throw new ComplianceValidationError("status must be 'active' or 'inactive'");
  const { rows } = await pool.query('UPDATE aml_rules SET status = $1 WHERE id = $2 RETURNING *', [status, ruleId]);
  if (!rows[0]) throw new ComplianceNotFoundError(`aml_rule ${ruleId} not found`);
  return rows[0];
}

/**
 * Scans savings/loan-disbursement/investment-booking transactions in the
 * date range against every active rule's threshold. `ON CONFLICT DO
 * NOTHING` on (rule_id, transaction_type, transaction_id) means
 * re-running this over an already-scanned window never creates duplicate
 * flags for the same transaction/rule pair.
 */
async function runAmlScreening(pool, { fromDate, toDate }) {
  if (!fromDate || !toDate) throw new ComplianceValidationError('fromDate and toDate are required');
  const rules = await listAmlRules(pool, { status: 'active' });
  const created = [];

  for (const rule of rules) {
    const scopes = rule.transaction_scope === 'all' ? ['savings', 'loan_disbursement', 'investment'] : [rule.transaction_scope];

    if (scopes.includes('savings')) {
      const { rows } = await pool.query(
        `SELECT st.id, sa.customer_id, sa.branch_id, ABS(st.amount_pesewas) AS amount_pesewas
           FROM savings_transactions st JOIN savings_accounts sa ON sa.id = st.account_id
          WHERE ABS(st.amount_pesewas) >= $1 AND st.created_at::date >= $2 AND st.created_at::date <= $3`,
        [rule.threshold_pesewas, fromDate, toDate]
      );
      for (const row of rows) created.push(await insertAmlFlag(pool, rule, 'savings', row));
    }
    if (scopes.includes('loan_disbursement')) {
      const { rows } = await pool.query(
        `SELECT id, customer_id, branch_id, principal_pesewas AS amount_pesewas
           FROM loans WHERE status = 'disbursed' AND principal_pesewas >= $1 AND disbursed_at::date >= $2 AND disbursed_at::date <= $3`,
        [rule.threshold_pesewas, fromDate, toDate]
      );
      for (const row of rows) created.push(await insertAmlFlag(pool, rule, 'loan_disbursement', row));
    }
    if (scopes.includes('investment')) {
      const { rows } = await pool.query(
        `SELECT id, customer_id, branch_id, principal_pesewas AS amount_pesewas
           FROM investments WHERE activated_at IS NOT NULL AND principal_pesewas >= $1 AND activated_at::date >= $2 AND activated_at::date <= $3`,
        [rule.threshold_pesewas, fromDate, toDate]
      );
      for (const row of rows) created.push(await insertAmlFlag(pool, rule, 'investment', row));
    }
  }

  return created.filter(Boolean);
}

async function insertAmlFlag(pool, rule, transactionType, row) {
  const { rows } = await pool.query(
    `INSERT INTO aml_flags (rule_id, transaction_type, transaction_id, customer_id, branch_id, amount_pesewas)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (rule_id, transaction_type, transaction_id) DO NOTHING
     RETURNING *`,
    [rule.id, transactionType, row.id, row.customer_id, row.branch_id, row.amount_pesewas]
  );
  return rows[0] || null;
}

async function listAmlFlags(pool, { status, branchId, customerId } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('status', status);
  add('branch_id', branchId);
  add('customer_id', customerId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM aml_flags ${where} ORDER BY flagged_at DESC`, params);
  return rows;
}

/** The ONLY path off 'open' — a flag never auto-clears (module prompt's own rule). Never allows a transition back to 'open'. */
async function reviewAmlFlag(pool, { flagId, reviewedBy, newStatus, reviewNotes }) {
  if (!reviewedBy || !reviewNotes) throw new ComplianceValidationError('reviewedBy and reviewNotes are required');
  if (!['reviewed', 'cleared'].includes(newStatus)) throw new ComplianceValidationError("newStatus must be 'reviewed' or 'cleared'");

  const { rows: beforeRows } = await pool.query('SELECT * FROM aml_flags WHERE id = $1', [flagId]);
  const before = beforeRows[0];
  if (!before) throw new ComplianceNotFoundError(`aml_flag ${flagId} not found`);
  if (before.status === 'cleared') throw new ComplianceConflictError(`aml_flag ${flagId} is already cleared`);

  const { rows } = await pool.query(
    `UPDATE aml_flags SET status = $1, reviewed_by = $2, reviewed_at = now(), review_notes = $3 WHERE id = $4 RETURNING *`,
    [newStatus, reviewedBy, reviewNotes, flagId]
  );
  const flag = rows[0];

  await auditLog.record(pool, {
    userId: reviewedBy,
    branchId: flag.branch_id,
    action: 'compliance.aml_flag_reviewed',
    entityType: 'aml_flag',
    entityId: flagId,
    beforeState: { status: before.status },
    afterState: { status: flag.status, reviewNotes },
  });

  return flag;
}

// --- Sanctions screening ---------------------------------------------------------

async function addSanctionsListEntry(pool, { fullName, listSource, notes = null, addedBy }) {
  if (!fullName || !listSource || !addedBy) throw new ComplianceValidationError('fullName, listSource, and addedBy are required');
  const { rows } = await pool.query(
    `INSERT INTO sanctions_list_entries (full_name, list_source, notes, added_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [fullName, listSource, notes, addedBy]
  );
  return rows[0];
}

async function listSanctionsListEntries(pool) {
  const { rows } = await pool.query('SELECT * FROM sanctions_list_entries ORDER BY full_name');
  return rows;
}

/**
 * Case-insensitive exact-name match against `sanctions_list_entries` —
 * mechanically real, but the list itself starts EMPTY (migration 048's
 * own comment) and stays empty until someone loads a genuine list feed,
 * so every screening returns 'no_match' until that happens. Never
 * auto-produces 'confirmed_match' — only a human, via
 * `resolveScreeningMatch`, can confirm or clear a 'potential_match'.
 */
async function screenCustomer(pool, { customerId, screenedBy }) {
  if (!customerId || !screenedBy) throw new ComplianceValidationError('customerId and screenedBy are required');

  const { rows: customerRows } = await pool.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  const customer = customerRows[0];
  if (!customer) throw new ComplianceNotFoundError(`customer ${customerId} not found`);

  const { rows: matches } = await pool.query(
    'SELECT id FROM sanctions_list_entries WHERE lower(full_name) = lower($1)',
    [customer.full_name]
  );
  const matchStatus = matches.length > 0 ? 'potential_match' : 'no_match';

  const { rows } = await pool.query(
    `INSERT INTO sanctions_screening_results (customer_id, screened_by, match_status, matched_entry_ids)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [customerId, screenedBy, matchStatus, matches.length > 0 ? JSON.stringify(matches.map((m) => m.id)) : null]
  );
  return rows[0];
}

async function runBatchScreening(pool, { screenedBy, customerIds = null } = {}) {
  if (!screenedBy) throw new ComplianceValidationError('screenedBy is required');
  let targetIds = customerIds;
  if (!targetIds) {
    const { rows } = await pool.query("SELECT id FROM customers WHERE status = 'active'");
    targetIds = rows.map((r) => r.id);
  }
  const results = [];
  for (const customerId of targetIds) {
    results.push(await screenCustomer(pool, { customerId, screenedBy }));
  }
  return results;
}

/** The ONLY path off 'potential_match' — never auto-resolved, same discipline as aml_flags. */
async function resolveScreeningMatch(pool, { screeningResultId, resolvedBy, resolution, notes }) {
  if (!resolvedBy || !notes) throw new ComplianceValidationError('resolvedBy and notes are required');
  if (!['cleared', 'confirmed_match'].includes(resolution)) {
    throw new ComplianceValidationError("resolution must be 'cleared' or 'confirmed_match'");
  }

  const { rows: beforeRows } = await pool.query('SELECT * FROM sanctions_screening_results WHERE id = $1', [screeningResultId]);
  const before = beforeRows[0];
  if (!before) throw new ComplianceNotFoundError(`sanctions_screening_result ${screeningResultId} not found`);
  if (before.match_status !== 'potential_match') {
    throw new ComplianceConflictError(`sanctions_screening_result ${screeningResultId} is not a pending potential match (status: ${before.match_status})`);
  }

  const { rows } = await pool.query(
    `UPDATE sanctions_screening_results SET match_status = $1, resolved_by = $2, resolved_at = now(), resolution_notes = $3 WHERE id = $4 RETURNING *`,
    [resolution, resolvedBy, notes, screeningResultId]
  );
  return rows[0];
}

async function listScreeningResults(pool, { matchStatus, customerId } = {}) {
  const clauses = [];
  const params = [];
  const add = (col, val) => {
    if (val === undefined || val === null) return;
    params.push(val);
    clauses.push(`${col} = $${params.length}`);
  };
  add('match_status', matchStatus);
  add('customer_id', customerId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM sanctions_screening_results ${where} ORDER BY screened_at DESC`, params);
  return rows;
}

module.exports = {
  getActiveLoanClassificationConfig,
  createLoanClassificationConfigSet,
  classifyLoan,
  runLoanClassification,
  getLoanClassificationSummary,
  getActiveRatioDefinition,
  createRatioDefinition,
  computeRatio,
  getActiveTaxRate,
  createTaxRate,
  getWithholdingTaxSummary,
  getVatSummary,
  createReportTemplate,
  listReportTemplates,
  getReportTemplate,
  setReportTemplateStatus,
  generateReport,
  markReportSubmitted,
  listReportSubmissions,
  createAmlRule,
  listAmlRules,
  updateAmlRuleStatus,
  runAmlScreening,
  listAmlFlags,
  reviewAmlFlag,
  addSanctionsListEntry,
  listSanctionsListEntries,
  screenCustomer,
  runBatchScreening,
  resolveScreeningMatch,
  listScreeningResults,
  LOAN_CLASSIFICATION_CATEGORIES,
  REPORT_DATA_SOURCES,
  ComplianceValidationError,
  ComplianceNotFoundError,
  ComplianceConflictError,
};
