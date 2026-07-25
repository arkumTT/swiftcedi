'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const auditLog = require('../shared/auditLog');
const glPosting = require('../shared/glPosting');

function glRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  router.get(
    '/accounts',
    auth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM gl_accounts ORDER BY code');
      res.json(rows);
    })
  );

  router.post(
    '/accounts',
    auth,
    requirePermission('gl.manage_accounts'),
    asyncHandler(async (req, res) => {
      const { code, name, accountType, branchId, parentAccountId } = req.body || {};
      if (!code || !name || !accountType) {
        return res.status(400).json({ error: 'code, name, accountType are required' });
      }

      const { rows } = await pool.query(
        `INSERT INTO gl_accounts (code, name, account_type, branch_id, parent_account_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [code, name, accountType, branchId || null, parentAccountId || null]
      );
      await auditLog.record(pool, {
        userId: req.user.id,
        branchId: req.user.homeBranchId,
        action: 'gl.account_created',
        entityType: 'gl_account',
        entityId: rows[0].id,
        afterState: rows[0],
      });
      res.status(201).json(rows[0]);
    })
  );

  router.post(
    '/journal-entries',
    auth,
    requirePermission('gl.post_journal'),
    asyncHandler(async (req, res) => {
      const { reference, description, entryDate, sourceModule, entryType, lines, approvedBy } = req.body || {};
      try {
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
      } catch (err) {
        if (err instanceof glPosting.GlPostingValidationError || err instanceof glPosting.PeriodLockedError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    })
  );

  router.get(
    '/accounts/:id/balance',
    auth,
    requirePermission('gl.view_reports'),
    asyncHandler(async (req, res) => {
      const { asOfDate, branchId } = req.query;
      try {
        const balancePesewas = await glPosting.getAccountBalance(pool, {
          accountId: req.params.id,
          asOfDate: asOfDate || null,
          branchId: branchId || null,
        });
        res.json({ accountId: Number(req.params.id), asOfDate: asOfDate || null, balancePesewas });
      } catch (err) {
        if (err instanceof glPosting.GlPostingValidationError) {
          return res.status(404).json({ error: err.message });
        }
        throw err;
      }
    })
  );

  return router;
}

module.exports = { glRouter };
