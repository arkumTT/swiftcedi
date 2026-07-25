'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { hashPassword } = require('../utils/password');
const { asyncHandler } = require('../utils/asyncHandler');
const auditLog = require('../shared/auditLog');

function rbacRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  router.get(
    '/roles',
    auth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM roles ORDER BY name');
      res.json(rows);
    })
  );

  router.post(
    '/roles',
    auth,
    requirePermission('rbac.manage_roles'),
    asyncHandler(async (req, res) => {
      const { name, description } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });

      const { rows } = await pool.query(
        'INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING *',
        [name, description || null]
      );
      await auditLog.record(pool, {
        userId: req.user.id,
        branchId: req.user.homeBranchId,
        action: 'rbac.role_created',
        entityType: 'role',
        entityId: rows[0].id,
        afterState: rows[0],
      });
      res.status(201).json(rows[0]);
    })
  );

  router.get(
    '/permissions',
    auth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM permissions ORDER BY code');
      res.json(rows);
    })
  );

  router.post(
    '/roles/:roleId/permissions',
    auth,
    requirePermission('rbac.manage_roles'),
    asyncHandler(async (req, res) => {
      const { roleId } = req.params;
      const { permissionCode } = req.body || {};
      if (!permissionCode) return res.status(400).json({ error: 'permissionCode is required' });

      const { rows: permRows } = await pool.query('SELECT id FROM permissions WHERE code = $1', [permissionCode]);
      if (!permRows[0]) return res.status(404).json({ error: `permission '${permissionCode}' not found` });

      await pool.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roleId, permRows[0].id]
      );
      await auditLog.record(pool, {
        userId: req.user.id,
        branchId: req.user.homeBranchId,
        action: 'rbac.permission_granted',
        entityType: 'role',
        entityId: roleId,
        afterState: { permissionCode },
      });
      res.status(204).end();
    })
  );

  router.post(
    '/users',
    auth,
    requirePermission('rbac.manage_users'),
    asyncHandler(async (req, res) => {
      const { fullName, email, password, roleId, homeBranchId } = req.body || {};
      if (!fullName || !email || !password || !roleId || !homeBranchId) {
        return res.status(400).json({ error: 'fullName, email, password, roleId, homeBranchId are required' });
      }

      const passwordHash = await hashPassword(password);
      const { rows } = await pool.query(
        `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, full_name, email, role_id, home_branch_id, status, created_at`,
        [fullName, email, passwordHash, roleId, homeBranchId]
      );
      await auditLog.record(pool, {
        userId: req.user.id,
        branchId: req.user.homeBranchId,
        action: 'rbac.user_created',
        entityType: 'user',
        entityId: rows[0].id,
        afterState: rows[0],
      });
      res.status(201).json(rows[0]);
    })
  );

  router.patch(
    '/users/:userId/role',
    auth,
    requirePermission('rbac.manage_users'),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { roleId } = req.body || {};
      if (!roleId) return res.status(400).json({ error: 'roleId is required' });

      const { rows: beforeRows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (!beforeRows[0]) return res.status(404).json({ error: 'user not found' });

      const { rows } = await pool.query(
        `UPDATE users SET role_id = $1, updated_at = now() WHERE id = $2
         RETURNING id, full_name, email, role_id, home_branch_id, status`,
        [roleId, userId]
      );
      await auditLog.record(pool, {
        userId: req.user.id,
        branchId: req.user.homeBranchId,
        action: 'rbac.user_role_changed',
        entityType: 'user',
        entityId: userId,
        beforeState: beforeRows[0],
        afterState: rows[0],
      });
      res.json(rows[0]);
    })
  );

  return router;
}

module.exports = { rbacRouter };
