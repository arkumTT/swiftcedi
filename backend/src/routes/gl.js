'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const glPosting = require('../shared/glPosting');
const glService = require('../modules/gl/glService');

// Route order: fixed-prefix paths (/accounts/rollup, /reports/..., /manual-
// entries/:id/post, /bank-accounts/:id/statement-lines) are registered
// before any /:id catch-all — see Decisions_Log.md's route ordering rule.
function glRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Chart of accounts ---------------------------------------------------

  router.get(
    '/accounts',
    auth,
    asyncHandler(async (req, res) => {
      const { branchId, accountType, status } = req.query;
      res.json(await glService.listGlAccounts(pool, { branchId, accountType, status }));
    })
  );

  router.post(
    '/accounts',
    auth,
    requirePermission('gl.manage_accounts'),
    asyncHandler(async (req, res) => {
      const { code, name, accountType, branchId, parentAccountId } = req.body || {};
      const account = await glService.createGlAccount(pool, {
        code,
        name,
        accountType,
        branchId: branchId || null,
        parentAccountId: parentAccountId || null,
        createdBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.status(201).json(account);
    })
  );

  router.patch(
    '/accounts/:id',
    auth,
    requirePermission('gl.manage_accounts'),
    asyncHandler(async (req, res) => {
      const account = await glService.updateGlAccount(pool, {
        accountId: req.params.id,
        updatedBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
        fields: req.body || {},
      });
      res.json(account);
    })
  );

  router.get(
    '/accounts/:id/balance',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { asOfDate, branchId } = req.query;
      const balancePesewas = await glPosting.getAccountBalance(pool, {
        accountId: req.params.id,
        asOfDate: asOfDate || null,
        branchId: branchId || null,
      });
      res.json({ accountId: Number(req.params.id), asOfDate: asOfDate || null, balancePesewas });
    })
  );

  // --- Journal entries ------------------------------------------------------

  // The closest thing to a unified transaction ledger — every module's
  // financial action posts through glPosting, so this lists across all of
  // them at once. Powers the frontend's Transactions screen and dashboard
  // recent-activity widget. Registered before POST /journal-entries only
  // for readability; there's no /:id catch-all here to worry about.
  router.get(
    '/journal-entries',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { branchId, sourceModule, fromDate, toDate, limit, offset } = req.query;
      res.json(await glService.listJournalEntries(pool, { branchId, sourceModule, fromDate, toDate, limit, offset }));
    })
  );

  router.post(
    '/journal-entries',
    auth,
    requirePermission('gl.post_journal'),
    asyncHandler(async (req, res) => {
      const { reference, description, entryDate, sourceModule, entryType, lines, approvedBy } = req.body || {};
      const result = await glPosting.postJournalEntry(pool, {
        branchId: req.user.homeBranchId,
        reference,
        description,
        entryDate,
        sourceModule: sourceModule || 'manual_jv',
        createdBy: req.user.id,
        approvedBy: approvedBy || null,
        entryType: entryType || 'standard',
        lines,
      });
      res.status(201).json(result);
    })
  );

  // --- Manual JV (maker-checker) --------------------------------------------

  router.post(
    '/manual-entries',
    auth,
    requirePermission('gl.request_manual_jv'),
    asyncHandler(async (req, res) => {
      const { branchId, entryDate, description, lines } = req.body || {};
      const result = await glService.requestManualJournalEntry(pool, {
        branchId: branchId || req.user.homeBranchId,
        entryDate,
        description,
        lines,
        requestedBy: req.user.id,
      });
      res.status(202).json(result);
    })
  );

  router.post(
    '/manual-entries/:id/post',
    auth,
    requirePermission('gl.post_journal'),
    asyncHandler(async (req, res) => {
      const result = await glService.postApprovedManualJournalEntry(pool, {
        entryId: req.params.id,
        postedBy: req.user.id,
      });
      res.json(result);
    })
  );

  // --- Reports ---------------------------------------------------------------

  router.get(
    '/reports/trial-balance',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { asOfDate, branchId } = req.query;
      res.json(await glService.getTrialBalance(pool, { asOfDate, branchId: branchId || null }));
    })
  );

  router.get(
    '/reports/balance-sheet',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { asOfDate, branchId } = req.query;
      res.json(await glService.getBalanceSheet(pool, { asOfDate, branchId: branchId || null }));
    })
  );

  router.get(
    '/reports/income-statement',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { fromDate, toDate, branchId } = req.query;
      res.json(await glService.getIncomeStatement(pool, { fromDate, toDate, branchId: branchId || null }));
    })
  );

  router.get(
    '/reports/daily-balance-summary',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { date, branchId } = req.query;
      res.json(await glService.getDailyBalanceSummary(pool, { date, branchId: branchId || null }));
    })
  );

  router.get(
    '/reports/annual-transactions',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { year, branchId } = req.query;
      res.json(await glService.getAnnualTransactionReport(pool, { year: Number(year), branchId: branchId || null }));
    })
  );

  // --- Bank reconciliation ----------------------------------------------------

  router.get(
    '/bank-accounts',
    auth,
    requirePermission('gl.reconcile_bank'),
    asyncHandler(async (req, res) => {
      const { branchId, status } = req.query;
      res.json(await glService.listBankAccounts(pool, { branchId, status }));
    })
  );

  router.post(
    '/bank-accounts',
    auth,
    requirePermission('gl.manage_accounts'),
    asyncHandler(async (req, res) => {
      const { glAccountId, branchId, bankName, accountNumber } = req.body || {};
      const bankAccount = await glService.createBankAccount(pool, {
        glAccountId,
        branchId: branchId || null,
        bankName,
        accountNumber,
        createdBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.status(201).json(bankAccount);
    })
  );

  router.post(
    '/bank-accounts/:id/statement-lines',
    auth,
    requirePermission('gl.reconcile_bank'),
    asyncHandler(async (req, res) => {
      const { lines } = req.body || {};
      const result = await glService.importStatementLines(pool, {
        bankAccountId: req.params.id,
        lines,
        uploadedBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/statement-lines/:id/match',
    auth,
    requirePermission('gl.reconcile_bank'),
    asyncHandler(async (req, res) => {
      const { journalLineId } = req.body || {};
      const result = await glService.matchStatementLine(pool, {
        statementLineId: req.params.id,
        journalLineId,
        matchedBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.json(result);
    })
  );

  router.get(
    '/bank-accounts/:id/reconciliation',
    auth,
    requirePermission('gl.reconcile_bank'),
    asyncHandler(async (req, res) => {
      const { asOfDate } = req.query;
      const params = { bankAccountId: req.params.id };
      if (asOfDate) params.asOfDate = asOfDate;
      res.json(await glService.getBankReconciliation(pool, params));
    })
  );

  return router;
}

module.exports = { glRouter };
