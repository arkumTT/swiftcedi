'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const cashierService = require('../modules/cashier/cashierService');
const glPosting = require('../shared/glPosting');

// Unlike loans/savings/investments, this router has no single primary
// resource and therefore no generic `/:id` catch-all at its root — every
// route has an explicit resource-type prefix (tills, cashback-requests,
// reversals, close-outs, cash-position, prior-period-adjustments), so the
// usual fixed-prefix-before-`/:id` ordering concern doesn't apply here.
function cashierRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Tills ----------------------------------------------------------------

  router.get(
    '/tills',
    auth,
    asyncHandler(async (req, res) => {
      const { branchId, cashierId, status } = req.query;
      res.json(
        await cashierService.listTills(pool, {
          branchId: branchId ? Number(branchId) : undefined,
          cashierId: cashierId ? Number(cashierId) : undefined,
          status,
        })
      );
    })
  );

  router.post(
    '/tills',
    auth,
    requirePermission('cashier.till_open'),
    asyncHandler(async (req, res) => {
      const till = await cashierService.openTill(pool, { ...req.body, openedBy: req.user.id });
      res.status(201).json(till);
    })
  );

  router.get(
    '/tills/:id',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await cashierService.getTill(pool, req.params.id));
    })
  );

  router.post(
    '/tills/:id/close',
    auth,
    requirePermission('cashier.till_close'),
    asyncHandler(async (req, res) => {
      const { closingBalancePesewas, denominationBreakdownClose } = req.body || {};
      const result = await cashierService.closeTill(pool, {
        tillId: req.params.id,
        closingBalancePesewas,
        denominationBreakdownClose,
        closedBy: req.user.id,
      });
      res.json(result);
    })
  );

  router.post(
    '/tills/:id/cashback-requests',
    auth,
    requirePermission('cashier.request_cashback'),
    asyncHandler(async (req, res) => {
      const { amountPesewas } = req.body || {};
      const result = await cashierService.requestCashBack(pool, {
        tillId: req.params.id,
        amountPesewas,
        requestedBy: req.user.id,
      });
      res.status(202).json(result);
    })
  );

  // --- Cash-back settlement ---------------------------------------------------

  router.post(
    '/cashback-requests/:id/settle',
    auth,
    requirePermission('cashier.request_cashback'),
    asyncHandler(async (req, res) => {
      const result = await cashierService.settleApprovedCashBack(pool, {
        cashBackRequestId: req.params.id,
        paidBy: req.user.id,
      });
      res.json(result);
    })
  );

  // --- Reversals ---------------------------------------------------------------

  router.post(
    '/reversals',
    auth,
    requirePermission('cashier.request_reversal'),
    asyncHandler(async (req, res) => {
      const { originalJournalEntryId, reasonCode, notes } = req.body || {};
      const result = await cashierService.requestReversal(pool, {
        originalJournalEntryId,
        reasonCode,
        notes,
        requestedBy: req.user.id,
      });
      res.status(202).json(result);
    })
  );

  router.post(
    '/reversals/:id/execute',
    auth,
    requirePermission('cashier.request_reversal'),
    asyncHandler(async (req, res) => {
      const result = await cashierService.executeApprovedReversal(pool, {
        reversalId: req.params.id,
        executedBy: req.user.id,
      });
      res.json(result);
    })
  );

  // --- Close-out (day/month/year) -----------------------------------------------

  router.get(
    '/close-outs',
    auth,
    requirePermission('cashier.view'),
    asyncHandler(async (req, res) => {
      const { branchId, periodType } = req.query;
      res.json(
        await cashierService.listCloseSnapshots(pool, {
          branchId: branchId ? Number(branchId) : undefined,
          periodType,
        })
      );
    })
  );

  router.post(
    '/close-outs',
    auth,
    requirePermission('cashier.close_out'),
    asyncHandler(async (req, res) => {
      const { branchId, periodType, periodStart, periodEnd } = req.body || {};
      const result = await cashierService.closeOutPeriod(pool, {
        branchId,
        periodType,
        periodStart,
        periodEnd,
        closedBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  // --- Cash position reporting ---------------------------------------------------

  router.get(
    '/cash-position',
    auth,
    requirePermission('cashier.view'),
    asyncHandler(async (req, res) => {
      res.json(await cashierService.getConsolidatedCashPosition(pool));
    })
  );

  router.get(
    '/cash-position/:branchId',
    auth,
    requirePermission('cashier.view'),
    asyncHandler(async (req, res) => {
      res.json(await cashierService.getBranchCashPosition(pool, req.params.branchId));
    })
  );

  // --- Prior-period adjustments (shared glPosting.js primitive) -----------------

  router.post(
    '/prior-period-adjustments',
    auth,
    requirePermission('cashier.adjust_prior_period'),
    asyncHandler(async (req, res) => {
      const { branchId, entryDate, description, lines } = req.body || {};
      const result = await glPosting.requestPriorPeriodAdjustment(pool, {
        branchId,
        entryDate,
        description,
        lines,
        requestedBy: req.user.id,
      });
      res.status(202).json(result);
    })
  );

  router.post(
    '/prior-period-adjustments/:id/post',
    auth,
    requirePermission('cashier.adjust_prior_period'),
    asyncHandler(async (req, res) => {
      const result = await glPosting.postApprovedPriorPeriodAdjustment(pool, {
        adjustmentId: req.params.id,
        postedBy: req.user.id,
      });
      res.json(result);
    })
  );

  return router;
}

module.exports = { cashierRouter };
