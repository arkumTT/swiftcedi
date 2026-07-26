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
const { loansRouter } = require('./routes/loans');
const { savingsRouter } = require('./routes/savings');
const { susuRouter } = require('./routes/susu');
const { investmentsRouter } = require('./routes/investments');
const { cashierRouter } = require('./routes/cashier');
const { analyticsRouter } = require('./routes/analytics');
const { agentsRouter } = require('./routes/agents');
const { complianceRouter } = require('./routes/compliance');
const { systemAdminRouter } = require('./routes/systemAdmin');
const { registerBranchExecutionHandlers } = require('./modules/branch/branchService');
const { registerCustomerExecutionHandlers, getAccountClosure } = require('./modules/customer/customerService');
const { registerLoanExecutionHandlers } = require('./modules/loan/loanService');
const { registerSavingsExecutionHandlers } = require('./modules/savings/savingsService');
const { registerInvestmentExecutionHandlers } = require('./modules/investment/investmentService');
const { registerCashierExecutionHandlers } = require('./modules/cashier/cashierService');
const { registerGlExecutionHandlers } = require('./shared/glPosting');
const { registerGlModuleExecutionHandlers } = require('./modules/gl/glService');
const { requireAuth } = require('./middleware/auth');
const { asyncHandler } = require('./utils/asyncHandler');

// Minimal hand-rolled CORS — the frontend is a separately-hosted SPA (Vite
// dev server / static build), never the same origin as this API in any
// real deployment. CORS_ORIGIN defaults to '*' for local dev; set it to the
// frontend's real origin in any environment that sends credentials or needs
// tighter restriction. No new dependency: this is the entire CORS surface
// the app needs (simple GET/POST/PATCH/PUT/DELETE + a Bearer header, no
// cookies), not worth pulling in the `cors` package for.
function corsMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

function createApp(pool) {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());

  // Lets approvalWorkflow.decide() dispatch approval-gated actions (branch
  // closure, customer closure, loan approval/restructure, above-threshold
  // savings withdrawal) to their owning module, whether decide() is called
  // via the generic POST /approvals/:id/decide endpoint or directly from code.
  registerBranchExecutionHandlers();
  registerCustomerExecutionHandlers();
  registerLoanExecutionHandlers();
  registerSavingsExecutionHandlers();
  registerInvestmentExecutionHandlers();
  registerCashierExecutionHandlers();
  registerGlExecutionHandlers();
  registerGlModuleExecutionHandlers();

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/auth', authRouter(pool));
  app.use('/rbac', rbacRouter(pool));
  app.use('/audit-log', auditRouter(pool));
  app.use('/approvals', approvalsRouter(pool));
  app.use('/gl', glRouter(pool));
  app.use('/branches', branchesRouter(pool));
  app.use('/customers', customersRouter(pool));
  app.use('/groups', groupsRouter(pool));
  app.use('/loans', loansRouter(pool));
  app.use('/savings', savingsRouter(pool));
  app.use('/susu', susuRouter(pool));
  app.use('/investments', investmentsRouter(pool));
  app.use('/cashier', cashierRouter(pool));
  app.use('/analytics', analyticsRouter(pool));
  app.use('/agents', agentsRouter(pool));
  app.use('/compliance', complianceRouter(pool));
  app.use('/system-admin', systemAdminRouter(pool));

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
