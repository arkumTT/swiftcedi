'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const susuService = require('../modules/savings/susuService');

function susuRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Agent remittance & commission (fixed-prefix, before /:id) ------------

  router.post(
    '/remittances',
    auth,
    requirePermission('susu.remit'),
    asyncHandler(async (req, res) => {
      const { agentId, branchId, remittedOn, collectionIds } = req.body || {};
      const remittance = await susuService.recordRemittance(pool, {
        agentId,
        branchId: branchId || req.user.homeBranchId,
        remittedOn,
        collectionIds,
        receivedBy: req.user.id,
      });
      res.status(201).json(remittance);
    })
  );

  router.get(
    '/collections',
    auth,
    requirePermission('susu.view'),
    asyncHandler(async (req, res) => {
      const { susuAccountId, agentId, from, to, unremittedOnly } = req.query;
      res.json(
        await susuService.listCollections(pool, {
          susuAccountId: susuAccountId ? Number(susuAccountId) : undefined,
          agentId: agentId ? Number(agentId) : undefined,
          from,
          to,
          unremittedOnly: unremittedOnly === 'true',
        })
      );
    })
  );

  router.get(
    '/agents/:agentId/commissions',
    auth,
    requirePermission('susu.view'),
    asyncHandler(async (req, res) => {
      const { from, to } = req.query;
      res.json(await susuService.getAgentCommissionSummary(pool, { agentId: req.params.agentId, from, to }));
    })
  );

  // --- Susu accounts ----------------------------------------------------------

  router.get(
    '/',
    auth,
    requirePermission('susu.view'),
    asyncHandler(async (req, res) => {
      const { customerId, branchId, agentId, status } = req.query;
      res.json(
        await susuService.listSusuAccounts(pool, {
          customerId: customerId ? Number(customerId) : undefined,
          branchId: branchId ? Number(branchId) : undefined,
          agentId: agentId ? Number(agentId) : undefined,
          status,
        })
      );
    })
  );

  router.post(
    '/',
    auth,
    requirePermission('susu.manage_accounts'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await susuService.createSusuAccount(pool, { ...req.body, createdBy: req.user.id }));
    })
  );

  router.get(
    '/:id',
    auth,
    requirePermission('susu.view'),
    asyncHandler(async (req, res) => {
      res.json(await susuService.getSusuAccount(pool, req.params.id));
    })
  );

  /**
   * Agent-facing collection recording. Offline-tolerant: the client
   * generates `idempotencyKey`, so a retry after a dropped connection
   * returns the original collection instead of double-posting (200 rather
   * than 201, with `idempotentReplay: true`).
   */
  router.post(
    '/:id/collections',
    auth,
    requirePermission('susu.record_collection'),
    asyncHandler(async (req, res) => {
      const { amountPesewas, idempotencyKey, collectionDate, gpsLat, gpsLng, agentId } = req.body || {};
      const result = await susuService.recordCollection(pool, {
        susuAccountId: req.params.id,
        // An agent records their own collections; a supervisor may record
        // on an agent's behalf by passing agentId explicitly.
        agentId: agentId || req.user.id,
        amountPesewas,
        idempotencyKey,
        collectionDate,
        gpsLat,
        gpsLng,
      });
      res.status(result.idempotentReplay ? 200 : 201).json(result);
    })
  );

  router.post(
    '/:id/complete-cycle',
    auth,
    requirePermission('susu.complete_cycle'),
    asyncHandler(async (req, res) => {
      res.json(await susuService.completeCycle(pool, { susuAccountId: req.params.id, completedBy: req.user.id }));
    })
  );

  router.post(
    '/:id/payout',
    auth,
    requirePermission('susu.complete_cycle'),
    asyncHandler(async (req, res) => {
      const { payoutSavingsAccountId, entryDate } = req.body || {};
      res.json(
        await susuService.payOutCycle(pool, {
          susuAccountId: req.params.id,
          payoutSavingsAccountId,
          entryDate,
          paidBy: req.user.id,
        })
      );
    })
  );

  return router;
}

module.exports = { susuRouter };
