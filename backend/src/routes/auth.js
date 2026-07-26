'use strict';

const express = require('express');
const { verifyPassword } = require('../utils/password');
const { createSession, destroySession } = require('../middleware/sessionStore');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');

function authRouter(pool) {
  const router = express.Router();

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
      }

      const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      const user = rows[0];
      if (!user || user.status !== 'active') {
        return res.status(401).json({ error: 'invalid credentials' });
      }

      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'invalid credentials' });
      }

      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      const token = createSession(user.id);
      return res.json({ token });
    })
  );

  router.post('/logout', requireAuth(pool), (req, res) => {
    const [, token] = (req.headers.authorization || '').split(' ');
    destroySession(token);
    res.status(204).end();
  });

  // Lets the frontend resolve who's logged in, their role, and their
  // permission set (for nav gating) without decoding anything client-side
  // — req.user is already populated by requireAuth from the same query
  // every other RBAC-gated route relies on.
  router.get('/me', requireAuth(pool), (req, res) => {
    res.json({
      id: req.user.id,
      fullName: req.user.fullName,
      email: req.user.email,
      homeBranchId: req.user.homeBranchId,
      roleId: req.user.roleId,
      roleName: req.user.roleName,
      permissions: Array.from(req.user.permissions),
      crossBranchAccessibleBranchIds: Array.from(req.user.crossBranchAccessibleBranchIds),
    });
  });

  return router;
}

module.exports = { authRouter };
