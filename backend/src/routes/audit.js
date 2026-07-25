'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const auditLog = require('../shared/auditLog');

function auditRouter(pool) {
  const router = express.Router();

  router.get(
    '/',
    requireAuth(pool),
    requirePermission('audit.view'),
    asyncHandler(async (req, res) => {
      const { userId, branchId, entityType, entityId, from, to, limit, offset } = req.query;
      const rows = await auditLog.query(
        pool,
        { userId, branchId, entityType, entityId, from, to },
        { limit, offset }
      );
      res.json(rows);
    })
  );

  return router;
}

module.exports = { auditRouter };
