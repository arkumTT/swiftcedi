'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const approvalWorkflow = require('../shared/approvalWorkflow');
const auditLog = require('../shared/auditLog');

function approvalsRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // Powers the approval queue / approval-trail screens and the
  // notification center — filterable by status/actionType/entityType/
  // branchId. Gated by approval.decide (the reviewer-queue permission),
  // matching who's actually meant to see what's awaiting a decision.
  router.get(
    '/',
    auth,
    requirePermission('approval.decide'),
    asyncHandler(async (req, res) => {
      const { status, actionType, entityType, branchId } = req.query;
      res.json(await approvalWorkflow.listApprovals(pool, { status, actionType, entityType, branchId }));
    })
  );

  // --- Approval thresholds (maker-checker amount configuration) ------------

  router.get(
    '/thresholds',
    auth,
    requirePermission('approval.manage_thresholds'),
    asyncHandler(async (req, res) => {
      const { branchId } = req.query;
      const params = [];
      let where = '';
      if (branchId) {
        params.push(branchId);
        where = 'WHERE branch_id = $1';
      }
      const { rows } = await pool.query(
        `SELECT t.*, r.name AS required_approver_role_name
           FROM approval_thresholds t
           JOIN roles r ON r.id = t.required_approver_role_id
           ${where}
          ORDER BY t.action_type, t.branch_id NULLS FIRST`,
        params
      );
      res.json(rows);
    })
  );

  router.post(
    '/thresholds',
    auth,
    requirePermission('approval.manage_thresholds'),
    asyncHandler(async (req, res) => {
      const { actionType, branchId = null, amountThresholdPesewas, requiredApproverRoleId } = req.body || {};
      if (!actionType || amountThresholdPesewas === undefined || !requiredApproverRoleId) {
        return res
          .status(400)
          .json({ error: 'actionType, amountThresholdPesewas, and requiredApproverRoleId are required' });
      }
      // One row per (action_type, branch_id) — an existing row for the same
      // pair is updated in place rather than erroring, since "set the
      // threshold for X" is the natural admin mental model, not "create a
      // new threshold row."
      const { rows } = await pool.query(
        `INSERT INTO approval_thresholds (action_type, branch_id, amount_threshold_pesewas, required_approver_role_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (action_type, COALESCE(branch_id, 0))
         DO UPDATE SET amount_threshold_pesewas = EXCLUDED.amount_threshold_pesewas,
                       required_approver_role_id = EXCLUDED.required_approver_role_id,
                       updated_at = now()
         RETURNING *`,
        [actionType, branchId, amountThresholdPesewas, requiredApproverRoleId]
      );
      await auditLog.record(pool, {
        userId: req.user.id,
        branchId: req.user.homeBranchId,
        action: 'approval.threshold_set',
        entityType: 'approval_threshold',
        entityId: rows[0].id,
        afterState: rows[0],
      });
      res.status(201).json(rows[0]);
    })
  );

  router.patch(
    '/thresholds/:id',
    auth,
    requirePermission('approval.manage_thresholds'),
    asyncHandler(async (req, res) => {
      const { amountThresholdPesewas, requiredApproverRoleId } = req.body || {};
      const { rows: beforeRows } = await pool.query('SELECT * FROM approval_thresholds WHERE id = $1', [
        req.params.id,
      ]);
      if (!beforeRows[0]) return res.status(404).json({ error: 'approval_threshold not found' });

      const { rows } = await pool.query(
        `UPDATE approval_thresholds
            SET amount_threshold_pesewas = COALESCE($1, amount_threshold_pesewas),
                required_approver_role_id = COALESCE($2, required_approver_role_id),
                updated_at = now()
          WHERE id = $3
          RETURNING *`,
        [amountThresholdPesewas, requiredApproverRoleId, req.params.id]
      );
      await auditLog.record(pool, {
        userId: req.user.id,
        branchId: req.user.homeBranchId,
        action: 'approval.threshold_set',
        entityType: 'approval_threshold',
        entityId: rows[0].id,
        beforeState: beforeRows[0],
        afterState: rows[0],
      });
      res.json(rows[0]);
    })
  );

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
      // decide() may dispatch to a registered execution handler (e.g. Module
      // 1's branch closure), so this runs in its own transaction — the
      // decision and whatever side effect it authorizes commit or roll back
      // together.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await approvalWorkflow.decide(client, {
          approvalId: req.params.id,
          decidedBy: req.user.id,
          decision,
          reason,
        });
        await client.query('COMMIT');
        res.json(result);
      } catch (err) {
        await client.query('ROLLBACK');
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
      } finally {
        client.release();
      }
    })
  );

  return router;
}

module.exports = { approvalsRouter };
