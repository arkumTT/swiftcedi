'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { asyncHandler } = require('../utils/asyncHandler');
const systemAdminService = require('../modules/systemAdmin/systemAdminService');
const calendarService = require('../modules/systemAdmin/calendarService');

function systemAdminRouter(pool) {
  const router = express.Router();
  const auth = requireAuth(pool);

  // --- Scheduled jobs -------------------------------------------------------------

  router.get(
    '/jobs',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      res.json(await systemAdminService.listScheduledJobs(pool, { status: req.query.status }));
    })
  );

  router.post(
    '/jobs',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      const { jobType, cronExpression, runAsUserId } = req.body || {};
      const job = await systemAdminService.createScheduledJob(pool, { jobType, cronExpression, runAsUserId, createdBy: req.user.id });
      res.status(201).json(job);
    })
  );

  router.patch(
    '/jobs/:id/status',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      const { status } = req.body || {};
      res.json(await systemAdminService.updateScheduledJobStatus(pool, { jobId: req.params.id, status, updatedBy: req.user.id }));
    })
  );

  router.post(
    '/jobs/trigger',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      const { jobId, jobType, params } = req.body || {};
      const result = await systemAdminService.triggerJob(pool, { jobId, jobType, params, triggeredBy: req.user.id });
      res.status(201).json(result);
    })
  );

  router.get(
    '/job-run-history',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      const { jobType, status, fromDate, toDate } = req.query;
      res.json(await systemAdminService.listJobRunHistory(pool, { jobType, status, fromDate, toDate }));
    })
  );

  // --- Working calendar -------------------------------------------------------------

  router.get(
    '/calendar',
    auth,
    requirePermission('sysadmin.manage_calendar'),
    asyncHandler(async (req, res) => {
      const { fromDate, toDate } = req.query;
      res.json(await calendarService.listWorkingCalendar(pool, { fromDate, toDate }));
    })
  );

  router.put(
    '/calendar',
    auth,
    requirePermission('sysadmin.manage_calendar'),
    asyncHandler(async (req, res) => {
      const { date, isWorkingDay, holidayName } = req.body || {};
      const day = await calendarService.upsertWorkingCalendarDay(pool, {
        date,
        isWorkingDay,
        holidayName,
        createdBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.status(201).json(day);
    })
  );

  // --- Archive policies ---------------------------------------------------------

  router.get(
    '/archive-policies',
    auth,
    requirePermission('sysadmin.manage_archiving'),
    asyncHandler(async (req, res) => {
      res.json(await systemAdminService.listArchivePolicies(pool, { status: req.query.status }));
    })
  );

  router.post(
    '/archive-policies',
    auth,
    requirePermission('sysadmin.manage_archiving'),
    asyncHandler(async (req, res) => {
      const { entityType, retentionPeriodDays, archiveLocation } = req.body || {};
      const policy = await systemAdminService.createArchivePolicy(pool, { entityType, retentionPeriodDays, archiveLocation, createdBy: req.user.id });
      res.status(201).json(policy);
    })
  );

  router.post(
    '/archive-policies/:id/run',
    auth,
    requirePermission('sysadmin.manage_archiving'),
    asyncHandler(async (req, res) => {
      const result = await systemAdminService.runArchivePolicy(pool, { policyId: req.params.id, triggeredBy: req.user.id });
      res.status(201).json(result);
    })
  );

  router.get(
    '/archived-records',
    auth,
    requirePermission('sysadmin.manage_archiving'),
    asyncHandler(async (req, res) => {
      res.json(await systemAdminService.listArchivedRecords(pool, { entityType: req.query.entityType }));
    })
  );

  // --- Backup / restore / export --------------------------------------------------

  router.post(
    '/backups',
    auth,
    requirePermission('sysadmin.manage_backups'),
    asyncHandler(async (req, res) => {
      const result = await systemAdminService.triggerBackup(pool, { triggeredBy: req.user.id });
      res.status(201).json(result);
    })
  );

  router.get(
    '/backups',
    auth,
    requirePermission('sysadmin.manage_backups'),
    asyncHandler(async (req, res) => {
      res.json(await systemAdminService.listBackupRuns(pool, { status: req.query.status }));
    })
  );

  router.post(
    '/backups/restore',
    auth,
    requirePermission('sysadmin.manage_backups'),
    asyncHandler(async (req, res) => {
      const { filePath, confirm } = req.body || {};
      const result = await systemAdminService.triggerRestore(pool, {
        filePath,
        confirm,
        triggeredBy: req.user.id,
        actorBranchId: req.user.homeBranchId,
      });
      res.json(result);
    })
  );

  router.get(
    '/export/:tableName',
    auth,
    requirePermission('sysadmin.manage_backups'),
    asyncHandler(async (req, res) => {
      const csv = await systemAdminService.exportTableToCsv(pool, { tableName: req.params.tableName });
      res.type('csv').set('Content-Disposition', `attachment; filename="${req.params.tableName}.csv"`).send(csv);
    })
  );

  // --- Subscription / licence tracking ----------------------------------------------

  router.get(
    '/subscriptions',
    auth,
    requirePermission('sysadmin.manage_subscriptions'),
    asyncHandler(async (req, res) => {
      res.json(await systemAdminService.listSubscriptionLicences(pool, { status: req.query.status }));
    })
  );

  router.post(
    '/subscriptions',
    auth,
    requirePermission('sysadmin.manage_subscriptions'),
    asyncHandler(async (req, res) => {
      const { tenantName, plan, seats, startDate, endDate } = req.body || {};
      const licence = await systemAdminService.createSubscriptionLicence(pool, { tenantName, plan, seats, startDate, endDate, createdBy: req.user.id });
      res.status(201).json(licence);
    })
  );

  // --- Reminder notifications --------------------------------------------------------

  router.get(
    '/reminders',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      const { status, notificationType, customerId } = req.query;
      res.json(await systemAdminService.listReminderNotifications(pool, { status, notificationType, customerId }));
    })
  );

  router.post(
    '/reminders/:id/mark-sent',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      res.json(await systemAdminService.markNotificationSent(pool, { notificationId: req.params.id }));
    })
  );

  router.post(
    '/reminders/:id/mark-failed',
    auth,
    requirePermission('sysadmin.manage_jobs'),
    asyncHandler(async (req, res) => {
      res.json(await systemAdminService.markNotificationFailed(pool, { notificationId: req.params.id }));
    })
  );

  return router;
}

module.exports = { systemAdminRouter };
