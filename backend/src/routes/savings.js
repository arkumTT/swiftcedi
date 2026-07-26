'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, canAccessBranch } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const savingsService = require('../modules/savings/savingsService');
const standingOrderService = require('../modules/savings/standingOrderService');

// Fixed-prefix paths before the /:id catch-all — see Decisions_Log.md's
// route ordering rule.
function savingsRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Products ----------------------------------------------------------

  router.get(
    '/products',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await savingsService.listSavingsProducts(pool, { status: req.query.status }));
    })
  );

  router.post(
    '/products',
    auth,
    requirePermission('savings.manage_products'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await savingsService.createSavingsProduct(pool, { ...req.body, createdBy: req.user.id }));
    })
  );

  // --- Standing orders (mounted under /savings so they stay with accounts) ---

  router.get(
    '/standing-orders',
    auth,
    asyncHandler(async (req, res) => {
      const sourceAccountId = req.query.sourceAccountId ? Number(req.query.sourceAccountId) : undefined;
      res.json(await standingOrderService.listStandingOrders(pool, { sourceAccountId, status: req.query.status }));
    })
  );

  router.post(
    '/standing-orders',
    auth,
    requirePermission('standing_order.manage'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await standingOrderService.createStandingOrder(pool, { ...req.body, createdBy: req.user.id }));
    })
  );

  router.get(
    '/standing-orders/failures',
    auth,
    requirePermission('standing_order.manage'),
    asyncHandler(async (req, res) => {
      res.json(await standingOrderService.listUnnotifiedFailures(pool));
    })
  );

  // Scheduler-facing (Module 12 will call this on a cron).
  router.post(
    '/standing-orders/execute-due',
    auth,
    requirePermission('standing_order.execute'),
    asyncHandler(async (req, res) => {
      const { asOfDate, limit } = req.body || {};
      res.json(await standingOrderService.executeDueOrders(pool, { asOfDate, limit, executedBy: req.user.id }));
    })
  );

  router.get(
    '/standing-orders/:orderId',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await standingOrderService.getStandingOrder(pool, req.params.orderId));
    })
  );

  router.get(
    '/standing-orders/:orderId/runs',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await standingOrderService.listRuns(pool, { standingOrderId: req.params.orderId, status: req.query.status }));
    })
  );

  router.post(
    '/standing-orders/:orderId/status',
    auth,
    requirePermission('standing_order.manage'),
    asyncHandler(async (req, res) => {
      const { status } = req.body || {};
      res.json(
        await standingOrderService.setStandingOrderStatus(pool, {
          standingOrderId: req.params.orderId,
          status,
          actorId: req.user.id,
        })
      );
    })
  );

  router.post(
    '/standing-orders/:orderId/execute',
    auth,
    requirePermission('standing_order.execute'),
    asyncHandler(async (req, res) => {
      const { runDate } = req.body || {};
      res.json(
        await standingOrderService.executeOrder(pool, {
          standingOrderId: req.params.orderId,
          runDate,
          executedBy: req.user.id,
        })
      );
    })
  );

  // --- Withdrawal requests (top-level: settling an approved one) ------------

  router.post(
    '/withdrawal-requests/:requestId/settle',
    auth,
    requirePermission('savings.withdraw'),
    asyncHandler(async (req, res) => {
      const { entryDate } = req.body || {};
      res.json(
        await savingsService.settleApprovedWithdrawal(pool, {
          withdrawalRequestId: req.params.requestId,
          paidBy: req.user.id,
          entryDate,
        })
      );
    })
  );

  // --- Branch reconciliation -------------------------------------------------

  router.get(
    '/reconciliation/branch/:branchId',
    auth,
    requirePermission('savings.view'),
    asyncHandler(async (req, res) => {
      if (!canAccessBranch(req, req.params.branchId)) {
        return res.status(403).json({ error: `not permitted to view reconciliation for branch ${req.params.branchId}` });
      }
      res.json(await savingsService.reconcileBranchDeposits(pool, { branchId: req.params.branchId }));
    })
  );

  // --- Accounts ---------------------------------------------------------------

  router.get(
    '/',
    auth,
    requirePermission('savings.view'),
    asyncHandler(async (req, res) => {
      const { customerId, branchId, status } = req.query;
      res.json(
        await savingsService.listAccounts(pool, {
          customerId: customerId ? Number(customerId) : undefined,
          branchId: branchId ? Number(branchId) : undefined,
          status,
        })
      );
    })
  );

  router.post(
    '/',
    auth,
    requirePermission('savings.open_account'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await savingsService.openAccount(pool, { ...req.body, createdBy: req.user.id }));
    })
  );

  router.get(
    '/:id',
    auth,
    requirePermission('savings.view'),
    asyncHandler(async (req, res) => {
      res.json(await savingsService.getAccount(pool, req.params.id));
    })
  );

  router.get(
    '/:id/statement',
    auth,
    requirePermission('savings.view'),
    asyncHandler(async (req, res) => {
      const { from, to, limit } = req.query;
      res.json(await savingsService.getStatement(pool, { accountId: req.params.id, from, to, limit }));
    })
  );

  router.get(
    '/:id/reconciliation',
    auth,
    requirePermission('savings.view'),
    asyncHandler(async (req, res) => {
      res.json(await savingsService.reconcileAccount(pool, { accountId: req.params.id }));
    })
  );

  router.post(
    '/:id/deposits',
    auth,
    requirePermission('savings.deposit'),
    asyncHandler(async (req, res) => {
      const { amountPesewas, description, idempotencyKey, entryDate } = req.body || {};
      const result = await savingsService.deposit(pool, {
        accountId: req.params.id,
        amountPesewas,
        description,
        idempotencyKey,
        entryDate,
        depositedBy: req.user.id,
      });
      res.status(result.idempotentReplay ? 200 : 201).json(result);
    })
  );

  router.post(
    '/:id/withdrawal-requests',
    auth,
    requirePermission('savings.withdraw'),
    asyncHandler(async (req, res) => {
      const { amountPesewas, entryDate } = req.body || {};
      const result = await savingsService.requestWithdrawal(pool, {
        accountId: req.params.id,
        amountPesewas,
        entryDate,
        requestedBy: req.user.id,
      });
      // Paid out immediately (below threshold) vs. queued for approval.
      res.status(result.paidOut ? 200 : 202).json(result);
    })
  );

  router.post(
    '/:id/charges',
    auth,
    requirePermission('savings.apply_charges'),
    asyncHandler(async (req, res) => {
      const { chargeTypes, entryDate } = req.body || {};
      res.json(
        await savingsService.applyCharges(pool, {
          accountId: req.params.id,
          chargeTypes,
          entryDate,
          appliedBy: req.user.id,
        })
      );
    })
  );

  router.post(
    '/:id/close',
    auth,
    requirePermission('savings.close_account'),
    asyncHandler(async (req, res) => {
      const { reason } = req.body || {};
      res.json(await savingsService.closeAccount(pool, { accountId: req.params.id, reason, closedBy: req.user.id }));
    })
  );

  return router;
}

module.exports = { savingsRouter };
