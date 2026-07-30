'use strict';

const auditLog = require('../../shared/auditLog');
const glService = require('../gl/glService');
const branchService = require('../branch/branchService');
const cashierService = require('../cashier/cashierService');
const susuService = require('../savings/susuService');
const loanMath = require('../loan/loanMath');

/**
 * Module 9: Analytics & Owner Dashboard. Per the module prompt, this is
 * "primarily read/aggregation logic ... over other modules' tables" — it
 * owns no primary transactional data and reuses the other modules' own
 * services wherever one already exists (glService's financial statements,
 * cashierService's cash position, susuService's agent commission summary)
 * rather than re-deriving the same figures a second way. See
 * Decisions_Log.md for the interpretation notes flagged below.
 */

class AnalyticsValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}
class AnalyticsNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Loan officers may only ever see their OWN loan book, no matter what a
 * caller passes as `requestedOfficerId` — this is enforced HERE, at the
 * service layer, not just by the route/middleware layer, per the module
 * prompt's explicit "incapable of returning another officer's book even
 * if they inspect network requests." "Loan officer" is approximated as
 * `loans.applied_by` — see Decisions_Log.md Open Questions (this schema
 * has no dedicated `loan_officer_id`/case-reassignment concept).
 */
function resolveLoanOfficerScope(requestingUser, requestedOfficerId) {
  if (requestingUser && requestingUser.roleName === 'loan_officer') {
    return requestingUser.id;
  }
  return requestedOfficerId || null;
}

// --- Live stats --------------------------------------------------------------

/**
 * Cash position reuses cashierService directly (never re-derives a GL
 * balance a different way) — branch-scoped when branchId is given,
 * consolidated with a per-branch snapshot grid otherwise.
 */
async function getLiveStats(pool, { branchId = null, date = todayIso() } = {}) {
  const cashPosition = branchId
    ? await cashierService.getBranchCashPosition(pool, branchId)
    : await cashierService.getConsolidatedCashPosition(pool);

  const disbursementParams = [date];
  let disbursementWhere = "status IN ('disbursed', 'paying', 'missed_payment') AND disbursed_at::date = $1";
  if (branchId) {
    disbursementParams.push(branchId);
    disbursementWhere += ` AND branch_id = $${disbursementParams.length}`;
  }
  const { rows: disbursementRows } = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(principal_pesewas), 0)::bigint AS total
       FROM loans WHERE ${disbursementWhere}`,
    disbursementParams
  );

  const repaymentParams = [date];
  let repaymentWhere = 'lr.payment_date = $1';
  if (branchId) {
    repaymentParams.push(branchId);
    repaymentWhere += ` AND l.branch_id = $${repaymentParams.length}`;
  }
  const { rows: repaymentRows } = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(lr.amount_pesewas), 0)::bigint AS total
       FROM loan_repayments lr JOIN loans l ON l.id = lr.loan_id WHERE ${repaymentWhere}`,
    repaymentParams
  );

  const depositParams = [date];
  let depositWhere = "st.txn_type = 'deposit' AND st.created_at::date = $1";
  if (branchId) {
    depositParams.push(branchId);
    depositWhere += ` AND sa.branch_id = $${depositParams.length}`;
  }
  const { rows: depositRows } = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(st.amount_pesewas), 0)::bigint AS total
       FROM savings_transactions st JOIN savings_accounts sa ON sa.id = st.account_id WHERE ${depositWhere}`,
    depositParams
  );

  const susuParams = [date];
  let susuWhere = 'sc.collection_date = $1';
  if (branchId) {
    susuParams.push(branchId);
    susuWhere += ` AND sua.branch_id = $${susuParams.length}`;
  }
  const { rows: susuRows } = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(sc.amount_pesewas), 0)::bigint AS total
       FROM susu_collections sc JOIN susu_accounts sua ON sua.id = sc.susu_account_id WHERE ${susuWhere}`,
    susuParams
  );

  // "Non-cash transaction volume": no digital payment rail (MoMo/GHIPSS/
  // Paystack/Hubtel) is wired up yet — see Decisions_Log.md — so this is
  // approximated as every GL journal entry posted today that does NOT
  // touch a cash/vault/cash-in-transit/cash-with-agents control account,
  // i.e. book-side postings (accruals, fees, interest) rather than actual
  // cash movement.
  const nonCashParams = [date];
  let nonCashWhere = `e.entry_date = $1
       AND NOT EXISTS (
         SELECT 1 FROM gl_journal_lines l2
           JOIN gl_accounts ga2 ON ga2.id = l2.account_id
          WHERE l2.journal_entry_id = e.id
            AND COALESCE(ga2.parent_account_id, ga2.id) IN (
              SELECT id FROM gl_accounts WHERE code IN ('1000', '1010', '1020', '1030') AND branch_id IS NULL
            )
       )`;
  if (branchId) {
    nonCashParams.push(branchId);
    nonCashWhere += ` AND e.branch_id = $${nonCashParams.length}`;
  }
  const { rows: nonCashRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM gl_journal_entries e WHERE ${nonCashWhere}`,
    nonCashParams
  );

  const result = {
    date,
    branchId: branchId ? Number(branchId) : null,
    cashPosition,
    todaysDisbursements: { count: disbursementRows[0].count, totalPesewas: Number(disbursementRows[0].total) },
    todaysCollections: {
      loanRepayments: { count: repaymentRows[0].count, totalPesewas: Number(repaymentRows[0].total) },
      savingsDeposits: { count: depositRows[0].count, totalPesewas: Number(depositRows[0].total) },
      susuCollections: { count: susuRows[0].count, totalPesewas: Number(susuRows[0].total) },
    },
    nonCashTransactionCount: nonCashRows[0].count,
  };

  if (!branchId) {
    const { rows: branches } = await pool.query('SELECT id, code, name FROM branches ORDER BY code');
    const branchById = new Map(branches.map((b) => [Number(b.id), b]));
    result.branchSnapshotGrid = cashPosition.branches.map((p) => ({
      ...p,
      code: branchById.get(p.branchId) ? branchById.get(p.branchId).code : null,
      name: branchById.get(p.branchId) ? branchById.get(p.branchId).name : null,
    }));
  }

  return result;
}

// --- Portfolio quality -------------------------------------------------------

const PAR_BUCKET_DAYS = [30, 60, 90];

/**
 * Per-loan outstanding principal and days-overdue, reconstructed from
 * `loan_schedules` (never a stored running balance) for every currently
 * `disbursed` loan — the base query every portfolio-quality figure below
 * is built on. `daysOverdue` is measured against the loan's EARLIEST
 * installment that is both past its due date and not yet fully paid
 * (principal+interest+fees due > paid) — a loan with no such installment
 * is fully current (`daysOverdue: 0`), regardless of remaining schedule.
 */
async function getLoanBookSnapshot(pool, { asOfDate = todayIso(), branchId = null, loanOfficerId = null } = {}) {
  const params = [asOfDate];
  let where = "l.status IN ('disbursed', 'paying', 'missed_payment')";
  if (branchId) {
    params.push(branchId);
    where += ` AND l.branch_id = $${params.length}`;
  }
  if (loanOfficerId) {
    params.push(loanOfficerId);
    where += ` AND l.applied_by = $${params.length}`;
  }

  const { rows } = await pool.query(
    `WITH schedule_agg AS (
       SELECT ls.loan_id,
              SUM(ls.principal_due_pesewas - ls.principal_paid_pesewas)::bigint AS outstanding_principal_pesewas,
              MIN(CASE
                    WHEN (ls.principal_due_pesewas + ls.interest_due_pesewas + ls.fees_due_pesewas)
                       > (ls.principal_paid_pesewas + ls.interest_paid_pesewas + ls.fees_paid_pesewas)
                     AND ls.due_date <= $1
                    THEN ls.due_date
                  END) AS earliest_unpaid_due_date
         FROM loan_schedules ls
         JOIN loans l ON l.id = ls.loan_id AND ls.schedule_version = l.current_schedule_version
        WHERE l.status IN ('disbursed', 'paying', 'missed_payment')
        GROUP BY ls.loan_id
     )
     SELECT l.id AS loan_id, l.branch_id, l.customer_id, l.applied_by AS loan_officer_id,
            c.full_name AS customer_name,
            sa.outstanding_principal_pesewas, sa.earliest_unpaid_due_date
       FROM loans l
       JOIN schedule_agg sa ON sa.loan_id = l.id
       JOIN customers c ON c.id = l.customer_id
      WHERE ${where}`,
    params
  );

  return rows.map((r) => {
    const outstandingPrincipalPesewas = Number(r.outstanding_principal_pesewas);
    const daysOverdue = r.earliest_unpaid_due_date
      ? Math.floor((new Date(asOfDate) - new Date(r.earliest_unpaid_due_date)) / 86400000)
      : 0;
    return {
      loanId: Number(r.loan_id),
      branchId: Number(r.branch_id),
      customerId: Number(r.customer_id),
      customerName: r.customer_name,
      loanOfficerId: r.loan_officer_id ? Number(r.loan_officer_id) : null,
      outstandingPrincipalPesewas,
      daysOverdue: Math.max(daysOverdue, 0),
    };
  });
}

/**
 * PAR at 30/60/90 days, an aging breakdown, and the largest exposures —
 * everything a portfolio-quality dashboard needs from one shared snapshot
 * so every figure ties back to the exact same per-loan numbers.
 * `requestingUser` enforces the loan-officer own-book restriction even if
 * a caller passes someone else's `loanOfficerId`.
 */
async function getPortfolioQuality(pool, { asOfDate = todayIso(), branchId = null, loanOfficerId = null, requestingUser, largestExposuresLimit = 10 } = {}) {
  const scopedOfficerId = resolveLoanOfficerScope(requestingUser, loanOfficerId);
  const book = await getLoanBookSnapshot(pool, { asOfDate, branchId, loanOfficerId: scopedOfficerId });

  const totalOutstandingPesewas = book.reduce((s, l) => s + l.outstandingPrincipalPesewas, 0);

  const par = {};
  for (const thresholdDays of PAR_BUCKET_DAYS) {
    const atRiskPesewas = book
      .filter((l) => l.daysOverdue >= thresholdDays)
      .reduce((s, l) => s + l.outstandingPrincipalPesewas, 0);
    par[`par${thresholdDays}`] = {
      atRiskPesewas,
      ratio: totalOutstandingPesewas > 0 ? atRiskPesewas / totalOutstandingPesewas : null,
    };
  }

  const agingBuckets = new Map();
  for (const loan of book) {
    const bucket = loanMath.bucketArrearsDays(loan.daysOverdue, PAR_BUCKET_DAYS) || 'current';
    if (!agingBuckets.has(bucket)) agingBuckets.set(bucket, { bucket, loanCount: 0, outstandingPesewas: 0 });
    const entry = agingBuckets.get(bucket);
    entry.loanCount += 1;
    entry.outstandingPesewas += loan.outstandingPrincipalPesewas;
  }

  const largestExposures = [...book]
    .sort((a, b) => b.outstandingPrincipalPesewas - a.outstandingPrincipalPesewas)
    .slice(0, largestExposuresLimit);

  return {
    asOfDate,
    branchId: branchId ? Number(branchId) : null,
    loanOfficerId: scopedOfficerId,
    loanCount: book.length,
    totalOutstandingPesewas,
    ...par,
    agingBuckets: [...agingBuckets.values()],
    largestExposures,
  };
}

// --- Profitability -----------------------------------------------------------

/**
 * Cost-to-income and operational self-sufficiency, plus a per-branch P&L —
 * all built on `glService.getIncomeStatement`, never a second parallel
 * income/expense computation. OSS here is simplified to
 * income / expense (no separate loan-loss-provision line exists yet to
 * split out of "expense") — see Decisions_Log.md.
 */
async function getProfitability(pool, { fromDate, toDate, branchId = null } = {}) {
  if (!fromDate || !toDate) throw new AnalyticsValidationError('fromDate and toDate are required');

  const incomeStatement = await glService.getIncomeStatement(pool, { fromDate, toDate, branchId });
  const { totalIncomePesewas, totalExpensePesewas } = incomeStatement;

  const costToIncomeRatio = totalIncomePesewas > 0 ? totalExpensePesewas / totalIncomePesewas : null;
  const operationalSelfSufficiencyRatio = totalExpensePesewas > 0 ? totalIncomePesewas / totalExpensePesewas : null;

  const result = {
    fromDate,
    toDate,
    branchId: branchId ? Number(branchId) : null,
    totalIncomePesewas,
    totalExpensePesewas,
    netIncomePesewas: incomeStatement.netIncomePesewas,
    costToIncomeRatio,
    operationalSelfSufficiencyRatio,
  };

  if (!branchId) {
    const branches = await branchService.listBranches(pool, {});
    result.branchPL = await Promise.all(
      branches.map(async (b) => {
        const stmt = await glService.getIncomeStatement(pool, { fromDate, toDate, branchId: b.id });
        return {
          branchId: Number(b.id),
          code: b.code,
          name: b.name,
          totalIncomePesewas: stmt.totalIncomePesewas,
          totalExpensePesewas: stmt.totalExpensePesewas,
          netIncomePesewas: stmt.netIncomePesewas,
        };
      })
    );
  }

  return result;
}

/**
 * "Loan customer profitability" approximated as interest+fee revenue
 * collected per customer over the period, ranked descending — a true
 * fully-loaded profitability figure would need overhead cost allocation
 * this schema has no basis for. See Decisions_Log.md.
 */
async function getTopLoanCustomersByRevenue(pool, { fromDate, toDate, branchId = null, limit = 10 } = {}) {
  if (!fromDate || !toDate) throw new AnalyticsValidationError('fromDate and toDate are required');

  const params = [fromDate, toDate];
  let where = 'lr.payment_date >= $1 AND lr.payment_date <= $2';
  if (branchId) {
    params.push(branchId);
    where += ` AND l.branch_id = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT c.id AS customer_id, c.full_name,
            COALESCE(SUM(lr.interest_component_pesewas + lr.fees_component_pesewas), 0)::bigint AS revenue_pesewas
       FROM loan_repayments lr
       JOIN loans l ON l.id = lr.loan_id
       JOIN customers c ON c.id = l.customer_id
      WHERE ${where}
      GROUP BY c.id, c.full_name
      ORDER BY revenue_pesewas DESC
      LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ customerId: Number(r.customer_id), fullName: r.full_name, revenuePesewas: Number(r.revenue_pesewas) }));
}

// --- Growth trends ------------------------------------------------------------

const VALID_GRANULARITIES = new Set(['day', 'week', 'month', 'year']);

/**
 * Customer recruitment, disbursement, and net-deposit trends bucketed by
 * `granularity` over the date range, plus a point-in-time sector
 * breakdown. "Sector" is approximated as `customers.classification` — see
 * Decisions_Log.md (no dedicated sector/industry field or BOG-style
 * taxonomy exists in this schema yet).
 */
async function getGrowthTrends(pool, { fromDate, toDate, branchId = null, granularity = 'month' } = {}) {
  if (!fromDate || !toDate) throw new AnalyticsValidationError('fromDate and toDate are required');
  if (!VALID_GRANULARITIES.has(granularity)) {
    throw new AnalyticsValidationError(`granularity must be one of ${[...VALID_GRANULARITIES].join(', ')}`);
  }

  const branchParams = branchId ? [branchId] : [];
  const branchClauseSuffix = branchId ? ` AND branch_id = $3` : '';

  const { rows: customerRows } = await pool.query(
    `SELECT date_trunc('${granularity}', created_at)::date AS period, COUNT(*)::int AS count
       FROM customers WHERE created_at >= $1 AND created_at <= $2${branchClauseSuffix}
      GROUP BY period ORDER BY period`,
    [fromDate, toDate, ...branchParams]
  );

  const { rows: disbursementRows } = await pool.query(
    `SELECT date_trunc('${granularity}', disbursed_at)::date AS period,
            COUNT(*)::int AS count, COALESCE(SUM(principal_pesewas), 0)::bigint AS total
       FROM loans
      WHERE status IN ('disbursed', 'paying', 'missed_payment') AND disbursed_at >= $1 AND disbursed_at <= $2${branchClauseSuffix}
      GROUP BY period ORDER BY period`,
    [fromDate, toDate, ...branchParams]
  );

  const depositBranchClauseSuffix = branchId ? ` AND sa.branch_id = $3` : '';
  const { rows: depositRows } = await pool.query(
    `SELECT date_trunc('${granularity}', st.created_at)::date AS period,
            COALESCE(SUM(st.amount_pesewas), 0)::bigint AS net_pesewas
       FROM savings_transactions st JOIN savings_accounts sa ON sa.id = st.account_id
      WHERE st.created_at >= $1 AND st.created_at <= $2${depositBranchClauseSuffix}
      GROUP BY period ORDER BY period`,
    [fromDate, toDate, ...branchParams]
  );

  const sectorClauseSuffix = branchId ? ' AND branch_id = $1' : '';
  const { rows: sectorRows } = await pool.query(
    `SELECT COALESCE(classification, 'unspecified') AS sector, COUNT(*)::int AS customer_count
       FROM customers WHERE status = 'active'${sectorClauseSuffix}
      GROUP BY sector ORDER BY customer_count DESC`,
    branchId ? [branchId] : []
  );

  return {
    fromDate,
    toDate,
    branchId: branchId ? Number(branchId) : null,
    granularity,
    customerRecruitment: customerRows.map((r) => ({ period: r.period, count: r.count })),
    disbursementTrend: disbursementRows.map((r) => ({ period: r.period, count: r.count, totalPesewas: Number(r.total) })),
    depositGrowth: depositRows.map((r) => ({ period: r.period, netPesewas: Number(r.net_pesewas) })),
    sectorBreakdown: sectorRows.map((r) => ({ sector: r.sector, customerCount: r.customer_count })),
  };
}

// --- Repayment / payment-mode breakdown (loan module amendment) --------------

/**
 * Payment record dashboard (item 2): totals by Payment Mode, breakdown by
 * Receiver (staff/teller who received it — for cash till accountability),
 * and a trend line over the date range, all under the SAME filter set
 * (branch/agent/loan-offer) so every panel reflects one consistent slice.
 * "Agent" filters on loans.applied_by, the same "loan officer" proxy
 * resolveLoanOfficerScope already uses elsewhere in this file (see its own
 * comment — this schema has no dedicated loan-officer/case assignment
 * concept). A loan_officer caller is always scoped to their own book here
 * too, never able to pass a different loanOfficerId to see someone else's.
 */
async function getRepaymentBreakdown(
  pool,
  { fromDate, toDate, branchId = null, loanOfficerId = null, productId = null, granularity = 'day', requestingUser } = {}
) {
  if (!fromDate || !toDate) throw new AnalyticsValidationError('fromDate and toDate are required');
  if (!VALID_GRANULARITIES.has(granularity)) {
    throw new AnalyticsValidationError(`granularity must be one of ${[...VALID_GRANULARITIES].join(', ')}`);
  }
  const scopedLoanOfficerId = resolveLoanOfficerScope(requestingUser, loanOfficerId);

  const clauses = ['lr.payment_date >= $1', 'lr.payment_date <= $2'];
  const params = [fromDate, toDate];
  if (branchId) {
    params.push(branchId);
    clauses.push(`l.branch_id = $${params.length}`);
  }
  if (scopedLoanOfficerId) {
    params.push(scopedLoanOfficerId);
    clauses.push(`l.applied_by = $${params.length}`);
  }
  if (productId) {
    params.push(productId);
    clauses.push(`l.product_id = $${params.length}`);
  }
  const where = clauses.join(' AND ');

  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(lr.amount_pesewas), 0)::bigint AS total_pesewas
       FROM loan_repayments lr JOIN loans l ON l.id = lr.loan_id
      WHERE ${where}`,
    params
  );

  const { rows: byModeRows } = await pool.query(
    `SELECT pm.id AS payment_mode_id, pm.code, pm.name,
            COUNT(*)::int AS count, COALESCE(SUM(lr.amount_pesewas), 0)::bigint AS total_pesewas
       FROM loan_repayments lr
       JOIN loans l ON l.id = lr.loan_id
       LEFT JOIN payment_modes pm ON pm.id = lr.payment_mode_id
      WHERE ${where}
      GROUP BY pm.id, pm.code, pm.name
      ORDER BY total_pesewas DESC`,
    params
  );

  const { rows: byReceiverRows } = await pool.query(
    `SELECT lr.receiver_user_id, u.full_name AS receiver_name,
            COUNT(*)::int AS count, COALESCE(SUM(lr.amount_pesewas), 0)::bigint AS total_pesewas
       FROM loan_repayments lr
       JOIN loans l ON l.id = lr.loan_id
       LEFT JOIN users u ON u.id = lr.receiver_user_id
      WHERE ${where}
      GROUP BY lr.receiver_user_id, u.full_name
      ORDER BY total_pesewas DESC`,
    params
  );

  const { rows: trendRows } = await pool.query(
    `SELECT date_trunc('${granularity}', lr.payment_date)::date AS period,
            COUNT(*)::int AS count, COALESCE(SUM(lr.amount_pesewas), 0)::bigint AS total_pesewas
       FROM loan_repayments lr JOIN loans l ON l.id = lr.loan_id
      WHERE ${where}
      GROUP BY period ORDER BY period`,
    params
  );

  return {
    fromDate,
    toDate,
    branchId: branchId ? Number(branchId) : null,
    loanOfficerId: scopedLoanOfficerId ? Number(scopedLoanOfficerId) : null,
    productId: productId ? Number(productId) : null,
    granularity,
    total: { count: totalRows[0].count, totalPesewas: Number(totalRows[0].total_pesewas) },
    byMode: byModeRows.map((r) => ({
      paymentModeId: r.payment_mode_id ? Number(r.payment_mode_id) : null,
      code: r.code,
      name: r.name ?? 'Unspecified',
      count: r.count,
      totalPesewas: Number(r.total_pesewas),
    })),
    byReceiver: byReceiverRows.map((r) => ({
      receiverUserId: r.receiver_user_id ? Number(r.receiver_user_id) : null,
      receiverName: r.receiver_name ?? 'Unspecified',
      count: r.count,
      totalPesewas: Number(r.total_pesewas),
    })),
    trend: trendRows.map((r) => ({ period: r.period, count: r.count, totalPesewas: Number(r.total_pesewas) })),
  };
}

// --- Agent / loan officer productivity ---------------------------------------

/**
 * Susu-agent productivity (collections + commissions, reusing
 * susuService.getAgentCommissionSummary rather than re-deriving it) and
 * loan-officer productivity (portfolio size, PAR on their own book,
 * collection rate) for the SAME `agentId` — a staff member can be either
 * or both, so both slices are always computed and simply come back empty
 * for whichever role the user doesn't hold.
 */
async function getAgentProductivity(pool, { agentId, fromDate, toDate, requestingUser } = {}) {
  const scopedAgentId = resolveLoanOfficerScope(requestingUser, agentId);
  if (!scopedAgentId) throw new AnalyticsValidationError('agentId is required');
  if (!fromDate || !toDate) throw new AnalyticsValidationError('fromDate and toDate are required');

  const commissionSummary = await susuService.getAgentCommissionSummary(pool, { agentId: scopedAgentId, from: fromDate, to: toDate });

  const { rows: collectionRows } = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_pesewas), 0)::bigint AS total
       FROM susu_collections WHERE agent_id = $1 AND collection_date >= $2 AND collection_date <= $3`,
    [scopedAgentId, fromDate, toDate]
  );
  const { rows: susuBookRows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM susu_accounts WHERE assigned_agent_id = $1 AND status = 'active'",
    [scopedAgentId]
  );

  const loanBook = await getLoanBookSnapshot(pool, { asOfDate: toDate, loanOfficerId: scopedAgentId });
  const outstandingPesewas = loanBook.reduce((s, l) => s + l.outstandingPrincipalPesewas, 0);
  const par30Pesewas = loanBook.filter((l) => l.daysOverdue >= 30).reduce((s, l) => s + l.outstandingPrincipalPesewas, 0);

  const { rows: dueRows } = await pool.query(
    `SELECT COALESCE(SUM(ls.principal_due_pesewas + ls.interest_due_pesewas + ls.fees_due_pesewas), 0)::bigint AS total
       FROM loan_schedules ls
       JOIN loans l ON l.id = ls.loan_id AND ls.schedule_version = l.current_schedule_version
      WHERE l.applied_by = $1 AND ls.due_date >= $2 AND ls.due_date <= $3`,
    [scopedAgentId, fromDate, toDate]
  );
  const { rows: collectedRows } = await pool.query(
    `SELECT COALESCE(SUM(lr.amount_pesewas), 0)::bigint AS total
       FROM loan_repayments lr JOIN loans l ON l.id = lr.loan_id
      WHERE l.applied_by = $1 AND lr.payment_date >= $2 AND lr.payment_date <= $3`,
    [scopedAgentId, fromDate, toDate]
  );
  const duePesewas = Number(dueRows[0].total);
  const collectedPesewas = Number(collectedRows[0].total);

  return {
    agentId: scopedAgentId,
    fromDate,
    toDate,
    susu: {
      activePortfolioSize: susuBookRows[0].count,
      collections: { count: collectionRows[0].count, totalPesewas: Number(collectionRows[0].total) },
      commissions: commissionSummary,
    },
    loanOfficer: {
      activeLoanCount: loanBook.length,
      outstandingPesewas,
      par30Pesewas,
      par30Ratio: outstandingPesewas > 0 ? par30Pesewas / outstandingPesewas : null,
      scheduledDuePesewas: duePesewas,
      collectedPesewas,
      collectionRate: duePesewas > 0 ? collectedPesewas / duePesewas : null,
    },
  };
}

// --- Social performance summary -----------------------------------------------

/**
 * Standard microfinance outreach figures this schema can actually
 * support (active customer/borrower counts, gender split, susu
 * participation, average loan size, a sector breakdown of active
 * borrowers) — the module prompt's own "social performance" term is
 * otherwise undefined, so this doesn't invent a metric beyond what's
 * derivable. Extracted as its own function (not inlined into
 * `generateExecutiveReportPack`) since Module 8's own donor/investor-
 * facing compliance reporting needs the exact same figures — see
 * Decisions_Log.md.
 */
async function getSocialPerformanceSummary(pool, { branchId = null } = {}) {
  const params = branchId ? [branchId] : [];
  const branchClause = branchId ? 'AND branch_id = $1' : '';

  const { rows: customerRows } = await pool.query(
    `SELECT gender, COUNT(*)::int AS count FROM customers WHERE status = 'active' ${branchClause} GROUP BY gender`,
    params
  );
  const { rows: susuParticipationRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM susu_accounts WHERE status = 'active' ${branchId ? 'AND branch_id = $1' : ''}`,
    params
  );
  const { rows: borrowerRows } = await pool.query(
    `SELECT COUNT(DISTINCT customer_id)::int AS borrower_count,
            COUNT(*)::int AS loan_count,
            COALESCE(AVG(principal_pesewas), 0)::bigint AS avg_principal_pesewas
       FROM loans WHERE status IN ('disbursed', 'paying', 'missed_payment') ${branchClause}`,
    params
  );
  const { rows: sectorRows } = await pool.query(
    `SELECT COALESCE(c.classification, 'unspecified') AS sector, COUNT(DISTINCT l.customer_id)::int AS borrower_count
       FROM loans l JOIN customers c ON c.id = l.customer_id
      WHERE l.status IN ('disbursed', 'paying', 'missed_payment') ${branchId ? 'AND l.branch_id = $1' : ''}
      GROUP BY sector ORDER BY borrower_count DESC`,
    params
  );

  return {
    branchId: branchId ? Number(branchId) : null,
    activeCustomersByGender: customerRows.map((r) => ({ gender: r.gender || 'unspecified', count: r.count })),
    activeSusuParticipants: susuParticipationRows[0].count,
    activeBorrowerCount: borrowerRows[0].borrower_count,
    averageLoanSizePesewas: Number(borrowerRows[0].avg_principal_pesewas),
    activeBorrowersBySector: sectorRows.map((r) => ({ sector: r.sector, borrowerCount: r.borrower_count })),
  };
}

// --- Executive report pack ----------------------------------------------------

/**
 * A single combined report: balance sheet + income statement (Module 7),
 * portfolio quality summary, and the social performance summary above.
 */
async function generateExecutiveReportPack(pool, { asOfDate = todayIso(), fromDate, toDate, branchId = null } = {}) {
  if (!fromDate || !toDate) throw new AnalyticsValidationError('fromDate and toDate are required');

  const [balanceSheet, incomeStatement, portfolioQuality, socialPerformance] = await Promise.all([
    glService.getBalanceSheet(pool, { asOfDate, branchId }),
    glService.getIncomeStatement(pool, { fromDate, toDate, branchId }),
    getPortfolioQuality(pool, { asOfDate, branchId }),
    getSocialPerformanceSummary(pool, { branchId }),
  ]);

  return {
    asOfDate,
    fromDate,
    toDate,
    branchId: branchId ? Number(branchId) : null,
    balanceSheet,
    incomeStatement,
    portfolioSummary: {
      loanCount: portfolioQuality.loanCount,
      totalOutstandingPesewas: portfolioQuality.totalOutstandingPesewas,
      par30: portfolioQuality.par30,
      par60: portfolioQuality.par60,
      par90: portfolioQuality.par90,
    },
    socialPerformance,
  };
}

// --- Dashboard widget config CRUD --------------------------------------------

const KNOWN_WIDGET_KEYS = new Set([
  'live_cash_position',
  'live_noncash_volume',
  'live_todays_disbursements',
  'live_todays_collections',
  'live_branch_snapshot_grid',
  'portfolio_par',
  'portfolio_aging',
  'portfolio_largest_exposures',
  'profitability_cost_to_income',
  'profitability_oss',
  'profitability_branch_pl',
  'growth_customer_recruitment',
  'growth_disbursement_trend',
  'growth_deposit_growth',
  'growth_sector_analysis',
  'agent_productivity',
]);

async function listWidgetConfigs(pool, { roleId } = {}) {
  const params = [];
  let where = '';
  if (roleId) {
    params.push(roleId);
    where = `WHERE role_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM dashboard_widget_configs ${where} ORDER BY role_id, position`,
    params
  );
  return rows;
}

async function upsertWidgetConfig(pool, { roleId, widgetKey, position = 0, visible = true, updatedBy, actorBranchId }) {
  if (!roleId || !widgetKey || !updatedBy || !actorBranchId) {
    throw new AnalyticsValidationError('roleId, widgetKey, updatedBy, and actorBranchId are required');
  }
  if (!KNOWN_WIDGET_KEYS.has(widgetKey)) {
    throw new AnalyticsValidationError(`unknown widgetKey '${widgetKey}'; must be one of ${[...KNOWN_WIDGET_KEYS].join(', ')}`);
  }

  const { rows: beforeRows } = await pool.query(
    'SELECT * FROM dashboard_widget_configs WHERE role_id = $1 AND widget_key = $2',
    [roleId, widgetKey]
  );
  const before = beforeRows[0] || null;

  const { rows } = await pool.query(
    `INSERT INTO dashboard_widget_configs (role_id, widget_key, position, visible, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (role_id, widget_key)
     DO UPDATE SET position = EXCLUDED.position, visible = EXCLUDED.visible, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [roleId, widgetKey, position, visible, updatedBy]
  );
  const config = rows[0];

  await auditLog.record(pool, {
    userId: updatedBy,
    branchId: actorBranchId,
    action: before ? 'analytics.dashboard_config_updated' : 'analytics.dashboard_config_created',
    entityType: 'dashboard_widget_config',
    entityId: config.id,
    beforeState: before,
    afterState: config,
  });

  return config;
}

async function deleteWidgetConfig(pool, { configId, deletedBy, actorBranchId }) {
  if (!deletedBy || !actorBranchId) throw new AnalyticsValidationError('deletedBy and actorBranchId are required');

  const { rows: beforeRows } = await pool.query('SELECT * FROM dashboard_widget_configs WHERE id = $1', [configId]);
  const before = beforeRows[0];
  if (!before) throw new AnalyticsNotFoundError(`dashboard_widget_config ${configId} not found`);

  await pool.query('DELETE FROM dashboard_widget_configs WHERE id = $1', [configId]);

  await auditLog.record(pool, {
    userId: deletedBy,
    branchId: actorBranchId,
    action: 'analytics.dashboard_config_deleted',
    entityType: 'dashboard_widget_config',
    entityId: configId,
    beforeState: before,
  });

  return { deleted: true };
}

module.exports = {
  getLiveStats,
  getLoanBookSnapshot,
  getPortfolioQuality,
  getProfitability,
  getTopLoanCustomersByRevenue,
  getGrowthTrends,
  getRepaymentBreakdown,
  getAgentProductivity,
  getSocialPerformanceSummary,
  generateExecutiveReportPack,
  listWidgetConfigs,
  upsertWidgetConfig,
  deleteWidgetConfig,
  resolveLoanOfficerScope,
  KNOWN_WIDGET_KEYS,
  AnalyticsValidationError,
  AnalyticsNotFoundError,
};
