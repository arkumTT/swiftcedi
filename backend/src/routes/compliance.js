'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const complianceService = require('../modules/compliance/complianceService');

function complianceRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Loan classification (BOG categories) ------------------------------------

  router.get(
    '/loan-classification-configs',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.getActiveLoanClassificationConfig(pool, req.query.asOfDate));
    })
  );

  router.post(
    '/loan-classification-configs',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      const { categories, effectiveDate } = req.body || {};
      const result = await complianceService.createLoanClassificationConfigSet(pool, {
        categories,
        effectiveDate,
        createdBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/loan-classification/run',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      const { asOfDate, branchId } = req.body || {};
      const result = await complianceService.runLoanClassification(pool, { asOfDate, branchId, createdBy: req.user.id });
      res.status(201).json(result);
    })
  );

  router.get(
    '/loan-classification/summary',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      const { asOfDate, branchId } = req.query;
      res.json(await complianceService.getLoanClassificationSummary(pool, { asOfDate, branchId }));
    })
  );

  // --- Regulatory ratios (CAR, liquidity, etc.) --------------------------------

  router.post(
    '/ratio-definitions',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      const { name, numeratorGlCodes, denominatorGlCodes, minimumRatioBps, effectiveDate } = req.body || {};
      const result = await complianceService.createRatioDefinition(pool, {
        name,
        numeratorGlCodes,
        denominatorGlCodes,
        minimumRatioBps,
        effectiveDate,
        createdBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.get(
    '/ratio-definitions/:name',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.getActiveRatioDefinition(pool, { name: req.params.name, asOfDate: req.query.asOfDate }));
    })
  );

  router.get(
    '/ratios/:name/compute',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      const { asOfDate, branchId } = req.query;
      res.json(await complianceService.computeRatio(pool, { name: req.params.name, asOfDate, branchId }));
    })
  );

  // --- GRA tax reporting ---------------------------------------------------------

  router.post(
    '/tax-rates',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      const { taxType, rateBps, vatApplicableGlCodes, effectiveDate, description } = req.body || {};
      const result = await complianceService.createTaxRate(pool, {
        taxType,
        rateBps,
        vatApplicableGlCodes,
        effectiveDate,
        description,
        createdBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.get(
    '/tax-rates/:taxType',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.getActiveTaxRate(pool, { taxType: req.params.taxType, asOfDate: req.query.asOfDate }));
    })
  );

  router.get(
    '/tax/withholding-summary',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      const { periodStart, periodEnd, asOfDate } = req.query;
      res.json(await complianceService.getWithholdingTaxSummary(pool, { periodStart, periodEnd, asOfDate }));
    })
  );

  router.get(
    '/tax/vat-summary',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      const { periodStart, periodEnd, asOfDate, branchId } = req.query;
      res.json(await complianceService.getVatSummary(pool, { periodStart, periodEnd, asOfDate, branchId }));
    })
  );

  // --- Report templates (versioned) --------------------------------------------

  router.get(
    '/report-templates',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.listReportTemplates(pool, { name: req.query.name, status: req.query.status }));
    })
  );

  router.post(
    '/report-templates',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      const { name, targetAuthority, fieldMappings, effectiveDate } = req.body || {};
      const result = await complianceService.createReportTemplate(pool, {
        name,
        targetAuthority,
        fieldMappings,
        effectiveDate,
        createdBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.get(
    '/report-templates/:id',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.getReportTemplate(pool, req.params.id));
    })
  );

  router.patch(
    '/report-templates/:id/status',
    auth,
    requirePermission('compliance.manage_config'),
    asyncHandler(async (req, res) => {
      const { status } = req.body || {};
      const result = await complianceService.setReportTemplateStatus(pool, {
        templateId: req.params.id,
        status,
        updatedBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.json(result);
    })
  );

  // --- Report generation ---------------------------------------------------------

  router.post(
    '/reports/generate',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      const { templateId, periodStart, periodEnd, asOfDate, branchId } = req.body || {};
      const result = await complianceService.generateReport(pool, {
        templateId,
        periodStart,
        periodEnd,
        asOfDate,
        branchId,
        generatedBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/reports/:id/submit',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      const { fileReference } = req.body || {};
      const result = await complianceService.markReportSubmitted(pool, {
        submissionId: req.params.id,
        submittedBy: req.user.id,
        fileReference,
      });
      res.json(result);
    })
  );

  router.get(
    '/reports',
    auth,
    requirePermission('compliance.generate_reports'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.listReportSubmissions(pool, { templateId: req.query.templateId, status: req.query.status }));
    })
  );

  // --- AML monitoring -------------------------------------------------------------

  router.get(
    '/aml/rules',
    auth,
    requirePermission('compliance.manage_aml'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.listAmlRules(pool, { status: req.query.status }));
    })
  );

  router.post(
    '/aml/rules',
    auth,
    requirePermission('compliance.manage_aml'),
    asyncHandler(async (req, res) => {
      const { name, thresholdPesewas, transactionScope } = req.body || {};
      const result = await complianceService.createAmlRule(pool, { name, thresholdPesewas, transactionScope, createdBy: req.user.id });
      res.status(201).json(result);
    })
  );

  router.patch(
    '/aml/rules/:id/status',
    auth,
    requirePermission('compliance.manage_aml'),
    asyncHandler(async (req, res) => {
      const { status } = req.body || {};
      res.json(await complianceService.updateAmlRuleStatus(pool, { ruleId: req.params.id, status }));
    })
  );

  router.post(
    '/aml/screen',
    auth,
    requirePermission('compliance.manage_aml'),
    asyncHandler(async (req, res) => {
      const { fromDate, toDate } = req.body || {};
      res.status(201).json(await complianceService.runAmlScreening(pool, { fromDate, toDate }));
    })
  );

  router.get(
    '/aml/flags',
    auth,
    requirePermission('compliance.manage_aml'),
    asyncHandler(async (req, res) => {
      const { status, branchId, customerId } = req.query;
      res.json(await complianceService.listAmlFlags(pool, { status, branchId, customerId }));
    })
  );

  router.post(
    '/aml/flags/:id/review',
    auth,
    requirePermission('compliance.manage_aml'),
    asyncHandler(async (req, res) => {
      const { newStatus, reviewNotes } = req.body || {};
      const result = await complianceService.reviewAmlFlag(pool, {
        flagId: req.params.id,
        reviewedBy: req.user.id,
        newStatus,
        reviewNotes,
      });
      res.json(result);
    })
  );

  // --- Sanctions screening ---------------------------------------------------------

  router.get(
    '/sanctions/list-entries',
    auth,
    requirePermission('compliance.manage_sanctions'),
    asyncHandler(async (req, res) => {
      res.json(await complianceService.listSanctionsListEntries(pool));
    })
  );

  router.post(
    '/sanctions/list-entries',
    auth,
    requirePermission('compliance.manage_sanctions'),
    asyncHandler(async (req, res) => {
      const { fullName, listSource, notes } = req.body || {};
      const result = await complianceService.addSanctionsListEntry(pool, { fullName, listSource, notes, addedBy: req.user.id });
      res.status(201).json(result);
    })
  );

  router.post(
    '/sanctions/screen',
    auth,
    requirePermission('compliance.manage_sanctions'),
    asyncHandler(async (req, res) => {
      const { customerId } = req.body || {};
      res.status(201).json(await complianceService.screenCustomer(pool, { customerId, screenedBy: req.user.id }));
    })
  );

  router.post(
    '/sanctions/screen-batch',
    auth,
    requirePermission('compliance.manage_sanctions'),
    asyncHandler(async (req, res) => {
      const { customerIds } = req.body || {};
      res.status(201).json(await complianceService.runBatchScreening(pool, { customerIds, screenedBy: req.user.id }));
    })
  );

  router.get(
    '/sanctions/results',
    auth,
    requirePermission('compliance.manage_sanctions'),
    asyncHandler(async (req, res) => {
      const { matchStatus, customerId } = req.query;
      res.json(await complianceService.listScreeningResults(pool, { matchStatus, customerId }));
    })
  );

  router.post(
    '/sanctions/results/:id/resolve',
    auth,
    requirePermission('compliance.manage_sanctions'),
    asyncHandler(async (req, res) => {
      const { resolution, notes } = req.body || {};
      const result = await complianceService.resolveScreeningMatch(pool, {
        screeningResultId: req.params.id,
        resolvedBy: req.user.id,
        resolution,
        notes,
      });
      res.json(result);
    })
  );

  return router;
}

module.exports = { complianceRouter };
