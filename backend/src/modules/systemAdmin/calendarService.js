'use strict';

const auditLog = require('../../shared/auditLog');

/**
 * Module 12's working-calendar CRUD + the DB-lookup other modules'
 * schedule-generation code calls into (loanService, standingOrderService)
 * — kept in its OWN file, separate from the bigger systemAdminService.js
 * (which imports loanService/investmentService/cashierService/
 * agentService for the job registry), specifically so loanService and
 * standingOrderService can depend on this small file without a circular
 * require back through systemAdminService.
 */

class CalendarValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/** DATE columns come back as JS Date objects from node-postgres, not 'YYYY-MM-DD' strings — see Decisions_Log.md's recurring gotcha note. */
function toDateString(dateOrString) {
  if (dateOrString instanceof Date) return dateOrString.toISOString().slice(0, 10);
  return String(dateOrString).slice(0, 10);
}

async function upsertWorkingCalendarDay(db, { date, isWorkingDay, holidayName = null, createdBy, actorBranchId }) {
  if (!date || isWorkingDay === undefined || !createdBy || !actorBranchId) {
    throw new CalendarValidationError('date, isWorkingDay, createdBy, and actorBranchId are required');
  }
  const { rows } = await db.query(
    `INSERT INTO working_calendar (calendar_date, is_working_day, holiday_name, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (calendar_date) DO UPDATE SET is_working_day = EXCLUDED.is_working_day, holiday_name = EXCLUDED.holiday_name, updated_at = now()
     RETURNING *`,
    [date, isWorkingDay, holidayName, createdBy]
  );
  const row = rows[0];

  await auditLog.record(db, {
    userId: createdBy,
    branchId: actorBranchId,
    action: 'sysadmin.working_calendar_updated',
    entityType: 'working_calendar',
    entityId: row.id,
    afterState: row,
  });

  return row;
}

async function listWorkingCalendar(db, { fromDate, toDate } = {}) {
  const params = [];
  let where = '';
  if (fromDate) {
    params.push(fromDate);
    where += `${where ? ' AND' : 'WHERE'} calendar_date >= $${params.length}`;
  }
  if (toDate) {
    params.push(toDate);
    where += `${where ? ' AND' : 'WHERE'} calendar_date <= $${params.length}`;
  }
  const { rows } = await db.query(`SELECT * FROM working_calendar ${where} ORDER BY calendar_date`, params);
  return rows;
}

/** Returns a Map<'YYYY-MM-DD', boolean> of every explicit override in the date range — calendarMath.isNonWorkingDay/rollForwardToWorkingDay's `overrides` argument. */
async function getWorkingCalendarOverrides(db, { fromDate, toDate }) {
  const { rows } = await db.query(
    'SELECT calendar_date, is_working_day FROM working_calendar WHERE calendar_date >= $1 AND calendar_date <= $2',
    [fromDate, toDate]
  );
  return new Map(rows.map((r) => [toDateString(r.calendar_date), r.is_working_day]));
}

module.exports = {
  upsertWorkingCalendarDay,
  listWorkingCalendar,
  getWorkingCalendarOverrides,
  toDateString,
  CalendarValidationError,
};
