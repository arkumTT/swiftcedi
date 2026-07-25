'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const approvalWorkflow = require('../shared/approvalWorkflow');

function approvalsRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  router.post(
    '/',
    auth,
    requirePermission('approval.request'),
    asyncHandler(async (req, res) => {
      const { actionType, entityType, entityId, amountPesewas, payload } = req.body || {};
      try {
        const result = await approvalWorkflow.requestApproval(pool, {
          actionType,
          entityType,
          entityId,
          branchId: req.user.homeBranchId,
          requestedBy: req.user.id,
          amountPesewas,
          payload,
        });
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof approvalWorkflow.ApprovalValidationError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    })
  );

  router.post(
    '/:id/decide',
    auth,
    requirePermission('approval.decide'),
    asyncHandler(async (req, res) => {
      const { decision, reason } = req.body || {};
      try {
        const result = await approvalWorkflow.decide(pool, {
          approvalId: req.params.id,
          decidedBy: req.user.id,
          decision,
          reason,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof approvalWorkflow.ApprovalNotFoundError) {
          return res.status(404).json({ error: err.message });
        }
        if (err instanceof approvalWorkflow.MakerCheckerViolationError) {
          return res.status(403).json({ error: err.message });
        }
        if (err instanceof approvalWorkflow.ApprovalValidationError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    })
  );

  return router;
}

module.exports = { approvalsRouter };
