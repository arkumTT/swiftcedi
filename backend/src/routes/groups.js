'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const customerService = require('../modules/customer/customerService');

function groupsRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  router.post(
    '/',
    auth,
    requirePermission('customer.create'),
    asyncHandler(async (req, res) => {
      const group = await customerService.createGroup(pool, { ...req.body, createdBy: req.user.id });
      res.status(201).json(group);
    })
  );

  router.get(
    '/:id',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await customerService.getGroup(pool, req.params.id));
    })
  );

  router.get(
    '/:id/members',
    auth,
    asyncHandler(async (req, res) => {
      const activeOnly = req.query.activeOnly !== 'false';
      res.json(await customerService.listGroupMembers(pool, { groupId: req.params.id, activeOnly }));
    })
  );

  router.post(
    '/:id/members',
    auth,
    requirePermission('group.manage_members'),
    asyncHandler(async (req, res) => {
      const { customerId } = req.body || {};
      const member = await customerService.addGroupMember(pool, {
        groupId: req.params.id,
        customerId,
        addedBy: req.user.id,
      });
      res.status(201).json(member);
    })
  );

  router.post(
    '/:id/members/:customerId/remove',
    auth,
    requirePermission('group.manage_members'),
    asyncHandler(async (req, res) => {
      const membership = await customerService.removeGroupMember(pool, {
        groupId: req.params.id,
        customerId: req.params.customerId,
        removedBy: req.user.id,
      });
      res.json(membership);
    })
  );

  router.post(
    '/:id/leader',
    auth,
    requirePermission('group.manage_members'),
    asyncHandler(async (req, res) => {
      const { customerId } = req.body || {};
      const group = await customerService.setGroupLeader(pool, {
        groupId: req.params.id,
        customerId,
        setBy: req.user.id,
      });
      res.json(group);
    })
  );

  return router;
}

module.exports = { groupsRouter };
