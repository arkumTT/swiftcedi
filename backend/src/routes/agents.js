'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, resolveConsolidatedBranchScope, canAccessBranch } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const agentService = require('../modules/agent/agentService');

// Route order: fixed-prefix paths (/ping, /reconciliations, /reconciliations/
// run-branch, /reconciliations/:id/resolve) are registered before any
// /:id catch-all — see Decisions_Log.md's route ordering rule.
function agentsRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  /** 403s (not a lookup error) so a caller can't discover whether some OTHER user is a field agent by trial and error. */
  function assertAccessToAgentBranch(req, res, agent) {
    if (!canAccessBranch(req, agent.home_branch_id)) {
      res.status(403).json({ error: `not permitted to access field_agent ${agent.id}` });
      return false;
    }
    return true;
  }

  // --- Location ping (agent-facing) --------------------------------------------

  router.post(
    '/ping',
    auth,
    requirePermission('agent.ping_location'),
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM field_agents WHERE user_id = $1', [req.user.id]);
      if (!rows[0]) {
        return res.status(404).json({ error: 'the calling user is not registered as a field agent' });
      }
      const { gpsLat, gpsLng, recordedAt } = req.body || {};
      const ping = await agentService.recordLocationPing(pool, { agentId: rows[0].id, gpsLat, gpsLng, recordedAt });
      res.status(201).json(ping);
    })
  );

  // --- Reconciliation (fixed prefixes) -----------------------------------------

  router.get(
    '/reconciliations',
    auth,
    requirePermission('agent.reconcile'),
    asyncHandler(async (req, res) => {
      const branchId = resolveConsolidatedBranchScope(req);
      const { agentId, status, fromDate, toDate } = req.query;
      res.json(
        await agentService.listReconciliations(pool, {
          branchId,
          agentId: agentId ? Number(agentId) : undefined,
          status,
          fromDate,
          toDate,
        })
      );
    })
  );

  router.post(
    '/reconciliations/run-branch',
    auth,
    requirePermission('agent.reconcile'),
    asyncHandler(async (req, res) => {
      const branchId = resolveConsolidatedBranchScope(req);
      if (req.body && req.body.branchId && !canAccessBranch(req, req.body.branchId)) {
        return res.status(403).json({ error: `not permitted to run reconciliation for branch ${req.body.branchId}` });
      }
      const { date } = req.body || {};
      const targetBranchId = (req.body && req.body.branchId) || branchId;
      const results = await agentService.runBranchDailyReconciliation(pool, {
        branchId: targetBranchId,
        date,
        createdBy: req.user.id,
      });
      res.status(201).json(results);
    })
  );

  router.post(
    '/reconciliations/:id/resolve',
    auth,
    requirePermission('agent.reconcile'),
    asyncHandler(async (req, res) => {
      const { resolutionNotes } = req.body || {};
      const result = await agentService.resolveReconciliation(pool, {
        reconciliationId: req.params.id,
        resolvedBy: req.user.id,
        resolutionNotes,
      });
      res.json(result);
    })
  );

  // --- Field agent CRUD ---------------------------------------------------------

  router.get(
    '/',
    auth,
    requirePermission('agent.manage'),
    asyncHandler(async (req, res) => {
      const branchId = resolveConsolidatedBranchScope(req);
      res.json(await agentService.listFieldAgents(pool, { branchId, status: req.query.status }));
    })
  );

  router.post(
    '/',
    auth,
    requirePermission('agent.manage'),
    asyncHandler(async (req, res) => {
      if (!canAccessBranch(req, req.body && req.body.homeBranchId)) {
        return res.status(403).json({ error: `not permitted to register a field agent for that branch` });
      }
      const { userId, homeBranchId, territory } = req.body || {};
      const agent = await agentService.createFieldAgent(pool, { userId, homeBranchId, territory, createdBy: req.user.id });
      res.status(201).json(agent);
    })
  );

  router.get(
    '/:id',
    auth,
    requirePermission('agent.manage'),
    asyncHandler(async (req, res) => {
      const agent = await agentService.getFieldAgent(pool, req.params.id);
      if (!assertAccessToAgentBranch(req, res, agent)) return;
      res.json(agent);
    })
  );

  router.patch(
    '/:id',
    auth,
    requirePermission('agent.manage'),
    asyncHandler(async (req, res) => {
      const agent = await agentService.getFieldAgent(pool, req.params.id);
      if (!assertAccessToAgentBranch(req, res, agent)) return;
      const updated = await agentService.updateFieldAgent(pool, { agentId: req.params.id, updatedBy: req.user.id, fields: req.body || {} });
      res.json(updated);
    })
  );

  router.post(
    '/:id/reassign',
    auth,
    requirePermission('agent.manage'),
    asyncHandler(async (req, res) => {
      const agent = await agentService.getFieldAgent(pool, req.params.id);
      if (!assertAccessToAgentBranch(req, res, agent)) return;
      const { newBranchId, territory, effectiveDate, reason } = req.body || {};
      if (!canAccessBranch(req, newBranchId)) {
        return res.status(403).json({ error: `not permitted to reassign an agent to branch ${newBranchId}` });
      }
      const updated = await agentService.reassignAgent(pool, {
        agentId: req.params.id,
        newBranchId,
        territory,
        effectiveDate,
        reason,
        assignedBy: req.user.id,
      });
      res.json(updated);
    })
  );

  router.get(
    '/:id/assignments',
    auth,
    requirePermission('agent.manage'),
    asyncHandler(async (req, res) => {
      const agent = await agentService.getFieldAgent(pool, req.params.id);
      if (!assertAccessToAgentBranch(req, res, agent)) return;
      res.json(await agentService.listAssignmentHistory(pool, { agentId: req.params.id }));
    })
  );

  // --- Location (supervisor-facing) --------------------------------------------

  router.get(
    '/:id/location',
    auth,
    requirePermission('agent.view_locations'),
    asyncHandler(async (req, res) => {
      const agent = await agentService.getFieldAgent(pool, req.params.id);
      if (!assertAccessToAgentBranch(req, res, agent)) return;
      res.json(await agentService.getCurrentLocation(pool, { agentId: req.params.id }));
    })
  );

  router.get(
    '/:id/locations',
    auth,
    requirePermission('agent.view_locations'),
    asyncHandler(async (req, res) => {
      const agent = await agentService.getFieldAgent(pool, req.params.id);
      if (!assertAccessToAgentBranch(req, res, agent)) return;
      const { fromDate, toDate } = req.query;
      res.json(await agentService.getLocationHistory(pool, { agentId: req.params.id, fromDate, toDate }));
    })
  );

  // --- Per-agent reconciliation -------------------------------------------------

  router.post(
    '/:id/reconciliations',
    auth,
    requirePermission('agent.reconcile'),
    asyncHandler(async (req, res) => {
      const agent = await agentService.getFieldAgent(pool, req.params.id);
      if (!assertAccessToAgentBranch(req, res, agent)) return;
      const { date } = req.body || {};
      const result = await agentService.runDailyReconciliation(pool, { agentId: req.params.id, date, createdBy: req.user.id });
      res.status(201).json(result);
    })
  );

  return router;
}

module.exports = { agentsRouter };
