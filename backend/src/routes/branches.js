'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, canAccessBranch } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const branchService = require('../modules/branch/branchService');

// Route order matters: every fixed-prefix path (regions, clusters,
// transfers, cross-branch-grants, performance/compare) must be registered
// before the `/:id` catch-all, or Express will treat e.g. "performance" as
// an :id value.
function branchesRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Regions / clusters ---------------------------------------------

  router.get(
    '/regions',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await branchService.listRegions(pool));
    })
  );

  router.post(
    '/regions',
    auth,
    requirePermission('branch.create'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await branchService.createRegion(pool, req.body || {}));
    })
  );

  router.get(
    '/clusters',
    auth,
    asyncHandler(async (req, res) => {
      const regionId = req.query.regionId ? Number(req.query.regionId) : undefined;
      res.json(await branchService.listClusters(pool, { regionId }));
    })
  );

  router.post(
    '/clusters',
    auth,
    requirePermission('branch.create'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await branchService.createCluster(pool, req.body || {}));
    })
  );

  // --- Cash-in-transit transfers ---------------------------------------

  router.post(
    '/transfers',
    auth,
    requirePermission('branch.transfer'),
    asyncHandler(async (req, res) => {
      const { sourceBranchId, destinationBranchId, amountPesewas, reason } = req.body || {};
      const transfer = await branchService.initiateTransfer(pool, {
        sourceBranchId,
        destinationBranchId,
        amountPesewas,
        reason,
        initiatedBy: req.user.id,
      });
      res.status(201).json(transfer);
    })
  );

  router.get(
    '/transfers/:transferId',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await branchService.getTransfer(pool, req.params.transferId));
    })
  );

  router.post(
    '/transfers/:transferId/confirm',
    auth,
    requirePermission('branch.transfer'),
    asyncHandler(async (req, res) => {
      const transfer = await branchService.confirmTransfer(pool, {
        transferId: req.params.transferId,
        confirmedBy: req.user.id,
      });
      res.json(transfer);
    })
  );

  router.post(
    '/transfers/:transferId/cancel',
    auth,
    requirePermission('branch.transfer'),
    asyncHandler(async (req, res) => {
      const { reason } = req.body || {};
      const transfer = await branchService.cancelTransfer(pool, {
        transferId: req.params.transferId,
        cancelledBy: req.user.id,
        reason,
      });
      res.json(transfer);
    })
  );

  // --- Cross-branch access grants (top-level path) ----------------------

  router.post(
    '/cross-branch-grants/:grantId/revoke',
    auth,
    requirePermission('branch.manage_staff'),
    asyncHandler(async (req, res) => {
      const grant = await branchService.revokeCrossBranchAccess(pool, {
        grantId: req.params.grantId,
        revokedBy: req.user.id,
      });
      res.json(grant);
    })
  );

  // --- Performance (top-level compare path) ------------------------------

  router.get(
    '/performance/compare',
    auth,
    requirePermission('branch.view_performance'),
    asyncHandler(async (req, res) => {
      const branchIds = String(req.query.branchIds || '')
        .split(',')
        .map((id) => Number(id.trim()))
        .filter(Boolean);
      if (branchIds.length === 0) {
        return res.status(400).json({ error: 'branchIds query param is required, e.g. ?branchIds=1,2,3' });
      }
      const denied = branchIds.filter((id) => !canAccessBranch(req, id));
      if (denied.length > 0) {
        return res.status(403).json({ error: `not permitted to view performance for branch(es): ${denied.join(', ')}` });
      }
      const asOfDate = req.query.asOfDate || null;
      res.json(await branchService.compareBranchPerformance(pool, { branchIds, asOfDate }));
    })
  );

  // --- Branch CRUD --------------------------------------------------------

  router.get(
    '/',
    auth,
    asyncHandler(async (req, res) => {
      const { regionId, clusterId, status } = req.query;
      res.json(
        await branchService.listBranches(pool, {
          regionId: regionId ? Number(regionId) : undefined,
          clusterId: clusterId ? Number(clusterId) : undefined,
          status,
        })
      );
    })
  );

  router.post(
    '/',
    auth,
    requirePermission('branch.create'),
    asyncHandler(async (req, res) => {
      const branch = await branchService.createBranch(pool, { ...req.body, createdBy: req.user.id });
      res.status(201).json(branch);
    })
  );

  router.get(
    '/:id',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await branchService.getBranch(pool, req.params.id));
    })
  );

  router.patch(
    '/:id',
    auth,
    requirePermission('branch.update'),
    asyncHandler(async (req, res) => {
      const branch = await branchService.updateBranch(pool, {
        branchId: req.params.id,
        updatedBy: req.user.id,
        fields: req.body || {},
      });
      res.json(branch);
    })
  );

  router.post(
    '/:id/status',
    auth,
    requirePermission('branch.change_status'),
    asyncHandler(async (req, res) => {
      const { toStatus, reason } = req.body || {};
      const result = await branchService.changeBranchStatus(pool, {
        branchId: req.params.id,
        toStatus,
        requestedBy: req.user.id,
        reason,
      });
      // Closing returns a pending approval_request (not yet applied);
      // every other transition returns the already-updated branch.
      res.status(toStatus === 'closed' ? 202 : 200).json(result);
    })
  );

  router.patch(
    '/:id/vault-config',
    auth,
    requirePermission('branch.manage_vault_config'),
    asyncHandler(async (req, res) => {
      const { openingFloatPesewas, dailyCashLimitPesewas, denominationBreakdown } = req.body || {};
      const { rows } = await pool.query(
        `UPDATE branch_vault_configs
           SET opening_float_pesewas = COALESCE($1, opening_float_pesewas),
               daily_cash_limit_pesewas = COALESCE($2, daily_cash_limit_pesewas),
               denomination_breakdown = COALESCE($3, denomination_breakdown),
               updated_at = now()
         WHERE branch_id = $4
         RETURNING *`,
        [
          openingFloatPesewas,
          dailyCashLimitPesewas,
          denominationBreakdown ? JSON.stringify(denominationBreakdown) : null,
          req.params.id,
        ]
      );
      if (!rows[0]) return res.status(404).json({ error: `branch ${req.params.id} has no vault config` });
      res.json(rows[0]);
    })
  );

  router.get(
    '/:id/staff-assignments',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await branchService.listStaffAssignments(pool, { branchId: req.params.id }));
    })
  );

  router.post(
    '/:id/staff-assignments',
    auth,
    requirePermission('branch.manage_staff'),
    asyncHandler(async (req, res) => {
      const { userId } = req.body || {};
      const result = await branchService.assignStaff(pool, {
        branchId: req.params.id,
        userId,
        assignedBy: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.get(
    '/:id/cross-branch-grants',
    auth,
    requirePermission('branch.manage_staff'),
    asyncHandler(async (req, res) => {
      res.json(await branchService.listCrossBranchGrantsForBranch(pool, { branchId: req.params.id }));
    })
  );

  router.post(
    '/:id/cross-branch-grants',
    auth,
    requirePermission('branch.manage_staff'),
    asyncHandler(async (req, res) => {
      const { userId, startDate, endDate } = req.body || {};
      const grant = await branchService.grantCrossBranchAccess(pool, {
        branchId: req.params.id,
        userId,
        startDate,
        endDate,
        grantedBy: req.user.id,
      });
      res.status(201).json(grant);
    })
  );

  router.get(
    '/:id/performance',
    auth,
    requirePermission('branch.view_performance'),
    asyncHandler(async (req, res) => {
      if (!canAccessBranch(req, req.params.id)) {
        return res.status(403).json({ error: `not permitted to view performance for branch ${req.params.id}` });
      }
      const asOfDate = req.query.asOfDate || null;
      res.json(await branchService.getBranchPerformance(pool, { branchId: req.params.id, asOfDate }));
    })
  );

  return router;
}

module.exports = { branchesRouter };
