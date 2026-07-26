'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, resolveAnalyticsBranchScope } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const analyticsService = require('../modules/analytics/analyticsService');

// Route order: fixed-prefix paths (/dashboard-configs/mine before
// /dashboard-configs/:roleId) are registered before any /:id catch-all —
// see Decisions_Log.md's route ordering rule.
function analyticsRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  router.get(
    '/live-stats',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      const branchId = resolveAnalyticsBranchScope(req);
      const { date } = req.query;
      res.json(await analyticsService.getLiveStats(pool, { branchId, date }));
    })
  );

  router.get(
    '/portfolio-quality',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      const branchId = resolveAnalyticsBranchScope(req);
      const { asOfDate, loanOfficerId, largestExposuresLimit } = req.query;
      res.json(
        await analyticsService.getPortfolioQuality(pool, {
          asOfDate,
          branchId,
          loanOfficerId: loanOfficerId ? Number(loanOfficerId) : null,
          largestExposuresLimit: largestExposuresLimit ? Number(largestExposuresLimit) : undefined,
          requestingUser: req.user,
        })
      );
    })
  );

  router.get(
    '/profitability',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      const branchId = resolveAnalyticsBranchScope(req);
      const { fromDate, toDate } = req.query;
      res.json(await analyticsService.getProfitability(pool, { fromDate, toDate, branchId }));
    })
  );

  router.get(
    '/top-loan-customers',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      const branchId = resolveAnalyticsBranchScope(req);
      const { fromDate, toDate, limit } = req.query;
      res.json(
        await analyticsService.getTopLoanCustomersByRevenue(pool, {
          fromDate,
          toDate,
          branchId,
          limit: limit ? Number(limit) : undefined,
        })
      );
    })
  );

  router.get(
    '/growth-trends',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      const branchId = resolveAnalyticsBranchScope(req);
      const { fromDate, toDate, granularity } = req.query;
      res.json(await analyticsService.getGrowthTrends(pool, { fromDate, toDate, branchId, granularity }));
    })
  );

  router.get(
    '/agent-productivity',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      const { agentId, fromDate, toDate } = req.query;
      res.json(
        await analyticsService.getAgentProductivity(pool, {
          agentId: agentId ? Number(agentId) : null,
          fromDate,
          toDate,
          requestingUser: req.user,
        })
      );
    })
  );

  router.get(
    '/report-pack',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      const branchId = resolveAnalyticsBranchScope(req);
      const { asOfDate, fromDate, toDate } = req.query;
      res.json(await analyticsService.generateExecutiveReportPack(pool, { asOfDate, fromDate, toDate, branchId }));
    })
  );

  // --- Dashboard widget configs --------------------------------------------

  // Any analytics.view holder may read their OWN role's widget layout —
  // this is what actually renders their dashboard, so it isn't gated
  // behind the admin-only manage permission. Deliberately ignores any
  // ?roleId= a caller might pass; always the caller's own role.
  router.get(
    '/dashboard-configs/mine',
    auth,
    requirePermission('analytics.view'),
    asyncHandler(async (req, res) => {
      res.json(await analyticsService.listWidgetConfigs(pool, { roleId: req.user.roleId }));
    })
  );

  router.get(
    '/dashboard-configs/:roleId',
    auth,
    requirePermission('analytics.manage_dashboards'),
    asyncHandler(async (req, res) => {
      res.json(await analyticsService.listWidgetConfigs(pool, { roleId: req.params.roleId }));
    })
  );

  router.put(
    '/dashboard-configs',
    auth,
    requirePermission('analytics.manage_dashboards'),
    asyncHandler(async (req, res) => {
      const { roleId, widgetKey, position, visible } = req.body || {};
      const config = await analyticsService.upsertWidgetConfig(pool, {
        roleId,
        widgetKey,
        position,
        visible,
        updatedBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.status(201).json(config);
    })
  );

  router.delete(
    '/dashboard-configs/:id',
    auth,
    requirePermission('analytics.manage_dashboards'),
    asyncHandler(async (req, res) => {
      const result = await analyticsService.deleteWidgetConfig(pool, {
        configId: req.params.id,
        deletedBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.json(result);
    })
  );

  return router;
}

module.exports = { analyticsRouter };
