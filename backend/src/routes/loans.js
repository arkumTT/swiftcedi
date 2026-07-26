'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, canAccessBranch } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const loanService = require('../modules/loan/loanService');

// Route order: fixed-prefix paths (/products, /calculator, /reports/...)
// are registered before the /:id catch-all — see Decisions_Log.md's route
// ordering rule.
function loansRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Products ---------------------------------------------------------

  router.get(
    '/products',
    auth,
    asyncHandler(async (req, res) => {
      const { loanType, status } = req.query;
      res.json(await loanService.listLoanProducts(pool, { loanType, status }));
    })
  );

  router.post(
    '/products',
    auth,
    requirePermission('loan.manage_products'),
    asyncHandler(async (req, res) => {
      const product = await loanService.createLoanProduct(pool, { ...req.body, createdBy: req.user.id });
      res.status(201).json(product);
    })
  );

  router.get(
    '/products/:productId',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await loanService.getLoanProduct(pool, req.params.productId));
    })
  );

  // --- Calculator (no commitment, creates nothing) ----------------------

  router.post(
    '/calculator',
    auth,
    asyncHandler(async (req, res) => {
      const { productId, principalPesewas, termMonths, startDate } = req.body || {};
      res.json(await loanService.calculateLoan(pool, { productId, principalPesewas, termMonths, startDate }));
    })
  );

  // --- Reports -----------------------------------------------------------

  router.get(
    '/reports/arrears',
    auth,
    requirePermission('loan.view_reports'),
    asyncHandler(async (req, res) => {
      const branchId = req.query.branchId ? Number(req.query.branchId) : null;
      if (branchId && !canAccessBranch(req, branchId)) {
        return res.status(403).json({ error: `not permitted to view loan reports for branch ${branchId}` });
      }
      res.json(await loanService.getArrearsReport(pool, { branchId, asOfDate: req.query.asOfDate || undefined }));
    })
  );

  // --- Loan lifecycle ------------------------------------------------------

  router.get(
    '/',
    auth,
    asyncHandler(async (req, res) => {
      const { branchId, customerId, status, productId } = req.query;
      res.json(
        await loanService.listLoans(pool, {
          branchId: branchId ? Number(branchId) : undefined,
          customerId: customerId ? Number(customerId) : undefined,
          status,
          productId: productId ? Number(productId) : undefined,
        })
      );
    })
  );

  router.post(
    '/',
    auth,
    requirePermission('loan.apply'),
    asyncHandler(async (req, res) => {
      const loan = await loanService.applyForLoan(pool, { ...req.body, appliedBy: req.user.id });
      res.status(201).json(loan);
    })
  );

  router.get(
    '/:id',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await loanService.getLoan(pool, req.params.id));
    })
  );

  router.post(
    '/:id/appraisals',
    auth,
    requirePermission('loan.appraise'),
    asyncHandler(async (req, res) => {
      const { checklist, recommendation, notes } = req.body || {};
      const result = await loanService.submitAppraisal(pool, {
        loanId: req.params.id,
        checklist,
        recommendation,
        notes,
        appraiserId: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/:id/approval-requests',
    auth,
    requirePermission('loan.request_approval'),
    asyncHandler(async (req, res) => {
      const approvalRequest = await loanService.requestLoanApproval(pool, {
        loanId: req.params.id,
        requestedBy: req.user.id,
      });
      res.status(202).json(approvalRequest);
    })
  );

  router.post(
    '/:id/disburse',
    auth,
    requirePermission('loan.disburse'),
    asyncHandler(async (req, res) => {
      const { disbursementDate } = req.body || {};
      const loan = await loanService.disburseLoan(pool, {
        loanId: req.params.id,
        disbursedBy: req.user.id,
        disbursementDate,
      });
      res.json(loan);
    })
  );

  // --- Overdraft servicing --------------------------------------------------

  router.get(
    '/:id/overdraft-status',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await loanService.getOverdraftStatus(pool, { loanId: req.params.id }));
    })
  );

  router.post(
    '/:id/overdraft/accrue-interest',
    auth,
    requirePermission('loan.accrue_overdraft_interest'),
    asyncHandler(async (req, res) => {
      const { accrualDate, days } = req.body || {};
      const result = await loanService.accrueOverdraftInterest(pool, {
        loanId: req.params.id,
        accrualDate,
        days,
        accruedBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/:id/overdraft/close',
    auth,
    requirePermission('loan.close_overdraft'),
    asyncHandler(async (req, res) => {
      const loan = await loanService.closeOverdraft(pool, { loanId: req.params.id, closedBy: req.user.id });
      res.json(loan);
    })
  );

  router.get(
    '/:id/schedule',
    auth,
    asyncHandler(async (req, res) => {
      const scheduleVersion = req.query.scheduleVersion ? Number(req.query.scheduleVersion) : null;
      res.json(await loanService.getLoanSchedule(pool, { loanId: req.params.id, scheduleVersion }));
    })
  );

  router.get(
    '/:id/repayments',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await loanService.listRepayments(pool, { loanId: req.params.id }));
    })
  );

  router.post(
    '/:id/repayments',
    auth,
    requirePermission('loan.post_repayment'),
    asyncHandler(async (req, res) => {
      const { amountPesewas, paymentDate } = req.body || {};
      const result = await loanService.postRepayment(pool, {
        loanId: req.params.id,
        amountPesewas,
        paymentDate,
        receivedBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/:id/restructure-requests',
    auth,
    requirePermission('loan.restructure'),
    asyncHandler(async (req, res) => {
      const { newTermMonths, newAnnualInterestRateBps, reason } = req.body || {};
      const restructure = await loanService.requestRestructure(pool, {
        loanId: req.params.id,
        newTermMonths,
        newAnnualInterestRateBps,
        reason,
        requestedBy: req.user.id,
      });
      res.status(202).json(restructure);
    })
  );

  router.post(
    '/:id/write-off',
    auth,
    requirePermission('loan.write_off'),
    asyncHandler(async (req, res) => {
      const { reason, writeOffDate } = req.body || {};
      const loan = await loanService.writeOffLoan(pool, {
        loanId: req.params.id,
        reason,
        writeOffDate,
        writtenOffBy: req.user.id,
      });
      res.json(loan);
    })
  );

  // --- Collateral & guarantors ---------------------------------------------

  router.get(
    '/:id/collateral',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await loanService.listCollateral(pool, { loanId: req.params.id }));
    })
  );

  router.post(
    '/:id/collateral',
    auth,
    requirePermission('loan.manage_collateral'),
    asyncHandler(async (req, res) => {
      const { description, estimatedValuePesewas } = req.body || {};
      const collateral = await loanService.addCollateral(pool, {
        loanId: req.params.id,
        description,
        estimatedValuePesewas,
        createdBy: req.user.id,
      });
      res.status(201).json(collateral);
    })
  );

  router.post(
    '/:id/collateral/:collateralId/verify',
    auth,
    requirePermission('loan.manage_collateral'),
    asyncHandler(async (req, res) => {
      const { verificationStatus } = req.body || {};
      const collateral = await loanService.verifyCollateral(pool, {
        collateralId: req.params.collateralId,
        verificationStatus,
        verifiedBy: req.user.id,
      });
      res.json(collateral);
    })
  );

  router.get(
    '/:id/guarantors',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await loanService.listGuarantors(pool, { loanId: req.params.id }));
    })
  );

  router.post(
    '/:id/guarantors',
    auth,
    requirePermission('loan.manage_guarantors'),
    asyncHandler(async (req, res) => {
      const { customerId, guarantorName, guarantorPhone, guaranteedAmountPesewas } = req.body || {};
      const guarantor = await loanService.addGuarantor(pool, {
        loanId: req.params.id,
        customerId,
        guarantorName,
        guarantorPhone,
        guaranteedAmountPesewas,
        createdBy: req.user.id,
      });
      res.status(201).json(guarantor);
    })
  );

  return router;
}

module.exports = { loansRouter };
