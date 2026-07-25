'use strict';

const express = require('express');
const { authRouter } = require('./routes/auth');
const { rbacRouter } = require('./routes/rbac');
const { auditRouter } = require('./routes/audit');
const { approvalsRouter } = require('./routes/approvals');
const { glRouter } = require('./routes/gl');
const { branchesRouter } = require('./routes/branches');
const { customersRouter } = require('./routes/customers');
const { groupsRouter } = require('./routes/groups');
const { registerBranchExecutionHandlers } = require('./modules/branch/branchService');
const { registerCustomerExecutionHandlers, getAccountClosure } = require('./modules/customer/customerService');
const { requireAuth } = require('./middleware/auth');
const { asyncHandler } = require('./utils/asyncHandler');

function createApp(pool) {
  const app = express();
  app.use(express.json());

  // Lets approvalWorkflow.decide() dispatch closure approvals (branch,
  // customer) to their owning module, whether decide() is called via the
  // generic POST /approvals/:id/decide endpoint or directly from code.
  registerBranchExecutionHandlers();
  registerCustomerExecutionHandlers();

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/auth', authRouter(pool));
  app.use('/rbac', rbacRouter(pool));
  app.use('/audit-log', auditRouter(pool));
  app.use('/approvals', approvalsRouter(pool));
  app.use('/gl', glRouter(pool));
  app.use('/branches', branchesRouter(pool));
  app.use('/customers', customersRouter(pool));
  app.use('/groups', groupsRouter(pool));

  app.get(
    '/account-closures/:id',
    requireAuth(pool),
    asyncHandler(async (req, res) => {
      res.json(await getAccountClosure(pool, req.params.id));
    })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if (statusCode === 500) console.error(err);
    res.status(statusCode).json({ error: statusCode === 500 ? 'internal server error' : err.message });
  });

  return app;
}

module.exports = { createApp };
