'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const investmentService = require('../modules/investment/investmentService');

// Route order: fixed-prefix paths (/products, /payout-requests/:id/settle,
// /redemption-requests/:id/confirm) are registered before the /:id
// catch-all — see Decisions_Log.md's route ordering rule.
function investmentsRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Products -----------------------------------------------------------

  router.get(
    '/products',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await investmentService.listInvestmentProducts(pool, { status: req.query.status }));
    })
  );

  router.post(
    '/products',
    auth,
    requirePermission('investment.manage_products'),
    asyncHandler(async (req, res) => {
      const product = await investmentService.createInvestmentProduct(pool, { ...req.body, createdBy: req.user.id });
      res.status(201).json(product);
    })
  );

  router.get(
    '/products/:productId',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await investmentService.getInvestmentProduct(pool, req.params.productId));
    })
  );

  // --- Payout / redemption settlement (fixed prefixes) --------------------

  router.post(
    '/payout-requests/:payoutId/settle',
    auth,
    requirePermission('investment.request_payout'),
    asyncHandler(async (req, res) => {
      const { paymentReference } = req.body || {};
      const result = await investmentService.settleApprovedInvestmentPayout(pool, {
        payoutId: req.params.payoutId,
        paymentReference,
        paidBy: req.user.id,
      });
      res.json(result);
    })
  );

  router.post(
    '/redemption-requests/:redemptionId/confirm',
    auth,
    requirePermission('investment.request_redemption'),
    asyncHandler(async (req, res) => {
      const { paymentReference } = req.body || {};
      const result = await investmentService.confirmRedemptionPayout(pool, {
        redemptionId: req.params.redemptionId,
        paymentReference,
        confirmedBy: req.user.id,
      });
      res.json(result);
    })
  );

  // --- Investment lifecycle ------------------------------------------------

  router.get(
    '/',
    auth,
    asyncHandler(async (req, res) => {
      const { customerId, branchId, status, productId } = req.query;
      res.json(
        await investmentService.listInvestments(pool, {
          customerId: customerId ? Number(customerId) : undefined,
          branchId: branchId ? Number(branchId) : undefined,
          status,
          productId: productId ? Number(productId) : undefined,
        })
      );
    })
  );

  router.post(
    '/',
    auth,
    requirePermission('investment.book'),
    asyncHandler(async (req, res) => {
      const result = await investmentService.bookInvestment(pool, { ...req.body, appliedBy: req.user.id });
      res.status(201).json(result);
    })
  );

  router.get(
    '/:id',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await investmentService.getInvestment(pool, req.params.id));
    })
  );

  router.post(
    '/:id/activate',
    auth,
    requirePermission('investment.activate'),
    asyncHandler(async (req, res) => {
      const { startDate } = req.body || {};
      const result = await investmentService.activateInvestment(pool, {
        investmentId: req.params.id,
        activatedBy: req.user.id,
        startDate,
      });
      res.json(result);
    })
  );

  router.post(
    '/:id/accrue-interest',
    auth,
    requirePermission('investment.accrue_interest'),
    asyncHandler(async (req, res) => {
      const { accrualDate, days } = req.body || {};
      const result = await investmentService.accrueInterest(pool, {
        investmentId: req.params.id,
        accrualDate,
        days,
        accruedBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.get(
    '/:id/statement',
    auth,
    requirePermission('investment.view'),
    asyncHandler(async (req, res) => {
      res.json(await investmentService.getInvestorStatement(pool, { investmentId: req.params.id }));
    })
  );

  router.post(
    '/:id/payout-requests',
    auth,
    requirePermission('investment.request_payout'),
    asyncHandler(async (req, res) => {
      const { amountPesewas } = req.body || {};
      const result = await investmentService.requestInvestmentPayout(pool, {
        investmentId: req.params.id,
        amountPesewas,
        requestedBy: req.user.id,
      });
      res.status(202).json(result);
    })
  );

  router.post(
    '/:id/redemption-requests',
    auth,
    requirePermission('investment.request_redemption'),
    asyncHandler(async (req, res) => {
      const { redemptionDate } = req.body || {};
      const result = await investmentService.requestRedemption(pool, {
        investmentId: req.params.id,
        redemptionDate,
        requestedBy: req.user.id,
      });
      res.status(202).json(result);
    })
  );

  return router;
}

module.exports = { investmentsRouter };
