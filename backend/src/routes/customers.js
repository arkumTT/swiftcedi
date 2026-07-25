'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const customerService = require('../modules/customer/customerService');

function customersRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  router.get(
    '/',
    auth,
    asyncHandler(async (req, res) => {
      const { branchId, customerType, status, classification } = req.query;
      res.json(
        await customerService.listCustomers(pool, {
          branchId: branchId ? Number(branchId) : undefined,
          customerType,
          status,
          classification,
        })
      );
    })
  );

  router.post(
    '/',
    auth,
    requirePermission('customer.create'),
    asyncHandler(async (req, res) => {
      const customer = await customerService.createCustomer(pool, { ...req.body, createdBy: req.user.id });
      res.status(201).json(customer);
    })
  );

  router.get(
    '/:id',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await customerService.getCustomer(pool, req.params.id));
    })
  );

  router.get(
    '/:id/360',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await customerService.getCustomer360(pool, { customerId: req.params.id }));
    })
  );

  router.patch(
    '/:id',
    auth,
    requirePermission('customer.update'),
    asyncHandler(async (req, res) => {
      const customer = await customerService.updateCustomer(pool, {
        customerId: req.params.id,
        updatedBy: req.user.id,
        fields: req.body || {},
      });
      res.json(customer);
    })
  );

  router.post(
    '/:id/classification',
    auth,
    requirePermission('customer.classify'),
    asyncHandler(async (req, res) => {
      const { classification } = req.body || {};
      const customer = await customerService.classifyCustomer(pool, {
        customerId: req.params.id,
        classification,
        classifiedBy: req.user.id,
      });
      res.json(customer);
    })
  );

  router.post(
    '/:id/kyc-status',
    auth,
    requirePermission('customer.verify_kyc'),
    asyncHandler(async (req, res) => {
      const { kycStatus, notes } = req.body || {};
      const customer = await customerService.updateKycStatus(pool, {
        customerId: req.params.id,
        kycStatus,
        notes,
        actorId: req.user.id,
      });
      res.json(customer);
    })
  );

  router.post(
    '/:id/deactivate',
    auth,
    requirePermission('customer.reactivate'),
    asyncHandler(async (req, res) => {
      const { reason } = req.body || {};
      res.json(await customerService.deactivateCustomer(pool, { customerId: req.params.id, actorId: req.user.id, reason }));
    })
  );

  router.post(
    '/:id/reactivate',
    auth,
    requirePermission('customer.reactivate'),
    asyncHandler(async (req, res) => {
      const { reason } = req.body || {};
      res.json(await customerService.reactivateCustomer(pool, { customerId: req.params.id, actorId: req.user.id, reason }));
    })
  );

  router.post(
    '/:id/closure-requests',
    auth,
    requirePermission('customer.close'),
    asyncHandler(async (req, res) => {
      const { reasonCode, reasonNotes } = req.body || {};
      const closure = await customerService.requestClosure(pool, {
        customerId: req.params.id,
        reasonCode,
        reasonNotes,
        requestedBy: req.user.id,
      });
      res.status(202).json(closure);
    })
  );

  router.post(
    '/:id/branch-transfer',
    auth,
    requirePermission('customer.transfer_branch'),
    asyncHandler(async (req, res) => {
      const { toBranchId, reason } = req.body || {};
      const customer = await customerService.transferCustomerBranch(pool, {
        customerId: req.params.id,
        toBranchId,
        reason,
        transferredBy: req.user.id,
      });
      res.json(customer);
    })
  );

  router.get(
    '/:id/documents',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await customerService.listDocuments(pool, { customerId: req.params.id }));
    })
  );

  router.post(
    '/:id/documents',
    auth,
    requirePermission('customer.manage_documents'),
    asyncHandler(async (req, res) => {
      const { documentType, fileUrl } = req.body || {};
      const document = await customerService.attachDocument(pool, {
        customerId: req.params.id,
        documentType,
        fileUrl,
        uploadedBy: req.user.id,
      });
      res.status(201).json(document);
    })
  );

  router.get(
    '/:id/next-of-kin',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await customerService.listNextOfKin(pool, { customerId: req.params.id }));
    })
  );

  router.post(
    '/:id/next-of-kin',
    auth,
    requirePermission('customer.manage_next_of_kin'),
    asyncHandler(async (req, res) => {
      const { fullName, relationship, phone, address } = req.body || {};
      const kin = await customerService.addNextOfKin(pool, {
        customerId: req.params.id,
        fullName,
        relationship,
        phone,
        address,
        createdBy: req.user.id,
      });
      res.status(201).json(kin);
    })
  );

  router.get(
    '/:id/credit-bureau-lookups',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await customerService.listCreditBureauLookups(pool, { customerId: req.params.id }));
    })
  );

  router.post(
    '/:id/credit-bureau-lookups',
    auth,
    requirePermission('customer.credit_bureau_lookup'),
    asyncHandler(async (req, res) => {
      const lookup = await customerService.lookupCreditBureau(pool, {
        customerId: req.params.id,
        requestedBy: req.user.id,
      });
      res.status(201).json(lookup);
    })
  );

  return router;
}

module.exports = { customersRouter };
